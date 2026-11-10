import json
import tempfile
from pathlib import Path
import unittest

from aw_calibrator.calibration import calculate_report
from aw_calibrator.controller import ControllerEvent
from aw_calibrator.exporter import SessionExporter
from aw_calibrator.models import CalibrationSession, CaptureRun, MasterProfile
from aw_calibrator.protocol import (
    CaptureProgress,
    DeviceInfo,
    DeviceParameters,
    Status,
    Telemetry,
)
from aw_calibrator.ui import (
    AwCalibratorApp,
    CalibrationWorkflow,
    selected_fit,
    session_has_activity,
)


class FakeController:
    def __init__(self) -> None:
        self.next_sequence = 100
        self.write_calls = []
        self.capture_calls = []
        self.heartbeat_calls = 0

    def _sequence(self) -> int:
        result = self.next_sequence
        self.next_sequence += 1
        return result

    def read_info(self) -> int:
        return self._sequence()

    def read_parameters(self) -> int:
        return self._sequence()

    def reset_parameters(self) -> int:
        return self._sequence()

    def start_capture(self, point_id: int) -> int:
        self.capture_calls.append(point_id)
        return self._sequence()

    def cancel_capture(self) -> int:
        return self._sequence()

    def write_parameters(self, slope_k: float, offset_b: float) -> int:
        self.write_calls.append((slope_k, offset_b))
        return self._sequence()
    def send_heartbeat(self) -> int:
        self.heartbeat_calls += 1
        return self._sequence()



def stable_run(point_id: int, repeat: int = 0) -> CaptureRun:
    raw = (38.857, 59.780, 77.687, 98.787)[point_id] + repeat * 0.01
    return CaptureRun(point_id, raw, raw + 7.0, 0.02, 150, 15_000, "stable")


def telemetry(sequence: int) -> Telemetry:
    return Telemetry(7, sequence, 25.0, 50.0, 57.0, 0.5, 0.5)


