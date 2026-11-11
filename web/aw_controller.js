// aw_controller.js — 标定控制器（controller.py 的 JS 移植）
// 语义逐条对齐 v2026.10.13-r2：
//   · 请求按序号关联，应答命令 = 请求 | 0x80；
//   · 单次应答等待 5s；GET_INFO / GET_PARAMS / SET_STREAM 自动重试 2 次（保留原序号）；
//   · START_CAPTURE 额外 10s 宽限，期间可用同点位、同 capture_id 的进度/结果确认开始；
//   · 迟到的有效应答在总期限内仍可完成请求；
//   · SET_PARAMS 成功后自动回读校验（1e-6 容差），RESET_PARAMS 校验 K=1/B=0；
//   · K/B 写入与恢复命令不会被自动重发；心跳每 2s 一次且不重发；
//   · 每点稳定采集次数可选 1/2/3（默认 3），达到所选次数后产出双拟合报告。
// 线程模型差异：Python 靠锁 + poll_events 队列；JS 单线程事件循环，由 app.js 定时调 tick()。

import { Emitter } from './comm_link.js';
import {
  Command,
  Status,
  StreamDecoder,
  encodeFrame,
  responseCommand,
  packSetParamsRequest,
  packSetStreamRequest,
  packStartCaptureRequest,
  unpackCaptureProgress,
  unpackCaptureResult,
  unpackDeviceInfo,
  unpackDeviceParameters,
  unpackNotice,
  unpackSetStreamResponse,
  unpackStartCaptureResponse,
  unpackTelemetry,
  unpackMdTelemetry,
} from './aw_protocol.js';
import { calculateReport, aggregateAcceptedRuns } from './aw_calculus.js';
import {snValidate,unpackSn} from './sn_code.js';
import {packDeviceControl,unpackDeviceState,deviceControlActive} from './device_control.js';
import {packMeasurementControl, unpackMeasurementState, measurementActive} from './measurement_control.js';

const UINT64_MASK = (1n << 64n) - 1n;
const SAFE_RETRY_COMMANDS = new Set([Command.GET_INFO, Command.GET_FIRMWARE_ID, Command.READ_SN, Command.GET_PARAMS, Command.SET_STREAM]);
export const OPERATION_LABELS = Object.freeze({
  read_device_control:'读取设备设置',device_control:'设备设置与校准',
  select_bean: '切换设备豆种', read_measurement: '读取设备测量状态', start_measurement: '启动设备测量', cancel_measurement: '取消设备测量',
  read_firmware_identity: '核对运行固件',
  read_sn:'读取 SN',write_sn:'写入 SN',sn_readback:'SN 写后回读',
  read_info: '读取设备信息', read_parameters: '读取参数',
  write_readback: '写后回读', enable_stream: '开启实时数据',
  start_capture: '开始采集', cancel_capture: '取消采集',
  write_parameters: '写入参数', reset_parameters: '恢复参数',
});

/** uint64 全周期置换发生器（非零值不重复，无历史记录）— 对齐 _CaptureIdGenerator。 */
class CaptureIdGenerator {
  constructor() {
    this.state = randomUint64();
    this.increment = randomUint64() | 1n;
  }

  next() {
    for (;;) {
      this.state = (this.state + this.increment) & UINT64_MASK;
      if (this.state !== 0n) return this.state;
    }
  }
}

function randomUint64() {
  const bytes = new Uint8Array(8);
  (globalThis.crypto ?? { getRandomValues: (b) => { for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256); } }).getRandomValues(bytes);
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function validateRequiredRuns(count) {
  if (![1, 2, 3].includes(count)) throw new RangeError('每点稳定采集次数只能为 1、2 或 3');
}

