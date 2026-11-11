// app.js — 二合一水活标定网页版上位机主程序
// 功能对等移植桌面版（v2026.10.13-r2）：连接（蓝牙/串口/模拟）、实时流、心跳、
// 四点采集与自动重试、双拟合与推荐、K/B 写入回读、恢复参数、会话导出；
// 新增：串口/蓝牙/WiFi 三通道固件升级。

import { SerialTransport } from './comm_link.js';
import {trafficPreview} from './log_preview.js';
import {
  Command, DEFAULT_MASTER_RH, POINT_LABELS, encodeFrame, parseBleCommandKey,
} from './aw_protocol.js';
import { CalibrationController, OPERATION_LABELS } from './aw_controller.js';
import { AwBleTransport } from './aw_ble.js';
import { SimTransport } from './aw_sim.js';
import { runWireOta, requestApMode, startApProbe, uploadToFirmware, validateFirmwareImage } from './aw_ota.js';
import { OtaResult, otaPresentation, firmwareIdentity } from './ota_status.js';
import { OtaTransferRate, formatTransferRate } from './ota_rate.js';
import { mdValues, mdCsvCells, moistureCsv } from './md_telemetry.js';
import {snGenerate,snValidate} from './sn_code.js';
import {deviceControlActive,deviceStatusText} from './device_control.js';
import {connectAuthorizedSerial} from './serial_reconnect.js';
import {measurementActive, measurementStatusText, BEAN_NAMES} from './measurement_control.js';

const $ = (id) => document.getElementById(id);
const HOST_VERSION = '1.1.26-web';
window.__awVersion = HOST_VERSION;
let bleCommandKey = null;
let connectAfterPrefix = false;

/* 顶栏版本号跟随真实版本（此前为 HTML 写死的静态文字，造成版本误导） */
document.getElementById('hostVersion').textContent = `上位机 v${HOST_VERSION}`;

const MASTER_STORAGE_KEY = 'aw_master_profile_v1';
const CAPTURE_RUNS_STORAGE_KEY = 'aw_required_runs_per_point_v1';

const state = {
  mock: false,
  controller: null,
  ble: null,
  serial: null,
  sim: null,
  activeTransport: null,   // 'ble' | 'serial' | 'sim'
  otaBusy: false,
  heartbeatOk: false,
  telemetryOn: true,
  chartPaused: false,
  selectedFit: null,       // 'endpoint' | 'least_squares'
  autoRetryTimer: null,
  masterRh: [...DEFAULT_MASTER_RH],
  params: null,
  requiredRunsPerPoint: 3,
  sn:null,snBusy:false,snExpected:null,
  deviceControl:null,deviceSupported:null,devicePending:false,deviceUnconfirmed:false,deviceError:'',calDialogAction:null,deviceLanguageEdited:false,deviceStandbyEdited:false,deviceApplyAction:null,deviceApplyValue:null,
  measure: null, measureSupported: null, measurePending: false, measureError: '', measureBeanEdited: false, measureUnconfirmed: false,
};

// ===========================================================================
// 连接管理
// ===========================================================================

function ensureController() {
  if (state.controller) return state.controller;
  const controller = new CalibrationController({ masterProfileRh: state.masterRh,
    requiredRunsPerPoint: state.requiredRunsPerPoint });
  controller.on('connected', onConnected);
  controller.on('disconnected', onDisconnected);
  controller.on('info', ({ data }) => {
    $('devId').textContent = data.deviceId || '(空)';
    if(state.activeTransport==='serial' && data.deviceId) {try {localStorage.setItem('aw_last_serial_device',data.deviceId);localStorage.setItem('aw_serial_auto','1');}catch{}}
    $('devFw').textContent = data.firmwareVersion || '--';
    setDeviceInfo(`${data.deviceId || '未命名'} · ${data.firmwareVersion || ''}`);
  });
  controller.on('firmware_identity', ({data}) => {
    if (!otaResult.canVerify) return;
    const matched=otaResult.verify(data);renderOtaStatus();
    otaLogLine(matched?(otaResult.value.verifyOnly?'当前固件已核对：指纹一致':'升级完成：运行固件指纹一致'):otaResult.value.detail);
    if(matched)banner(otaPresentation(otaResult.value).title,'ok');
  });
  controller.on('parameters', ({ data }) => applyParams(data));
  controller.on('sn',({data})=>{
    state.sn=data.sn;$('snExisting').textContent=data.sn||'未写入';
    if(!state.snBusy)setSnStatus(data.sn?'已读取设备 SN，写入保护已启用。':'设备未写入 SN，请核对候选号码后写入。');
    refreshSnControls();
  });
  controller.on('sn_verified',({data})=>{
    state.snBusy=false;state.snExpected=null;
    setSnStatus((state.mock?'模拟：':'')+'SN 写入并回读校验通过：'+data.sn,'ok');
    if(!state.mock) {
      const next=Number(data.sn.slice(13,17))+1;
      try{localStorage.setItem(snCounterKey(),String(next));}catch{}
      if(next<=9999){$('snSequence').value=next;refreshSnCandidate();}
    }
    refreshSnControls();
  });
  controller.on('reset', ({ data }) => { applyParams(data); banner('参数已恢复 K=1 / B=0，露点校准标志已失效', 'warn'); });
  controller.on('write_verified', ({ data }) => {
    applyParams(data);
    banner('K/B 写入成功，回读校验通过。请重新执行设备原有的 0.753 标准液校准。', 'warn');
  });
  controller.on('telemetry', ({ data }) => onTelemetry(data));
  controller.on('md_telemetry', ({ data }) => onMdTelemetry(data));
  controller.on('device_control',({data})=>{
    const previous=state.deviceControl;
    state.deviceControl=data;state.deviceSupported=true;
    if(data.operation==='device_control')state.devicePending=false;
    if(data.operation==='device_control'||state.deviceUnconfirmed||state.deviceErrorIsRead)state.deviceError='';
    state.deviceErrorIsRead=false;
    state.deviceUnconfirmed=false;
    if(data.phase===3 && data.action===state.deviceApplyAction && data.value===state.deviceApplyValue) {
      if(data.action===1)state.deviceLanguageEdited=false;
      if(data.action===2)state.deviceStandbyEdited=false;
      state.deviceApplyAction=null;state.deviceApplyValue=null;
    }
    if(!state.deviceLanguageEdited && !deviceControlActive(data) && document.activeElement!==$('deviceLanguage'))$('deviceLanguage').value=String(data.language);
    if(!state.deviceStandbyEdited && !deviceControlActive(data) && [3,5,10].includes(data.standbyMinutes) && document.activeElement!==$('deviceStandby'))$('deviceStandby').value=String(data.standbyMinutes);
    if(data.phase===3 && data.action>=3 && (previous?.phase!==3 || previous?.requestId!==data.requestId))state.controller.readParameters();
    refreshAll();
  });
  controller.on('measurement', ({data}) => {
    state.measureSupported = true;
    state.measure = data;
    if (data.operation !== 'read_measurement') state.measurePending = false;
    if (data.operation !== 'read_measurement' || measurementActive(data) || state.measureUnconfirmed) state.measureError = '';
    state.measureUnconfirmed = false;
    if (data.operation === 'select_bean') state.measureBeanEdited = false;
    if (!state.measureBeanEdited || measurementActive(data)) $('measureBean').value = String(data.beanId);
    refreshAll();
  });
  controller.on('capture_started', () => refreshCaptureUi());
  controller.on('capture_progress', ({ data }) => onCaptureProgress(data));
  controller.on('capture_result', ({ data }) => onCaptureResult(data));
  controller.on('report', ({ data }) => applyReport(data));
  controller.on('error', ({ message, data }) => {
    if (handleDeviceControlError(message,data)) return;
    if (handleMeasurementError(message, data)) return;
    if(['read_sn','write_sn','sn_readback'].includes(data?.operation)) {
      state.snBusy=false;state.snExpected=null;
      state.sn=null;
      setSnStatus(data?.status===1?'设备固件尚不支持 SN 读写，请升级配套固件。':(message||'SN 操作失败')+'；请读取 SN 核实。','err');
      refreshSnControls();return;
    }
    if(data?.operation==='read_firmware_identity') {
      if(otaResult.canVerify){otaResult.set('unconfirmed','未能读取固件指纹。请连接配套固件后点击“核对升级结果”；当前不能确认升级完成。');renderOtaStatus();}
      return;
    }
    if (data?.operation === 'heartbeat' || data?.operation === 'transport') return;
    banner(message || JSON.stringify(data), 'err');
  });
  controller.on('request_timeout', ({ message, data }) => {
    if (handleDeviceControlError(message,data,true)) return;
    if (handleMeasurementError(message, data, true)) return;
    if(['read_sn','write_sn','sn_readback'].includes(data?.operation)) {
      state.snBusy=false;state.snExpected=null;state.sn=null;
      setSnStatus('SN 操作未确认，请点击“读取 SN”核实，勿更换号码重复写入。','err');refreshSnControls();return;
    }
    if(data?.operation==='read_firmware_identity') {
      if(otaResult.canVerify){otaResult.set('unconfirmed','设备尚未应答固件核对。请等设备重启完成后重连，再点击“核对升级结果”。');renderOtaStatus();}
      return;
    }
    banner(message, 'err');
    // 超时也可能来自固件发送队列阻塞，不能据此认定缓存损坏并撤销设备权限。
    if (state.activeTransport === 'ble' && state.ble) {
      state.bleTimeoutStreak = (state.bleTimeoutStreak || 0) + 1;
      if (state.bleTimeoutStreak >= 2) {
        state.bleTimeoutStreak = 0;
        banner('蓝牙已连接，但设备命令应答持续超时。请核对蓝牙前缀和设备固件版本。', 'warn');
      }
    }
  });
  controller.on('request_retry', ({ message }) => banner(message, 'warn'));
  controller.on('capture_recovering', ({ message }) => banner(message, 'warn'));
  controller.on('diagnostic', ({ message }) => logDiag(message));
  controller.on('heartbeat', () => { state.heartbeatOk = true; });
  state.controller = controller;
  return controller;
}

