import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimTransport } from '../aw_sim.js';
import { CalibrationController } from '../aw_controller.js';
import { runWireOta, validateFirmwareImage, startApProbe, uploadToFirmware } from '../aw_ota.js';
import { Command, StreamDecoder, parseBleOtaAck, serialOtaBurstSupported } from '../aw_protocol.js';
import {trafficPreview} from '../log_preview.js';

test('firmware traffic preview stays bounded without changing raw bytes or small control frames',()=>{
  assert.equal(trafficPreview(Uint8Array.of(0xa5,0x5a)),'A5 5A');
  const data=new Uint8Array(2460).fill(0x41),copy=data.slice();
  for(const hex of [true,false]){
    const text=trafficPreview(data,hex);assert.ok(text.length<420);assert.match(text,/2460 bytes/);
  }
  assert.deepEqual(data,copy);
});

test('serial burst mode requires an exact successful F2/v1 START capability',()=>{
  assert.equal(serialOtaBurstSupported(Uint8Array.of(0,0xf2,1,10)),true);
  for(const payload of [[0],[3,0xf2,1,10],[0,0xf1,1,10],[0,0xf2,2,10],[0,0xf2,1,32],[0,0xf2,1,10,0]])
    assert.equal(serialOtaBurstSupported(Uint8Array.from(payload)),false);
});

for(const fast of [false,true])test(`serial ${fast?'burst':'legacy'} transfer retains exact packet bytes, padding and progress`,async()=>{
  const sim=await new SimTransport().connect();sim.fastSerialOta=fast;
  const write=sim.write.bind(sim),chunks=[];let stats,progress;
  sim.write=async bytes=>{if(sim._serialOta&&!(bytes[0]===255&&bytes[1]===255))chunks.push(bytes.slice());return write(bytes);};
  const image=Uint8Array.from({length:244*23+37},(_,i)=>(i*17+5)&255);
  try{
    await runWireOta({transport:sim,channel:'serial',bytes:image,packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s,onProgress:p=>progress=p});
    assert.equal(stats.serialBurst,fast);assert.equal(stats.dataPackets,24);assert.equal(stats.writeCalls,fast?3:24);
    assert.equal(stats.retransmittedPackets,0);assert.equal(progress.percent,100);
    const all=Uint8Array.from(chunks.flatMap(c=>[...c]));assert.equal(all.length,24*246);
    for(let seq=0;seq<24;seq++){
      const packet=all.subarray(seq*246,(seq+1)*246);assert.equal((packet[0]<<8)|packet[1],seq);
      for(let j=0;j<244;j++)assert.equal(packet[j+2],seq*244+j<image.length?image[seq*244+j]:255);
    }
  }finally{await sim.disconnect();}
});

test('serial burst recovery after a lost ACK does not duplicate confirmed progress',async()=>{
  const sim=await new SimTransport().connect();sim.fastSerialOta=true;
  const emit=sim.emit.bind(sim);let dropped=false,stats;const progress=[];
  sim.emit=(name,event)=>{
    if(name==='data'&&!dropped&&new StreamDecoder().feed(event.bytes).some(f=>f.command===Command.OTA_ACK)) {dropped=true;return;}
    return emit(name,event);
  };
  try{
    await runWireOta({transport:sim,channel:'serial',bytes:new Uint8Array(244*25+37),packetGapMs:0,ackTimeoutMs:20,
      onStats:s=>stats=s,onProgress:p=>progress.push(p.transferred)});
    assert.equal(stats.serialBurst,true);assert.equal(stats.timeouts,1);assert.equal(stats.retransmittedPackets,10);
    assert.equal(progress.at(-1),244*25+37);assert.ok(progress.every((v,i)=>!i||v>=progress[i-1]));
  }finally{await sim.disconnect();}
});