export class CalibrationSession {
  constructor(masterRh, requiredRunsPerPoint = 3) {
    validateRequiredRuns(requiredRunsPerPoint);
    this.requiredRunsPerPoint = requiredRunsPerPoint;
    this.masterProfileRh = [...masterRh];
    this.deviceId = '';
    this.startedAt = new Date();
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
    const accepted = run.resultCode === 'stable' &&
      Number.isInteger(run.pointId) && run.pointId >= 0 && run.pointId < 4 &&
      [run.meanRhRaw, run.meanRhCorrected, run.stddevRhRaw].every(Number.isFinite) &&
      run.stddevRhRaw >= 0;
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

  recordParameterOperation(operation, statusName, details) {
    this.parameterOperations.push({
      operation, status: statusName, details: details ?? {}, timestamp: new Date().toISOString(),
    });
  }

  parameterDetails(parameters) {
    return {
      param_version: parameters.paramVersion,
      params_valid: parameters.paramsValid,
      cal_dew_valid: parameters.calDewValid,
      slope_k: parameters.slopeK,
      offset_b: parameters.offsetB,
      cal_dew: parameters.calDew,
    };
  }
}

export class CalibrationController extends Emitter {
  constructor(options = {}) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.readRetryCount = options.readRetryCount ?? 2;
    this.captureStartGraceMs = options.captureStartGraceMs ?? 10000;
    this.sequenceStart = options.sequenceStart ?? 1;
    this.masterProfileRh = options.masterProfileRh ?? [38.983, 57.530, 71.577, 89.697];
    this.requiredRunsPerPoint = options.requiredRunsPerPoint ?? 3;
    validateRequiredRuns(this.requiredRunsPerPoint);
    this.captureIdFactory = options.captureIdFactory ?? new CaptureIdGenerator();
    this._now = options.clock ?? (() => performance.now());
    this._nextSequence = this.sequenceStart;
    this._pending = new Map(); // sequence -> pending
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
    if (this._activeCapture || [...this._pending.values()].some(p =>
      !['heartbeat', 'read_info', 'read_firmware_identity', 'read_parameters', 'enable_stream'].includes(p.operation) || p.context?.writeVerify)) {
      throw new Error('请先结束采集或等待参数操作完成，再升级固件');
    }
    this._otaPaused = true;
    this._pending.clear();
  }

  resumeAfterOta(restoreStream = false) {
    this._otaPaused = false;
    if (restoreStream && this.isConnected) {
      this._registerAndWrite(Command.SET_STREAM, packSetStreamRequest(true, 100), 'enable_stream');
    }
  }

  get connectedTransportName() {
    return this._transport?.name ?? null;
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
      transport.on('data', ({ bytes }) => this._receiveBytes(generation, bytes)),
      transport.on('error', (error) => this._transportError(generation, error)),
      transport.on('disconnected', () => this._peerDisconnected(generation)),
    ];

