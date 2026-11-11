import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEAN_LABELS, Command, encodeFrame, StreamDecoder, packMdTelemetry, unpackMdTelemetry } from '../aw_protocol.js';
import { mdValues, mdCsvCells, moistureCsv, MOISTURE_CSV_COLUMNS } from '../md_telemetry.js';
import { SimTransport } from '../aw_sim.js';
import { CalibrationController } from '../aw_controller.js';

const sample = { flags:7, beanId:1, sampleSequence:0xffffffff, moisturePct:12.5,
  densityGl:680, capacitancePf:16.125, weightAdc:-8388608, weightG:108.625 };

test('four device bean IDs, signed raw ADC and float values survive fragmented wire frames', () => {
  assert.deepEqual(BEAN_LABELS, ['烘焙豆','生豆','带壳豆','干果']);
  for (let beanId=0; beanId<4; beanId++) {
    const s = {...sample,beanId};
    const payload = packMdTelemetry(s);
    assert.equal(payload.length,26);
    assert.equal(Buffer.from(payload).toString('hex'),
      `07${beanId.toString(16).padStart(2,'0')}ffffffff0000484100002a4400008141000080ff0040d942`);
    const frame = encodeFrame(Command.MD_TELEMETRY,42,payload), decoder = new StreamDecoder();
    assert.deepEqual(decoder.feed(frame.slice(0,13)),[]);
    const [decoded] = decoder.feed(frame.slice(13));
    assert.deepEqual(unpackMdTelemetry(decoded.payload),s);
    assert.equal(mdValues(s).beanName,BEAN_LABELS[beanId]);
  }
  assert.throws(()=>unpackMdTelemetry(new Uint8Array(25)));
});

test('unavailable sensors and unknown bean IDs never masquerade as valid moisture or density', () => {
  assert.equal(mdValues({...sample,flags:0}).moisturePct,null);
  assert.equal(mdValues({...sample,flags:0}).weightAdc,null);
  assert.equal(mdValues({...sample,flags:1}).capacitancePf,sample.capacitancePf);
  assert.equal(mdValues({...sample,flags:1}).densityGl,null);
  assert.equal(mdValues({...sample,beanId:255}).moisturePct,null);
  assert.equal(mdValues({...sample,moisturePct:NaN}).moisturePct,null);
  assert.deepEqual(mdCsvCells(sample),[1,'生豆',12.5,680,16.125,-8388608,108.625,null,null]);
  assert.equal(mdCsvCells({...sample,flags:0})[2],null);
});

test('extended telemetry carries same-frame empty and signed delta while legacy frames stay readable', () => {
  for (const deltaCapacitancePf of [-0.25, 0, 0.125]) {
    const s = {...sample, flags:15, capacitancePf:2.25 + deltaCapacitancePf,
      emptyCapacitancePf:2.25, deltaCapacitancePf};
    const payload = packMdTelemetry(s);
    assert.equal(payload.length,34);
    const wire = encodeFrame(Command.MD_TELEMETRY,99,payload);
    const decoder = new StreamDecoder();
    assert.deepEqual(decoder.feed(wire.slice(0,29)),[]);
    const [frame] = decoder.feed(wire.slice(29));
    const parsed = unpackMdTelemetry(frame.payload);
    assert.deepEqual(parsed,s);
    assert.equal(mdValues(parsed).deltaCapacitancePf,deltaCapacitancePf);
    assert.equal(mdValues(parsed).emptyCapacitancePf,2.25);
  }
  const legacy = unpackMdTelemetry(packMdTelemetry(sample));
  assert.equal(mdValues(legacy).emptyCapacitancePf,null);
  assert.equal(mdValues(legacy).deltaCapacitancePf,null);
  for (const size of [0,25,27,30,33,35]) assert.throws(()=>unpackMdTelemetry(new Uint8Array(size)));
});

test('missing calibration, stale snapshots and unavailable sensors never create a fake delta zero', () => {
  const s = {...sample,flags:15,emptyCapacitancePf:2.25,deltaCapacitancePf:0};
  assert.equal(mdValues(s).deltaCapacitancePf,0);
  for (const flags of [0,1,7]) {
    assert.equal(mdValues({...s,flags}).emptyCapacitancePf,null);
    assert.equal(mdValues({...s,flags}).deltaCapacitancePf,null);
  }
  assert.equal(mdValues({...s,flags:8}).emptyCapacitancePf,2.25);
  assert.equal(mdValues({...s,flags:8}).deltaCapacitancePf,null);
  for (const emptyCapacitancePf of [0,-1,NaN,Infinity]) {
    assert.equal(mdValues({...s,emptyCapacitancePf}).deltaCapacitancePf,null);
  }
  assert.equal(mdValues({...s,deltaCapacitancePf:NaN}).deltaCapacitancePf,null);
});

test('CSV preserves per-sample recalibration and leaves reference moisture blank for real standards', () => {
  const first = {...sample,flags:15,timestamp:'2026-10-22T04:00:00Z',
    capacitancePf:2,emptyCapacitancePf:2.25,deltaCapacitancePf:-0.25};
  const second = {...first,sampleSequence:8,emptyCapacitancePf:2,deltaCapacitancePf:0};
  const csv = moistureCsv([first,second],'SN,"A"');
  const rows = csv.split('\r\n');
  assert.equal(rows[0],MOISTURE_CSV_COLUMNS.join(','));
  assert.ok(rows[1].includes('"SN,""A"""'));
  assert.ok(rows[1].endsWith(',2.25,-0.25,'));
  assert.ok(rows[2].endsWith(',2,0,'));
  const plain = moistureCsv([first,second],'SN123').split('\r\n');
  for (const row of plain) assert.equal(row.split(',').length,MOISTURE_CSV_COLUMNS.length);
  const deviceValueColumn = MOISTURE_CSV_COLUMNS.indexOf('moisture_device_pct');
  assert.equal(Number(plain[1].split(',')[deviceValueColumn]),12.5);
  assert.equal(plain[1].split(',').at(-1),'');
  assert.ok(moistureCsv([sample],'old').split('\r\n')[1].endsWith(',,,') );
});

test('production controller receives independent MD stream, records bean and rejects malformed payload', async () => {
  const transport = new SimTransport();
  const controller = new CalibrationController();
  await transport.connect();
  controller.connectTransport(transport,{mode:'simulator'});
  // Manual frames below are deterministic; prevent automatic streaming ticks.
  clearInterval(transport._timer); transport._timer = null;
  const received=[];
  controller.on('md_telemetry',({data})=>received.push(data));
  try {
    for(let beanId=0;beanId<4;beanId++) {
      transport.beanId=beanId;
      transport._telemetryFrame();
    }
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(received.slice(0,4).map(s=>s.beanId),[0,1,2,3]);
    assert.ok(controller.session.telemetry.length>=4);
    assert.ok(controller.session.mdTelemetry.length>=4);
    assert.ok(received.every(s=>s.timestamp && s.weightAdc===123456));
    const before=received.length;
    transport._event(Command.MD_TELEMETRY,new Uint8Array(25));
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(received.length,before);
  } finally { await controller.disconnect(); }
});
