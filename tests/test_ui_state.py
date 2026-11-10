import unittest
from unittest import mock

from aw_calibrator.calibration import WARNING_TEXT, calculate_report
from aw_calibrator.chart import (
    draw_chart,
    calibration_chart_data,
    project_points,
    realtime_chart_data,
)
from aw_calibrator.controller import ControllerEvent
from aw_calibrator.models import CalibrationSession, CaptureRun, MasterProfile
from aw_calibrator.protocol import (
    CaptureProgress,
    DeviceInfo,
    DeviceParameters,
    Notice,
    Status,
    Telemetry,
)
from aw_calibrator.ui import (
    BAUD_RATES,
    DEFAULT_BAUD_RATE,
    RECALIBRATION_NOTICE,
    PresentationState,
    apply_event_to_session,
    calibration_data_for_session,
    enumerate_com_ports,
    configure_clickable_styles,
    reduce_presentation,
    smoke_observation_complete,
)


def _telemetry(sequence: int, raw: float | None = None) -> Telemetry:
    humidity_raw = float(sequence if raw is None else raw)
    return Telemetry(
        flags=0x07,
        sample_sequence=sequence,
        temperature_c=25.0,
        humidity_raw=humidity_raw,
        humidity_corrected=humidity_raw + 0.25,
        aw_unclamped=0.5,
        aw_final=0.5,
    )


def _stable_run(point_id: int, repeat: int) -> CaptureRun:

    raw = (38.857, 59.780, 77.687, 98.787)[point_id] + repeat * 0.001
    return CaptureRun(point_id, raw, raw, 0.02, 150, 15_000, "stable")


class CommunicationRecoveryStateTests(unittest.TestCase):
    def pending_state(self, operation):
        state = reduce_presentation(PresentationState(), ControllerEvent("connected", {"mode": "serial"}))
        return reduce_presentation(state, ControllerEvent("command_pending", {"operation": operation}, 42))

    def test_read_retry_preserves_busy_state_until_matching_success(self):
        state = self.pending_state("read_parameters")
        state = reduce_presentation(state, ControllerEvent(
            "request_retry", {"operation": "read_parameters", "attempt": 2}, 42,
            "读取参数应答未到，自动重试 1/2",
        ))
        self.assertEqual(state.pending_sequences, (42,))
        self.assertFalse(state.device_command_enabled)
        self.assertIn("自动重试", state.status_text)
        self.assertEqual(state.error_text, "")
        state = reduce_presentation(state, ControllerEvent(
            "parameters", DeviceParameters(Status.OK, 1, True, True, 1.0, 0.0, 0.0), 42,
        ))
        self.assertEqual(state.pending_sequences, ())
        self.assertTrue(state.device_command_enabled)

    def test_capture_recovery_then_confirmed_start_remains_one_capture(self):
        state = self.pending_state("start_capture")
        state = reduce_presentation(state, ControllerEvent(
            "capture_recovering", {"point_id": 1}, 42, "正在等待对应采集进度或结果",
        ))
        self.assertFalse(any(state.capture_enabled))
        self.assertEqual(state.pending_sequences, (42,))
        state = reduce_presentation(state, ControllerEvent("capture_started", {"point_id": 1}, 42))
        self.assertEqual(state.capture_point, 1)
        self.assertEqual(state.pending_sequences, ())
        self.assertTrue(state.cancel_enabled)

    def test_unconfirmed_capture_must_be_cancelled_before_restart_or_parameter_write(self):
        state = self.pending_state("start_capture")
        state = reduce_presentation(state, ControllerEvent(
            "request_timeout", {"operation": "start_capture", "capture_uncertain": True},
            42, "开始采集未确认，请先取消当前采集后重试",
        ))
        self.assertTrue(state.orphan_capture_recovery)
        self.assertTrue(state.cancel_enabled)
        self.assertFalse(state.device_command_enabled)
        self.assertFalse(any(state.capture_enabled))
        state = reduce_presentation(state, ControllerEvent("command_pending", {"operation": "cancel_capture"}, 43))
        state = reduce_presentation(state, ControllerEvent("capture_cancelled", sequence=43))
        self.assertFalse(state.orphan_capture_recovery)
        self.assertTrue(all(state.capture_enabled))