class CalibrationWorkflowTests(unittest.TestCase):
    def test_failed_active_capture_waits_for_automatic_retry(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        sequence = workflow.issue("start_capture", lambda: controller.start_capture(1))
        workflow.consume(ControllerEvent("capture_started", {"point_id": 1}, sequence))

        failed = CaptureRun(1, 59.7, 59.7, 0.08, 150, 480_000, "timeout")
        workflow.consume(ControllerEvent("capture_result", failed, 700))

        self.assertEqual(workflow.state.capture_retry_point, 1)
        self.assertFalse(any(workflow.state.capture_enabled))
        self.assertTrue(workflow.state.cancel_enabled)
        self.assertIn("自动继续", workflow.state.status_text)

    def test_write_selected_parameters_rejects_one_or_two_repeats_per_point(self):
        for repeat_count in (1, 2):
            with self.subTest(repeat_count=repeat_count):
                controller = FakeController()
                workflow = CalibrationWorkflow(controller, MasterProfile())
                workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
                for point_id in range(4):
                    for repeat in range(repeat_count):
                        workflow.consume(
                            ControllerEvent("capture_result", stable_run(point_id, repeat), 800 + point_id),
                        )

                self.assertIsNotNone(workflow.state.report)
                self.assertFalse(workflow.state.write_enabled)
                with self.assertRaisesRegex(RuntimeError, "3"):
                    workflow.write_selected_parameters()
                self.assertEqual(controller.write_calls, [])
                self.assertEqual(workflow.state.pending_requests, ())

    def test_invalid_profile_clears_report_blocks_stale_write_and_valid_recovery_recomputes(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        for point_id in range(4):
            for repeat in range(3):
                workflow.consume(ControllerEvent("capture_result", stable_run(point_id, repeat), 850 + point_id))
        stale_report = workflow.state.report
        self.assertTrue(workflow.state.write_enabled)

        for invalid_entries in (
            ("40", "", "75", "92"),
            ("40", "nan", "75", "92"),
        ):
            with self.subTest(entries=invalid_entries):
                with self.assertRaisesRegex(ValueError, "基准 RH 输入无效"):
                    workflow.set_profile_entries(invalid_entries)
                self.assertFalse(workflow.state.profile_valid)
                self.assertIsNone(workflow.state.report)
                self.assertIsNone(workflow.session.report)
                self.assertFalse(workflow.state.write_enabled)
                workflow.consume(ControllerEvent("report", stale_report, 999))
                self.assertIsNone(workflow.state.report)
                with self.assertRaisesRegex(ValueError, "基准 RH"):
                    workflow.write_selected_parameters()
                self.assertEqual(controller.write_calls, [])

        with tempfile.TemporaryDirectory() as directory:
            paths = SessionExporter().export(workflow.session, directory)
            invalid_export = json.loads(Path(paths.json_path).read_text(encoding="utf-8"))
        self.assertIsNone(invalid_export["report"])

        changed_entries = ("40.000", "60.000", "75.000", "92.000")
        workflow.set_profile_entries(changed_entries)
        expected = calculate_report(
            tuple(float(value) for value in changed_entries),
            tuple(workflow.session.point_aggregate(point_id).mean_rh_raw for point_id in range(4)),
        )
        self.assertTrue(workflow.state.profile_valid)
        self.assertEqual(workflow.state.report, expected)
        self.assertEqual(workflow.session.report, expected)
        self.assertTrue(workflow.state.write_enabled)
        chosen = selected_fit(workflow.state)
        workflow.write_selected_parameters()
        self.assertEqual(controller.write_calls, [(chosen.slope_k, chosen.offset_b)])

    def test_changed_profile_is_authoritative_for_report_and_exact_written_fit(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        for point_id in range(4):
            for repeat in range(3):
                workflow.consume(ControllerEvent("capture_result", stable_run(point_id, repeat), 900 + point_id))

        changed = MasterProfile((40.0, 60.0, 75.0, 92.0))
        workflow.set_profile(changed)
        raw_means = tuple(
            workflow.session.point_aggregate(point_id).mean_rh_raw
            for point_id in range(4)
        )
        expected = calculate_report(changed.rh, raw_means)
        stale = calculate_report(MasterProfile().rh, raw_means)

        workflow.consume(ControllerEvent("report", stale, 999))

        self.assertEqual(workflow.state.report, expected)
        self.assertEqual(workflow.session.report, expected)
        self.assertNotEqual(expected.least_squares.slope_k, stale.least_squares.slope_k)
        chosen = selected_fit(workflow.state)
        sequence = workflow.write_selected_parameters()
        self.assertEqual(controller.write_calls, [(chosen.slope_k, chosen.offset_b)])
        self.assertEqual(workflow.state.pending_requests[0].sequence, sequence)

    def test_interleaved_responses_only_resolve_their_own_sequence(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        info_sequence = workflow.issue("read_info", controller.read_info, allow_concurrent=True)
        params_sequence = workflow.issue("read_parameters", controller.read_parameters, allow_concurrent=True)
        reset_sequence = workflow.issue("reset_parameters", controller.reset_parameters, allow_concurrent=True)

        workflow.consume(ControllerEvent("stream_configured", {"enabled": True}, 77))
        workflow.consume(ControllerEvent("parameters", DeviceParameters(Status.OK, 1, True, True, 1.0, 0.0, 0.0), 555))
        self.assertEqual(workflow.state.pending_sequences, (info_sequence, params_sequence, reset_sequence))

        workflow.consume(ControllerEvent("info", DeviceInfo(Status.OK, "SIM", "1"), info_sequence))
        self.assertEqual(workflow.state.pending_sequences, (params_sequence, reset_sequence))
        workflow.consume(ControllerEvent("error", {"reason": "unrelated"}, 444, "unrelated"))
        self.assertEqual(workflow.state.pending_sequences, (params_sequence, reset_sequence))
        workflow.consume(ControllerEvent("parameters", DeviceParameters(Status.OK, 1, True, True, 1.0, 0.0, 0.0), params_sequence))
        self.assertEqual(workflow.state.pending_sequences, (reset_sequence,))
        workflow.consume(ControllerEvent("reset", DeviceParameters(Status.OK, 2, True, False, 1.0, 0.0, 0.0), reset_sequence))
        self.assertEqual(workflow.state.pending_sequences, ())

    def test_session_finishes_and_exports_exact_events_and_parameter_outcomes(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        workflow.consume(ControllerEvent("telemetry", telemetry(1), 800))
        workflow.consume(ControllerEvent("telemetry", telemetry(2), 801))
        stable = stable_run(0)
        cancelled = CaptureRun(0, 38.9, 45.9, 0.2, 70, 7_000, "cancelled")
        workflow.consume(ControllerEvent("capture_result", stable, 802))
        workflow.consume(ControllerEvent("capture_result", cancelled, 803))

        write_sequence = workflow.issue(
            "write_parameters",
            lambda: controller.write_parameters(0.9, 4.0),
            allow_concurrent=True,
        )
        workflow.consume(ControllerEvent("error", {"reason": "readback mismatch"}, write_sequence, "readback mismatch"))
        reset_sequence = workflow.issue("reset_parameters", controller.reset_parameters, allow_concurrent=True)
        parameters = DeviceParameters(Status.OK, 3, True, False, 1.0, 0.0, 0.0)
        workflow.consume(ControllerEvent("reset", parameters, reset_sequence))
        finished_session = workflow.session
        workflow.consume(ControllerEvent("disconnected"))

        self.assertIsNotNone(workflow.session.ended_at)
        self.assertEqual(workflow.finished_sessions, [finished_session])
        self.assertEqual(len(workflow.session.telemetry), 2)
        self.assertEqual(workflow.session.capture_results, (stable, cancelled))
        outcomes = tuple((item.operation, item.status) for item in workflow.session.parameter_operations)
        self.assertIn(("write_parameters", "error"), outcomes)
        self.assertIn(("reset", "ok"), outcomes)

        with tempfile.TemporaryDirectory() as directory:
            paths = SessionExporter().export(workflow.session, directory)
            exported = json.loads(Path(paths.json_path).read_text(encoding="utf-8"))
        self.assertIsNotNone(exported["ended_at"])
        self.assertEqual(len(exported["telemetry"]), 2)
        self.assertEqual(len(exported["captures"]), 2)
        self.assertTrue(any(item["operation"] == "write_parameters" and item["status"] == "error"
                            for item in exported["parameter_operations"]))

    def test_parameter_success_audit_requires_matching_pending_sequence_context(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        parameters = DeviceParameters(Status.OK, 3, True, False, 0.9, 4.0, 0.0)

        workflow.consume(ControllerEvent("write_verified", parameters, 999))
        workflow.consume(ControllerEvent("reset", parameters, 998))
        self.assertEqual(workflow.session.parameter_operations, ())

        write_sequence = workflow.issue(
            "write_parameters",
            lambda: controller.write_parameters(0.9, 4.0),
            allow_concurrent=True,
        )
        workflow.consume(ControllerEvent("write_verified", parameters, write_sequence))
        reset_sequence = workflow.issue(
            "reset_parameters",
            controller.reset_parameters,
            allow_concurrent=True,
        )
        workflow.consume(ControllerEvent("reset", parameters, reset_sequence))

        self.assertEqual(
            tuple((item.operation, item.status) for item in workflow.session.parameter_operations),
            (("write", "verified"), ("reset", "ok")),
        )

    def test_cancel_response_is_ack_only_until_terminal_result_arrives(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        start_sequence = workflow.issue("start_capture", lambda: controller.start_capture(2))
        workflow.consume(ControllerEvent("capture_started", {"point_id": 2, "capture_id": 0x2222}, start_sequence))
        workflow.consume(ControllerEvent("capture_progress", CaptureProgress(2, 0x2222, 20, 2_000, 71.5, 0.02), 700))
        self.assertTrue(workflow.state.cancel_enabled)

        cancel_sequence = workflow.issue("cancel_capture", controller.cancel_capture, allow_concurrent=True)
        self.assertFalse(workflow.state.cancel_enabled)
        workflow.consume(ControllerEvent("capture_cancelled", sequence=cancel_sequence + 1))
        self.assertEqual(workflow.state.capture_point, 2)
        self.assertIsNotNone(workflow.state.capture_progress)
        self.assertEqual(workflow.state.pending_sequences, (cancel_sequence,))
        workflow.consume(ControllerEvent("capture_cancelled", sequence=cancel_sequence))
        self.assertEqual(workflow.state.capture_point, 2)
        self.assertIsNotNone(workflow.state.capture_progress)
        self.assertTrue(workflow.state.cancel_enabled)
        self.assertEqual(workflow.state.pending_sequences, ())

        cancelled = CaptureRun(2, 71.5, 78.5, 0.02, 20, 2_000, "cancelled")
        workflow.consume(ControllerEvent("capture_result", cancelled, 701))
        self.assertIsNone(workflow.state.capture_point)
        self.assertFalse(workflow.state.cancel_enabled)
        self.assertEqual(workflow.state.accepted_counts, (0, 0, 0, 0))
        self.assertEqual(workflow.session.capture_results, (cancelled,))

    def test_capture_disconnect_reconnect_exposes_one_orphan_cancel_recovery(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "serial"}))
        self.assertFalse(workflow.state.cancel_enabled)

        start_sequence = workflow.issue("start_capture", lambda: controller.start_capture(1))
        workflow.consume(
            ControllerEvent(
                "capture_started",
                {"point_id": 1, "capture_id": 0x1111},
                start_sequence,
            )
        )
        workflow.consume(ControllerEvent("disconnected"))
        self.assertTrue(workflow.state.orphan_capture_recovery)
        self.assertFalse(workflow.state.cancel_enabled)

        workflow.consume(ControllerEvent("connected", {"mode": "serial"}))
        self.assertTrue(workflow.state.orphan_capture_recovery)
        self.assertTrue(workflow.state.cancel_enabled)
        self.assertFalse(any(workflow.state.capture_enabled))

        cancel_sequence = workflow.issue("cancel_capture", controller.cancel_capture)
        workflow.consume(ControllerEvent("capture_cancelled", sequence=cancel_sequence))
        self.assertFalse(workflow.state.orphan_capture_recovery)
        self.assertFalse(workflow.state.cancel_enabled)
        self.assertTrue(all(workflow.state.capture_enabled))

        next_sequence = workflow.issue("start_capture", lambda: controller.start_capture(2))
        workflow.consume(
            ControllerEvent(
                "capture_started",
                {"point_id": 2, "capture_id": 0x2222},
                next_sequence,
            )
        )
        self.assertEqual(workflow.state.capture_point, 2)
        self.assertFalse(workflow.state.orphan_capture_recovery)
        self.assertTrue(workflow.state.cancel_enabled)

    def test_delayed_old_point_events_do_not_replace_or_clear_new_active_capture(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        for point_id in (0, 1, 3):
            for repeat in range(3):
                workflow.consume(ControllerEvent("capture_result", stable_run(point_id, repeat), 600 + point_id))
        for repeat in range(2):
            workflow.consume(ControllerEvent("capture_result", stable_run(2, repeat), 602))

        start_sequence = workflow.issue("start_capture", lambda: controller.start_capture(1))
        workflow.consume(ControllerEvent("capture_started", {"point_id": 1, "capture_id": 0x1111}, start_sequence))
        current_progress = CaptureProgress(1, 0x1111, 30, 3_000, 59.8, 0.02)
        workflow.consume(ControllerEvent("capture_progress", current_progress, 701))

        workflow.consume(ControllerEvent("capture_progress", CaptureProgress(2, 0x2222, 90, 9_000, 77.7, 0.03), 702))
        self.assertEqual(workflow.state.capture_point, 1)
        self.assertEqual(workflow.state.capture_progress, current_progress)
        self.assertTrue(workflow.state.cancel_enabled)

        delayed_stable = stable_run(2, 2)
        workflow.consume(ControllerEvent("capture_result", delayed_stable, 703))
        self.assertEqual(workflow.state.capture_point, 1)
        self.assertEqual(workflow.state.capture_progress, current_progress)
        self.assertTrue(workflow.state.cancel_enabled)
        self.assertEqual(workflow.state.accepted_counts, (3, 3, 3, 3))
        self.assertIsNotNone(workflow.state.report)
        self.assertIn(delayed_stable, workflow.state.capture_results)
        self.assertIn(delayed_stable, workflow.session.capture_results)

        delayed_cancelled = CaptureRun(2, 77.7, 84.7, 0.03, 90, 9_000, "cancelled")
        workflow.consume(ControllerEvent("capture_result", delayed_cancelled, 704))
        self.assertEqual(workflow.state.capture_point, 1)
        self.assertEqual(workflow.state.capture_progress, current_progress)
        self.assertTrue(workflow.state.cancel_enabled)
        self.assertIn(delayed_cancelled, workflow.session.capture_results)

    def test_parameter_only_completed_session_remains_exportable(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        sequence = workflow.issue("read_parameters", controller.read_parameters)
        parameters = DeviceParameters(Status.OK, 3, True, False, 1.0, 0.0, 0.0)
        workflow.consume(ControllerEvent("parameters", parameters, sequence))
        workflow.consume(ControllerEvent("disconnected"))

        self.assertEqual(workflow.session.telemetry, ())
        self.assertEqual(workflow.session.capture_results, ())
        self.assertEqual(len(workflow.session.parameter_operations), 1)
        self.assertIsNotNone(workflow.session.ended_at)
        self.assertTrue(session_has_activity(workflow.session))
        self.assertTrue(workflow.export_enabled)

    def test_session_activity_includes_each_audited_non_sample_source(self):
        self.assertFalse(session_has_activity(CalibrationSession()))
        self.assertTrue(session_has_activity(CalibrationSession(connection_metadata={"mode": "simulator"})))
        self.assertTrue(session_has_activity(CalibrationSession(device_id="SIM")))
        parameter_session = CalibrationSession()
        parameter_session.record_parameter_operation("read", "ok")
        self.assertTrue(session_has_activity(parameter_session))
        finished_session = CalibrationSession()
        finished_session.finish()
        self.assertTrue(session_has_activity(finished_session))


class FakeRoot:
    def __init__(self) -> None:
        self.after_calls = []
        self.after_cancel_calls = []

    def after(self, delay, callback):
        self.after_calls.append((delay, callback))
        return f"after-{len(self.after_calls)}"

    def after_cancel(self, after_id) -> None:
        self.after_cancel_calls.append(after_id)


class PollCycleTests(unittest.TestCase):
    def test_telemetry_uses_lightweight_render_path(self):
        controller = FakeController()
        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = CalibrationWorkflow(controller, MasterProfile())
        app.workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        app.smoke_observed = set()
        calls = []
        app._render = lambda: calls.append("full")
        app._render_telemetry = lambda: calls.append("telemetry")

        app._consume_controller_event(ControllerEvent("telemetry", telemetry(1), 1))
        app._consume_controller_event(ControllerEvent("diagnostic", message="next"))

        self.assertEqual(calls, ["telemetry", "full"])
        self.assertLessEqual(AwCalibratorApp.POLL_INTERVAL_MS, 20)

    def test_failed_capture_is_reissued_after_retry_delay(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        sequence = workflow.issue("start_capture", lambda: controller.start_capture(2))
        workflow.consume(ControllerEvent("capture_started", {"point_id": 2}, sequence))

        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = workflow
        app.root = FakeRoot()
        app.smoke_observed = set()
        app._closed = False
        app._capture_retry_after_id = None
        app._render = lambda: None
        app._render_telemetry = lambda: None

        failed = CaptureRun(2, 78.5, 78.5, 0.08, 150, 480_000, "timeout")
        app._consume_controller_event(ControllerEvent("capture_result", failed, 701))

        self.assertEqual(controller.capture_calls, [2])
        self.assertEqual(app.root.after_calls[-1][0], app.CAPTURE_RETRY_DELAY_MS)
        app.root.after_calls[-1][1]()
        self.assertEqual(controller.capture_calls, [2, 2])
        self.assertEqual(workflow.state.pending_operation, "start_capture")

    def test_waiting_auto_retry_can_be_cancelled_locally(self):
        controller = FakeController()
        workflow = CalibrationWorkflow(controller, MasterProfile())
        workflow.consume(ControllerEvent("connected", {"mode": "simulator"}))
        sequence = workflow.issue("start_capture", lambda: controller.start_capture(0))
        workflow.consume(ControllerEvent("capture_started", {"point_id": 0}, sequence))

        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = workflow
        app.root = FakeRoot()
        app.smoke_observed = set()
        app._closed = False
        app._capture_retry_after_id = None
        app._render = lambda: None
        app._render_telemetry = lambda: None

        failed = CaptureRun(0, 38.5, 38.5, 0.08, 150, 480_000, "sensor_error")
        app._consume_controller_event(ControllerEvent("capture_result", failed, 702))
        retry_callback = app.root.after_calls[-1][1]
        retry_after_id = app._capture_retry_after_id

        app.cancel_capture()
        retry_callback()

        self.assertIsNone(workflow.state.capture_retry_point)
        self.assertEqual(app.root.after_cancel_calls, [retry_after_id])
        self.assertEqual(controller.capture_calls, [0])

    def test_event_and_render_failures_surface_and_polling_is_rescheduled(self):
        controller = FakeController()
        controller.poll_events = lambda: [ControllerEvent("telemetry", telemetry(1), 1), ControllerEvent("diagnostic", message="next")]
        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = CalibrationWorkflow(controller, MasterProfile())
        app.root = FakeRoot()
        app._closed = False
        app.smoke_test = False
        app.smoke_observed = set()
        app.smoke_succeeded = False
        app.POLL_INTERVAL_MS = 50
        seen = []

        def consume(event):
            seen.append(event.kind)
            if event.kind == "telemetry":
                raise RuntimeError("mirror exploded")

        app._consume_controller_event = consume
        app._render = lambda: (_ for _ in ()).throw(RuntimeError("render exploded"))

        app._poll_controller()

        self.assertEqual(seen, ["telemetry", "diagnostic"])
        self.assertIn("mirror exploded", app.state.error_text)
        self.assertIn("render exploded", app.state.error_text)
        self.assertEqual(len(app.root.after_calls), 1)
        self.assertEqual(app.root.after_calls[0][0], 50)

    def test_poll_failure_surfaces_and_reschedules(self):
        controller = FakeController()
        controller.poll_events = lambda: (_ for _ in ()).throw(RuntimeError("poll exploded"))
        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = CalibrationWorkflow(controller, MasterProfile())
        app.root = FakeRoot()
        app._closed = False
        app.smoke_test = False
        app.smoke_observed = set()
        app.smoke_succeeded = False
        app.POLL_INTERVAL_MS = 50
        app._render = lambda: None

        app._poll_controller()

        self.assertIn("poll exploded", app.state.error_text)
        self.assertEqual(len(app.root.after_calls), 1)


    def test_connected_app_sends_periodic_heartbeat_and_disconnect_cancels_it(self):
        controller = FakeController()
        app = AwCalibratorApp.__new__(AwCalibratorApp)
        app.controller = controller
        app.workflow = CalibrationWorkflow(controller, MasterProfile())
        app.root = FakeRoot()
        app._closed = False
        app._capture_retry_after_id = None
        app._heartbeat_after_id = None
        app.smoke_observed = set()
        app._render = lambda: None
        app._render_telemetry = lambda: None

        app._consume_controller_event(ControllerEvent("connected", {"mode": "serial"}))
        heartbeat_delay, heartbeat_callback = app.root.after_calls[-1]
        self.assertEqual(heartbeat_delay, 0)
        heartbeat_callback()
        self.assertEqual(controller.heartbeat_calls, 1)
        self.assertEqual(app.root.after_calls[-1][0], app.HEARTBEAT_INTERVAL_MS)

        scheduled_id = app._heartbeat_after_id
        app._consume_controller_event(ControllerEvent("disconnected"))
        self.assertIn(scheduled_id, app.root.after_cancel_calls)
        self.assertIsNone(app._heartbeat_after_id)

if __name__ == "__main__":
    unittest.main()
