(() => {
  // comm_link.js
  var TransportState = Object.freeze({
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected"
  });
  var MAX_FRAME_PAYLOAD = 1 << 20;
  var textEncoder = new TextEncoder();
  function transportError(code, message, cause) {
    const error = new Error(message || code);
    error.code = code;
    if (cause !== void 0) error.cause = cause;
    return error;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }
  var Emitter = class {
    constructor() {
      this._handlers = /* @__PURE__ */ new Map();
    }
    on(type, handler) {
      if (!this._handlers.has(type)) this._handlers.set(type, /* @__PURE__ */ new Set());
      this._handlers.get(type).add(handler);
      return () => this.off(type, handler);
    }
    off(type, handler) {
      const handlers = this._handlers.get(type);
      if (handlers) handlers.delete(handler);
    }
    emit(type, detail) {
      const handlers = this._handlers.get(type);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(detail);
        } catch (error) {
          if (type !== "error") this.emit("error", { error, source: type });
        }
      }
    }
  };
  var Transport = class extends Emitter {
    constructor(name) {
      super();
      this.name = name;
      this.state = TransportState.DISCONNECTED;
    }
    get isConnected() {
      return this.state === TransportState.CONNECTED;
    }
    _setState(state2) {
      if (this.state === state2) return;
      this.state = state2;
      this.emit("state", { transport: this, state: state2 });
    }
    async connect() {
      throw transportError("NOT_IMPLEMENTED", this.name + ": connect() is not implemented");
    }
    async disconnect() {
      throw transportError("NOT_IMPLEMENTED", this.name + ": disconnect() is not implemented");
    }
    async write() {
      throw transportError("NOT_IMPLEMENTED", this.name + ": write() is not implemented");
    }
  };
  var SerialTransport = class extends Transport {
    constructor(options = {}) {
      var _a;
      super(options.name ?? "UART0");
      this.baudRate = options.baudRate ?? 115200;
      this.bufferSize = options.bufferSize ?? 0;
      this.openOptions = options.openOptions ?? {};
      this.serial = options.serial ?? ((_a = globalThis.navigator) == null ? void 0 : _a.serial) ?? null;
      this._port = null;
      this.presetPort = options.presetPort ?? null;
      this._reader = null;
      this._writer = null;
      this._readActive = false;
    }
    get port() {
      return this._port;
    }
    get reader() {
      return this._reader;
    }
    get writer() {
      return this._writer;
    }
    async connect() {
      var _a;
      if (!((_a = this.serial) == null ? void 0 : _a.requestPort)) {
        throw transportError("SERIAL_UNSUPPORTED", "Web Serial is not available in this browser");
      }
      if (this._port) return this;
      this._setState(TransportState.CONNECTING);
      let port;
      try {
        port = this.presetPort ?? await this.serial.requestPort();
      } catch (error) {
        this._setState(TransportState.DISCONNECTED);
        throw transportError("DEVICE_NOT_SELECTED", "serial port was not selected", error);
      }
      const openOptions = {
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        ...this.openOptions
      };
      if (this.bufferSize) openOptions.bufferSize = this.bufferSize;
      try {
        await port.open(openOptions);
      } catch (error) {
        this._readActive = false;
        this._port = null;
        this._writer = null;
        try {
          await port.close();
        } catch (_) {
        }
        this._setState(TransportState.DISCONNECTED);
        throw transportError("OPEN_FAILED", "serial open failed: " + ((error == null ? void 0 : error.message) || error), error);
      }
      this._port = port;
      this._writer = port.writable.getWriter();
      this._readActive = true;
      this._setState(TransportState.CONNECTED);
      this._readLoop();
      return this;
    }
    async _readLoop() {
      var _a;
      while (this._readActive && ((_a = this._port) == null ? void 0 : _a.readable)) {
        this._reader = this._port.readable.getReader();
        try {
          while (this._readActive) {
            const { value, done } = await this._reader.read();
            if (done) break;
            if (!value) continue;
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            this.emit("data", { transport: this, bytes });
          }
        } catch (error) {
          if (this._readActive) {
            this.emit("error", transportError("READ_FAILED", "serial read failed: " + ((error == null ? void 0 : error.message) || error), error));
          }
        } finally {
          this._reader.releaseLock();
          this._reader = null;
        }
      }
    }
    async disconnect() {
      this._readActive = false;
      if (this._reader) {
        try {
          await this._reader.cancel();
        } catch (error) {
          this.emit("error", transportError("CANCEL_FAILED", "reader cancel failed: " + ((error == null ? void 0 : error.message) || error), error));
        }
      }
      if (this._writer) {
        try {
          this._writer.releaseLock();
        } catch (error) {
          this.emit("error", transportError("RELEASE_FAILED", "writer release failed: " + ((error == null ? void 0 : error.message) || error), error));
        }
        this._writer = null;
      }
      if (this._port) {
        try {
          await this._port.close();
        } catch (error) {
          this.emit("error", transportError("CLOSE_FAILED", "serial close failed: " + ((error == null ? void 0 : error.message) || error), error));
        }
      }
      this._port = null;
      this._reader = null;
      this._setState(TransportState.DISCONNECTED);
      return this;
    }
    async write(bytes) {
      if (!this._writer) {
        throw transportError("NOT_CONNECTED", this.name + " is not connected");
      }
      await this._writer.write(bytes);
    }
  };

  // log_preview.js
  function trafficPreview(bytes, hex = true) {
    const preview = bytes.subarray(0, 128);
    const body = hex ? bytesToHex(preview) : new TextDecoder().decode(preview).replace(/[^\x20-\x7e\n\r\t]/g, "\xB7");
    return body + (bytes.length > preview.length ? ` \u2026 [${bytes.length} bytes]` : "");
  }

  // aw_protocol.js
  var AW_HEADER = Object.freeze([165, 90]);
  var AW_VERSION = 1;
  var AW_MIN_BODY_LENGTH = 4;
  var AW_MAX_BODY_LENGTH = 132;
  var Command = Object.freeze({
    GET_INFO: 1,
    GET_FIRMWARE_ID: 14,
    // 运行固件 ELF SHA256 + 本次开机时长
    READ_SN: 15,
    WRITE_SN: 16,
    DEVICE_CONTROL: 18,
    MEASUREMENT_CONTROL: 17,
    // empty=status; [action,bean,mode,0,request_id:u32LE]
    GET_PARAMS: 2,
    SET_PARAMS: 3,
    RESET_PARAMS: 4,
    START_CAPTURE: 5,
    CANCEL_CAPTURE: 6,
    SET_STREAM: 7,
    HEARTBEAT: 8,
    // —— 本次新增的 OTA 扩展（固件 ≥ ota 版本才支持；旧固件回 UNKNOWN_COMMAND）——
    OTA_START: 9,
    // 串口 OTA 开始：payload [total:4B BE][chunk:2B BE]；应答 0x89 [ok:1B]
    OTA_END: 10,
    // 串口 OTA 结束（校验字节数→切分区重启）；应答 0x8A [ok:1B]
    OTA_ABORT: 11,
    // 串口 OTA 中止；应答 0x8B [ok:1B]
    OTA_ENTER_AP: 12,
    // 进入 WiFi 热点升级模式（重启）；应答 0x8C [ok:1B]
    BLE_DISCONNECT: 13,
    // 结束本次 BLE 会话；应答后由设备主动终止物理连接
    TELEMETRY: 64,
    MD_TELEMETRY: 69,
    CAPTURE_PROGRESS: 65,
    CAPTURE_RESULT: 66,
    NOTICE: 67,
    OTA_ACK: 68
    // 串口 OTA 窗口 ACK 事件（对齐 smoke 0xA0 语义）：payload [ok:1B][seq:2B BE]
  });
  var Status = Object.freeze({
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
    MD_NOT_CALIBRATED: 10
  });
  var STATUS_NAMES = Object.freeze([
    "OK",
    "UNKNOWN_COMMAND",
    "BAD_LENGTH",
    "INVALID_PARAMETER",
    "BUSY",
    "SENSOR_UNAVAILABLE",
    "CAPTURE_TIMEOUT",
    "STORAGE_ERROR",
    "INTERNAL_ERROR",
    "SN_LOCKED",
    "MD_NOT_CALIBRATED"
  ]);
  var CRC_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i += 1) {
      let crc = i << 8;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 32768 ? (crc << 1 ^ 4129) & 65535 : crc << 1 & 65535;
      }
      table[i] = crc;
    }
    return table;
  })();
  function crc16CcittFalse(bytes) {
    let crc = 65535;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = crc << 8 & 65535 ^ CRC_TABLE[(crc >> 8 ^ bytes[i]) & 255];
    }
    return crc;
  }
  function encodeFrame(command, sequence, payload = new Uint8Array(0)) {
    if (!Number.isInteger(command) || command < 0 || command > 255) {
      throw new Error("command must be a uint8");
    }
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535) {
      throw new Error("sequence must be a uint16");
    }
    if (!(payload instanceof Uint8Array)) {
      throw new Error("payload must be Uint8Array");
    }
    const bodyLength = AW_MIN_BODY_LENGTH + payload.length;
    if (bodyLength < AW_MIN_BODY_LENGTH || bodyLength > AW_MAX_BODY_LENGTH) {
      throw new Error("body length must be between 4 and 132");
    }
    const body = new Uint8Array(6 + payload.length);
    body[0] = bodyLength & 255;
    body[1] = bodyLength >> 8 & 255;
    body[2] = AW_VERSION;
    body[3] = command;
    body[4] = sequence & 255;
    body[5] = sequence >> 8 & 255;
    body.set(payload, 6);
    const frame = new Uint8Array(2 + body.length + 2);
    frame[0] = 165;
    frame[1] = 90;
    frame.set(body, 2);
    const crc = crc16CcittFalse(body);
    frame[2 + body.length] = crc & 255;
    frame[3 + body.length] = crc >> 8 & 255;
    return frame;
  }
  function responseCommand(requestCommand) {
    if (requestCommand & 128 || requestCommand >= 64) {
      throw new Error("request_command must not be a response or event");
    }
    return requestCommand | 128;
  }
  var StreamDecoder = class {
    constructor() {
      this.buffer = new Uint8Array(0);
      this.crcErrors = 0;
      this.lengthErrors = 0;
      this.versionErrors = 0;
    }
    feed(data) {
      if (!(data instanceof Uint8Array)) throw new Error("data must be Uint8Array");
      const merged = new Uint8Array(this.buffer.length + data.length);
      merged.set(this.buffer, 0);
      merged.set(data, this.buffer.length);
      let bytes = merged;
      const frames = [];
      for (; ; ) {
        const headerIndex = findPattern(bytes, AW_HEADER);
        if (headerIndex < 0) {
          bytes = bytes.length > 0 && bytes[bytes.length - 1] === AW_HEADER[0] ? bytes.slice(bytes.length - 1) : new Uint8Array(0);
          this.buffer = bytes;
          return frames;
        }
        if (headerIndex > 0) bytes = bytes.slice(headerIndex);
        if (bytes.length < 4) {
          this.buffer = bytes;
          return frames;
        }
        const bodyLength = bytes[2] | bytes[3] << 8;
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
        const expectedCrc = bytes[bodyEnd] | bytes[bodyEnd + 1] << 8;
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
          sequence: bytes[6] | bytes[7] << 8,
          payload: bytes.slice(8, bodyEnd),
          version
        });
        bytes = bytes.slice(frameLength);
      }
    }
  };
  function findPattern(bytes, pattern) {
    outer: for (let i = 0; i + pattern.length <= bytes.length; i += 1) {
      for (let j = 0; j < pattern.length; j += 1) {
        if (bytes[i + j] !== pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
  var textDecoder = new TextDecoder();
  var textEncoder2 = new TextEncoder();
  var dataViewScratch = new DataView(new ArrayBuffer(8));
  function requireLength(payload, expected) {
    if (!(payload instanceof Uint8Array)) throw new Error("payload must be Uint8Array");
    if (payload.length !== expected) {
      throw new Error("payload length must be exactly " + expected);
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
    if (!Number.isFinite(value)) throw new Error("float payload value must be finite");
    dataViewScratch.setFloat32(0, value, true);
    target[offset] = dataViewScratch.getUint8(0);
    target[offset + 1] = dataViewScratch.getUint8(1);
    target[offset + 2] = dataViewScratch.getUint8(2);
    target[offset + 3] = dataViewScratch.getUint8(3);
  }
  function readU32LE(payload, offset) {
    return (payload[offset] | payload[offset + 1] << 8 | payload[offset + 2] << 16 | payload[offset + 3] << 24) >>> 0;
  }
  function readU64LE(payload, offset) {
    let value = 0n;
    for (let byte = 7; byte >= 0; byte -= 1) value = value << 8n | BigInt(payload[offset + byte]);
    return value;
  }
  function writeU64LE(target, offset, value) {
    let v = BigInt(value);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error("capture_id must be a uint64");
    for (let byte = 0; byte < 8; byte += 1) {
      target[offset + byte] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  function readText(bytes) {
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    return textDecoder.decode(bytes.slice(0, end));
  }
  function packText(value, fieldLength) {
    const encoded = textEncoder2.encode(String(value));
    if (encoded.length > fieldLength - 1) {
      throw new Error("text field must contain at most " + (fieldLength - 1) + " UTF-8 bytes");
    }
    const out = new Uint8Array(fieldLength);
    out.set(encoded, 0);
    return out;
  }
  function unpackDeviceInfo(payload) {
    requireLength(payload, 37);
    return {
      status: payload[0],
      deviceId: readText(payload.slice(1, 21)),
      firmwareVersion: readText(payload.slice(21, 37))
    };
  }
  function packDeviceInfo(status, deviceId, firmwareVersion) {
    const out = new Uint8Array(37);
    out[0] = status;
    out.set(packText(deviceId, 20), 1);
    out.set(packText(firmwareVersion, 16), 21);
    return out;
  }
  function unpackDeviceParameters(payload) {
    requireLength(payload, 17);
    return {
      status: payload[0],
      paramVersion: payload[1] | payload[2] << 8,
      paramsValid: payload[3] === 1,
      calDewValid: payload[4] === 1,
      slopeK: readF32LE(payload, 5),
      offsetB: readF32LE(payload, 9),
      calDew: readF32LE(payload, 13)
    };
  }
  function packDeviceParameters(value) {
    const out = new Uint8Array(17);
    out[0] = value.status;
    out[1] = value.paramVersion & 255;
    out[2] = value.paramVersion >> 8 & 255;
    out[3] = value.paramsValid ? 1 : 0;
    out[4] = value.calDewValid ? 1 : 0;
    writeF32LE(out, 5, value.slopeK);
    writeF32LE(out, 9, value.offsetB);
    writeF32LE(out, 13, value.calDew);
    return out;
  }
  function packSetParamsRequest(slopeK, offsetB) {
    const out = new Uint8Array(8);
    writeF32LE(out, 0, slopeK);
    writeF32LE(out, 4, offsetB);
    return out;
  }
  function unpackSetParamsRequest(payload) {
    requireLength(payload, 8);
    return { slopeK: readF32LE(payload, 0), offsetB: readF32LE(payload, 4) };
  }
  function packStartCaptureRequest(pointId, captureId) {
    const out = new Uint8Array(9);
    out[0] = pointId;
    writeU64LE(out, 1, captureId);
    return out;
  }
  function unpackStartCaptureRequest(payload) {
    requireLength(payload, 9);
    return { pointId: payload[0], captureId: readU64LE(payload, 1) };
  }
  function unpackStartCaptureResponse(payload) {
    requireLength(payload, 10);
    return { status: payload[0], pointId: payload[1], captureId: readU64LE(payload, 2) };
  }
  function packStartCaptureResponse(status, pointId, captureId) {
    const out = new Uint8Array(10);
    out[0] = status;
    out[1] = pointId;
    writeU64LE(out, 2, captureId);
    return out;
  }
  function packSetStreamRequest(enabled, intervalMs) {
    return new Uint8Array([enabled ? 1 : 0, intervalMs & 255, intervalMs >> 8 & 255]);
  }
  function unpackSetStreamRequest(payload) {
    requireLength(payload, 3);
    return { enabled: payload[0] === 1, intervalMs: payload[1] | payload[2] << 8 };
  }
  function unpackSetStreamResponse(payload) {
    requireLength(payload, 4);
    return {
      status: payload[0],
      enabled: payload[1] === 1,
      intervalMs: payload[2] | payload[3] << 8
    };
  }
  function packSetStreamResponse(status, enabled, intervalMs) {
    return new Uint8Array([status, enabled ? 1 : 0, intervalMs & 255, intervalMs >> 8 & 255]);
  }
  function unpackTelemetry(payload) {
    requireLength(payload, 25);
    return {
      flags: payload[0],
      sampleSequence: readU32LE(payload, 1),
      temperatureC: readF32LE(payload, 5),
      humidityRaw: readF32LE(payload, 9),
      humidityCorrected: readF32LE(payload, 13),
      awUnclamped: readF32LE(payload, 17),
      awFinal: readF32LE(payload, 21)
    };
  }
  var BEAN_LABELS = Object.freeze(["\u70D8\u7119\u8C46", "\u751F\u8C46", "\u5E26\u58F3\u8C46", "\u5E72\u679C"]);
  function unpackMdTelemetry(payload) {
    if (payload.length !== 26 && payload.length !== 34) {
      throw new Error("MD telemetry must contain 26 or 34 bytes");
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      flags: payload[0],
      beanId: payload[1],
      sampleSequence: readU32LE(payload, 2),
      moisturePct: readF32LE(payload, 6),
      densityGl: readF32LE(payload, 10),
      capacitancePf: readF32LE(payload, 14),
      weightAdc: view.getInt32(18, true),
      weightG: readF32LE(payload, 22),
      ...payload.length === 34 ? {
        emptyCapacitancePf: readF32LE(payload, 26),
        deltaCapacitancePf: readF32LE(payload, 30)
      } : {}
    };
  }
  function packMdTelemetry(value) {
    const extended = "emptyCapacitancePf" in value || "deltaCapacitancePf" in value;
    const out = new Uint8Array(extended ? 34 : 26);
    const view = new DataView(out.buffer);
    out[0] = value.flags;
    out[1] = value.beanId;
    view.setUint32(2, value.sampleSequence, true);
    writeF32LE(out, 6, value.moisturePct);
    writeF32LE(out, 10, value.densityGl);
    writeF32LE(out, 14, value.capacitancePf);
    view.setInt32(18, value.weightAdc, true);
    writeF32LE(out, 22, value.weightG);
    if (extended) {
      writeF32LE(out, 26, value.emptyCapacitancePf ?? 0);
      writeF32LE(out, 30, value.deltaCapacitancePf ?? 0);
    }
    return out;
  }
  function packTelemetry(value) {
    const out = new Uint8Array(25);
    out[0] = value.flags;
    out[1] = value.sampleSequence & 255;
    out[2] = value.sampleSequence >> 8 & 255;
    out[3] = value.sampleSequence >> 16 & 255;
    out[4] = value.sampleSequence >> 24 & 255;
    writeF32LE(out, 5, value.temperatureC);
    writeF32LE(out, 9, value.humidityRaw);
    writeF32LE(out, 13, value.humidityCorrected);
    writeF32LE(out, 17, value.awUnclamped);
    writeF32LE(out, 21, value.awFinal);
    return out;
  }
  function unpackCaptureProgress(payload) {
    requireLength(payload, 23);
    return {
      pointId: payload[0],
      captureId: readU64LE(payload, 1),
      sampleCount: payload[9] | payload[10] << 8,
      elapsedMs: readU32LE(payload, 11),
      meanRhRaw: readF32LE(payload, 15),
      stddevRhRaw: readF32LE(payload, 19)
    };
  }
  function packCaptureProgress(value) {
    const out = new Uint8Array(23);
    out[0] = value.pointId;
    writeU64LE(out, 1, value.captureId);
    out[9] = value.sampleCount & 255;
    out[10] = value.sampleCount >> 8 & 255;
    out[11] = value.elapsedMs & 255;
    out[12] = value.elapsedMs >> 8 & 255;
    out[13] = value.elapsedMs >> 16 & 255;
    out[14] = value.elapsedMs >> 24 & 255;
    writeF32LE(out, 15, value.meanRhRaw);
    writeF32LE(out, 19, value.stddevRhRaw);
    return out;
  }
  function unpackCaptureResult(payload) {
    requireLength(payload, 28);
    return {
      pointId: payload[0],
      resultCode: payload[1],
      captureId: readU64LE(payload, 2),
      sampleCount: payload[10] | payload[11] << 8,
      elapsedMs: readU32LE(payload, 12),
      meanRhRaw: readF32LE(payload, 16),
      meanRhCorrected: readF32LE(payload, 20),
      stddevRhRaw: readF32LE(payload, 24)
    };
  }
  function packCaptureResult(value) {
    const out = new Uint8Array(28);
    out[0] = value.pointId;
    out[1] = value.resultCode;
    writeU64LE(out, 2, value.captureId);
    out[10] = value.sampleCount & 255;
    out[11] = value.sampleCount >> 8 & 255;
    out[12] = value.elapsedMs & 255;
    out[13] = value.elapsedMs >> 8 & 255;
    out[14] = value.elapsedMs >> 16 & 255;
    out[15] = value.elapsedMs >> 24 & 255;
    writeF32LE(out, 16, value.meanRhRaw);
    writeF32LE(out, 20, value.meanRhCorrected);
    writeF32LE(out, 24, value.stddevRhRaw);
    return out;
  }
  function unpackNotice(payload) {
    requireLength(payload, 1);
    return { noticeCode: payload[0] };
  }
  function packNotice(noticeCode) {
    return new Uint8Array([noticeCode]);
  }
  var u16 = (value) => value.toString(16).padStart(8, "0");
  var AW_BLE = Object.freeze({
    namePrefix: "LEBREW DOUBLE TO ONE",
    serviceUuid: u16(6157) + "-0000-1000-8000-00805f9b34fb",
    telemetryUuid: u16(10807) + "-0000-1000-8000-00805f9b34fb",
    // Notify：A5 5A 上行帧（+固件调试文本）
    commandUuid: u16(10808) + "-0000-1000-8000-00805f9b34fb",
    // Write：[16B 密钥][A5 5A 完整帧]
    transferCtrlUuid: u16(10809) + "-0000-1000-8000-00805f9b34fb",
    // Write+Notify：OTA 控制 / ACK（smoke 格式）
    transferDataUuid: u16(10816) + "-0000-1000-8000-00805f9b34fb"
    // WriteNoResponse：OTA 数据包
  });
  var COMMAND_KEY = Uint8Array.of(
    166,
    195,
    202,
    75,
    156,
    28,
    70,
    184,
    88,
    233,
    75,
    209,
    210,
    165,
    86,
    166
  );
  function buildBleCommand(frame, commandKey) {
    if (!(commandKey instanceof Uint8Array) || commandKey.length !== 16) {
      throw new Error("\u84DD\u7259\u547D\u4EE4\u524D\u7F00\u957F\u5EA6\u65E0\u6548");
    }
    const out = new Uint8Array(commandKey.length + frame.length);
    out.set(commandKey, 0);
    out.set(frame, commandKey.length);
    return out;
  }
  var OTA_MAX_CHUNK = 244;
  var SERIAL_CHUNK = 244;
  var ACK_WINDOW = 10;
  var BLE_FAST_ACK_WINDOW = 32;
  var BLE_PACKET_GAP_MS = 0;
  var SERIAL_PACKET_GAP_MS = 8;
  function serialOtaBurstSupported(payload) {
    return (payload == null ? void 0 : payload.length) === 4 && payload[0] === 0 && payload[1] === 242 && payload[2] === 1 && payload[3] === ACK_WINDOW;
  }
  var AP_DEVICE_URL = "http://192.168.4.1";
  function unpackOtaStartRequest(payload) {
    requireLength(payload, 6);
    return {
      totalBytes: (payload[0] << 24 | payload[1] << 16 | payload[2] << 8 | payload[3]) >>> 0,
      chunkSize: payload[4] << 8 | payload[5]
    };
  }
  function packOtaAck(ok, seq) {
    return new Uint8Array([ok ? 0 : 1, seq >> 8 & 255, seq & 255]);
  }
  function unpackOtaAck(payload) {
    requireLength(payload, 3);
    return { ok: payload[0] === 0, seq: payload[1] << 8 | payload[2] };
  }
  var BLE_OTA = Object.freeze({ START: 17, END: 18, ABORT: 19, START_FAST: 20, ACK: 160 });
  function buildBleOtaStart(totalBytes, chunkSize, fast = false) {
    const out = new Uint8Array(7);
    out[0] = fast ? BLE_OTA.START_FAST : BLE_OTA.START;
    out[1] = totalBytes >>> 24 & 255;
    out[2] = totalBytes >>> 16 & 255;
    out[3] = totalBytes >>> 8 & 255;
    out[4] = totalBytes & 255;
    out[5] = chunkSize >> 8 & 255;
    out[6] = chunkSize & 255;
    return out;
  }
  function buildBleOtaControl(opcode) {
    return Uint8Array.of(opcode);
  }
  function buildOtaDataPacket(seq, chunk) {
    const out = new Uint8Array(2 + chunk.length);
    out[0] = seq >> 8 & 255;
    out[1] = seq & 255;
    out.set(chunk, 2);
    return out;
  }
  function parseBleOtaAck(bytes) {
    if (bytes.length >= 4 && bytes[0] === BLE_OTA.ACK) {
      const ack = { ok: bytes[1] === 0, seq: bytes[2] << 8 | bytes[3] };
      if (bytes.length === 7 && ack.ok && ack.seq === 0 && bytes[4] === 241 && bytes[5] === 1 && bytes[6] === BLE_FAST_ACK_WINDOW)
        ack.fastWindow = BLE_FAST_ACK_WINDOW;
      return ack;
    }
    return null;
  }
  var DEFAULT_MASTER_RH = Object.freeze([38.983, 57.53, 71.577, 89.697]);
  var POINT_LABELS = Object.freeze(["0.328", "0.529", "0.753", "\u6C34/1.000"]);
  var RESULT_CODE_NAMES = Object.freeze(["stable", "timeout", "cancelled", "sensor_error"]);

  // aw_calculus.js
  var WARNING_TEXT = "\u5355\u4E00\u659C\u7387\u4FEE\u6B63\u4E0D\u8DB3\uFF0C\u53EF\u80FD\u9700\u8981K+B\u6216\u591A\u70B9\u6821\u51C6";
  var DENOMINATOR_EPSILON = 1e-9;
  function validatePoints(masterRh, deviceRh) {
    const master = [...masterRh];
    const device = [...deviceRh];
    if (master.length !== 4 || device.length !== 4) {
      throw new Error("master and device RH data must contain four points");
    }
    if (![...master, ...device].every(Number.isFinite)) {
      throw new Error("RH values must be finite");
    }
    return [master, device];
  }
  function fit(method, master, device, slope) {
    const offset = master[0] - slope * device[0];
    const corrected = device.map((value) => slope * value + offset);
    const residuals = corrected.map((value, index) => value - master[index]);
    const rmse = Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / 4);
    return { method, slopeK: slope, offsetB: offset, correctedRh: corrected, residuals, rmse };
  }
  function calculateReport(masterRh, deviceRh) {
    const [master, device] = validatePoints(masterRh, deviceRh);
    const endpointDenominator = device[3] - device[0];
    if (Math.abs(endpointDenominator) < DENOMINATOR_EPSILON) {
      throw new Error("device RH span is too small");
    }
    const endpointSlope = (master[3] - master[0]) / endpointDenominator;
    const anchoredDeltas = device.slice(1).map((value) => value - device[0]);
    const masterDeltas = master.slice(1).map((value) => value - master[0]);
    const lsqDenominator = anchoredDeltas.reduce((sum, delta) => sum + delta * delta, 0);
    if (Math.abs(lsqDenominator) < DENOMINATOR_EPSILON) {
      throw new Error("device RH span is too small");
    }
    const lsqNumerator = anchoredDeltas.reduce((sum, delta, index) => sum + delta * masterDeltas[index], 0);
    const lsqSlope = lsqNumerator / lsqDenominator;
    const endpoint = fit("endpoint", master, device, endpointSlope);
    const leastSquares = fit("least_squares", master, device, lsqSlope);
    const recommendedMethod = endpoint.rmse <= leastSquares.rmse ? "endpoint" : "least_squares";
    const warningReasons = [];
    if (Math.abs(device[0] - master[0]) > 1 || (recommendedMethod === "endpoint" ? endpoint.rmse : leastSquares.rmse) > 0.75 || Math.max(...(recommendedMethod === "endpoint" ? endpoint : leastSquares).residuals.map(Math.abs)) > 1) {
      warningReasons.push(WARNING_TEXT);
    }
    return { endpoint, leastSquares, recommendedMethod, warningReasons };
  }
  function aggregateAcceptedRuns(runs) {
    const accepted = [...runs];
    if (accepted.length === 0) throw new Error("at least one accepted run is required");
    if (accepted.some((run) => run.resultCode !== "stable")) {
      throw new Error("aggregate accepts stable runs only");
    }
    const pointId = accepted[0].pointId;
    if (accepted.some((run) => run.pointId !== pointId)) {
      throw new Error("aggregate requires runs from the same point_id");
    }
    const rawValues = accepted.map((run) => run.meanRhRaw);
    const correctedValues = accepted.map((run) => run.meanRhCorrected);
    const count = accepted.length;
    return {
      pointId,
      count,
      meanRhRaw: mean(rawValues),
      meanRhCorrected: mean(correctedValues),
      stdevRhRaw: count > 1 ? sampleStdev(rawValues) : null,
      stdevRhCorrected: count > 1 ? sampleStdev(correctedValues) : null
    };
  }
  function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  function sampleStdev(values) {
    const m = mean(values);
    const squares = values.reduce((sum, value) => sum + (value - m) * (value - m), 0);
    return Math.sqrt(squares / (values.length - 1));
  }

  // sn_code.js
  var ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function snCheckCharacter(body) {
    if (typeof body !== "string" || !/^[0-9A-Z]{17}$/.test(body)) return null;
    const sum = [...body].reduce((n, c, i) => n + ALPHABET.indexOf(c) * [1, 3, 7][i % 3], 0);
    return ALPHABET[(36 - sum % 36) % 36];
  }
  function validDate(text) {
    if (!/^\d{6}$/.test(text)) return false;
    const y = 2e3 + Number(text.slice(0, 2)), m = Number(text.slice(2, 4)), d = Number(text.slice(4, 6));
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  }
  function snValidate(sn) {
    return typeof sn === "string" && /^LBDT01\d{6}[A-Z]\d{4}[0-9A-Z]$/.test(sn) && validDate(sn.slice(6, 12)) && Number(sn.slice(13, 17)) > 0 && snCheckCharacter(sn.slice(0, 17)) === sn[17];
  }
  function snGenerate({ date = /* @__PURE__ */ new Date(), line = "A", sequence = 1 } = {}) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getFullYear() < 2e3 || date.getFullYear() > 2099 || !/^[A-Z]$/.test(line) || !Number.isInteger(sequence) || sequence < 1 || sequence > 9999) return null;
    const day = `${String(date.getFullYear() % 100).padStart(2, "0")}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const body = `LBDT01${day}${line}${String(sequence).padStart(4, "0")}`;
    return body + snCheckCharacter(body);
  }
  function unpackSn(payload) {
    if (payload.length < 2 || payload[0] !== 0 || payload[1] > 19 || payload.length !== payload[1] + 2) throw new Error("SN \u5E94\u7B54\u957F\u5EA6\u6216\u72B6\u6001\u65E0\u6548");
    if ([...payload.slice(2)].some((b) => b < 33 || b > 126)) throw new Error("SN \u5E94\u7B54\u4E0D\u662F\u6709\u6548 ASCII");
    return { sn: new TextDecoder().decode(payload.slice(2)) };
  }

  // device_control.js
  var DeviceAction = Object.freeze({ LANGUAGE: 1, STANDBY: 2, CAL_MD: 3, CAL_AW: 4 });
  var deviceControlActive = (s) => !!s && [1, 2].includes(s.phase);
  function validDeviceValue(action, value) {
    return Number.isInteger(value) && (action === 1 ? [0, 1].includes(value) : action === 2 ? [3, 5, 10].includes(value) : [3, 4].includes(action) && value === 0);
  }
  function packDeviceControl(action, value, requestId) {
    if (!validDeviceValue(action, value) || !Number.isInteger(requestId) || requestId <= 0 || requestId > 4294967295) throw new Error("\u8BBE\u5907\u64CD\u4F5C\u53C2\u6570\u65E0\u6548");
    const b = Uint8Array.of(action, value, 0, 0, 0, 0, 0, 0);
    new DataView(b.buffer).setUint32(4, requestId, true);
    return b;
  }
  function unpackDeviceState(b) {
    if (!(b instanceof Uint8Array) || b.length !== 20 || b[0] !== 0 || b[1] > 4 || b[2] > 4 || b[4] > 1 || ![3, 5, 10].includes(b[5]) && (b[8] & 1 || b[5] !== 0) || b[8] & ~3 || b[9] || b[10] || b[11] || b[1] !== 0 && (!validDeviceValue(b[2], b[3]) || new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(12, true) === 0)) throw new Error("\u8BBE\u5907\u8BBE\u7F6E\u72B6\u6001\u5B57\u6BB5\u65E0\u6548");
    if (b[1] === 3 && (b[2] === 1 && b[4] !== b[3] || b[2] === 2 && b[5] !== b[3] || b[7])) throw new Error("\u8BBE\u5907\u8BBE\u7F6E\u56DE\u8BFB\u4E0D\u4E00\u81F4");
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { phase: b[1], action: b[2], value: b[3], language: b[4], standbyMinutes: b[5], screenId: b[6], error: b[7], ready: !!(b[8] & 1), busy: !!(b[8] & 2), requestId: v.getUint32(12, true), elapsedMs: v.getUint32(16, true) };
  }
  function packDeviceState(s) {
    const b = Uint8Array.of(0, s.phase ?? 0, s.action ?? 0, s.value ?? 0, s.language ?? 0, s.standbyMinutes ?? 3, s.screenId ?? 0, s.error ?? 0, (s.ready ? 1 : 0) | (s.busy ? 2 : 0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const v = new DataView(b.buffer);
    v.setUint32(12, s.requestId ?? 0, true);
    v.setUint32(16, s.elapsedMs ?? 0, true);
    unpackDeviceState(b);
    return b;
  }
  function deviceStatusText(s) {
    if (!s) return "\u8FDE\u63A5\u540E\u8BFB\u53D6\u8BBE\u5907\u8BED\u8A00\u4E0E\u5F85\u673A\u8BBE\u7F6E\u3002";
    const name = ["", "\u8BBE\u5907\u8BED\u8A00", "\u5F85\u673A\u65F6\u95F4", "\u6C34\u5206\u548C\u5BC6\u5EA6\u6821\u51C6", "\u6C34\u6D3B\u6821\u51C6"][s.action];
    if (!s.ready) return "\u8BBE\u5907\u6B63\u5728\u542F\u52A8\uFF0C\u8BF7\u7A0D\u5019\u3002";
    if (s.phase === 0) return s.busy ? "\u8BBE\u5907\u6B63\u5728\u64CD\u4F5C\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u3002" : "\u8BBE\u5907\u8BBE\u7F6E\u5DF2\u8BFB\u53D6\u3002";
    if (s.phase === 1) return `${name}\uFF1A\u6307\u4EE4\u5DF2\u63A5\u6536\uFF0C\u7B49\u5F85\u8BBE\u5907\u6267\u884C\u3002`;
    if (s.phase === 2) return `${name}\uFF1A\u8FDB\u884C\u4E2D\uFF08${Math.floor(s.elapsedMs / 1e3)} \u79D2\uFF09\u3002\u8BF7\u4FDD\u6301\u6837\u54C1\u4E0E\u8BBE\u5907\u72B6\u6001\u3002`;
    if (s.phase === 3) return `${name}\uFF1A${s.action <= 2 ? "\u5DF2\u4FDD\u5B58\u5E76\u56DE\u8BFB\u6838\u5BF9" : "\u6821\u51C6\u5B8C\u6210"}\u3002`;
    return `${name}\uFF1A\u672A\u5B8C\u6210${s.error === 6 ? "\uFF0C\u7B49\u5F85\u4F20\u611F\u5668\u6216\u4FDD\u5B58\u8D85\u65F6" : s.error === 7 ? "\uFF0C\u53C2\u6570\u4FDD\u5B58\u5931\u8D25" : s.error === 4 ? "\uFF0C\u8BBE\u5907\u6B63\u5FD9" : "\uFF0C\u64CD\u4F5C\u88AB\u4E2D\u65AD\u6216\u8BBE\u5907\u5F02\u5E38"}\u3002`;
  }

  // measurement_control.js
  var MeasurementMode = Object.freeze({ MD: 1, AW: 2, ALL: 3 });
  var MeasurementPhase = Object.freeze({ IDLE: 0, PENDING: 1, RUNNING: 2, COMPLETED: 3, CANCELLED: 4, FAILED: 5 });
  var BEAN_NAMES = Object.freeze(["\u70D8\u7119\u8C46", "\u751F\u8C46", "\u5E26\u58F3\u8C46", "\u5E72\u679C"]);
  var MODE_NAMES = Object.freeze(["", "\u6C34\u5206\u4E0E\u5BC6\u5EA6", "\u6C34\u6D3B", "\u5168\u90E8\u6D4B\u91CF"]);
  var measurementActive = (state2) => !!state2 && [1, 2].includes(state2.phase);
  function packMeasurementControl(action, beanId, mode, requestId) {
    if (![1, 2, 3].includes(action) || !Number.isInteger(requestId) || requestId < 0 || requestId > 4294967295)
      throw new Error("\u6D4B\u91CF\u64CD\u4F5C\u6216\u4EFB\u52A1\u7F16\u53F7\u65E0\u6548");
    if (!Number.isInteger(beanId) || beanId < 0 || beanId > 3 || (action === 3 ? mode !== 0 : ![1, 2, 3].includes(mode)) || action !== 2 && requestId === 0)
      throw new Error("\u8C46\u79CD\u6216\u6D4B\u91CF\u65B9\u5F0F\u65E0\u6548");
    const bytes = Uint8Array.of(action, beanId, mode, 0, 0, 0, 0, 0);
    new DataView(bytes.buffer).setUint32(4, requestId, true);
    return bytes;
  }
  function unpackMeasurementControl(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 8 || bytes[3] !== 0)
      throw new Error("\u6D4B\u91CF\u547D\u4EE4\u957F\u5EA6\u6216\u4FDD\u7559\u5B57\u6BB5\u65E0\u6548");
    const requestId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    packMeasurementControl(bytes[0], bytes[1], bytes[2], requestId);
    return { action: bytes[0], beanId: bytes[1], mode: bytes[2], requestId };
  }
  function unpackMeasurementState(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 28 || bytes[0] !== 0)
      throw new Error("\u8BBE\u5907\u6D4B\u91CF\u72B6\u6001\u957F\u5EA6\u6216\u72B6\u6001\u7801\u65E0\u6548");
    if (bytes[1] > 5 || bytes[2] > 3 || bytes[3] > 3 || bytes[4] & ~3 || bytes[4] & ~bytes[3] || bytes[7] & ~3 || bytes[1] === 3 && (bytes[3] === 0 || bytes[4] !== bytes[3]))
      throw new Error("\u8BBE\u5907\u6D4B\u91CF\u72B6\u6001\u5B57\u6BB5\u65E0\u6548");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moisture = view.getFloat32(16, true), density = view.getFloat32(20, true), aw = view.getFloat32(24, true);
    if (bytes[4] & 1 && ![moisture, density].every(Number.isFinite) || bytes[4] & 2 && (!Number.isFinite(aw) || aw < 0 || aw > 1))
      throw new Error("\u8BBE\u5907\u6D4B\u91CF\u7ED3\u679C\u6570\u503C\u65E0\u6548");
    return {
      phase: bytes[1],
      beanId: bytes[2],
      mode: bytes[3],
      resultFlags: bytes[4],
      screenId: bytes[5],
      error: bytes[6],
      deviceReady: !!(bytes[7] & 1),
      deviceBusy: !!(bytes[7] & 2),
      requestId: view.getUint32(8, true),
      elapsedMs: view.getUint32(12, true),
      moisture: bytes[4] & 1 ? moisture : null,
      density: bytes[4] & 1 ? density : null,
      aw: bytes[4] & 2 ? aw : null
    };
  }
  function packMeasurementState(state2) {
    const bytes = new Uint8Array(28), view = new DataView(bytes.buffer);
    bytes.set([
      0,
      state2.phase ?? 0,
      state2.beanId ?? 0,
      state2.mode ?? 0,
      state2.resultFlags ?? 0,
      state2.screenId ?? 0,
      state2.error ?? 0,
      (state2.deviceReady ? 1 : 0) | (state2.deviceBusy ? 2 : 0)
    ]);
    view.setUint32(8, state2.requestId ?? 0, true);
    view.setUint32(12, state2.elapsedMs ?? 0, true);
    view.setFloat32(16, state2.moisture ?? 0, true);
    view.setFloat32(20, state2.density ?? 0, true);
    view.setFloat32(24, state2.aw ?? 0, true);
    unpackMeasurementState(bytes);
    return bytes;
  }
  function measurementStatusText(state2) {
    if (!state2) return "\u8FDE\u63A5\u8BBE\u5907\u540E\u53EF\u9009\u62E9\u8C46\u79CD\u5E76\u542F\u52A8\u6D4B\u91CF\u3002";
    const label = `${BEAN_NAMES[state2.beanId]} \xB7 ${MODE_NAMES[state2.mode] || "\u5F85\u6D4B\u91CF"}`;
    if (state2.phase === 0) return state2.deviceBusy ? "\u8BBE\u5907\u6B63\u5728\u6821\u51C6\uFF0C\u5B8C\u6210\u540E\u53EF\u542F\u52A8\u6D4B\u91CF\u3002" : state2.deviceReady ? "\u8BBE\u5907\u5DF2\u5C31\u7EEA\uFF0C\u9009\u62E9\u8C46\u79CD\u7ACB\u5373\u540C\u6B65\u8BBE\u5907\u754C\u9762\u3002" : "\u8BBE\u5907\u6B63\u5728\u542F\u52A8\uFF0C\u8BF7\u7A0D\u5019\u3002";
    if (state2.phase === 1 && state2.mode === 0) return `${BEAN_NAMES[state2.beanId]}\uFF1A\u6B63\u5728\u540C\u6B65\u8BBE\u5907\u754C\u9762\u3002`;
    if (state2.phase === 1) return `${label}\uFF1A\u6307\u4EE4\u5DF2\u63A5\u6536\uFF0C\u7B49\u5F85\u8BBE\u5907\u542F\u52A8\u3002`;
    if (state2.phase === 2) return `${label}\uFF1A\u6D4B\u91CF\u4E2D${state2.mode === 3 && state2.resultFlags & 1 ? "\uFF0C\u6C34\u5206\u4E0E\u5BC6\u5EA6\u5DF2\u5B8C\u6210\uFF0C\u6C34\u6D3B\u7EE7\u7EED\u6D4B\u91CF" : ""}\u3002`;
    if (state2.phase === 3) return `${label}\uFF1A\u6D4B\u91CF\u5B8C\u6210\u3002`;
    if (state2.phase === 4) return `${label}\uFF1A\u5DF2\u53D6\u6D88\uFF1B\u5DF2\u5B8C\u6210\u7684\u5355\u9879\u7ED3\u679C\u4FDD\u7559\u3002`;
    return `${label}\uFF1A\u6D4B\u91CF\u672A\u5B8C\u6210${state2.error === 6 ? "\uFF0C\u7B49\u5F85\u4F20\u611F\u5668\u8D85\u65F6" : state2.error === 10 ? "\uFF0C\u8BF7\u5148\u505A\u8BBE\u5907\u7A7A\u676F\u6821\u51C6" : state2.error === 4 ? "\uFF0C\u8BBE\u5907\u6B63\u5FD9" : ""}\u3002`;
  }

  // aw_controller.js
  var UINT64_MASK = (1n << 64n) - 1n;
  var SAFE_RETRY_COMMANDS = /* @__PURE__ */ new Set([Command.GET_INFO, Command.GET_FIRMWARE_ID, Command.READ_SN, Command.GET_PARAMS, Command.SET_STREAM]);
  var OPERATION_LABELS = Object.freeze({
    read_device_control: "\u8BFB\u53D6\u8BBE\u5907\u8BBE\u7F6E",
    device_control: "\u8BBE\u5907\u8BBE\u7F6E\u4E0E\u6821\u51C6",
    select_bean: "\u5207\u6362\u8BBE\u5907\u8C46\u79CD",
    read_measurement: "\u8BFB\u53D6\u8BBE\u5907\u6D4B\u91CF\u72B6\u6001",
    start_measurement: "\u542F\u52A8\u8BBE\u5907\u6D4B\u91CF",
    cancel_measurement: "\u53D6\u6D88\u8BBE\u5907\u6D4B\u91CF",
    read_firmware_identity: "\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6",
    read_sn: "\u8BFB\u53D6 SN",
    write_sn: "\u5199\u5165 SN",
    sn_readback: "SN \u5199\u540E\u56DE\u8BFB",
    read_info: "\u8BFB\u53D6\u8BBE\u5907\u4FE1\u606F",
    read_parameters: "\u8BFB\u53D6\u53C2\u6570",
    write_readback: "\u5199\u540E\u56DE\u8BFB",
    enable_stream: "\u5F00\u542F\u5B9E\u65F6\u6570\u636E",
    start_capture: "\u5F00\u59CB\u91C7\u96C6",
    cancel_capture: "\u53D6\u6D88\u91C7\u96C6",
    write_parameters: "\u5199\u5165\u53C2\u6570",
    reset_parameters: "\u6062\u590D\u53C2\u6570"
  });
  var CaptureIdGenerator = class {
    constructor() {
      this.state = randomUint64();
      this.increment = randomUint64() | 1n;
    }
    next() {
      for (; ; ) {
        this.state = this.state + this.increment & UINT64_MASK;
        if (this.state !== 0n) return this.state;
      }
    }
  };
  function randomUint64() {
    const bytes = new Uint8Array(8);
    (globalThis.crypto ?? { getRandomValues: (b) => {
      for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256);
    } }).getRandomValues(bytes);
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = value << 8n | BigInt(bytes[i]);
    return value;
  }
  function validateRequiredRuns(count) {
    if (![1, 2, 3].includes(count)) throw new RangeError("\u6BCF\u70B9\u7A33\u5B9A\u91C7\u96C6\u6B21\u6570\u53EA\u80FD\u4E3A 1\u30012 \u6216 3");
  }
  var CalibrationSession = class {
    constructor(masterRh, requiredRunsPerPoint = 3) {
      validateRequiredRuns(requiredRunsPerPoint);
      this.requiredRunsPerPoint = requiredRunsPerPoint;
      this.masterProfileRh = [...masterRh];
      this.deviceId = "";
      this.startedAt = /* @__PURE__ */ new Date();
      this.endedAt = null;
      this.connectionMetadata = {};
      this.telemetry = [];
      this.mdTelemetry = [];
      this.captureResults = [];
      this.acceptedRunsByPoint = [[], [], [], []];
      this.parameterOperations = [];
      this.report = null;
    }
    recordTelemetry(telemetry) {
      this.telemetry.push(telemetry);
    }
    recordCapture(run) {
      this.captureResults.push(run);
      const accepted = run.resultCode === "stable" && Number.isInteger(run.pointId) && run.pointId >= 0 && run.pointId < 4 && [run.meanRhRaw, run.meanRhCorrected, run.stddevRhRaw].every(Number.isFinite) && run.stddevRhRaw >= 0;
      if (accepted) this.acceptedRunsByPoint[run.pointId].push(run);
    }
    pointAggregate(pointId) {
      return aggregateAcceptedRuns(this.acceptedRunsByPoint[pointId]);
    }
    devicePointMeans() {
      if (this.acceptedRunsByPoint.some((runs) => runs.length < this.requiredRunsPerPoint)) return null;
      const means = this.acceptedRunsByPoint.map((_, pointId) => this.pointAggregate(pointId).meanRhRaw);
      return means.every(Number.isFinite) ? means : null;
    }
    recordParameterOperation(operation, statusName2, details) {
      this.parameterOperations.push({
        operation,
        status: statusName2,
        details: details ?? {},
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    parameterDetails(parameters) {
      return {
        param_version: parameters.paramVersion,
        params_valid: parameters.paramsValid,
        cal_dew_valid: parameters.calDewValid,
        slope_k: parameters.slopeK,
        offset_b: parameters.offsetB,
        cal_dew: parameters.calDew
      };
    }
  };
  var CalibrationController = class extends Emitter {
    constructor(options = {}) {
      super();
      this.requestTimeoutMs = options.requestTimeoutMs ?? 5e3;
      this.readRetryCount = options.readRetryCount ?? 2;
      this.captureStartGraceMs = options.captureStartGraceMs ?? 1e4;
      this.sequenceStart = options.sequenceStart ?? 1;
      this.masterProfileRh = options.masterProfileRh ?? [38.983, 57.53, 71.577, 89.697];
      this.requiredRunsPerPoint = options.requiredRunsPerPoint ?? 3;
      validateRequiredRuns(this.requiredRunsPerPoint);
      this.captureIdFactory = options.captureIdFactory ?? new CaptureIdGenerator();
      this._now = options.clock ?? (() => performance.now());
      this._nextSequence = this.sequenceStart;
      this._pending = /* @__PURE__ */ new Map();
      this._transport = null;
      this._connected = false;
      this._connecting = false;
      this._generation = 0;
      this._activeCapture = null;
      this.measurement = null;
      this.deviceControl = null;
      this._decoder = null;
      this.session = new CalibrationSession(this.masterProfileRh, this.requiredRunsPerPoint);
      this._offTransport = [];
    }
    get isConnected() {
      return this._connected;
    }
    pauseForOta() {
      this._assertMeasurementIdle();
      if (this._activeCapture || [...this._pending.values()].some((p) => {
        var _a;
        return !["heartbeat", "read_info", "read_firmware_identity", "read_parameters", "enable_stream"].includes(p.operation) || ((_a = p.context) == null ? void 0 : _a.writeVerify);
      })) {
        throw new Error("\u8BF7\u5148\u7ED3\u675F\u91C7\u96C6\u6216\u7B49\u5F85\u53C2\u6570\u64CD\u4F5C\u5B8C\u6210\uFF0C\u518D\u5347\u7EA7\u56FA\u4EF6");
      }
      this._otaPaused = true;
      this._pending.clear();
    }
    resumeAfterOta(restoreStream = false) {
      this._otaPaused = false;
      if (restoreStream && this.isConnected) {
        this._registerAndWrite(Command.SET_STREAM, packSetStreamRequest(true, 100), "enable_stream");
      }
    }
    get connectedTransportName() {
      var _a;
      return ((_a = this._transport) == null ? void 0 : _a.name) ?? null;
    }
    /** transport 需提供：name、write(bytes)（可异步）、close()，并 emit('data',{bytes}) / emit('error') */
    connectTransport(transport, metadata) {
      this._otaPaused = false;
      this.disconnect();
      this._generation += 1;
      const generation = this._generation;
      this._connecting = true;
      this._nextSequence = this.sequenceStart;
      this._activeCapture = null;
      this.session = new CalibrationSession(this.masterProfileRh, this.requiredRunsPerPoint);
      this._pending.clear();
      this._transport = transport;
      this._decoder = new StreamDecoder();
      this._offTransport = [
        transport.on("data", ({ bytes }) => this._receiveBytes(generation, bytes)),
        transport.on("error", (error) => this._transportError(generation, error)),
        transport.on("disconnected", () => this._peerDisconnected(generation))
      ];
      this._connecting = false;
      this._connected = true;
      this.session.connectionMetadata = { ...metadata };
      this._emit("connected", metadata);
      this._registerAndWrite(Command.SET_STREAM, packSetStreamRequest(true, 100), "enable_stream", {
        enabled: true,
        intervalMs: 100
      });
    }
    disconnect() {
      var _a, _b;
      const transport = this._transport;
      if (!this._connected && !this._connecting && !transport) return;
      this._transport = null;
      this._connecting = false;
      this._connected = false;
      this._generation += 1;
      this._activeCapture = null;
      this.measurement = null;
      this.deviceControl = null;
      for (const off of this._offTransport) off();
      this._offTransport = [];
      for (const request of this._pending.values()) {
        if (request.operation === "heartbeat") continue;
        this._emitRequestError(request, "disconnected", "request failed because the transport disconnected");
      }
      this._pending.clear();
      this._emit("disconnected");
      const closing = [];
      try {
        closing.push(Promise.resolve((_a = transport == null ? void 0 : transport.close) == null ? void 0 : _a.call(transport)).catch(() => {
        }));
      } catch {
      }
      try {
        closing.push(Promise.resolve((_b = transport == null ? void 0 : transport.disconnect) == null ? void 0 : _b.call(transport)).catch(() => {
        }));
      } catch {
      }
      return Promise.all(closing);
    }
    // —— 公开操作（返回序号）——
    _assertMeasurementIdle() {
      var _a;
      if (deviceControlActive(this.deviceControl) || ((_a = this.deviceControl) == null ? void 0 : _a.busy) || [...this._pending.values()].some((p) => p.operation === "device_control")) throw new Error("\u8BF7\u5148\u5B8C\u6210\u8BBE\u5907\u8BBE\u7F6E\u6216\u6821\u51C6");
      if (measurementActive(this.measurement) || [...this._pending.values()].some((p) => ["start_measurement", "select_bean"].includes(p.operation)))
        throw new Error("\u8BF7\u5148\u5B8C\u6210\u6216\u53D6\u6D88\u8BBE\u5907\u6D4B\u91CF");
    }
    readDeviceControl() {
      if ([...this._pending.values()].some((p) => p.operation === "read_device_control")) return null;
      return this._send(Command.DEVICE_CONTROL, new Uint8Array(), "read_device_control");
    }
    controlDevice(action, value, requestId) {
      this._assertMeasurementIdle();
      if (this._activeCapture || this._otaPaused || [...this._pending.values()].some((p) => ["start_capture", "write_parameters", "reset_parameters", "write_sn", "write_readback"].includes(p.operation))) throw new Error("\u8BF7\u5148\u7ED3\u675F\u91C7\u96C6\u3001\u53C2\u6570\u5199\u5165\u6216\u5347\u7EA7\u64CD\u4F5C");
      if (requestId == null) {
        const r = new Uint32Array(1);
        (globalThis.crypto ?? { getRandomValues: (b) => {
          b[0] = Math.floor(Math.random() * 4294967295);
        } }).getRandomValues(r);
        requestId = r[0] || 1;
      }
      return this._send(Command.DEVICE_CONTROL, packDeviceControl(action, value, requestId), "device_control", { action, value, requestId });
    }
    readMeasurement() {
      if ([...this._pending.values()].some((p) => p.operation === "read_measurement")) return null;
      return this._send(Command.MEASUREMENT_CONTROL, new Uint8Array(), "read_measurement");
    }
    startMeasurement(beanId, mode, requestId) {
      this._assertMeasurementIdle();
      if (this._activeCapture || this._otaPaused || [...this._pending.values()].some((p) => ["start_capture", "write_parameters", "reset_parameters", "write_sn", "write_readback"].includes(p.operation)))
        throw new Error("\u8BF7\u5148\u7ED3\u675F\u91C7\u96C6\u3001\u53C2\u6570\u5199\u5165\u6216\u5347\u7EA7\u64CD\u4F5C");
      if (requestId == null) {
        const random = new Uint32Array(1);
        (globalThis.crypto ?? { getRandomValues: (b) => {
          b[0] = Math.floor(Math.random() * 4294967295);
        } }).getRandomValues(random);
        requestId = random[0] || 1;
      }
      return this._send(
        Command.MEASUREMENT_CONTROL,
        packMeasurementControl(1, beanId, mode, requestId),
        "start_measurement",
        { requestId, beanId, mode }
      );
    }
    selectBean(beanId) {
      this._assertMeasurementIdle();
      if (this._activeCapture || this._otaPaused || [...this._pending.values()].some((p) => ["start_capture", "write_parameters", "reset_parameters", "write_sn", "write_readback"].includes(p.operation)))
        throw new Error("\u8BF7\u5148\u7ED3\u675F\u91C7\u96C6\u3001\u53C2\u6570\u5199\u5165\u6216\u5347\u7EA7\u64CD\u4F5C");
      const random = new Uint32Array(1);
      (globalThis.crypto ?? { getRandomValues: (b) => {
        b[0] = Math.floor(Math.random() * 4294967295);
      } }).getRandomValues(random);
      const requestId = random[0] || 1;
      return this._send(
        Command.MEASUREMENT_CONTROL,
        packMeasurementControl(3, beanId, 0, requestId),
        "select_bean",
        { requestId, beanId, mode: 0 }
      );
    }
    cancelMeasurement() {
      const m = this.measurement;
      if (!measurementActive(m)) throw new Error("\u8BBE\u5907\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u6D4B\u91CF");
      return this._send(Command.MEASUREMENT_CONTROL, packMeasurementControl(2, m.beanId, m.mode, m.requestId), "cancel_measurement");
    }
    readInfo() {
      return this._send(Command.GET_INFO, new Uint8Array(0), "read_info");
    }
    readSn() {
      return this._send(Command.READ_SN, new Uint8Array(), "read_sn");
    }
    writeSn(sn) {
      this._assertMeasurementIdle();
      if (!snValidate(sn)) throw new Error("SN \u683C\u5F0F\u6216\u6821\u9A8C\u4F4D\u9519\u8BEF");
      if (this._activeCapture || this._otaPaused || [...this._pending.values()].some((p) => p.command === Command.START_CAPTURE)) throw new Error("\u8BF7\u5148\u7ED3\u675F\u91C7\u96C6\u6216\u5347\u7EA7\uFF0C\u518D\u5199\u5165 SN");
      if ([...this._pending.values()].some((p) => {
        var _a;
        return p.command === Command.WRITE_SN || ((_a = p.context) == null ? void 0 : _a.snExpected);
      })) throw new Error("\u6B63\u5728\u5199\u5165\u6216\u6838\u5BF9 SN\uFF0C\u8BF7\u7B49\u5F85");
      return this._send(Command.WRITE_SN, new TextEncoder().encode(sn), "write_sn", { sn });
    }
    readFirmwareIdentity() {
      return this._send(Command.GET_FIRMWARE_ID, new Uint8Array(0), "read_firmware_identity");
    }
    readParameters() {
      return this._send(Command.GET_PARAMS, new Uint8Array(0), "read_parameters");
    }
    writeParameters(slopeK, offsetB) {
      this._assertMeasurementIdle();
      return this._send(Command.SET_PARAMS, packSetParamsRequest(slopeK, offsetB), "write_parameters", {
        slopeK,
        offsetB
      });
    }
    resetParameters() {
      this._assertMeasurementIdle();
      return this._send(Command.RESET_PARAMS, new Uint8Array(0), "reset_parameters");
    }
    startCapture(pointId) {
      this._assertMeasurementIdle();
      if ([...this._pending.values()].some((p) => {
        var _a;
        return p.command === Command.WRITE_SN || ((_a = p.context) == null ? void 0 : _a.snExpected);
      })) throw new Error("\u8BF7\u7B49\u5F85 SN \u5199\u5165\u6821\u9A8C\u5B8C\u6210");
      const captureId = BigInt(this.captureIdFactory.next());
      return this._send(Command.START_CAPTURE, packStartCaptureRequest(pointId, captureId), "start_capture", {
        pointId,
        captureId
      });
    }
    cancelCapture() {
      return this._send(Command.CANCEL_CAPTURE, new Uint8Array(0), "cancel_capture");
    }
    sendHeartbeat() {
      if (this._otaPaused) return null;
      for (const request of this._pending.values()) {
        if (request.operation === "heartbeat") return request.sequence;
      }
      return this._send(Command.HEARTBEAT, new Uint8Array(0), "heartbeat");
    }
    /** 基准 RH 变更后重算报告（无新采集时返回 null） */
    recomputeReport() {
      this.session.report = null;
      const means = this.session.devicePointMeans();
      if (!means) return null;
      const report = calculateReport(this.session.masterProfileRh, means);
      this.session.report = report;
      return report;
    }
    setRequiredRunsPerPoint(count) {
      validateRequiredRuns(count);
      this.requiredRunsPerPoint = count;
      this.session.requiredRunsPerPoint = count;
      return this.recomputeReport();
    }
    // —— 内部机制 ——
    _send(command, payload, operation, context) {
      return this._registerAndWrite(command, payload, operation, context);
    }
    _registerAndWrite(command, payload, operation, context) {
      const ticket = this._register(command, payload, operation, context);
      if (!ticket) return null;
      this._writeTicket(ticket).catch((error) => this._handleWriteError(ticket, error));
      return ticket.pending.sequence;
    }
    _register(command, payload, operation, context) {
      if (this._otaPaused) throw new Error("\u56FA\u4EF6\u5347\u7EA7\u671F\u95F4\u6682\u505C\u6807\u5B9A\u547D\u4EE4");
      if (!this._connected || !this._transport) {
        throw new Error("controller is not connected");
      }
      const sequence = this._allocateSequence();
      const now = this._now();
      const frame = encodeFrame(command, sequence, payload);
      let budget = this.requestTimeoutMs;
      if (SAFE_RETRY_COMMANDS.has(command)) budget *= this.readRetryCount + 1;
      else if (command === Command.START_CAPTURE) budget += this.captureStartGraceMs;
      const pending = {
        generation: this._generation,
        command,
        sequence,
        deadline: now + this.requestTimeoutMs,
        operation,
        context: { ...context ?? {} },
        frame,
        startedAt: now,
        finalDeadline: now + budget,
        retries: 0,
        recovering: false
      };
      this._pending.set(sequence, pending);
      return { generation: this._generation, transport: this._transport, pending, frame };
    }
    async _writeTicket(ticket) {
      await ticket.transport.write(ticket.frame);
    }
    _handleWriteError(ticket, error) {
      const pending = ticket.pending;
      if (this._pending.get(pending.sequence) !== pending) return;
      this._pending.delete(pending.sequence);
      try {
        console.error("[AW] write error:", pending.operation, error);
        window.__awWriteError = {
          operation: pending.operation,
          error,
          time: (/* @__PURE__ */ new Date()).toISOString()
        };
        localStorage.setItem("awDiagWrite", JSON.stringify({
          operation: pending.operation,
          msg: String((error == null ? void 0 : error.message) ?? error),
          name: (error == null ? void 0 : error.name) ?? "",
          time: Date.now()
        }));
      } catch {
      }
      if (pending.operation === "enable_stream") {
        this._emit("error", { operation: "connect", reason: String((error == null ? void 0 : error.message) ?? error) }, pending.sequence, String((error == null ? void 0 : error.message) ?? error));
        this.disconnect();
        return;
      }
      if (pending.operation === "heartbeat") {
        this._emit("diagnostic", { reason: `heartbeat write failed: ${error}` }, pending.sequence, `\u5FC3\u8DF3\u5199\u5165\u5931\u8D25\uFF1A${error}`);
        return;
      }
      this._emitRequestError(pending, String((error == null ? void 0 : error.message) ?? error), String((error == null ? void 0 : error.message) ?? error));
    }
    _allocateSequence() {
      for (let i = 0; i < 65535; i += 1) {
        const candidate = this._nextSequence;
        this._nextSequence = candidate === 65535 ? 1 : candidate + 1;
        if (!this._pending.has(candidate)) return candidate;
      }
      throw new Error("sequence space exhausted");
    }
    _receiveBytes(generation, data) {
      if (generation !== this._generation) return;
      let frames;
      const before = [this._decoder.crcErrors, this._decoder.lengthErrors, this._decoder.versionErrors];
      try {
        frames = this._decoder.feed(data);
      } catch (error) {
        this._diagnostic(`decoder rejected bytes: ${error}`);
        return;
      }
      const after = [this._decoder.crcErrors, this._decoder.lengthErrors, this._decoder.versionErrors];
      if (before.join() !== after.join()) {
        this._emit("diagnostic", {
          reason: `RX_REJECTED crc=${after[0]} length=${after[1]} version=${after[2]}`
        }, null, `\u6536\u5230\u635F\u574F\u5E27\uFF08CRC=${after[0]} \u957F\u5EA6=${after[1]} \u7248\u672C=${after[2]}\uFF09\uFF0C\u5DF2\u4E22\u5F03`);
      }
      for (const frame of frames) this._handleFrame(generation, frame);
    }
    _handleFrame(generation, frame) {
      if (generation !== this._generation) return;
      if (frame.command >= 128) {
        this._handleResponse(frame);
      } else if (frame.command === Command.TELEMETRY || frame.command === Command.MD_TELEMETRY || frame.command === Command.CAPTURE_PROGRESS || frame.command === Command.CAPTURE_RESULT || frame.command === Command.NOTICE || frame.command === Command.OTA_ACK) {
        this._handleAsyncEvent(frame);
      } else if (this._connected) {
        this._diagnostic(`unknown device frame command 0x${frame.command.toString(16).toUpperCase().padStart(2, "0")}`, frame.sequence);
      }
    }
    _handleResponse(frame) {
      const pending = this._pending.get(frame.sequence);
      if (pending == null) {
        this._diagnostic("stale or unknown response sequence", frame.sequence);
        return;
      }
      if (frame.command !== responseCommand(pending.command)) {
        this._diagnostic("response command does not match pending request", frame.sequence);
        return;
      }
      if (this._now() >= pending.finalDeadline) {
        this._pending.delete(pending.sequence);
        this._finishTimeout(pending);
        return;
      }
      if (pending.command === Command.START_CAPTURE) {
        this._handleStartCaptureResponse(pending, frame.payload);
        return;
      }
      if (frame.payload.length === 0) {
        this._pending.delete(pending.sequence);
        this._finishMalformed(pending, "response payload is missing status");
        return;
      }
      const status = frame.payload[0];
      if (status !== Status.OK) {
        this._pending.delete(pending.sequence);
        this._finishStatusError(pending, status);
        return;
      }
      let decoded;
      try {
        decoded = this._decodeSuccess(pending.command, frame.payload);
      } catch (error) {
        this._pending.delete(pending.sequence);
        this._finishMalformed(pending, `malformed response payload: ${error.message}`);
        return;
      }
      this._pending.delete(pending.sequence);
      this._completeRequest(pending, decoded);
    }
    _decodeSuccess(command, payload) {
      if (command === Command.DEVICE_CONTROL) return unpackDeviceState(payload);
      if (command === Command.MEASUREMENT_CONTROL) return unpackMeasurementState(payload);
      if (command === Command.READ_SN) return unpackSn(payload);
      if (command === Command.WRITE_SN) {
        if (payload.length !== 1) throw new Error("SN \u5199\u5165\u5E94\u7B54\u957F\u5EA6\u65E0\u6548");
        return payload[0];
      }
      if (command === Command.GET_FIRMWARE_ID) {
        if (payload.length !== 37) throw new Error("firmware identity length must be 37");
        return {
          sha256: Array.from(payload.subarray(1, 33), (b) => b.toString(16).padStart(2, "0")).join(""),
          uptimeMs: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(33, true)
        };
      }
      if (command === Command.GET_INFO) return unpackDeviceInfo(payload);
      if (command === Command.GET_PARAMS || command === Command.SET_PARAMS || command === Command.RESET_PARAMS) {
        return unpackDeviceParameters(payload);
      }
      if (command === Command.CANCEL_CAPTURE || command === Command.HEARTBEAT) {
        if (payload.length !== 1) throw new Error("payload length must be exactly 1");
        return payload[0];
      }
      if (command === Command.SET_STREAM) return unpackSetStreamResponse(payload);
      throw new Error("unexpected response command");
    }
    _handleStartCaptureResponse(pending, payload) {
      let decoded;
      try {
        decoded = unpackStartCaptureResponse(payload);
      } catch (error) {
        this._diagnostic(`uncorrelated capture start response retained pending request: ${error.message}`, pending.sequence);
        return;
      }
      const expected = [pending.context.pointId, pending.context.captureId];
      const actual = [decoded.pointId, decoded.captureId];
      if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
        this._diagnostic(
          `capture start identity mismatch: expected point ${expected[0]} capture_id ${expected[1]}, received point ${actual[0]} capture_id ${actual[1]}`,
          pending.sequence
        );
        return;
      }
      this._pending.delete(pending.sequence);
      if (decoded.status !== Status.OK) {
        this._finishStatusError(pending, decoded.status);
        return;
      }
      this._completeRequest(pending, decoded);
    }
    _finishStatusError(pending, status) {
      this._recordParameterFailureIfNeeded(pending, statusName(status));
      if (pending.operation === "heartbeat") {
        this._diagnostic(`heartbeat failed: ${statusName(status)}`, pending.sequence);
        return;
      }
      this._emitRequestError(pending, statusName(status), `${pending.operation} failed: ${statusName(status)}`, {
        status
      });
    }
    _completeRequest(pending, decoded) {
      switch (pending.command) {
        case Command.DEVICE_CONTROL:
          if (pending.operation === "device_control" && (decoded.requestId !== pending.context.requestId || decoded.action !== pending.context.action || decoded.value !== pending.context.value)) {
            this._emitRequestError(pending, "device_control_mismatch", "\u8BBE\u5907\u64CD\u4F5C\u5E94\u7B54\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
            break;
          }
          this.deviceControl = decoded;
          this._emit("device_control", { ...decoded, operation: pending.operation }, pending.sequence);
          break;
        case Command.MEASUREMENT_CONTROL:
          if (["start_measurement", "select_bean"].includes(pending.operation) && (decoded.requestId !== pending.context.requestId || decoded.beanId !== pending.context.beanId || decoded.mode !== pending.context.mode)) {
            this._emitRequestError(pending, "measurement_mismatch", "\u8BBE\u5907\u8FD4\u56DE\u7684\u6D4B\u91CF\u4EFB\u52A1\u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4");
            break;
          }
          this.measurement = decoded;
          this._emit("measurement", { ...decoded, operation: pending.operation }, pending.sequence);
          break;
        case Command.WRITE_SN:
          this._send(Command.READ_SN, new Uint8Array(), "sn_readback", { snExpected: pending.context.sn });
          break;
        case Command.READ_SN:
          this._emit("sn", decoded, pending.sequence);
          if (pending.context.snExpected) {
            if (decoded.sn !== pending.context.snExpected) this._emitRequestError(pending, "SN_MISMATCH", "SN \u5199\u540E\u56DE\u8BFB\u4E0D\u4E00\u81F4");
            else {
              this.session.deviceId = decoded.sn;
              this._emit("sn_verified", decoded, pending.sequence);
              this.readInfo();
            }
          }
          break;
        case Command.GET_FIRMWARE_ID:
          this._emit("firmware_identity", decoded, pending.sequence);
          break;
        case Command.GET_INFO:
          this.session.deviceId = decoded.deviceId;
          this._emit("info", decoded, pending.sequence);
          break;
        case Command.GET_PARAMS: {
          if (pending.context.writeVerify != null) {
            this._verifyWriteReadback(pending, decoded);
          } else {
            this.session.recordParameterOperation("read", "ok", this.session.parameterDetails(decoded));
            this._emit("parameters", decoded, pending.sequence);
          }
          break;
        }
        case Command.SET_PARAMS: {
          const verification = {
            slopeK: pending.context.slopeK,
            offsetB: pending.context.offsetB,
            paramVersion: decoded.paramVersion,
            paramsValid: true,
            calDewValid: false,
            originSequence: pending.sequence
          };
          const readbackTicket = this._register(Command.GET_PARAMS, new Uint8Array(0), "write_readback", {
            writeVerify: verification
          });
          if (readbackTicket) {
            this._writeTicket(readbackTicket).catch((error) => this._handleWriteError(readbackTicket, error));
          }
          break;
        }
        case Command.RESET_PARAMS:
          if (decoded.calDewValid || !decoded.paramsValid || decoded.slopeK !== 1 || decoded.offsetB !== 0) {
            this.session.recordParameterOperation("reset", "error", this.session.parameterDetails(decoded));
            this._emit("error", { operation: "reset_parameters", reason: "reset readback mismatch" }, pending.sequence, "\u6062\u590D\u53C2\u6570\u540E\u56DE\u8BFB\u4E0D\u4E00\u81F4");
          } else {
            this.session.recordParameterOperation("reset", "ok", this.session.parameterDetails(decoded));
            this._emit("reset", decoded, pending.sequence);
          }
          break;
        case Command.START_CAPTURE:
          this._activeCapture = {
            generation: pending.generation,
            pointId: decoded.pointId,
            captureId: decoded.captureId,
            requestSequence: pending.sequence
          };
          this._emit("capture_started", { pointId: decoded.pointId, captureId: decoded.captureId }, pending.sequence);
          break;
        case Command.CANCEL_CAPTURE:
          this._emit("capture_cancelled", null, pending.sequence);
          break;
        case Command.SET_STREAM: {
          const expected = [pending.context.enabled, pending.context.intervalMs];
          const actual = [decoded.enabled, decoded.intervalMs];
          if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
            this._emit("error", {
              operation: pending.operation,
              reason: "stream response mismatch",
              expected,
              actual
            }, pending.sequence, "\u5B9E\u65F6\u6D41\u5E94\u7B54\u4E0D\u4E00\u81F4");
          } else {
            this._emit("stream_configured", { enabled: decoded.enabled, intervalMs: decoded.intervalMs }, pending.sequence);
          }
          break;
        }
        case Command.HEARTBEAT:
          this._emit("heartbeat", null, pending.sequence);
          break;
        default:
          break;
      }
    }
    _verifyWriteReadback(pending, parameters) {
      const expected = pending.context.writeVerify;
      const matches = Math.abs(parameters.slopeK - expected.slopeK) <= 1e-6 && Math.abs(parameters.offsetB - expected.offsetB) <= 1e-6 && parameters.paramVersion === expected.paramVersion && parameters.paramsValid === expected.paramsValid && parameters.calDewValid === expected.calDewValid;
      if (matches) {
        this.session.recordParameterOperation("write", "verified", this.session.parameterDetails(parameters));
        this._emit("write_verified", parameters, expected.originSequence);
      } else {
        const details = {
          reason: "readback mismatch",
          expected,
          actual: this.session.parameterDetails(parameters)
        };
        this.session.recordParameterOperation("write", "error", details);
        this._emit("error", details, expected.originSequence, "\u53C2\u6570\u5199\u5165\u540E\u56DE\u8BFB\u4E0D\u4E00\u81F4");
      }
    }
    _handleAsyncEvent(frame) {
      try {
        if (frame.command === Command.TELEMETRY) {
          const telemetry = unpackTelemetry(frame.payload);
          this.session.recordTelemetry(telemetry);
          this._emit("telemetry", telemetry, frame.sequence);
        } else if (frame.command === Command.MD_TELEMETRY) {
          const telemetry = { ...unpackMdTelemetry(frame.payload), timestamp: (/* @__PURE__ */ new Date()).toISOString() };
          this.session.mdTelemetry.push(telemetry);
          this._emit("md_telemetry", telemetry, frame.sequence);
        } else if (frame.command === Command.CAPTURE_PROGRESS) {
          this._recordCaptureProgress(unpackCaptureProgress(frame.payload), frame.sequence);
        } else if (frame.command === Command.CAPTURE_RESULT) {
          this._recordCaptureResult(unpackCaptureResult(frame.payload), frame.sequence);
        } else if (frame.command === Command.NOTICE) {
          this._emit("notice", unpackNotice(frame.payload), frame.sequence);
        } else if (frame.command === Command.OTA_ACK) {
        }
      } catch (error) {
        this._diagnostic(`malformed asynchronous payload: ${error.message}`, frame.sequence);
      }
    }
    _recordCaptureProgress(progress, sequence) {
      if (progress.pointId < 0 || progress.pointId > 3) throw new Error("point_id out of range");
      this._recoverCaptureFromEvent(progress);
      const active = this._activeCapture;
      if (!active) {
        this._diagnostic("ignored capture progress without an active capture", sequence);
        return;
      }
      if (progress.pointId !== active.pointId) {
        this._diagnostic(`ignored capture progress point mismatch: active ${active.pointId}, progress ${progress.pointId}`, sequence);
        return;
      }
      if (progress.captureId !== active.captureId) {
        this._diagnostic(`ignored capture progress capture_id mismatch: active ${active.captureId}, progress ${progress.captureId}`, sequence);
        return;
      }
      this._emit("capture_progress", progress, sequence);
    }
    _recordCaptureResult(result, sequence) {
      const names = ["stable", "timeout", "cancelled", "sensor_error"];
      if (result.pointId < 0 || result.pointId > 3) throw new Error("point_id out of range");
      if (!names[result.resultCode]) throw new Error("unknown capture result code");
      const run = {
        pointId: result.pointId,
        meanRhRaw: result.meanRhRaw,
        meanRhCorrected: result.meanRhCorrected,
        stddevRhRaw: result.stddevRhRaw,
        sampleCount: result.sampleCount,
        elapsedMs: result.elapsedMs,
        resultCode: names[result.resultCode]
      };
      this._recoverCaptureFromEvent(result);
      const active = this._activeCapture;
      if (!active) {
        this._diagnostic("ignored capture result without an active capture", sequence);
        return;
      }
      if (run.pointId !== active.pointId) {
        this._diagnostic(`ignored capture result point mismatch: active ${active.pointId}, result ${run.pointId}`, sequence);
        return;
      }
      if (result.captureId !== active.captureId) {
        this._diagnostic(`ignored capture result capture_id mismatch: active ${active.captureId}, result ${result.captureId}`, sequence);
        return;
      }
      this._activeCapture = null;
      this.session.recordCapture(run);
      this._emit("capture_result", run, sequence);
      if (run.resultCode === "stable") {
        const report = this.recomputeReport();
        if (report) this._emit("report", report, sequence);
      }
    }
    /** 匹配的采集 ID 证明设备已受理（即使 ACK 丢失）— 对齐 _recover_capture_from_event。 */
    _recoverCaptureFromEvent(event) {
      if (this._activeCapture != null) return;
      for (const pending of [...this._pending.values()]) {
        if (pending.command === Command.START_CAPTURE && pending.context.pointId === event.pointId && pending.context.captureId === event.captureId && this._now() < pending.finalDeadline) {
          this._pending.delete(pending.sequence);
          this._diagnostic("\u5DF2\u901A\u8FC7\u5339\u914D\u7684\u91C7\u96C6 ID \u786E\u8BA4\u8BBE\u5907\u6B63\u5728\u91C7\u96C6", pending.sequence);
          this._completeRequest(pending, {
            status: Status.OK,
            pointId: event.pointId,
            captureId: event.captureId
          });
          return;
        }
      }
    }
    /** 由 app.js 每 200ms 调用：驱动超时/重试/宽限判定 */
    tick() {
      if (this._otaPaused) return;
      const now = this._now();
      const tickets = [];
      for (const request of [...this._pending.values()]) {
        if (request.deadline > now) continue;
        if (now < request.finalDeadline) {
          if (SAFE_RETRY_COMMANDS.has(request.command) && request.retries < this.readRetryCount) {
            request.retries += 1;
            request.deadline = Math.min(now + this.requestTimeoutMs, request.finalDeadline);
            tickets.push({ generation: this._generation, transport: this._transport, pending: request, frame: request.frame });
            this._emit(
              "request_retry",
              {
                operation: request.operation,
                attempt: request.retries + 1
              },
              this._publicSequence(request),
              `${OPERATION_LABELS[request.operation] ?? request.operation}\u5E94\u7B54\u672A\u5230\uFF0C\u81EA\u52A8\u91CD\u8BD5 ${request.retries}/${this.readRetryCount}`
            );
            continue;
          }
          if (request.command === Command.START_CAPTURE && !request.recovering) {
            request.recovering = true;
            request.deadline = request.finalDeadline;
            this._emit(
              "capture_recovering",
              { pointId: request.context.pointId },
              request.sequence,
              "\u91C7\u96C6\u786E\u8BA4\u5E94\u7B54\u672A\u5230\uFF0C\u6B63\u5728\u7B49\u5F85\u5BF9\u5E94\u91C7\u96C6\u8FDB\u5EA6\u6216\u7ED3\u679C"
            );
            continue;
          }
        }
        if (this._pending.get(request.sequence) !== request) continue;
        this._pending.delete(request.sequence);
        this._finishTimeout(request);
      }
      for (const ticket of tickets) {
        this._writeTicket(ticket).catch((error) => this._handleWriteError(ticket, error));
      }
    }
    _finishTimeout(request) {
      this._recordParameterFailureIfNeeded(request, "timeout");
      const origin = this._publicSequence(request);
      if (request.operation === "heartbeat") {
        this._diagnostic("\u5FC3\u8DF3\u5E94\u7B54\u8D85\u65F6\uFF1B\u5B9E\u65F6\u6570\u636E\u66F4\u65B0\u4E0D\u4EE3\u8868\u547D\u4EE4\u5E94\u7B54\u6B63\u5E38", request.sequence);
        return;
      }
      const uncertain = request.command === Command.START_CAPTURE;
      const label = OPERATION_LABELS[request.operation] ?? request.operation;
      const message = uncertain ? "\u5F00\u59CB\u91C7\u96C6\u672A\u786E\u8BA4\uFF0C\u8BF7\u5148\u53D6\u6D88\u5F53\u524D\u91C7\u96C6\u540E\u91CD\u8BD5" : `${label}\u5E94\u7B54\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u5907\u901A\u4FE1`;
      this._emit("request_timeout", {
        operation: request.operation,
        reason: "timeout",
        requestSequence: request.sequence,
        captureUncertain: uncertain
      }, origin, message);
    }
    _finishMalformed(pending, reason) {
      this._diagnostic(reason, pending.sequence);
      this._recordParameterFailureIfNeeded(pending, reason);
      if (pending.operation === "heartbeat") return;
      this._emitRequestError(pending, reason, reason);
    }
    _transportError(generation, error) {
      var _a, _b, _c;
      if (generation !== this._generation || !this._connected) return;
      try {
        console.error("[AW] transport error:", error);
        window.__awTransportError = { detail: error, stack: (_a = error == null ? void 0 : error.error) == null ? void 0 : _a.stack, time: (/* @__PURE__ */ new Date()).toISOString() };
        localStorage.setItem("awDiagTransport", JSON.stringify({
          msg: String((error == null ? void 0 : error.message) ?? error),
          source: (error == null ? void 0 : error.source) ?? null,
          stack: (((_b = error == null ? void 0 : error.error) == null ? void 0 : _b.stack) ?? "").slice(0, 600),
          time: Date.now()
        }));
      } catch {
      }
      if (error && typeof error === "object" && error.error != null && error.source != null) {
        this._diagnostic(
          `\u4E8B\u4EF6\u5904\u7406\u5668\u5F02\u5E38\uFF08${error.source}\uFF09\uFF1A${((_c = error.error) == null ? void 0 : _c.message) ?? String(error.error)}`
        );
        return;
      }
      const message = String((error == null ? void 0 : error.message) ?? error);
      this._transport = null;
      this._connected = false;
      this._generation += 1;
      this._activeCapture = null;
      for (const request of this._pending.values()) {
        if (request.operation === "heartbeat") continue;
        this._emitRequestError(request, "disconnected", "request failed because the transport disconnected");
      }
      this._pending.clear();
      for (const off of this._offTransport) off();
      this._offTransport = [];
      this._emit("error", { operation: "transport", reason: message }, null, `\u901A\u4FE1\u4E2D\u65AD\uFF1A${message}`);
      this._emit("disconnected");
    }
    /** 对端主动断开（蓝牙 GATT 断连等）：等同传输故障处理 */
    _peerDisconnected(generation) {
      if (generation !== this._generation || !this._connected) return;
      this._transportError(generation, { message: "peer disconnected" });
    }
    _recordParameterFailureIfNeeded(pending, reason) {
      if ([Command.GET_PARAMS, Command.SET_PARAMS, Command.RESET_PARAMS].includes(pending.command)) {
        this.session.recordParameterOperation(pending.operation, "error", { reason });
      }
    }
    _publicSequence(request) {
      const verification = request.context.writeVerify;
      if (verification && Number.isInteger(verification.originSequence)) {
        return verification.originSequence;
      }
      return request.sequence;
    }
    _emitRequestError(pending, reason, message, extra) {
      if (pending.operation === "heartbeat") return;
      const details = { operation: pending.operation, reason, ...extra ?? {} };
      const origin = this._publicSequence(pending);
      if (origin !== pending.sequence) details.requestSequence = pending.sequence;
      this._emit("error", details, origin, message ?? reason);
    }
    _diagnostic(message, sequence = null) {
      this._emit("diagnostic", { reason: message }, sequence, message);
    }
    _emit(kind, data, sequence, message = "") {
      this.emit(kind, { kind, data, sequence, message });
    }
  };
  function statusName(value) {
    const names = [
      "OK",
      "UNKNOWN_COMMAND",
      "BAD_LENGTH",
      "INVALID_PARAMETER",
      "BUSY",
      "SENSOR_UNAVAILABLE",
      "CAPTURE_TIMEOUT",
      "STORAGE_ERROR",
      "INTERNAL_ERROR"
    ];
    return names[value] ?? `UNKNOWN_${value}`;
  }

  // aw_ble.js
  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  var AwBleTransport = class extends Transport {
    constructor(options = {}) {
      var _a;
      super(options.name ?? "BLE");
      this.bluetooth = options.bluetooth ?? ((_a = globalThis.navigator) == null ? void 0 : _a.bluetooth) ?? null;
      this.filters = options.filters ?? [{ namePrefix: AW_BLE.namePrefix }];
      this.serviceUuid = options.serviceUuid ?? AW_BLE.serviceUuid;
      this.uuids = options.uuids ?? AW_BLE;
      this.commandKey = (options.commandKey ?? COMMAND_KEY).slice();
      this.presetDevice = options.presetDevice ?? null;
      this.connectRetryCount = options.connectRetryCount ?? 2;
      this.retryDelayMs = options.retryDelayMs ?? 500;
      this.gattTimeoutMs = options.gattTimeoutMs ?? 1e4;
      this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? 1e3;
      this._disconnectPromise = null;
      this._disconnecting = false;
      this._generation = 0;
      this.device = null;
      this.server = null;
      this.service = null;
      this.chars = null;
      this._writeChain = Promise.resolve();
      this._notifyHandlers = /* @__PURE__ */ new Map();
      this._onGattDisconnected = () => {
        this._removeListeners();
        this.server = null;
        this.service = null;
        this.chars = null;
        this._setState(TransportState.DISCONNECTED);
        this.emit("disconnected", { transport: this, device: this.device });
      };
    }
    async connect() {
      var _a, _b, _c;
      if (!(this.commandKey instanceof Uint8Array) || this.commandKey.length !== 16) {
        throw transportError("BLE_PREFIX_INVALID", "\u84DD\u7259\u547D\u4EE4\u524D\u7F00\u957F\u5EA6\u65E0\u6548");
      }
      this._otaWriteWithResponse = false;
      this._disconnectPromise = null;
      this._disconnecting = false;
      this._generation++;
      if (!((_a = this.bluetooth) == null ? void 0 : _a.requestDevice)) {
        throw transportError("BLE_UNSUPPORTED", "Web Bluetooth is not available\uFF08\u8BF7\u7528 Chrome / Edge\uFF09");
      }
      this._setState(TransportState.CONNECTING);
      let device;
      if (this.presetDevice) {
        device = this.presetDevice;
      } else {
        try {
          if (this.bluetooth.getDevices) {
            try {
              const devices = await this.bluetooth.getDevices();
              const matches = devices.filter((d) => this.filters.some((filter) => {
                var _a2;
                return filter.name && d.name === filter.name || filter.namePrefix && ((_a2 = d.name) == null ? void 0 : _a2.startsWith(filter.namePrefix));
              }));
              if (matches.length === 1) device = matches[0];
            } catch {
            }
          }
          device ??= await this.bluetooth.requestDevice({
            filters: this.filters,
            optionalServices: [this.serviceUuid]
          });
        } catch (error) {
          this._setState(TransportState.DISCONNECTED);
          throw transportError(
            (error == null ? void 0 : error.name) === "NotFoundError" ? "DEVICE_NOT_SELECTED" : "BLE_DEVICE_REQUEST_FAILED",
            (error == null ? void 0 : error.name) === "NotFoundError" ? "\u672A\u9009\u62E9\u84DD\u7259\u8BBE\u5907\uFF0C\u8BF7\u9009\u62E9 LEBREW DOUBLE TO ONE" : "\u65E0\u6CD5\u6253\u5F00\u84DD\u7259\u8BBE\u5907\u9009\u62E9\uFF1A" + ((error == null ? void 0 : error.message) || error),
            error
          );
        }
      }
      this.device = device;
      this.emit("log", { transport: this, text: `\u8FDE\u63A5\u8BBE\u5907\uFF1A${device.name || "\u672A\u547D\u540D\u8BBE\u5907"}` });
      for (let attempt = 0; attempt <= this.connectRetryCount; attempt++) {
        device.addEventListener("gattserverdisconnected", this._onGattDisconnected);
        this._setState(TransportState.CONNECTING);
        try {
          if (!device.gatt) {
            let forgot = false;
            try {
              if (typeof device.forget === "function") {
                await device.forget();
                forgot = true;
              }
            } catch (_) {
            }
            throw transportError(
              "BLE_CONNECT_FAILED",
              "\u6D4F\u89C8\u5668\u8BB0\u4F4F\u4E86\u4E4B\u524D\u5931\u6548\u7684\u8BBE\u5907\uFF08\u672A\u5F39\u9009\u62E9\u6846\u76F4\u63A5\u5931\u8D25\uFF09" + (forgot ? "\uFF0C\u5DF2\u81EA\u52A8\u6E05\u9664\u8BB0\u5FC6\u2014\u2014\u8BF7\u518D\u70B9\u4E00\u6B21\u300C\u8FDE\u63A5\u84DD\u7259\u300D\u91CD\u65B0\u9009\u62E9\u8BBE\u5907" : "\u2014\u2014\u8BF7\u5728\u5730\u5740\u680F\u5DE6\u4FA7\u7684\u7AD9\u70B9\u8BBE\u7F6E\u91CC\u6E05\u9664\u8BE5\u7F51\u7AD9\u6570\u636E\u540E\u91CD\u8BD5")
            );
          }
          this.server = await this._gatt(() => device.gatt.connect(), "\u5EFA\u7ACB GATT \u8FDE\u63A5");
          this.emit("log", { transport: this, text: "GATT \u5DF2\u8FDE\u63A5\uFF0C\u6B63\u5728\u53D1\u73B0\u6807\u5B9A\u670D\u52A1" });
          this.service = await this._gatt(() => this.server.getPrimaryService(this.serviceUuid), "\u53D1\u73B0\u6807\u5B9A\u670D\u52A1");
          const { telemetryUuid, commandUuid, transferCtrlUuid, transferDataUuid } = this.uuids;
          const telemetry = await this._gatt(() => this.service.getCharacteristic(telemetryUuid), "\u53D1\u73B0\u5B9E\u65F6\u6570\u636E\u7279\u5F81");
          const command = await this._gatt(() => this.service.getCharacteristic(commandUuid), "\u53D1\u73B0\u547D\u4EE4\u7279\u5F81");
          const optionalCharacteristic = async (uuid) => {
            try {
              return await this._gatt(() => this.service.getCharacteristic(uuid), "\u53D1\u73B0\u5347\u7EA7\u7279\u5F81");
            } catch (error) {
              if ((error == null ? void 0 : error.name) === "NotFoundError") return null;
              throw error;
            }
          };
          const ctrl = await optionalCharacteristic(transferCtrlUuid);
          const data = await optionalCharacteristic(transferDataUuid);
          if (!ctrl || !data) {
            let forgot = false;
            try {
              if (typeof device.forget === "function") {
                await device.forget();
                forgot = true;
              }
            } catch (_) {
            }
            throw transportError(
              "BLE_FIRMWARE_TOO_OLD",
              "\u8BBE\u5907\u84DD\u7259\u5DF2\u8FDE\u4E0A\uFF0C\u4F46\u56FA\u4EF6\u7F3A\u5C11 0x2A39/0x2A40 \u4F20\u8F93\u7279\u5F81\u2014\u2014\u5F53\u524D\u51FA\u5382\u56FA\u4EF6\u7684\u84DD\u7259\u4E0D\u4F1A\u5904\u7406\u4EFB\u4F55\u547D\u4EE4\u3002\u8BF7\u5148\u7528 USB \u6709\u7EBF\u5237\u5165\u914D\u5957\u56FA\u4EF6\uFF08\u5206\u533A\u8868\u5DF2\u6539\u53CC OTA \u69FD\uFF0C\u9996\u6B21\u5FC5\u987B\u6709\u7EBF\u5237\uFF09\uFF0C\u518D\u70B9\u300C\u8FDE\u63A5\u84DD\u7259\u300D" + (forgot ? "\uFF08\u5DF2\u6E05\u9664\u6D4F\u89C8\u5668\u8BBE\u5907\u8BB0\u5FC6\uFF0C\u5237\u673A\u540E\u91CD\u65B0\u9009\u62E9\u5373\u53EF\uFF09" : "")
            );
          }
          this.chars = { telemetry, command, ctrl, data };
          await this._subscribe(telemetry, "telemetry");
          await this._subscribe(ctrl, "ctrl");
          if (!device.gatt.connected) throw new DOMException("GATT disconnected during setup", "NetworkError");
          this._setState(TransportState.CONNECTED);
          this.emit("log", { transport: this, text: "\u7279\u5F81\u5C31\u7EEA\uFF1A0x2A37/0x2A38/0x2A39/0x2A40" });
          return this;
        } catch (error) {
          try {
            if ((_c = (_b = this.device) == null ? void 0 : _b.gatt) == null ? void 0 : _c.connected) this.device.gatt.disconnect();
          } catch (_) {
          }
          this._removeListeners();
          this.server = null;
          this.service = null;
          this.chars = null;
          if (attempt < this.connectRetryCount && (error == null ? void 0 : error.name) === "NetworkError") {
            this.emit("log", { transport: this, text: `\u84DD\u7259\u670D\u52A1\u53D1\u73B0\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5 ${attempt + 1}/${this.connectRetryCount}` });
            await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
            continue;
          }
          this._setState(TransportState.DISCONNECTED);
          throw typeof (error == null ? void 0 : error.code) === "string" ? error : transportError("BLE_CONNECT_FAILED", "BLE connect failed: " + ((error == null ? void 0 : error.message) || error), error);
        }
      }
    }
    async _gatt(operation, label) {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new DOMException(`${label}\u8D85\u65F6\uFF08\u6D4F\u89C8\u5668\u84DD\u7259\u6808\u672A\u8FD4\u56DE\uFF09`, "NetworkError");
              error.gattTimedOut = true;
              reject(error);
            }, this.gattTimeoutMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    /** 清除浏览器对该设备的记忆（权限 + 缓存的属性句柄表），下次连接重新发现服务 */
    async _forgetDevice() {
      try {
        if (this.device && typeof this.device.forget === "function") {
          await this.device.forget();
        }
      } catch (_) {
      }
    }
    /** 对外：命令全超时（GATT 属性缓存过期典型症状）时主动清缓存 */
    async recoverStaleCache() {
      var _a, _b;
      try {
        if ((_b = (_a = this.device) == null ? void 0 : _a.gatt) == null ? void 0 : _b.connected) this.device.gatt.disconnect();
      } catch {
      }
      await this._forgetDevice();
      this._setState(TransportState.DISCONNECTED);
      this.emit("disconnected", { transport: this, device: this.device });
    }
    async _subscribe(characteristic, kind) {
      const handler = (event) => {
        this.emit("data", { transport: this, bytes: toBytes(event.target.value), kind });
      };
      const previous = this._notifyHandlers.get(kind);
      if (previous) previous.characteristic.removeEventListener("characteristicvaluechanged", previous.handler);
      characteristic.addEventListener("characteristicvaluechanged", handler);
      this._notifyHandlers.set(kind, { characteristic, handler });
      await this._gatt(() => characteristic.startNotifications(), "\u8BA2\u9605\u8BBE\u5907\u901A\u77E5");
    }
    _removeListeners() {
      var _a;
      for (const { characteristic, handler } of this._notifyHandlers.values()) {
        characteristic.removeEventListener("characteristicvaluechanged", handler);
      }
      this._notifyHandlers.clear();
      (_a = this.device) == null ? void 0 : _a.removeEventListener("gattserverdisconnected", this._onGattDisconnected);
    }
    _requireChar(name) {
      var _a, _b, _c;
      const characteristic = (_a = this.chars) == null ? void 0 : _a[name];
      if (!characteristic || !((_c = (_b = this.device) == null ? void 0 : _b.gatt) == null ? void 0 : _c.connected)) {
        throw transportError("NOT_CONNECTED", this.name + " is not connected");
      }
      return characteristic;
    }
    async _write(characteristic, bytes, withoutResponse) {
      var _a, _b;
      try {
        await this._gatt(() => {
          if (withoutResponse && typeof characteristic.writeValueWithoutResponse === "function") {
            return characteristic.writeValueWithoutResponse(bytes);
          } else if (typeof characteristic.writeValueWithResponse === "function") {
            return characteristic.writeValueWithResponse(bytes);
          }
          return characteristic.writeValue(bytes);
        }, "\u84DD\u7259\u5199\u5165");
      } catch (error) {
        if (error.gattTimedOut) {
          this._generation++;
          try {
            (_b = (_a = this.device) == null ? void 0 : _a.gatt) == null ? void 0 : _b.disconnect();
          } catch {
          }
        }
        throw error;
      }
    }
    /** 所有 GATT 写入统一排队，杜绝并发 */
    _queueWrite(operation) {
      const generation = this._generation;
      const run = () => {
        if (generation !== this._generation) throw transportError("NOT_CONNECTED", "BLE session ended");
        return operation();
      };
      const next = this._writeChain.then(run, run);
      this._writeChain = next.catch(() => {
      });
      return next;
    }
    /** 参数命令 → 0x2A38：控制器给的是裸 A5 5A 帧，设备要求 [16B 密钥][帧]（带响应写） */
    async writeCommand(bytes) {
      if (this._disconnecting) throw transportError("NOT_CONNECTED", "BLE is disconnecting");
      return this._queueWrite(() => this._write(this._requireChar("command"), bytes, false));
    }
    /** OTA 控制（START/END/ABORT）→ 0x2A39：同样要求密钥前缀（固件侧校验后剥离） */
    async writeControl(bytes) {
      if (this._disconnecting) throw transportError("NOT_CONNECTED", "BLE is disconnecting");
      return this._queueWrite(() => this._write(this._requireChar("ctrl"), buildBleCommand(bytes, this.commandKey), false));
    }
    /** OTA 数据包（[seq:2B BE][chunk]）→ 0x2A40，无响应写（高频通道，不走密钥） */
    get otaWriteMode() {
      return this._otaWriteWithResponse ? "\u5E26\u54CD\u5E94\u5199" : "\u65E0\u54CD\u5E94\u5199";
    }
    /* Called only after an acknowledged ABORT, before START. FFFF is reserved
     * and the matching firmware treats it as a no-op even during a session. */
    async prepareOtaData(maxChunk = 244) {
      return this._queueWrite(async () => {
        var _a, _b;
        const data = this._requireChar("data");
        const safeChunk = Math.min(maxChunk, 242);
        if (typeof data.writeValueWithoutResponse === "function" && ((_a = data.properties) == null ? void 0 : _a.writeWithoutResponse) !== false) {
          const candidates = [.../* @__PURE__ */ new Set([safeChunk, Math.min(safeChunk, 180), Math.min(safeChunk, 120), Math.min(safeChunk, 18)])];
          for (const chunk of candidates) {
            const probe = new Uint8Array(chunk + 2).fill(255);
            try {
              await this._write(data, probe, true);
              this._otaWriteWithResponse = false;
              return chunk;
            } catch (error) {
              if (!["InvalidModificationError", "DataError", "NotSupportedError"].includes(error.name)) throw error;
            }
          }
        }
        if (((_b = data.properties) == null ? void 0 : _b.write) === false) throw transportError("BLE_OTA_WRITE_UNAVAILABLE", "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u8BBE\u5907\u6240\u9700\u7684\u84DD\u7259\u5199\u5165\u65B9\u5F0F");
        this._otaWriteWithResponse = true;
        return Math.min(maxChunk, 242);
      });
    }
    async writeData(bytes) {
      if (this._disconnecting) throw transportError("NOT_CONNECTED", "BLE is disconnecting");
      return this._queueWrite(async () => {
        var _a, _b, _c;
        const data = this._requireChar("data");
        try {
          await this._write(data, bytes, !this._otaWriteWithResponse);
        } catch (error) {
          if (this._otaWriteWithResponse || !((_a = data.properties) == null ? void 0 : _a.write) || !((_c = (_b = this.device) == null ? void 0 : _b.gatt) == null ? void 0 : _c.connected)) throw error;
          this._otaWriteWithResponse = true;
          this.emit("log", { transport: this, text: "\u84DD\u7259\u65E0\u54CD\u5E94\u5199\u4E0D\u53EF\u7528\uFF0C\u5347\u7EA7\u6570\u636E\u5207\u6362\u4E3A\u5E26\u54CD\u5E94\u5199" });
          await this._write(data, bytes, false);
        }
      });
    }
    /** 基座 Link 通用出口：自动补 16B 密钥后走命令特征 */
    async write(bytes) {
      return this.writeCommand(buildBleCommand(bytes, this.commandKey));
    }
    disconnect() {
      if (!this._disconnectPromise) {
        this._disconnecting = true;
        this._generation++;
        this._disconnectPromise = this._disconnectLink();
      }
      return this._disconnectPromise;
    }
    async _disconnectLink() {
      var _a, _b, _c;
      const device = this.device;
      const command = (_a = this.chars) == null ? void 0 : _a.command;
      if (command && ((_b = device == null ? void 0 : device.gatt) == null ? void 0 : _b.connected)) {
        const sequence = 65533;
        const decoder = new StreamDecoder();
        let finish;
        const closed = new Promise((resolve) => {
          finish = resolve;
        });
        const offDisconnected = this.on("disconnected", () => finish());
        const offData = this.on("data", ({ bytes, kind }) => {
          if (kind === "ctrl") return;
          for (const frame of decoder.feed(bytes)) {
            if (frame.command === (Command.BLE_DISCONNECT | 128) && frame.sequence === sequence && frame.payload[0] !== 0) finish();
          }
        });
        const timer = setTimeout(() => finish(), this.disconnectTimeoutMs);
        try {
          this._queueWrite(() => this._write(
            command,
            buildBleCommand(encodeFrame(Command.BLE_DISCONNECT, sequence), this.commandKey),
            false
          )).catch(() => finish());
          await closed;
        } finally {
          clearTimeout(timer);
          offData();
          offDisconnected();
        }
      }
      try {
        if ((_c = device == null ? void 0 : device.gatt) == null ? void 0 : _c.connected) device.gatt.disconnect();
      } catch {
      }
      this.server = null;
      this.service = null;
      this.chars = null;
      this._setState(TransportState.DISCONNECTED);
      this._removeListeners();
      return this;
    }
  };

  // aw_sim.js
  var CAPTURE_CENTERS = [38.857, 59.78, 77.687, 98.787];
  var SIM_COMMAND_KEY = new Uint8Array(16);
  var REQUEST_COMMANDS = /* @__PURE__ */ new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18]);
  var CAPTURE_SAMPLE_INTERVAL_MS = 100;
  var CAPTURE_SAMPLE_COUNT = 150;
  var PARAM_SCHEMA_VERSION = 1;
  var CAPTURE_TIMEOUT_MS = 48e4;
  function mean2(values) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  function pstdev(values) {
    const m = mean2(values);
    return Math.sqrt(values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / values.length);
  }
  var SimTransport = class extends Transport {
    constructor(options = {}) {
      super(options.name ?? "SIM");
      this.deviceId = options.deviceId ?? "SIM-AW-0001";
      this.sn = options.sn ?? "";
      this.firmwareVersion = "sim-web-1.0";
      this.firmwareSha256 = "a7".repeat(32);
      this.apMode = false;
      this.otaLog = [];
      this._decoder = new StreamDecoder();
      this._slopeK = 1;
      this._offsetB = 0;
      this._paramVersion = PARAM_SCHEMA_VERSION;
      this._paramsValid = true;
      this._calDew = 0;
      this._calDewValid = true;
      this._streamEnabled = false;
      this._streamIntervalMs = 100;
      this._nextStreamAt = 0;
      this._sampleSequence = 0;
      this._eventSequence = 0;
      this._capture = null;
      this._deviceControl = { phase: 0, action: 0, value: 0, language: 0, standbyMinutes: 3, ready: true };
      this._measurement = { phase: 0, beanId: 0, mode: 0, deviceReady: true, resultFlags: 0 };
      this._timer = null;
      this._startMs = 0;
      this._serialOta = null;
      this._rawBuffer = new Uint8Array(0);
      this._bleOta = null;
    }
    now() {
      return Date.now() - this._startMs;
    }
    async connect() {
      this._setState(TransportState.CONNECTING);
      this._startMs = Date.now();
      this._setState(TransportState.CONNECTED);
      this._timer = setInterval(() => this._tick(), 50);
      return this;
    }
    async disconnect() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this._capture = null;
      this._streamEnabled = false;
      this._setState(TransportState.DISCONNECTED);
      return this;
    }
    close() {
      this.disconnect().catch(() => {
      });
    }
    _emitBytes(frame) {
      this.emit("data", { transport: this, bytes: frame });
    }
    /** 上位机写入：串口裸帧，或 [16B 密钥][帧]（蓝牙演练路径自动剥密钥） */
    async write(data) {
      let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (this._serialOta) {
        this._feedSerialOta(bytes);
        return;
      }
      if (bytes.length >= SIM_COMMAND_KEY.length + 4 && SIM_COMMAND_KEY.every((byte, index) => bytes[index] === byte)) {
        bytes = bytes.slice(SIM_COMMAND_KEY.length);
      }
      for (const frame of this._decoder.feed(bytes)) {
        this._handleRequest(frame);
      }
    }
    /** 蓝牙 0x2A39 控制写（smoke 格式，可选 16B 密钥前缀——与固件行为一致，校验后剥离）；ACK 以 kind:'ctrl' 发出 */
    async writeControl(bytesInput) {
      let bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
      if (bytes.length >= SIM_COMMAND_KEY.length + 1 && SIM_COMMAND_KEY.every((byte, index) => bytes[index] === byte)) {
        bytes = bytes.slice(SIM_COMMAND_KEY.length);
      }
      const notifyCtrl = (ack) => this.emit("data", {
        transport: this,
        bytes: Uint8Array.of(160, ack ? 0 : 1, 0, 0),
        kind: "ctrl"
      });
      if ((bytes[0] === 17 || bytes[0] === 20 && this.fastBleOta) && bytes.length >= 7) {
        const total = (bytes[1] << 24 | bytes[2] << 16 | bytes[3] << 8 | bytes[4]) >>> 0;
        const chunk = bytes[5] << 8 | bytes[6];
        if (chunk > OTA_MAX_CHUNK || total < 32 || total > 3407872) {
          this.emit("data", { transport: this, bytes: Uint8Array.of(160, 1, 0, 0), kind: "ctrl" });
          return;
        }
        this._bleOta = {
          total,
          chunk,
          received: 0,
          expectedSeq: 0,
          packetsInWindow: 0,
          ackWindow: bytes[0] === 20 ? 32 : ACK_WINDOW
        };
        this.otaLog.push(`(\u6A21\u62DF) BLE OTA START\uFF1A${total} \u5B57\u8282\uFF0Cchunk=${chunk}`);
        notifyCtrl(true);
      } else if (bytes[0] === 18) {
        const ok = this._bleOta && this._bleOta.received === this._bleOta.total;
        this.otaLog.push(`(\u6A21\u62DF) BLE OTA END\uFF1A${ok ? "\u6821\u9A8C\u901A\u8FC7\uFF0C\u91CD\u542F" : "\u5B57\u8282\u6570\u4E0D\u7B26"}`);
        this.emit("data", { transport: this, bytes: Uint8Array.of(160, ok ? 0 : 1, 0, 0), kind: "ctrl" });
        if (ok) this._simulateReboot();
      } else if (bytes[0] === 19) {
        this._bleOta = null;
        this.otaLog.push("(\u6A21\u62DF) BLE OTA ABORT");
        if (this.fastBleOta) this.emit("data", { transport: this, bytes: Uint8Array.of(160, 0, 0, 0, 241, 1, 32), kind: "ctrl" });
        else notifyCtrl(true);
      }
    }
    /** 蓝牙 0x2A40 数据写：[seq:2B BE][chunk]（末包含 0xFF 填充，按 total 裁掉） */
    async writeData(bytes) {
      const ota = this._bleOta;
      if (!ota) return;
      const seq = bytes[0] << 8 | bytes[1];
      const chunk = bytes.slice(2);
      const ackOf = (ok, seq_) => this.emit("data", {
        transport: this,
        bytes: Uint8Array.of(160, ok ? 0 : 1, seq_ >> 8 & 255, seq_ & 255),
        kind: "ctrl"
      });
      if (seq < ota.expectedSeq) {
        ackOf(true, ota.expectedSeq - 1);
        return;
      }
      if (seq !== ota.expectedSeq) {
        ackOf(false, ota.expectedSeq);
        return;
      }
      const take = Math.min(chunk.length, ota.total - ota.received);
      ota.received += take;
      ota.expectedSeq += 1;
      ota.packetsInWindow += 1;
      if (ota.packetsInWindow >= ota.ackWindow || ota.received >= ota.total) {
        ota.packetsInWindow = 0;
        ackOf(true, seq);
      }
    }
    // —— 帧命令处理（对齐 simulator.py _handle_request_locked）——
    _handleRequest(frame) {
      const { command, sequence, payload } = frame;
      if (!REQUEST_COMMANDS.has(command)) {
        this._respond(command, sequence, Uint8Array.of(Status.UNKNOWN_COMMAND));
        return;
      }
      this._updateDeviceControl();
      if ((measurementActive(this._measurement) || deviceControlActive(this._deviceControl)) && [
        Command.START_CAPTURE,
        Command.SET_PARAMS,
        Command.RESET_PARAMS,
        Command.WRITE_SN,
        Command.OTA_START,
        Command.OTA_ENTER_AP
      ].includes(command))
        return this._status(command, sequence, Status.BUSY);
      switch (command) {
        case Command.DEVICE_CONTROL: {
          const s = this._deviceControl;
          if (payload.length) {
            if (payload.length !== 8) return this._status(command, sequence, Status.BAD_LENGTH);
            const requestId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
            try {
              packDeviceControl(payload[0], payload[1], requestId);
              if (payload[2] || payload[3]) throw new Error();
            } catch {
              return this._status(command, sequence, Status.INVALID_PARAMETER);
            }
            const action = payload[0], value = payload[1];
            if (s.requestId === requestId) {
              if (s.action !== action || s.value !== value) return this._status(command, sequence, Status.INVALID_PARAMETER);
            } else {
              if (measurementActive(this._measurement) || deviceControlActive(s) || this._capture || this._serialOta || this._bleOta) return this._status(command, sequence, Status.BUSY);
              this._deviceControl = { ...s, action, value, requestId, elapsedMs: 0, error: 0, startedAt: this.now(), phase: action <= 2 ? 3 : 2, screenId: [0, value ? 20 : 7, 8, 11, 12][action] };
              if (action === 1) this._deviceControl.language = value;
              if (action === 2) this._deviceControl.standbyMinutes = value;
            }
          }
          return this._respond(command, sequence, packDeviceState({ ...this._deviceControl, busy: deviceControlActive(this._deviceControl) || measurementActive(this._measurement) || !!this._capture }));
        }
        case Command.MEASUREMENT_CONTROL: {
          this._updateMeasurement();
          if (payload.length) {
            if (payload.length !== 8) return this._status(command, sequence, Status.BAD_LENGTH);
            let r;
            try {
              r = unpackMeasurementControl(payload);
            } catch {
              return this._status(command, sequence, Status.INVALID_PARAMETER);
            }
            const current = this._measurement;
            if (deviceControlActive(this._deviceControl)) return this._status(command, sequence, Status.BUSY);
            if (r.action === 3) {
              if (measurementActive(current) || this._capture || this._serialOta || this._bleOta)
                return this._status(command, sequence, Status.BUSY);
              this.beanId = r.beanId;
              this._measurement = {
                phase: 0,
                beanId: r.beanId,
                mode: 0,
                requestId: r.requestId,
                resultFlags: 0,
                deviceReady: true,
                elapsedMs: 0,
                screenId: 2
              };
            } else if (r.action === 1) {
              if (current.requestId === r.requestId) {
                if (current.beanId !== r.beanId || current.mode !== r.mode)
                  return this._status(command, sequence, Status.INVALID_PARAMETER);
              } else {
                if (measurementActive(current) || this._capture || this._serialOta || this._bleOta)
                  return this._status(command, sequence, Status.BUSY);
                this.beanId = r.beanId;
                this._measurement = {
                  ...r,
                  phase: 2,
                  resultFlags: 0,
                  deviceReady: true,
                  elapsedMs: 0,
                  startedAt: this.now(),
                  screenId: 2
                };
              }
            } else {
              if (current.requestId !== r.requestId) return this._status(command, sequence, Status.INVALID_PARAMETER);
              if (measurementActive(current)) current.phase = 4;
            }
          }
          return this._respond(command, sequence, packMeasurementState(this._measurement));
        }
        case Command.GET_FIRMWARE_ID: {
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          const response = new Uint8Array(37);
          response.set(this.firmwareSha256.match(/../g).map((x) => parseInt(x, 16)), 1);
          new DataView(response.buffer).setUint32(33, this.now(), true);
          return this._respond(command, sequence, response);
        }
        case Command.READ_SN: {
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          const sn = this.sn;
          const text = new TextEncoder().encode(sn);
          return this._respond(command, sequence, Uint8Array.of(0, text.length, ...text));
        }
        case Command.WRITE_SN: {
          if (payload.length !== 18) return this._status(command, sequence, Status.BAD_LENGTH);
          const sn = new TextDecoder().decode(payload);
          if (!snValidate(sn)) return this._status(command, sequence, Status.INVALID_PARAMETER);
          if (this._capture) return this._status(command, sequence, Status.BUSY);
          if (this.sn && this.sn !== sn) return this._status(command, sequence, Status.SN_LOCKED);
          this.sn = sn;
          this.deviceId = sn;
          return this._status(command, sequence, Status.OK);
        }
        case Command.GET_INFO:
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          return this._respond(command, sequence, packDeviceInfo(Status.OK, this.deviceId, this.firmwareVersion));
        case Command.GET_PARAMS:
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          return this._respond(command, sequence, this._packParams());
        case Command.SET_PARAMS: {
          if (payload.length !== 8) return this._status(command, sequence, Status.BAD_LENGTH);
          let request;
          try {
            request = unpackSetParamsRequest(payload);
          } catch {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          if (request.slopeK < 0.25 || request.slopeK > 4 || request.offsetB < -100 || request.offsetB > 100) {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          this._slopeK = request.slopeK;
          this._offsetB = request.offsetB;
          this._calDew = 0;
          this._calDewValid = false;
          this._respond(command, sequence, this._packParams());
          this._event(Command.NOTICE, packNotice(1));
          this._event(Command.NOTICE, packNotice(2));
          return;
        }
        case Command.RESET_PARAMS:
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          this._slopeK = 1;
          this._offsetB = 0;
          this._calDew = 0;
          this._calDewValid = false;
          this._respond(command, sequence, this._packParams());
          this._event(Command.NOTICE, packNotice(1));
          this._event(Command.NOTICE, packNotice(2));
          return;
        case Command.START_CAPTURE: {
          if (payload.length !== 9) return this._status(command, sequence, Status.BAD_LENGTH);
          let request;
          try {
            request = unpackStartCaptureRequest(payload);
          } catch {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          if (request.pointId > 3) {
            return this._respond(command, sequence, packStartCaptureResponse(Status.INVALID_PARAMETER, request.pointId, request.captureId));
          }
          if (this._capture) {
            return this._respond(command, sequence, packStartCaptureResponse(Status.BUSY, request.pointId, request.captureId));
          }
          this._capture = {
            pointId: request.pointId,
            captureId: request.captureId,
            startedAt: this.now(),
            samples: []
          };
          return this._respond(command, sequence, packStartCaptureResponse(Status.OK, request.pointId, request.captureId));
        }
        case Command.CANCEL_CAPTURE: {
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          this._respond(command, sequence, Uint8Array.of(Status.OK));
          if (this._capture) {
            this._captureResult(2);
            this._capture = null;
          }
          return;
        }
        case Command.SET_STREAM: {
          if (payload.length !== 3) return this._status(command, sequence, Status.BAD_LENGTH);
          let request;
          try {
            request = unpackSetStreamRequest(payload);
          } catch {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          if (request.intervalMs < 100 || request.intervalMs > 1e3) {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          this._streamEnabled = request.enabled;
          this._streamIntervalMs = request.intervalMs;
          this._nextStreamAt = this.now() + request.intervalMs;
          return this._respond(command, sequence, packSetStreamResponse(Status.OK, request.enabled, request.intervalMs));
        }
        case Command.HEARTBEAT:
          if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
          return this._status(command, sequence, Status.OK);
        // —— OTA 扩展（串口路径：控制走帧，数据走裸包）——
        case Command.OTA_START: {
          let request;
          try {
            request = unpackOtaStartRequest(payload);
          } catch {
            return this._status(command, sequence, Status.BAD_LENGTH);
          }
          if (request.chunkSize > OTA_MAX_CHUNK || request.totalBytes < 32 || request.totalBytes > 3407872) {
            return this._status(command, sequence, Status.INVALID_PARAMETER);
          }
          this._serialOta = {
            total: request.totalBytes,
            chunk: request.chunkSize,
            received: 0,
            expectedSeq: 0,
            packetsInWindow: 0
          };
          this.otaLog.push(`(\u6A21\u62DF) \u4E32\u53E3 OTA START\uFF1A${request.totalBytes} \u5B57\u8282\uFF0Cchunk=${request.chunkSize}`);
          return this._respond(command, sequence, this.fastSerialOta ? Uint8Array.of(Status.OK, 242, 1, ACK_WINDOW) : Uint8Array.of(Status.OK));
        }
        case Command.OTA_END: {
          const ok = this._serialOta && this._serialOta.received === this._serialOta.total;
          this.otaLog.push(`(\u6A21\u62DF) \u4E32\u53E3 OTA END\uFF1A${ok ? "\u6821\u9A8C\u901A\u8FC7\uFF0C\u5207\u5206\u533A\u91CD\u542F" : "\u5B57\u8282\u6570\u4E0D\u7B26"}`);
          this._respond(command, sequence, Uint8Array.of(ok ? Status.OK : Status.INVALID_PARAMETER));
          if (ok) this._simulateReboot();
          return;
        }
        case Command.OTA_ABORT:
          this._serialOta = null;
          this.otaLog.push("(\u6A21\u62DF) \u4E32\u53E3 OTA ABORT");
          return this._respond(command, sequence, Uint8Array.of(Status.OK));
        case Command.OTA_ENTER_AP:
          this._respond(command, sequence, Uint8Array.of(Status.OK));
          this.apMode = true;
          this.emit("log", { transport: this, text: "AP:REBOOTING" });
          this.otaLog.push("(\u6A21\u62DF) \u8FDB\u5165\u70ED\u70B9\u5347\u7EA7\u6A21\u5F0F\uFF1ALEBREW-AW / 192.168.4.1");
          return;
        default:
          return this._status(command, sequence, Status.UNKNOWN_COMMAND);
      }
    }
    /** 串口 OTA 裸包流：包边界处 0x12/0x13 为 END/ABORT 控制字节，其余为 [seq:2B BE][chunk 定长包]（末包含 0xFF 填充） */
    _feedSerialOta(bytes) {
      const merged = new Uint8Array(this._rawBuffer.length + bytes.length);
      merged.set(this._rawBuffer, 0);
      merged.set(bytes, this._rawBuffer.length);
      let buffer = merged;
      const ota = this._serialOta;
      for (; ; ) {
        if (buffer.length === 0) break;
        if (buffer.length >= 2 && buffer[0] === 255 && buffer[1] === 255) {
          if (buffer.length < 3) break;
          const isEnd = buffer[2] === 18;
          buffer = buffer.slice(3);
          this._serialOta = null;
          if (isEnd) {
            const ok = ota.received === ota.total;
            this.otaLog.push(`(\u6A21\u62DF) \u4E32\u53E3 OTA END\uFF1A${ok ? "\u6821\u9A8C\u901A\u8FC7\uFF0C\u5207\u5206\u533A\u91CD\u542F" : "\u5B57\u8282\u6570\u4E0D\u7B26\uFF08" + ota.received + "/" + ota.total + "\uFF09"}`);
            this._emitBytes(this._frame(138, Uint8Array.of(ok ? Status.OK : Status.INVALID_PARAMETER), 0));
            if (ok) this._simulateReboot();
          } else {
            this.otaLog.push("(\u6A21\u62DF) \u4E32\u53E3 OTA ABORT");
            this._emitBytes(this._frame(139, Uint8Array.of(Status.OK), 0));
          }
          this._rawBuffer = buffer;
          return;
        }
        const packetLength = 2 + ota.chunk;
        if (buffer.length < packetLength) break;
        const seq = buffer[0] << 8 | buffer[1];
        const chunk = buffer.slice(2, packetLength);
        buffer = buffer.slice(packetLength);
        if (seq < ota.expectedSeq) {
          this._event(Command.OTA_ACK, packOtaAck(true, ota.expectedSeq - 1));
          continue;
        }
        if (seq !== ota.expectedSeq) {
          this._event(Command.OTA_ACK, packOtaAck(false, ota.expectedSeq));
          this._rawBuffer = buffer;
          return;
        }
        const take = Math.min(chunk.length, ota.total - ota.received);
        ota.received += take;
        ota.expectedSeq += 1;
        ota.packetsInWindow += 1;
        if (ota.packetsInWindow >= ACK_WINDOW || ota.received >= ota.total) {
          ota.packetsInWindow = 0;
          this._event(Command.OTA_ACK, packOtaAck(true, seq));
        }
      }
      this._rawBuffer = buffer;
    }
    exitApMode() {
      this.apMode = false;
      this._simulateReboot();
    }
    _simulateReboot() {
      const finish = () => {
        this._capture = null;
        this._deviceControl = { phase: 0, action: 0, value: 0, language: this._deviceControl.language, standbyMinutes: this._deviceControl.standbyMinutes, ready: true };
        this._measurement = { phase: 0, beanId: 0, mode: 0, deviceReady: true, resultFlags: 0 };
        this._streamEnabled = false;
        this._serialOta = null;
        this._bleOta = null;
        this._rawBuffer = new Uint8Array(0);
      };
      setTimeout(finish, 400);
    }
    // —— 周期事件（遥测 + 采集采样），由 50ms 定时器驱动 ——
    _updateDeviceControl() {
      const s = this._deviceControl;
      if (!deviceControlActive(s)) return;
      s.elapsedMs = Math.max(0, this.now() - s.startedAt);
      if (s.elapsedMs >= 3e3) {
        s.phase = 3;
        s.screenId = s.action === 3 ? 16 : 17;
      }
    }
    _updateMeasurement() {
      const m = this._measurement;
      if (!measurementActive(m)) return;
      m.elapsedMs = Math.max(0, this.now() - m.startedAt);
      if (m.mode & 1 && m.elapsedMs >= 1200) {
        m.resultFlags |= 1;
        m.moisture = [2.4, 11.5, 15, 12][m.beanId];
        m.density = [420, 650, 370, 310][m.beanId];
      }
      if (m.mode & 2 && m.elapsedMs >= 3e3) {
        m.resultFlags |= 2;
        m.aw = 0.42;
      }
      if (m.resultFlags === m.mode) m.phase = 3;
    }
    _tick() {
      if (this.state !== TransportState.CONNECTED) return;
      const now = this.now();
      this._updateMeasurement();
      if (this._streamEnabled && now >= this._nextStreamAt) {
        this._nextStreamAt += this._streamIntervalMs;
        this._telemetryFrame();
      }
      const capture = this._capture;
      if (capture) {
        const targetSamples = Math.min(
          CAPTURE_SAMPLE_COUNT,
          Math.floor((now - capture.startedAt) / CAPTURE_SAMPLE_INTERVAL_MS)
        );
        while (capture.samples.length < targetSamples && capture.samples.length < CAPTURE_SAMPLE_COUNT) {
          const center = CAPTURE_CENTERS[capture.pointId];
          capture.samples.push(center + (Math.random() * 0.03 - 0.015));
          const count = capture.samples.length;
          if (count === 1 || count % 10 === 0) {
            this._event(Command.CAPTURE_PROGRESS, this._packProgress(capture, now));
          }
          if (count === CAPTURE_SAMPLE_COUNT) {
            this._captureResult(0);
            this._capture = null;
            break;
          }
        }
        if (this._capture && now - capture.startedAt >= CAPTURE_TIMEOUT_MS) {
          this._captureResult(1);
          this._capture = null;
        }
      }
    }
    _packProgress(capture, now) {
      return packCaptureProgress({
        pointId: capture.pointId,
        captureId: capture.captureId,
        sampleCount: capture.samples.length,
        elapsedMs: Math.max(0, now - capture.startedAt),
        meanRhRaw: mean2(capture.samples),
        stddevRhRaw: pstdev(capture.samples)
      });
    }
    _captureResult(resultCode) {
      const capture = this._capture;
      const center = CAPTURE_CENTERS[capture.pointId];
      const samples = capture.samples;
      const meanRaw = samples.length ? mean2(samples) : center;
      const elapsed = Math.max(0, this.now() - capture.startedAt);
      this._event(Command.CAPTURE_RESULT, packCaptureResult({
        pointId: capture.pointId,
        resultCode,
        captureId: capture.captureId,
        sampleCount: samples.length,
        elapsedMs: elapsed,
        meanRhRaw: meanRaw,
        meanRhCorrected: this._slopeK * meanRaw + this._offsetB,
        stddevRhRaw: samples.length ? pstdev(samples) : 0
      }));
    }
    _telemetryFrame() {
      this._sampleSequence = this._sampleSequence + 1 >>> 0;
      const raw = CAPTURE_CENTERS[0] + (Math.random() * 0.04 - 0.02);
      const corrected = this._slopeK * raw + this._offsetB;
      const awUnclamped = awPolynomial(corrected) - this._calDew;
      const flags = 1 | (this._paramsValid ? 2 : 0) | (this._calDewValid ? 4 : 0);
      this._event(Command.TELEMETRY, packTelemetry({
        flags,
        sampleSequence: this._sampleSequence,
        temperatureC: 25,
        humidityRaw: raw,
        humidityCorrected: corrected,
        awUnclamped,
        awFinal: awFinal(corrected, awUnclamped)
      }));
      this._event(Command.MD_TELEMETRY, packMdTelemetry({
        flags: 15,
        beanId: this.beanId ?? 1,
        sampleSequence: this._sampleSequence,
        moisturePct: 10.25 + Math.random() * 0.02,
        densityGl: 680,
        capacitancePf: 15.123456,
        weightAdc: 123456,
        weightG: 108.62,
        emptyCapacitancePf: 2.75,
        deltaCapacitancePf: 15.123456 - 2.75
      }));
    }
    _packParams() {
      return packDeviceParameters({
        status: Status.OK,
        paramVersion: this._paramVersion,
        paramsValid: this._paramsValid,
        calDewValid: this._calDewValid,
        slopeK: this._slopeK,
        offsetB: this._offsetB,
        calDew: this._calDew
      });
    }
    _respond(command, sequence, payload) {
      this._emitBytes(this._frame(command | 128, payload, sequence));
    }
    _status(command, sequence, status) {
      this._respond(command, sequence, Uint8Array.of(status));
    }
    _event(command, payload) {
      this._eventSequence = this._eventSequence >= 65535 ? 1 : this._eventSequence + 1;
      this._emitBytes(this._frame(command, payload, this._eventSequence));
    }
    _frame(command, payload, sequence) {
      return encodeFrame(command, sequence, payload);
    }
  };
  function awPolynomial(humidity) {
    return ((-4422697519e-15 * humidity + 868044735923e-15) * humidity - 0.041082199067613) * humidity + 0.85977143111729;
  }
  function awFinal(correctedHumidity, awUnclamped) {
    if (correctedHumidity <= 31.0154) return 0.28866;
    if (correctedHumidity >= 95.21) return 1;
    return Math.min(1, Math.max(0.28866, awUnclamped));
  }

  // aw_ota.js
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var OtaError = class extends Error {
  };
  var Inbox = class {
    constructor() {
      this.items = [];
      this.waiters = [];
    }
    push(item) {
      const waiter = this.waiters.find((w) => w.match(item));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(item);
      } else {
        this.items.push(item);
        if (this.items.length > 128) this.items.shift();
      }
    }
    next(match, timeoutMs) {
      const index = this.items.findIndex(match);
      if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve, reject };
        w.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new OtaError("\u8BBE\u5907\u5E94\u7B54\u8D85\u65F6"));
        }, timeoutMs);
        this.waiters.push(w);
      });
    }
    clear() {
      this.items.length = 0;
    }
    takeAll(match) {
      const found = this.items.filter(match);
      this.items = this.items.filter((item) => !match(item));
      return found;
    }
    close() {
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new OtaError("\u8FDE\u63A5\u5DF2\u7ED3\u675F"));
      }
      this.clear();
    }
  };
  var FrameChannel = class {
    constructor(transport) {
      this.transport = transport;
      this.decoder = new StreamDecoder();
      this.inbox = new Inbox();
      this.seq = 57344;
      this.off = transport.on("data", ({ bytes, kind }) => {
        if (kind !== "ctrl") for (const f of this.decoder.feed(bytes)) this.inbox.push(f);
      });
    }
    async request(command, payload, timeoutMs = 6e3) {
      const seq = this.seq++;
      await this.transport.write(encodeFrame(command, seq, payload));
      return this.inbox.next((f) => f.command === (command | 128) && f.sequence === seq, timeoutMs);
    }
    async raw(command, op, timeoutMs = 8e3) {
      await this.transport.write(Uint8Array.of(255, 255, op));
      return this.inbox.next((f) => f.command === (command | 128) && f.sequence === 0, timeoutMs);
    }
    release() {
      this.off();
      this.inbox.close();
    }
  };
  function validateFirmwareImage(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes[0] !== 233) throw new OtaError("\u8BF7\u9009\u62E9 ESP32 \u5E94\u7528\u56FA\u4EF6 .bin\uFF0C\u4E0D\u80FD\u4F7F\u7528\u7A7A\u6587\u4EF6\u6216\u5408\u5E76\u70E7\u5F55\u6587\u4EF6");
    if ((bytes[12] | bytes[13] << 8) !== 13) throw new OtaError("\u56FA\u4EF6\u82AF\u7247\u578B\u53F7\u4E0D\u662F ESP32-C6");
    if (bytes.length > 1966080) throw new OtaError("\u56FA\u4EF6\u8D85\u8FC7\u8BBE\u5907 OTA \u5206\u533A\u5BB9\u91CF\uFF081920 KB\uFF09");
  }
  async function runWireOta(options) {
    var _a;
    const { transport, bytes, channel, onLog = () => {
    }, onProgress, onPhase = () => {
    } } = options;
    if (!["ble", "serial"].includes(channel) || !(bytes == null ? void 0 : bytes.length)) throw new OtaError("\u5347\u7EA7\u901A\u9053\u6216\u56FA\u4EF6\u65E0\u6548");
    let chunk = options.chunkSize ?? (channel === "ble" ? OTA_MAX_CHUNK : SERIAL_CHUNK);
    let packets = Math.ceil(bytes.length / chunk);
    if (chunk < 1 || chunk > 244 || packets >= 65535) throw new OtaError("\u56FA\u4EF6\u5305\u6570\u6216\u5206\u5305\u957F\u5EA6\u8D85\u9650");
    let gap = options.packetGapMs ?? (channel === "ble" ? BLE_PACKET_GAP_MS : SERIAL_PACKET_GAP_MS);
    let serialBurst = false;
    const timeout = options.ackTimeoutMs ?? 6e3;
    const frames = new FrameChannel(transport), ackInbox = new Inbox();
    const off = transport.on("data", ({ bytes: bytes2, kind }) => {
      if (kind === "ctrl") {
        const ack = parseBleOtaAck(bytes2);
        if (ack) ackInbox.push(ack);
      }
    });
    let started = false;
    let phase = "preparing";
    const updatePhase = (value) => {
      phase = value;
      onPhase(value);
    };
    const startAt = Date.now();
    const stats = { dataPackets: 0, retransmittedPackets: 0, nacks: 0, timeouts: 0, writeMs: 0, ackWaitMs: 0, writeCalls: 0 };
    let highestSent = 0;
    let ackWindow = ACK_WINDOW;
    const progress = (sent, transferred = sent) => onProgress == null ? void 0 : onProgress({ sent, transferred, total: bytes.length, percent: Math.floor(sent * 100 / bytes.length), detail: `${(transferred / 1024).toFixed(1)} / ${(bytes.length / 1024).toFixed(1)} KB` });
    const prefix = (ack) => ack.ok ? ack.seq + 1 : ack.seq;
    const ackMatches = (ack, begin, end) => !ack.ok && ack.seq === 65535 || (ack.ok ? ack.seq >= begin && ack.seq < end : ack.seq >= begin && ack.seq <= end);
    const takeAcks = (match) => channel === "ble" ? ackInbox.takeAll(match) : frames.inbox.takeAll((f) => f.command === Command.OTA_ACK && match(unpackOtaAck(f.payload))).map((f) => unpackOtaAck(f.payload));
    const waitAck = async (begin, end) => {
      const match = (ack) => ackMatches(ack, begin, end);
      const first = channel === "ble" ? await ackInbox.next(match, timeout) : unpackOtaAck((await frames.inbox.next((f) => f.command === Command.OTA_ACK && match(unpackOtaAck(f.payload)), timeout)).payload);
      if (!first.ok && first.seq !== 65535) await sleep(options.nackSettleMs ?? Math.min(250, timeout));
      const acks = [first, ...takeAcks(match)];
      if (acks.some((a) => !a.ok && a.seq === 65535)) throw new OtaError("\u8BBE\u5907\u5199\u5165 Flash \u5931\u8D25\uFF0C\u5347\u7EA7\u5DF2\u4E2D\u6B62");
      return acks.reduce((best, a) => prefix(a) > prefix(best) || prefix(a) === prefix(best) && a.ok ? a : best);
    };
    try {
      updatePhase("preparing");
      onLog(`\u5F00\u59CB${channel === "ble" ? "\u84DD\u7259" : "\u4E32\u53E3"}\u5347\u7EA7\uFF1A${bytes.length} \u5B57\u8282`);
      progress(0);
      const stopped = await frames.request(Command.SET_STREAM, Uint8Array.of(0, 100, 0), timeout);
      if (stopped.payload[0] !== 0) throw new OtaError("\u8BBE\u5907\u62D2\u7EDD\u505C\u6B62\u5B9E\u65F6\u6D41");
      started = true;
      if (channel === "ble") {
        if (typeof transport.prepareOtaData === "function") {
          onLog("\u68C0\u6D4B\u84DD\u7259\u5355\u5305\u957F\u5EA6\u4E0E\u5199\u5165\u6A21\u5F0F\u2026");
          await transport.writeControl(buildBleOtaControl(BLE_OTA.ABORT));
          const stopped2 = await ackInbox.next((a) => a.seq === 0, timeout);
          if (!stopped2.ok) throw new OtaError("\u8BBE\u5907\u672A\u786E\u8BA4\u505C\u6B62\u65E7\u5347\u7EA7\u4F1A\u8BDD");
          if (stopped2.fastWindow === BLE_FAST_ACK_WINDOW && options.preferFastBle !== false)
            ackWindow = BLE_FAST_ACK_WINDOW;
          ackInbox.clear();
          chunk = await transport.prepareOtaData(chunk);
          if (!Number.isInteger(chunk) || chunk < 1 || chunk > OTA_MAX_CHUNK) throw new OtaError("\u84DD\u7259\u534F\u5546\u5305\u957F\u65E0\u6548");
          packets = Math.ceil(bytes.length / chunk);
          if (packets >= 65535) throw new OtaError("\u84DD\u7259\u534F\u5546\u5305\u957F\u5BFC\u81F4\u5305\u6570\u8D85\u9650");
          onLog(`\u84DD\u7259\u6570\u636E\u6A21\u5F0F\uFF1A${transport.otaWriteMode}\uFF0C\u56FA\u4EF6\u8F7D\u8377 ${chunk} \u5B57\u8282/\u5305\uFF0C\u5171 ${packets} \u5305`);
        }
        onLog(`\u84DD\u7259\u786E\u8BA4\u7A97\u53E3\uFF1A${ackWindow} \u5305${ackWindow === ACK_WINDOW ? "\uFF08\u517C\u5BB9\u6A21\u5F0F\uFF09" : "\uFF08\u9AD8\u901F\u6A21\u5F0F\uFF09"}`);
        await transport.writeControl(buildBleOtaStart(bytes.length, chunk, ackWindow === BLE_FAST_ACK_WINDOW));
        const ack = await ackInbox.next((a) => a.seq === 0, timeout);
        if (!ack.ok) throw new OtaError("\u8BBE\u5907\u62D2\u7EDD START\uFF08\u8BF7\u786E\u8BA4\u914D\u5957\u56FA\u4EF6\u53CA OTA \u5206\u533A\uFF09");
      } else {
        const n = bytes.length;
        const frame = await frames.request(Command.OTA_START, Uint8Array.of(n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255, chunk >> 8, chunk & 255), timeout);
        if (frame.payload[0] !== 0) throw new OtaError("\u8BBE\u5907\u62D2\u7EDD START\uFF0Cstatus=" + frame.payload[0]);
        serialBurst = serialOtaBurstSupported(frame.payload) && options.preferFastSerial !== false && (options.packetGapMs === void 0 || options.packetGapMs === 0);
        if (serialBurst) gap = 0;
        onLog(serialBurst ? "\u4E32\u53E3\u9AD8\u901F\u6A21\u5F0F\uFF1A\u6BCF 10 \u5305\u5408\u5E76\u5199\u5165\uFF0C\u6309\u8BBE\u5907 ACK \u6D41\u63A7\uFF0C\u65E0\u9010\u5305\u5EF6\u65F6" : `\u4E32\u53E3\u517C\u5BB9\u6A21\u5F0F\uFF1A\u9010\u5305\u5199\u5165\uFF0C\u5305\u95F4\u9694 ${gap}ms`);
      }
      started = true;
      onLog("START \u5DF2\u786E\u8BA4\uFF0C\u5F00\u59CB\u53D1\u9001\u6570\u636E");
      updatePhase("sending");
      let seq = 0, nextToSend = 0, retries = 0;
      while (seq < packets) {
        const begin = seq, end = Math.min(seq + ackWindow, packets);
        takeAcks((a) => a.seq !== 65535 && prefix(a) <= begin);
        const burst = serialBurst ? new Uint8Array((end - nextToSend) * (chunk + 2)) : null;
        for (let i = nextToSend; i < end; i++) {
          const piece = new Uint8Array(chunk).fill(255);
          piece.set(bytes.subarray(i * chunk, Math.min((i + 1) * chunk, bytes.length)));
          const packet = buildOtaDataPacket(i, piece);
          const writeAt = performance.now();
          if (burst) burst.set(packet, (i - nextToSend) * (chunk + 2));
          else {
            if (channel === "ble") await transport.writeData(packet);
            else await transport.write(packet);
            stats.writeCalls++;
          }
          stats.writeMs += performance.now() - writeAt;
          stats.dataPackets++;
          if (i < highestSent) stats.retransmittedPackets++;
          highestSent = Math.max(highestSent, i + 1);
          if (gap) await sleep(gap);
        }
        if (burst == null ? void 0 : burst.length) {
          const writeAt = performance.now();
          await transport.write(burst);
          stats.writeMs += performance.now() - writeAt;
          stats.writeCalls++;
        }
        nextToSend = end;
        try {
          const ackAt = performance.now();
          const ack = await waitAck(begin, end);
          stats.ackWaitMs += performance.now() - ackAt;
          seq = ack.ok ? ack.seq + 1 : ack.seq;
          if (!ack.ok) nextToSend = seq;
          if (seq <= begin) {
            if (++retries > 8) throw new OtaError("\u8BBE\u5907\u91CD\u590D\u62D2\u7EDD\u540C\u4E00\u7A97\u53E3");
          } else retries = 0;
          if (!ack.ok) {
            stats.nacks++;
            onLog("\u8BBE\u5907\u8BF7\u6C42\u4ECE seq=" + seq + " \u91CD\u4F20");
          }
          progress(Math.min(seq * chunk, bytes.length - 1), Math.min(seq * chunk, bytes.length));
        } catch (error) {
          if (error.message.includes("\u5199\u5165 Flash \u5931\u8D25")) throw error;
          stats.timeouts++;
          if (++retries > 8) throw new OtaError("\u7A97\u53E3\u8FDE\u7EED\u5931\u8D25\uFF1A" + error.message);
          onLog("\u7A97\u53E3\u5E94\u7B54\u672A\u786E\u8BA4\uFF0C\u91CD\u4F20 seq=" + begin);
          seq = begin;
          nextToSend = begin;
        }
      }
      updatePhase("validating");
      (_a = options.onStats) == null ? void 0 : _a.call(options, { ...stats, ackWindow, serialBurst });
      if (channel === "ble" && transport.otaWriteMode) onLog(`\u672C\u6B21\u84DD\u7259\u6570\u636E\u5199\u5165\uFF1A${transport.otaWriteMode}`);
      onLog(`\u4F20\u8F93\u7EDF\u8BA1\uFF1A\u53D1\u9001 ${stats.dataPackets} \u5305\uFF0C\u91CD\u4F20 ${stats.retransmittedPackets} \u5305\uFF0CNACK ${stats.nacks} \u6B21\uFF0C\u8D85\u65F6 ${stats.timeouts} \u6B21\uFF1B\u5199\u5305\u7D2F\u8BA1 ${(stats.writeMs / 1e3).toFixed(1)} \u79D2\uFF0C\u7B49\u5F85\u7A97\u53E3\u786E\u8BA4 ${(stats.ackWaitMs / 1e3).toFixed(1)} \u79D2`);
      ackInbox.clear();
      if (channel === "ble") {
        await transport.writeControl(buildBleOtaControl(BLE_OTA.END));
        const ack = await ackInbox.next((a) => a.seq === 0, timeout);
        if (!ack.ok) throw new OtaError("\u8BBE\u5907\u6821\u9A8C\u56FA\u4EF6\u5931\u8D25\uFF0C\u672A\u5207\u6362\u542F\u52A8\u5206\u533A");
      } else {
        const frame = await frames.raw(Command.OTA_END, BLE_OTA.END, timeout);
        if (frame.payload[0] !== 0) throw new OtaError("\u8BBE\u5907\u6821\u9A8C\u56FA\u4EF6\u5931\u8D25\uFF0C\u672A\u5207\u6362\u542F\u52A8\u5206\u533A");
      }
      progress(bytes.length);
      onLog(`\u4F20\u8F93\u5B8C\u6210\uFF0C\u8BBE\u5907\u5DF2\u786E\u8BA4\u6821\u9A8C\u901A\u8FC7\uFF0C\u5373\u5C06\u91CD\u542F\uFF08${((Date.now() - startAt) / 1e3).toFixed(1)}s\uFF09\u3002\u8BF7\u91CD\u8FDE\u6838\u5BF9\u7248\u672C\u3002`);
    } catch (error) {
      error.otaResultUnknown = phase === "validating" && !error.message.includes("\u8BBE\u5907\u6821\u9A8C\u56FA\u4EF6\u5931\u8D25");
      onLog((error.otaResultUnknown ? "\u672A\u6536\u5230\u6700\u7EC8\u6821\u9A8C\u786E\u8BA4\uFF0C\u7ED3\u679C\u5F85\u6838\u5BF9\uFF1A" : "\u5347\u7EA7\u5931\u8D25\uFF1A") + error.message);
      if (started) {
        try {
          if (channel === "ble") await transport.writeControl(buildBleOtaControl(BLE_OTA.ABORT));
          else await frames.raw(Command.OTA_ABORT, BLE_OTA.ABORT, 1500);
        } catch {
          onLog("ABORT \u672A\u786E\u8BA4\uFF1B\u8BBE\u5907\u901A\u4FE1\u6062\u590D\u540E\u518D\u91CD\u8BD5");
        }
      }
      throw error;
    } finally {
      off();
      ackInbox.close();
      frames.release();
    }
  }
  async function requestApMode(transport) {
    const frames = new FrameChannel(transport);
    try {
      return (await frames.request(Command.OTA_ENTER_AP, new Uint8Array(), 6e3)).payload[0] === 0;
    } finally {
      frames.release();
    }
  }
  function startApProbe(onState, onReady, timeoutMs = 3e5, onTimeout = () => {
  }) {
    let stopped = false, timer, request;
    const start = Date.now();
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      request == null ? void 0 : request.abort();
    };
    const probe = async () => {
      if (stopped) return;
      if (Date.now() - start > timeoutMs) {
        stop();
        onState("\u7B49\u5F85\u70ED\u70B9\u8D85\u65F6\uFF0C\u8BF7\u8FDE\u63A5 LEBREW-AW \u540E\u91CD\u8BD5\u4E0A\u4F20");
        onTimeout();
        return;
      }
      request = new AbortController();
      const abort = setTimeout(() => request.abort(), 1500);
      try {
        const response = await fetch(AP_DEVICE_URL + "/info", { mode: "cors", cache: "no-store", signal: request.signal });
        const info = await response.json();
        if (!response.ok || info.device !== "LEBREW-AW" || info.ota !== true) throw new Error("not our device");
        if (!stopped) {
          stop();
          await onReady();
        }
        return;
      } catch {
      } finally {
        clearTimeout(abort);
      }
      if (!stopped) timer = setTimeout(probe, 2e3);
    };
    onState("\u8BF7\u4F7F\u7528\u8BBE\u5907\u914D\u5957\u5BC6\u7801\u8FDE\u63A5 LEBREW-AW\uFF0C\u5E76\u5141\u8BB8\u6D4F\u89C8\u5668\u8BBF\u95EE\u672C\u5730\u7F51\u7EDC\u3002");
    timer = setTimeout(probe, 1e3);
    return stop;
  }
  function uploadToFirmware(bytes, onProgress) {
    validateFirmwareImage(bytes);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", AP_DEVICE_URL + "/ota");
      xhr.timeout = 18e4;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress == null ? void 0 : onProgress(e.loaded, e.total);
      };
      xhr.onload = () => xhr.status === 200 && xhr.responseText.startsWith("OK") ? resolve() : reject(new OtaError("HTTP " + xhr.status + " " + xhr.responseText.slice(0, 120)));
      xhr.onerror = () => reject(new OtaError("\u4E0A\u4F20\u5931\u8D25\uFF1A\u8BF7\u8FDE\u63A5 LEBREW-AW\uFF0C\u5E76\u5141\u8BB8\u6D4F\u89C8\u5668\u8BBF\u95EE\u672C\u5730\u7F51\u7EDC\uFF1B\u4E5F\u53EF\u76F4\u63A5\u6253\u5F00\u8BBE\u5907\u5347\u7EA7\u9875\u3002"));
      xhr.ontimeout = () => reject(new OtaError("\u70ED\u70B9\u4E0A\u4F20\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5"));
      xhr.send(bytes);
    });
  }

  // ota_status.js
  var OTA_RESULT_KEY = "aw_ota_result_v1";
  var ACTIVE = ["preparing", "sending", "validating", "waiting_ap"];
  function firmwareIdentity(bytes) {
    if (bytes.length < 288 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(32, true) !== 2882360370) {
      return { version: "", sha256: "" };
    }
    const text = new TextDecoder().decode(bytes.subarray(48, 80)).split("\0")[0];
    const sha256 = Array.from(bytes.subarray(176, 208), (b) => b.toString(16).padStart(2, "0")).join("");
    return { version: text, sha256: /^0+$/.test(sha256) ? "" : sha256 };
  }
  var OtaResult = class {
    constructor(storage, clock = () => Date.now()) {
      this.storage = storage;
      this.clock = clock;
      this.lastSave = 0;
      this.value = { phase: "idle", percent: 0 };
      try {
        const saved = JSON.parse((storage == null ? void 0 : storage.getItem(OTA_RESULT_KEY)) || "null");
        if (saved && typeof saved.phase === "string") this.value = saved;
      } catch {
      }
      if (ACTIVE.includes(this.value.phase)) this.set("unconfirmed", "\u9875\u9762\u5728\u5347\u7EA7\u671F\u95F4\u88AB\u5237\u65B0\uFF0C\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\u3002\u8BF7\u91CD\u8FDE\u8BBE\u5907\u540E\u6838\u5BF9\u56FA\u4EF6\u3002");
      else if (this.value.phase === "verifying" || this.value.phase === "restarting") this.set("awaiting_reconnect", "\u5199\u5165\u5DF2\u6210\u529F\uFF0C\u8BF7\u8FDE\u63A5\u8BBE\u5907\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6\u3002");
    }
    save(force = false) {
      var _a;
      if (!force && this.clock() - this.lastSave < 1e3) return;
      this.lastSave = this.clock();
      try {
        (_a = this.storage) == null ? void 0 : _a.setItem(OTA_RESULT_KEY, JSON.stringify(this.value));
      } catch {
      }
    }
    start(file, channel, bytes) {
      this.value = {
        phase: "preparing",
        percent: 0,
        fileName: file,
        channel,
        ...firmwareIdentity(bytes),
        startedAt: this.clock(),
        writeConfirmed: false,
        detail: "\u6B63\u5728\u8BF7\u6C42\u8BBE\u5907\u5F00\u59CB\u5347\u7EA7\uFF0C\u8BF7\u4FDD\u6301\u4F9B\u7535\u3002"
      };
      this.save(true);
    }
    set(phase, detail) {
      this.value = { ...this.value, phase, detail };
      this.save(true);
    }
    progress(percent, detail) {
      this.value.percent = Math.min(99, Math.max(0, Math.floor(percent)));
      this.value.detail = detail;
      this.save();
    }
    confirmed() {
      this.value = { ...this.value, percent: 100, writeConfirmed: true, confirmedAt: this.clock() };
      this.set("restarting", "\u8BBE\u5907\u5DF2\u786E\u8BA4\u56FA\u4EF6\u6821\u9A8C\u901A\u8FC7\u3002\u7B49\u5F85\u91CD\u542F\u540E\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u4EE5\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6\u3002");
    }
    get canVerify() {
      return ["restarting", "awaiting_reconnect", "verifying", "unconfirmed", "mismatch"].includes(this.value.phase);
    }
    disconnected() {
      if (this.value.writeConfirmed && this.canVerify) this.set("awaiting_reconnect", "\u5DF2\u65AD\u5F00\uFF0C\u7B49\u5F85\u8BBE\u5907\u91CD\u542F\u3002\u8BF7\u70B9\u51FB\u8FDE\u63A5\u84DD\u7259\u6216\u8FDE\u63A5\u4E32\u53E3\uFF0C\u7CFB\u7EDF\u5C06\u81EA\u52A8\u6838\u5BF9\u56FA\u4EF6\u3002");
    }
    verify(identity) {
      if (!this.canVerify) return false;
      this.value.actualSha256 = identity.sha256;
      if (!this.value.sha256) {
        this.set("unconfirmed", "\u6240\u9009\u6587\u4EF6\u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u56FA\u4EF6\u6307\u7EB9\uFF0C\u65E0\u6CD5\u81EA\u52A8\u786E\u8BA4\uFF1B\u8BF7\u6838\u5BF9\u8BBE\u5907\u7248\u672C\u3002");
        return false;
      }
      if (identity.sha256 !== this.value.sha256) {
        this.set("mismatch", "\u8BBE\u5907\u8FD0\u884C\u7684\u56FA\u4EF6\u4E0E\u6240\u9009\u6587\u4EF6\u4E0D\u4E00\u81F4\u3002\u8BF7\u786E\u8BA4\u8FDE\u63A5\u7684\u662F\u76EE\u6807\u8BBE\u5907\uFF0C\u518D\u91CD\u65B0\u5347\u7EA7\u3002");
        return false;
      }
      this.value.percent = 100;
      this.value.completedAt = this.clock();
      this.value.uptimeMs = identity.uptimeMs;
      this.set("completed", this.value.verifyOnly ? "\u8BBE\u5907\u5F53\u524D\u8FD0\u884C\u7684\u56FA\u4EF6\u4E0E\u6240\u9009\u6587\u4EF6\u4E00\u81F4\uFF0C\u65E0\u9700\u91CD\u590D\u5347\u7EA7\u3002" : "\u8FD0\u884C\u56FA\u4EF6\u6307\u7EB9\u4E0E\u6240\u9009\u6587\u4EF6\u4E00\u81F4\uFF0C\u5347\u7EA7\u5DF2\u5B8C\u6210\u3002\u53EF\u4EE5\u6B63\u5E38\u4F7F\u7528\u8BBE\u5907\u3002");
      return true;
    }
  };
  function otaPresentation(result) {
    const titles = {
      idle: "\u5C1A\u672A\u5F00\u59CB\u5347\u7EA7",
      preparing: "\u51C6\u5907\u5347\u7EA7\u2026",
      sending: "\u6B63\u5728\u4F20\u8F93\u56FA\u4EF6\u2026",
      validating: "\u4F20\u8F93\u5B8C\u6210\uFF0C\u6B63\u5728\u6821\u9A8C\u2026",
      waiting_ap: "\u7B49\u5F85\u8FDE\u63A5\u8BBE\u5907\u70ED\u70B9\u2026",
      restarting: "\u5199\u5165\u6210\u529F\uFF0C\u7B49\u5F85\u8BBE\u5907\u91CD\u542F",
      awaiting_reconnect: "\u5199\u5165\u6210\u529F\uFF0C\u8BF7\u91CD\u8FDE\u786E\u8BA4",
      verifying: "\u6B63\u5728\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6\u2026",
      completed: "\u2713 \u5347\u7EA7\u5B8C\u6210\uFF0C\u56FA\u4EF6\u5DF2\u6838\u5BF9",
      failed: "\u2715 \u5347\u7EA7\u5931\u8D25",
      mismatch: "\u2715 \u8FD0\u884C\u56FA\u4EF6\u4E0D\u4E00\u81F4",
      unconfirmed: "\u7ED3\u679C\u5F85\u786E\u8BA4",
      cancelled: "\u5DF2\u505C\u6B62\u7B49\u5F85\u70ED\u70B9",
      mock_completed: "\u6A21\u62DF\u6F14\u7EC3\u5B8C\u6210\uFF08\u672A\u70E7\u5F55\u8BBE\u5907\uFF09"
    };
    const tone = result.phase === "completed" ? "success" : ["failed", "mismatch"].includes(result.phase) ? "error" : ["restarting", "awaiting_reconnect", "unconfirmed", "cancelled"].includes(result.phase) ? "warn" : "info";
    return { title: result.phase === "completed" && result.verifyOnly ? "\u2713 \u5F53\u524D\u56FA\u4EF6\u5DF2\u6838\u5BF9" : titles[result.phase] ?? "\u7ED3\u679C\u5F85\u786E\u8BA4", tone };
  }

  // ota_rate.js
  var OtaTransferRate = class {
    constructor(totalBytes, clock = () => performance.now()) {
      this.clock = clock;
      this.totalBytes = totalBytes;
      this.startedAt = this.lastNow = clock();
      this.sent = 0;
      this.samples = [{ time: this.startedAt, sent: 0 }];
      this.active = true;
      this.simulated = false;
    }
    now() {
      this.lastNow = Math.max(this.lastNow, this.clock());
      return this.lastNow;
    }
    update(sent) {
      if (!this.active || !Number.isFinite(sent)) return;
      const time = this.now();
      this.sent = Math.max(this.sent, Math.min(this.totalBytes, Math.max(0, sent)));
      this.samples.push({ time, sent: this.sent });
      this.prune(time);
    }
    prune(time) {
      const cutoff = time - 1500;
      while (this.samples.length > 2 && this.samples[1].time <= cutoff) this.samples.shift();
    }
    snapshot() {
      const time = this.active ? this.now() : this.endedAt;
      this.prune(time);
      const elapsedMs = Math.max(0, time - this.startedAt);
      const cutoff = Math.max(this.startedAt, time - 1500);
      let baseline = this.samples[0].sent;
      for (let i = 0; i < this.samples.length; i++) {
        const a = this.samples[i], b = this.samples[i + 1];
        if (a.time > cutoff) break;
        baseline = a.sent;
        if (b && b.time > cutoff && b.time > a.time) {
          baseline += (b.sent - a.sent) * (cutoff - a.time) / (b.time - a.time);
          break;
        }
      }
      const windowMs = time - cutoff;
      return {
        sent: this.sent,
        totalBytes: this.totalBytes,
        elapsedMs,
        currentBps: this.active && windowMs > 0 ? Math.max(0, (this.sent - baseline) * 1e3 / windowMs) : 0,
        averageBps: elapsedMs > 0 ? this.sent * 1e3 / elapsedMs : 0,
        finished: !this.active,
        simulated: this.simulated
      };
    }
    stop() {
      if (this.active) {
        this.endedAt = this.now();
        this.active = false;
      }
      return this.snapshot();
    }
  };
  function formatTransferRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return "--";
    if (bytesPerSecond >= 1024 * 1024) return (bytesPerSecond / (1024 * 1024)).toFixed(2) + " MB/s";
    if (bytesPerSecond >= 1024) return (bytesPerSecond / 1024).toFixed(1) + " KB/s";
    return Math.round(bytesPerSecond) + " B/s";
  }

  // md_telemetry.js
  function mdValues(sample) {
    const valid = (mask, value) => sample && (sample.flags & mask) === mask && Number.isFinite(value) ? value : null;
    const knownBean = sample && BEAN_LABELS[sample.beanId] != null;
    const empty = valid(8, sample == null ? void 0 : sample.emptyCapacitancePf);
    const emptyCapacitancePf = empty > 0 ? empty : null;
    return {
      beanName: sample ? BEAN_LABELS[sample.beanId] ?? `\u672A\u77E5\u8C46\u79CD (${sample.beanId})` : "\u7B49\u5F85\u8BBE\u5907",
      moisturePct: knownBean ? valid(4, sample.moisturePct) : null,
      densityGl: valid(2, sample == null ? void 0 : sample.densityGl),
      capacitancePf: valid(1, sample == null ? void 0 : sample.capacitancePf),
      weightAdc: valid(2, sample == null ? void 0 : sample.weightAdc),
      weightG: valid(2, sample == null ? void 0 : sample.weightG),
      emptyCapacitancePf,
      deltaCapacitancePf: emptyCapacitancePf == null ? null : valid(9, sample == null ? void 0 : sample.deltaCapacitancePf)
    };
  }
  function mdCsvCells(sample) {
    const v = mdValues(sample);
    return [
      sample.beanId,
      v.beanName,
      v.moisturePct,
      v.densityGl,
      v.capacitancePf,
      v.weightAdc,
      v.weightG,
      v.emptyCapacitancePf,
      v.deltaCapacitancePf
    ];
  }
  var MOISTURE_CSV_COLUMNS = Object.freeze([
    "timestamp",
    "device_id",
    "sample_sequence",
    "flags",
    "bean_id",
    "bean_name",
    "moisture_device_pct",
    "density_g_l",
    "capacitance_raw_pf",
    "weight_raw_adc",
    "weight_g",
    "capacitance_empty_pf",
    "delta_capacitance_pf",
    "reference_moisture_pct"
  ]);
  function moistureCsv(samples, deviceId) {
    const escape = (value) => {
      const text = value == null ? "" : String(value);
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const rows = [MOISTURE_CSV_COLUMNS.join(",")];
    for (const sample of samples) {
      const cells = [
        sample.timestamp,
        deviceId,
        sample.sampleSequence,
        sample.flags,
        ...mdCsvCells(sample),
        ""
      ];
      rows.push(cells.map(escape).join(","));
    }
    return rows.join("\r\n");
  }

  // serial_reconnect.js
  async function connectAuthorizedSerial(expectedId, { serial = ((_a) => (_a = globalThis.navigator) == null ? void 0 : _a.serial)(), timeoutMs = 2500 } = {}) {
    if (!(serial == null ? void 0 : serial.getPorts)) return null;
    const ports = (await serial.getPorts()).filter((p) => {
      const i = p.getInfo();
      return i.usbVendorId === 12346 && i.usbProductId === 4097;
    });
    for (const port of ports) {
      const transport = new SerialTransport({ name: "SERIAL", serial, presetPort: port, bufferSize: 16384 });
      let keep = false;
      try {
        await transport.connect();
        try {
          await port.setSignals({ dataTerminalReady: false, requestToSend: false, breakpoint: false });
        } catch {
        }
        const decoder = new StreamDecoder();
        let off, timer;
        const info = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("\u8BBE\u5907\u8EAB\u4EFD\u8BFB\u53D6\u8D85\u65F6")), timeoutMs);
          off = transport.on("data", ({ bytes }) => {
            for (const frame of decoder.feed(bytes)) if (frame.command === (Command.GET_INFO | 128) && frame.sequence === 57648) {
              try {
                if (frame.payload[0] !== 0) throw new Error("\u8BBE\u5907\u8EAB\u4EFD\u67E5\u8BE2\u5931\u8D25");
                resolve(unpackDeviceInfo(frame.payload));
              } catch (error) {
                reject(error);
              }
            }
          });
          transport.write(encodeFrame(Command.GET_INFO, 57648, new Uint8Array())).catch(reject);
        }).finally(() => {
          clearTimeout(timer);
          off == null ? void 0 : off();
        });
        if (expectedId ? info.deviceId === expectedId : /^LBDT01/.test(info.deviceId)) {
          keep = true;
          return transport;
        }
      } catch {
      } finally {
        if (!keep) await transport.disconnect();
      }
    }
    return null;
  }

  // app.js
  var $ = (id) => document.getElementById(id);
  var HOST_VERSION = "1.1.27-web";
  window.__awVersion = HOST_VERSION;
  document.getElementById("hostVersion").textContent = `\u4E0A\u4F4D\u673A v${HOST_VERSION}`;
  var MASTER_STORAGE_KEY = "aw_master_profile_v1";
  var CAPTURE_RUNS_STORAGE_KEY = "aw_required_runs_per_point_v1";
  var state = {
    mock: false,
    controller: null,
    ble: null,
    serial: null,
    sim: null,
    activeTransport: null,
    // 'ble' | 'serial' | 'sim'
    otaBusy: false,
    heartbeatOk: false,
    telemetryOn: true,
    chartPaused: false,
    selectedFit: null,
    // 'endpoint' | 'least_squares'
    autoRetryTimer: null,
    masterRh: [...DEFAULT_MASTER_RH],
    params: null,
    requiredRunsPerPoint: 3,
    sn: null,
    snBusy: false,
    snExpected: null,
    deviceControl: null,
    deviceSupported: null,
    devicePending: false,
    deviceUnconfirmed: false,
    deviceError: "",
    calDialogAction: null,
    deviceLanguageEdited: false,
    deviceStandbyEdited: false,
    deviceApplyAction: null,
    deviceApplyValue: null,
    measure: null,
    measureSupported: null,
    measurePending: false,
    measureError: "",
    measureBeanEdited: false,
    measureUnconfirmed: false
  };
  function ensureController() {
    if (state.controller) return state.controller;
    const controller = new CalibrationController({
      masterProfileRh: state.masterRh,
      requiredRunsPerPoint: state.requiredRunsPerPoint
    });
    controller.on("connected", onConnected);
    controller.on("disconnected", onDisconnected);
    controller.on("info", ({ data }) => {
      $("devId").textContent = data.deviceId || "(\u7A7A)";
      if (state.activeTransport === "serial" && data.deviceId) {
        try {
          localStorage.setItem("aw_last_serial_device", data.deviceId);
          localStorage.setItem("aw_serial_auto", "1");
        } catch {
        }
      }
      $("devFw").textContent = data.firmwareVersion || "--";
      setDeviceInfo(`${data.deviceId || "\u672A\u547D\u540D"} \xB7 ${data.firmwareVersion || ""}`);
    });
    controller.on("firmware_identity", ({ data }) => {
      if (!otaResult.canVerify) return;
      const matched = otaResult.verify(data);
      renderOtaStatus();
      otaLogLine(matched ? otaResult.value.verifyOnly ? "\u5F53\u524D\u56FA\u4EF6\u5DF2\u6838\u5BF9\uFF1A\u6307\u7EB9\u4E00\u81F4" : "\u5347\u7EA7\u5B8C\u6210\uFF1A\u8FD0\u884C\u56FA\u4EF6\u6307\u7EB9\u4E00\u81F4" : otaResult.value.detail);
      if (matched) banner(otaPresentation(otaResult.value).title, "ok");
    });
    controller.on("parameters", ({ data }) => applyParams(data));
    controller.on("sn", ({ data }) => {
      state.sn = data.sn;
      $("snExisting").textContent = data.sn || "\u672A\u5199\u5165";
      if (!state.snBusy) setSnStatus(data.sn ? "\u5DF2\u8BFB\u53D6\u8BBE\u5907 SN\uFF0C\u5199\u5165\u4FDD\u62A4\u5DF2\u542F\u7528\u3002" : "\u8BBE\u5907\u672A\u5199\u5165 SN\uFF0C\u8BF7\u6838\u5BF9\u5019\u9009\u53F7\u7801\u540E\u5199\u5165\u3002");
      refreshSnControls();
    });
    controller.on("sn_verified", ({ data }) => {
      state.snBusy = false;
      state.snExpected = null;
      setSnStatus((state.mock ? "\u6A21\u62DF\uFF1A" : "") + "SN \u5199\u5165\u5E76\u56DE\u8BFB\u6821\u9A8C\u901A\u8FC7\uFF1A" + data.sn, "ok");
      if (!state.mock) {
        const next = Number(data.sn.slice(13, 17)) + 1;
        try {
          localStorage.setItem(snCounterKey(), String(next));
        } catch {
        }
        if (next <= 9999) {
          $("snSequence").value = next;
          refreshSnCandidate();
        }
      }
      refreshSnControls();
    });
    controller.on("reset", ({ data }) => {
      applyParams(data);
      banner("\u53C2\u6570\u5DF2\u6062\u590D K=1 / B=0\uFF0C\u9732\u70B9\u6821\u51C6\u6807\u5FD7\u5DF2\u5931\u6548", "warn");
    });
    controller.on("write_verified", ({ data }) => {
      applyParams(data);
      banner("K/B \u5199\u5165\u6210\u529F\uFF0C\u56DE\u8BFB\u6821\u9A8C\u901A\u8FC7\u3002\u8BF7\u91CD\u65B0\u6267\u884C\u8BBE\u5907\u539F\u6709\u7684 0.753 \u6807\u51C6\u6DB2\u6821\u51C6\u3002", "warn");
    });
    controller.on("telemetry", ({ data }) => onTelemetry(data));
    controller.on("md_telemetry", ({ data }) => onMdTelemetry(data));
    controller.on("device_control", ({ data }) => {
      const previous = state.deviceControl;
      state.deviceControl = data;
      state.deviceSupported = true;
      if (data.operation === "device_control") state.devicePending = false;
      if (data.operation === "device_control" || state.deviceUnconfirmed || state.deviceErrorIsRead) state.deviceError = "";
      state.deviceErrorIsRead = false;
      state.deviceUnconfirmed = false;
      if (data.phase === 3 && data.action === state.deviceApplyAction && data.value === state.deviceApplyValue) {
        if (data.action === 1) state.deviceLanguageEdited = false;
        if (data.action === 2) state.deviceStandbyEdited = false;
        state.deviceApplyAction = null;
        state.deviceApplyValue = null;
      }
      if (!state.deviceLanguageEdited && !deviceControlActive(data) && document.activeElement !== $("deviceLanguage")) $("deviceLanguage").value = String(data.language);
      if (!state.deviceStandbyEdited && !deviceControlActive(data) && [3, 5, 10].includes(data.standbyMinutes) && document.activeElement !== $("deviceStandby")) $("deviceStandby").value = String(data.standbyMinutes);
      if (data.phase === 3 && data.action >= 3 && ((previous == null ? void 0 : previous.phase) !== 3 || (previous == null ? void 0 : previous.requestId) !== data.requestId)) state.controller.readParameters();
      refreshAll();
    });
    controller.on("measurement", ({ data }) => {
      state.measureSupported = true;
      state.measure = data;
      if (data.operation !== "read_measurement") state.measurePending = false;
      if (data.operation !== "read_measurement" || measurementActive(data) || state.measureUnconfirmed) state.measureError = "";
      state.measureUnconfirmed = false;
      if (data.operation === "select_bean") state.measureBeanEdited = false;
      if (!state.measureBeanEdited || measurementActive(data)) $("measureBean").value = String(data.beanId);
      refreshAll();
    });
    controller.on("capture_started", () => refreshCaptureUi());
    controller.on("capture_progress", ({ data }) => onCaptureProgress(data));
    controller.on("capture_result", ({ data }) => onCaptureResult(data));
    controller.on("report", ({ data }) => applyReport(data));
    controller.on("error", ({ message, data }) => {
      if (handleDeviceControlError(message, data)) return;
      if (handleMeasurementError(message, data)) return;
      if (["read_sn", "write_sn", "sn_readback"].includes(data == null ? void 0 : data.operation)) {
        state.snBusy = false;
        state.snExpected = null;
        state.sn = null;
        setSnStatus((data == null ? void 0 : data.status) === 1 ? "\u8BBE\u5907\u56FA\u4EF6\u5C1A\u4E0D\u652F\u6301 SN \u8BFB\u5199\uFF0C\u8BF7\u5347\u7EA7\u914D\u5957\u56FA\u4EF6\u3002" : (message || "SN \u64CD\u4F5C\u5931\u8D25") + "\uFF1B\u8BF7\u8BFB\u53D6 SN \u6838\u5B9E\u3002", "err");
        refreshSnControls();
        return;
      }
      if ((data == null ? void 0 : data.operation) === "read_firmware_identity") {
        if (otaResult.canVerify) {
          otaResult.set("unconfirmed", "\u672A\u80FD\u8BFB\u53D6\u56FA\u4EF6\u6307\u7EB9\u3002\u8BF7\u8FDE\u63A5\u914D\u5957\u56FA\u4EF6\u540E\u70B9\u51FB\u201C\u6838\u5BF9\u5347\u7EA7\u7ED3\u679C\u201D\uFF1B\u5F53\u524D\u4E0D\u80FD\u786E\u8BA4\u5347\u7EA7\u5B8C\u6210\u3002");
          renderOtaStatus();
        }
        return;
      }
      if ((data == null ? void 0 : data.operation) === "heartbeat" || (data == null ? void 0 : data.operation) === "transport") return;
      banner(message || JSON.stringify(data), "err");
    });
    controller.on("request_timeout", ({ message, data }) => {
      if (handleDeviceControlError(message, data, true)) return;
      if (handleMeasurementError(message, data, true)) return;
      if (["read_sn", "write_sn", "sn_readback"].includes(data == null ? void 0 : data.operation)) {
        state.snBusy = false;
        state.snExpected = null;
        state.sn = null;
        setSnStatus("SN \u64CD\u4F5C\u672A\u786E\u8BA4\uFF0C\u8BF7\u70B9\u51FB\u201C\u8BFB\u53D6 SN\u201D\u6838\u5B9E\uFF0C\u52FF\u66F4\u6362\u53F7\u7801\u91CD\u590D\u5199\u5165\u3002", "err");
        refreshSnControls();
        return;
      }
      if ((data == null ? void 0 : data.operation) === "read_firmware_identity") {
        if (otaResult.canVerify) {
          otaResult.set("unconfirmed", "\u8BBE\u5907\u5C1A\u672A\u5E94\u7B54\u56FA\u4EF6\u6838\u5BF9\u3002\u8BF7\u7B49\u8BBE\u5907\u91CD\u542F\u5B8C\u6210\u540E\u91CD\u8FDE\uFF0C\u518D\u70B9\u51FB\u201C\u6838\u5BF9\u5347\u7EA7\u7ED3\u679C\u201D\u3002");
          renderOtaStatus();
        }
        return;
      }
      banner(message, "err");
      if (state.activeTransport === "ble" && state.ble) {
        state.bleTimeoutStreak = (state.bleTimeoutStreak || 0) + 1;
        if (state.bleTimeoutStreak >= 2) {
          state.bleTimeoutStreak = 0;
          banner("\u84DD\u7259\u5DF2\u8FDE\u63A5\uFF0C\u4F46\u8BBE\u5907\u547D\u4EE4\u5E94\u7B54\u6301\u7EED\u8D85\u65F6\u3002\u8BF7\u6838\u5BF9\u8BBE\u5907\u56FA\u4EF6\u7248\u672C\u3002", "warn");
        }
      }
    });
    controller.on("request_retry", ({ message }) => banner(message, "warn"));
    controller.on("capture_recovering", ({ message }) => banner(message, "warn"));
    controller.on("diagnostic", ({ message }) => logDiag(message));
    controller.on("heartbeat", () => {
      state.heartbeatOk = true;
    });
    state.controller = controller;
    return controller;
  }
  async function connect(channel, { authorizedOnly = false, expectedId = null } = {}) {
    const controller = ensureController();
    state.connecting = true;
    refreshConnectButtons();
    try {
      let transport;
      if (state.mock) {
        transport = new SimTransport({ name: "SIM" });
        state.sim = transport;
        await transport.connect();
        state.activeTransport = "sim";
        controller.connectTransport(transport, { mode: "simulator" });
        return;
      }
      if (channel === "ble") {
        transport = new AwBleTransport();
        transport.on("log", ({ text }) => setDeviceInfo(text));
        await transport.connect();
        state.ble = transport;
        state.activeTransport = "ble";
        controller.connectTransport(transport, { mode: "ble" });
        return;
      }
      let remembered = expectedId;
      try {
        remembered ||= localStorage.getItem("aw_last_serial_device");
      } catch {
      }
      if (remembered || authorizedOnly) transport = await connectAuthorizedSerial(remembered);
      if (!transport) {
        if (authorizedOnly) throw new Error("\u672A\u627E\u5230\u5DF2\u6388\u6743\u4E14\u8EAB\u4EFD\u5339\u914D\u7684\u4E32\u53E3\u8BBE\u5907\uFF0C\u8BF7\u68C0\u67E5 USB \u8FDE\u63A5\u6216\u5176\u4ED6\u8F6F\u4EF6\u7684\u5360\u7528");
        transport = new SerialTransport({ name: "SERIAL", baudRate: 115200, bufferSize: 16384 });
        await transport.connect();
      }
      try {
        await transport.port.setSignals({ dataTerminalReady: false, requestToSend: false, breakpoint: false });
      } catch {
      }
      state.serial = transport;
      patchTransportLogging(transport, "serial");
      state.activeTransport = "serial";
      controller.connectTransport(transport, { mode: "serial" });
    } finally {
      state.connecting = false;
      refreshConnectButtons();
    }
  }
  function refreshConnectButtons() {
    const busy = !!(state.connecting || state.disconnecting || state.otaBusy);
    const busyText = state.otaBusy ? "\u5347\u7EA7\u4E2D\u2026" : state.disconnecting ? "\u65AD\u5F00\u4E2D\u2026" : "\u8FDE\u63A5\u4E2D\u2026";
    $("useMock").disabled = busy;
    const bleOn = state.activeTransport === "ble";
    $("btnBle").disabled = busy;
    $("btnBle").textContent = busy ? busyText : bleOn ? "\u65AD\u5F00\u84DD\u7259" : "\u8FDE\u63A5\u84DD\u7259";
    const serialOn = state.activeTransport === "serial" || state.activeTransport === "sim";
    $("btnSerial").disabled = busy;
    $("btnSerial").textContent = busy ? busyText : serialOn ? "\u65AD\u5F00\u4E32\u53E3" : "\u8FDE\u63A5\u4E32\u53E3";
  }
  function onConnected({ data }) {
    state.deviceControl = null;
    state.deviceSupported = null;
    state.devicePending = false;
    state.deviceUnconfirmed = false;
    state.deviceError = "";
    state.deviceLanguageEdited = false;
    state.deviceStandbyEdited = false;
    state.measure = null;
    state.measureSupported = null;
    state.measurePending = false;
    state.measureError = "";
    state.measureBeanEdited = false;
    state.measureUnconfirmed = false;
    state.sn = null;
    state.snBusy = false;
    state.snExpected = null;
    $("snExisting").textContent = "\u8BFB\u53D6\u4E2D\u2026";
    resetMdTelemetry("\u7B49\u5F85\u8BBE\u5907\u4E0A\u4F20\u6C34\u5206\u4E0E\u5BC6\u5EA6\uFF1B\u8C46\u79CD\u8DDF\u968F\u8BBE\u5907\u9009\u62E9\u3002");
    lastHeartbeatSentAt = -Infinity;
    $("chipBle").classList.toggle("on", data.mode === "ble");
    $("chipSerial").classList.toggle("on", data.mode === "serial" || data.mode === "simulator");
    refreshConnectButtons();
    setDeviceInfo(state.mock ? "\u6A21\u62DF\u8BBE\u5907\u5DF2\u8FDE\u63A5" : "\u5DF2\u8FDE\u63A5");
    state.bleTimeoutStreak = 0;
    state.controller.readInfo();
    state.controller.readSn();
    state.controller.readParameters();
    state.controller.readMeasurement();
    state.controller.readDeviceControl();
    refreshAll();
    if (otaResult.canVerify) scheduleOtaVerification();
  }
  function onDisconnected() {
    state.deviceControl = null;
    state.deviceSupported = null;
    state.devicePending = false;
    state.deviceUnconfirmed = false;
    state.deviceError = "";
    state.deviceLanguageEdited = false;
    state.deviceStandbyEdited = false;
    if ($("deviceCalDialog").open) $("deviceCalDialog").close();
    state.measure = null;
    state.measureSupported = null;
    state.measurePending = false;
    state.measureError = "";
    state.measureUnconfirmed = false;
    state.sn = null;
    state.snBusy = false;
    state.snExpected = null;
    $("snExisting").textContent = "\u672A\u8BFB\u53D6";
    setSnStatus("\u8BBE\u5907\u5DF2\u65AD\u5F00\uFF0C\u8FDE\u63A5\u540E\u91CD\u65B0\u8BFB\u53D6 SN\u3002");
    resetMdTelemetry("\u8BBE\u5907\u5DF2\u65AD\u5F00\uFF0C\u91CD\u65B0\u8FDE\u63A5\u540E\u66F4\u65B0\u3002");
    otaResult.disconnected();
    renderOtaStatus();
    state.activeTransport = null;
    $("chipBle").classList.remove("on");
    $("chipSerial").classList.remove("on");
    $("chipHb").classList.remove("on");
    refreshConnectButtons();
    setDeviceInfo("\u672A\u8FDE\u63A5");
    cancelAutoRetry();
    state.params = null;
    refreshAll();
  }
  async function disconnectAll() {
    var _a;
    if (state.disconnecting) return;
    state.disconnecting = true;
    refreshConnectButtons();
    try {
      if (state.activeTransport === "serial" && state.serial) {
        let timer;
        try {
          await Promise.race([
            state.serial.write(encodeFrame(Command.SET_STREAM, 65534, new Uint8Array([0, 100, 0]))),
            new Promise((resolve) => {
              timer = setTimeout(resolve, 500);
            })
          ]);
        } catch {
        } finally {
          clearTimeout(timer);
        }
      }
      await ((_a = state.controller) == null ? void 0 : _a.disconnect());
    } finally {
      state.ble = null;
      state.serial = null;
      state.sim = null;
      state.disconnecting = false;
      refreshConnectButtons();
    }
  }
  function deviceOperationLocked() {
    return state.devicePending || state.deviceUnconfirmed || deviceControlActive(state.deviceControl);
  }
  function handleDeviceControlError(message, data, timeout = false) {
    if (!["read_device_control", "device_control"].includes(data == null ? void 0 : data.operation)) return false;
    if (data.operation === "device_control") state.devicePending = false;
    if (timeout && data.operation === "device_control") state.deviceUnconfirmed = true;
    if (data.status === 1) {
      state.deviceSupported = false;
      state.deviceError = "\u6B64\u56FA\u4EF6\u5C1A\u4E0D\u652F\u6301\u8BBE\u5907\u8BBE\u7F6E\u4E0E\u6821\u51C6\uFF0C\u8BF7\u5347\u7EA7\u914D\u5957\u56FA\u4EF6\u3002";
    } else if (data.operation === "device_control" || !state.deviceControl) state.deviceError = timeout ? "\u64CD\u4F5C\u5E94\u7B54\u672A\u786E\u8BA4\uFF0C\u6B63\u5728\u56DE\u8BFB\u8BBE\u5907\u72B6\u6001\uFF1B\u8BF7\u52FF\u91CD\u590D\u6821\u51C6\u3002" : data.status === 4 ? "\u8BBE\u5907\u6B63\u5728\u6D4B\u91CF\u3001\u6821\u51C6\u6216\u5347\u7EA7\uFF0C\u8BF7\u7B49\u5F85\u3002" : data.status === 5 ? "\u6240\u9700\u4F20\u611F\u5668\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u5907\u3002" : message || "\u8BBE\u5907\u64CD\u4F5C\u5931\u8D25";
    state.deviceErrorIsRead = data.operation === "read_device_control";
    refreshAll();
    return true;
  }
  function refreshDeviceControls() {
    var _a, _b, _c;
    const connected = !!((_a = state.controller) == null ? void 0 : _a.isConnected);
    const busy = state.otaBusy || state.snBusy || captureState.active || measurementLocked() || ((_b = state.deviceControl) == null ? void 0 : _b.busy);
    const blocked = !connected || state.deviceSupported !== true || !((_c = state.deviceControl) == null ? void 0 : _c.ready) || busy;
    for (const id of ["deviceLanguage", "deviceStandby", "deviceApplyLanguage", "deviceApplyStandby", "deviceCalMd", "deviceCalAw"]) $(id).disabled = blocked;
    $("deviceRead").disabled = !connected || state.otaBusy;
    $("deviceControlStatus").textContent = !connected ? "\u8FDE\u63A5\u540E\u8BFB\u53D6\u8BBE\u5907\u8BED\u8A00\u4E0E\u5F85\u673A\u8BBE\u7F6E\u3002" : state.deviceError || deviceStatusText(state.deviceControl);
    $("deviceCalConfirm").disabled = blocked;
  }
  function applyDeviceControl(action, value) {
    try {
      if (measurementLocked()) throw new Error("\u8BF7\u7B49\u5F85\u5F53\u524D\u8BBE\u5907\u64CD\u4F5C\u5B8C\u6210");
      state.devicePending = true;
      state.deviceError = "";
      state.deviceApplyAction = action;
      state.deviceApplyValue = value;
      state.controller.controlDevice(action, value);
      refreshAll();
    } catch (error) {
      state.devicePending = false;
      refreshAll();
      banner(error.message, "warn");
    }
  }
  function openDeviceCalibration(action) {
    state.calDialogAction = action;
    $("deviceCalTitle").textContent = action === 3 ? "\u6C34\u5206\u548C\u5BC6\u5EA6\u6821\u51C6\u8B66\u544A" : "\u6C34\u6D3B\u6821\u51C6\u8B66\u544A";
    $("deviceCalWarning").textContent = action === 3 ? "\u5012\u7A7A\u5E76\u6E05\u6D01\u6D4B\u91CF\u676F\uFF0C\u7A7A\u676F\u653E\u7A33\u540E\u786E\u8BA4\u3002" : "\u653E\u5165 0.753 \u6807\u51C6\u6DB2\u5E76\u5BC6\u5C01\uFF0C\u7B49\u5F85\u6E29\u5EA6\u7A33\u5B9A\u540E\u786E\u8BA4\u3002";
    $("deviceCalDialog").showModal();
  }
  function handleMeasurementError(message, data, timeout = false) {
    if (!["read_measurement", "start_measurement", "cancel_measurement", "select_bean"].includes(data == null ? void 0 : data.operation)) return false;
    state.measurePending = false;
    if (data.operation === "select_bean") {
      state.measureBeanEdited = false;
      if (state.measure) $("measureBean").value = String(state.measure.beanId);
    }
    if (timeout && data.operation !== "read_measurement") state.measureUnconfirmed = true;
    if (data.status === 1) {
      state.measureSupported = false;
      state.measureError = "\u8BBE\u5907\u56FA\u4EF6\u5C1A\u4E0D\u652F\u6301\u8FDC\u7A0B\u6D4B\u91CF\uFF0C\u8BF7\u5347\u7EA7\u914D\u5957\u56FA\u4EF6\u3002";
    } else if (data.operation !== "read_measurement" || !state.measure) {
      state.measureError = timeout ? "\u6307\u4EE4\u5E94\u7B54\u672A\u786E\u8BA4\uFF0C\u6B63\u5728\u56DE\u8BFB\u8BBE\u5907\u72B6\u6001\uFF1B\u8BF7\u52FF\u91CD\u590D\u542F\u52A8\u3002" : data.operation === "select_bean" && data.status === 3 ? "\u8BBE\u5907\u56FA\u4EF6\u5C1A\u4E0D\u652F\u6301\u7ACB\u5373\u5207\u6362\u8C46\u79CD\uFF0C\u8BF7\u5347\u7EA7\u914D\u5957\u56FA\u4EF6\u3002" : data.status === 10 ? "\u8BF7\u5148\u5728\u8BBE\u5907\u4E0A\u5B8C\u6210\u201C\u6C34\u5206\u4E0E\u5BC6\u5EA6\u201D\u7A7A\u676F\u6821\u51C6\u3002" : data.status === 5 ? "\u6240\u9700\u4F20\u611F\u5668\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u5907\u3002" : data.status === 4 ? "\u8BBE\u5907\u6B63\u5728\u6D4B\u91CF\u3001\u6821\u51C6\u6216\u5347\u7EA7\uFF0C\u8BF7\u7B49\u5F85\u6216\u53D6\u6D88\u5F53\u524D\u6D4B\u91CF\u3002" : message || "\u8BBE\u5907\u6D4B\u91CF\u64CD\u4F5C\u5931\u8D25";
    }
    refreshMeasurementControls();
    return true;
  }
  function measurementLocked() {
    return state.measurePending || state.measureUnconfirmed || measurementActive(state.measure) || deviceOperationLocked();
  }
  function refreshMeasurementControls() {
    var _a, _b, _c;
    const connected = !!((_a = state.controller) == null ? void 0 : _a.isConnected);
    const running = measurementActive(state.measure);
    const blocked = !connected || state.measureSupported !== true || state.otaBusy || state.snBusy || captureState.active || deviceOperationLocked() || state.measurePending || state.measureUnconfirmed || running || !((_b = state.measure) == null ? void 0 : _b.deviceReady) || ((_c = state.measure) == null ? void 0 : _c.deviceBusy);
    for (const id of ["measureMd", "measureAll"]) $(id).disabled = blocked;
    $("measureBean").disabled = blocked;
    const m = state.measure;
    $("measurePhase").textContent = !connected ? "\u672A\u8FDE\u63A5" : state.measureSupported === false ? "\u9700\u5347\u7EA7\u56FA\u4EF6" : state.measurePending ? "\u53D1\u9001\u4E2D" : !m ? "\u8BFB\u53D6\u72B6\u6001" : ["\u5F85\u6D4B\u91CF", "\u7B49\u5F85\u542F\u52A8", "\u6D4B\u91CF\u4E2D", "\u5DF2\u5B8C\u6210", "\u5DF2\u53D6\u6D88", "\u672A\u5B8C\u6210"][m.phase];
    $("measurePhase").classList.toggle("ok", (m == null ? void 0 : m.phase) === 3 && connected);
    $("measureStatus").textContent = !connected ? "\u8BBE\u5907\u5DF2\u65AD\u5F00\uFF1B\u91CD\u65B0\u8FDE\u63A5\u540E\u56DE\u8BFB\u6D4B\u91CF\u72B6\u6001\u3002" : state.measureError || measurementStatusText(m);
    $("measureMoisture").textContent = fmt(m == null ? void 0 : m.moisture, 1);
    $("measureDensity").textContent = fmt(m == null ? void 0 : m.density, 0);
    $("measureAwValue").textContent = fmt(m == null ? void 0 : m.aw, 3);
    const seconds = Math.floor(((m == null ? void 0 : m.elapsedMs) || 0) / 1e3);
    $("measureElapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function startDeviceMeasurement(mode) {
    try {
      if (measurementLocked()) throw new Error("\u8BF7\u5148\u5B8C\u6210\u6216\u53D6\u6D88\u5F53\u524D\u6D4B\u91CF");
      state.measurePending = true;
      state.measureError = "";
      state.controller.startMeasurement(Number($("measureBean").value), mode);
      refreshAll();
    } catch (error) {
      state.measurePending = false;
      refreshAll();
      banner(error.message, "warn");
    }
  }
  setInterval(() => {
    var _a, _b;
    if (((_a = state.controller) == null ? void 0 : _a.isConnected) && !state.otaBusy && state.measureSupported !== false)
      state.controller.readMeasurement();
    if (((_b = state.controller) == null ? void 0 : _b.isConnected) && !state.otaBusy && state.deviceSupported !== false) state.controller.readDeviceControl();
  }, 1e3);
  var rhSeries = { raw: [], corrected: [] };
  var awSeries = [];
  var mdSeries = [];
  var lastMdTelemetryAt = 0;
  function resetMdTelemetry(message) {
    var _a, _b, _c;
    lastMdTelemetryAt = 0;
    for (const id of ["liveMoisture", "liveDensity", "liveCapRaw", "liveWeightRaw", "liveDeltaCap", "liveEmptyCap"]) $(id).textContent = "--";
    $("liveBean").textContent = "\u8C46\u79CD\uFF1A\u7B49\u5F85\u8BBE\u5907";
    $("mdStatus").textContent = message;
    $("mdExport").disabled = !((_c = (_b = (_a = state.controller) == null ? void 0 : _a.session) == null ? void 0 : _b.mdTelemetry) == null ? void 0 : _c.length);
  }
  function onMdTelemetry(sample) {
    var _a, _b, _c;
    if (!state.telemetryOn) return;
    lastMdTelemetryAt = Date.now();
    state.bleTimeoutStreak = 0;
    const v = mdValues(sample);
    $("liveBean").textContent = `\u8C46\u79CD\uFF1A${v.beanName}`;
    $("liveMoisture").textContent = v.moisturePct == null ? "--" : fmt(v.moisturePct, 2);
    $("liveDensity").textContent = v.densityGl == null ? "--" : fmt(v.densityGl, 0);
    $("liveCapRaw").textContent = v.capacitancePf == null ? "--" : fmt(v.capacitancePf, 6);
    $("liveWeightRaw").textContent = v.weightAdc == null ? "--" : String(v.weightAdc);
    $("liveDeltaCap").textContent = v.deltaCapacitancePf == null ? "--" : fmt(v.deltaCapacitancePf, 6);
    $("liveEmptyCap").textContent = v.emptyCapacitancePf == null ? "--" : fmt(v.emptyCapacitancePf, 6);
    $("mdExport").disabled = !((_c = (_b = (_a = state.controller) == null ? void 0 : _a.session) == null ? void 0 : _b.mdTelemetry) == null ? void 0 : _c.length);
    const status = [];
    if (v.capacitancePf == null) status.push("\u7535\u5BB9\u4F20\u611F\u5668\u672A\u5C31\u7EEA");
    else if (v.moisturePct == null) status.push("\u6C34\u5206\u8BA1\u7B97\u672A\u5C31\u7EEA");
    if (v.emptyCapacitancePf == null) status.push("emptyCapacitancePf" in sample ? "\u8BF7\u5148\u5728\u8BBE\u5907\u6267\u884C\u7A7A\u676F\u6821\u51C6" : "\u8BBE\u5907\u672A\u4E0A\u62A5\u7A7A\u676F/\u0394C\uFF0C\u8BF7\u66F4\u65B0\u914D\u5957\u56FA\u4EF6");
    if (v.weightAdc == null) status.push("\u79F0\u91CD\u4F20\u611F\u5668\u672A\u5C31\u7EEA");
    else status.push(`\u91CD\u91CF ${fmt(v.weightG, 2)} g`);
    $("mdStatus").textContent = status.join(" \xB7 ");
    if (!state.chartPaused) {
      mdSeries.push({ ...sample, time: lastMdTelemetryAt });
      trimSeries();
    }
  }
  var lastTelemetryAt = 0;
  var lastHeartbeatSentAt = -Infinity;
  var DESPIKE_RH = 3;
  var displayFilter = { prev: null, pending: null };
  function confirmSample(t, nowMs) {
    const f = displayFilter;
    if (!f.pending) {
      f.pending = { t, nowMs };
      return null;
    }
    const a = f.prev, b = f.pending, c = t;
    let outlier = false;
    if (a && Number.isFinite(a.t.humidityRaw) && Number.isFinite(b.t.humidityRaw)) {
      const d1 = Math.abs(b.t.humidityRaw - a.t.humidityRaw);
      const d2 = Math.abs(b.t.humidityRaw - c.humidityRaw);
      const d3 = Math.abs(c.humidityRaw - a.t.humidityRaw);
      outlier = d1 > DESPIKE_RH && d2 > DESPIKE_RH && d3 < DESPIKE_RH;
    }
    const show = outlier ? null : b;
    f.prev = { t: b.t, nowMs: b.nowMs };
    f.pending = { t, nowMs };
    return show;
  }
  function onTelemetry(t) {
    if (!state.telemetryOn) return;
    lastTelemetryAt = Date.now();
    state.bleTimeoutStreak = 0;
    const show = confirmSample(t, Date.now());
    if (!show) return;
    t = show.t;
    $("liveTemp").textContent = fmt(t.temperatureC, 2);
    $("liveRhRaw").textContent = fmt(t.humidityRaw, 3);
    $("liveRhCorr").textContent = fmt(t.humidityCorrected, 3);
    $("liveAw").textContent = fmt(t.awFinal, 4);
    $("flagSensor").classList.toggle("on", !!(t.flags & 1));
    $("flagParams").classList.toggle("on", !!(t.flags & 2));
    $("flagDew").classList.toggle("on", !!(t.flags & 4));
    if (!state.chartPaused) {
      rhSeries.raw.push([show.nowMs, t.humidityRaw]);
      rhSeries.corrected.push([show.nowMs, t.humidityCorrected]);
      awSeries.push([show.nowMs, t.awFinal]);
      trimSeries();
      chartsDirty = true;
    }
  }
  function trimSeries() {
    const windowMs = Number($("chartWindow").value);
    const cutoff = Date.now() - windowMs;
    for (const series of [rhSeries.raw, rhSeries.corrected, awSeries]) {
      while (series.length > 2 && series[0][0] < cutoff) series.shift();
    }
    while (mdSeries.length && mdSeries[0].time < cutoff) mdSeries.shift();
  }
  setInterval(() => {
    var _a, _b, _c;
    if (state.telemetryOn && lastMdTelemetryAt && Date.now() - lastMdTelemetryAt > 3e3) {
      resetMdTelemetry("\u6C34\u5206\u4E0E\u5BC6\u5EA6\u6570\u636E\u5DF2\u4E2D\u65AD\uFF0C\u7B49\u5F85\u8BBE\u5907\u6062\u590D\u4E0A\u4F20\u3002");
    }
    if (!state.otaBusy) (_a = state.controller) == null ? void 0 : _a.tick();
    if (((_b = state.controller) == null ? void 0 : _b.isConnected) && !state.otaBusy && !state.disconnecting && performance.now() - lastHeartbeatSentAt >= 2e3) {
      lastHeartbeatSentAt = performance.now();
      state.controller.sendHeartbeat();
    }
    if ((_c = state.controller) == null ? void 0 : _c.isConnected) {
      $("chipHb").classList.toggle("on", Date.now() - lastHeartbeatAckAt < 5e3);
    }
  }, 200);
  var lastHeartbeatAckAt = 0;
  setInterval(() => {
    var _a;
    if ((_a = state.controller) == null ? void 0 : _a.isConnected) {
      if (state.heartbeatOk) {
        lastHeartbeatAckAt = Date.now();
        state.heartbeatOk = false;
      }
    }
    if (chartsDirty && !state.chartPaused) {
      chartsDirty = false;
      drawCharts();
    }
  }, 250);
  var captureState = {
    active: false,
    pointId: null,
    progress: {}
  };
  function buildPointsUi() {
    const grid = $("pointsGrid");
    grid.innerHTML = "";
    POINT_LABELS.forEach((label, pointId) => {
      const div = document.createElement("div");
      div.className = "point";
      div.id = "point" + pointId;
      div.innerHTML = `
      <div class="head">
        <span class="title">${label}</span>
        <span class="count" id="count${pointId}">0/${state.requiredRunsPerPoint}</span>
        <button class="btn small primary" data-point="${pointId}" id="start${pointId}">\u5F00\u59CB\u91C7\u96C6</button>
      </div>
      <div class="bar"><i id="bar${pointId}"></i></div>
      <div class="nums" id="nums${pointId}">--</div>`;
      grid.appendChild(div);
    });
    grid.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-point]");
      if (!button) return;
      startCapture(Number(button.dataset.point));
    });
  }
  function startCapture(pointId) {
    var _a;
    if (!((_a = state.controller) == null ? void 0 : _a.isConnected)) return banner("\u8BF7\u5148\u8FDE\u63A5\u8BBE\u5907", "warn");
    if (captureState.active) return banner("\u5F53\u524D\u5DF2\u6709\u91C7\u96C6\u8FDB\u884C\u4E2D\uFF0C\u8BF7\u5148\u53D6\u6D88", "warn");
    cancelAutoRetry();
    state.controller.startCapture(pointId);
  }
  function onCaptureProgress(progress) {
    captureState.active = true;
    captureState.pointId = progress.pointId;
    captureState.progress = progress;
    refreshCaptureUi();
  }
  function onCaptureResult(run) {
    captureState.active = false;
    captureState.progress = {};
    const label = { stable: "\u7A33\u5B9A", timeout: "\u8D85\u65F6", cancelled: "\u53D6\u6D88", sensor_error: "\u4F20\u611F\u5668\u9519\u8BEF" }[run.resultCode];
    appendRun(`${(/* @__PURE__ */ new Date()).toTimeString().slice(0, 8)} \u70B9${POINT_LABELS[run.pointId]} ${label}\uFF1Araw=${fmt(run.meanRhRaw, 3)} corr=${fmt(run.meanRhCorrected, 3)} sd=${fmt(run.stddevRhRaw, 4)} n=${run.sampleCount}`);
    if (run.resultCode === "stable") {
      banner(`\u70B9\u4F4D ${POINT_LABELS[run.pointId]} \u91C7\u96C6\u7A33\u5B9A\u901A\u8FC7`, "warn");
    } else if ((run.resultCode === "timeout" || run.resultCode === "sensor_error") && $("autoRetry").checked) {
      scheduleAutoRetry(run.pointId);
    }
    refreshAll();
  }
  function scheduleAutoRetry(pointId) {
    cancelAutoRetry();
    appendRun(`\u5C06\u5728 2 \u79D2\u540E\u81EA\u52A8\u91CD\u8BD5\u70B9\u4F4D ${POINT_LABELS[pointId]}\u2026`);
    state.autoRetryTimer = setTimeout(() => {
      var _a;
      state.autoRetryTimer = null;
      if (((_a = state.controller) == null ? void 0 : _a.isConnected) && !captureState.active) {
        state.controller.startCapture(pointId);
      }
    }, 2e3);
  }
  function cancelAutoRetry() {
    if (state.autoRetryTimer) {
      clearTimeout(state.autoRetryTimer);
      state.autoRetryTimer = null;
    }
  }
  function appendRun(text) {
    const el = $("runList");
    el.textContent += (el.textContent ? "\n" : "") + text;
    el.scrollTop = el.scrollHeight;
  }
  function refreshCaptureUi() {
    var _a, _b;
    refreshSnControls();
    const session = (_a = state.controller) == null ? void 0 : _a.session;
    for (let pointId = 0; pointId < 4; pointId += 1) {
      const count = session ? session.acceptedRunsByPoint[pointId].length : 0;
      const countEl = $("count" + pointId);
      countEl.textContent = `${count}/${state.requiredRunsPerPoint}`;
      countEl.classList.toggle("ok", count >= state.requiredRunsPerPoint);
      const pointEl = $("point" + pointId);
      pointEl.classList.toggle("active", captureState.active && captureState.pointId === pointId);
      if (captureState.active && captureState.pointId === pointId && captureState.progress.sampleCount) {
        $("bar" + pointId).style.width = Math.min(100, captureState.progress.sampleCount / 1.5) + "%";
        $("nums" + pointId).textContent = `n=${captureState.progress.sampleCount}/150 \xB7 ${Math.round(captureState.progress.elapsedMs / 1e3)}s \xB7 mean=${fmt(captureState.progress.meanRhRaw, 3)} sd=${fmt(captureState.progress.stddevRhRaw, 4)}`;
      } else {
        $("bar" + pointId).style.width = "0";
        if (count > 0) {
          const agg = session.pointAggregate(pointId);
          $("nums" + pointId).textContent = `${count} \u6B21\u5747\u503C ${fmt(agg.meanRhRaw, 3)}` + (agg.stdevRhRaw != null ? ` \xB1 ${fmt(agg.stdevRhRaw, 3)}` : "");
        } else {
          $("nums" + pointId).textContent = "--";
        }
      }
    }
    for (let pointId = 0; pointId < 4; pointId++) $("point" + pointId).querySelector("button").disabled = !((_b = state.controller) == null ? void 0 : _b.isConnected) || state.otaBusy || captureState.active || measurementLocked();
    $("btnCancel").disabled = !captureState.active;
    $("btnCancel").textContent = captureState.active ? `\u53D6\u6D88\u5F53\u524D\u91C7\u96C6\uFF08\u70B9 ${POINT_LABELS[captureState.pointId]}\uFF09` : "\u53D6\u6D88\u5F53\u524D\u91C7\u96C6";
  }
  function refreshFits() {
    var _a;
    sessionReportCache = null;
    let report;
    try {
      report = (_a = state.controller) == null ? void 0 : _a.recomputeReport();
    } catch (error) {
      $("fitTable").textContent = error.message;
      $("fitWarning").classList.add("hidden");
      $("btnWrite").disabled = true;
      drawCalibrationChart();
      return;
    }
    if (!report) {
      $("fitTable").innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--dim)">\u56DB\u4E2A\u70B9\u4F4D\u5404\u9700\u81F3\u5C11 ${state.requiredRunsPerPoint} \u6B21\u7A33\u5B9A\u91C7\u96C6\u540E\u81EA\u52A8\u751F\u6210\u62DF\u5408</td></tr>`;
      $("fitWarning").classList.add("hidden");
      $("btnWrite").disabled = true;
      drawCalibrationChart();
      return;
    }
    applyReport(report);
  }
  function applyReport(report) {
    var _a;
    if (!(report == null ? void 0 : report.endpoint) || !report.leastSquares) return;
    sessionReportCache = report;
    const methods = [
      { key: "endpoint", name: "\u4E24\u7AEF\u70B9\u6CD5", fit: report.endpoint },
      { key: "least_squares", name: "\u56DB\u70B9\u6700\u5C0F\u4E8C\u4E58", fit: report.leastSquares }
    ];
    let html = "<tr><th>\u65B9\u6CD5</th><th>K</th><th>B</th>" + POINT_LABELS.map((l) => `<th>${l}</th>`).join("") + "<th>RMSE</th></tr>";
    for (const { key, name, fit: fit2 } of methods) {
      html += `<tr class="${(state.selectedFit ?? report.recommendedMethod) === key ? "sel" : ""}" data-fit="${key}"><td>${name}${report.recommendedMethod === key ? '<span class="tag rec">\u63A8\u8350</span>' : ""}</td><td>${fmt(fit2.slopeK, 6)}</td><td>${fmt(fit2.offsetB, 6)}</td>` + fit2.correctedRh.map((v, i) => `<td title="\u6B8B\u5DEE ${fmt(fit2.residuals[i], 3)}">${fmt(v, 2)}</td>`).join("") + `<td>${fmt(fit2.rmse, 3)}</td></tr>`;
    }
    html += "<tr><th>\u6B8B\u5DEE</th><th></th><th></th>" + POINT_LABELS.map(() => "<th></th>").join("") + "<th></th></tr>";
    for (const { key, name, fit: fit2 } of methods) {
      html += `<tr><td>${name} \u6B8B\u5DEE</td><td></td><td></td>` + fit2.residuals.map((v) => `<td>${fmt(v, 3)}</td>`).join("") + "<td></td></tr>";
    }
    $("fitTable").innerHTML = html;
    for (const row of $("fitTable").querySelectorAll("tr[data-fit]")) {
      row.addEventListener("click", () => {
        state.selectedFit = row.dataset.fit;
        applyReport(sessionReportCache);
      });
    }
    if (report.warningReasons.length) {
      $("fitWarning").textContent = report.warningReasons.join("\uFF1B");
      $("fitWarning").classList.remove("hidden");
    } else {
      $("fitWarning").classList.add("hidden");
    }
    drawCalibrationChart();
    $("btnWrite").disabled = !((_a = state.controller) == null ? void 0 : _a.isConnected);
  }
  var sessionReportCache = null;
  function writeSelected() {
    var _a;
    if (!((_a = state.controller) == null ? void 0 : _a.isConnected)) return;
    refreshFits();
    const report = sessionReportCache;
    if (!report) return;
    const method = state.selectedFit ?? report.recommendedMethod;
    const fit2 = method === "endpoint" ? report.endpoint : report.leastSquares;
    if (!confirm(`\u786E\u8BA4\u5199\u5165 ${method === "endpoint" ? "\u4E24\u7AEF\u70B9\u6CD5" : "\u56DB\u70B9\u6700\u5C0F\u4E8C\u4E58"} \u53C2\u6570 K=${fmt(fit2.slopeK, 6)} / B=${fmt(fit2.offsetB, 6)}\uFF1F
\u5199\u5165\u540E\u65E7 0.753 \u9732\u70B9\u6821\u51C6\u5C06\u5931\u6548\u3002`)) return;
    state.controller.writeParameters(fit2.slopeK, fit2.offsetB);
  }
  function exportSession() {
    var _a;
    const session = (_a = state.controller) == null ? void 0 : _a.session;
    if (!session) return;
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const document_ = {
      schema_version: 1,
      device_id: session.deviceId,
      started_at: session.startedAt.toISOString(),
      ended_at: session.endedAt ? session.endedAt.toISOString() : null,
      connection_metadata: session.connectionMetadata,
      master_profile: { rh: session.masterProfileRh },
      required_runs_per_point: session.requiredRunsPerPoint,
      telemetry: session.telemetry,
      md_telemetry: session.mdTelemetry,
      captures: session.captureResults,
      accepted_runs_by_point: Object.fromEntries(
        session.acceptedRunsByPoint.map((runs, id) => [id, runs])
      ),
      parameter_operations: session.parameterOperations,
      report: session.report ? {
        fits: {
          endpoint: session.report.endpoint,
          least_squares: session.report.leastSquares
        },
        recommended_method: session.report.recommendedMethod,
        warning_reasons: session.report.warningReasons
      } : null
    };
    download(
      new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" }),
      `calibration_session_${stamp}.json`
    );
    const header = [
      "record_type",
      "timestamp",
      "device_id",
      "flags",
      "sample_sequence",
      "point_id",
      "result_code",
      "sample_count",
      "elapsed_ms",
      "temperature_c",
      "humidity_raw",
      "humidity_corrected",
      "aw_unclamped",
      "aw_final",
      "mean_rh_raw",
      "mean_rh_corrected",
      "stddev_rh_raw",
      "fit_method",
      "slope_k",
      "offset_b",
      "corrected_rh",
      "residual",
      "rmse",
      "recommended_method",
      "bean_id",
      "bean_name",
      "moisture_pct",
      "density_g_l",
      "capacitance_raw_pf",
      "weight_raw_adc",
      "weight_g",
      "capacitance_empty_pf",
      "delta_capacitance_pf",
      "required_runs_per_point"
    ];
    const rows = [header.join(",")];
    const esc = (v) => v == null ? "" : String(v).includes(",") ? `"${v}"` : String(v);
    const csvRow = (cells) => Array.from({ length: header.length }, (_, i) => esc(i === header.length - 1 ? session.requiredRunsPerPoint : cells[i])).join(",");
    rows.push(csvRow(["metadata", document_.started_at, session.deviceId]));
    for (const t of session.telemetry) {
      rows.push(csvRow([
        "telemetry",
        "",
        session.deviceId,
        t.flags,
        t.sampleSequence,
        "",
        "",
        "",
        "",
        t.temperatureC,
        t.humidityRaw,
        t.humidityCorrected,
        t.awUnclamped,
        t.awFinal,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        ""
      ]));
    }
    for (const c of session.captureResults) {
      rows.push(csvRow([
        "capture",
        "",
        session.deviceId,
        "",
        "",
        c.pointId,
        c.resultCode,
        c.sampleCount,
        c.elapsedMs,
        "",
        "",
        "",
        "",
        "",
        c.meanRhRaw,
        c.meanRhCorrected,
        c.stddevRhRaw,
        "",
        "",
        "",
        "",
        "",
        ""
      ]));
    }
    if (session.report) {
      for (const [method, fit2] of [["endpoint", session.report.endpoint], ["least_squares", session.report.leastSquares]]) {
        for (let pointId = 0; pointId < 4; pointId += 1) {
          rows.push(csvRow([
            "fit_point",
            "",
            session.deviceId,
            "",
            "",
            pointId,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            method,
            fit2.slopeK,
            fit2.offsetB,
            fit2.correctedRh[pointId],
            fit2.residuals[pointId],
            fit2.rmse,
            session.report.recommendedMethod
          ]));
        }
      }
    }
    for (const t of session.mdTelemetry) {
      const cells = Array(24).fill("");
      cells[0] = "md_telemetry";
      cells[1] = t.timestamp;
      cells[2] = session.deviceId;
      cells[3] = t.flags;
      cells[4] = t.sampleSequence;
      rows.push(csvRow([...cells, ...mdCsvCells(t)]));
    }
    download(new Blob([rows.join("\n")], { type: "text/csv" }), `calibration_session_${stamp}.csv`);
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  function applyParams(p) {
    state.params = p;
    $("devParamVer").textContent = String(p.paramVersion);
    $("devKb").textContent = `${fmt(p.slopeK, 6)} / ${fmt(p.offsetB, 6)}${p.paramsValid ? "" : "\uFF08\u65E0\u6548\uFF09"}`;
    $("devDew").textContent = p.calDewValid ? fmt(p.calDew, 3) : "\u5DF2\u5931\u6548";
    refreshAll();
  }
  function buildMasterUi() {
    const grid = $("masterGrid");
    grid.innerHTML = "";
    POINT_LABELS.forEach((label, index) => {
      const wrap = document.createElement("label");
      wrap.innerHTML = `<span>${label}</span><input type="number" step="0.001" id="master${index}" value="${state.masterRh[index]}">`;
      grid.appendChild(wrap);
    });
  }
  function saveMaster() {
    const values = [];
    for (let i = 0; i < 4; i += 1) {
      const value = Number($("master" + i).value);
      if (!Number.isFinite(value)) return banner("\u57FA\u51C6 RH \u5FC5\u987B\u662F\u6570\u5B57", "err");
      values.push(value);
    }
    state.masterRh = values;
    localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify(values));
    if (state.controller) {
      state.controller.masterProfileRh = values;
      state.controller.session.masterProfileRh = values;
      const report = state.controller.recomputeReport();
      if (report) applyReport(report);
    }
    banner("\u57FA\u51C6 RH \u5DF2\u4FDD\u5B58\u5E76\u91CD\u7B97", "warn");
  }
  function loadMaster() {
    try {
      const stored = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY));
      if (Array.isArray(stored) && stored.length === 4 && stored.every((v) => Number.isFinite(v))) {
        state.masterRh = stored;
      }
    } catch {
    }
  }
  var chartsDirty = true;
  function drawCharts() {
    drawChart($("chartRh"), [
      { data: rhSeries.raw, color: "#60a5fa", label: "\u539F\u59CB RH" },
      { data: rhSeries.corrected, color: "#16a34a", label: "\u4FEE\u6B63 RH" }
    ], "%RH");
    drawChart($("chartAw"), [
      { data: awSeries, color: "#06b6d4", label: "AW" }
    ], "AW");
  }
  function drawChart(canvas, seriesList, unit) {
    const ctx = canvas.getContext("2d");
    const parent = canvas.parentElement;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!seriesList.some((s) => s.data.length)) {
      ctx.fillStyle = "#43536f";
      ctx.font = "12px sans-serif";
      ctx.fillText("\u6682\u65E0\u6570\u636E", 8, 18);
      return;
    }
    const windowMs = Number($("chartWindow").value);
    const now = Date.now();
    const xMin = now - windowMs;
    const xMax = now;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const series of seriesList) {
      for (const [, value] of series.data) {
        if (value < yMin) yMin = value;
        if (value > yMax) yMax = value;
      }
    }
    if (yMax - yMin < 1e-6) {
      yMin -= 1;
      yMax += 1;
    }
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad;
    yMax += pad;
    const padL = 44, padR = 8, padT = 8, padB = 16;
    const toX = (t) => padL + (t - xMin) / (xMax - xMin) * (width - padL - padR);
    const toY = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (height - padT - padB);
    ctx.strokeStyle = "#1c2942";
    ctx.fillStyle = "#68799b";
    ctx.font = "10px monospace";
    for (let i = 0; i <= 4; i += 1) {
      const y = padT + i / 4 * (height - padT - padB);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText((yMax - i / 4 * (yMax - yMin)).toFixed(yMax - yMin > 20 ? 0 : 2), 4, y + 3);
    }
    for (const series of seriesList) {
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const [t, v] of series.data) {
        const x = toX(t);
        const y = toY(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    let lx = padL + 4;
    for (const series of seriesList) {
      ctx.fillStyle = series.color;
      ctx.fillRect(lx, height - 10, 8, 3);
      ctx.fillStyle = "#8ea0c0";
      ctx.fillText(series.label, lx + 11, height - 5);
      lx += 14 + ctx.measureText(series.label).width + 10;
    }
    ctx.fillStyle = "#68799b";
    ctx.fillText(unit, width - 34, 12);
  }
  window.addEventListener("resize", () => {
    chartsDirty = true;
    drawCalibrationChart();
  });
  function drawCalibrationChart() {
    var _a;
    const canvas = $("calibChart");
    if (!canvas) return;
    const session = (_a = state.controller) == null ? void 0 : _a.session;
    const raw = session == null ? void 0 : session.devicePointMeans();
    const report = sessionReportCache;
    if (!canvas.parentElement || canvas.parentElement.clientWidth === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement.clientWidth;
    const height = canvas.parentElement.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!raw || !report) {
      ctx.fillStyle = "#43536f";
      ctx.font = "12px sans-serif";
      ctx.fillText("\u56DB\u70B9\u91C7\u96C6\u5B8C\u6210\u540E\u663E\u793A\u5BF9\u6BD4\u66F2\u7EBF", 8, 18);
      return;
    }
    const method = state.selectedFit ?? report.recommendedMethod;
    const fit2 = method === "endpoint" ? report.endpoint : report.leastSquares;
    const master = session.masterProfileRh;
    const series = [
      { label: "\u8BBE\u5907\u539F\u59CB", color: "#60a5fa", values: raw, r: 3.2 },
      { label: "\u9009\u5B9A\u4FEE\u6B63", color: "#f59e0b", values: fit2.correctedRh, r: 3.2 },
      { label: "\u4E00\u53F7\u673A\u57FA\u51C6", color: "#4ade80", values: master, r: 2.6 }
    ];
    let yMin = Infinity, yMax = -Infinity;
    for (const s of series) for (const v of s.values) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    const pad = Math.max((yMax - yMin) * 0.15, 0.5);
    yMin -= pad;
    yMax += pad;
    const padL = 44, padR = 10, padT = 10, padB = 26;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const toX = (i) => padL + (i + 0.5) / 4 * plotW;
    const toY = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
    ctx.strokeStyle = "#1c2942";
    ctx.fillStyle = "#68799b";
    ctx.font = "10px monospace";
    for (let i = 0; i <= 4; i += 1) {
      const y = padT + i / 4 * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText((yMax - i / 4 * (yMax - yMin)).toFixed(1), 4, y + 3);
    }
    ctx.textAlign = "center";
    POINT_LABELS.forEach((label, i) => ctx.fillText(label, toX(i), height - 12));
    ctx.textAlign = "left";
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      s.values.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = s.color;
      for (let i = 0; i < s.values.length; i += 1) {
        ctx.beginPath();
        ctx.arc(toX(i), toY(s.values[i]), s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    let lx = padL + 6;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(lx + 4, height - 4.5, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8ea0c0";
      ctx.font = "10px monospace";
      ctx.fillText(s.label, lx + 11, height - 1);
      lx += 16 + ctx.measureText(s.label).width + 10;
    }
    ctx.fillStyle = "#68799b";
    ctx.fillText("%RH", width - 30, 12);
  }
  function exportChartCsv() {
    const records = [];
    const length = Math.max(rhSeries.raw.length, rhSeries.corrected.length, awSeries.length);
    const at = (series, i) => i < series.length ? series[i] : [0, null];
    for (let i = 0; i < length; i += 1) {
      const [t0] = at(rhSeries.raw, i);
      records.push({ time: t0, cells: [
        new Date(t0).toISOString(),
        at(rhSeries.raw, i)[1],
        at(rhSeries.corrected, i)[1],
        at(awSeries, i)[1],
        "aw",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        ""
      ] });
    }
    for (const sample of mdSeries) records.push({ time: sample.time, cells: [
      new Date(sample.time).toISOString(),
      "",
      "",
      "",
      "md",
      ...mdCsvCells(sample),
      sample.flags
    ] });
    records.sort((a, b) => a.time - b.time);
    const rows = [
      "time,rh_raw,rh_corrected,aw_final,record_type,bean_id,bean_name,moisture_pct,density_g_l,capacitance_raw_pf,weight_raw_adc,weight_g,capacitance_empty_pf,delta_capacitance_pf,md_flags",
      ...records.map((r) => Array.from({ length: 15 }, (_, i) => r.cells[i] ?? "").join(","))
    ];
    download(new Blob([rows.join("\n")], { type: "text/csv" }), `aw_telemetry_${Date.now()}.csv`);
  }
  var otaFileBytes = null;
  var otaFileName = "";
  var stopApProbeFn = null;
  var verifyOtaTimer = null;
  var otaStorage;
  try {
    otaStorage = localStorage;
  } catch {
  }
  var otaResult = new OtaResult(otaStorage);
  var otaRate = null;
  function resetOtaRate() {
    otaRate = null;
    delete otaResult.value.transferStats;
  }
  function startOtaRate(simulated = false) {
    otaRate = new OtaTransferRate(otaFileBytes.length);
    otaRate.simulated = simulated;
    saveOtaRate();
  }
  function saveOtaRate() {
    if (otaRate) otaResult.value.transferStats = otaRate.snapshot();
  }
  function stopOtaRate() {
    if (otaRate) {
      otaResult.value.transferStats = otaRate.stop();
      otaResult.save(true);
    }
  }
  function renderOtaStatus() {
    const r = otaResult.value, p = otaPresentation(r);
    $("otaStatus").className = "ota-status " + p.tone;
    $("otaStatusTitle").textContent = p.title;
    $("otaStatusDetail").textContent = r.detail || "\u9009\u62E9\u56FA\u4EF6\u5E76\u8FDE\u63A5\u8BBE\u5907\u540E\uFF0C\u70B9\u51FB\u5BF9\u5E94\u5347\u7EA7\u6309\u94AE\u3002";
    const rows = [];
    if (r.fileName) rows.push("\u8BB0\u5F55\u56FA\u4EF6\uFF1A" + r.fileName + (r.version ? " \xB7 " + r.version : ""));
    if (r.startedAt) rows.push("\u5F00\u59CB\u65F6\u95F4\uFF1A" + new Date(r.startedAt).toLocaleString());
    if (r.sha256) rows.push("\u76EE\u6807\u6307\u7EB9\uFF1A" + r.sha256.slice(0, 16));
    if (r.actualSha256) rows.push("\u8FD0\u884C\u6307\u7EB9\uFF1A" + r.actualSha256.slice(0, 16));
    if (r.completedAt) rows.push("\u5B8C\u6210\u65F6\u95F4\uFF1A" + new Date(r.completedAt).toLocaleString());
    if (r.startedAt && state.otaBusy) rows.push("\u5DF2\u7528\u65F6\uFF1A" + Math.floor((Date.now() - r.startedAt) / 1e3) + " \u79D2");
    $("otaResultMeta").textContent = rows.join("\n");
    $("otaVerify").classList.toggle("hidden", !otaResult.canVerify && !otaFileBytes);
    $("otaVerify").textContent = otaResult.canVerify && (!otaFileBytes || firmwareIdentity(otaFileBytes).sha256 === r.sha256) ? "\u6838\u5BF9\u5347\u7EA7\u7ED3\u679C" : "\u6838\u5BF9\u6240\u9009\u56FA\u4EF6";
    $("otaVerify").disabled = state.otaBusy || r.phase === "verifying";
    $("otaBar").style.width = (r.percent || 0) + "%";
    $("otaPercent").textContent = (r.percent || 0) + "%";
    const stats = (otaRate == null ? void 0 : otaRate.active) ? otaRate.snapshot() : r.transferStats;
    const simulated = (stats == null ? void 0 : stats.simulated) ? "\uFF08\u6A21\u62DF\uFF09" : "";
    $("otaCurrentRate").textContent = `\u5B9E\u65F6\u901F\u5EA6${simulated}\uFF1A${formatTransferRate((otaRate == null ? void 0 : otaRate.active) ? stats.currentBps : null)}`;
    $("otaAverageRate").textContent = `\u5E73\u5747\u901F\u5EA6${simulated}\uFF1A${formatTransferRate(stats == null ? void 0 : stats.averageBps)}`;
  }
  function scheduleOtaVerification(delay = 2500) {
    clearTimeout(verifyOtaTimer);
    const attempt = otaResult.value.startedAt;
    verifyOtaTimer = setTimeout(() => {
      var _a;
      if (!otaResult.canVerify || attempt !== otaResult.value.startedAt || state.otaBusy) return;
      if (!((_a = state.controller) == null ? void 0 : _a.isConnected)) {
        otaResult.set("awaiting_reconnect", "\u56FA\u4EF6\u5199\u5165\u5DF2\u6210\u529F\u3002\u8BF7\u70B9\u51FB\u8FDE\u63A5\u84DD\u7259\u6216\u8FDE\u63A5\u4E32\u53E3\uFF0C\u7CFB\u7EDF\u4F1A\u81EA\u52A8\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6\u3002");
        renderOtaStatus();
        return;
      }
      otaResult.set("verifying", "\u6B63\u5728\u8BFB\u53D6\u8BBE\u5907\u5F53\u524D\u8FD0\u884C\u56FA\u4EF6\u7684\u6307\u7EB9\uFF0C\u6700\u591A\u7EA6 15 \u79D2\u2026");
      renderOtaStatus();
      try {
        state.controller.readFirmwareIdentity();
      } catch (error) {
        otaResult.set("unconfirmed", error.message);
        renderOtaStatus();
      }
    }, delay);
  }
  renderOtaStatus();
  setInterval(() => {
    if (state.otaBusy) {
      saveOtaRate();
      otaResult.save();
      renderOtaStatus();
    }
  }, 1e3);
  function otaLogLine(text) {
    const el = $("otaLog");
    const time = (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8);
    el.textContent += `[${time}] ${text}
`;
    el.scrollTop = el.scrollHeight;
  }
  function setOtaProgress(sent, total, detail, transferred = sent) {
    otaRate == null ? void 0 : otaRate.update(transferred);
    saveOtaRate();
    const pct = total ? Math.floor(sent * 100 / total) : 0;
    otaResult.progress(pct, detail);
    renderOtaStatus();
    $("otaDetail").textContent = detail ?? "";
  }
  async function runOta(channel) {
    var _a, _b;
    if (state.otaBusy) return;
    if (!otaFileBytes) return otaLogLine("\u8BF7\u5148\u9009\u62E9 .bin \u56FA\u4EF6\u6587\u4EF6");
    if (state.mock) {
      return runMockOta(channel);
    }
    const transport = channel === "ble" ? state.ble : state.serial;
    if (!(transport == null ? void 0 : transport.isConnected)) return otaLogLine((channel === "ble" ? "\u84DD\u7259" : "\u4E32\u53E3") + "\u672A\u8FDE\u63A5");
    try {
      (_a = state.controller) == null ? void 0 : _a.pauseForOta();
    } catch (error) {
      return otaLogLine(error.message);
    }
    state.otaBusy = true;
    refreshAll();
    refreshConnectButtons();
    otaResult.start(otaFileName, channel, otaFileBytes);
    resetOtaRate();
    renderOtaStatus();
    let failed = false;
    try {
      validateFirmwareImage(otaFileBytes);
      await runWireOta({
        transport,
        bytes: otaFileBytes,
        channel,
        onLog: otaLogLine,
        onProgress: (p) => setOtaProgress(p.sent, p.total, p.detail, p.transferred),
        onPhase: (phase) => {
          if (phase === "sending") startOtaRate();
          if (phase === "validating") stopOtaRate();
          otaResult.set(phase, phase === "validating" ? "\u6570\u636E\u5DF2\u4F20\u5B8C\uFF0C\u6B63\u5728\u7B49\u5F85\u8BBE\u5907\u6821\u9A8C\u3002\u6B64\u65F6\u8FD8\u4E0D\u80FD\u5224\u65AD\u5347\u7EA7\u5B8C\u6210\u3002" : phase === "sending" ? "\u6B63\u5728\u4F20\u8F93\uFF0C\u8BF7\u4FDD\u6301\u8BBE\u5907\u4F9B\u7535\u548C\u8FDE\u63A5\u3002" : "\u6B63\u5728\u7B49\u5F85 START \u786E\u8BA4\u2026");
          renderOtaStatus();
        }
      });
      otaResult.confirmed();
      renderOtaStatus();
      scheduleOtaVerification();
    } catch (error) {
      failed = true;
      otaLogLine(error.message);
      otaResult.set(error.otaResultUnknown ? "unconfirmed" : "failed", error.message);
      renderOtaStatus();
      if (error.otaResultUnknown) scheduleOtaVerification();
    } finally {
      stopOtaRate();
      state.otaBusy = false;
      (_b = state.controller) == null ? void 0 : _b.resumeAfterOta(failed);
      refreshAll();
      refreshConnectButtons();
      renderOtaStatus();
    }
  }
  async function runMockOta(channel) {
    var _a, _b;
    otaResult.start(otaFileName, channel, otaFileBytes);
    otaResult.set("sending", "\u6A21\u62DF\u6F14\u7EC3\uFF0C\u4E0D\u4F1A\u5411\u771F\u5B9E\u8BBE\u5907\u70E7\u5F55\u3002");
    resetOtaRate();
    startOtaRate(true);
    state.otaBusy = true;
    refreshAll();
    refreshConnectButtons();
    otaLogLine(`(\u6A21\u62DF) ${channel === "wifi" ? "WiFi \u70ED\u70B9" : channel === "ble" ? "\u84DD\u7259" : "\u4E32\u53E3"}\u5347\u7EA7\uFF1A${otaFileBytes.length} \u5B57\u8282`);
    const total = otaFileBytes.length;
    for (let pct = 0; pct <= 100; pct += 4) {
      await new Promise((r) => setTimeout(r, 80));
      setOtaProgress(total * pct / 100, total, "(\u6A21\u62DF\u4F20\u8F93)");
    }
    (_b = (_a = state.sim) == null ? void 0 : _a.exitApMode) == null ? void 0 : _b.call(_a);
    otaLogLine("(\u6A21\u62DF) \u8BBE\u5907\u5237\u673A\u5B8C\u6210\uFF0C\u91CD\u542F\u56DE\u6B63\u5E38\u6A21\u5F0F");
    stopOtaRate();
    state.otaBusy = false;
    otaResult.value.percent = 100;
    otaResult.set("mock_completed", "\u8FD9\u53EA\u662F\u6A21\u62DF\u6F14\u7EC3\uFF0C\u771F\u5B9E\u8BBE\u5907\u56FA\u4EF6\u6CA1\u6709\u66F4\u65B0\u3002");
    renderOtaStatus();
    refreshAll();
    refreshConnectButtons();
  }
  function finishWifiWait() {
    var _a;
    stopOtaRate();
    stopApProbeFn == null ? void 0 : stopApProbeFn();
    stopApProbeFn = null;
    state.wifiUploading = false;
    state.otaBusy = false;
    (_a = state.controller) == null ? void 0 : _a.resumeAfterOta();
    refreshAll();
    refreshConnectButtons();
    renderOtaStatus();
  }
  function beginWifiProbe() {
    resetOtaRate();
    otaResult.set("waiting_ap", "\u7535\u8111\u8FDE\u63A5 LEBREW-AW \u540E\u4F1A\u81EA\u52A8\u4E0A\u4F20\u3002\u5C1A\u672A\u5F00\u59CB\u70E7\u5F55\u3002");
    renderOtaStatus();
    stopApProbeFn == null ? void 0 : stopApProbeFn();
    state.otaBusy = true;
    refreshAll();
    refreshConnectButtons();
    stopApProbeFn = startApProbe(
      (text) => {
        $("wifiProbeStatus").textContent = text;
      },
      async () => {
        state.wifiUploading = true;
        otaResult.set("sending", "\u6B63\u5728\u901A\u8FC7 WiFi \u4E0A\u4F20\u56FA\u4EF6\uFF0C\u8BF7\u4FDD\u6301\u8BBE\u5907\u4F9B\u7535\u3002");
        renderOtaStatus();
        $("wifiProbeStatus").textContent = "\u5DF2\u786E\u8BA4 LEBREW-AW\uFF0C\u6B63\u5728\u4E0A\u4F20\u2026";
        $("wifiRetry").disabled = true;
        $("wifiCancel").disabled = true;
        startOtaRate();
        try {
          await uploadToFirmware(otaFileBytes, (loaded, total) => {
            setOtaProgress(Math.min(loaded, total - 1), total, `\u5DF2\u4E0A\u4F20 ${(loaded / 1024).toFixed(1)} KB\uFF0C\u7B49\u5F85\u8BBE\u5907\u6821\u9A8C`, loaded);
            if (loaded >= total) {
              stopOtaRate();
              otaResult.set("validating", "\u4E0A\u4F20\u5DF2\u5B8C\u6210\uFF0C\u7B49\u5F85\u8BBE\u5907\u6821\u9A8C\u7ED3\u679C\u3002");
              renderOtaStatus();
            }
          });
          setOtaProgress(otaFileBytes.length, otaFileBytes.length, "\u56FA\u4EF6\u6821\u9A8C\u6210\u529F");
          stopOtaRate();
          otaLogLine("WiFi \u5347\u7EA7\u6210\u529F\uFF0C\u8BBE\u5907\u5373\u5C06\u91CD\u542F\u3002\u8BF7\u91CD\u65B0\u8FDE\u63A5\u5E76\u6838\u5BF9\u7248\u672C\u3002");
          otaResult.confirmed();
          renderOtaStatus();
          scheduleOtaVerification();
        } catch (error) {
          otaLogLine("WiFi \u5347\u7EA7\u5931\u8D25\uFF1A" + error.message);
          otaResult.set(/^HTTP [45]/.test(error.message) ? "failed" : "unconfirmed", "\u672A\u6536\u5230\u6709\u6548\u7684\u6700\u7EC8\u786E\u8BA4\uFF1A" + error.message + "\u3002\u8BF7\u91CD\u8FDE\u8BBE\u5907\u540E\u6838\u5BF9\u8FD0\u884C\u56FA\u4EF6\u3002");
          renderOtaStatus();
        } finally {
          finishWifiWait();
        }
      },
      3e5,
      () => {
        otaResult.set("failed", "\u7B49\u5F85\u70ED\u70B9\u8D85\u65F6\uFF0C\u672A\u786E\u8BA4\u5347\u7EA7\u6210\u529F\u3002\u8BF7\u8FDE\u63A5 LEBREW-AW \u540E\u91CD\u65B0\u68C0\u6D4B\u3002");
        renderOtaStatus();
        finishWifiWait();
      }
    );
  }
  async function startWifiUpgrade() {
    var _a, _b, _c;
    if (state.otaBusy) return;
    if (!otaFileBytes) return otaLogLine("\u8BF7\u5148\u9009\u62E9 .bin \u56FA\u4EF6\u6587\u4EF6");
    if (state.mock) return runMockOta("wifi");
    try {
      validateFirmwareImage(otaFileBytes);
    } catch (error) {
      return otaLogLine(error.message);
    }
    const transport = ((_a = state.ble) == null ? void 0 : _a.isConnected) ? state.ble : ((_b = state.serial) == null ? void 0 : _b.isConnected) ? state.serial : null;
    if (!transport && !state.wifiApRequested) return otaLogLine("\u8BF7\u5148\u8FDE\u63A5\u84DD\u7259\u6216\u4E32\u53E3\uFF0C\u518D\u53D1\u9001\u8FDB\u5165\u70ED\u70B9\u6A21\u5F0F\u6307\u4EE4");
    try {
      otaResult.start(otaFileName, "wifi", otaFileBytes);
      resetOtaRate();
      renderOtaStatus();
      if (transport) {
        (_c = state.controller) == null ? void 0 : _c.pauseForOta();
        state.otaBusy = true;
        refreshAll();
        refreshConnectButtons();
        if (!await requestApMode(transport)) throw new Error("\u8BBE\u5907\u62D2\u7EDD\u8FDB\u5165\u70ED\u70B9\u6A21\u5F0F");
        state.wifiApRequested = true;
        otaLogLine("\u8FDB\u5165\u70ED\u70B9\u6307\u4EE4\u5DF2\u786E\u8BA4\uFF0C\u8BF7\u7528\u8BBE\u5907\u914D\u5957\u5BC6\u7801\u8FDE\u63A5 LEBREW-AW");
      }
      $("wifiSteps").classList.remove("hidden");
      beginWifiProbe();
    } catch (error) {
      otaLogLine(error.message);
      otaResult.set("failed", error.message);
      renderOtaStatus();
      finishWifiWait();
    }
  }
  var logPanes = {
    ble: { el: () => $("logBle"), entries: [], hex: true, paused: false },
    serial: { el: () => $("logSerial"), entries: [], hex: true, paused: false }
  };
  function logPane(channel, dir, bytes) {
    const pane = logPanes[channel];
    if (!pane) return;
    pane.entries.push({ t: /* @__PURE__ */ new Date(), dir, bytes: bytes.slice() });
    if (pane.entries.length > 400) pane.entries.shift();
    pane.dirty = true;
  }
  setInterval(() => {
    for (const pane of Object.values(logPanes)) if (pane.dirty && !pane.paused) renderLog(pane);
  }, 200);
  function renderLog(pane) {
    const lines = pane.entries.slice(-200).map((entry) => {
      const time = entry.t.toTimeString().slice(0, 8) + "." + String(entry.t.getMilliseconds()).padStart(3, "0");
      const body = trafficPreview(entry.bytes, pane.hex);
      return time + " " + entry.dir.padEnd(2) + " " + body;
    });
    const el = pane.el();
    el.textContent = lines.join("\n") || "\uFF08\u6682\u65E0\u6570\u636E\uFF09";
    el.scrollTop = el.scrollHeight;
    pane.dirty = false;
  }
  function attachTransportLogging(transport, channel) {
    transport.on("tx", ({ bytes }) => logPane(channel, "TX", bytes));
    transport.on("rx", ({ bytes }) => logPane(channel, "RX", bytes));
  }
  function patchTransportLogging(transport, channel) {
    if (!transport || transport._awLogPatched) return;
    transport._awLogPatched = true;
    const originalWrite = transport.write.bind(transport);
    transport.write = async (bytes) => {
      logPane(channel, "TX", bytes);
      return originalWrite(bytes);
    };
    transport.on("data", ({ bytes }) => logPane(channel, "RX", bytes));
    attachTransportLogging(transport, channel);
  }
  function logDiag(message) {
    const line = (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8) + " DIAG " + message;
    for (const pane of Object.values(logPanes)) {
      pane.entries.push({ t: /* @__PURE__ */ new Date(), dir: "DG", bytes: new TextEncoder().encode(message) });
      if (!pane.paused) renderLog(pane);
    }
  }
  var bannerTimer = null;
  function banner(text, kind = "warn") {
    if (!text) return;
    $("bannerText").textContent = text;
    $("banner").className = "banner " + kind;
    $("banner").classList.remove("hidden");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => $("banner").classList.add("hidden"), 8e3);
  }
  function setDeviceInfo(text) {
    $("deviceInfo").textContent = text;
  }
  function fmt(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "--";
  }
  function refreshAll() {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    refreshDeviceControls();
    refreshMeasurementControls();
    refreshSnControls();
    refreshCaptureUi();
    refreshFits();
    $("btnWrite").disabled = !((_a = state.controller) == null ? void 0 : _a.isConnected) || !sessionReportCache;
    $("btnResetParams").disabled = !((_b = state.controller) == null ? void 0 : _b.isConnected);
    $("btnExport").disabled = !((_e = (_d = (_c = state.controller) == null ? void 0 : _c.session) == null ? void 0 : _d.captureResults) == null ? void 0 : _e.length);
    $("btnReadInfo").disabled = !((_f = state.controller) == null ? void 0 : _f.isConnected);
    $("btnReadParams").disabled = !((_g = state.controller) == null ? void 0 : _g.isConnected);
    $("telemetryOn").disabled = !((_h = state.controller) == null ? void 0 : _h.isConnected) || state.otaBusy;
    $("useMock").disabled = state.otaBusy;
    $("requiredRuns").disabled = state.otaBusy;
    for (const id of ["otaSerial", "otaBle", "otaWifi", "otaFile", "btnReadInfo", "btnReadParams", "btnWrite", "btnResetParams", "btnCancel"]) {
      if (state.otaBusy) $(id).disabled = true;
    }
    if (state.otaBusy) for (const button of $("pointsGrid").querySelectorAll("button")) button.disabled = true;
    $("otaSerial").disabled = state.otaBusy;
    $("otaBle").disabled = state.otaBusy;
    $("otaWifi").disabled = state.otaBusy;
    $("otaFile").disabled = state.otaBusy;
    $("wifiRetry").disabled = !!state.wifiUploading;
    $("wifiCancel").disabled = !state.otaBusy || !!state.wifiUploading;
    if (measurementLocked()) {
      for (const id of ["btnWrite", "btnResetParams", "otaSerial", "otaBle", "otaWifi", "otaFile"]) $(id).disabled = true;
      for (const button of $("pointsGrid").querySelectorAll("button")) button.disabled = true;
    }
  }
  function setSnStatus(text, tone = "") {
    $("snStatus").textContent = text;
    $("snStatus").className = "sn-status " + tone;
  }
  function snCounterKey() {
    return `aw_sn_DT01_${$("snDate").value}_${$("snLine").value}`;
  }
  function refreshSnCandidate() {
    const parts = $("snDate").value.split("-").map(Number);
    const date = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : /* @__PURE__ */ new Date(NaN);
    const candidate = snGenerate({ date, line: $("snLine").value, sequence: Number($("snSequence").value) });
    $("snCandidate").textContent = candidate || "\u65E5\u671F\u3001\u4EA7\u7EBF\u6216\u6D41\u6C34\u53F7\u65E0\u6548";
    refreshSnControls();
  }
  function refreshSnControls() {
    var _a;
    const connected = !!((_a = state.controller) == null ? void 0 : _a.isConnected);
    const busy = state.snBusy || state.otaBusy || !!(captureState == null ? void 0 : captureState.active) || measurementLocked();
    $("snRead").disabled = !connected || busy;
    $("snWrite").disabled = !connected || busy || state.sn !== "" || !snValidate($("snCandidate").textContent);
    for (const id of ["snDate", "snLine", "snSequence"]) $(id).disabled = state.snBusy || state.otaBusy;
  }
  function loadSnCounter() {
    try {
      $("snSequence").value = localStorage.getItem(snCounterKey()) || 1;
    } catch {
      $("snSequence").value = 1;
    }
    refreshSnCandidate();
  }
  $("snDate").value = (/* @__PURE__ */ new Date()).toLocaleDateString("sv-SE");
  $("snDate").addEventListener("change", loadSnCounter);
  $("snLine").addEventListener("input", () => {
    $("snLine").value = $("snLine").value.toUpperCase();
    loadSnCounter();
  });
  $("snSequence").addEventListener("input", refreshSnCandidate);
  $("snRead").addEventListener("click", () => {
    var _a;
    state.sn = null;
    setSnStatus("\u6B63\u5728\u8BFB\u53D6\u8BBE\u5907 SN\u2026");
    refreshSnControls();
    (_a = state.controller) == null ? void 0 : _a.readSn();
  });
  $("snWrite").addEventListener("click", () => {
    var _a;
    const sn = $("snCandidate").textContent;
    if (state.sn !== "" || !snValidate(sn) || !((_a = state.controller) == null ? void 0 : _a.isConnected)) return;
    state.snBusy = true;
    state.snExpected = sn;
    setSnStatus("\u6B63\u5728\u5199\u5165\u5E76\u56DE\u8BFB SN\uFF0C\u8BF7\u4FDD\u6301\u8FDE\u63A5\u2026");
    refreshSnControls();
    try {
      if (state.controller.writeSn(sn) == null) throw new Error("SN \u8BF7\u6C42\u672A\u53D1\u9001");
    } catch (error) {
      state.snBusy = false;
      state.snExpected = null;
      setSnStatus(error.message, "err");
      refreshSnControls();
    }
  });
  loadSnCounter();
  $("requiredRuns").addEventListener("change", () => {
    const count = Number($("requiredRuns").value);
    if (![1, 2, 3].includes(count)) return;
    state.requiredRunsPerPoint = count;
    state.selectedFit = null;
    $("requiredRunsHint").textContent = String(count);
    try {
      localStorage.setItem(CAPTURE_RUNS_STORAGE_KEY, String(count));
    } catch {
    }
    if (state.controller) {
      try {
        state.controller.setRequiredRunsPerPoint(count);
      } catch (error) {
        banner(error.message, "err");
      }
    }
    refreshAll();
  });
  $("btnBle").addEventListener("click", async () => {
    if (state.connecting || state.disconnecting || state.otaBusy) return;
    if (state.activeTransport === "ble") {
      disconnectAll();
      return;
    }
    try {
      await connect("ble");
      patchTransportLogging(state.ble, "ble");
    } catch (error) {
      setDeviceInfo("\u84DD\u7259\u8FDE\u63A5\u5931\u8D25\uFF1A" + ((error == null ? void 0 : error.message) || error.code));
    }
  });
  $("btnSerial").addEventListener("click", async () => {
    if (state.connecting || state.disconnecting || state.otaBusy) return;
    if (state.activeTransport === "serial" || state.activeTransport === "sim") {
      disconnectAll();
      return;
    }
    try {
      await connect("serial");
      patchTransportLogging(state.serial, "serial");
    } catch (error) {
      setDeviceInfo("\u4E32\u53E3\u8FDE\u63A5\u5931\u8D25\uFF1A" + ((error == null ? void 0 : error.message) || error.code));
    }
  });
  $("useMock").addEventListener("change", async (event) => {
    state.mock = event.target.checked;
    await disconnectAll();
    if (state.mock) {
      try {
        await connect("sim");
        patchTransportLogging(state.sim, "serial");
      } catch (error) {
        setDeviceInfo("\u6A21\u62DF\u8BBE\u5907\u542F\u52A8\u5931\u8D25\uFF1A" + error.message);
      }
    }
  });
  $("btnCancel").addEventListener("click", () => {
    var _a;
    cancelAutoRetry();
    (_a = state.controller) == null ? void 0 : _a.cancelCapture();
  });
  $("btnWrite").addEventListener("click", writeSelected);
  $("btnResetParams").addEventListener("click", () => {
    var _a;
    if (confirm("\u786E\u8BA4\u6062\u590D K=1 / B=0\uFF1F\u65E7\u9732\u70B9\u6821\u51C6\u5C06\u5931\u6548\u3002")) (_a = state.controller) == null ? void 0 : _a.resetParameters();
  });
  $("btnExport").addEventListener("click", exportSession);
  $("btnReadInfo").addEventListener("click", () => {
    var _a;
    return (_a = state.controller) == null ? void 0 : _a.readInfo();
  });
  $("btnReadParams").addEventListener("click", () => {
    var _a;
    return (_a = state.controller) == null ? void 0 : _a.readParameters();
  });
  $("btnSaveMaster").addEventListener("click", saveMaster);
  $("btnRecompute").addEventListener("click", refreshFits);
  $("measureBean").addEventListener("change", () => {
    try {
      state.measureBeanEdited = true;
      state.measurePending = true;
      state.measureError = "";
      state.controller.selectBean(Number($("measureBean").value));
      refreshAll();
    } catch (error) {
      state.measurePending = false;
      state.measureBeanEdited = false;
      if (state.measure) $("measureBean").value = String(state.measure.beanId);
      refreshAll();
      banner(error.message, "warn");
    }
  });
  $("deviceLanguage").addEventListener("change", () => {
    state.deviceLanguageEdited = true;
  });
  $("deviceStandby").addEventListener("change", () => {
    state.deviceStandbyEdited = true;
  });
  $("deviceRead").addEventListener("click", () => {
    var _a;
    state.deviceLanguageEdited = false;
    state.deviceStandbyEdited = false;
    (_a = state.controller) == null ? void 0 : _a.readDeviceControl();
  });
  $("deviceApplyLanguage").addEventListener("click", () => applyDeviceControl(1, Number($("deviceLanguage").value)));
  $("deviceApplyStandby").addEventListener("click", () => applyDeviceControl(2, Number($("deviceStandby").value)));
  $("deviceCalMd").addEventListener("click", () => openDeviceCalibration(3));
  $("deviceCalAw").addEventListener("click", () => openDeviceCalibration(4));
  $("deviceCalDismiss").addEventListener("click", () => $("deviceCalDialog").close());
  $("deviceCalDialog").addEventListener("close", () => {
    state.calDialogAction = null;
  });
  $("deviceCalConfirm").addEventListener("click", () => {
    const action = state.calDialogAction;
    $("deviceCalDialog").close();
    if ([3, 4].includes(action)) applyDeviceControl(action, 0);
  });
  $("measureMd").addEventListener("click", () => startDeviceMeasurement(1));
  $("measureAll").addEventListener("click", () => startDeviceMeasurement(3));
  for (const toggle of document.querySelectorAll(".panel-toggle")) {
    toggle.addEventListener("click", () => {
      const body = $(toggle.getAttribute("aria-controls"));
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      body.hidden = !expanded;
      toggle.closest(".card").classList.toggle("collapsed", !expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      const title = toggle.closest("h2").firstChild.textContent.trim();
      toggle.textContent = expanded ? "\u6536\u8D77" : "\u5C55\u5F00";
      toggle.setAttribute("aria-label", `${expanded ? "\u6536\u8D77" : "\u5C55\u5F00"}${title}`);
      requestAnimationFrame(() => {
        drawCharts();
      });
    });
  }
  $("telemetryOn").addEventListener("change", (event) => {
    state.telemetryOn = event.target.checked;
  });
  $("chartWindow").addEventListener("change", () => {
    trimSeries();
    chartsDirty = true;
  });
  $("chartPause").addEventListener("click", () => {
    state.chartPaused = !state.chartPaused;
    $("chartPause").textContent = state.chartPaused ? "\u7EE7\u7EED" : "\u6682\u505C";
  });
  $("chartExport").addEventListener("click", exportChartCsv);
  $("mdExport").addEventListener("click", () => {
    var _a, _b;
    const session = (_a = state.controller) == null ? void 0 : _a.session;
    if (!((_b = session == null ? void 0 : session.mdTelemetry) == null ? void 0 : _b.length)) return;
    const text = moistureCsv(session.mdTelemetry, session.deviceId);
    download(new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" }), `moisture_delta_${Date.now()}.csv`);
  });
  $("otaFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    otaFileBytes = new Uint8Array(await file.arrayBuffer());
    otaFileName = file.name;
    try {
      validateFirmwareImage(otaFileBytes);
    } catch (error) {
      otaFileBytes = null;
      return otaLogLine(error.message);
    }
    otaLogLine("\u5DF2\u9009\u62E9\u56FA\u4EF6\uFF1A" + file.name + "\uFF08" + otaFileBytes.length + " \u5B57\u8282\uFF09");
    renderOtaStatus();
  });
  $("otaSerial").addEventListener("click", () => runOta("serial"));
  $("otaBle").addEventListener("click", () => runOta("ble"));
  $("otaWifi").addEventListener("click", startWifiUpgrade);
  $("wifiRetry").addEventListener("click", () => {
    if (otaFileBytes) beginWifiProbe();
  });
  $("wifiCancel").addEventListener("click", () => {
    otaResult.set("cancelled", "\u672A\u5B8C\u6210\u5347\u7EA7\u3002\u53EF\u91CD\u65B0\u68C0\u6D4B\u70ED\u70B9\u7EE7\u7EED\u4E0A\u4F20\uFF0C\u6216\u91CD\u542F\u8BBE\u5907\u56DE\u5230\u6B63\u5E38\u6A21\u5F0F\u3002");
    renderOtaStatus();
    finishWifiWait();
    otaLogLine("\u5DF2\u505C\u6B62\u7B49\u5F85\u70ED\u70B9\uFF1B\u8BBE\u5907\u4ECD\u5904\u4E8E\u70ED\u70B9\u6A21\u5F0F\uFF0C\u53EF\u91CD\u65B0\u68C0\u6D4B\u6216\u65AD\u7535\u56DE\u6B63\u5E38\u6A21\u5F0F");
  });
  $("otaVerify").addEventListener("click", () => {
    var _a;
    if (!((_a = state.controller) == null ? void 0 : _a.isConnected)) return banner("\u8BF7\u5148\u70B9\u51FB\u9876\u90E8\u8FDE\u63A5\u84DD\u7259\u6216\u8FDE\u63A5\u4E32\u53E3\uFF0C\u518D\u6838\u5BF9\u5347\u7EA7\u7ED3\u679C", "warn");
    if (otaFileBytes && (!otaResult.canVerify || firmwareIdentity(otaFileBytes).sha256 !== otaResult.value.sha256)) {
      otaResult.start(otaFileName, "verify", otaFileBytes);
      otaResult.value.verifyOnly = true;
      otaResult.set("unconfirmed", "\u4EC5\u6838\u5BF9\u5F53\u524D\u8FD0\u884C\u56FA\u4EF6\uFF0C\u4E0D\u6267\u884C\u70E7\u5F55\u3002");
      renderOtaStatus();
    }
    scheduleOtaVerification(0);
  });
  for (const button of document.querySelectorAll(".logfmt")) {
    button.addEventListener("click", () => {
      const pane = logPanes[button.dataset.ch];
      pane.hex = !pane.hex;
      button.textContent = pane.hex ? "HEX" : "\u6587\u672C";
      renderLog(pane);
    });
  }
  for (const button of document.querySelectorAll(".logpause")) {
    button.addEventListener("click", () => {
      const pane = logPanes[button.dataset.ch];
      pane.paused = !pane.paused;
      button.textContent = pane.paused ? "\u7EE7\u7EED" : "\u6682\u505C";
      if (!pane.paused) renderLog(pane);
    });
  }
  for (const button of document.querySelectorAll(".logclear")) {
    button.addEventListener("click", () => {
      const pane = logPanes[button.dataset.ch];
      pane.entries = [];
      renderLog(pane);
    });
  }
  $("bannerClose").addEventListener("click", () => $("banner").classList.add("hidden"));
  window.addEventListener("pagehide", () => {
    var _a, _b, _c;
    if ((_c = (_b = (_a = state.ble) == null ? void 0 : _a.device) == null ? void 0 : _b.gatt) == null ? void 0 : _c.connected) state.ble.device.gatt.disconnect();
  });
  loadMaster();
  try {
    const storedRuns = Number(localStorage.getItem(CAPTURE_RUNS_STORAGE_KEY));
    if ([1, 2, 3].includes(storedRuns)) state.requiredRunsPerPoint = storedRuns;
  } catch {
  }
  $("requiredRuns").value = String(state.requiredRunsPerPoint);
  $("requiredRunsHint").textContent = String(state.requiredRunsPerPoint);
  buildPointsUi();
  buildMasterUi();
  refreshCaptureUi();
  refreshFits();
  drawCharts();
  var autoSerialTarget = new URLSearchParams(location.search).get("serial_device");
  var restoreSerial = false;
  try {
    restoreSerial = localStorage.getItem("aw_serial_auto") === "1";
  } catch {
  }
  if (location.hash === "#autoserial" || restoreSerial && !["#autoble", "#noauto"].includes(location.hash)) {
    connect("serial", { authorizedOnly: true, expectedId: autoSerialTarget }).catch((error) => banner(error.message, "warn"));
  }
})();