class ControlStyleTests(unittest.TestCase):
    @mock.patch("aw_calibrator.ui.ttk.Style")
    def test_clickable_controls_use_large_distinct_styles(self, style_factory):
        style = style_factory.return_value
        root = object()

        result = configure_clickable_styles(root)

        style_factory.assert_called_once_with(root)
        self.assertIs(result, style)
        style.configure.assert_any_call(
            "TButton",
            font=("Microsoft YaHei UI", 11, "bold"),
            padding=(14, 8),
        )
        style.configure.assert_any_call(
            "Capture.TButton",
            font=("Microsoft YaHei UI", 12, "bold"),
            padding=(18, 10),
            foreground="#075985",
        )
        style.configure.assert_any_call(
            "Primary.TButton",
            font=("Microsoft YaHei UI", 11, "bold"),
            padding=(16, 9),
            foreground="#005fb8",
        )
        style.configure.assert_any_call(
            "Warning.TButton",
            font=("Microsoft YaHei UI", 11, "bold"),
            padding=(14, 8),
            foreground="#b42318",
        )
        style.configure.assert_any_call(
            "TCheckbutton",
            font=("Microsoft YaHei UI", 10, "bold"),
            padding=(8, 5),
        )


class PresentationReducerTests(unittest.TestCase):
    def test_connection_actions_drive_buttons_and_pending_status(self):
        state = PresentationState()
        self.assertTrue(state.connect_enabled)
        self.assertFalse(state.disconnect_enabled)
        self.assertFalse(any(state.capture_enabled))

        state = reduce_presentation(state, ControllerEvent("connect_requested"))
        self.assertFalse(state.connect_enabled)
        self.assertFalse(state.disconnect_enabled)
        self.assertEqual(state.pending_operation, "connect")

        state = reduce_presentation(
            state,
            ControllerEvent("connected", {"mode": "simulator"}),
        )
        self.assertFalse(state.connect_enabled)
        self.assertTrue(state.disconnect_enabled)
        self.assertTrue(all(state.capture_enabled))
        self.assertIsNone(state.pending_operation)

        state = reduce_presentation(state, ControllerEvent("disconnected"))
        self.assertTrue(state.connect_enabled)
        self.assertFalse(state.disconnect_enabled)
        self.assertFalse(any(state.capture_enabled))

    def test_only_stable_runs_increment_counts_but_all_outcomes_stay_visible(self):
        state = reduce_presentation(PresentationState(), ControllerEvent("connected"))
        stable = _stable_run(0, 0)
        timeout = CaptureRun(0, 39.0, 39.0, 0.2, 149, 480_000, "timeout")

        state = reduce_presentation(state, ControllerEvent("capture_result", timeout))
        state = reduce_presentation(state, ControllerEvent("capture_result", stable))

        self.assertEqual(state.accepted_counts, (1, 0, 0, 0))
        self.assertEqual(state.point_count_labels[0], "0.328：1/3 次稳定")
        self.assertEqual(state.capture_results, (timeout, stable))

    def test_write_requires_report_and_three_accepted_runs_at_every_point(self):
        state = reduce_presentation(PresentationState(), ControllerEvent("connected"))
        report = calculate_report(
            (38.983, 57.530, 71.577, 89.697),
            (38.857, 59.780, 77.687, 98.787),
        )
        state = reduce_presentation(state, ControllerEvent("local_report", report))
        for point_id in range(4):
            for repeat in range(3):
                if point_id == 3 and repeat == 2:
                    self.assertFalse(state.write_enabled)
                state = reduce_presentation(
                    state,
                    ControllerEvent("capture_result", _stable_run(point_id, repeat)),
                )

        self.assertTrue(state.write_enabled)
        state = reduce_presentation(
            state,
            ControllerEvent("command_pending", {"operation": "write_parameters", "sequence": 42}, 42),
        )
        self.assertFalse(state.write_enabled)
        state = reduce_presentation(state, ControllerEvent("disconnected"))
        self.assertFalse(state.write_enabled)

    def test_report_uses_recommendation_allows_switch_and_shows_exact_warning(self):
        report = calculate_report(
            (38.983, 57.530, 71.577, 89.697),
            (36.0, 59.780, 77.687, 98.787),
        )
        state = reduce_presentation(PresentationState(), ControllerEvent("local_report", report))
        self.assertEqual(state.selected_method, report.recommended_method)
        self.assertEqual(state.warning_text, WARNING_TEXT)

        state = reduce_presentation(
            state,
            ControllerEvent("method_selected", {"method": "endpoint"}),
        )
        self.assertEqual(state.selected_method, "endpoint")
        unchanged = reduce_presentation(
            state,
            ControllerEvent("method_selected", {"method": "unsupported"}),
        )
        self.assertEqual(unchanged.selected_method, "endpoint")
        self.assertIn("unsupported", unchanged.error_text)

    def test_write_reset_and_notice_require_0753_recalibration(self):
        params = DeviceParameters(Status.OK, 2, True, False, 0.85, 6.0, 0.0)
        for event in (
            ControllerEvent("write_verified", params),
            ControllerEvent("reset", params),
            ControllerEvent("notice", Notice(2)),
        ):
            with self.subTest(kind=event.kind):
                state = reduce_presentation(PresentationState(), event)
                self.assertEqual(state.recalibration_notice, RECALIBRATION_NOTICE)

    def test_telemetry_keeps_rolling_window_and_sample_statistics(self):
        state = PresentationState()
        for sequence, raw in enumerate((10.0, 11.0, 12.0), start=1):
            state = reduce_presentation(
                state,
                ControllerEvent("telemetry", _telemetry(sequence, raw)),
            )
        self.assertEqual(state.sample_count, 3)
        self.assertEqual(state.sample_sequence, 3)
        self.assertAlmostEqual(state.rolling_mean_raw, 11.0)
        self.assertAlmostEqual(state.rolling_stdev_raw, 1.0)

        for sequence in range(4, 1_205):
            state = reduce_presentation(
                state,
                ControllerEvent("telemetry", _telemetry(sequence)),
            )
        self.assertEqual(len(state.recent_telemetry), 1_200)
        self.assertEqual(state.recent_telemetry[0].sample_sequence, 5)
        self.assertEqual(state.sample_count, 1_204)

    def test_controller_events_have_defensive_user_visible_outcomes(self):
        events = (
            ControllerEvent("info", DeviceInfo(Status.OK, "SIM-1", "1.2.3")),
            ControllerEvent("parameters", DeviceParameters(Status.OK, 1, True, True, 1.0, 0.0, 0.0)),
            ControllerEvent("capture_started", {"point_id": 2, "capture_id": 0x1234}),
            ControllerEvent("capture_progress", CaptureProgress(2, 0x1234, 10, 1_000, 71.5, 0.02)),
            ControllerEvent("capture_cancelled"),
            ControllerEvent("stream_configured", {"enabled": True, "interval_ms": 100}),
            ControllerEvent("diagnostic", message="bad frame"),
            ControllerEvent("request_timeout", {"operation": "read_info"}, message="timed out"),
            ControllerEvent("error", {"operation": "read_parameters"}, message="failed"),
        )
        state = PresentationState()
        for event in events:
            state = reduce_presentation(state, event)
        self.assertEqual(state.device_id, "SIM-1")
        self.assertIsNotNone(state.parameters)
        self.assertIn("failed", state.error_text)

        unknown = reduce_presentation(state, ControllerEvent("future_event", {"x": 1}))
        self.assertIn("future_event", unknown.diagnostic_text)

    def test_reconnect_resets_session_presentation_to_match_new_session(self):
        state = reduce_presentation(PresentationState(), ControllerEvent("connected"))
        state = reduce_presentation(state, ControllerEvent("capture_result", _stable_run(0, 0)))
        state = reduce_presentation(state, ControllerEvent("telemetry", _telemetry(1, 50.0)))
        state = reduce_presentation(state, ControllerEvent("disconnected"))

        state = reduce_presentation(state, ControllerEvent("connected", {"mode": "simulator"}))

        self.assertEqual(state.accepted_counts, (0, 0, 0, 0))
        self.assertEqual(state.capture_results, ())
        self.assertEqual(state.recent_telemetry, ())
        self.assertEqual(state.sample_count, 0)
        self.assertIsNone(state.report)

    def test_cancel_ack_and_terminal_result_are_presentation_order_independent(self):
        cancelled = CaptureRun(2, 71.5, 78.5, 0.02, 20, 2_000, "cancelled")

        for order in (("ack", "result"), ("result", "ack")):
            with self.subTest(order=order):
                state = reduce_presentation(PresentationState(), ControllerEvent("connected"))
                state = reduce_presentation(
                    state,
                    ControllerEvent(
                        "command_pending",
                        {"operation": "start_capture", "sequence": 10},
                        10,
                    ),
                )
                state = reduce_presentation(
                    state,
                    ControllerEvent(
                        "capture_started",
                        {"point_id": 2, "capture_id": 0x2222},
                        10,
                    ),
                )
                state = reduce_presentation(
                    state,
                    ControllerEvent(
                        "command_pending",
                        {"operation": "cancel_capture", "sequence": 11},
                        11,
                    ),
                )

                for step in order:
                    event = (
                        ControllerEvent("capture_cancelled", sequence=11)
                        if step == "ack"
                        else ControllerEvent("capture_result", cancelled, 99)
                    )
                    state = reduce_presentation(state, event)

                self.assertIsNone(state.capture_point)
                self.assertEqual(state.pending_requests, ())
                self.assertFalse(state.cancel_enabled)
                self.assertNotIn("等待", state.status_text)


