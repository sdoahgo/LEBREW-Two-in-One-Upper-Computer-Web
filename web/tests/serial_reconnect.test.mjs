import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectAuthorizedSerial} from '../serial_reconnect.js';
import {encodeFrame,packDeviceInfo,Command} from '../aw_protocol.js';
function port(deviceId,{busy=false,vendor=0x303a}={}) {
  let pending;const p={opened:0,closed:0,signals:[],getInfo:()=>({usbVendorId:vendor,usbProductId:0x1001}),async open(options){if(busy)throw new Error('busy');p.opened++;p.openOptions=options;},async close(){p.closed++;},async setSignals(s){p.signals.push(s);}};
  p.readable={getReader:()=>({read:()=>new Promise(resolve=>pending=resolve),async cancel(){pending?.({done:true});},releaseLock(){}})};
  p.writable={getWriter:()=>({async write(bytes){assert.equal(bytes[5],Command.GET_INFO);queueMicrotask(()=>pending({done:false,value:encodeFrame(Command.GET_INFO|0x80,0xe130,packDeviceInfo(0,deviceId,'test'))}));},releaseLock(){}})};
  return p;
}
test('previously authorized identity is selected among matching USB ports without chooser',async()=>{
  const other=port('TEST-DEVICE-01'),target=port('TEST-DEVICE-02');let chooser=0;
  const serial={getPorts:async()=>[port('unrelated',{vendor:0x1234}),other,target],requestPort:async()=>{chooser++;throw new Error('not authorized');}};
  const t=await connectAuthorizedSerial('TEST-DEVICE-02',{serial});
  assert.equal(t.port,target);assert.equal(other.closed,1);assert.equal(chooser,0);assert.equal(target.signals[0].dataTerminalReady,false);assert.equal(target.openOptions.bufferSize,16384);await t.disconnect();
});
test('unavailable or wrong identity never falls back to unrelated device or opens chooser',async()=>{
  let chooser=0;const wrong=port('wrong');
  const serial={getPorts:async()=>[port('busy',{busy:true}),wrong],requestPort:async()=>{chooser++;}};
  assert.equal(await connectAuthorizedSerial('target',{serial}),null);assert.equal(chooser,0);assert.equal(wrong.closed,1);
});
