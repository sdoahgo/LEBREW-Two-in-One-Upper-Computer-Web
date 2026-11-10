import math
import statistics
import unittest

from aw_calibrator.calibration import WARNING_TEXT, aggregate_accepted_runs, calculate_report
from aw_calibrator.models import CaptureRun, MasterProfile


MASTER = (38.983, 57.530, 71.577, 89.697)
DEVICE = (38.857, 59.780, 77.687, 98.787)


class CalibrationMathTests(unittest.TestCase):
    def test_given_device_data_matches_expected_results(self):
        report = calculate_report(MASTER, DEVICE)
        self.assertAlmostEqual(report.endpoint.slope_k, 0.846220590689, places=10)
        self.assertAlmostEqual(report.endpoint.offset_b, 6.101406507592, places=9)
        self.assertEqual(
            report.endpoint.corrected_rh,
            (38.983, 56.68847341898882, 71.8417455364592, 89.697),
        )
        self.assertEqual(
            report.endpoint.residuals,
            (0.0, -0.8415265810111805, 0.26474553645920196, 0.0),
        )
        self.assertAlmostEqual(report.endpoint.rmse, 0.441094430259, places=10)
        self.assertAlmostEqual(report.least_squares.slope_k, 0.847543870197, places=10)
        self.assertEqual(
            report.least_squares.corrected_rh,
            (38.983, 56.716160396126355, 71.89312847973935, 89.77630414089053),
        )
        self.assertEqual(
            report.least_squares.residuals,
            (0.0, -0.813839603873646, 0.31612847973934777, 0.07930414089052817),
        )
        self.assertAlmostEqual(report.least_squares.rmse, 0.438338129558, places=10)
        self.assertEqual(report.recommended_method, "least_squares")
        self.assertEqual(report.warning_reasons, ())

    def test_degenerate_device_span_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "device RH span"):
            calculate_report(MASTER, (40.0, 40.0, 40.0, 40.0))

    def test_non_finite_input_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "finite"):
            calculate_report(MASTER, (38.0, 57.0, math.nan, 90.0))

    def test_warning_thresholds_are_strictly_greater_than_limits(self):
        no_warning = calculate_report(MASTER, (39.983, 58.5, 72.5, 91.0))
        self.assertEqual(no_warning.warning_reasons, ())

        warning = calculate_report(MASTER, (37.9, 59.78, 77.687, 98.787))
        self.assertGreater(abs(37.9 - MASTER[0]), 1.0)
        self.assertEqual(warning.warning_reasons, (WARNING_TEXT,))

    def test_warning_is_reported_for_large_rmse(self):
        report = calculate_report(
            MASTER,
            (38.27667360809734, 64.2187981511552, 83.12198766869979, 104.89432447630176),
        )
        self.assertLessEqual(abs(38.27667360809734 - MASTER[0]), 1.0)
        self.assertGreater(report.least_squares.rmse, 0.75)
        self.assertLessEqual(max(abs(value) for value in report.least_squares.residuals), 1.0)
        self.assertEqual(report.warning_reasons, (WARNING_TEXT,))

    def test_warning_is_reported_for_large_residual(self):
        report = calculate_report(MASTER, (38.983, 58.0, 75.0, 95.0))
        self.assertLessEqual(abs(38.983 - MASTER[0]), 1.0)
        self.assertLessEqual(report.least_squares.rmse, 0.75)
        self.assertGreater(max(abs(value) for value in report.least_squares.residuals), 1.0)
        self.assertEqual(report.warning_reasons, (WARNING_TEXT,))

    def test_capture_run_uses_population_window_and_sample_cross_run_dispersion(self):
        run = CaptureRun(
            point_id=0,
            mean_rh_raw=40.0,
            mean_rh_corrected=40.0,
            stddev_rh_raw=statistics.pstdev((39.9, 40.0, 40.1)),
            sample_count=3,
            elapsed_ms=200,
            result_code="stable",
        )
        self.assertAlmostEqual(run.stddev_rh_raw, statistics.pstdev((39.9, 40.0, 40.1)))
        self.assertAlmostEqual(statistics.stdev((39.9, 40.0, 40.1)), 0.1)

    def test_master_profile_has_four_finite_reference_points(self):
        profile = MasterProfile()
        self.assertEqual(profile.rh, MASTER)
        self.assertEqual(len(profile.rh), 4)
        self.assertTrue(all(math.isfinite(value) for value in profile.rh))

    def test_aggregate_accepted_runs_uses_sample_dispersion(self):
        runs = (
            CaptureRun(0, 40.0, 41.0, 0.04, 150, 15000),
            CaptureRun(0, 40.2, 41.2, 0.03, 150, 15000),
            CaptureRun(0, 39.8, 40.8, 0.05, 150, 15000),
        )
        summary = aggregate_accepted_runs(runs)
        self.assertEqual(summary.point_id, 0)
        self.assertEqual(summary.count, 3)
        self.assertAlmostEqual(summary.mean_rh_raw, statistics.mean((40.0, 40.2, 39.8)))
        self.assertAlmostEqual(summary.mean_rh_corrected, statistics.mean((41.0, 41.2, 40.8)))
        self.assertAlmostEqual(summary.stdev_rh_raw, statistics.stdev((40.0, 40.2, 39.8)))
        self.assertAlmostEqual(summary.stdev_rh_corrected, statistics.stdev((41.0, 41.2, 40.8)))

    def test_aggregate_one_accepted_run_has_no_sample_dispersion(self):
        summary = aggregate_accepted_runs((CaptureRun(0, 40.0, 41.0, 0.04, 150, 15000),))
        self.assertEqual(summary.count, 1)
        self.assertEqual(summary.mean_rh_raw, 40.0)
        self.assertEqual(summary.mean_rh_corrected, 41.0)
        self.assertIsNone(summary.stdev_rh_raw)
        self.assertIsNone(summary.stdev_rh_corrected)

    def test_aggregate_rejects_mixed_calibration_points(self):
        runs = (
            CaptureRun(0, 40.0, 41.0, 0.04, 150, 15000),
            CaptureRun(1, 60.0, 61.0, 0.04, 150, 15000),
        )
        with self.assertRaisesRegex(ValueError, "same point_id"):
            aggregate_accepted_runs(runs)


if __name__ == "__main__":
    unittest.main()