class ChartTransformTests(unittest.TestCase):
    def test_draw_chart_legend_uses_each_series_color_and_marker(self):
        class FakeCanvas:
            def __init__(self):
                self.calls = []

            def winfo_width(self):
                return 900

            def winfo_reqwidth(self):
                return 900

            def winfo_height(self):
                return 600

            def winfo_reqheight(self):
                return 600

            def __getattr__(self, name):
                if name == "delete" or name.startswith("create_"):
                    return lambda *args, **kwargs: self.calls.append((name, args, kwargs))
                raise AttributeError(name)

        chart = calibration_chart_data(
            (38.857, 59.780, 77.687, 98.787),
            (38.983, 56.688, 71.842, 89.697),
            (38.983, 57.530, 71.577, 89.697),
        )
        canvas = FakeCanvas()

        draw_chart(canvas, chart)

        legend_calls = [call for call in canvas.calls if call[2].get("tags") == "legend"]
        expected_colors = [series.color for series in chart.series]
        self.assertEqual(
            [call[2]["fill"] for call in legend_calls if call[0] == "create_line"],
            expected_colors,
        )
        self.assertEqual(
            [call[2]["fill"] for call in legend_calls if call[0] == "create_oval"],
            expected_colors,
        )
        self.assertEqual(
            [(call[2]["text"], call[2]["fill"]) for call in legend_calls if call[0] == "create_text"],
            [(series.name, series.color) for series in chart.series],
        )

    def test_realtime_chart_uses_latest_1200_without_mutating_full_input(self):
        telemetry = tuple(_telemetry(sequence) for sequence in range(1, 1_301))
        chart = realtime_chart_data(telemetry)

        self.assertEqual(len(telemetry), 1_300)
        self.assertEqual(len(chart.series[0].points), 1_200)
        self.assertEqual(chart.series[0].points[0], (101.0, 101.0))
        self.assertEqual(chart.series[1].points[-1], (1_300.0, 1_300.25))
        self.assertLess(chart.y_range[0], 101.0)
        self.assertGreater(chart.y_range[1], 1_300.25)

    def test_calibration_chart_has_four_categories_and_three_named_lines(self):
        chart = calibration_chart_data(
            (38.857, 59.780, 77.687, 98.787),
            (38.983, 56.688, 71.842, 89.697),
            (38.983, 57.530, 71.577, 89.697),
        )
        self.assertEqual(chart.categories, ("0.328", "0.529", "0.753", "水(1.000)"))
        self.assertEqual(tuple(series.name for series in chart.series), ("设备原始", "选定修正", "一号机基准"))
        self.assertTrue(all(len(series.points) == 4 for series in chart.series))
        self.assertEqual(tuple(x for x, _ in chart.series[2].points), (0.0, 1.0, 2.0, 3.0))

    def test_project_points_maps_data_ranges_to_canvas_with_inverted_y(self):
        projected = project_points(
            ((0.0, 10.0), (3.0, 40.0)),
            x_range=(0.0, 3.0),
            y_range=(10.0, 40.0),
            width=400,
            height=200,
            padding=20,
        )
        self.assertEqual(projected, ((20.0, 180.0), (380.0, 20.0)))

    def test_project_points_empty_and_out_of_range_values_are_clipped(self):
        self.assertEqual(
            project_points((), x_range=(0.0, 1.0), y_range=(0.0, 1.0), width=100, height=100, padding=10),
            (),
        )
        projected = project_points(
            ((-5.0, -2.0), (5.0, 2.0)),
            x_range=(0.0, 1.0),
            y_range=(0.0, 1.0),
            width=100,
            height=100,
            padding=10,
        )
        self.assertEqual(projected, ((10.0, 90.0), (90.0, 10.0)))

    def test_realtime_ranges_handle_singleton_and_constant_values(self):
        singleton = realtime_chart_data((_telemetry(1, 50.0),))
        self.assertLess(singleton.x_range[0], singleton.x_range[1])
        self.assertLess(singleton.y_range[0], singleton.y_range[1])
        constant = realtime_chart_data((_telemetry(1, 50.0), _telemetry(2, 50.0)))
        self.assertLess(constant.y_range[0], 50.0)
        self.assertGreater(constant.y_range[1], 50.25)

    def test_chart_transforms_reject_nonfinite_values(self):
        with self.assertRaisesRegex(ValueError, "finite"):
            realtime_chart_data((_telemetry(1, float("nan")),))
        with self.assertRaisesRegex(ValueError, "finite"):
            project_points(
                ((float("inf"), 0.0),),
                x_range=(0.0, 1.0),
                y_range=(0.0, 1.0),
                width=100,
                height=100,
                padding=10,
            )


