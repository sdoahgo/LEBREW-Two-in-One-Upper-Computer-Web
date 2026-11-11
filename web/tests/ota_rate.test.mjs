import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtaTransferRate, formatTransferRate } from '../ota_rate.js';
import { runWireOta, uploadToFirmware } from '../aw_ota.js';
import { SimTransport } from '../aw_sim.js';
import { OtaResult, OTA_RESULT_KEY } from '../ota_status.js';

test('rate units and zero elapsed time never display Infinity or NaN', () => {
  assert.equal(formatTransferRate(null),'--');
  assert.equal(formatTransferRate(Infinity),'--');
  assert.equal(formatTransferRate(-1),'--');
  assert.equal(formatTransferRate(0),'0 B/s');
  assert.equal(formatTransferRate(512),'512 B/s');
  assert.equal(formatTransferRate(10240),'10.0 KB/s');
  assert.equal(formatTransferRate(2*1024*1024),'2.00 MB/s');
  const rate=new OtaTransferRate(1024,()=>0);
  rate.update(1024);
  assert.equal(rate.snapshot().averageBps,0);
  assert.equal(rate.snapshot().currentBps,0);
});

test('recent speed falls to zero on a stall; retries and padding do not inflate payload bytes', () => {
  let now=0;
  const rate=new OtaTransferRate(4096,()=>now);
  now=1000; rate.update(1024);
  assert.equal(rate.snapshot().currentBps,1024);
  assert.equal(rate.snapshot().averageBps,1024);
  now=1500; rate.update(512); // repeated ACK or retransmission
  assert.equal(rate.snapshot().sent,1024);
  now=3000;
  assert.equal(rate.snapshot().currentBps,0);
  assert.equal(rate.snapshot().averageBps,1024/3);
  now=4000; rate.update(5000); // final packet padding
  assert.equal(rate.snapshot().sent,4096);
  assert.equal(rate.snapshot().averageBps,1024);
  rate.update(NaN);
  assert.equal(rate.snapshot().sent,4096);
});

test('stopping freezes transfer average and survives result reload; a new transfer starts clean', () => {
  let now=10000;
  const rate=new OtaTransferRate(2048,()=>now);
  now+=2000; rate.update(2048);
  const finished=rate.stop();
  now+=30000; rate.update(2048);
  assert.deepEqual(rate.snapshot(),finished);
  assert.equal(finished.averageBps,1024);
  assert.equal(finished.currentBps,0);
  assert.equal(finished.finished,true);
  const values=new Map(), storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const result=new OtaResult(storage);
  result.value={phase:'completed',percent:100,transferStats:finished}; result.save(true);
  const reloaded=new OtaResult(storage);
  assert.equal(reloaded.value.transferStats.averageBps,1024);
  assert.ok(values.has(OTA_RESULT_KEY));
  const next=new OtaTransferRate(4096,()=>now);
  assert.equal(next.snapshot().sent,0);
  assert.equal(next.snapshot().averageBps,0);
});

for (const channel of ['serial','ble']) test(`${channel}: actual OTA progress reports unpadded confirmed bytes before END and excludes validation wait`, async () => {
  const sim=await new SimTransport().connect();
  clearInterval(sim._timer);sim._timer=null;
  let now=5000, rate, lastProgress, atValidation;
  const original=(channel==='ble' ? sim.writeData : sim.write).bind(sim);
  const write=async bytes=>{
    if(channel==='ble'||bytes.length===246) now+=100;
    return original(bytes);
  };
  if(channel==='ble')sim.writeData=write; else sim.write=write;
  const bytes=new Uint8Array(244*10+37);
  try {
    await runWireOta({transport:sim,channel,bytes,packetGapMs:0,
      onPhase:phase=>{
        if(phase==='sending')rate=new OtaTransferRate(bytes.length,()=>now);
        if(phase==='validating'){
          atValidation={...lastProgress};rate.stop();now+=9000;
        }
      },
      onProgress:p=>{lastProgress=p;rate?.update(p.transferred);},
    });
    assert.equal(atValidation.sent,bytes.length-1);
    assert.equal(atValidation.transferred,bytes.length);
    assert.equal(atValidation.percent,99);
    assert.equal(rate.snapshot().sent,bytes.length);
    assert.equal(rate.snapshot().elapsedMs,1100);
    assert.ok(Math.abs(rate.snapshot().averageBps-bytes.length/1.1)<1e-9);
    assert.equal(lastProgress.percent,100);
  } finally {await sim.disconnect();}
});

test('WiFi uses XHR payload progress and freezes average before final HTTP validation', async () => {
  const original=globalThis.XMLHttpRequest;
  const bytes=new Uint8Array(2048);bytes[0]=0xe9;bytes[12]=13;
  let now=20000; // Waiting for AP is deliberately before transfer timing begins.
  const rate=new OtaTransferRate(bytes.length,()=>now);
  globalThis.XMLHttpRequest=class {
    upload={};status=200;responseText='OK-rebooting';
    open(){}setRequestHeader(){}
    send(){
      now+=1000;this.upload.onprogress({lengthComputable:true,loaded:1024,total:2048});
      now+=1000;this.upload.onprogress({lengthComputable:true,loaded:2048,total:2048});
      now+=10000;this.onload();
    }
  };
  try {
    await uploadToFirmware(bytes,(loaded,total)=>{rate.update(loaded);if(loaded>=total)rate.stop();});
    assert.equal(rate.snapshot().averageBps,1024);
    assert.equal(rate.snapshot().elapsedMs,2000);
    assert.equal(rate.snapshot().sent,2048);
  } finally {globalThis.XMLHttpRequest=original;}
});