    this._connecting = false;
    this._connected = true;
    this.session.connectionMetadata = { ...metadata };
    this._emit('connected', metadata);
    // 连接即开实时流（与 Python _finish_connection 一致）
    this._registerAndWrite(Command.SET_STREAM, packSetStreamRequest(true, 100), 'enable_stream', {
      enabled: true, intervalMs: 100,
    });
  }

  disconnect() {
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
      if (request.operation === 'heartbeat') continue;
      this._emitRequestError(request, 'disconnected', 'request failed because the transport disconnected');
    }
    this._pending.clear();
    this._emit('disconnected');
    // 真正断开底层链路：串口是 close，蓝牙是 disconnect（漏掉会造成设备图标常亮、链路占用）
    const closing = [];
    try { closing.push(Promise.resolve(transport?.close?.()).catch(() => {})); } catch { /* 尽力而为 */ }
    try { closing.push(Promise.resolve(transport?.disconnect?.()).catch(() => {})); } catch { /* 尽力而为 */ }
    return Promise.all(closing);
  }

  // —— 公开操作（返回序号）——

  _assertMeasurementIdle() {
    if(deviceControlActive(this.deviceControl) || this.deviceControl?.busy || [...this._pending.values()].some(p=>p.operation==='device_control')) throw new Error('请先完成设备设置或校准');
    if (measurementActive(this.measurement) || [...this._pending.values()].some(p => ['start_measurement','select_bean'].includes(p.operation)))
      throw new Error('请先完成或取消设备测量');
  }

  readDeviceControl() {
    if([...this._pending.values()].some(p=>p.operation==='read_device_control')) return null;
    return this._send(Command.DEVICE_CONTROL,new Uint8Array(),'read_device_control');
  }
  controlDevice(action,value,requestId) {
    this._assertMeasurementIdle();
    if(this._activeCapture || this._otaPaused || [...this._pending.values()].some(p=>['start_capture','write_parameters','reset_parameters','write_sn','write_readback'].includes(p.operation))) throw new Error('请先结束采集、参数写入或升级操作');
    if(requestId==null) {
      const r=new Uint32Array(1);(globalThis.crypto??{getRandomValues:b=>{b[0]=Math.floor(Math.random()*0xffffffff);}}).getRandomValues(r);requestId=r[0]||1;
    }
    return this._send(Command.DEVICE_CONTROL,packDeviceControl(action,value,requestId),'device_control',{action,value,requestId});
  }

  readMeasurement() {
    if ([...this._pending.values()].some(p => p.operation === 'read_measurement')) return null;
    return this._send(Command.MEASUREMENT_CONTROL, new Uint8Array(), 'read_measurement');
  }

  startMeasurement(beanId, mode, requestId) {
    this._assertMeasurementIdle();
    if (this._activeCapture || this._otaPaused || [...this._pending.values()].some(p =>
      ['start_capture', 'write_parameters', 'reset_parameters', 'write_sn', 'write_readback'].includes(p.operation)))
      throw new Error('请先结束采集、参数写入或升级操作');
    if (requestId == null) {
      const random = new Uint32Array(1); (globalThis.crypto ?? {getRandomValues: b => {b[0] = Math.floor(Math.random() * 0xffffffff);}}).getRandomValues(random);
      requestId = random[0] || 1;
    }
    return this._send(Command.MEASUREMENT_CONTROL, packMeasurementControl(1, beanId, mode, requestId),
      'start_measurement', {requestId, beanId, mode});
  }

  selectBean(beanId) {
    this._assertMeasurementIdle();
    if (this._activeCapture || this._otaPaused || [...this._pending.values()].some(p =>
      ['start_capture','write_parameters','reset_parameters','write_sn','write_readback'].includes(p.operation)))
      throw new Error('请先结束采集、参数写入或升级操作');
    const random = new Uint32Array(1);
    (globalThis.crypto ?? {getRandomValues: b => {b[0] = Math.floor(Math.random() * 0xffffffff);}}).getRandomValues(random);
    const requestId = random[0] || 1;
    return this._send(Command.MEASUREMENT_CONTROL, packMeasurementControl(3, beanId, 0, requestId),
      'select_bean', {requestId, beanId, mode: 0});
  }

  cancelMeasurement() {
    const m = this.measurement;
    if (!measurementActive(m)) throw new Error('设备当前没有正在进行的测量');
    return this._send(Command.MEASUREMENT_CONTROL, packMeasurementControl(2, m.beanId, m.mode, m.requestId), 'cancel_measurement');
  }

  readInfo() {
    return this._send(Command.GET_INFO, new Uint8Array(0), 'read_info');
  }

  readSn() {return this._send(Command.READ_SN,new Uint8Array(),'read_sn');}
  writeSn(sn) {
    this._assertMeasurementIdle();
    if(!snValidate(sn))throw new Error('SN 格式或校验位错误');
    if(this._activeCapture||this._otaPaused||[...this._pending.values()].some(p=>p.command===Command.START_CAPTURE))throw new Error('请先结束采集或升级，再写入 SN');
    if([...this._pending.values()].some(p=>p.command===Command.WRITE_SN||p.context?.snExpected))throw new Error('正在写入或核对 SN，请等待');
    return this._send(Command.WRITE_SN,new TextEncoder().encode(sn),'write_sn',{sn});
  }

  readFirmwareIdentity() {
    return this._send(Command.GET_FIRMWARE_ID, new Uint8Array(0), 'read_firmware_identity');
  }

  readParameters() {
    return this._send(Command.GET_PARAMS, new Uint8Array(0), 'read_parameters');
  }

  writeParameters(slopeK, offsetB) {
    this._assertMeasurementIdle();
    return this._send(Command.SET_PARAMS, packSetParamsRequest(slopeK, offsetB), 'write_parameters', {
      slopeK, offsetB,
    });
  }

  resetParameters() {
    this._assertMeasurementIdle();
    return this._send(Command.RESET_PARAMS, new Uint8Array(0), 'reset_parameters');
  }

  startCapture(pointId) {
    this._assertMeasurementIdle();
    if([...this._pending.values()].some(p=>p.command===Command.WRITE_SN||p.context?.snExpected))throw new Error('请等待 SN 写入校验完成');
    const captureId = BigInt(this.captureIdFactory.next());
    return this._send(Command.START_CAPTURE, packStartCaptureRequest(pointId, captureId), 'start_capture', {
      pointId, captureId,
    });
  }

  cancelCapture() {
    return this._send(Command.CANCEL_CAPTURE, new Uint8Array(0), 'cancel_capture');
  }

  sendHeartbeat() {
    if (this._otaPaused) return null;
    for (const request of this._pending.values()) {
      if (request.operation === 'heartbeat') return request.sequence;
    }
    return this._send(Command.HEARTBEAT, new Uint8Array(0), 'heartbeat');
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
    if (this._otaPaused) throw new Error('固件升级期间暂停标定命令');
    if (!this._connected || !this._transport) {
      throw new Error('controller is not connected');
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
      context: { ...(context ?? {}) },
      frame,
      startedAt: now,
      finalDeadline: now + budget,
      retries: 0,
      recovering: false,
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
    // 诊断钩子：首条命令写失败的原因会被后续断开错误覆盖，必须留存（localStorage 防刷新）
    try {
      console.error('[AW] write error:', pending.operation, error);
      window.__awWriteError = {
        operation: pending.operation, error, time: new Date().toISOString(),
      };
      localStorage.setItem('awDiagWrite', JSON.stringify({
        operation: pending.operation,
        msg: String(error?.message ?? error), name: error?.name ?? '', time: Date.now(),
      }));
    } catch { /* 忽略 */ }
    if (pending.operation === 'enable_stream') {
      this._emit('error', { operation: 'connect', reason: String(error?.message ?? error) }, pending.sequence, String(error?.message ?? error));
      this.disconnect();
      return;
    }
    if (pending.operation === 'heartbeat') {
      this._emit('diagnostic', { reason: `heartbeat write failed: ${error}` }, pending.sequence, `心跳写入失败：${error}`);
      return;
    }
    this._emitRequestError(pending, String(error?.message ?? error), String(error?.message ?? error));
  }

  _allocateSequence() {
    for (let i = 0; i < 0xffff; i += 1) {
      const candidate = this._nextSequence;
      this._nextSequence = candidate === 0xffff ? 1 : candidate + 1;
      if (!this._pending.has(candidate)) return candidate;
    }
    throw new Error('sequence space exhausted');
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
      this._emit('diagnostic', {
        reason: `RX_REJECTED crc=${after[0]} length=${after[1]} version=${after[2]}`,
      }, null, `收到损坏帧（CRC=${after[0]} 长度=${after[1]} 版本=${after[2]}），已丢弃`);
    }
    for (const frame of frames) this._handleFrame(generation, frame);
  }

  _handleFrame(generation, frame) {
    if (generation !== this._generation) return;
    if (frame.command >= 0x80) {
      this._handleResponse(frame);
    } else if (frame.command === Command.TELEMETRY ||
               frame.command === Command.MD_TELEMETRY ||
               frame.command === Command.CAPTURE_PROGRESS ||
               frame.command === Command.CAPTURE_RESULT ||
               frame.command === Command.NOTICE ||
               frame.command === Command.OTA_ACK) {
      this._handleAsyncEvent(frame);
    } else if (this._connected) {
      this._diagnostic(`unknown device frame command 0x${frame.command.toString(16).toUpperCase().padStart(2, '0')}`, frame.sequence);
    }
  }

  _handleResponse(frame) {
    const pending = this._pending.get(frame.sequence);
    if (pending == null) {
      this._diagnostic('stale or unknown response sequence', frame.sequence);
      return;
    }
    if (frame.command !== responseCommand(pending.command)) {
      this._diagnostic('response command does not match pending request', frame.sequence);
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
      this._finishMalformed(pending, 'response payload is missing status');
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
    if(command===Command.READ_SN)return unpackSn(payload);
    if(command===Command.WRITE_SN) {
      if(payload.length!==1)throw new Error('SN 写入应答长度无效');
      return payload[0];
    }
    if (command === Command.GET_FIRMWARE_ID) {
      if (payload.length !== 37) throw new Error('firmware identity length must be 37');
      return {sha256:Array.from(payload.subarray(1,33),b=>b.toString(16).padStart(2,'0')).join(''),
        uptimeMs:new DataView(payload.buffer,payload.byteOffset,payload.byteLength).getUint32(33,true)};
    }
    if (command === Command.GET_INFO) return unpackDeviceInfo(payload);
    if (command === Command.GET_PARAMS || command === Command.SET_PARAMS || command === Command.RESET_PARAMS) {
      return unpackDeviceParameters(payload);
    }
    if (command === Command.CANCEL_CAPTURE || command === Command.HEARTBEAT) {
      if (payload.length !== 1) throw new Error('payload length must be exactly 1');
      return payload[0];
    }
    if (command === Command.SET_STREAM) return unpackSetStreamResponse(payload);
    throw new Error('unexpected response command');
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
        `capture start identity mismatch: expected point ${expected[0]} capture_id ${expected[1]}, ` +
        `received point ${actual[0]} capture_id ${actual[1]}`,
        pending.sequence,
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
    if (pending.operation === 'heartbeat') {
      this._diagnostic(`heartbeat failed: ${statusName(status)}`, pending.sequence);
      return;
    }
    this._emitRequestError(pending, statusName(status), `${pending.operation} failed: ${statusName(status)}`, {
      status,
    });
  }

  _completeRequest(pending, decoded) {
    switch (pending.command) {
      case Command.DEVICE_CONTROL:
        if(pending.operation==='device_control' && (decoded.requestId!==pending.context.requestId || decoded.action!==pending.context.action || decoded.value!==pending.context.value)) {
          this._emitRequestError(pending,'device_control_mismatch','设备操作应答与请求不一致');break;
        }
        this.deviceControl=decoded;
        this._emit('device_control',{...decoded,operation:pending.operation},pending.sequence);
        break;
      case Command.MEASUREMENT_CONTROL:
        if (['start_measurement','select_bean'].includes(pending.operation) &&
            (decoded.requestId !== pending.context.requestId || decoded.beanId !== pending.context.beanId || decoded.mode !== pending.context.mode)) {
          this._emitRequestError(pending, 'measurement_mismatch', '设备返回的测量任务与请求不一致');
          break;
        }
        this.measurement = decoded;
        this._emit('measurement', {...decoded, operation: pending.operation}, pending.sequence);
        break;
      case Command.WRITE_SN:
        this._send(Command.READ_SN,new Uint8Array(),'sn_readback',{snExpected:pending.context.sn});
        break;
      case Command.READ_SN:
        this._emit('sn',decoded,pending.sequence);
        if(pending.context.snExpected) {
          if(decoded.sn!==pending.context.snExpected)this._emitRequestError(pending,'SN_MISMATCH','SN 写后回读不一致');
          else {this.session.deviceId=decoded.sn;this._emit('sn_verified',decoded,pending.sequence);this.readInfo();}
        }
        break;
      case Command.GET_FIRMWARE_ID:
        this._emit('firmware_identity',decoded,pending.sequence);
        break;
      case Command.GET_INFO:
        this.session.deviceId = decoded.deviceId;
        this._emit('info', decoded, pending.sequence);
        break;
      case Command.GET_PARAMS: {
        if (pending.context.writeVerify != null) {
          this._verifyWriteReadback(pending, decoded);
        } else {
          this.session.recordParameterOperation('read', 'ok', this.session.parameterDetails(decoded));
          this._emit('parameters', decoded, pending.sequence);
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
          originSequence: pending.sequence,
        };
        const readbackTicket = this._register(Command.GET_PARAMS, new Uint8Array(0), 'write_readback', {
          writeVerify: verification,
        });
        if (readbackTicket) {
          this._writeTicket(readbackTicket)
            .catch((error) => this._handleWriteError(readbackTicket, error));
        }
        break;
      }
      case Command.RESET_PARAMS:
        if (decoded.calDewValid || !decoded.paramsValid || decoded.slopeK !== 1.0 || decoded.offsetB !== 0.0) {
          this.session.recordParameterOperation('reset', 'error', this.session.parameterDetails(decoded));
          this._emit('error', { operation: 'reset_parameters', reason: 'reset readback mismatch' }, pending.sequence, '恢复参数后回读不一致');
        } else {
          this.session.recordParameterOperation('reset', 'ok', this.session.parameterDetails(decoded));
          this._emit('reset', decoded, pending.sequence);
        }
        break;
      case Command.START_CAPTURE:
        this._activeCapture = {
          generation: pending.generation,
          pointId: decoded.pointId,
          captureId: decoded.captureId,
          requestSequence: pending.sequence,
        };
        this._emit('capture_started', { pointId: decoded.pointId, captureId: decoded.captureId }, pending.sequence);
        break;
      case Command.CANCEL_CAPTURE:
        this._emit('capture_cancelled', null, pending.sequence);
        break;
      case Command.SET_STREAM: {
        const expected = [pending.context.enabled, pending.context.intervalMs];
        const actual = [decoded.enabled, decoded.intervalMs];
        if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
          this._emit('error', {
            operation: pending.operation, reason: 'stream response mismatch', expected, actual,
          }, pending.sequence, '实时流应答不一致');
        } else {
          this._emit('stream_configured', { enabled: decoded.enabled, intervalMs: decoded.intervalMs }, pending.sequence);
        }
        break;
      }
      case Command.HEARTBEAT:
        this._emit('heartbeat', null, pending.sequence);
        break;
      default:
        break;
    }
  }

  _verifyWriteReadback(pending, parameters) {
    const expected = pending.context.writeVerify;
    const matches =
      Math.abs(parameters.slopeK - expected.slopeK) <= 1e-6 &&
      Math.abs(parameters.offsetB - expected.offsetB) <= 1e-6 &&
      parameters.paramVersion === expected.paramVersion &&
      parameters.paramsValid === expected.paramsValid &&
      parameters.calDewValid === expected.calDewValid;
    if (matches) {
      this.session.recordParameterOperation('write', 'verified', this.session.parameterDetails(parameters));
      this._emit('write_verified', parameters, expected.originSequence);
    } else {
      const details = {
        reason: 'readback mismatch',
        expected,
        actual: this.session.parameterDetails(parameters),
      };
      this.session.recordParameterOperation('write', 'error', details);
      this._emit('error', details, expected.originSequence, '参数写入后回读不一致');
    }
  }

  _handleAsyncEvent(frame) {
    try {
      if (frame.command === Command.TELEMETRY) {
        const telemetry = unpackTelemetry(frame.payload);
        this.session.recordTelemetry(telemetry);
        this._emit('telemetry', telemetry, frame.sequence);
      } else if (frame.command === Command.MD_TELEMETRY) {
        const telemetry = { ...unpackMdTelemetry(frame.payload), timestamp: new Date().toISOString() };
        this.session.mdTelemetry.push(telemetry);
        this._emit('md_telemetry', telemetry, frame.sequence);
      } else if (frame.command === Command.CAPTURE_PROGRESS) {
        this._recordCaptureProgress(unpackCaptureProgress(frame.payload), frame.sequence);
      } else if (frame.command === Command.CAPTURE_RESULT) {
        this._recordCaptureResult(unpackCaptureResult(frame.payload), frame.sequence);
      } else if (frame.command === Command.NOTICE) {
        this._emit('notice', unpackNotice(frame.payload), frame.sequence);
      } else if (frame.command === Command.OTA_ACK) {
        // OTA 窗口 ACK 事件（非标定路径）；aw_ota.js 在外层消费，这里保持安静
      }
    } catch (error) {
      this._diagnostic(`malformed asynchronous payload: ${error.message}`, frame.sequence);
    }
  }

  _recordCaptureProgress(progress, sequence) {
    if (progress.pointId < 0 || progress.pointId > 3) throw new Error('point_id out of range');
    this._recoverCaptureFromEvent(progress);
    const active = this._activeCapture;
    if (!active) {
      this._diagnostic('ignored capture progress without an active capture', sequence);
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
    this._emit('capture_progress', progress, sequence);
  }

  _recordCaptureResult(result, sequence) {
    const names = ['stable', 'timeout', 'cancelled', 'sensor_error'];
    if (result.pointId < 0 || result.pointId > 3) throw new Error('point_id out of range');
    if (!names[result.resultCode]) throw new Error('unknown capture result code');
    const run = {
      pointId: result.pointId,
      meanRhRaw: result.meanRhRaw,
      meanRhCorrected: result.meanRhCorrected,
      stddevRhRaw: result.stddevRhRaw,
      sampleCount: result.sampleCount,
      elapsedMs: result.elapsedMs,
      resultCode: names[result.resultCode],
    };
    this._recoverCaptureFromEvent(result);
    const active = this._activeCapture;
    if (!active) {
      this._diagnostic('ignored capture result without an active capture', sequence);
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
    this._emit('capture_result', run, sequence);
    if (run.resultCode === 'stable') {
      const report = this.recomputeReport();
      if (report) this._emit('report', report, sequence);
    }
  }

  /** 匹配的采集 ID 证明设备已受理（即使 ACK 丢失）— 对齐 _recover_capture_from_event。 */
  _recoverCaptureFromEvent(event) {
    if (this._activeCapture != null) return;
    for (const pending of [...this._pending.values()]) {
      if (pending.command === Command.START_CAPTURE &&
          pending.context.pointId === event.pointId &&
          pending.context.captureId === event.captureId &&
          this._now() < pending.finalDeadline) {
        this._pending.delete(pending.sequence);
        this._diagnostic('已通过匹配的采集 ID 确认设备正在采集', pending.sequence);
        this._completeRequest(pending, {
          status: Status.OK, pointId: event.pointId, captureId: event.captureId,
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
          this._emit('request_retry', {
            operation: request.operation, attempt: request.retries + 1,
          }, this._publicSequence(request),
          `${OPERATION_LABELS[request.operation] ?? request.operation}应答未到，自动重试 ${request.retries}/${this.readRetryCount}`);
          continue;
        }
        if (request.command === Command.START_CAPTURE && !request.recovering) {
          request.recovering = true;
          request.deadline = request.finalDeadline;
          this._emit('capture_recovering', { pointId: request.context.pointId }, request.sequence,
            '采集确认应答未到，正在等待对应采集进度或结果');
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
    this._recordParameterFailureIfNeeded(request, 'timeout');
    const origin = this._publicSequence(request);
    if (request.operation === 'heartbeat') {
      this._diagnostic('心跳应答超时；实时数据更新不代表命令应答正常', request.sequence);
      return;
    }
    const uncertain = request.command === Command.START_CAPTURE;
    const label = OPERATION_LABELS[request.operation] ?? request.operation;
    const message = uncertain
      ? '开始采集未确认，请先取消当前采集后重试'
      : `${label}应答超时，请检查设备通信`;
    this._emit('request_timeout', {
      operation: request.operation,
      reason: 'timeout',
      requestSequence: request.sequence,
      captureUncertain: uncertain,
    }, origin, message);
  }

  _finishMalformed(pending, reason) {
    this._diagnostic(reason, pending.sequence);
    this._recordParameterFailureIfNeeded(pending, reason);
    if (pending.operation === 'heartbeat') return;
    this._emitRequestError(pending, reason, reason);
  }

  _transportError(generation, error) {
    if (generation !== this._generation || !this._connected) return;
    // 诊断钩子：把完整错误对象（含基座转发的 source）落到 localStorage——刷新页面后仍可读取
    try {
      console.error('[AW] transport error:', error);
      window.__awTransportError = { detail: error, stack: error?.error?.stack, time: new Date().toISOString() };
      localStorage.setItem('awDiagTransport', JSON.stringify({
        msg: String(error?.message ?? error), source: error?.source ?? null,
        stack: (error?.error?.stack ?? '').slice(0, 600), time: Date.now(),
      }));
    } catch { /* 忽略 */ }
    // 基座 Emitter 转发的处理器异常（{error, source} 结构）不是传输故障：
    // 只记诊断不断连——否则一个可恢复的 JS 异常会把好端端的蓝牙/串口连接整个拆掉
    if (error && typeof error === 'object' && error.error != null && error.source != null) {
      this._diagnostic(
        `事件处理器异常（${error.source}）：${error.error?.message ?? String(error.error)}`);
      return;
    }
    const message = String(error?.message ?? error);
    this._transport = null;
    this._connected = false;
    this._generation += 1;
    this._activeCapture = null;
    for (const request of this._pending.values()) {
      if (request.operation === 'heartbeat') continue;
      this._emitRequestError(request, 'disconnected', 'request failed because the transport disconnected');
    }
    this._pending.clear();
    for (const off of this._offTransport) off();
    this._offTransport = [];
    this._emit('error', { operation: 'transport', reason: message }, null, `通信中断：${message}`);
    this._emit('disconnected');
  }

  /** 对端主动断开（蓝牙 GATT 断连等）：等同传输故障处理 */
  _peerDisconnected(generation) {
    if (generation !== this._generation || !this._connected) return;
    this._transportError(generation, { message: 'peer disconnected' });
  }

  _recordParameterFailureIfNeeded(pending, reason) {
    if ([Command.GET_PARAMS, Command.SET_PARAMS, Command.RESET_PARAMS].includes(pending.command)) {
      this.session.recordParameterOperation(pending.operation, 'error', { reason });
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
    if (pending.operation === 'heartbeat') return;
    const details = { operation: pending.operation, reason, ...(extra ?? {}) };
    const origin = this._publicSequence(pending);
    if (origin !== pending.sequence) details.requestSequence = pending.sequence;
    this._emit('error', details, origin, message ?? reason);
  }

  _diagnostic(message, sequence = null) {
    this._emit('diagnostic', { reason: message }, sequence, message);
  }

  _emit(kind, data, sequence, message = '') {
    this.emit(kind, { kind, data, sequence, message });
  }
}

function statusName(value) {
  const names = ['OK', 'UNKNOWN_COMMAND', 'BAD_LENGTH', 'INVALID_PARAMETER', 'BUSY',
    'SENSOR_UNAVAILABLE', 'CAPTURE_TIMEOUT', 'STORAGE_ERROR', 'INTERNAL_ERROR'];
  return names[value] ?? `UNKNOWN_${value}`;
}
