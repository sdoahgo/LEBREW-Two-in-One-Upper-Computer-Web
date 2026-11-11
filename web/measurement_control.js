export const MeasurementMode = Object.freeze({MD: 1, AW: 2, ALL: 3});
export const MeasurementPhase = Object.freeze({IDLE: 0, PENDING: 1, RUNNING: 2, COMPLETED: 3, CANCELLED: 4, FAILED: 5});
export const BEAN_NAMES = Object.freeze(['烘焙豆', '生豆', '带壳豆', '干果']);
export const MODE_NAMES = Object.freeze(['', '水分与密度', '水活', '全部测量']);
export const measurementActive = state => !!state && [1, 2].includes(state.phase);

export function packMeasurementControl(action, beanId, mode, requestId) {
  if (![1, 2, 3].includes(action) || !Number.isInteger(requestId) || requestId < 0 || requestId > 0xffffffff)
    throw new Error('测量操作或任务编号无效');
  if (!Number.isInteger(beanId) || beanId < 0 || beanId > 3 ||
      (action === 3 ? mode !== 0 : ![1, 2, 3].includes(mode)) || (action !== 2 && requestId === 0))
    throw new Error('豆种或测量方式无效');
  const bytes = Uint8Array.of(action, beanId, mode, 0, 0, 0, 0, 0);
  new DataView(bytes.buffer).setUint32(4, requestId, true);
  return bytes;
}

export function unpackMeasurementControl(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8 || bytes[3] !== 0)
    throw new Error('测量命令长度或保留字段无效');
  const requestId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  packMeasurementControl(bytes[0], bytes[1], bytes[2], requestId);
  return {action: bytes[0], beanId: bytes[1], mode: bytes[2], requestId};
}

export function unpackMeasurementState(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 28 || bytes[0] !== 0)
    throw new Error('设备测量状态长度或状态码无效');
  if (bytes[1] > 5 || bytes[2] > 3 || bytes[3] > 3 || (bytes[4] & ~3) ||
      (bytes[4] & ~bytes[3]) || (bytes[7] & ~3) ||
      (bytes[1] === 3 && (bytes[3] === 0 || bytes[4] !== bytes[3])))
    throw new Error('设备测量状态字段无效');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moisture = view.getFloat32(16, true), density = view.getFloat32(20, true), aw = view.getFloat32(24, true);
  if (((bytes[4] & 1) && ![moisture, density].every(Number.isFinite)) ||
      ((bytes[4] & 2) && (!Number.isFinite(aw) || aw < 0 || aw > 1)))
    throw new Error('设备测量结果数值无效');
  return {phase: bytes[1], beanId: bytes[2], mode: bytes[3], resultFlags: bytes[4],
    screenId: bytes[5], error: bytes[6], deviceReady: !!(bytes[7] & 1), deviceBusy: !!(bytes[7] & 2),
    requestId: view.getUint32(8, true), elapsedMs: view.getUint32(12, true),
    moisture: bytes[4] & 1 ? moisture : null, density: bytes[4] & 1 ? density : null,
    aw: bytes[4] & 2 ? aw : null};
}

export function packMeasurementState(state) {
  const bytes = new Uint8Array(28), view = new DataView(bytes.buffer);
  bytes.set([0, state.phase ?? 0, state.beanId ?? 0, state.mode ?? 0,
    state.resultFlags ?? 0, state.screenId ?? 0, state.error ?? 0,
    (state.deviceReady ? 1 : 0) | (state.deviceBusy ? 2 : 0)]);
  view.setUint32(8, state.requestId ?? 0, true); view.setUint32(12, state.elapsedMs ?? 0, true);
  view.setFloat32(16, state.moisture ?? 0, true); view.setFloat32(20, state.density ?? 0, true);
  view.setFloat32(24, state.aw ?? 0, true);
  unpackMeasurementState(bytes);
  return bytes;
}

export function measurementStatusText(state) {
  if (!state) return '连接设备后可选择豆种并启动测量。';
  const label = `${BEAN_NAMES[state.beanId]} · ${MODE_NAMES[state.mode] || '待测量'}`;
  if (state.phase === 0) return state.deviceBusy ? '设备正在校准，完成后可启动测量。' :
    state.deviceReady ? '设备已就绪，选择豆种立即同步设备界面。' : '设备正在启动，请稍候。';
  if (state.phase === 1 && state.mode === 0) return `${BEAN_NAMES[state.beanId]}：正在同步设备界面。`;
  if (state.phase === 1) return `${label}：指令已接收，等待设备启动。`;
  if (state.phase === 2) return `${label}：测量中${state.mode === 3 && (state.resultFlags & 1) ? '，水分与密度已完成，水活继续测量' : ''}。`;
  if (state.phase === 3) return `${label}：测量完成。`;
  if (state.phase === 4) return `${label}：已取消；已完成的单项结果保留。`;
  return `${label}：测量未完成${state.error === 6 ? '，等待传感器超时' : state.error === 10 ? '，请先做设备空杯校准' : state.error === 4 ? '，设备正忙' : ''}。`;
}
