"""Real-filesystem tests for profile persistence and paired session exports."""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aw_calibrator.calibration import calculate_report
from aw_calibrator.config_store import MasterProfileStore
from aw_calibrator.exporter import ExportError, SessionExporter
from aw_calibrator.models import CalibrationSession, CalibrationReport, CaptureRun, FitResult, MasterProfile
from aw_calibrator.protocol import Telemetry


class MasterProfileStoreTests(unittest.TestCase):
    def test_default_path_uses_appdata_and_round_trips_four_point_profile_atomically(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch.dict(os.environ, {"APPDATA": temporary_directory}, clear=False):
                store = MasterProfileStore()
                self.assertEqual(
                    store.path,
                    Path(temporary_directory) / "Lebrew" / "AwCalibrator" / "master_profile.json",
                )
                profile = MasterProfile((39.0, 58.0, 72.0, 90.0))
                store.save(profile)
                loaded = store.load()

                self.assertEqual(loaded.profile, profile)
                self.assertIsNone(loaded.error)
                self.assertEqual(list(store.path.parent.glob("*.tmp")), [])

    def test_damaged_or_non_finite_profile_falls_back_without_overwriting_the_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = MasterProfileStore(base_path=Path(temporary_directory))
            store.path.parent.mkdir(parents=True, exist_ok=True)
            damaged = '{"schema_version": 1, "rh": [38.983, 57.530, NaN, 89.697]}'
            store.path.write_text(damaged, encoding="utf-8")

            result = store.load()

            self.assertEqual(result.profile, MasterProfile())
            self.assertIsNotNone(result.error)
            self.assertEqual(store.path.read_text(encoding="utf-8"), damaged)

    def test_atomic_save_failure_keeps_existing_profile_and_removes_temp_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = MasterProfileStore(base_path=Path(temporary_directory))
            store.path.write_text('{"schema_version": 1, "rh": [1, 2, 3, 4]}\n', encoding="utf-8")
            original = store.path.read_bytes()

            with patch("aw_calibrator.config_store.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    store.save(MasterProfile((39.0, 58.0, 72.0, 90.0)))

            self.assertEqual(store.path.read_bytes(), original)
            self.assertEqual(list(Path(temporary_directory).glob("*.tmp")), [])


class SessionExporterTests(unittest.TestCase):
    def _session(self) -> CalibrationSession:
        session = CalibrationSession(
            MasterProfile((38.983, 57.530, 71.577, 89.697)),
            device_id="AW-C6-007",
            connection_metadata={"port": "COM7", "baudrate": 115200, "transport": {"retries": [1]}},
            started_at=datetime(2026, 8, 21, 17, 30, tzinfo=timezone(timedelta(hours=8))),
        )
        session.record_telemetry(Telemetry(7, 8, 24.5, 38.857, 38.983, 0.3278, 0.3280))
        session.record_telemetry(Telemetry(3, 9, 25.0, 39.000, 39.100, 0.3290, 0.3300))
        session.record_capture(CaptureRun(0, 38.857, 38.983, 0.04, 150, 15000))
        session.record_capture(CaptureRun(0, 38.900, 39.010, 0.03, 150, 15000))
        session.record_capture(CaptureRun(1, 59.780, 57.530, 0.04, 150, 15000))
        session.record_capture(CaptureRun(2, 77.687, 71.577, 0.05, 150, 15000))
        session.record_capture(CaptureRun(3, 98.787, 89.697, 0.02, 150, 15000))
        session.record_capture(CaptureRun(0, 38.800, 38.920, 0.10, 4800, 480000, "timeout"))
        session.record_capture(CaptureRun(2, 77.600, 71.500, 0.09, 1, 100, "sensor_error"))
        session.record_parameter_operation(
            "write", "ok", {"slope_k": 0.85, "offset_b": 6.0, "readback": {"version": 2}},
            timestamp=datetime(2026, 8, 21, 17, 31, tzinfo=timezone(timedelta(hours=8))),
        )
        session.record_parameter_operation("read", "ok", {"params_valid": True}, timestamp=datetime(2026, 8, 21, 17, 32, tzinfo=timezone(timedelta(hours=8))) )
        session.set_report(calculate_report(
            (38.983, 57.530, 71.577, 89.697),
            (38.857, 59.780, 77.687, 98.787),
        ))
        return session

    def test_exports_complete_deterministic_json_and_csv_with_stable_schema(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            exporter = SessionExporter()
            paths = exporter.export(self._session(), directory, stem="calibration")

            document = json.loads(paths.json_path.read_text(encoding="utf-8"))
            self.assertEqual(document["schema_version"], 1)
            self.assertEqual(document["device_id"], "AW-C6-007")
            self.assertEqual(document["started_at"], "2026-08-21T09:30:00+00:00")
            self.assertEqual(document["connection_metadata"]["transport"]["retries"], [1])
            self.assertEqual(len(document["telemetry"]), 2)
            self.assertEqual(document["telemetry"], [
                {"flags": 7, "sample_sequence": 8, "temperature_c": 24.5, "humidity_raw": 38.857,
                 "humidity_corrected": 38.983, "aw_unclamped": 0.3278, "aw_final": 0.3280},
                {"flags": 3, "sample_sequence": 9, "temperature_c": 25.0, "humidity_raw": 39.0,
                 "humidity_corrected": 39.1, "aw_unclamped": 0.3290, "aw_final": 0.3300},
            ])
            self.assertEqual(len(document["captures"]), 7)
            self.assertEqual(document["captures"], [
                {"point_id": 0, "mean_rh_raw": 38.857, "mean_rh_corrected": 38.983, "stddev_rh_raw": 0.04, "sample_count": 150, "elapsed_ms": 15000, "result_code": "stable"},
                {"point_id": 0, "mean_rh_raw": 38.9, "mean_rh_corrected": 39.01, "stddev_rh_raw": 0.03, "sample_count": 150, "elapsed_ms": 15000, "result_code": "stable"},
                {"point_id": 1, "mean_rh_raw": 59.78, "mean_rh_corrected": 57.53, "stddev_rh_raw": 0.04, "sample_count": 150, "elapsed_ms": 15000, "result_code": "stable"},
                {"point_id": 2, "mean_rh_raw": 77.687, "mean_rh_corrected": 71.577, "stddev_rh_raw": 0.05, "sample_count": 150, "elapsed_ms": 15000, "result_code": "stable"},
                {"point_id": 3, "mean_rh_raw": 98.787, "mean_rh_corrected": 89.697, "stddev_rh_raw": 0.02, "sample_count": 150, "elapsed_ms": 15000, "result_code": "stable"},
                {"point_id": 0, "mean_rh_raw": 38.8, "mean_rh_corrected": 38.92, "stddev_rh_raw": 0.1, "sample_count": 4800, "elapsed_ms": 480000, "result_code": "timeout"},
                {"point_id": 2, "mean_rh_raw": 77.6, "mean_rh_corrected": 71.5, "stddev_rh_raw": 0.09, "sample_count": 1, "elapsed_ms": 100, "result_code": "sensor_error"},
            ])
            self.assertEqual(len(document["accepted_runs_by_point"]["0"]), 2)
            self.assertEqual(document["parameter_operations"], [
                {"operation": "write", "status": "ok", "details": {"slope_k": 0.85, "offset_b": 6.0, "readback": {"version": 2}}, "timestamp": "2026-08-21T09:31:00+00:00"},
                {"operation": "read", "status": "ok", "details": {"params_valid": True}, "timestamp": "2026-08-21T09:32:00+00:00"},
            ])
            self.assertEqual(set(document["report"]["fits"]), {"endpoint", "least_squares"})
            self.assertEqual(document["report"]["recommended_method"], "least_squares")
            report = self._session().report
            for method, fit in (("endpoint", report.endpoint), ("least_squares", report.least_squares)):
                exported_fit = document["report"]["fits"][method]
                self.assertEqual(exported_fit["slope_k"], fit.slope_k)
                self.assertEqual(exported_fit["offset_b"], fit.offset_b)
                self.assertEqual(exported_fit["corrected_rh"], list(fit.corrected_rh))
                self.assertEqual(exported_fit["residuals"], list(fit.residuals))
                self.assertEqual(exported_fit["rmse"], fit.rmse)

            with paths.csv_path.open("r", encoding="utf-8", newline="") as stream:
                reader = csv.DictReader(stream)
                rows = list(reader)
            self.assertEqual(reader.fieldnames[0], "record_type")
            self.assertEqual(
                reader.fieldnames,
                list(SessionExporter.CSV_HEADER),
            )
            rows_by_type = {record_type: [row for row in rows if row["record_type"] == record_type]
                            for record_type in ("metadata", "telemetry", "capture", "parameter_operation", "fit_point", "report_summary")}
            self.assertEqual({record_type: len(records) for record_type, records in rows_by_type.items()}, {
                "metadata": 1, "telemetry": 2, "capture": 7, "parameter_operation": 2,
                "fit_point": 8, "report_summary": 1,
            })
            self.assertEqual(len(rows), 21)
            self.assertEqual(rows_by_type["telemetry"][0]["humidity_raw"], "38.857")
            self.assertEqual(rows_by_type["telemetry"][0]["humidity_corrected"], "38.983")
            self.assertEqual(rows_by_type["telemetry"][0]["aw_unclamped"], "0.3278")
            self.assertEqual(rows_by_type["telemetry"][0]["aw_final"], "0.328")
            self.assertEqual(rows_by_type["capture"][0]["stddev_rh_raw"], "0.04")
            self.assertEqual(rows_by_type["capture"][-1]["result_code"], "sensor_error")
            self.assertEqual(
                [(row["point_id"], row["mean_rh_raw"], row["mean_rh_corrected"], row["stddev_rh_raw"], row["result_code"])
                 for row in rows_by_type["capture"]],
                [("0", "38.857", "38.983", "0.04", "stable"), ("0", "38.9", "39.01", "0.03", "stable"),
                 ("1", "59.78", "57.53", "0.04", "stable"), ("2", "77.687", "71.577", "0.05", "stable"),
                 ("3", "98.787", "89.697", "0.02", "stable"), ("0", "38.8", "38.92", "0.1", "timeout"),
                 ("2", "77.6", "71.5", "0.09", "sensor_error")],
            )
            self.assertEqual(json.loads(rows_by_type["parameter_operation"][0]["details"])["readback"]["version"], 2)
            self.assertEqual(json.loads(rows_by_type["parameter_operation"][1]["details"]), {"params_valid": True})
            for method, fit in (("endpoint", report.endpoint), ("least_squares", report.least_squares)):
                fit_rows = [row for row in rows_by_type["fit_point"] if row["fit_method"] == method]
                self.assertEqual(len(fit_rows), 4)
                for point_id, row in enumerate(fit_rows):
                    self.assertEqual(int(row["point_id"]), point_id)
                    self.assertEqual(float(row["slope_k"]), fit.slope_k)
                    self.assertEqual(float(row["offset_b"]), fit.offset_b)
                    self.assertEqual(float(row["corrected_rh"]), fit.corrected_rh[point_id])
                    self.assertEqual(float(row["residual"]), fit.residuals[point_id])
                    self.assertEqual(float(row["rmse"]), fit.rmse)
            self.assertEqual(rows_by_type["report_summary"][0]["recommended_method"], "least_squares")

            second_paths = exporter.export(self._session(), directory, stem="same-data")
            third_paths = exporter.export(self._session(), directory, stem="same-data-copy")
            self.assertEqual(second_paths.json_path.read_bytes(), third_paths.json_path.read_bytes())
            self.assertEqual(second_paths.csv_path.read_bytes(), third_paths.csv_path.read_bytes())

    def test_export_keeps_nested_values_owned_after_caller_mutates_original_inputs(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            metadata = {"device": {"ports": ["COM7"]}}
            details = {"readback": {"versions": [2]}}
            session = CalibrationSession(MasterProfile(), connection_metadata=metadata,
                                         started_at=datetime(2026, 8, 21, tzinfo=timezone.utc))
            session.record_parameter_operation("write", "ok", details,
                                               timestamp=datetime(2026, 8, 21, 1, tzinfo=timezone.utc))
            metadata["device"]["ports"].append("COM99")
            details["readback"]["versions"].append(99)

            paths = SessionExporter().export(session, Path(temporary_directory), stem="owned")
            document = json.loads(paths.json_path.read_text(encoding="utf-8"))

            self.assertEqual(document["connection_metadata"], {"device": {"ports": ["COM7"]}})
            self.assertEqual(document["parameter_operations"][0]["details"], {"readback": {"versions": [2]}})

    def test_failed_pair_commit_removes_new_json_and_temporary_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            (directory / "broken.csv").mkdir()

            with self.assertRaises(ExportError):
                SessionExporter().export(self._session(), directory, stem="broken")

            self.assertFalse((directory / "broken.json").exists())
            self.assertEqual(list(directory.glob("*.tmp")), [])

    def test_finite_cancelled_capture_is_retained_and_exports_successfully(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            session = self._session()
            session.record_capture(CaptureRun(1, 58.0, 57.0, 0.08, 12, 1200, "cancelled"))
            directory = Path(temporary_directory)

            paths = SessionExporter().export(session, directory, stem="cancelled")
            document = json.loads(paths.json_path.read_text(encoding="utf-8"))

            self.assertEqual(document["captures"][-1], {
                "point_id": 1, "mean_rh_raw": 58.0, "mean_rh_corrected": 57.0,
                "stddev_rh_raw": 0.08, "sample_count": 12, "elapsed_ms": 1200,
                "result_code": "cancelled",
            })

    def test_genuine_identical_capture_measurements_remain_two_export_records(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            session = CalibrationSession(MasterProfile())
            first = CaptureRun(0, 38.857, 38.983, 0.04, 150, 15_000, "stable")
            second = CaptureRun(0, 38.857, 38.983, 0.04, 150, 15_000, "stable")
            session.record_capture(first)
            session.record_capture(second)

            paths = SessionExporter().export(session, Path(temporary_directory), stem="identical-captures")
            document = json.loads(paths.json_path.read_text(encoding="utf-8"))
            with paths.csv_path.open("r", encoding="utf-8", newline="") as stream:
                capture_rows = [
                    row for row in csv.DictReader(stream)
                    if row["record_type"] == "capture"
                ]

            self.assertEqual(len(document["captures"]), 2)
            self.assertEqual(document["captures"][0], document["captures"][1])
            self.assertEqual(len(capture_rows), 2)
            self.assertEqual(capture_rows[0], capture_rows[1])

    def test_export_revalidates_malformed_report_before_writing_any_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            session = self._session()
            valid = session.report
            session._report = CalibrationReport(
                FitResult("endpoint", 1.0, 0.0, (1.0, 2.0, 3.0), (0.0, 0.0, 0.0), 0.0),
                valid.least_squares,
                "endpoint",
                (),
            )
            directory = Path(temporary_directory)

            with self.assertRaisesRegex(ExportError, "four"):
                SessionExporter().export(session, directory, stem="bad-report")

            self.assertFalse((directory / "bad-report.json").exists())
            self.assertFalse((directory / "bad-report.csv").exists())

    def test_mid_commit_failure_restores_existing_pair_and_cleans_staged_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            json_path = directory / "restore.json"
            csv_path = directory / "restore.csv"
            json_path.write_text("old json", encoding="utf-8")
            csv_path.write_text("old csv", encoding="utf-8")
            real_replace = os.replace

            def fail_csv_commit(source, destination):
                if Path(source).suffix == ".tmp" and Path(destination) == csv_path:
                    raise OSError("injected csv commit failure")
                return real_replace(source, destination)

            with patch("aw_calibrator.exporter.os.replace", side_effect=fail_csv_commit):
                with self.assertRaisesRegex(ExportError, "回滚"):
                    SessionExporter().export(self._session(), directory, stem="restore")

            self.assertEqual(json_path.read_text(encoding="utf-8"), "old json")
            self.assertEqual(csv_path.read_text(encoding="utf-8"), "old csv")
            self.assertEqual(list(directory.glob("*.tmp")), [])
            self.assertEqual(list(directory.glob("*.bak")), [])

    def test_backup_cleanup_failure_reports_committed_outputs_without_false_rollback(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            json_path = directory / "cleanup.json"
            csv_path = directory / "cleanup.csv"
            json_path.write_text("old json", encoding="utf-8")
            csv_path.write_text("old csv", encoding="utf-8")
            real_unlink = Path.unlink

            def fail_backup_unlink(path, *args, **kwargs):
                if path.suffix == ".bak":
                    raise OSError("injected backup cleanup failure")
                return real_unlink(path, *args, **kwargs)

            with patch("aw_calibrator.exporter.Path.unlink", new=fail_backup_unlink):
                with self.assertRaisesRegex(ExportError, "已提交"):
                    SessionExporter().export(self._session(), directory, stem="cleanup")

            self.assertNotEqual(json_path.read_text(encoding="utf-8"), "old json")
            self.assertNotEqual(csv_path.read_text(encoding="utf-8"), "old csv")
            self.assertEqual(list(directory.glob("*.tmp")), [])
            self.assertEqual(len(list(directory.glob("*.bak"))), 2)


if __name__ == "__main__":
    unittest.main()
