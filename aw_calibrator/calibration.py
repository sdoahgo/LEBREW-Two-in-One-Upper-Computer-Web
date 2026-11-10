"""Pure calibration fitting and diagnostic calculations."""

import math
import statistics
from collections.abc import Iterable

from .models import CalibrationReport, CaptureRun, FitResult, RunAggregation


WARNING_TEXT = "单一斜率修正不足，可能需要K+B或多点校准"
_DENOMINATOR_EPSILON = 1e-9


def _validate_points(master_rh, device_rh):
    master = tuple(master_rh)
    device = tuple(device_rh)
    if len(master) != 4 or len(device) != 4:
        raise ValueError("master and device RH data must contain four points")
    if not all(math.isfinite(value) for value in (*master, *device)):
        raise ValueError("RH values must be finite")
    return master, device


def _fit(method, master, device, slope):
    offset = master[0] - slope * device[0]
    corrected = tuple(slope * value + offset for value in device)
    residuals = tuple(corrected_value - master_value for corrected_value, master_value in zip(corrected, master))
    rmse = math.sqrt(sum(residual * residual for residual in residuals) / 4.0)
    return FitResult(method, slope, offset, corrected, residuals, rmse)


def calculate_report(master_rh: tuple[float, float, float, float],
                     device_rh: tuple[float, float, float, float]) -> CalibrationReport:
    """Calculate endpoint and anchor-based least-squares RH corrections."""
    master, device = _validate_points(master_rh, device_rh)

    endpoint_denominator = device[3] - device[0]
    if abs(endpoint_denominator) < _DENOMINATOR_EPSILON:
        raise ValueError("device RH span is too small")
    endpoint_slope = (master[3] - master[0]) / endpoint_denominator

    anchored_deltas = tuple(value - device[0] for value in device[1:])
    master_deltas = tuple(value - master[0] for value in master[1:])
    least_squares_denominator = sum(delta * delta for delta in anchored_deltas)
    if abs(least_squares_denominator) < _DENOMINATOR_EPSILON:
        raise ValueError("device RH span is too small")
    least_squares_slope = sum(device_delta * master_delta
                              for device_delta, master_delta in zip(anchored_deltas, master_deltas)) / least_squares_denominator

    endpoint = _fit("endpoint", master, device, endpoint_slope)
    least_squares = _fit("least_squares", master, device, least_squares_slope)
    recommended = endpoint if endpoint.rmse <= least_squares.rmse else least_squares

    reasons = []
    if abs(device[0] - master[0]) > 1.0 or recommended.rmse > 0.75 or max(abs(value) for value in recommended.residuals) > 1.0:
        reasons.append(WARNING_TEXT)
    return CalibrationReport(endpoint, least_squares, recommended.method, tuple(reasons))


def aggregate_accepted_runs(runs: Iterable[CaptureRun]) -> RunAggregation:
    """Summarize accepted runs for one point using sample standard deviation.

    The caller supplies only accepted runs. A single run has valid means but
    no sample dispersion, represented by ``None`` rather than a misleading
    zero. Device-window population dispersion remains ``CaptureRun.stddev_rh_raw``.
    """
    accepted = tuple(runs)
    if not accepted:
        raise ValueError("at least one accepted run is required")
    if any(run.result_code != "stable" for run in accepted):
        raise ValueError("aggregate_accepted_runs accepts stable runs only")
    point_id = accepted[0].point_id
    if any(run.point_id != point_id for run in accepted[1:]):
        raise ValueError("aggregate_accepted_runs requires runs from the same point_id")

    raw_values = tuple(run.mean_rh_raw for run in accepted)
    corrected_values = tuple(run.mean_rh_corrected for run in accepted)
    count = len(accepted)
    return RunAggregation(
        point_id=point_id,
        count=count,
        mean_rh_raw=statistics.mean(raw_values),
        mean_rh_corrected=statistics.mean(corrected_values),
        stdev_rh_raw=statistics.stdev(raw_values) if count > 1 else None,
        stdev_rh_corrected=statistics.stdev(corrected_values) if count > 1 else None,
    )