async function connect(channel, {authorizedOnly=false,expectedId=null}={}) {
  const controller = ensureController();
  state.connecting = true;
  refreshConnectButtons();
  try {
    let transport;
    if (state.mock) {
      transport = new SimTransport({ name: 'SIM' });
      state.sim = transport;
      await transport.connect();
      state.activeTransport = 'sim';
      controller.connectTransport(transport, { mode: 'simulator' });
      return;
    }
    if (channel === 'ble') {
      transport = new AwBleTransport({ commandKey: bleCommandKey });
      transport.on('log', ({ text }) => setDeviceInfo(text));
      await transport.connect();
      state.ble = transport;
      state.activeTransport = 'ble';
      controller.connectTransport(transport, { mode: 'ble' });
      return;
    }
    // 串口：Web Serial。打开后立即释放 DTR/RTS——复刻 transport.py 的 no-reset 意图，
    // 防止 Windows 在打开 ESP32-C6 USB-Serial/JTAG 口的瞬间复位设备。
    let remembered=expectedId;
    try {remembered ||= localStorage.getItem('aw_last_serial_device');}catch{}
    if(remembered || authorizedOnly)transport=await connectAuthorizedSerial(remembered);
    if(!transport) {
      if(authorizedOnly)throw new Error('未找到已授权且身份匹配的串口设备，请检查 USB 连接或其他软件的占用');
      transport=new SerialTransport({name:'SERIAL',baudRate:115200,bufferSize:16384});await transport.connect();
    }
    try {
      await transport.port.setSignals({ dataTerminalReady: false, requestToSend: false, breakpoint: false });
    } catch { /* 部分驱动不支持，忽略 */ }
    state.serial = transport;
    patchTransportLogging(transport,'serial');
    state.activeTransport = 'serial';
    controller.connectTransport(transport, { mode: 'serial' });
  } finally {
    state.connecting = false;
    refreshConnectButtons();
  }
}

/** 连接按钮状态：连接进行中禁用按钮——第二次点击会被当成"断开"，把自己刚建的连接拆掉 */
function refreshConnectButtons() {
  const busy = !!(state.connecting || state.disconnecting || state.otaBusy);
  const busyText = state.otaBusy ? '升级中…' : state.disconnecting ? '断开中…' : '连接中…';
  $('useMock').disabled = busy;
  const bleOn = state.activeTransport === 'ble';
  $('btnBlePrefix').disabled = busy || bleOn;
  $('btnBle').disabled = busy;
  $('btnBle').textContent = busy ? busyText : (bleOn ? '断开蓝牙' : '连接蓝牙');
  const serialOn = state.activeTransport === 'serial' || state.activeTransport === 'sim';
  $('btnSerial').disabled = busy;
  $('btnSerial').textContent = busy ? busyText : (serialOn ? '断开串口' : '连接串口');
}

function onConnected({ data }) {
  state.deviceControl=null;state.deviceSupported=null;state.devicePending=false;state.deviceUnconfirmed=false;state.deviceError='';state.deviceLanguageEdited=false;state.deviceStandbyEdited=false;
  state.measure=null;state.measureSupported=null;state.measurePending=false;state.measureError='';state.measureBeanEdited=false;state.measureUnconfirmed=false;
  state.sn=null;state.snBusy=false;state.snExpected=null;$('snExisting').textContent='读取中…';
  resetMdTelemetry('等待设备上传水分与密度；豆种跟随设备选择。');
  lastHeartbeatSentAt = -Infinity;
  $('chipBle').classList.toggle('on', data.mode === 'ble');
  $('chipSerial').classList.toggle('on', data.mode === 'serial' || data.mode === 'simulator');
  refreshConnectButtons();
  setDeviceInfo(state.mock ? '模拟设备已连接' : '已连接');
  state.bleTimeoutStreak = 0;
  state.controller.readInfo();
  state.controller.readSn();
  state.controller.readParameters();
  state.controller.readMeasurement();
  state.controller.readDeviceControl();
  refreshAll();
  if(otaResult.canVerify)scheduleOtaVerification();
}

function onDisconnected() {
  state.deviceControl=null;state.deviceSupported=null;state.devicePending=false;state.deviceUnconfirmed=false;state.deviceError='';state.deviceLanguageEdited=false;state.deviceStandbyEdited=false;
  if($('deviceCalDialog').open)$('deviceCalDialog').close();
  state.measure=null;state.measureSupported=null;state.measurePending=false;state.measureError='';state.measureUnconfirmed=false;
  state.sn=null;state.snBusy=false;state.snExpected=null;$('snExisting').textContent='未读取';
  setSnStatus('设备已断开，连接后重新读取 SN。');
  resetMdTelemetry('设备已断开，重新连接后更新。');
  otaResult.disconnected();renderOtaStatus();
  state.activeTransport = null;
  $('chipBle').classList.remove('on');
  $('chipSerial').classList.remove('on');
  $('chipHb').classList.remove('on');
  refreshConnectButtons();
  setDeviceInfo('未连接');
  cancelAutoRetry();
  state.params = null;
  refreshAll();
}

