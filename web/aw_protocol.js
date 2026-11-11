// aw_protocol.js — 水活标定（LEBREW 二合一）上位机协议层
// 逐行移植自 aw_calibrator/aw_calibrator/protocol.py（v2026.10.13-r2）：
//   帧 = A5 5A | body_len:2B LE | version:1B | command:1B | sequence:2B LE | payload | CRC16-CCITT-FALSE:2B LE
//   body_len = 4 + payload 长度（4..132），CRC 覆盖 body（len 字段起）。
// 蓝牙承载方式（B+混合方案）：0x2A38 写 [16B 密钥][A5 5A 完整帧]；0x2A37 Notify 原样上行帧。
// OTA 扩展命令（0x09..0x0C）为本次新增，串口控制走帧、数据走裸包，蓝牙控制走 0x2A39。

export const AW_HEADER = Object.freeze([0xa5, 0x5a]);
export const AW_VERSION = 1;
export const AW_MIN_BODY_LENGTH = 4;
export const AW_MAX_BODY_LENGTH = 132;

export const Command = Object.freeze({
  GET_INFO: 0x01,
  GET_FIRMWARE_ID: 0x0e, // 运行固件 ELF SHA256 + 本次开机时长
  READ_SN: 0x0f,
  WRITE_SN: 0x10,
  DEVICE_CONTROL: 0x12,
  MEASUREMENT_CONTROL: 0x11, // empty=status; [action,bean,mode,0,request_id:u32LE]
  GET_PARAMS: 0x02,
  SET_PARAMS: 0x03,
  RESET_PARAMS: 0x04,
  START_CAPTURE: 0x05,
  CANCEL_CAPTURE: 0x06,
  SET_STREAM: 0x07,
  HEARTBEAT: 0x08,
  // —— 本次新增的 OTA 扩展（固件 ≥ ota 版本才支持；旧固件回 UNKNOWN_COMMAND）——
  OTA_START: 0x09,   // 串口 OTA 开始：payload [total:4B BE][chunk:2B BE]；应答 0x89 [ok:1B]
  OTA_END: 0x0a,     // 串口 OTA 结束（校验字节数→切分区重启）；应答 0x8A [ok:1B]
  OTA_ABORT: 0x0b,   // 串口 OTA 中止；应答 0x8B [ok:1B]
  OTA_ENTER_AP: 0x0c,// 进入 WiFi 热点升级模式（重启）；应答 0x8C [ok:1B]
  BLE_DISCONNECT: 0x0d, // 结束本次 BLE 会话；应答后由设备主动终止物理连接
  TELEMETRY: 0x40,
  MD_TELEMETRY: 0x45,
  CAPTURE_PROGRESS: 0x41,
  CAPTURE_RESULT: 0x42,
  NOTICE: 0x43,
  OTA_ACK: 0x44,     // 串口 OTA 窗口 ACK 事件（对齐 smoke 0xA0 语义）：payload [ok:1B][seq:2B BE]
});

export const Status = Object.freeze({
  OK: 0,
  UNKNOWN_COMMAND: 1,
  BAD_LENGTH: 2,
  INVALID_PARAMETER: 3,
  BUSY: 4,
  SENSOR_UNAVAILABLE: 5,
  CAPTURE_TIMEOUT: 6,
  STORAGE_ERROR: 7,
  INTERNAL_ERROR: 8,
  SN_LOCKED: 9,
  MD_NOT_CALIBRATED: 10,
});

export const STATUS_NAMES = Object.freeze([
  'OK', 'UNKNOWN_COMMAND', 'BAD_LENGTH', 'INVALID_PARAMETER', 'BUSY',
  'SENSOR_UNAVAILABLE', 'CAPTURE_TIMEOUT', 'STORAGE_ERROR', 'INTERNAL_ERROR', 'SN_LOCKED', 'MD_NOT_CALIBRATED',
]);

export function statusName(value) {
  return STATUS_NAMES[value] ?? ('UNKNOWN_' + value);
}

// ---------------------------------------------------------------------------
// CRC16-CCITT-FALSE（初值 0xFFFF，多项式 0x1021，不反射）
// 标准校验值：crc16CcittFalse("123456789") === 0x29B1
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

export function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff];
  }
  return crc;
}

// ---------------------------------------------------------------------------
// 帧编码 / 解码（与 protocol.py encode_frame / StreamDecoder 语义一致）
// ---------------------------------------------------------------------------

