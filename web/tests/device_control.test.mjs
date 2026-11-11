import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packDeviceControl,unpackDeviceState,packDeviceState} from '../device_control.js';
import {CalibrationController} from '../aw_controller.js';
import {SimTransport} from '../aw_sim.js';
import {Command} from '../aw_protocol.js';
async function setup(options={}) {
  const sim=new SimTransport();await sim.connect();clearInterval(sim._timer);sim._timer=null;
  let now=0;sim.now=()=>now;
  const c=new CalibrationController({clock:()=>now,...options});c.connectTransport(sim,{mode:'simulator'});
  return {sim,c,tick:t=>now=t};
}
test('device control strict schema, calibration confirmation command and readback mismatch rejection',()=>{
  assert.equal(Buffer.from(packDeviceControl(2,10,0x11223344)).toString('hex'),'020a000044332211');
  for(const args of [[1,2,1],[2,0,1],[2,4,1],[3,1,1],[4,0,0],[5,0,1]])assert.throws(()=>packDeviceControl(...args));
  const s=unpackDeviceState(packDeviceState({phase:1,action:3,requestId:1,ready:true}));assert.equal(s.phase,1);
  assert.throws(()=>unpackDeviceState(new Uint8Array(19)));
  assert.throws(()=>packDeviceState({phase:3,action:1,value:1,language:0,requestId:1}));
});
for(const [action,values] of [[1,[0,1]],[2,[3,5,10]]])test(`setting ${action} is saved and read back`,async()=>{
  const {c}=await setup();try {
    for(const value of values){c.controlDevice(action,value,100+value);assert.equal(c.deviceControl.phase,3);assert.equal(c.deviceControl[action===1?'language':'standbyMinutes'],value);c.readDeviceControl();assert.equal(c.deviceControl.value,value);}
  }finally{await c.disconnect();}
});
for(const action of [3,4])test(`calibration ${action} never reports an ACK as completion and blocks conflicting work`,async()=>{
  const {c,sim,tick}=await setup();try{
    c.controlDevice(action,0,123);assert.equal(c.deviceControl.phase,2);
    for(const fn of [()=>c.startMeasurement(1,3,124),()=>c.selectBean(1),()=>c.startCapture(0),()=>c.writeParameters(1,0),()=>c.pauseForOta(),()=>c.controlDevice(1,1,125)])assert.throws(fn,/设备设置或校准/);
    const failures=[];c.on('error',e=>failures.push(e));
    sim._handleRequest({command:Command.DEVICE_CONTROL,sequence:0xff,payload:packDeviceControl(1,1,124)});
    assert.equal(sim._deviceControl.action,action);
    tick(3100);c.readDeviceControl();assert.equal(c.deviceControl.phase,3);assert.equal(c.deviceControl.action,action);
    c.controlDevice(1,1,125);assert.equal(c.deviceControl.language,1);
  }finally{await c.disconnect();}
});
test('lost calibration ACK is not resent; query recovers actual completion',async()=>{
  const {c,sim,tick}=await setup({requestTimeoutMs:20});try{
    let count=0;const original=sim._handleRequest.bind(sim);sim._handleRequest=f=>{if(f.command===Command.DEVICE_CONTROL&&f.payload.length)count++;original(f);};
    const respond=sim._respond.bind(sim);let drop=true;sim._respond=(cmd,seq,body)=>{if(cmd===Command.DEVICE_CONTROL&&drop){drop=false;return;}respond(cmd,seq,body);};
    c.controlDevice(3,0,55);tick(4000);c.tick();assert.equal(count,1);c.readDeviceControl();assert.equal(c.deviceControl.phase,3);assert.equal(c.deviceControl.requestId,55);assert.equal(count,1);
  }finally{await c.disconnect();}
});
test('old firmware and active measurement never fabricate calibration success',async()=>{
  const {c,sim}=await setup();try{
    c.startMeasurement(1,3,99);assert.throws(()=>c.controlDevice(3,0,100),/测量/);
    await c.disconnect();
    c.connectTransport(sim,{mode:'simulator'});
    const errors=[];c.on('error',e=>errors.push(e));const original=sim._handleRequest.bind(sim);
    sim._handleRequest=f=>f.command===Command.DEVICE_CONTROL?sim._status(f.command,f.sequence,1):original(f);
    c.readDeviceControl();assert.equal(c.deviceControl,null);assert.equal(errors.at(-1).data.status,1);
  }finally{await c.disconnect();}
});


test('boot snapshot before UI publication remains pending readiness; ready snapshot requires valid standby',()=>{
  const boot=unpackDeviceState(new Uint8Array(20));assert.equal(boot.ready,false);assert.equal(boot.phase,0);
  const malformed=new Uint8Array(20);malformed[8]=1;assert.throws(()=>unpackDeviceState(malformed));
});