async function disconnectAll() {
  if (state.disconnecting) return;
  state.disconnecting = true;
  refreshConnectButtons();
  try {
    // BLE 由传输层执行应答→设备主动断链；串口先尽力停流，再释放端口。
    if (state.activeTransport === 'serial' && state.serial) {
      let timer;
      try {
        await Promise.race([
          state.serial.write(encodeFrame(Command.SET_STREAM, 0xfffe, new Uint8Array([0, 100, 0]))),
          new Promise(resolve => { timer = setTimeout(resolve, 500); }),
        ]);
      } catch { /* 停流失败仍断开 */ }
      finally { clearTimeout(timer); }
    }
    await state.controller?.disconnect();
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
function handleDeviceControlError(message,data,timeout=false) {
  if(!['read_device_control','device_control'].includes(data?.operation))return false;
  if(data.operation==='device_control')state.devicePending=false;
  if(timeout && data.operation==='device_control')state.deviceUnconfirmed=true;
  if(data.status===1) {state.deviceSupported=false;state.deviceError='此固件尚不支持设备设置与校准，请升级配套固件。';}
  else if(data.operation==='device_control' || !state.deviceControl)state.deviceError=timeout?'操作应答未确认，正在回读设备状态；请勿重复校准。':data.status===4?'设备正在测量、校准或升级，请等待。':data.status===5?'所需传感器尚未就绪，请检查设备。':message||'设备操作失败';
  state.deviceErrorIsRead=data.operation==='read_device_control';
  refreshAll();return true;
}
function refreshDeviceControls() {
  const connected=!!state.controller?.isConnected;
  const busy=state.otaBusy||state.snBusy||captureState.active||measurementLocked()||state.deviceControl?.busy;
  const blocked=!connected||state.deviceSupported!==true||!state.deviceControl?.ready||busy;
  for(const id of ['deviceLanguage','deviceStandby','deviceApplyLanguage','deviceApplyStandby','deviceCalMd','deviceCalAw'])$(id).disabled=blocked;
  $('deviceRead').disabled=!connected||state.otaBusy;
  $('deviceControlStatus').textContent=!connected?'连接后读取设备语言与待机设置。':state.deviceError||deviceStatusText(state.deviceControl);
  $('deviceCalConfirm').disabled=blocked;
}
function applyDeviceControl(action,value) {
  try {
    if(measurementLocked())throw new Error('请等待当前设备操作完成');
    state.devicePending=true;state.deviceError='';state.deviceApplyAction=action;state.deviceApplyValue=value;
    state.controller.controlDevice(action,value);refreshAll();
  } catch(error) {state.devicePending=false;refreshAll();banner(error.message,'warn');}
}
function openDeviceCalibration(action) {
  state.calDialogAction=action;
  $('deviceCalTitle').textContent=action===3?'水分和密度校准警告':'水活校准警告';
  $('deviceCalWarning').textContent=action===3?'倒空并清洁测量杯，空杯放稳后确认。':'放入 0.753 标准液并密封，等待温度稳定后确认。';
  $('deviceCalDialog').showModal();
}

function handleMeasurementError(message, data, timeout = false) {
  if (!['read_measurement','start_measurement','cancel_measurement','select_bean'].includes(data?.operation)) return false;
  state.measurePending = false;
  if (data.operation === 'select_bean') {
    state.measureBeanEdited = false;
    if (state.measure) $('measureBean').value = String(state.measure.beanId);
  }
  if (timeout && data.operation !== 'read_measurement') state.measureUnconfirmed = true;
  if (data.status === 1) {
    state.measureSupported = false;
    state.measureError = '设备固件尚不支持远程测量，请升级配套固件。';
  } else if (data.operation !== 'read_measurement' || !state.measure) {
    state.measureError = timeout ? '指令应答未确认，正在回读设备状态；请勿重复启动。' :
      data.operation === 'select_bean' && data.status === 3 ? '设备固件尚不支持立即切换豆种，请升级配套固件。' :
      data.status === 10 ? '请先在设备上完成“水分与密度”空杯校准。' :
      data.status === 5 ? '所需传感器尚未就绪，请检查设备。' :
      data.status === 4 ? '设备正在测量、校准或升级，请等待或取消当前测量。' : (message || '设备测量操作失败');
  }
  refreshMeasurementControls();
  return true;
}

function measurementLocked() {
  return state.measurePending || state.measureUnconfirmed || measurementActive(state.measure) || deviceOperationLocked();
}

function refreshMeasurementControls() {
  const connected = !!state.controller?.isConnected;
  const running = measurementActive(state.measure);
  const blocked = !connected || state.measureSupported !== true || state.otaBusy || state.snBusy ||
    captureState.active || deviceOperationLocked() || state.measurePending || state.measureUnconfirmed || running || !state.measure?.deviceReady || state.measure?.deviceBusy;
  for (const id of ['measureMd','measureAll']) $(id).disabled = blocked;
  $('measureBean').disabled = blocked;
  const m = state.measure;
  $('measurePhase').textContent = !connected ? '未连接' : state.measureSupported === false ? '需升级固件' :
    state.measurePending ? '发送中' : !m ? '读取状态' : ['待测量','等待启动','测量中','已完成','已取消','未完成'][m.phase];
  $('measurePhase').classList.toggle('ok', m?.phase === 3 && connected);
  $('measureStatus').textContent = !connected ? '设备已断开；重新连接后回读测量状态。' :
    state.measureError || measurementStatusText(m);
  $('measureMoisture').textContent = fmt(m?.moisture, 1);
  $('measureDensity').textContent = fmt(m?.density, 0);
  $('measureAwValue').textContent = fmt(m?.aw, 3);
  const seconds = Math.floor((m?.elapsedMs || 0) / 1000);
  $('measureElapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}

function startDeviceMeasurement(mode) {
  try {
    if (measurementLocked()) throw new Error('请先完成或取消当前测量');
    state.measurePending = true; state.measureError = '';
    state.controller.startMeasurement(Number($('measureBean').value), mode);
    refreshAll();
  } catch (error) { state.measurePending = false; refreshAll(); banner(error.message, 'warn'); }
}

setInterval(() => {
  if (state.controller?.isConnected && !state.otaBusy && state.measureSupported !== false)
    state.controller.readMeasurement();
  if(state.controller?.isConnected && !state.otaBusy && state.deviceSupported!==false)state.controller.readDeviceControl();
}, 1000);

// ===========================================================================
// 实时流 / 心跳 / 控制器节拍
// ===========================================================================

const rhSeries = { raw: [], corrected: [] };
const awSeries = [];
const mdSeries = [];
let lastMdTelemetryAt = 0;

function resetMdTelemetry(message) {
  lastMdTelemetryAt = 0;
  for (const id of ['liveMoisture', 'liveDensity', 'liveCapRaw', 'liveWeightRaw', 'liveDeltaCap', 'liveEmptyCap']) $(id).textContent = '--';
  $('liveBean').textContent = '豆种：等待设备';
  $('mdStatus').textContent = message;
  $('mdExport').disabled = !state.controller?.session?.mdTelemetry?.length;
}

function onMdTelemetry(sample) {
  if (!state.telemetryOn) return;
  lastMdTelemetryAt = Date.now();
  state.bleTimeoutStreak = 0;
  const v = mdValues(sample);
  $('liveBean').textContent = `豆种：${v.beanName}`;
  $('liveMoisture').textContent = v.moisturePct == null ? '--' : fmt(v.moisturePct, 2);
  $('liveDensity').textContent = v.densityGl == null ? '--' : fmt(v.densityGl, 0);
  $('liveCapRaw').textContent = v.capacitancePf == null ? '--' : fmt(v.capacitancePf, 6);
  $('liveWeightRaw').textContent = v.weightAdc == null ? '--' : String(v.weightAdc);
  $('liveDeltaCap').textContent = v.deltaCapacitancePf == null ? '--' : fmt(v.deltaCapacitancePf, 6);
  $('liveEmptyCap').textContent = v.emptyCapacitancePf == null ? '--' : fmt(v.emptyCapacitancePf, 6);
  $('mdExport').disabled = !state.controller?.session?.mdTelemetry?.length;
  const status = [];
  if (v.capacitancePf == null) status.push('电容传感器未就绪');
  else if (v.moisturePct == null) status.push('水分计算未就绪');
  if (v.emptyCapacitancePf == null) status.push('emptyCapacitancePf' in sample ?
    '请先在设备执行空杯校准' : '设备未上报空杯/ΔC，请更新配套固件');
  if (v.weightAdc == null) status.push('称重传感器未就绪');
  else status.push(`重量 ${fmt(v.weightG, 2)} g`);
  $('mdStatus').textContent = status.join(' · ');
  if (!state.chartPaused) {
    mdSeries.push({ ...sample, time: lastMdTelemetryAt });
    trimSeries();
  }
}
let lastTelemetryAt = 0;
let lastHeartbeatSentAt = -Infinity;

/* 单帧尖峰抑制（仅显示层；会话记录/导出/日志仍是原始数据）：
 * 每个样本等到下一个样本到达才确认——若它相对前后样本都是孤立跳变
 * （如设备水分测量对湿度传感器的 ~±13%RH 周期性干扰、传感器掉线 0 值帧），
 * 则该帧不进曲线和数值格。代价：显示延迟一个采样周期（100ms）。 */
const DESPIKE_RH = 3.0; // %RH
const displayFilter = { prev: null, pending: null };
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
  state.bleTimeoutStreak = 0;   // 有数据流动即链路健康，清零超时计数
  const show = confirmSample(t, Date.now());
  if (!show) return;
  t = show.t;
  $('liveTemp').textContent = fmt(t.temperatureC, 2);
  $('liveRhRaw').textContent = fmt(t.humidityRaw, 3);
  $('liveRhCorr').textContent = fmt(t.humidityCorrected, 3);
  $('liveAw').textContent = fmt(t.awFinal, 4);
  $('flagSensor').classList.toggle('on', !!(t.flags & 0x01));
  $('flagParams').classList.toggle('on', !!(t.flags & 0x02));
  $('flagDew').classList.toggle('on', !!(t.flags & 0x04));
  if (!state.chartPaused) {
    rhSeries.raw.push([show.nowMs, t.humidityRaw]);
    rhSeries.corrected.push([show.nowMs, t.humidityCorrected]);
    awSeries.push([show.nowMs, t.awFinal]);
    trimSeries();
    chartsDirty = true;
  }
}

function trimSeries() {
  const windowMs = Number($('chartWindow').value);
  const cutoff = Date.now() - windowMs;
  for (const series of [rhSeries.raw, rhSeries.corrected, awSeries]) {
    while (series.length > 2 && series[0][0] < cutoff) series.shift();
  }
  while (mdSeries.length && mdSeries[0].time < cutoff) mdSeries.shift();
}

setInterval(() => {
  if (state.telemetryOn && lastMdTelemetryAt && Date.now() - lastMdTelemetryAt > 3000) {
    resetMdTelemetry('水分与密度数据已中断，等待设备恢复上传。');
  }
  // 控制器节拍：超时 / 重试 / 宽限判定
  if (!state.otaBusy) state.controller?.tick();
  // 心跳：连接期间每 2s；OTA（尤其串口裸传）期间必须暂停
  if (state.controller?.isConnected && !state.otaBusy && !state.disconnecting &&
      performance.now() - lastHeartbeatSentAt >= 2000) {
    lastHeartbeatSentAt = performance.now();
    state.controller.sendHeartbeat();
  }
  if (state.controller?.isConnected) {
    $('chipHb').classList.toggle('on', Date.now() - lastHeartbeatAckAt < 5000);
  }
}, 200);

let lastHeartbeatAckAt = 0;

setInterval(() => {
  if (state.controller?.isConnected) {
    // 心跳应答到达时间由 heartbeat 事件更新
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

// ===========================================================================
// 采集
// ===========================================================================

const captureState = {
  active: false,
  pointId: null,
  progress: {},
};

function buildPointsUi() {
  const grid = $('pointsGrid');
  grid.innerHTML = '';
  POINT_LABELS.forEach((label, pointId) => {
    const div = document.createElement('div');
    div.className = 'point';
    div.id = 'point' + pointId;
    div.innerHTML = `
      <div class="head">
        <span class="title">${label}</span>
        <span class="count" id="count${pointId}">0/${state.requiredRunsPerPoint}</span>
        <button class="btn small primary" data-point="${pointId}" id="start${pointId}">开始采集</button>
      </div>
      <div class="bar"><i id="bar${pointId}"></i></div>
      <div class="nums" id="nums${pointId}">--</div>`;
    grid.appendChild(div);
  });
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-point]');
    if (!button) return;
    startCapture(Number(button.dataset.point));
  });
}

function startCapture(pointId) {
  if (!state.controller?.isConnected) return banner('请先连接设备', 'warn');
  if (captureState.active) return banner('当前已有采集进行中，请先取消', 'warn');
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
  const label = { stable: '稳定', timeout: '超时', cancelled: '取消', sensor_error: '传感器错误' }[run.resultCode];
  appendRun(`${new Date().toTimeString().slice(0, 8)} 点${POINT_LABELS[run.pointId]} ${label}：`
    + `raw=${fmt(run.meanRhRaw, 3)} corr=${fmt(run.meanRhCorrected, 3)} sd=${fmt(run.stddevRhRaw, 4)} n=${run.sampleCount}`);
  if (run.resultCode === 'stable') {
    banner(`点位 ${POINT_LABELS[run.pointId]} 采集稳定通过`, 'warn');
  } else if ((run.resultCode === 'timeout' || run.resultCode === 'sensor_error') && $('autoRetry').checked) {
    scheduleAutoRetry(run.pointId);
  }
  refreshAll();
}

function scheduleAutoRetry(pointId) {
  cancelAutoRetry();
  appendRun(`将在 2 秒后自动重试点位 ${POINT_LABELS[pointId]}…`);
  state.autoRetryTimer = setTimeout(() => {
    state.autoRetryTimer = null;
    if (state.controller?.isConnected && !captureState.active) {
      state.controller.startCapture(pointId);
    }
  }, 2000);
}

function cancelAutoRetry() {
  if (state.autoRetryTimer) {
    clearTimeout(state.autoRetryTimer);
    state.autoRetryTimer = null;
  }
}

function appendRun(text) {
  const el = $('runList');
  el.textContent += (el.textContent ? '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}

function refreshCaptureUi() {
  refreshSnControls();
  const session = state.controller?.session;
  for (let pointId = 0; pointId < 4; pointId += 1) {
    const count = session ? session.acceptedRunsByPoint[pointId].length : 0;
    const countEl = $('count' + pointId);
    countEl.textContent = `${count}/${state.requiredRunsPerPoint}`;
    countEl.classList.toggle('ok', count >= state.requiredRunsPerPoint);
    const pointEl = $('point' + pointId);
    pointEl.classList.toggle('active', captureState.active && captureState.pointId === pointId);
    if (captureState.active && captureState.pointId === pointId && captureState.progress.sampleCount) {
      $('bar' + pointId).style.width = Math.min(100, captureState.progress.sampleCount / 1.5) + '%';
      $('nums' + pointId).textContent =
        `n=${captureState.progress.sampleCount}/150 · ${Math.round(captureState.progress.elapsedMs / 1000)}s · ` +
        `mean=${fmt(captureState.progress.meanRhRaw, 3)} sd=${fmt(captureState.progress.stddevRhRaw, 4)}`;
    } else {
      $('bar' + pointId).style.width = '0';
      if (count > 0) {
        const agg = session.pointAggregate(pointId);
        $('nums' + pointId).textContent =
          `${count} 次均值 ${fmt(agg.meanRhRaw, 3)}` + (agg.stdevRhRaw != null ? ` ± ${fmt(agg.stdevRhRaw, 3)}` : '');
      } else {
        $('nums' + pointId).textContent = '--';
      }
    }
  }
  for (let pointId=0;pointId<4;pointId++) $('point'+pointId).querySelector('button').disabled = !state.controller?.isConnected || state.otaBusy || captureState.active || measurementLocked();
  $('btnCancel').disabled = !captureState.active;
  $('btnCancel').textContent = captureState.active ? `取消当前采集（点 ${POINT_LABELS[captureState.pointId]}）` : '取消当前采集';
}

// ===========================================================================
// 拟合 / 写入 / 导出
// ===========================================================================

function refreshFits() {
  sessionReportCache = null;
  let report;
  try {
    report = state.controller?.recomputeReport();
  } catch (error) {
    $('fitTable').textContent = error.message;
    $('fitWarning').classList.add('hidden');
    $('btnWrite').disabled = true;
    drawCalibrationChart();
    return;
  }
  if (!report) {
    $('fitTable').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--dim)">四个点位各需至少 ${state.requiredRunsPerPoint} 次稳定采集后自动生成拟合</td></tr>`;
    $('fitWarning').classList.add('hidden');
    $('btnWrite').disabled = true;
    drawCalibrationChart();
    return;
  }
  applyReport(report);
}

function applyReport(report) {
  if (!report?.endpoint || !report.leastSquares) return;
  sessionReportCache = report;
  const methods = [
    { key: 'endpoint', name: '两端点法', fit: report.endpoint },
    { key: 'least_squares', name: '四点最小二乘', fit: report.leastSquares },
  ];
  let html = '<tr><th>方法</th><th>K</th><th>B</th>' +
    POINT_LABELS.map((l) => `<th>${l}</th>`).join('') + '<th>RMSE</th></tr>';
  for (const { key, name, fit } of methods) {
    html += `<tr class="${(state.selectedFit ?? report.recommendedMethod) === key ? 'sel' : ''}" data-fit="${key}">` +
      `<td>${name}${report.recommendedMethod === key ? '<span class="tag rec">推荐</span>' : ''}</td>` +
      `<td>${fmt(fit.slopeK, 6)}</td><td>${fmt(fit.offsetB, 6)}</td>` +
      fit.correctedRh.map((v, i) => `<td title="残差 ${fmt(fit.residuals[i], 3)}">${fmt(v, 2)}</td>`).join('') +
      `<td>${fmt(fit.rmse, 3)}</td></tr>`;
  }
  html += '<tr><th>残差</th><th></th><th></th>' +
    POINT_LABELS.map(() => '<th></th>').join('') + '<th></th></tr>';
  for (const { key, name, fit } of methods) {
    html += `<tr><td>${name} 残差</td><td></td><td></td>` +
      fit.residuals.map((v) => `<td>${fmt(v, 3)}</td>`).join('') + '<td></td></tr>';
  }
  $('fitTable').innerHTML = html;
  for (const row of $('fitTable').querySelectorAll('tr[data-fit]')) {
    row.addEventListener('click', () => {
      state.selectedFit = row.dataset.fit;
      applyReport(sessionReportCache);
    });
  }
  if (report.warningReasons.length) {
    $('fitWarning').textContent = report.warningReasons.join('；');
    $('fitWarning').classList.remove('hidden');
  } else {
    $('fitWarning').classList.add('hidden');
  }
  drawCalibrationChart();
  $('btnWrite').disabled = !state.controller?.isConnected;
}

let sessionReportCache = null;

function writeSelected() {
  if (!state.controller?.isConnected) return;
  refreshFits();
  const report = sessionReportCache;
  if (!report) return;
  const method = state.selectedFit ?? report.recommendedMethod;
  const fit = method === 'endpoint' ? report.endpoint : report.leastSquares;
  if (!confirm(`确认写入 ${method === 'endpoint' ? '两端点法' : '四点最小二乘'} 参数 K=${fmt(fit.slopeK, 6)} / B=${fmt(fit.offsetB, 6)}？\n写入后旧 0.753 露点校准将失效。`)) return;
  state.controller.writeParameters(fit.slopeK, fit.offsetB);
}

function exportSession() {
  const session = state.controller?.session;
  if (!session) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // JSON
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
      session.acceptedRunsByPoint.map((runs, id) => [id, runs]),
    ),
    parameter_operations: session.parameterOperations,
    report: session.report ? {
      fits: {
        endpoint: session.report.endpoint,
        least_squares: session.report.leastSquares,
      },
      recommended_method: session.report.recommendedMethod,
      warning_reasons: session.report.warningReasons,
    } : null,
  };
  download(new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' }),
    `calibration_session_${stamp}.json`);
  // CSV（同桌面版列结构）
  const header = ['record_type', 'timestamp', 'device_id', 'flags', 'sample_sequence', 'point_id',
    'result_code', 'sample_count', 'elapsed_ms', 'temperature_c', 'humidity_raw', 'humidity_corrected',
    'aw_unclamped', 'aw_final', 'mean_rh_raw', 'mean_rh_corrected', 'stddev_rh_raw', 'fit_method',
    'slope_k', 'offset_b', 'corrected_rh', 'residual', 'rmse', 'recommended_method',
    'bean_id', 'bean_name', 'moisture_pct', 'density_g_l', 'capacitance_raw_pf', 'weight_raw_adc', 'weight_g',
    'capacitance_empty_pf', 'delta_capacitance_pf', 'required_runs_per_point'];
  const rows = [header.join(',')];
  const esc = (v) => (v == null ? '' : String(v).includes(',') ? `"${v}"` : String(v));
  const csvRow = (cells) => Array.from({length:header.length}, (_,i) =>
    esc(i === header.length-1 ? session.requiredRunsPerPoint : cells[i])).join(',');
  rows.push(csvRow(['metadata', document_.started_at, session.deviceId]));
  for (const t of session.telemetry) {
    rows.push(csvRow(['telemetry', '', session.deviceId, t.flags, t.sampleSequence, '', '', '', '',
      t.temperatureC, t.humidityRaw, t.humidityCorrected, t.awUnclamped, t.awFinal,
      '', '', '', '', '', '', '', '', '', '']));
  }
  for (const c of session.captureResults) {
    rows.push(csvRow(['capture', '', session.deviceId, '', '', c.pointId, c.resultCode, c.sampleCount, c.elapsedMs,
      '', '', '', '', '', c.meanRhRaw, c.meanRhCorrected, c.stddevRhRaw, '', '', '', '', '', '']));
  }
  if (session.report) {
    for (const [method, fit] of [['endpoint', session.report.endpoint], ['least_squares', session.report.leastSquares]]) {
      for (let pointId = 0; pointId < 4; pointId += 1) {
        rows.push(csvRow(['fit_point', '', session.deviceId, '', '', pointId, '', '', '', '', '', '', '', '', '', '', '',
          method, fit.slopeK, fit.offsetB, fit.correctedRh[pointId], fit.residuals[pointId], fit.rmse,
          session.report.recommendedMethod]));
      }
    }
  }
  for (const t of session.mdTelemetry) {
    const cells = Array(24).fill('');
    cells[0] = 'md_telemetry'; cells[1] = t.timestamp; cells[2] = session.deviceId;
    cells[3] = t.flags; cells[4] = t.sampleSequence;
    rows.push(csvRow([...cells, ...mdCsvCells(t)]));
  }
  download(new Blob([rows.join('\n')], { type: 'text/csv' }), `calibration_session_${stamp}.csv`);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ===========================================================================
// 设备参数 / 基准
// ===========================================================================

function applyParams(p) {
  state.params = p;
  $('devParamVer').textContent = String(p.paramVersion);
  $('devKb').textContent = `${fmt(p.slopeK, 6)} / ${fmt(p.offsetB, 6)}${p.paramsValid ? '' : '（无效）'}`;
  $('devDew').textContent = p.calDewValid ? fmt(p.calDew, 3) : '已失效';
  refreshAll();
}

function buildMasterUi() {
  const grid = $('masterGrid');
  grid.innerHTML = '';
  POINT_LABELS.forEach((label, index) => {
    const wrap = document.createElement('label');
    wrap.innerHTML = `<span>${label}</span><input type="number" step="0.001" id="master${index}" value="${state.masterRh[index]}">`;
    grid.appendChild(wrap);
  });
}

function saveMaster() {
  const values = [];
  for (let i = 0; i < 4; i += 1) {
    const value = Number($('master' + i).value);
    if (!Number.isFinite(value)) return banner('基准 RH 必须是数字', 'err');
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
  banner('基准 RH 已保存并重算', 'warn');
}

function loadMaster() {
  try {
    const stored = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY));
    if (Array.isArray(stored) && stored.length === 4 && stored.every((v) => Number.isFinite(v))) {
      state.masterRh = stored;
    }
  } catch { /* 损坏则用默认 */ }
}

// ===========================================================================
// 曲线（轻量 canvas 折线）
// ===========================================================================

let chartsDirty = true;

function drawCharts() {
  drawChart($('chartRh'), [
    { data: rhSeries.raw, color: '#60a5fa', label: '原始 RH' },
    { data: rhSeries.corrected, color: '#16a34a', label: '修正 RH' },
  ], '%RH');
  drawChart($('chartAw'), [
    { data: awSeries, color: '#06b6d4', label: 'AW' },
  ], 'AW');
}

function drawChart(canvas, seriesList, unit) {
  const ctx = canvas.getContext('2d');
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
    ctx.fillStyle = '#43536f';
    ctx.font = '12px sans-serif';
    ctx.fillText('暂无数据', 8, 18);
    return;
  }
  const windowMs = Number($('chartWindow').value);
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
  if (yMax - yMin < 1e-6) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.1;
  yMin -= pad; yMax += pad;
  const padL = 44, padR = 8, padT = 8, padB = 16;
  const toX = (t) => padL + ((t - xMin) / (xMax - xMin)) * (width - padL - padR);
  const toY = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (height - padT - padB);
  // 网格
  ctx.strokeStyle = '#1c2942';
  ctx.fillStyle = '#68799b';
  ctx.font = '10px monospace';
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + (i / 4) * (height - padT - padB);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText((yMax - (i / 4) * (yMax - yMin)).toFixed(yMax - yMin > 20 ? 0 : 2), 4, y + 3);
  }
  // 折线
  for (const series of seriesList) {
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const [t, v] of series.data) {
      const x = toX(t); const y = toY(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // 图例
  let lx = padL + 4;
  for (const series of seriesList) {
    ctx.fillStyle = series.color;
    ctx.fillRect(lx, height - 10, 8, 3);
    ctx.fillStyle = '#8ea0c0';
    ctx.fillText(series.label, lx + 11, height - 5);
    lx += 14 + ctx.measureText(series.label).width + 10;
  }
  ctx.fillStyle = '#68799b';
  ctx.fillText(unit, width - 34, 12);
}

window.addEventListener('resize', () => { chartsDirty = true; drawCalibrationChart(); });

/* 四点标定对比曲线（复刻桌面版 calibration chart）：
 * 四个盐点上画三条系列——设备原始 / 选定修正 / 主基准，
 * 修正点贴住基准点即为标定成功，肉眼可判。 */
function drawCalibrationChart() {
  const canvas = $('calibChart');
  if (!canvas) return;
  const session = state.controller?.session;
  const raw = session?.devicePointMeans();
  const report = sessionReportCache;
  if (!canvas.parentElement || canvas.parentElement.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.clientWidth;
  const height = canvas.parentElement.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!raw || !report) {
    ctx.fillStyle = '#43536f';
    ctx.font = '12px sans-serif';
    ctx.fillText('四点采集完成后显示对比曲线', 8, 18);
    return;
  }
  const method = state.selectedFit ?? report.recommendedMethod;
  const fit = method === 'endpoint' ? report.endpoint : report.leastSquares;
  const master = session.masterProfileRh;
  const series = [
    { label: '设备原始', color: '#60a5fa', values: raw, r: 3.2 },
    { label: '选定修正', color: '#f59e0b', values: fit.correctedRh, r: 3.2 },
    { label: '一号机基准', color: '#4ade80', values: master, r: 2.6 },
  ];
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) for (const v of s.values) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  const pad = Math.max((yMax - yMin) * 0.15, 0.5);
  yMin -= pad; yMax += pad;
  const padL = 44, padR = 10, padT = 10, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const toX = (i) => padL + ((i + 0.5) / 4) * plotW;
  const toY = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  // 网格 + Y 轴
  ctx.strokeStyle = '#1c2942';
  ctx.fillStyle = '#68799b';
  ctx.font = '10px monospace';
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText((yMax - (i / 4) * (yMax - yMin)).toFixed(1), 4, y + 3);
  }
  // X 轴点位标签
  ctx.textAlign = 'center';
  POINT_LABELS.forEach((label, i) => ctx.fillText(label, toX(i), height - 12));
  ctx.textAlign = 'left';
  // 系列：细折线 + 圆点
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    s.values.forEach((v, i) => (i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v))));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.color;
    for (let i = 0; i < s.values.length; i += 1) {
      ctx.beginPath();
      ctx.arc(toX(i), toY(s.values[i]), s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 图例
  let lx = padL + 6;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(lx + 4, height - 4.5, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8ea0c0';
    ctx.font = '10px monospace';
    ctx.fillText(s.label, lx + 11, height - 1);
    lx += 16 + ctx.measureText(s.label).width + 10;
  }
  ctx.fillStyle = '#68799b';
  ctx.fillText('%RH', width - 30, 12);
}

function exportChartCsv() {
  const records = [];
  const length = Math.max(rhSeries.raw.length, rhSeries.corrected.length, awSeries.length);
  const at = (series, i) => (i < series.length ? series[i] : [0, null]);
  for (let i = 0; i < length; i += 1) {
    const [t0] = at(rhSeries.raw, i);
    records.push({ time:t0, cells:[
      new Date(t0).toISOString(),
      at(rhSeries.raw, i)[1], at(rhSeries.corrected, i)[1], at(awSeries, i)[1],
      'aw', '', '', '', '', '', '', '', '',
    ] });
  }
  for (const sample of mdSeries) records.push({time:sample.time, cells:[
    new Date(sample.time).toISOString(), '', '', '', 'md', ...mdCsvCells(sample), sample.flags,
  ]});
  records.sort((a,b) => a.time-b.time);
  const rows = ['time,rh_raw,rh_corrected,aw_final,record_type,bean_id,bean_name,moisture_pct,density_g_l,capacitance_raw_pf,weight_raw_adc,weight_g,capacitance_empty_pf,delta_capacitance_pf,md_flags',
    ...records.map(r => Array.from({length:15}, (_,i) => r.cells[i]??'').join(','))];
  download(new Blob([rows.join('\n')], { type: 'text/csv' }), `aw_telemetry_${Date.now()}.csv`);
}

// ===========================================================================
// 固件升级
// ===========================================================================

let otaFileBytes = null;
let otaFileName = '';
let stopApProbeFn = null;
let verifyOtaTimer = null;
let otaStorage;
try{otaStorage=localStorage;}catch{}
const otaResult = new OtaResult(otaStorage);
let otaRate = null;
function resetOtaRate() {
  otaRate = null;
  delete otaResult.value.transferStats;
}
function startOtaRate(simulated=false) {
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
  const r=otaResult.value,p=otaPresentation(r);
  $('otaStatus').className='ota-status '+p.tone;
  $('otaStatusTitle').textContent=p.title;
  $('otaStatusDetail').textContent=r.detail||'选择固件并连接设备后，点击对应升级按钮。';
  const rows=[];
  if(r.fileName)rows.push('记录固件：'+r.fileName+(r.version?' · '+r.version:''));
  if(r.startedAt)rows.push('开始时间：'+new Date(r.startedAt).toLocaleString());
  if(r.sha256)rows.push('目标指纹：'+r.sha256.slice(0,16));
  if(r.actualSha256)rows.push('运行指纹：'+r.actualSha256.slice(0,16));
  if(r.completedAt)rows.push('完成时间：'+new Date(r.completedAt).toLocaleString());
  if(r.startedAt&&state.otaBusy)rows.push('已用时：'+Math.floor((Date.now()-r.startedAt)/1000)+' 秒');
  $('otaResultMeta').textContent=rows.join('\n');
  $('otaVerify').classList.toggle('hidden',!otaResult.canVerify&&!otaFileBytes);
  $('otaVerify').textContent=otaResult.canVerify&&(!otaFileBytes||firmwareIdentity(otaFileBytes).sha256===r.sha256)?'核对升级结果':'核对所选固件';
  $('otaVerify').disabled=state.otaBusy||r.phase==='verifying';
  $('otaBar').style.width=(r.percent||0)+'%';
  $('otaPercent').textContent=(r.percent||0)+'%';
  const stats=otaRate?.active ? otaRate.snapshot() : r.transferStats;
  const simulated=stats?.simulated ? '（模拟）' : '';
  $('otaCurrentRate').textContent=`实时速度${simulated}：${formatTransferRate(otaRate?.active ? stats.currentBps : null)}`;
  $('otaAverageRate').textContent=`平均速度${simulated}：${formatTransferRate(stats?.averageBps)}`;
}
function scheduleOtaVerification(delay=2500) {
  clearTimeout(verifyOtaTimer);
  const attempt=otaResult.value.startedAt;
  verifyOtaTimer=setTimeout(()=>{
    if(!otaResult.canVerify||attempt!==otaResult.value.startedAt||state.otaBusy)return;
    if(!state.controller?.isConnected){otaResult.set('awaiting_reconnect','固件写入已成功。请点击连接蓝牙或连接串口，系统会自动核对运行固件。');renderOtaStatus();return;}
    otaResult.set('verifying','正在读取设备当前运行固件的指纹，最多约 15 秒…');renderOtaStatus();
    try{state.controller.readFirmwareIdentity();}catch(error){otaResult.set('unconfirmed',error.message);renderOtaStatus();}
  },delay);
}
renderOtaStatus();
setInterval(()=>{if(state.otaBusy){saveOtaRate();otaResult.save();renderOtaStatus();}},1000);

function otaLogLine(text) {
  const el = $('otaLog');
  const time = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${time}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

function setOtaProgress(sent, total, detail, transferred=sent) {
  otaRate?.update(transferred);saveOtaRate();
  const pct = total ? Math.floor((sent * 100) / total) : 0;
  otaResult.progress(pct,detail);renderOtaStatus();
  $('otaDetail').textContent = detail ?? '';
}

async function runOta(channel) {
  if (state.otaBusy) return;
  if (!otaFileBytes) return otaLogLine('请先选择 .bin 固件文件');
  if (state.mock) {
    return runMockOta(channel);
  }
  const transport = channel === 'ble' ? state.ble : state.serial;
  if (!transport?.isConnected) return otaLogLine((channel === 'ble' ? '蓝牙' : '串口') + '未连接');
  try { state.controller?.pauseForOta(); } catch (error) { return otaLogLine(error.message); }
  state.otaBusy = true; refreshAll(); refreshConnectButtons();
  otaResult.start(otaFileName,channel,otaFileBytes);resetOtaRate();renderOtaStatus();
  let failed = false;
  try {
    validateFirmwareImage(otaFileBytes);
    await runWireOta({
      transport,
      bytes: otaFileBytes,
      channel,
      onLog: otaLogLine,
      onProgress: (p) => setOtaProgress(p.sent, p.total, p.detail, p.transferred),
      onPhase:phase=>{
        if(phase==='sending')startOtaRate();
        if(phase==='validating')stopOtaRate();
        otaResult.set(phase,phase==='validating'?'数据已传完，正在等待设备校验。此时还不能判断升级完成。':phase==='sending'?'正在传输，请保持设备供电和连接。':'正在等待 START 确认…');renderOtaStatus();
      },
    });
    otaResult.confirmed();renderOtaStatus();scheduleOtaVerification();
  } catch (error) { failed = true; otaLogLine(error.message);otaResult.set(error.otaResultUnknown?'unconfirmed':'failed',error.message);renderOtaStatus();if(error.otaResultUnknown)scheduleOtaVerification(); } finally {
    stopOtaRate();state.otaBusy = false; state.controller?.resumeAfterOta(failed); refreshAll(); refreshConnectButtons();renderOtaStatus();
  }
}

async function runMockOta(channel) {
  otaResult.start(otaFileName,channel,otaFileBytes);otaResult.set('sending','模拟演练，不会向真实设备烧录。');
  resetOtaRate();startOtaRate(true);
  state.otaBusy = true;
  refreshAll();refreshConnectButtons();
  otaLogLine(`(模拟) ${channel === 'wifi' ? 'WiFi 热点' : channel === 'ble' ? '蓝牙' : '串口'}升级：${otaFileBytes.length} 字节`);
  const total = otaFileBytes.length;
  for (let pct = 0; pct <= 100; pct += 4) {
    await new Promise((r) => setTimeout(r, 80));
    setOtaProgress((total * pct) / 100, total, '(模拟传输)');
  }
  state.sim?.exitApMode?.();
  otaLogLine('(模拟) 设备刷机完成，重启回正常模式');
  stopOtaRate();state.otaBusy = false;
  otaResult.value.percent=100;otaResult.set('mock_completed','这只是模拟演练，真实设备固件没有更新。');renderOtaStatus();
  refreshAll();refreshConnectButtons();
}

function finishWifiWait() {
  stopOtaRate();
  stopApProbeFn?.(); stopApProbeFn = null;
  state.wifiUploading = false;
  state.otaBusy = false; state.controller?.resumeAfterOta(); refreshAll(); refreshConnectButtons();renderOtaStatus();
}
function beginWifiProbe() {
  resetOtaRate();
  otaResult.set('waiting_ap','电脑连接 LEBREW-AW 后会自动上传。尚未开始烧录。');renderOtaStatus();
  stopApProbeFn?.(); state.otaBusy = true; refreshAll(); refreshConnectButtons();
  stopApProbeFn = startApProbe(
    text => { $('wifiProbeStatus').textContent = text; },
    async () => {
      state.wifiUploading = true;
      otaResult.set('sending','正在通过 WiFi 上传固件，请保持设备供电。');renderOtaStatus();
      $('wifiProbeStatus').textContent = '已确认 LEBREW-AW，正在上传…';
      $('wifiRetry').disabled = true; $('wifiCancel').disabled = true;
      startOtaRate();
      try {
        await uploadToFirmware(otaFileBytes, (loaded,total) => {
          setOtaProgress(Math.min(loaded,total-1),total, `已上传 ${(loaded/1024).toFixed(1)} KB，等待设备校验`, loaded);
          if(loaded>=total){stopOtaRate();otaResult.set('validating','上传已完成，等待设备校验结果。');renderOtaStatus();}
        });
        setOtaProgress(otaFileBytes.length,otaFileBytes.length,'固件校验成功');
        stopOtaRate();
        otaLogLine('WiFi 升级成功，设备即将重启。请重新连接并核对版本。');
        otaResult.confirmed();renderOtaStatus();scheduleOtaVerification();
      } catch(error) { otaLogLine('WiFi 升级失败：'+error.message);otaResult.set(/^HTTP [45]/.test(error.message)?'failed':'unconfirmed','未收到有效的最终确认：'+error.message+'。请重连设备后核对运行固件。');renderOtaStatus(); }
      finally { finishWifiWait(); }
    }, 300000, ()=>{otaResult.set('failed','等待热点超时，未确认升级成功。请连接 LEBREW-AW 后重新检测。');renderOtaStatus();finishWifiWait();});
}
async function startWifiUpgrade() {
  if (state.otaBusy) return;
  if (!otaFileBytes) return otaLogLine('请先选择 .bin 固件文件');
  if (state.mock) return runMockOta('wifi');
  try { validateFirmwareImage(otaFileBytes); } catch(error) { return otaLogLine(error.message); }
  const transport = state.ble?.isConnected ? state.ble : state.serial?.isConnected ? state.serial : null;
  if (!transport && !state.wifiApRequested) return otaLogLine('请先连接蓝牙或串口，再发送进入热点模式指令');
  try {
    otaResult.start(otaFileName,'wifi',otaFileBytes);resetOtaRate();renderOtaStatus();
    if (transport) {
      state.controller?.pauseForOta();state.otaBusy = true;refreshAll();refreshConnectButtons();
      if (!await requestApMode(transport)) throw new Error('设备拒绝进入热点模式');
      state.wifiApRequested = true;
      otaLogLine('进入热点指令已确认，请用设备配套密码连接 LEBREW-AW');
    }
    $('wifiSteps').classList.remove('hidden');beginWifiProbe();
  } catch(error) { otaLogLine(error.message);otaResult.set('failed',error.message);renderOtaStatus();finishWifiWait(); }
}

// ===========================================================================
// 日志面板
// ===========================================================================

const logPanes = {
  ble: { el: () => $('logBle'), entries: [], hex: true, paused: false },
  serial: { el: () => $('logSerial'), entries: [], hex: true, paused: false },
};

function logPane(channel, dir, bytes) {
  const pane = logPanes[channel];
  if (!pane) return;
  pane.entries.push({ t: new Date(), dir, bytes: bytes.slice() });
  if (pane.entries.length > 400) pane.entries.shift();
  pane.dirty=true;
}

setInterval(()=>{
  for(const pane of Object.values(logPanes))if(pane.dirty&&!pane.paused)renderLog(pane);
},200);

function renderLog(pane) {
  const lines = pane.entries.slice(-200).map((entry) => {
    const time = entry.t.toTimeString().slice(0, 8) + '.' + String(entry.t.getMilliseconds()).padStart(3, '0');
    const body = trafficPreview(entry.bytes,pane.hex);
    return time + ' ' + entry.dir.padEnd(2) + ' ' + body;
  });
  const el = pane.el();
  el.textContent = lines.join('\n') || '（暂无数据）';
  el.scrollTop = el.scrollHeight;
  pane.dirty=false;
}

function attachTransportLogging(transport, channel) {
  transport.on('tx', ({ bytes }) => logPane(channel, 'TX', bytes));
  transport.on('rx', ({ bytes }) => logPane(channel, 'RX', bytes));
}

// comm_link 基座不自动发 tx/rx 事件；这里在 write/data 上补一份
function patchTransportLogging(transport, channel) {
  if(!transport || transport._awLogPatched)return;
  transport._awLogPatched=true;
  const originalWrite = transport.write.bind(transport);
  transport.write = async (bytes) => {
    logPane(channel, 'TX', bytes);
    return originalWrite(bytes);
  };
  transport.on('data', ({ bytes }) => logPane(channel, 'RX', bytes));
  attachTransportLogging(transport, channel);
}

function logDiag(message) {
  const line = new Date().toTimeString().slice(0, 8) + ' DIAG ' + message;
  for (const pane of Object.values(logPanes)) {
    pane.entries.push({ t: new Date(), dir: 'DG', bytes: new TextEncoder().encode(message) });
    if (!pane.paused) renderLog(pane);
  }
}

// ===========================================================================
// 横幅 / 杂项
// ===========================================================================

let bannerTimer = null;
function banner(text, kind = 'warn') {
  if (!text) return;
  $('bannerText').textContent = text;
  $('banner').className = 'banner ' + kind;
  $('banner').classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.add('hidden'), 8000);
}

function setDeviceInfo(text) {
  $('deviceInfo').textContent = text;
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function refreshAll() {
  refreshDeviceControls();
  refreshMeasurementControls();
  refreshSnControls();
  refreshCaptureUi();
  refreshFits();
  $('btnWrite').disabled = !state.controller?.isConnected || !sessionReportCache;
  $('btnResetParams').disabled = !state.controller?.isConnected;
  $('btnExport').disabled = !state.controller?.session?.captureResults?.length;
  $('btnReadInfo').disabled = !state.controller?.isConnected;
  $('btnReadParams').disabled = !state.controller?.isConnected;
  $('telemetryOn').disabled = !state.controller?.isConnected || state.otaBusy;
  $('useMock').disabled = state.otaBusy;
  $('requiredRuns').disabled = state.otaBusy;
  for (const id of ['otaSerial','otaBle','otaWifi','otaFile','btnReadInfo','btnReadParams','btnWrite','btnResetParams','btnCancel']) {
    if (state.otaBusy) $(id).disabled = true;
  }
  if (state.otaBusy) for (const button of $('pointsGrid').querySelectorAll('button')) button.disabled = true;
  $('otaSerial').disabled = state.otaBusy; $('otaBle').disabled = state.otaBusy; $('otaWifi').disabled = state.otaBusy; $('otaFile').disabled = state.otaBusy;
  $('wifiRetry').disabled = !!state.wifiUploading; $('wifiCancel').disabled = !state.otaBusy || !!state.wifiUploading;
  if (measurementLocked()) {
    for (const id of ['btnWrite','btnResetParams','otaSerial','otaBle','otaWifi','otaFile']) $(id).disabled = true;
    for (const button of $('pointsGrid').querySelectorAll('button')) button.disabled = true;
  }
}

// ===========================================================================
// 事件绑定
// ===========================================================================

function setSnStatus(text,tone='') {$('snStatus').textContent=text;$('snStatus').className='sn-status '+tone;}
function snCounterKey(){return `aw_sn_DT01_${$('snDate').value}_${$('snLine').value}`;}
function refreshSnCandidate() {
  const parts=$('snDate').value.split('-').map(Number);
  const date=parts.length===3?new Date(parts[0],parts[1]-1,parts[2]):new Date(NaN);
  const candidate=snGenerate({date,line:$('snLine').value,sequence:Number($('snSequence').value)});
  $('snCandidate').textContent=candidate||'日期、产线或流水号无效';refreshSnControls();
}
function refreshSnControls() {
  const connected=!!state.controller?.isConnected;
  const busy=state.snBusy||state.otaBusy||!!captureState?.active||measurementLocked();
  $('snRead').disabled=!connected||busy;
  $('snWrite').disabled=!connected||busy||state.sn!==''||!snValidate($('snCandidate').textContent);
  for(const id of ['snDate','snLine','snSequence'])$(id).disabled=state.snBusy||state.otaBusy;
}
function loadSnCounter() {
  try{$('snSequence').value=localStorage.getItem(snCounterKey())||1;}catch{$('snSequence').value=1;}
  refreshSnCandidate();
}
$('snDate').value=new Date().toLocaleDateString('sv-SE');
$('snDate').addEventListener('change',loadSnCounter);
$('snLine').addEventListener('input',()=>{$('snLine').value=$('snLine').value.toUpperCase();loadSnCounter();});
$('snSequence').addEventListener('input',refreshSnCandidate);
$('snRead').addEventListener('click',()=>{state.sn=null;setSnStatus('正在读取设备 SN…');refreshSnControls();state.controller?.readSn();});
$('snWrite').addEventListener('click',()=>{
  const sn=$('snCandidate').textContent;
  if(state.sn!==''||!snValidate(sn)||!state.controller?.isConnected)return;
  state.snBusy=true;state.snExpected=sn;setSnStatus('正在写入并回读 SN，请保持连接…');refreshSnControls();
  try{if(state.controller.writeSn(sn)==null)throw new Error('SN 请求未发送');}
  catch(error){state.snBusy=false;state.snExpected=null;setSnStatus(error.message,'err');refreshSnControls();}
});
loadSnCounter();


$('requiredRuns').addEventListener('change', () => {
  const count = Number($('requiredRuns').value);
  if (![1, 2, 3].includes(count)) return;
  state.requiredRunsPerPoint = count;
  state.selectedFit = null;
  $('requiredRunsHint').textContent = String(count);
  try { localStorage.setItem(CAPTURE_RUNS_STORAGE_KEY, String(count)); } catch { /* 仍可使用本次设置 */ }
  if (state.controller) {
    try { state.controller.setRequiredRunsPerPoint(count); }
    catch (error) { banner(error.message, 'err'); }
  }
  refreshAll();
});

async function connectBle() {
  try {
    await connect('ble');
    patchTransportLogging(state.ble, 'ble');
  } catch (error) {
    setDeviceInfo('蓝牙连接失败：' + (error?.message || error.code));
  }
}

function openBlePrefixDialog(connectAfterSave) {
  connectAfterPrefix = connectAfterSave;
  $('blePrefixError').textContent = '';
  $('blePrefixSubmit').textContent = connectAfterSave ? '确认并连接' : '保存';
  $('blePrefixDialog').showModal();
}

$('blePrefixForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = parseBleCommandKey($('blePrefixInput').value);
  if (!key) {
    $('blePrefixError').textContent = '请输入完整的 16 字节前缀（32 个十六进制字符）。';
    return;
  }
  bleCommandKey = key;
  $('blePrefixDialog').close();
  if (connectAfterPrefix) void connectBle();
});
$('blePrefixDialog').addEventListener('close', () => { $('blePrefixInput').value = ''; });
$('blePrefixCancel').addEventListener('click', () => $('blePrefixDialog').close());
$('btnBlePrefix').addEventListener('click', () => openBlePrefixDialog(false));

$('btnBle').addEventListener('click', () => {
  if (state.connecting || state.disconnecting || state.otaBusy) return;
  if (state.activeTransport === 'ble') { disconnectAll(); return; }
  if (!state.mock && !bleCommandKey) { openBlePrefixDialog(true); return; }
  void connectBle();
});

$('btnSerial').addEventListener('click', async () => {
  if (state.connecting || state.disconnecting || state.otaBusy) return;
  if (state.activeTransport === 'serial' || state.activeTransport === 'sim') { disconnectAll(); return; }
  try {
    await connect('serial');
    patchTransportLogging(state.serial, 'serial');
  } catch (error) {
    setDeviceInfo('串口连接失败：' + (error?.message || error.code));
  }
});

$('useMock').addEventListener('change', async (event) => {
  state.mock = event.target.checked;
  await disconnectAll();
  if (state.mock) {
    try {
      await connect('sim');
      patchTransportLogging(state.sim, 'serial');
    } catch (error) {
      setDeviceInfo('模拟设备启动失败：' + error.message);
    }
  }
});

$('btnCancel').addEventListener('click', () => {
  cancelAutoRetry();
  state.controller?.cancelCapture();
});

$('btnWrite').addEventListener('click', writeSelected);
$('btnResetParams').addEventListener('click', () => {
  if (confirm('确认恢复 K=1 / B=0？旧露点校准将失效。')) state.controller?.resetParameters();
});
$('btnExport').addEventListener('click', exportSession);
$('btnReadInfo').addEventListener('click', () => state.controller?.readInfo());
$('btnReadParams').addEventListener('click', () => state.controller?.readParameters());
$('btnSaveMaster').addEventListener('click', saveMaster);
$('btnRecompute').addEventListener('click', refreshFits);

$('measureBean').addEventListener('change', () => {
  try {
    state.measureBeanEdited = true;
    state.measurePending = true; state.measureError = '';
    state.controller.selectBean(Number($('measureBean').value));
    refreshAll();
  } catch (error) {
    state.measurePending = false; state.measureBeanEdited = false;
    if (state.measure) $('measureBean').value = String(state.measure.beanId);
    refreshAll(); banner(error.message, 'warn');
  }
});
$('deviceLanguage').addEventListener('change',()=>{state.deviceLanguageEdited=true;});
$('deviceStandby').addEventListener('change',()=>{state.deviceStandbyEdited=true;});
$('deviceRead').addEventListener('click',()=>{state.deviceLanguageEdited=false;state.deviceStandbyEdited=false;state.controller?.readDeviceControl();});
$('deviceApplyLanguage').addEventListener('click',()=>applyDeviceControl(1,Number($('deviceLanguage').value)));
$('deviceApplyStandby').addEventListener('click',()=>applyDeviceControl(2,Number($('deviceStandby').value)));
$('deviceCalMd').addEventListener('click',()=>openDeviceCalibration(3));
$('deviceCalAw').addEventListener('click',()=>openDeviceCalibration(4));
$('deviceCalDismiss').addEventListener('click',()=>$('deviceCalDialog').close());
$('deviceCalDialog').addEventListener('close',()=>{state.calDialogAction=null;});
$('deviceCalConfirm').addEventListener('click',()=>{
  const action=state.calDialogAction;
  $('deviceCalDialog').close();
  if([3,4].includes(action))applyDeviceControl(action,0);
});
$('measureMd').addEventListener('click', () => startDeviceMeasurement(1));
$('measureAll').addEventListener('click', () => startDeviceMeasurement(3));

for (const toggle of document.querySelectorAll('.panel-toggle')) {
  toggle.addEventListener('click', () => {
    const body = $(toggle.getAttribute('aria-controls'));
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    body.hidden = !expanded;
    toggle.closest('.card').classList.toggle('collapsed', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    const title = toggle.closest('h2').firstChild.textContent.trim();
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${title}`);
    requestAnimationFrame(() => { drawCharts(); });
  });
}

$('telemetryOn').addEventListener('change', (event) => { state.telemetryOn = event.target.checked; });
$('chartWindow').addEventListener('change', () => { trimSeries(); chartsDirty = true; });
$('chartPause').addEventListener('click', () => {
  state.chartPaused = !state.chartPaused;
  $('chartPause').textContent = state.chartPaused ? '继续' : '暂停';
});
$('chartExport').addEventListener('click', exportChartCsv);
$('mdExport').addEventListener('click', () => {
  const session = state.controller?.session;
  if (!session?.mdTelemetry?.length) return;
  const text = moistureCsv(session.mdTelemetry, session.deviceId);
  download(new Blob(['\ufeff', text], { type:'text/csv;charset=utf-8' }), `moisture_delta_${Date.now()}.csv`);
});

$('otaFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  otaFileBytes = new Uint8Array(await file.arrayBuffer());
  otaFileName=file.name;
  try { validateFirmwareImage(otaFileBytes); } catch(error) { otaFileBytes = null; return otaLogLine(error.message); }
  otaLogLine('已选择固件：' + file.name + '（' + otaFileBytes.length + ' 字节）');
  renderOtaStatus();
});

$('otaSerial').addEventListener('click', () => runOta('serial'));
$('otaBle').addEventListener('click', () => runOta('ble'));
$('otaWifi').addEventListener('click', startWifiUpgrade);
$('wifiRetry').addEventListener('click', () => { if (otaFileBytes) beginWifiProbe(); });
$('wifiCancel').addEventListener('click', () => { otaResult.set('cancelled','未完成升级。可重新检测热点继续上传，或重启设备回到正常模式。');renderOtaStatus();finishWifiWait(); otaLogLine('已停止等待热点；设备仍处于热点模式，可重新检测或断电回正常模式'); });
$('otaVerify').addEventListener('click',()=>{
  if(!state.controller?.isConnected)return banner('请先点击顶部连接蓝牙或连接串口，再核对升级结果','warn');
  if(otaFileBytes&&(!otaResult.canVerify||firmwareIdentity(otaFileBytes).sha256!==otaResult.value.sha256)){
    otaResult.start(otaFileName,'verify',otaFileBytes);otaResult.value.verifyOnly=true;
    otaResult.set('unconfirmed','仅核对当前运行固件，不执行烧录。');renderOtaStatus();
  }
  scheduleOtaVerification(0);
});

for (const button of document.querySelectorAll('.logfmt')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.hex = !pane.hex;
    button.textContent = pane.hex ? 'HEX' : '文本';
    renderLog(pane);
  });
}
for (const button of document.querySelectorAll('.logpause')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.paused = !pane.paused;
    button.textContent = pane.paused ? '继续' : '暂停';
    if (!pane.paused) renderLog(pane);
  });
}
for (const button of document.querySelectorAll('.logclear')) {
  button.addEventListener('click', () => {
    const pane = logPanes[button.dataset.ch];
    pane.entries = [];
    renderLog(pane);
  });
}

$('bannerClose').addEventListener('click', () => $('banner').classList.add('hidden'));

// ===========================================================================
// 启动
// ===========================================================================

// 刷新/关闭页面时主动释放本页的 GATT 客户端，避免旧页和新页争用连接。
window.addEventListener('pagehide', () => {
  if (state.ble?.device?.gatt?.connected) state.ble.device.gatt.disconnect();
});

loadMaster();
try {
  const storedRuns = Number(localStorage.getItem(CAPTURE_RUNS_STORAGE_KEY));
  if ([1, 2, 3].includes(storedRuns)) state.requiredRunsPerPoint = storedRuns;
} catch { /* 默认每点三次 */ }
$('requiredRuns').value = String(state.requiredRunsPerPoint);
$('requiredRunsHint').textContent = String(state.requiredRunsPerPoint);
buildPointsUi();
buildMasterUi();
refreshCaptureUi();
refreshFits();
drawCharts();

const autoSerialTarget=new URLSearchParams(location.search).get('serial_device');
let restoreSerial=false;try {restoreSerial=localStorage.getItem('aw_serial_auto')==='1';}catch{}
if(location.hash==='#autoserial' || (restoreSerial && !['#autoble','#noauto'].includes(location.hash))) {
  connect('serial',{authorizedOnly:true,expectedId:autoSerialTarget}).catch(error=>banner(error.message,'warn'));
}