test('serial burst crosses 1200/1300 sequence values and can force legacy pacing',async()=>{
  for(const preferFastSerial of [true,false]){
    const sim=await new SimTransport().connect();sim.fastSerialOta=true;let stats;
    try{
      await runWireOta({transport:sim,channel:'serial',bytes:new Uint8Array(244*5100+37),preferFastSerial,packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s});
      assert.equal(stats.serialBurst,preferFastSerial);assert.equal(stats.retransmittedPackets,0);assert.equal(stats.timeouts,0);
      assert.ok(sim.otaLog.some(x=>x.includes('END')&&x.includes('校验通过')));
    }finally{await sim.disconnect();}
  }
});

test('fast BLE capability requires exact recognized extension; legacy ACK remains compatible',()=>{
  assert.deepEqual(parseBleOtaAck(Uint8Array.of(0xa0,0,0,0)),{ok:true,seq:0});
  assert.equal(parseBleOtaAck(Uint8Array.of(0xa0,0,0,0,0xf1,1,32)).fastWindow,32);
  for(const tail of [[0xf1,2,32],[0xf1,1,64],[0,1,32],[0xf1,1,32,0]])
    assert.equal(parseBleOtaAck(Uint8Array.of(0xa0,0,0,0,...tail)).fastWindow,undefined);
  assert.equal(parseBleOtaAck(Uint8Array.of(0xa0,1,0,0,0xf1,1,32)).fastWindow,undefined);
});

for(const fast of [false,true])test(`BLE negotiates ${fast?'32':'10'} packets without changing old firmware behavior`,async()=>{
  const sim=await new SimTransport().connect();sim.fastBleOta=fast;
  sim.prepareOtaData=async()=>242;let stats,final,start;
  const control=sim.writeControl.bind(sim);
  sim.writeControl=async bytes=>{if(bytes.length===7)start=bytes[0];return control(bytes);};
  try{
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(242*65+37),packetGapMs:0,
      ackTimeoutMs:30,onStats:s=>stats=s,onProgress:p=>final=p});
    assert.equal(start,fast?0x14:0x11);assert.equal(stats.ackWindow,fast?32:10);
    assert.equal(stats.dataPackets,66);assert.equal(stats.retransmittedPackets,0);assert.equal(final.percent,100);
  }finally{await sim.disconnect();}
});

test('lost fast-window ACK recovers without reporting premature completion',async()=>{
  const sim=await new SimTransport().connect();sim.fastBleOta=true;sim.prepareOtaData=async()=>242;
  const emit=sim.emit.bind(sim);let dropped=false,stats;
  sim.emit=(name,event)=>{
    if(name==='data'&&event.kind==='ctrl'&&!dropped&&event.bytes[1]===0&&event.bytes[3]===31){dropped=true;return;}
    emit(name,event);
  };
  try{
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(242*66+37),packetGapMs:0,ackTimeoutMs:20,onStats:s=>stats=s});
    assert.equal(dropped,true);assert.equal(stats.ackWindow,32);assert.equal(stats.timeouts,1);
    assert.ok(stats.retransmittedPackets<=32);assert.ok(sim.otaLog.some(x=>x.includes('END')&&x.includes('校验通过')));
  }finally{await sim.disconnect();}
});

test('fast BLE recovers a missing packet and can explicitly select legacy mode',async()=>{
  for(const preferFastBle of [true,false]){
    const sim=await new SimTransport().connect();sim.fastBleOta=true;sim.prepareOtaData=async()=>242;
    const write=sim.writeData.bind(sim);let dropped=false,stats;
    sim.writeData=async packet=>{if(!dropped&&packet[0]===0&&packet[1]===2){dropped=true;return;}return write(packet);};
    try{
      await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(242*70+37),preferFastBle,packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s});
      assert.equal(stats.ackWindow,preferFastBle?32:10);assert.equal(stats.nacks,1);assert.equal(stats.timeouts,0);
      assert.ok(stats.retransmittedPackets<=stats.ackWindow);
    }finally{await sim.disconnect();}
  }
});

