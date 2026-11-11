// 端到端演练：模拟设备 + 控制器全流程
import { SimTransport } from '../aw_sim.js';
import { CalibrationController } from '../aw_controller.js';

const sim = new SimTransport();
await sim.connect();
const controller = new CalibrationController({ masterProfileRh: [38.983, 57.530, 71.577, 89.697] });
const events = [];
for (const kind of ['connected','info','parameters','write_verified','capture_started','capture_progress','capture_result','report','stream_configured','heartbeat','request_timeout','error','diagnostic']) {
  controller.on(kind, (e) => events.push(e.kind));
}
let errors = 0;
controller.on('error', (e) => { errors++; console.log('ERROR:', e.message); });
controller.connectTransport(sim, { mode: 'simulator' });
controller.readInfo();
controller.readParameters();
await new Promise(r => setTimeout(r, 300));
controller.writeParameters(1.05, -0.3);
await new Promise(r => setTimeout(r, 600));
controller.startCapture(0);
await new Promise(r => setTimeout(r, 2500));
controller.tick();
await new Promise(r => setTimeout(r, 200));
const uniq = [...new Set(events)];
console.log('events:', uniq.join(','));
console.log('errors:', errors);
console.log('telemetry count:', controller.session.telemetry.length);
console.log('write params in sim: K=' + sim._slopeK + ' B=' + sim._offsetB);
const ok = errors === 0
  && uniq.includes('connected') && uniq.includes('info') && uniq.includes('parameters')
  && uniq.includes('write_verified') && uniq.includes('capture_started') && uniq.includes('capture_progress')
  && controller.session.telemetry.length > 5 && Math.abs(sim._slopeK - 1.05) < 1e-6;
await sim.disconnect();
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
