import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snCheckCharacter,snGenerate,snValidate,unpackSn} from '../sn_code.js';
import {CalibrationController} from '../aw_controller.js';
import {SimTransport} from '../aw_sim.js';
import {Command} from '../aw_protocol.js';

test('check character matches coffee scale known vector; DT01 round trips and rejects invalid fields',()=>{
  assert.equal(snCheckCharacter('LBDT01260101Z9999'),'Q');
  const sn=snGenerate({date:new Date(2026,0,1),line:'Z',sequence:9999});
  assert.equal(sn,'LBDT01260101Z9999Q');
  assert.equal(sn.length,18);assert.ok(snValidate(sn));
  for(let i=0;i<sn.length;i++)assert.equal(snValidate(sn.slice(0,i)+(sn[i]==='0'?'1':'0')+sn.slice(i+1)),false);
  for(const bad of ['LBDT01260230A0001','LBDT01261301A0001','LBDT01261021A0000','LBCS01261021A0001'])assert.equal(snValidate(bad+snCheckCharacter(bad)),false);
  assert.equal(snGenerate({sequence:0}),null);assert.equal(snGenerate({sequence:10000}),null);
  assert.equal(snGenerate({line:'AA'}),null);assert.equal(snGenerate({date:new Date(NaN)}),null);
  assert.ok(snValidate(snGenerate({date:new Date(2024,1,29)})));
});
test('SN response must have exact length and printable content',()=>{
  assert.deepEqual(unpackSn(Uint8Array.of(0,0)),{sn:''});
  for(const bytes of [[0],[0,2,65],[0,1,65,66],[0,1,0],[0,20,...Array(20).fill(65)]])assert.throws(()=>unpackSn(Uint8Array.from(bytes)));
});
test('SN writes wait for capture/OTA and a pending SN verification prevents capture',async()=>{
  const sim=await new SimTransport().connect(),c=new CalibrationController();c.connectTransport(sim,{});
  try {
    c.startCapture(0);assert.throws(()=>c.writeSn(snGenerate()),/结束采集/);c.cancelCapture();
    c.pauseForOta();assert.throws(()=>c.writeSn(snGenerate()),/升级/);c.resumeAfterOta();
    const handle=sim._handleRequest.bind(sim);
    sim._handleRequest=f=>f.command===Command.WRITE_SN?undefined:handle(f);
    c.writeSn(snGenerate());assert.throws(()=>c.startCapture(0),/SN/);assert.throws(()=>c.pauseForOta(),/参数操作/);
  }finally{await c.disconnect();}
});
test('framed SN write is read back before success and cannot overwrite existing identity',async()=>{
  const sim=await new SimTransport().connect(),c=new CalibrationController();
  const verified=[],errors=[],reads=[];c.on('sn_verified',e=>verified.push(e.data));c.on('sn',e=>reads.push(e.data));c.on('error',e=>errors.push(e));
  c.connectTransport(sim,{mode:'simulator'});
  try {
    c.readSn();assert.equal(reads.at(-1).sn,'');
    const sn=snGenerate({sequence:1});c.writeSn(sn);
    assert.deepEqual(verified,[{sn}]);assert.equal(c.session.deviceId,sn);
    c.writeSn(sn);assert.equal(verified.length,2);
    c.writeSn(snGenerate({sequence:2}));assert.equal(verified.length,2);assert.equal(sim.sn,sn);assert.equal(errors.at(-1).data.status,9);
  }finally{await c.disconnect();}
});
test('SN mismatch and lost write acknowledgement never report success or automatically reissue a write',async()=>{
  for(const mode of ['mismatch','lost']) {
    const sim=await new SimTransport().connect(),c=new CalibrationController({requestTimeoutMs:10,clock:()=>0});
    const verified=[],errors=[];let writes=0;
    const handler=sim._handleRequest.bind(sim);
    sim._handleRequest=frame=>{if(frame.command===Command.WRITE_SN){writes++;if(mode==='lost')return;}if(mode==='mismatch'&&frame.command===Command.READ_SN)sim.sn=snGenerate({sequence:2});return handler(frame);};
    c.on('sn_verified',e=>verified.push(e));c.on('error',e=>errors.push(e));c.connectTransport(sim,{});
    try {
      c.writeSn(snGenerate({sequence:1}));c.tick(1000);
      assert.equal(verified.length,0);assert.equal(writes,1);
      if(mode==='mismatch')assert.equal(errors.at(-1).data.reason,'SN_MISMATCH');
    }finally{await c.disconnect();}
  }
});