export function encodeFrame(command, sequence, payload = new Uint8Array(0)) {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new Error('command must be a uint8');
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new Error('sequence must be a uint16');
  }
  if (!(payload instanceof Uint8Array)) {
    throw new Error('payload must be Uint8Array');
  }
  const bodyLength = AW_MIN_BODY_LENGTH + payload.length;
  if (bodyLength < AW_MIN_BODY_LENGTH || bodyLength > AW_MAX_BODY_LENGTH) {
    throw new Error('body length must be between 4 and 132');
  }
  // 线格式：body = len:2B(=4+payload) + ver:1B + cmd:1B + seq:2B + payload（len 字段不含自身 2 字节）
  const body = new Uint8Array(6 + payload.length);
  body[0] = bodyLength & 0xff;
  body[1] = (bodyLength >> 8) & 0xff;
  body[2] = AW_VERSION;
  body[3] = command;
  body[4] = sequence & 0xff;
  body[5] = (sequence >> 8) & 0xff;
  body.set(payload, 6);
  const frame = new Uint8Array(2 + body.length + 2);
  frame[0] = 0xa5;
  frame[1] = 0x5a;
  frame.set(body, 2);
  const crc = crc16CcittFalse(body);
  frame[2 + body.length] = crc & 0xff;
  frame[3 + body.length] = (crc >> 8) & 0xff;
  return frame;
}

export function responseCommand(requestCommand) {
  if (requestCommand & 0x80 || requestCommand >= 0x40) {
    throw new Error('request_command must not be a response or event');
  }
  return requestCommand | 0x80;
}

/** 增量帧解码器 — 与 protocol.py StreamDecoder 逐分支对应（含头部残尾保留与错误计数）。 */
export class StreamDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.crcErrors = 0;
    this.lengthErrors = 0;
    this.versionErrors = 0;
  }

  feed(data) {
    if (!(data instanceof Uint8Array)) throw new Error('data must be Uint8Array');
    const merged = new Uint8Array(this.buffer.length + data.length);
    merged.set(this.buffer, 0);
    merged.set(data, this.buffer.length);
    let bytes = merged;
    const frames = [];
    for (;;) {
      const headerIndex = findPattern(bytes, AW_HEADER);
      if (headerIndex < 0) {
        // 无头：保留可能是头部前缀的最后一个字节
        bytes = bytes.length > 0 && bytes[bytes.length - 1] === AW_HEADER[0]
          ? bytes.slice(bytes.length - 1)
          : new Uint8Array(0);
        this.buffer = bytes;
        return frames;
      }
      if (headerIndex > 0) bytes = bytes.slice(headerIndex);
      if (bytes.length < 4) {
        this.buffer = bytes;
        return frames;
      }
      const bodyLength = bytes[2] | (bytes[3] << 8);
      if (bodyLength < AW_MIN_BODY_LENGTH || bodyLength > AW_MAX_BODY_LENGTH) {
        this.lengthErrors += 1;
        bytes = bytes.slice(1);
        continue;
      }
      const frameLength = 2 + 2 + bodyLength + 2;
      if (bytes.length < frameLength) {
        this.buffer = bytes;
        return frames;
      }
      const bodyEnd = 4 + bodyLength;
      const expectedCrc = bytes[bodyEnd] | (bytes[bodyEnd + 1] << 8);
      if (crc16CcittFalse(bytes.slice(2, bodyEnd)) !== expectedCrc) {
        this.crcErrors += 1;
        bytes = bytes.slice(1);
        continue;
      }
      const version = bytes[4];
      if (version !== AW_VERSION) {
        this.versionErrors += 1;
        bytes = bytes.slice(1);
        continue;
      }
      frames.push({
        command: bytes[5],
        sequence: bytes[6] | (bytes[7] << 8),
        payload: bytes.slice(8, bodyEnd),
        version,
      });
      bytes = bytes.slice(frameLength);
    }
  }
}

