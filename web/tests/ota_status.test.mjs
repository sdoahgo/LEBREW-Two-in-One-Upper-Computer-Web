import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OtaResult,firmwareIdentity,otaPresentation} from '../ota_status.js';
import {SimTransport} from '../aw_sim.js';
import {CalibrationController} from '../aw_controller.js';
import {runWireOta} from '../aw_ota.js';
function image(byte=0xa7){const b=new Uint8Array(300);b[0]=0xe9;b[12]=13;new DataView(b.buffer).setUint32(32,0xabcd5432,true);b.set(new TextEncoder().encode('same-dirty'),48);b.fill(byte,176,208);return b;}
function storage(){let raw=null;return {getItem:()=>raw,setItem:(_,v)=>{raw=v;}};}
test('read ESP application version and ELF identity from selected image',()=>{
  assert.deepEqual(firmwareIdentity(image()),{version:'same-dirty',sha256:'a7'.repeat(32)});
  assert.deepEqual(firmwareIdentity(new Uint8Array(64)),{version:'',sha256:''});
});
test('100% transmission does not become a completed upgrade until device confirms and identity matches',()=>{
  const r=new OtaResult(storage());r.start('firmware.bin','serial',image());
  r.set('sending','sending');r.progress(100,'all bytes uploaded');
  assert.equal(r.value.percent,99);assert.notEqual(r.value.phase,'completed');
  r.confirmed();assert.equal(r.value.phase,'restarting');assert.equal(r.value.percent,100);
  r.disconnected();assert.equal(r.value.phase,'awaiting_reconnect');
  assert.equal(r.verify({sha256:'a7'.repeat(32),uptimeMs:1000}),true);
  assert.equal(r.value.phase,'completed');assert.equal(otaPresentation(r.value).tone,'success');
});
test('same version string cannot hide a wrong running firmware fingerprint',()=>{
  const r=new OtaResult(storage());r.start('new.bin','ble',image());r.confirmed();
  assert.equal(r.verify({sha256:'b8'.repeat(32)}),false);
  assert.equal(r.value.phase,'mismatch');assert.equal(otaPresentation(r.value).tone,'error');
});
test('completion persists across reload and a later file does not erase previous result',()=>{
  const s=storage(),r=new OtaResult(s);r.start('old.bin','serial',image());r.confirmed();r.verify({sha256:'a7'.repeat(32)});
  const loaded=new OtaResult(s);assert.equal(loaded.value.phase,'completed');assert.equal(loaded.value.fileName,'old.bin');
});
test('page reload during transfer produces unconfirmed state instead of success',()=>{
  const s=storage(),r=new OtaResult(s,()=>1000);r.start('firmware.bin','serial',image());r.set('sending','sending');r.progress(80,'');
  const loaded=new OtaResult(s);assert.equal(loaded.value.phase,'unconfirmed');assert.equal(loaded.value.percent,0); // last durable checkpoint is phase transition
});
test('unknown file identity never gets a green success result',()=>{
  const r=new OtaResult(storage());r.start('unknown.bin','serial',new Uint8Array(64));r.confirmed();
  assert.equal(r.verify({sha256:'a7'.repeat(32)}),false);assert.equal(r.value.phase,'unconfirmed');
});
test('read-only fingerprint check does not claim a flash operation happened',()=>{
  const r=new OtaResult(storage());r.start('fw.bin','verify',image());r.value.verifyOnly=true;r.set('unconfirmed','check');
  r.verify({sha256:'a7'.repeat(32)});
  assert.equal(otaPresentation(r.value).title,'✓ 当前固件已核对');
  assert.match(r.value.detail,/无需重复升级/);
});
test('controller reads fingerprint response through the actual framed transport',async()=>{
  const sim=await new SimTransport().connect(),c=new CalibrationController();
  try{
    c.connectTransport(sim,{mode:'simulator'});
    const identity=new Promise(resolve=>c.on('firmware_identity',({data})=>resolve(data)));
    c.readFirmwareIdentity();
    assert.equal((await identity).sha256,'a7'.repeat(32));
  }finally{await c.disconnect();await sim.disconnect();}
});
test('OTA engine exposes prepare, transfer and validation phases in order',async()=>{
  const sim=await new SimTransport().connect(),phases=[];
  try{await runWireOta({transport:sim,channel:'serial',bytes:image(),packetGapMs:0,onPhase:p=>phases.push(p)});
    assert.deepEqual(phases,['preparing','sending','validating']);
  }finally{await sim.disconnect();}
});