test('large serial image crosses sequence 1200 and 1300 without treating data as END/ABORT', async () => {
  const sim = await new SimTransport().connect();
  try {
    let final;
    await runWireOta({transport:sim, channel:'serial', bytes:new Uint8Array(244*5100+37), packetGapMs:0,
      ackTimeoutMs:30, onProgress:p=>{final=p;}});
    assert.equal(final.percent,100);
    assert.ok(sim.otaLog.some(x=>x.includes('END') && x.includes('校验通过')));
  } finally { await sim.disconnect(); }
});

for (const channel of ['serial','ble']) test(`${channel} lost window ACK retries without double counting firmware`, async () => {
  const sim = await new SimTransport().connect();
  const emit=sim.emit.bind(sim); let dropped=false;
  sim.emit=(name,event)=>{
    if(name==='data'&&!dropped) {
      const isAck=event.kind==='ctrl' ? event.bytes[2]===0&&event.bytes[3]===9 :
        new StreamDecoder().feed(event.bytes).some(f=>f.command===Command.OTA_ACK);
      if(isAck){dropped=true;return;}
    }
    emit(name,event);
  };
  try {
    await runWireOta({transport:sim,channel,bytes:new Uint8Array(244*21+33),packetGapMs:0,ackTimeoutMs:20});
    assert.equal(dropped,true);
    assert.ok(sim.otaLog.some(x=>x.includes('END')&&x.includes('校验通过')));
  } finally { await sim.disconnect(); }
});

test('persistent NACK terminates with ABORT and never reports success', async()=>{
  const sim=await new SimTransport().connect();let writes=0;
  sim.writeData=async()=>{writes++;sim.emit('data',{kind:'ctrl',bytes:Uint8Array.of(0xa0,1,0,0)});};
  try {
    await assert.rejects(runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(1000),packetGapMs:0,ackTimeoutMs:10}),/窗口/);
    assert.ok(writes<100);assert.ok(sim.otaLog.some(x=>x.includes('ABORT')));
  } finally {await sim.disconnect();}
});

test('queued old NACKs yield to the newest cumulative ACK instead of causing recovery storms',async()=>{
  const sim=await new SimTransport().connect();
  const original=sim.writeData.bind(sim);let stats;
  sim.writeData=async packet=>{
    const seq=(packet[0]<<8)|packet[1];
    if(seq===9)for(let i=0;i<7;i++)sim.emit('data',{kind:'ctrl',bytes:Uint8Array.of(0xa0,1,0,2)});
    return original(packet);
  };
  try {
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(244*31+37),packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s});
    assert.equal(stats.retransmittedPackets,0);assert.equal(stats.nacks,0);assert.equal(stats.timeouts,0);
  }finally{await sim.disconnect();}
});

test('one missing packet plus a burst of NACKs recovers without repeatedly consuming stale requests',async()=>{
  const sim=await new SimTransport().connect();
  const original=sim.writeData.bind(sim);let dropped=false,stats;
  sim.writeData=async packet=>{
    if(!dropped&&packet[0]===0&&packet[1]===2){dropped=true;return;}
    return original(packet);
  };
  try {
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(244*31+37),packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s});
    assert.equal(dropped,true);assert.equal(stats.nacks,1);
    assert.ok(stats.retransmittedPackets<=10);assert.equal(stats.timeouts,0);
  }finally{await sim.disconnect();}
});

test('reserved fatal Flash failure stops immediately without a success result or END request',async()=>{
  const sim=await new SimTransport().connect();let packets=0;
  sim.writeData=async()=>{packets++;sim.emit('data',{kind:'ctrl',bytes:Uint8Array.of(0xa0,1,255,255)});};
  try {
    await assert.rejects(runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(244*20),packetGapMs:0,ackTimeoutMs:10}),/写入 Flash 失败/);
    assert.equal(packets,10);assert.ok(sim.otaLog.some(x=>x.includes('ABORT')));
    assert.ok(!sim.otaLog.some(x=>x.includes('END')));
  }finally{await sim.disconnect();}
});

