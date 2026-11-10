"""Behavioural tests for calibration-session ownership and aggregation."""

from __future__ import annotations

from datetime import datetime, timezone
import math
import statistics
import struct
import unittest

from aw_calibrator.calibration import calculate_report
from aw_calibrator.models import CalibrationSession, CalibrationReport, CaptureRun, FitResult, MasterProfile
from aw_calibrator.protocol import Telemetry


class CalibrationSessionTests(unittest.TestCase):
    def test_records_every_capture_but_aggregates_only_stable_finite_valid_points(self):
        session = CalibrationSession(
            MasterProfile(),
            device_id="AW-C6-007",
            connection_metadata={"port": "COM7", "baudrate": 115200},
        )
        accepted = []
        for point_id in range(4):
            for delta in (-0.1, 0.0, 0.1):
                run = CaptureRun(point_id, 40.0 + point_id * 10 + delta,
                                 40.5 + point_id * 10 + delta, 0.04, 150, 15000)
                accepted.append(run)
                session.record_capture(run)

        timeout = CaptureRun(1, 50.0, 50.5, 0.10, 4800, 480000, "timeout")
        cancelled = CaptureRun(2, 60.0, 60.5, 0.10, 20, 2000, "cancelled")
        invalid_point = CaptureRun(4, 80.0, 80.5, 0.04, 150, 15000)
        for run in (timeout, cancelled, invalid_point):
            session.record_capture(run)

        self.assertEqual(session.capture_results[-3:], (timeout, cancelled, invalid_point))
        self.assertEqual(tuple(len(runs) for runs in session.accepted_runs_by_point.values()), (3, 3, 3, 3))
        aggregate = session.point_aggregate(1)
        self.assertEqual(aggregate.count, 3)
        self.assertAlmostEqual(aggregate.mean_rh_raw, 50.0)
        self.assertAlmostEqual(aggregate.stdev_rh_raw, statistics.stdev((49.9, 50.0, 50.1)))
        self.assertEqual(session.device_point_means(), (40.0, 50.0, 60.0, 70.0))

    def test_point_means_require_at_least_one_accepted_run_at_all_four_points(self):
        session = CalibrationSession(MasterProfile())
        for point_id in range(3):
            session.record_capture(CaptureRun(point_id, 40.0, 41.0, 0.04, 150, 15000))
        self.assertIsNone(session.device_point_means())
        session.record_capture(CaptureRun(3, 70.0, 71.0, 0.04, 150, 15000))
        self.assertEqual(session.device_point_means(), (40.0, 40.0, 40.0, 70.0))

    def test_exposed_collections_cannot_mutate_session_state(self):
        session = CalibrationSession(MasterProfile(), connection_metadata={"port": "COM4"})
        session.record_capture(CaptureRun(0, 40.0, 40.1, 0.04, 150, 15000))
        session.record_telemetry(Telemetry(7, 1, 25.0, 40.0, 40.1, 0.321, 0.322))

        with self.assertRaises(TypeError):
            session.accepted_runs_by_point[0] = ()
        with self.assertRaises(TypeError):
            session.connection_metadata["port"] = "COM99"
        self.assertEqual(session.telemetry[0].aw_unclamped, 0.321)
        self.assertEqual(session.accepted_runs_by_point[0], (CaptureRun(0, 40.0, 40.1, 0.04, 150, 15000),))

    def test_finite_invalid_and_sensor_error_runs_stay_in_history_but_not_fits(self):
        session = CalibrationSession(MasterProfile())
        stable = CaptureRun(0, 40.0, 40.1, 0.037, 150, 15000)
        invalid_point = CaptureRun(4, 40.0, 40.1, 0.04, 150, 15000)
        negative_stddev = CaptureRun(2, 60.0, 60.1, -0.04, 150, 15000)
        sensor_error = CaptureRun(3, 70.0, 70.1, 0.04, 150, 15000, "sensor_error")

        for run in (stable, invalid_point, negative_stddev, sensor_error):
            session.record_capture(run)

        self.assertEqual(session.capture_results, (stable, invalid_point, negative_stddev, sensor_error))
        self.assertEqual(session.accepted_runs_by_point[0], (stable,))
        self.assertEqual(session.point_aggregate(0).stdev_rh_raw, None)
        self.assertEqual(session.capture_results[0].stddev_rh_raw, 0.037)
        self.assertEqual(tuple(len(runs) for runs in session.accepted_runs_by_point.values()), (1, 0, 0, 0))

    def test_nonfinite_capture_values_are_rejected_without_changing_history(self):
        session = CalibrationSession(MasterProfile())
        for run in (
            CaptureRun(0, math.nan, 40.1, 0.04, 150, 15000),
            CaptureRun(0, 40.0, math.inf, 0.04, 150, 15000),
            CaptureRun(0, 40.0, 40.1, -math.inf, 150, 15000),
        ):
            with self.subTest(run=run):
                with self.assertRaisesRegex(ValueError, "finite"):
                    session.record_capture(run)
                self.assertEqual(session.capture_results, ())

    def test_structurally_malformed_capture_is_rejected_without_changing_history(self):
        session = CalibrationSession(MasterProfile())
        malformed_runs = (
            CaptureRun(True, 40.0, 40.1, 0.04, 150, 15000),
            CaptureRun(0.0, 40.0, 40.1, 0.04, 150, 15000),
            CaptureRun(0, "bad", 40.1, 0.04, 150, 15000),
            CaptureRun(0, 40.0, 40.1, 0.04, True, 15000),
            CaptureRun(0, 40.0, 40.1, 0.04, 150, -1),
            CaptureRun(0, 40.0, 40.1, 0.04, 150, 15000, "unexpected"),
        )

        for run in malformed_runs:
            with self.subTest(run=run):
                with self.assertRaises((TypeError, ValueError)):
                    session.record_capture(run)
                self.assertEqual(session.capture_results, ())

    def test_nested_metadata_and_operation_details_are_owned_at_insertion(self):
        metadata = {"device": {"channels": ["COM7"]}}
        details = {"readback": {"values": [1.0, 0.0]}}
        session = CalibrationSession(MasterProfile(), connection_metadata=metadata)
        session.record_parameter_operation("write", "ok", details, timestamp=datetime(2026, 8, 21, tzinfo=timezone.utc))
        metadata["device"]["channels"].append("COM99")
        details["readback"]["values"][0] = 9.0

        self.assertEqual(session.connection_metadata["device"]["channels"], ("COM7",))
        self.assertEqual(session.parameter_operations[0].details["readback"]["values"], (1.0, 0.0))

    def test_metadata_and_details_require_export_safe_recursive_values(self):
        invalid_metadata = (
            [],
            {1: "non-string key"},
            {"valid": 1, 2: "mixed keys"},
            {"nested": {1: "non-string key"}},
            {"gain": math.nan},
            {"unsupported": object()},
        )
        for metadata in invalid_metadata:
            with self.subTest(metadata=metadata):
                with self.assertRaises((TypeError, ValueError)):
                    CalibrationSession(MasterProfile(), connection_metadata=metadata)

        session = CalibrationSession(MasterProfile())
        invalid_details = (
            [],
            {"gain": math.inf},
            {"nested": {False: "non-string key"}},
            {"unsupported": {1, 2}},
        )
        for details in invalid_details:
            with self.subTest(details=details):
                with self.assertRaises((TypeError, ValueError)):
                    session.record_parameter_operation("write", "ok", details,
                                                       timestamp=datetime(2026, 8, 21, tzinfo=timezone.utc))
                self.assertEqual(session.parameter_operations, ())

    def test_session_rejects_malformed_telemetry_and_naive_timestamps(self):
        with self.assertRaises(ValueError):
            CalibrationSession(MasterProfile(), started_at=datetime(2026, 8, 21))
        session = CalibrationSession(MasterProfile())
        with self.assertRaises(TypeError):
            session.record_telemetry(object())
        with self.assertRaises(ValueError):
            session.record_telemetry(Telemetry(8, 1, 25.0, 40.0, 40.1, 0.3, 0.4))
        with self.assertRaises(ValueError):
            session.record_telemetry(Telemetry(7, 1, math.nan, 40.0, 40.1, 0.3, 0.4))
        with self.assertRaises(ValueError):
            session.record_telemetry(Telemetry(7, 1, 25.0, 40.0, 40.1, 0.3, 1.1))
        with self.assertRaises(ValueError):
            session.record_parameter_operation("write", "ok", timestamp=datetime(2026, 8, 21))
        self.assertEqual(session.telemetry, ())

    def test_session_accepts_float32_wire_representation_of_aw_lower_limit(self):
        session = CalibrationSession(MasterProfile())
        wire_lower_limit = struct.unpack("<f", struct.pack("<f", 0.288660))[0]

        self.assertLess(wire_lower_limit, 0.288660)
        session.record_telemetry(
            Telemetry(7, 1, 25.0, 0.0, 0.0, 0.0, wire_lower_limit)
        )
        self.assertEqual(session.telemetry[-1].aw_final, wire_lower_limit)

        with self.assertRaisesRegex(ValueError, "aw_final is out of range"):
            session.record_telemetry(
                Telemetry(7, 2, 25.0, 0.0, 0.0, 0.0, wire_lower_limit - 1e-6)
            )

    def test_report_validation_rejects_bad_methods_vectors_and_recommendation_before_storage(self):
        session = CalibrationSession(MasterProfile())
        valid = calculate_report((38.983, 57.530, 71.577, 89.697), (38.857, 59.780, 77.687, 98.787))
        malformed_reports = (
            CalibrationReport(FitResult("endpoint", 1.0, 0.0, (1.0, 2.0, 3.0), (0.0, 0.0, 0.0), 0.0), valid.least_squares, "endpoint", ()),
            CalibrationReport(FitResult("other", 1.0, 0.0, (1.0, 2.0, 3.0, 4.0), (0.0, 0.0, 0.0, 0.0), 0.0), valid.least_squares, "endpoint", ()),
            CalibrationReport(FitResult("endpoint", math.nan, 0.0, (1.0, 2.0, 3.0, 4.0), (0.0, 0.0, 0.0, 0.0), 0.0), valid.least_squares, "endpoint", ()),
            CalibrationReport(FitResult("endpoint", 1.0, 0.0, (1.0, 2.0, 3.0, 4.0), (0.0, 0.0, 0.0, 0.0), -0.1), valid.least_squares, "endpoint", ()),
            CalibrationReport(valid.endpoint, FitResult("endpoint", 1.0, 0.0, (1.0, 2.0, 3.0, 4.0), (0.0, 0.0, 0.0, 0.0), 0.0), "endpoint", ()),
            CalibrationReport(valid.endpoint, valid.least_squares, "missing", ()),
            CalibrationReport(valid.endpoint, valid.least_squares, "endpoint", ("",)),
        )

        for report in malformed_reports:
            with self.subTest(report=report):
                with self.assertRaises(ValueError):
                    session.set_report(report)
                self.assertIsNone(session.report)


if __name__ == "__main__":
    unittest.main()
