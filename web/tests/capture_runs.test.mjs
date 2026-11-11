import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationController, CalibrationSession } from '../aw_controller.js';
import { SimTransport } from '../aw_sim.js';

const master = [38.983,57.530,71.577,89.697];
function run(pointId, value=master[pointId], resultCode='stable') {
  return {pointId, meanRhRaw:value, meanRhCorrected:value, stddevRhRaw:0.01,
    sampleCount:150, elapsedMs:15000, resultCode};
}

for (const requiredRunsPerPoint of [1,2,3]) {
  test(`${requiredRunsPerPoint} runs: framed capture results generate a report only after all four points meet target`, async () => {
    const sim = new SimTransport(), controller = new CalibrationController({requiredRunsPerPoint});
    await sim.connect(); clearInterval(sim._timer); sim._timer=null;
    let clock=0; sim.now=()=>clock;
    controller.connectTransport(sim,{mode:'simulator'});
    const reports=[]; controller.on('report',({data})=>reports.push(data));
    try {
      // Cancelled runs are recorded but never count towards the target.
      controller.startCapture(0); controller.cancelCapture();
      assert.equal(controller.session.acceptedRunsByPoint[0].length,0);
      for(let round=0;round<requiredRunsPerPoint;round++) for(let point=0;point<4;point++) {
        assert.equal(controller.session.report,null);
        controller.startCapture(point);
        clock+=15000; sim._tick();
        if(round!==requiredRunsPerPoint-1 || point!==3) {
          assert.equal(controller.session.devicePointMeans(),null);
          assert.equal(reports.length,0);
        }
      }
      assert.equal(reports.length,1);
      assert.ok(controller.session.report);
      assert.deepEqual(controller.session.acceptedRunsByPoint.map(r=>r.length),Array(4).fill(requiredRunsPerPoint));
      assert.equal(controller.session.pointAggregate(0).stdevRhRaw===null,requiredRunsPerPoint===1);
    } finally { await controller.disconnect(); }
  });
}

test('increasing target invalidates report, lowering it reuses every accepted run without discarding captures', () => {
  const controller=new CalibrationController({requiredRunsPerPoint:1});
  for(let point=0;point<4;point++) controller.session.recordCapture(run(point));
  assert.ok(controller.recomputeReport());
  assert.equal(controller.setRequiredRunsPerPoint(2),null);
  assert.equal(controller.session.report,null);
  for(let point=0;point<4;point++) controller.session.recordCapture(run(point,master[point]+0.2));
  assert.ok(controller.recomputeReport());
  assert.ok(Math.abs(controller.session.pointAggregate(0).meanRhRaw-(master[0]+0.1))<1e-10);
  assert.equal(controller.setRequiredRunsPerPoint(3),null);
  assert.equal(controller.session.report,null);
  assert.ok(controller.setRequiredRunsPerPoint(1));
  assert.equal(controller.session.captureResults.length,8);
  assert.deepEqual(controller.session.acceptedRunsByPoint.map(r=>r.length),[2,2,2,2]);
  assert.equal(controller.session.requiredRunsPerPoint,1);
});

test('default is three, malformed/failed runs do not satisfy the target, invalid settings do not mutate it', () => {
  const session=new CalibrationSession(master);
  assert.equal(session.requiredRunsPerPoint,3);
  for(let point=0;point<4;point++) {
    session.recordCapture(run(point));
    session.recordCapture(run(point,NaN));
    session.recordCapture(run(point,master[point],'timeout'));
    session.recordCapture(run(point,master[point],'sensor_error'));
  }
  assert.equal(session.devicePointMeans(),null);
  assert.deepEqual(session.acceptedRunsByPoint.map(r=>r.length),[1,1,1,1]);
  const controller=new CalibrationController();
  for(const value of [0,4,1.5,NaN,'1',null]) {
    assert.throws(()=>controller.setRequiredRunsPerPoint(value),RangeError);
    assert.equal(controller.requiredRunsPerPoint,3);
    assert.equal(controller.session.requiredRunsPerPoint,3);
  }
});

test('reconnect retains chosen target and starts with an empty report', async () => {
  const controller=new CalibrationController();
  controller.setRequiredRunsPerPoint(2);
  const sim=new SimTransport(); await sim.connect();
  try {
    controller.connectTransport(sim,{mode:'simulator'});
    assert.equal(controller.session.requiredRunsPerPoint,2);
    assert.equal(controller.session.report,null);
    assert.equal(controller.session.devicePointMeans(),null);
  } finally { await controller.disconnect(); }
});
