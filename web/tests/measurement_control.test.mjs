import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packMeasurementControl, unpackMeasurementControl, packMeasurementState,
  unpackMeasurementState, measurementStatusText} from '../measurement_control.js';
import {CalibrationController} from '../aw_controller.js';
import {SimTransport} from '../aw_sim.js';
import {Command, StreamDecoder, encodeFrame} from '../aw_protocol.js';

test('wire schema matches C golden state including task identity and result validity', () => {
  assert.equal(Buffer.from(packMeasurementControl(1,3,3,0x11223344)).toString('hex'),'0103030044332211');
  const golden = Buffer.from('00030303030200014433221140e20100000020400000de430000c03e','hex');
  const state = unpackMeasurementState(golden);
  assert.equal(state.requestId,0x11223344);assert.equal(state.elapsedMs,123456);
  assert.equal(state.moisture,2.5);assert.equal(state.density,444);assert.equal(state.aw,.375);
  assert.deepEqual(packMeasurementState(state),new Uint8Array(golden));
  const frame=encodeFrame(Command.MEASUREMENT_CONTROL|0x80,9,golden);
  const decoder=new StreamDecoder();assert.equal(decoder.feed(frame.subarray(0,7)).length,0);
  assert.equal(unpackMeasurementState(decoder.feed(frame.subarray(7))[0].payload).screenId,2);
});

test('invalid beans, operations, malformed fields and incomplete completion are rejected', () => {
  for (const args of [[1,4,1,1],[1,0,0,1],[1,0,1,0],[1,0,1,-1],[3,0,1,1]])
    assert.throws(()=>packMeasurementControl(...args));
  assert.throws(()=>unpackMeasurementControl(Uint8Array.of(1,0,1,1,1,0,0,0)));
  assert.throws(()=>unpackMeasurementState(new Uint8Array(27)));
  assert.throws(()=>packMeasurementState({phase:3,mode:3,resultFlags:1,deviceReady:true}));
  const s=unpackMeasurementState(packMeasurementState({phase:2,mode:3,resultFlags:1,
    moisture:0,density:0,aw:.5,deviceReady:true}));
  assert.equal(s.moisture,0);assert.equal(s.aw,null);
  assert.match(measurementStatusText(s),/水活继续测量/);
  assert.doesNotMatch(measurementStatusText(s),/：测量完成/);
});

async function setup(options={}) {
  const sim=new SimTransport();await sim.connect();clearInterval(sim._timer);sim._timer=null;
  let clock=0;sim.now=()=>clock;
  const c=new CalibrationController({clock:()=>clock,...options});
  c.connectTransport(sim,{mode:'simulator'});
  return {sim,c,setClock:t=>clock=t};
}

for (let bean=0;bean<4;bean++) for(let mode=1;mode<=3;mode++) {
  test(`bean ${bean}, mode ${mode}: start, partial results, final result and state readback`,async()=>{
    const {sim,c,setClock}=await setup();
    try {
      c.startMeasurement(bean,mode,100+bean*3+mode);
      assert.equal(c.measurement.beanId,bean);assert.equal(c.measurement.mode,mode);
      assert.equal(c.measurement.phase,2);assert.equal(c.measurement.screenId,2);
      assert.throws(()=>c.startCapture(0),/测量/);
      assert.throws(()=>c.writeParameters(1,0),/测量/);
      assert.throws(()=>c.pauseForOta(),/测量/);
      assert.throws(()=>c.startMeasurement(bean,mode,999),/测量/);
      setClock(1300);c.readMeasurement();
      assert.equal(c.measurement.resultFlags,mode&1);
      assert.equal(c.measurement.phase,mode===1?3:2);
      if(mode!==1) assert.equal(c.measurement.aw,null);
      setClock(3100);c.readMeasurement();
      assert.equal(c.measurement.phase,3);assert.equal(c.measurement.resultFlags,mode);
      if(mode&1)assert.ok(c.measurement.density>0);else assert.equal(c.measurement.moisture,null);
      if(mode&2)assert.ok(Math.abs(c.measurement.aw-.42)<1e-6);
    } finally {await c.disconnect();}
  });
}

test('cancellation preserves partial MD result and stale cancellation cannot stop another task',async()=>{
  const {sim,c,setClock}=await setup();
  try {
    c.startMeasurement(2,3,77);setClock(1300);c.readMeasurement();c.cancelMeasurement();
    assert.equal(c.measurement.phase,4);assert.equal(c.measurement.resultFlags,1);assert.equal(c.measurement.aw,null);
    c.startMeasurement(1,2,78);
    sim._handleRequest({command:Command.MEASUREMENT_CONTROL,sequence:123,payload:packMeasurementControl(2,2,3,77)});
    c.readMeasurement();assert.equal(c.measurement.requestId,78);assert.equal(c.measurement.phase,2);
  } finally {await c.disconnect();}
});

test('lost START acknowledgement is never automatically resent and status query recovers actual completion',async()=>{
  const {sim,c,setClock}=await setup({requestTimeoutMs:20});
  try {
    let requests=0;const original=sim._handleRequest.bind(sim);
    sim._handleRequest=f=>{if(f.command===Command.MEASUREMENT_CONTROL&&f.payload[0]===1)requests++;original(f);};
    const respond=sim._respond.bind(sim);let drop=true;
    sim._respond=(cmd,seq,body)=>{if(cmd===Command.MEASUREMENT_CONTROL&&drop){drop=false;return;}respond(cmd,seq,body);};
    c.startMeasurement(0,1,88);assert.equal(c.measurement,null);
    setClock(4000);c.tick();assert.equal(requests,1);
    c.readMeasurement();assert.equal(c.measurement.phase,3);assert.equal(c.measurement.requestId,88);
    assert.equal(requests,1);
  } finally {await c.disconnect();}
});

test('unknown old firmware produces an error and never a fabricated measurement result',async()=>{
  const {sim,c}=await setup();
  try {
    const errors=[];c.on('error',e=>errors.push(e));
    const original=sim._handleRequest.bind(sim);
    sim._handleRequest=f=>f.command===Command.MEASUREMENT_CONTROL?sim._status(f.command,f.sequence,1):original(f);
    c.readMeasurement();assert.equal(errors[0].data.status,1);assert.equal(c.measurement,null);
  } finally {await c.disconnect();}
});


test('bean selection synchronizes all four device pages without starting a measurement', async () => {
  const {sim,c,setClock}=await setup();
  try {
    for (const bean of [1,0,2,3]) {
      c.selectBean(bean);
      assert.equal(c.measurement.beanId,bean);
      assert.equal(sim.beanId,bean);
      assert.equal(c.measurement.screenId,2);
      assert.equal(c.measurement.phase,0);
      assert.equal(c.measurement.mode,0);
      assert.equal(c.measurement.resultFlags,0);
      setClock(10000);c.readMeasurement();
      assert.equal(c.measurement.phase,0);
    }
    c.startMeasurement(3,3,1234);
    assert.throws(()=>c.selectBean(1),/测量/);
    sim._handleRequest({command:Command.MEASUREMENT_CONTROL,sequence:123,
      payload:packMeasurementControl(3,1,0,1235)});
    c.readMeasurement();assert.equal(c.measurement.beanId,3);
    assert.equal(c.measurement.requestId,1234);
    for (const args of [[3,4,0,1],[3,0,1,1],[3,0,0,0]])
      assert.throws(()=>packMeasurementControl(...args));
  } finally {await c.disconnect();}
});
