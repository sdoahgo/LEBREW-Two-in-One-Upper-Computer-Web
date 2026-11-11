// aw_sim.js — 模拟设备（simulator.py 的 JS 移植 + OTA/热点演练）
// 完整实现 v1 帧协议状态机：参数存取、四点采集（150 样本 @100ms、±0.015 噪声、480s 超时）、
// 遥测多项式、通知事件；并模拟串口/蓝牙 OTA 窗口 ACK 与 WiFi 热点升级模式，
// 不接硬件即可完整演练上位机全部功能。

import { Transport, TransportState } from './comm_link.js';
import {snValidate} from './sn_code.js';
import {packDeviceState,packDeviceControl,deviceControlActive} from './device_control.js';
import {packMeasurementState, unpackMeasurementControl, measurementActive} from './measurement_control.js';
import {
  Command,
  Status,
  StreamDecoder,
  encodeFrame,
  packCaptureProgress,
  packCaptureResult,
  packDeviceInfo,
  packDeviceParameters,
  packNotice,
  packOtaAck,
  packSetStreamResponse,
  packStartCaptureResponse,
  packTelemetry,
  packMdTelemetry,
  unpackOtaStartRequest,
  unpackSetParamsRequest,
  unpackSetStreamRequest,
  unpackStartCaptureRequest,
  OTA_MAX_CHUNK,
  ACK_WINDOW,
} from './aw_protocol.js';

const CAPTURE_CENTERS = [38.857, 59.780, 77.687, 98.787];
const SIM_COMMAND_KEY = new Uint8Array(16);
const REQUEST_COMMANDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 0x09, 0x0a, 0x0b, 0x0c, 0x0e,0x0f,0x10,0x11,0x12]);
const CAPTURE_SAMPLE_INTERVAL_MS = 100;
const CAPTURE_SAMPLE_COUNT = 150;
const PARAM_SCHEMA_VERSION = 1;
const CAPTURE_TIMEOUT_MS = 480000;

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function pstdev(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / values.length);
}

export class SimTransport extends Transport {
  constructor(options = {}) {
    super(options.name ?? 'SIM');
    this.deviceId = options.deviceId ?? 'SIM-AW-0001';
    this.sn=options.sn??'';
    this.firmwareVersion = 'sim-web-1.0';
    this.firmwareSha256 = 'a7'.repeat(32);
    this.apMode = false;
    this.otaLog = [];
    this._decoder = new StreamDecoder();
    this._slopeK = 1.0;
    this._offsetB = 0.0;
    this._paramVersion = PARAM_SCHEMA_VERSION;
    this._paramsValid = true;
    this._calDew = 0.0;
    this._calDewValid = true;
    this._streamEnabled = false;
    this._streamIntervalMs = 100;
    this._nextStreamAt = 0;
    this._sampleSequence = 0;
    this._eventSequence = 0;
    this._capture = null;
    this._deviceControl={phase:0,action:0,value:0,language:0,standbyMinutes:3,ready:true};
    this._measurement = {phase: 0, beanId: 0, mode: 0, deviceReady: true, resultFlags: 0};
    this._timer = null;
    this._startMs = 0;
    // 串口 OTA 裸包状态
    this._serialOta = null; // { total, chunk, received, expectedSeq, packetsInWindow }
    this._rawBuffer = new Uint8Array(0);
    // 蓝牙 OTA 状态（0x2A39/0x2A40 通道）
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
    this.disconnect().catch(() => {});
  }

  _emitBytes(frame) {
    this.emit('data', { transport: this, bytes: frame });
  }