function findPattern(bytes, pattern) {
  outer: for (let i = 0; i + pattern.length <= bytes.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 载荷编解码（结构与 protocol.py 的 struct 布局一一对应，全部小端）
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const dataViewScratch = new DataView(new ArrayBuffer(8));

function requireLength(payload, expected) {
  if (!(payload instanceof Uint8Array)) throw new Error('payload must be Uint8Array');
  if (payload.length !== expected) {
    throw new Error('payload length must be exactly ' + expected);
  }
}

function readF32LE(payload, offset) {
  dataViewScratch.setUint8(0, payload[offset]);
  dataViewScratch.setUint8(1, payload[offset + 1]);
  dataViewScratch.setUint8(2, payload[offset + 2]);
  dataViewScratch.setUint8(3, payload[offset + 3]);
  return dataViewScratch.getFloat32(0, true);
}

function writeF32LE(target, offset, value) {
  if (!Number.isFinite(value)) throw new Error('float payload value must be finite');
  dataViewScratch.setFloat32(0, value, true);
  target[offset] = dataViewScratch.getUint8(0);
  target[offset + 1] = dataViewScratch.getUint8(1);
  target[offset + 2] = dataViewScratch.getUint8(2);
  target[offset + 3] = dataViewScratch.getUint8(3);
}

function readU32LE(payload, offset) {
  return ((payload[offset] | (payload[offset + 1] << 8) |
    (payload[offset + 2] << 16) | (payload[offset + 3] << 24)) >>> 0);
}

function readU64LE(payload, offset) {
  let value = 0n;
  for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(payload[offset + byte]);
  return value;
}

function writeU64LE(target, offset, value) {
  let v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error('capture_id must be a uint64');
  for (let byte = 0; byte < 8; byte += 1) {
    target[offset + byte] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readText(bytes) {
  // protocol.py 要求 NUL 结尾且其后全零；浏览器侧放宽为按首个 NUL 截断（容错固件裁剪差异）
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return textDecoder.decode(bytes.slice(0, end));
}

function packText(value, fieldLength) {
  const encoded = textEncoder.encode(String(value));
  if (encoded.length > fieldLength - 1) {
    throw new Error('text field must contain at most ' + (fieldLength - 1) + ' UTF-8 bytes');
  }
  const out = new Uint8Array(fieldLength);
  out.set(encoded, 0);
  return out;
}

// GET_INFO 响应（37B）：status + device_id[20] + firmware_version[16]
export function unpackDeviceInfo(payload) {
  requireLength(payload, 37);
  return {
    status: payload[0],
    deviceId: readText(payload.slice(1, 21)),
    firmwareVersion: readText(payload.slice(21, 37)),
  };
}

export function packDeviceInfo(status, deviceId, firmwareVersion) {
  const out = new Uint8Array(37);
  out[0] = status;
  out.set(packText(deviceId, 20), 1);
  out.set(packText(firmwareVersion, 16), 21);
  return out;
}

// 参数（17B）：status + version:u16 + valid:u8 + calDewValid:u8 + k:f32 + b:f32 + calDew:f32
export function unpackDeviceParameters(payload) {
  requireLength(payload, 17);
  return {
    status: payload[0],
    paramVersion: payload[1] | (payload[2] << 8),
    paramsValid: payload[3] === 1,
    calDewValid: payload[4] === 1,
    slopeK: readF32LE(payload, 5),
    offsetB: readF32LE(payload, 9),
    calDew: readF32LE(payload, 13),
  };
}

export function packDeviceParameters(value) {
  const out = new Uint8Array(17);
  out[0] = value.status;
  out[1] = value.paramVersion & 0xff;
  out[2] = (value.paramVersion >> 8) & 0xff;
  out[3] = value.paramsValid ? 1 : 0;
  out[4] = value.calDewValid ? 1 : 0;
  writeF32LE(out, 5, value.slopeK);
  writeF32LE(out, 9, value.offsetB);
  writeF32LE(out, 13, value.calDew);
  return out;
}

export function packSetParamsRequest(slopeK, offsetB) {
  const out = new Uint8Array(8);
  writeF32LE(out, 0, slopeK);
  writeF32LE(out, 4, offsetB);
  return out;
}

export function unpackSetParamsRequest(payload) {
  requireLength(payload, 8);
  return { slopeK: readF32LE(payload, 0), offsetB: readF32LE(payload, 4) };
}

// START_CAPTURE 请求（9B）：point_id:u8 + capture_id:u64
export function packStartCaptureRequest(pointId, captureId) {
  const out = new Uint8Array(9);
  out[0] = pointId;
  writeU64LE(out, 1, captureId);
  return out;
}

export function unpackStartCaptureRequest(payload) {
  requireLength(payload, 9);
  return { pointId: payload[0], captureId: readU64LE(payload, 1) };
}

// START_CAPTURE 响应（10B）：status + point_id + capture_id
export function unpackStartCaptureResponse(payload) {
  requireLength(payload, 10);
  return { status: payload[0], pointId: payload[1], captureId: readU64LE(payload, 2) };
}

export function packStartCaptureResponse(status, pointId, captureId) {
  const out = new Uint8Array(10);
  out[0] = status;
  out[1] = pointId;
  writeU64LE(out, 2, captureId);
  return out;
}

// SET_STREAM 请求（3B）：enabled:u8 + interval_ms:u16
export function packSetStreamRequest(enabled, intervalMs) {
  return new Uint8Array([enabled ? 1 : 0, intervalMs & 0xff, (intervalMs >> 8) & 0xff]);
}

export function unpackSetStreamRequest(payload) {
  requireLength(payload, 3);
  return { enabled: payload[0] === 1, intervalMs: payload[1] | (payload[2] << 8) };
}

export function unpackSetStreamResponse(payload) {
  requireLength(payload, 4);
  return {
    status: payload[0],
    enabled: payload[1] === 1,
    intervalMs: payload[2] | (payload[3] << 8),
  };
}

export function packSetStreamResponse(status, enabled, intervalMs) {
  return new Uint8Array([status, enabled ? 1 : 0, intervalMs & 0xff, (intervalMs >> 8) & 0xff]);
}

// 遥测（25B）：flags + sample_sequence:u32 + 5 × f32
export function unpackTelemetry(payload) {
  requireLength(payload, 25);
  return {
    flags: payload[0],
    sampleSequence: readU32LE(payload, 1),
    temperatureC: readF32LE(payload, 5),
    humidityRaw: readF32LE(payload, 9),
    humidityCorrected: readF32LE(payload, 13),
    awUnclamped: readF32LE(payload, 17),
    awFinal: readF32LE(payload, 21),
  };
}

// Independent extension; the original 25-byte AW telemetry remains unchanged.
export const BEAN_LABELS = Object.freeze(['烘焙豆', '生豆', '带壳豆', '干果']);

export function unpackMdTelemetry(payload) {
  if (payload.length !== 26 && payload.length !== 34) {
    throw new Error('MD telemetry must contain 26 or 34 bytes');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    flags: payload[0], beanId: payload[1], sampleSequence: readU32LE(payload, 2),
    moisturePct: readF32LE(payload, 6), densityGl: readF32LE(payload, 10),
    capacitancePf: readF32LE(payload, 14), weightAdc: view.getInt32(18, true),
    weightG: readF32LE(payload, 22),
    ...(payload.length === 34 ? {
      emptyCapacitancePf: readF32LE(payload, 26),
      deltaCapacitancePf: readF32LE(payload, 30),
    } : {}),
  };
}

export function packMdTelemetry(value) {
  const extended = 'emptyCapacitancePf' in value || 'deltaCapacitancePf' in value;
  const out = new Uint8Array(extended ? 34 : 26);
  const view = new DataView(out.buffer);
  out[0] = value.flags; out[1] = value.beanId;
  view.setUint32(2, value.sampleSequence, true);
  writeF32LE(out, 6, value.moisturePct); writeF32LE(out, 10, value.densityGl);
  writeF32LE(out, 14, value.capacitancePf); view.setInt32(18, value.weightAdc, true);
  writeF32LE(out, 22, value.weightG);
  if (extended) {
    writeF32LE(out, 26, value.emptyCapacitancePf ?? 0);
    writeF32LE(out, 30, value.deltaCapacitancePf ?? 0);
  }
  return out;
}

export function packTelemetry(value) {
  const out = new Uint8Array(25);
  out[0] = value.flags;
  out[1] = value.sampleSequence & 0xff;
  out[2] = (value.sampleSequence >> 8) & 0xff;
  out[3] = (value.sampleSequence >> 16) & 0xff;
  out[4] = (value.sampleSequence >> 24) & 0xff;
  writeF32LE(out, 5, value.temperatureC);
  writeF32LE(out, 9, value.humidityRaw);
  writeF32LE(out, 13, value.humidityCorrected);
  writeF32LE(out, 17, value.awUnclamped);
  writeF32LE(out, 21, value.awFinal);
  return out;
}

// 采集进度（23B）：point_id + capture_id:u64 + sample_count:u16 + elapsed_ms:u32 + mean:f32 + stddev:f32
export function unpackCaptureProgress(payload) {
  requireLength(payload, 23);
  return {
    pointId: payload[0],
    captureId: readU64LE(payload, 1),
    sampleCount: payload[9] | (payload[10] << 8),
    elapsedMs: readU32LE(payload, 11),
    meanRhRaw: readF32LE(payload, 15),
    stddevRhRaw: readF32LE(payload, 19),
  };
}

export function packCaptureProgress(value) {
  const out = new Uint8Array(23);
  out[0] = value.pointId;
  writeU64LE(out, 1, value.captureId);
  out[9] = value.sampleCount & 0xff;
  out[10] = (value.sampleCount >> 8) & 0xff;
  out[11] = value.elapsedMs & 0xff;
  out[12] = (value.elapsedMs >> 8) & 0xff;
  out[13] = (value.elapsedMs >> 16) & 0xff;
  out[14] = (value.elapsedMs >> 24) & 0xff;
  writeF32LE(out, 15, value.meanRhRaw);
  writeF32LE(out, 19, value.stddevRhRaw);
  return out;
}

// 采集结果（28B）：point_id + result_code + capture_id:u64 + sample_count:u16 + elapsed_ms:u32 + 3 × f32
export function unpackCaptureResult(payload) {
  requireLength(payload, 28);
  return {
    pointId: payload[0],
    resultCode: payload[1],
    captureId: readU64LE(payload, 2),
    sampleCount: payload[10] | (payload[11] << 8),
    elapsedMs: readU32LE(payload, 12),
    meanRhRaw: readF32LE(payload, 16),
    meanRhCorrected: readF32LE(payload, 20),
    stddevRhRaw: readF32LE(payload, 24),
  };
}

export function packCaptureResult(value) {
  const out = new Uint8Array(28);
  out[0] = value.pointId;
  out[1] = value.resultCode;
  writeU64LE(out, 2, value.captureId);
  out[10] = value.sampleCount & 0xff;
  out[11] = (value.sampleCount >> 8) & 0xff;
  out[12] = value.elapsedMs & 0xff;
  out[13] = (value.elapsedMs >> 8) & 0xff;
  out[14] = (value.elapsedMs >> 16) & 0xff;
  out[15] = (value.elapsedMs >> 24) & 0xff;
  writeF32LE(out, 16, value.meanRhRaw);
  writeF32LE(out, 20, value.meanRhCorrected);
  writeF32LE(out, 24, value.stddevRhRaw);
  return out;
}

export function unpackNotice(payload) {
  requireLength(payload, 1);
  return { noticeCode: payload[0] };
}

export function packNotice(noticeCode) {
  return new Uint8Array([noticeCode]);
}

// ---------------------------------------------------------------------------
// 蓝牙服务与特征（沿用固件现有 0x180D 服务，扩展为四特征，与 smoke 布局一致）
// ---------------------------------------------------------------------------

const u16 = (value) => value.toString(16).padStart(8, '0');

export const AW_BLE = Object.freeze({
  namePrefix: 'LEBREW DOUBLE TO ONE',
  serviceUuid: u16(0x180d) + '-0000-1000-8000-00805f9b34fb',
  telemetryUuid: u16(0x2a37) + '-0000-1000-8000-00805f9b34fb',   // Notify：A5 5A 上行帧（+固件调试文本）
  commandUuid: u16(0x2a38) + '-0000-1000-8000-00805f9b34fb',     // Write：[16B 密钥][A5 5A 完整帧]
  transferCtrlUuid: u16(0x2a39) + '-0000-1000-8000-00805f9b34fb', // Write+Notify：OTA 控制 / ACK（smoke 格式）
  transferDataUuid: u16(0x2a40) + '-0000-1000-8000-00805f9b34fb', // WriteNoResponse：OTA 数据包
});

export function parseBleCommandKey(text) {
  const hex = text.replace(/0x|[\s,]/gi, '');
  if (!/^[\da-f]{32}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
}

/** 蓝牙命令载荷：[16B 密钥][A5 5A 完整帧]（写 0x2A38） */
export function buildBleCommand(frame, commandKey) {
  if (!(commandKey instanceof Uint8Array) || commandKey.length !== 16) {
    throw new Error('请先输入 16 字节蓝牙命令前缀');
  }
  const out = new Uint8Array(commandKey.length + frame.length);
  out.set(commandKey, 0);
  out.set(frame, commandKey.length);
  return out;
}

// ---------------------------------------------------------------------------
// OTA 扩展（三通道共用参数；对齐 smoke 实测节奏）
// ---------------------------------------------------------------------------

export const OTA_MAX_CHUNK = 244;   // 蓝牙 0x2A40：MTU 256 - 3 ATT - 2 seq
export const SERIAL_CHUNK = 244;    // 串口裸包：对齐 smoke 实测稳定值
export const ACK_WINDOW = 10;       // 设备每 10 包窗口 ACK
export const BLE_FAST_ACK_WINDOW = 32; // Only after explicit F1/01 capability negotiation.
export const BLE_PACKET_GAP_MS = 0; // Stop-and-wait with explicitly negotiated 10/32 packet windows.
export const SERIAL_PACKET_GAP_MS = 8; // 串口帧间隔（连发丢字节）
// Only devices advertising this START reply have a full USB-window receive buffer.
export function serialOtaBurstSupported(payload) {
  return payload?.length === 4 && payload[0] === 0 && payload[1] === 0xf2 &&
    payload[2] === 1 && payload[3] === ACK_WINDOW;
}
export const AP_SSID = 'LEBREW-AW';
export const AP_DEVICE_URL = 'http://192.168.4.1';

/** 串口 OTA 控制帧载荷 */
export function packOtaStartRequest(totalBytes, chunkSize) {
  const out = new Uint8Array(6);
  out[0] = (totalBytes >>> 24) & 0xff;
  out[1] = (totalBytes >>> 16) & 0xff;
  out[2] = (totalBytes >>> 8) & 0xff;
  out[3] = totalBytes & 0xff;
  out[4] = (chunkSize >> 8) & 0xff;
  out[5] = chunkSize & 0xff;
  return out;
}

export function unpackOtaStartRequest(payload) {
  requireLength(payload, 6);
  return {
    totalBytes: ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0,
    chunkSize: (payload[4] << 8) | payload[5],
  };
}

/** 串口 OTA ACK 事件（0x44）：[ok:1B][seq:2B BE] */
export function packOtaAck(ok, seq) {
  return new Uint8Array([ok ? 0 : 1, (seq >> 8) & 0xff, seq & 0xff]);
}

export function unpackOtaAck(payload) {
  requireLength(payload, 3);
  return { ok: payload[0] === 0, seq: (payload[1] << 8) | payload[2] };
}

// —— 蓝牙 0x2A39 传输控制（smoke 字节格式，密钥同款）——
export const BLE_OTA = Object.freeze({ START: 0x11, END: 0x12, ABORT: 0x13, START_FAST: 0x14, ACK: 0xa0 });

export function buildBleOtaStart(totalBytes, chunkSize, fast = false) {
  const out = new Uint8Array(7);
  out[0] = fast ? BLE_OTA.START_FAST : BLE_OTA.START;
  out[1] = (totalBytes >>> 24) & 0xff;
  out[2] = (totalBytes >>> 16) & 0xff;
  out[3] = (totalBytes >>> 8) & 0xff;
  out[4] = totalBytes & 0xff;
  out[5] = (chunkSize >> 8) & 0xff;
  out[6] = chunkSize & 0xff;
  return out;
}

export function buildBleOtaControl(opcode) {
  return Uint8Array.of(opcode);
}

/** 数据包（串口裸发 / 蓝牙写 0x2A40）：[seq:2B 大端][chunk] */
export function buildOtaDataPacket(seq, chunk) {
  const out = new Uint8Array(2 + chunk.length);
  out[0] = (seq >> 8) & 0xff;
  out[1] = seq & 0xff;
  out.set(chunk, 2);
  return out;
}

/** 蓝牙 0x2A39 ACK 通知：[0xA0][ok:1B][seq:2B 大端] */
export function parseBleOtaAck(bytes) {
  if (bytes.length >= 4 && bytes[0] === BLE_OTA.ACK) {
    const ack = { ok: bytes[1] === 0, seq: (bytes[2] << 8) | bytes[3] };
    if (bytes.length === 7 && ack.ok && ack.seq === 0 &&
        bytes[4] === 0xf1 && bytes[5] === 1 && bytes[6] === BLE_FAST_ACK_WINDOW)
      ack.fastWindow = BLE_FAST_ACK_WINDOW;
    return ack;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 领域常量
// ---------------------------------------------------------------------------

export const DEFAULT_MASTER_RH = Object.freeze([38.983, 57.530, 71.577, 89.697]);
export const POINT_LABELS = Object.freeze(['0.328', '0.529', '0.753', '水/1.000']);
export const CAPTURE_SAMPLE_COUNT = 150;
export const CAPTURE_SAMPLE_INTERVAL_MS = 100;
export const RESULT_CODE_NAMES = Object.freeze(['stable', 'timeout', 'cancelled', 'sensor_error']);