test('BLE packet length negotiation happens after ABORT and before START, with the negotiated chunk on wire',async()=>{
  const sim=await new SimTransport().connect();let prepared=false,stats;
  sim.otaWriteMode='无响应写';
  sim.prepareOtaData=async max=>{assert.equal(max,244);assert.equal(sim._bleOta,null);prepared=true;return 242;};
  const write=sim.writeData.bind(sim);
  sim.writeData=async packet=>{assert.equal(prepared,true);assert.equal(packet.length,244);return write(packet);};
  try {
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(242*21+17),packetGapMs:0,ackTimeoutMs:30,onStats:s=>stats=s});
    assert.equal(stats.dataPackets,22);assert.equal(stats.retransmittedPackets,0);
    assert.ok(sim.otaLog.some(x=>x.includes('chunk=242')));
  }finally{await sim.disconnect();}
});

test('asynchronous NACK bursts and partial ACKs keep already sent packets in flight instead of resending them',async()=>{
  const sim=await new SimTransport().connect();
  const original=sim.writeData.bind(sim);let dropped=false,stats,chain=Promise.resolve();
  sim.writeData=async packet=>{
    const copy=packet.slice();
    chain=chain.then(()=>new Promise(resolve=>setTimeout(resolve,2))).then(()=>{
      if(!dropped&&copy[0]===0&&copy[1]===2){dropped=true;return;}
      return original(copy);
    });
  };
  try {
    await runWireOta({transport:sim,channel:'ble',bytes:new Uint8Array(244*41+37),packetGapMs:0,ackTimeoutMs:300,onStats:s=>stats=s});
    await chain;
    assert.equal(stats.nacks,1);assert.equal(stats.timeouts,0);
    assert.ok(stats.retransmittedPackets<=10,JSON.stringify(stats));
  }finally{await chain;await sim.disconnect();}
});

test('controller suspends pending retries and heartbeat while OTA owns transport',()=>{
  const c=new CalibrationController();let writes=0;
  c._connected=true;c._transport={write:()=>{writes++;}};
  c._pending.set(1,{operation:'read_info'});
  c.pauseForOta();c.tick();c.sendHeartbeat();
  assert.equal(writes,0);assert.equal(c._pending.size,0);
  c.resumeAfterOta();assert.equal(c._otaPaused,false);
  c._activeCapture={};assert.throws(()=>c.pauseForOta(),/采集/);
});

function image(){const b=new Uint8Array(64);b[0]=0xe9;b[12]=13;return b;}
test('firmware selector rejects wrong chip, empty, merged and oversized images',()=>{
  validateFirmwareImage(image());
  assert.throws(()=>validateFirmwareImage(new Uint8Array()),/固件/);
  const wrong=image();wrong[12]=5;assert.throws(()=>validateFirmwareImage(wrong),/C6/);
  assert.throws(()=>validateFirmwareImage(new Uint8Array(100)),/固件/);
  const big=new Uint8Array(0x1e0001);big.set(image());assert.throws(()=>validateFirmwareImage(big),/容量/);
});

test('hotspot probe validates identity and uses readable CORS request',async()=>{
  const original=globalThis.fetch;let ready=0,calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.mode,'cors');assert.match(url,/\/info$/);return {ok:true,json:async()=>({device:'LEBREW-AW',ota:true})};};
  try {
    await new Promise((resolve,reject)=>{
      const stop=startApProbe(()=>{},()=>{ready++;resolve();},3000);
      setTimeout(()=>{stop();if(!ready)reject(new Error('probe did not recognize device'));},1200);
    });
    assert.equal(calls,1);assert.equal(ready,1);
  } finally {globalThis.fetch=original;}
});

test('HTTP 200 without device validation success is not accepted as successful upgrade',async()=>{
  const original=globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest=class {
    upload={};status=200;responseText='ERR:end';
    open(){}setRequestHeader(){}send(){this.onload();}
  };
  try {await assert.rejects(uploadToFirmware(image()),/ERR:end/);}
  finally{globalThis.XMLHttpRequest=original;}
});

test('hotspot wait timeout invokes recovery callback without starting upload',async()=>{
  let ready=false;
  await new Promise(resolve=>startApProbe(()=>{},()=>{ready=true;},1,resolve));
  assert.equal(ready,false);
});