class UiBoundaryTests(unittest.TestCase):
    def test_baud_rates_are_exact_and_default_to_115200(self):
        self.assertEqual(
            BAUD_RATES,
            (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600),
        )
        self.assertEqual(DEFAULT_BAUD_RATE, 115200)

    def test_com_enumeration_is_lazy_and_missing_pyserial_is_user_readable(self):
        fake_port = type("Port", (), {"device": "COM7"})()
        fake_module = type("ListPorts", (), {"comports": staticmethod(lambda: [fake_port])})
        with mock.patch("aw_calibrator.ui.importlib.import_module", return_value=fake_module) as importer:
            self.assertEqual(enumerate_com_ports(), ("COM7",))
        importer.assert_called_once_with("serial.tools.list_ports")

        with mock.patch(
            "aw_calibrator.ui.importlib.import_module",
            side_effect=ModuleNotFoundError("No module named 'serial'"),
        ):
            with self.assertRaisesRegex(RuntimeError, "pyserial"):
                enumerate_com_ports()

    def test_session_event_mirror_retains_all_telemetry_and_capture_outcomes(self):
        session = CalibrationSession(MasterProfile())
        session = apply_event_to_session(
            session,
            ControllerEvent("connected", {"mode": "simulator"}),
        )
        session = apply_event_to_session(
            session,
            ControllerEvent("info", DeviceInfo(Status.OK, "SIM-AW", "sim-1.0")),
        )
        for sequence in range(1, 1_205):
            session = apply_event_to_session(
                session,
                ControllerEvent("telemetry", _telemetry(sequence, 50.0 + (sequence % 10) * 0.01)),
            )
        timeout = CaptureRun(1, 59.8, 59.8, 0.3, 149, 480_000, "timeout")
        stable = _stable_run(1, 0)
        session = apply_event_to_session(session, ControllerEvent("capture_result", timeout))
        session = apply_event_to_session(session, ControllerEvent("capture_result", stable))

        self.assertEqual(session.device_id, "SIM-AW")
        self.assertEqual(len(session.telemetry), 1_204)
        self.assertEqual(session.capture_results, (timeout, stable))
        self.assertEqual(len(session.accepted_runs_by_point[1]), 1)

    def test_smoke_completion_requires_info_parameters_and_telemetry(self):
        self.assertFalse(smoke_observation_complete({"info", "parameters"}))
        self.assertTrue(smoke_observation_complete({"info", "parameters", "telemetry"}))

    def test_session_calibration_chart_uses_device_raw_means(self):
        session = CalibrationSession(MasterProfile())
        for point_id, raw in enumerate((38.0, 58.0, 72.0, 90.0)):
            session.record_capture(CaptureRun(point_id, raw, raw + 5.0, 0.02, 150, 15_000, "stable"))
        report = calculate_report(session.master_profile.rh, (38.0, 58.0, 72.0, 90.0))
        state = reduce_presentation(PresentationState(), ControllerEvent("local_report", report))

        chart = calibration_data_for_session(session, state)

        self.assertEqual(tuple(value for _, value in chart.series[0].points), (38.0, 58.0, 72.0, 90.0))
        self.assertEqual(chart.series[1].name, "选定修正")


if __name__ == "__main__":
    unittest.main()
