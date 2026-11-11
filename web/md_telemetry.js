import { BEAN_LABELS } from './aw_protocol.js';

export function mdValues(sample) {
  const valid = (mask, value) => sample && (sample.flags & mask) === mask && Number.isFinite(value) ? value : null;
  const knownBean = sample && BEAN_LABELS[sample.beanId] != null;
  const empty = valid(8, sample?.emptyCapacitancePf);
  const emptyCapacitancePf = empty > 0 ? empty : null;
  return {
    beanName: sample ? (BEAN_LABELS[sample.beanId] ?? `未知豆种 (${sample.beanId})`) : '等待设备',
    moisturePct: knownBean ? valid(4, sample.moisturePct) : null,
    densityGl: valid(2, sample?.densityGl), capacitancePf: valid(1, sample?.capacitancePf),
    weightAdc: valid(2, sample?.weightAdc), weightG: valid(2, sample?.weightG),
    emptyCapacitancePf,
    deltaCapacitancePf: emptyCapacitancePf == null ? null : valid(9, sample?.deltaCapacitancePf),
  };
}

export function mdCsvCells(sample) {
  const v = mdValues(sample);
  return [sample.beanId, v.beanName, v.moisturePct, v.densityGl, v.capacitancePf, v.weightAdc, v.weightG,
    v.emptyCapacitancePf, v.deltaCapacitancePf];
}

export const MOISTURE_CSV_COLUMNS = Object.freeze([
  'timestamp', 'device_id', 'sample_sequence', 'flags',
  'bean_id', 'bean_name', 'moisture_device_pct', 'density_g_l', 'capacitance_raw_pf',
  'weight_raw_adc', 'weight_g', 'capacitance_empty_pf', 'delta_capacitance_pf', 'reference_moisture_pct',
]);

export function moistureCsv(samples, deviceId) {
  const escape = value => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [MOISTURE_CSV_COLUMNS.join(',')];
  for (const sample of samples) {
    // The device result is not ground truth: leave reference moisture blank.
    const cells = [sample.timestamp, deviceId, sample.sampleSequence, sample.flags,
      ...mdCsvCells(sample), ''];
    rows.push(cells.map(escape).join(','));
  }
  return rows.join('\r\n');
}
