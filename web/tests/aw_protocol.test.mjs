// aw_protocol.test.mjs — 协议层黄金向量自测（向量由 aw_calibrator Python 源码生成）
// 运行：node tests/aw_protocol.test.mjs（Node 18+，无需硬件）

import {
  crc16CcittFalse, encodeFrame, StreamDecoder, unpackDeviceInfo,
  packDeviceInfo, unpackDeviceParameters, packDeviceParameters,
  packSetParamsRequest, unpackSetParamsRequest,
  packStartCaptureRequest, unpackStartCaptureRequest,
  unpackStartCaptureResponse, packStartCaptureResponse,
  packSetStreamRequest, unpackSetStreamRequest, unpackSetStreamResponse,
  unpackTelemetry, packTelemetry,
  unpackCaptureProgress, packCaptureProgress,
  unpackCaptureResult, packCaptureResult,
  unpackNotice, packNotice,
  packOtaAck, unpackOtaAck,
} from '../aw_protocol.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = typeof actual === 'string' ? actual : hex(actual);
  const e = typeof expected === 'string' ? expected : hex(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}\n  actual   ${a}\n  expected ${e}`);
  }
}

function assert(name, condition, detail = '') {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name} ${detail}`);
  }
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function floatsEqual(a, b) {
  // float32 精度：按数量级给相对容差
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

// —— CRC 标准校验值 ——
assert('crc16-ccitt-false check value', crc16CcittFalse(new TextEncoder().encode('123456789')) === 0x29b1);

// —— 帧编码黄金向量（Python encode_frame 输出）——
check('GET_INFO seq=1', encodeFrame(0x01, 1), 'a55a040001010100047a');
check('GET_PARAMS seq=2', encodeFrame(0x02, 2), 'a55a0400010202000776');
check('SET_STREAM seq=3', encodeFrame(0x07, 3, packSetStreamRequest(true, 100)), 'a55a070001070300016400f5c7');
check('START_CAPTURE seq=4', encodeFrame(0x05, 4, packStartCaptureRequest(2, 0x1122334455667788n)), 'a55a0d0001050400028877665544332211c440');
check('TELEMETRY event seq=7', encodeFrame(0x40, 7, packTelemetry({
  flags: 0x03, sampleSequence: 0xaabbccdd, temperatureC: 25.5, humidityRaw: 38.857,
  humidityCorrected: 39.0, awUnclamped: 0.75, awFinal: 0.75,
})), 'a55a1d000140070003ddccbbaa0000cc41916d1b4200001c420000403f0000403f89d0');
check('OTA_START seq=9', encodeFrame(0x09, 9, new Uint8Array([0x00, 0x12, 0x34, 0x56, 0x78, 0x00, 0xf4])), 'a55a0b0001090900001234567800f4d44b');

// —— 解码器：乱码前缀 + 半帧 + 尾部粘连 ——
{
  const golden = encodeFrame(0x01, 1);
  const telemetry = encodeFrame(0x40, 7, packTelemetry({
    flags: 3, sampleSequence: 0xaabbccdd, temperatureC: 25.5, humidityRaw: 38.857,
    humidityCorrected: 39, awUnclamped: 0.75, awFinal: 0.75,
  }));
  const decoder = new StreamDecoder();
  const part1 = decoder.feed(new Uint8Array([0x00, 0x67, 0x72, 0x62, ...golden.slice(0, 5)]));
  const part2 = decoder.feed(new Uint8Array([...golden.slice(5), 0xa5, ...telemetry]));
  const frames = [...part1, ...part2];
  assert('decoder frames across split', frames.length === 2, `got ${frames.length}`);
  assert('decoder frame identities', frames[0].command === 0x01 && frames[0].sequence === 1 &&
    frames[1].command === 0x40 && frames[1].sequence === 7);
  assert('decoder error counters', decoder.crcErrors === 0 && decoder.lengthErrors === 0 && decoder.versionErrors === 0);
}

// —— 解码器：CRC 损坏帧被丢弃、后续好帧恢复 ——
{
  const good = encodeFrame(0x02, 9);
  const corrupt = encodeFrame(0x02, 10);
  corrupt[corrupt.length - 1] ^= 0xff;
  const decoder = new StreamDecoder();
  const frames = decoder.feed(new Uint8Array([...corrupt, ...good]));
  assert('crc-error dropped then recovered', frames.length === 1 && frames[0].sequence === 9);
  assert('crc error counted', decoder.crcErrors === 1);
}

// —— 载荷往返与黄金向量 ——
check('params payload', packDeviceParameters({
  status: 0, paramVersion: 1, paramsValid: true, calDewValid: false,
  slopeK: 1.25, offsetB: -0.5, calDew: 0.0,
}), '00010001000000a03f000000bf00000000');

check('capture_result payload', packCaptureResult({
  pointId: 3, resultCode: 0, captureId: 0x99aabbccddeeff01n, sampleCount: 150,
  elapsedMs: 480000, meanRhRaw: 98.787, meanRhCorrected: 98.9, stddevRhRaw: 0.01,
}), '030001ffeeddccbbaa99960000530700f292c542cdccc5420ad7233c');

check('progress payload', packCaptureProgress({
  pointId: 1, captureId: 0x99aabbccddeeff01n, sampleCount: 120, elapsedMs: 11900,
  meanRhRaw: 59.78, stddevRhRaw: 0.004,
}), '0101ffeeddccbbaa9978007c2e0000b81e6f426f12833b');

// unpack 黄金向量 → 数值断言
{
  const params = unpackDeviceParameters(new Uint8Array(Buffer.from('00010001000000a03f000000bf00000000', 'hex')));
  assert('params unpack k', floatsEqual(params.slopeK, 1.25), String(params.slopeK));
  assert('params unpack b', floatsEqual(params.offsetB, -0.5), String(params.offsetB));
  assert('params unpack flags', params.paramsValid === true && params.calDewValid === false && params.paramVersion === 1);
}
{
  const result = unpackCaptureResult(new Uint8Array(Buffer.from('030001ffeeddccbbaa99960000530700f292c542cdccc5420ad7233c', 'hex')));
  assert('result unpack', result.pointId === 3 && result.resultCode === 0 &&
    result.captureId === 0x99aabbccddeeff01n && result.sampleCount === 150 &&
    floatsEqual(result.meanRhRaw, 98.787) && floatsEqual(result.stddevRhRaw, 0.01));
}
{
  const info = unpackDeviceInfo(packDeviceInfo(0, 'SIM-AW-0001', 'sim-web-1.0'));
  assert('device info roundtrip', info.status === 0 && info.deviceId === 'SIM-AW-0001' && info.firmwareVersion === 'sim-web-1.0');
}
{
  const start = unpackStartCaptureRequest(packStartCaptureRequest(2, 0x1122334455667788n));
  assert('start request roundtrip', start.pointId === 2 && start.captureId === 0x1122334455667788n);
  const resp = unpackStartCaptureResponse(packStartCaptureResponse(0, 2, 42n));
  assert('start response roundtrip', resp.status === 0 && resp.pointId === 2 && resp.captureId === 42n);
}
{
  const stream = unpackSetStreamResponse(new Uint8Array([0, 1, 100, 0]));
  assert('set stream response', stream.status === 0 && stream.enabled && stream.intervalMs === 100);
}
{
  const notice = unpackNotice(packNotice(2));
  assert('notice roundtrip', notice.noticeCode === 2);
}
{
  const ack = unpackOtaAck(packOtaAck(true, 500));
  assert('ota ack roundtrip', ack.ok === true && ack.seq === 500);
}

// —— 拟合数学：与 calibration.py 参考输出比对 ——
{
  const { calculateReport } = await import('../aw_calculus.js');
  const master = [38.983, 57.530, 71.577, 89.697];
  const device = [38.857, 59.780, 77.687, 98.787];
  const report = calculateReport(master, device);
  // Python 真值：endpoint K=0.8462206 B=6.1014065 RMSE=0.4410944；LSQ K=0.8475439 B=6.0499878 RMSE=0.4383381
  assert('endpoint slope', floatsEqual(report.endpoint.slopeK, 0.8462206), String(report.endpoint.slopeK));
  assert('endpoint offset', floatsEqual(report.endpoint.offsetB, 6.1014065), String(report.endpoint.offsetB));
  assert('endpoint rmse', floatsEqual(report.endpoint.rmse, 0.4410944), String(report.endpoint.rmse));
  assert('lsq slope', floatsEqual(report.leastSquares.slopeK, 0.8475439), String(report.leastSquares.slopeK));
  assert('lsq offset', floatsEqual(report.leastSquares.offsetB, 6.0499878), String(report.leastSquares.offsetB));
  assert('lsq rmse', floatsEqual(report.leastSquares.rmse, 0.4383381), String(report.leastSquares.rmse));
  assert('recommended is lsq (smaller rmse)', report.recommendedMethod === 'least_squares');
  assert('no warning for this input', report.warningReasons.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