  /** 上位机写入：串口裸帧，或 [16B 密钥][帧]（蓝牙演练路径自动剥密钥） */
  async write(data) {
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this._serialOta) {
      this._feedSerialOta(bytes);
      return;
    }
    if (bytes.length >= SIM_COMMAND_KEY.length + 4 &&
        SIM_COMMAND_KEY.every((byte, index) => bytes[index] === byte)) {
      bytes = bytes.slice(SIM_COMMAND_KEY.length);
    }
    for (const frame of this._decoder.feed(bytes)) {
      this._handleRequest(frame);
    }
  }

  /** 蓝牙 0x2A39 控制写（smoke 格式，可选 16B 密钥前缀——与固件行为一致，校验后剥离）；ACK 以 kind:'ctrl' 发出 */
  async writeControl(bytesInput) {
    let bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
    if (bytes.length >= SIM_COMMAND_KEY.length + 1 &&
        SIM_COMMAND_KEY.every((byte, index) => bytes[index] === byte)) {
      bytes = bytes.slice(SIM_COMMAND_KEY.length);
    }
    const notifyCtrl = (ack) => this.emit('data', {
      transport: this,
      bytes: Uint8Array.of(0xa0, ack ? 0 : 1, 0, 0),
      kind: 'ctrl',
    });
    if ((bytes[0] === 0x11 || (bytes[0] === 0x14 && this.fastBleOta)) && bytes.length >= 7) {
      const total = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
      const chunk = (bytes[5] << 8) | bytes[6];
      if (chunk > OTA_MAX_CHUNK || total < 32 || total > 0x340000) {
        this.emit('data', { transport: this, bytes: Uint8Array.of(0xa0, 1, 0, 0), kind: 'ctrl' });
        return;
      }
      this._bleOta = { total, chunk, received: 0, expectedSeq: 0, packetsInWindow: 0,
        ackWindow:bytes[0] === 0x14 ? 32 : ACK_WINDOW };
      this.otaLog.push(`(模拟) BLE OTA START：${total} 字节，chunk=${chunk}`);
      notifyCtrl(true);
    } else if (bytes[0] === 0x12) {
      const ok = this._bleOta && this._bleOta.received === this._bleOta.total;
      this.otaLog.push(`(模拟) BLE OTA END：${ok ? '校验通过，重启' : '字节数不符'}`);
      this.emit('data', { transport: this, bytes: Uint8Array.of(0xa0, ok ? 0 : 1, 0, 0), kind: 'ctrl' });
      if (ok) this._simulateReboot();
    } else if (bytes[0] === 0x13) {
      this._bleOta = null;
      this.otaLog.push('(模拟) BLE OTA ABORT');
      if(this.fastBleOta)this.emit('data',{transport:this,bytes:Uint8Array.of(0xa0,0,0,0,0xf1,1,32),kind:'ctrl'});
      else notifyCtrl(true);
    }
  }

  /** 蓝牙 0x2A40 数据写：[seq:2B BE][chunk]（末包含 0xFF 填充，按 total 裁掉） */
  async writeData(bytes) {
    const ota = this._bleOta;
    if (!ota) return;
    const seq = (bytes[0] << 8) | bytes[1];
    const chunk = bytes.slice(2);
    const ackOf = (ok, seq_) => this.emit('data', {
      transport: this,
      bytes: Uint8Array.of(0xa0, ok ? 0 : 1, (seq_ >> 8) & 0xff, seq_ & 0xff),
      kind: 'ctrl',
    });
    if (seq < ota.expectedSeq) { ackOf(true, ota.expectedSeq - 1); return; }
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
    if ((measurementActive(this._measurement) || deviceControlActive(this._deviceControl)) && [Command.START_CAPTURE, Command.SET_PARAMS,
      Command.RESET_PARAMS, Command.WRITE_SN, Command.OTA_START, Command.OTA_ENTER_AP].includes(command))
      return this._status(command, sequence, Status.BUSY);
    switch (command) {
      case Command.DEVICE_CONTROL: {
        const s=this._deviceControl;
        if(payload.length) {
          if(payload.length!==8) return this._status(command,sequence,Status.BAD_LENGTH);
          const requestId=new DataView(payload.buffer,payload.byteOffset,payload.byteLength).getUint32(4,true);
          try {packDeviceControl(payload[0],payload[1],requestId);if(payload[2]||payload[3])throw new Error();}
          catch{return this._status(command,sequence,Status.INVALID_PARAMETER);}
          const action=payload[0],value=payload[1];
          if(s.requestId===requestId) {
            if(s.action!==action||s.value!==value)return this._status(command,sequence,Status.INVALID_PARAMETER);
          } else {
            if(measurementActive(this._measurement)||deviceControlActive(s)||this._capture||this._serialOta||this._bleOta)return this._status(command,sequence,Status.BUSY);
            this._deviceControl={...s,action,value,requestId,elapsedMs:0,error:0,startedAt:this.now(),phase:action<=2?3:2,screenId:[0,value?20:7,8,11,12][action]};
            if(action===1)this._deviceControl.language=value;
            if(action===2)this._deviceControl.standbyMinutes=value;
          }
        }
        return this._respond(command,sequence,packDeviceState({...this._deviceControl,busy:deviceControlActive(this._deviceControl)||measurementActive(this._measurement)||!!this._capture}));
      }
      case Command.MEASUREMENT_CONTROL: {
        this._updateMeasurement();
        if (payload.length) {
          if (payload.length !== 8) return this._status(command, sequence, Status.BAD_LENGTH);
          let r;
          try { r = unpackMeasurementControl(payload); }
          catch { return this._status(command, sequence, Status.INVALID_PARAMETER); }
          const current = this._measurement;
          if(deviceControlActive(this._deviceControl)) return this._status(command,sequence,Status.BUSY);
          if (r.action === 3) {
            if (measurementActive(current) || this._capture || this._serialOta || this._bleOta)
              return this._status(command, sequence, Status.BUSY);
            this.beanId = r.beanId;
            this._measurement = {phase: 0, beanId: r.beanId, mode: 0, requestId: r.requestId,
              resultFlags: 0, deviceReady: true, elapsedMs: 0, screenId: 2};
          } else if (r.action === 1) {
            if (current.requestId === r.requestId) {
              if (current.beanId !== r.beanId || current.mode !== r.mode)
                return this._status(command, sequence, Status.INVALID_PARAMETER);
            } else {
              if (measurementActive(current) || this._capture || this._serialOta || this._bleOta)
                return this._status(command, sequence, Status.BUSY);
              this.beanId = r.beanId;
              this._measurement = {...r, phase: 2, resultFlags: 0, deviceReady: true,
                elapsedMs: 0, startedAt: this.now(), screenId: 2};
            }
          } else {
            if (current.requestId !== r.requestId) return this._status(command, sequence, Status.INVALID_PARAMETER);
            if (measurementActive(current)) current.phase = 4;
          }
        }
        return this._respond(command, sequence, packMeasurementState(this._measurement));
      }
      case Command.GET_FIRMWARE_ID: {
        if(payload.length)return this._status(command,sequence,Status.BAD_LENGTH);
        const response=new Uint8Array(37);
        response.set(this.firmwareSha256.match(/../g).map(x=>parseInt(x,16)),1);
        new DataView(response.buffer).setUint32(33,this.now(),true);
        return this._respond(command,sequence,response);
      }
      case Command.READ_SN: {
        if(payload.length)return this._status(command,sequence,Status.BAD_LENGTH);
        const sn=this.sn;
        const text=new TextEncoder().encode(sn);
        return this._respond(command,sequence,Uint8Array.of(0,text.length,...text));
      }
      case Command.WRITE_SN: {
        if(payload.length!==18)return this._status(command,sequence,Status.BAD_LENGTH);
        const sn=new TextDecoder().decode(payload);
        if(!snValidate(sn))return this._status(command,sequence,Status.INVALID_PARAMETER);
        if(this._capture)return this._status(command,sequence,Status.BUSY);
        if(this.sn&&this.sn!==sn)return this._status(command,sequence,Status.SN_LOCKED);
        this.sn=sn;this.deviceId=sn;return this._status(command,sequence,Status.OK);
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
        if (request.slopeK < 0.25 || request.slopeK > 4.0 || request.offsetB < -100 || request.offsetB > 100) {
          return this._status(command, sequence, Status.INVALID_PARAMETER);
        }
        this._slopeK = request.slopeK;
        this._offsetB = request.offsetB;
        this._calDew = 0.0;
        this._calDewValid = false;
        this._respond(command, sequence, this._packParams());
        this._event(Command.NOTICE, packNotice(1));
        this._event(Command.NOTICE, packNotice(2));
        return;
      }
      case Command.RESET_PARAMS:
        if (payload.length) return this._status(command, sequence, Status.BAD_LENGTH);
        this._slopeK = 1.0;
        this._offsetB = 0.0;
        this._calDew = 0.0;
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
          samples: [],
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
        if (request.intervalMs < 100 || request.intervalMs > 1000) {
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
        if (request.chunkSize > OTA_MAX_CHUNK || request.totalBytes < 32 || request.totalBytes > 0x340000) {
          return this._status(command, sequence, Status.INVALID_PARAMETER);
        }
        this._serialOta = {
          total: request.totalBytes,
          chunk: request.chunkSize,
          received: 0,
          expectedSeq: 0,
          packetsInWindow: 0,
        };
        this.otaLog.push(`(模拟) 串口 OTA START：${request.totalBytes} 字节，chunk=${request.chunkSize}`);
        return this._respond(command, sequence, this.fastSerialOta ? Uint8Array.of(Status.OK,0xf2,1,ACK_WINDOW) : Uint8Array.of(Status.OK));
      }
      case Command.OTA_END: {
        const ok = this._serialOta && this._serialOta.received === this._serialOta.total;
        this.otaLog.push(`(模拟) 串口 OTA END：${ok ? '校验通过，切分区重启' : '字节数不符'}`);
        this._respond(command, sequence, Uint8Array.of(ok ? Status.OK : Status.INVALID_PARAMETER));
        if (ok) this._simulateReboot();
        return;
      }
      case Command.OTA_ABORT:
        this._serialOta = null;
        this.otaLog.push('(模拟) 串口 OTA ABORT');
        return this._respond(command, sequence, Uint8Array.of(Status.OK));
      case Command.OTA_ENTER_AP:
        this._respond(command, sequence, Uint8Array.of(Status.OK));
        this.apMode = true;
        this.emit('log', { transport: this, text: 'AP:REBOOTING' });
        this.otaLog.push('(模拟) 进入热点升级模式：LEBREW-AW / 192.168.4.1');
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
    for (;;) {
      if (buffer.length === 0) break;
      if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xff) {
        if (buffer.length < 3) break;
        const isEnd = buffer[2] === 0x12;
        buffer = buffer.slice(3);
        this._serialOta = null;
        if (isEnd) {
          const ok = ota.received === ota.total;
          this.otaLog.push(`(模拟) 串口 OTA END：${ok ? '校验通过，切分区重启' : '字节数不符（' + ota.received + '/' + ota.total + '）'}`);
          this._emitBytes(this._frame(0x8a, Uint8Array.of(ok ? Status.OK : Status.INVALID_PARAMETER), 0));
          if (ok) this._simulateReboot();
        } else {
          this.otaLog.push('(模拟) 串口 OTA ABORT');
          this._emitBytes(this._frame(0x8b, Uint8Array.of(Status.OK), 0));
        }
        this._rawBuffer = buffer;
        return;
      }
      const packetLength = 2 + ota.chunk;
      if (buffer.length < packetLength) break;
      const seq = (buffer[0] << 8) | buffer[1];
      const chunk = buffer.slice(2, packetLength);
      buffer = buffer.slice(packetLength);
      if (seq < ota.expectedSeq) { this._event(Command.OTA_ACK, packOtaAck(true, ota.expectedSeq - 1)); continue; }
      if (seq !== ota.expectedSeq) {
        this._event(Command.OTA_ACK, packOtaAck(false, ota.expectedSeq));
        this._rawBuffer = buffer;
        return; // 丢掉后续直到重发对齐
      }
      // 设备按 total 裁掉末包的 0xFF 填充
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
      // 模拟重启：清流/采集状态，旧连接自然失效由用户重连
      this._capture = null;
      this._deviceControl={phase:0,action:0,value:0,language:this._deviceControl.language,standbyMinutes:this._deviceControl.standbyMinutes,ready:true};
    this._measurement = {phase: 0, beanId: 0, mode: 0, deviceReady: true, resultFlags: 0};
      this._streamEnabled = false;
      this._serialOta = null;
      this._bleOta = null;
      this._rawBuffer = new Uint8Array(0);
    };
    setTimeout(finish, 400);
  }

  // —— 周期事件（遥测 + 采集采样），由 50ms 定时器驱动 ——

  _updateDeviceControl() {
    const s=this._deviceControl;
    if(!deviceControlActive(s))return;
    s.elapsedMs=Math.max(0,this.now()-s.startedAt);
    if(s.elapsedMs>=3000) {s.phase=3;s.screenId=s.action===3?16:17;}
  }

  _updateMeasurement() {
    const m = this._measurement;
    if (!measurementActive(m)) return;
    m.elapsedMs = Math.max(0, this.now() - m.startedAt);
    if ((m.mode & 1) && m.elapsedMs >= 1200) {
      m.resultFlags |= 1;
      m.moisture = [2.4, 11.5, 15.0, 12.0][m.beanId];
      m.density = [420, 650, 370, 310][m.beanId];
    }
    if ((m.mode & 2) && m.elapsedMs >= 3000) { m.resultFlags |= 2; m.aw = .42; }
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
        Math.floor((now - capture.startedAt) / CAPTURE_SAMPLE_INTERVAL_MS),
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
      meanRhRaw: mean(capture.samples),
      stddevRhRaw: pstdev(capture.samples),
    });
  }

  _captureResult(resultCode) {
    const capture = this._capture;
    const center = CAPTURE_CENTERS[capture.pointId];
    const samples = capture.samples;
    const meanRaw = samples.length ? mean(samples) : center;
    const elapsed = Math.max(0, this.now() - capture.startedAt);
    this._event(Command.CAPTURE_RESULT, packCaptureResult({
      pointId: capture.pointId,
      resultCode,
      captureId: capture.captureId,
      sampleCount: samples.length,
      elapsedMs: elapsed,
      meanRhRaw: meanRaw,
      meanRhCorrected: this._slopeK * meanRaw + this._offsetB,
      stddevRhRaw: samples.length ? pstdev(samples) : 0.0,
    }));
  }

  _telemetryFrame() {
    this._sampleSequence = (this._sampleSequence + 1) >>> 0;
    const raw = CAPTURE_CENTERS[0] + (Math.random() * 0.04 - 0.02);
    const corrected = this._slopeK * raw + this._offsetB;
    const awUnclamped = awPolynomial(corrected) - this._calDew;
    const flags = 0x01 | (this._paramsValid ? 0x02 : 0) | (this._calDewValid ? 0x04 : 0);
    this._event(Command.TELEMETRY, packTelemetry({
      flags,
      sampleSequence: this._sampleSequence,
      temperatureC: 25.0,
      humidityRaw: raw,
      humidityCorrected: corrected,
      awUnclamped,
      awFinal: awFinal(corrected, awUnclamped),
    }));
    this._event(Command.MD_TELEMETRY, packMdTelemetry({
      flags: 15, beanId: this.beanId ?? 1, sampleSequence: this._sampleSequence,
      moisturePct: 10.25 + Math.random() * 0.02, densityGl: 680,
      capacitancePf: 15.123456, weightAdc: 123456, weightG: 108.62,
      emptyCapacitancePf: 2.75, deltaCapacitancePf: 15.123456 - 2.75,
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
      calDew: this._calDew,
    });
  }

  _respond(command, sequence, payload) {
    this._emitBytes(this._frame(command | 0x80, payload, sequence));
  }

  _status(command, sequence, status) {
    this._respond(command, sequence, Uint8Array.of(status));
  }

  _event(command, payload) {
    this._eventSequence = this._eventSequence >= 0xffff ? 1 : this._eventSequence + 1;
    this._emitBytes(this._frame(command, payload, this._eventSequence));
  }

  _frame(command, payload, sequence) {
    return encodeFrame(command, sequence, payload);
  }
}

// —— 水活换算（与 simulator.py 常数一致）——

function awPolynomial(humidity) {
  return ((-0.000004422697519 * humidity + 0.000868044735923)
    * humidity - 0.041082199067613) * humidity + 0.859771431117290;
}

function awFinal(correctedHumidity, awUnclamped) {
  if (correctedHumidity <= 31.015400) return 0.288660;
  if (correctedHumidity >= 95.210000) return 1.0;
  return Math.min(1.0, Math.max(0.288660, awUnclamped));
}
