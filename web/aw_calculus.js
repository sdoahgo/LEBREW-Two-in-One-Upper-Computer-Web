// aw_calculus.js — 标定拟合与统计（calibration.py 的 JS 移植，公式与判定逐行对齐）
// 两种拟合：端点法（0.328 与 水 两点定斜率）和四点锚定最小二乘；默认推荐 RMSE 更小者。

export const WARNING_TEXT = '单一斜率修正不足，可能需要K+B或多点校准';
const DENOMINATOR_EPSILON = 1e-9;

function validatePoints(masterRh, deviceRh) {
  const master = [...masterRh];
  const device = [...deviceRh];
  if (master.length !== 4 || device.length !== 4) {
    throw new Error('master and device RH data must contain four points');
  }
  if (![...master, ...device].every(Number.isFinite)) {
    throw new Error('RH values must be finite');
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

/** 输入四个主基准 RH 与四个设备均值 RH，返回双拟合报告。 */
export function calculateReport(masterRh, deviceRh) {
  const [master, device] = validatePoints(masterRh, deviceRh);

  const endpointDenominator = device[3] - device[0];
  if (Math.abs(endpointDenominator) < DENOMINATOR_EPSILON) {
    throw new Error('device RH span is too small');
  }
  const endpointSlope = (master[3] - master[0]) / endpointDenominator;

  const anchoredDeltas = device.slice(1).map((value) => value - device[0]);
  const masterDeltas = master.slice(1).map((value) => value - master[0]);
  const lsqDenominator = anchoredDeltas.reduce((sum, delta) => sum + delta * delta, 0);
  if (Math.abs(lsqDenominator) < DENOMINATOR_EPSILON) {
    throw new Error('device RH span is too small');
  }
  const lsqNumerator = anchoredDeltas.reduce((sum, delta, index) => sum + delta * masterDeltas[index], 0);
  const lsqSlope = lsqNumerator / lsqDenominator;

  const endpoint = fit('endpoint', master, device, endpointSlope);
  const leastSquares = fit('least_squares', master, device, lsqSlope);
  const recommendedMethod = endpoint.rmse <= leastSquares.rmse ? 'endpoint' : 'least_squares';

  const warningReasons = [];
  if (Math.abs(device[0] - master[0]) > 1.0 ||
      (recommendedMethod === 'endpoint' ? endpoint.rmse : leastSquares.rmse) > 0.75 ||
      Math.max(...(recommendedMethod === 'endpoint' ? endpoint : leastSquares).residuals.map(Math.abs)) > 1.0) {
    warningReasons.push(WARNING_TEXT);
  }
  return { endpoint, leastSquares, recommendedMethod, warningReasons };
}

/** 单点聚合：均值 + 样本标准差（单次无离散度记 null）— 对齐 aggregate_accepted_runs。 */
export function aggregateAcceptedRuns(runs) {
  const accepted = [...runs];
  if (accepted.length === 0) throw new Error('at least one accepted run is required');
  if (accepted.some((run) => run.resultCode !== 'stable')) {
    throw new Error('aggregate accepts stable runs only');
  }
  const pointId = accepted[0].pointId;
  if (accepted.some((run) => run.pointId !== pointId)) {
    throw new Error('aggregate requires runs from the same point_id');
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
    stdevRhCorrected: count > 1 ? sampleStdev(correctedValues) : null,
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
