"""Data models shared by the calibration workflow."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
import struct
from types import MappingProxyType
from typing import Any, Mapping

from .protocol import Telemetry


DEFAULT_MASTER_RH = (38.983, 57.530, 71.577, 89.697)
_KNOWN_RESULT_CODES = frozenset(("stable", "timeout", "cancelled", "sensor_error"))
_AW_FINAL_WIRE_MIN = struct.unpack("<f", struct.pack("<f", 0.288660))[0]
_AW_FINAL_WIRE_MAX = struct.unpack("<f", struct.pack("<f", 1.0))[0]


@dataclass(frozen=True)
class MasterProfile:
    """Four reference RH values, ordered by increasing water activity point."""

    rh: tuple[float, float, float, float] = DEFAULT_MASTER_RH

    def __post_init__(self) -> None:
        values = tuple(self.rh)
        if len(values) != 4 or any(isinstance(value, bool) or not isinstance(value, (int, float))
                                   or not math.isfinite(value) for value in values):
            raise ValueError("master profile RH values must be four finite numbers")
        object.__setattr__(self, "rh", values)


@dataclass(frozen=True)
class CaptureRun:
    """One device stability-window result."""

    point_id: int
    mean_rh_raw: float
    mean_rh_corrected: float
    stddev_rh_raw: float
    sample_count: int
    elapsed_ms: int
    result_code: str = "stable"


@dataclass(frozen=True)
class RunAggregation:
    """Aggregates accepted runs for one calibration point.

    A single accepted run has no sample dispersion, so both standard
    deviations are ``None``. Per-window dispersion remains on ``CaptureRun``
    as the device-provided population standard deviation.
    """

    point_id: int
    count: int
    mean_rh_raw: float
    mean_rh_corrected: float
    stdev_rh_raw: float | None
    stdev_rh_corrected: float | None


@dataclass(frozen=True)
class FitResult:
    method: str
    slope_k: float
    offset_b: float
    corrected_rh: tuple[float, float, float, float]
    residuals: tuple[float, float, float, float]
    rmse: float


@dataclass(frozen=True)
class CalibrationReport:
    endpoint: FitResult
    least_squares: FitResult
    recommended_method: str
    warning_reasons: tuple[str, ...]


@dataclass(frozen=True)
class ParameterOperation:
    """One parameter read/write/reset operation recorded by a session."""

    operation: str
    status: str
    details: Mapping[str, Any]
    timestamp: datetime


class CalibrationSession:
    """Own all data gathered during one device calibration session.

    Capture outcomes are never discarded.  The four per-point aggregates are
    derived only from stable, finite runs with a protocol-valid point id.
    Read-only tuple and mapping views prevent callers accidentally modifying
    the lists that underpin an in-progress session.
    """

    def __init__(
        self,
        master_profile: MasterProfile | None = None,
        *,
        device_id: str = "",
        connection_metadata: Mapping[str, Any] | None = None,
        started_at: datetime | None = None,
    ) -> None:
        if not isinstance(device_id, str):
            raise TypeError("device_id must be a string")
        if master_profile is None:
            master_profile = MasterProfile()
        if not isinstance(master_profile, MasterProfile):
            raise TypeError("master_profile must be a MasterProfile")
        _require_aware_datetime(started_at, "started_at", allow_none=True)
        self.master_profile = master_profile
        self.device_id = device_id
        self.started_at = started_at or datetime.now(timezone.utc)
        self.ended_at: datetime | None = None
        self._connection_metadata = _freeze_mapping(
            {} if connection_metadata is None else connection_metadata,
            "connection_metadata",
        )
        self._telemetry: list[Telemetry] = []
        self._capture_results: list[CaptureRun] = []
        self._accepted_runs: dict[int, list[CaptureRun]] = {point_id: [] for point_id in range(4)}
        self._parameter_operations: list[ParameterOperation] = []
        self._report: CalibrationReport | None = None

    @property
    def connection_metadata(self) -> Mapping[str, Any]:
        return self._connection_metadata

    @property
    def telemetry(self) -> tuple[Any, ...]:
        return tuple(self._telemetry)

    @property
    def capture_results(self) -> tuple[CaptureRun, ...]:
        return tuple(self._capture_results)

    @property
    def accepted_runs_by_point(self) -> Mapping[int, tuple[CaptureRun, ...]]:
        return MappingProxyType({point_id: tuple(runs) for point_id, runs in self._accepted_runs.items()})

    @property
    def parameter_operations(self) -> tuple[ParameterOperation, ...]:
        return tuple(self._parameter_operations)

    @property
    def report(self) -> CalibrationReport | None:
        return self._report

    def record_telemetry(self, telemetry: Telemetry) -> None:
        """Retain an entire validated telemetry packet, including raw AW data."""
        _validate_telemetry(telemetry)
        self._telemetry.append(telemetry)

    def record_capture(self, run: CaptureRun) -> None:
        """Record any device capture result and accept only valid stable runs."""
        _validate_recordable_capture(run)
        self._capture_results.append(run)
        if _is_accepted_run(run):
            self._accepted_runs[run.point_id].append(run)

    def point_aggregate(self, point_id: int) -> RunAggregation:
        """Return the Task 1 aggregate for accepted captures at one point."""
        if point_id not in self._accepted_runs or not self._accepted_runs[point_id]:
            raise ValueError("point has no accepted runs")
        from .calibration import aggregate_accepted_runs

        return aggregate_accepted_runs(self._accepted_runs[point_id])

    def device_point_means(self) -> tuple[float, float, float, float] | None:
        """Return finite raw-RH means for fitting once all four points are present."""
        if any(not self._accepted_runs[point_id] for point_id in range(4)):
            return None
        means = tuple(self.point_aggregate(point_id).mean_rh_raw for point_id in range(4))
        return means if all(math.isfinite(value) for value in means) else None

    def record_parameter_operation(
        self,
        operation: str,
        status: str,
        details: Mapping[str, Any] | None = None,
        *,
        timestamp: datetime | None = None,
    ) -> None:
        if not isinstance(operation, str) or not isinstance(status, str):
            raise TypeError("operation and status must be strings")
        self._parameter_operations.append(ParameterOperation(
            operation,
            status,
            _freeze_mapping({} if details is None else details, "details"),
            _validated_timestamp(timestamp, "timestamp") if timestamp is not None else datetime.now(timezone.utc),
        ))

    def set_report(self, report: CalibrationReport | None) -> None:
        if report is not None and not isinstance(report, CalibrationReport):
            raise TypeError("report must be a CalibrationReport or None")
        if report is not None:
            validate_calibration_report(report)
        self._report = report

    def finish(self, ended_at: datetime | None = None) -> None:
        self.ended_at = _validated_timestamp(ended_at, "ended_at") if ended_at is not None else datetime.now(timezone.utc)


def _is_finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _is_accepted_run(run: CaptureRun) -> bool:
    return (
        run.result_code == "stable"
        and type(run.point_id) is int
        and run.point_id in range(4)
        and all(_is_finite_number(value) for value in (
            run.mean_rh_raw, run.mean_rh_corrected, run.stddev_rh_raw,
        ))
        and run.stddev_rh_raw >= 0
    )


def _validate_recordable_capture(run: CaptureRun) -> None:
    """Reject malformed records before history ownership; semantic failures stay recorded."""
    if not isinstance(run, CaptureRun):
        raise TypeError("run must be a CaptureRun")
    if type(run.point_id) is not int:
        raise TypeError("point_id must be an exact int")
    for field_name in ("sample_count", "elapsed_ms"):
        value = getattr(run, field_name)
        if type(value) is not int:
            raise TypeError(f"{field_name} must be an exact int")
        if value < 0:
            raise ValueError(f"{field_name} must be nonnegative")
    for field_name in ("mean_rh_raw", "mean_rh_corrected", "stddev_rh_raw"):
        value = getattr(run, field_name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"{field_name} must be numeric")
        if not math.isfinite(value):
            raise ValueError(f"{field_name} must be finite")
    if run.result_code not in _KNOWN_RESULT_CODES:
        raise ValueError("result_code is unknown")


def _validate_telemetry(telemetry: Telemetry) -> None:
    if not isinstance(telemetry, Telemetry):
        raise TypeError("telemetry must be a protocol Telemetry")
    if type(telemetry.flags) is not int or not 0 <= telemetry.flags <= 0x07:
        raise ValueError("telemetry flags must be an integer between 0 and 7")
    if type(telemetry.sample_sequence) is not int or not 0 <= telemetry.sample_sequence <= 0xFFFFFFFF:
        raise ValueError("telemetry sample_sequence must be a uint32")
    for field_name in ("temperature_c", "humidity_raw", "humidity_corrected", "aw_unclamped", "aw_final"):
        if not _is_finite_number(getattr(telemetry, field_name)):
            raise ValueError(f"telemetry {field_name} must be finite")
    if not -40.0 <= telemetry.temperature_c <= 125.0:
        raise ValueError("telemetry temperature_c is out of range")
    if not -6.0 <= telemetry.humidity_raw <= 119.0:
        raise ValueError("telemetry humidity_raw is out of range")
    if not _AW_FINAL_WIRE_MIN <= telemetry.aw_final <= _AW_FINAL_WIRE_MAX:
        raise ValueError("telemetry aw_final is out of range")


def validate_calibration_report(report: CalibrationReport) -> None:
    """Ensure a report has the locked two-fit shape before it is stored/exported."""
    if not isinstance(report, CalibrationReport):
        raise TypeError("report must be a CalibrationReport")
    _validate_fit(report.endpoint, "endpoint")
    _validate_fit(report.least_squares, "least_squares")
    if report.recommended_method not in ("endpoint", "least_squares"):
        raise ValueError("recommended_method must name one report fit")
    if not isinstance(report.warning_reasons, tuple) or any(
        not isinstance(reason, str) or not reason.strip() for reason in report.warning_reasons
    ):
        raise ValueError("warning_reasons must be nonempty strings")
    if len(set(report.warning_reasons)) != len(report.warning_reasons):
        raise ValueError("warning_reasons must not repeat")


def _validate_fit(fit: FitResult, expected_method: str) -> None:
    if not isinstance(fit, FitResult):
        raise TypeError("report fits must be FitResult values")
    if fit.method != expected_method:
        raise ValueError(f"fit method must be {expected_method}")
    for field_name in ("slope_k", "offset_b", "rmse"):
        if not _is_finite_number(getattr(fit, field_name)):
            raise ValueError(f"{field_name} must be finite")
    if fit.rmse < 0:
        raise ValueError("rmse must be nonnegative")
    for field_name in ("corrected_rh", "residuals"):
        values = getattr(fit, field_name)
        if not isinstance(values, tuple) or len(values) != 4:
            raise ValueError(f"{field_name} must contain exactly four values")
        if not all(_is_finite_number(value) for value in values):
            raise ValueError(f"{field_name} values must be finite")


def _freeze_mapping(value: Mapping[str, Any], field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be a mapping")
    frozen = {}
    for key, nested in value.items():
        if not isinstance(key, str):
            raise TypeError(f"{field_name} keys must be strings")
        frozen[key] = _freeze_value(nested, field_name)
    return MappingProxyType(frozen)


def _freeze_value(value: Any, field_name: str) -> Any:
    if isinstance(value, Mapping):
        return _freeze_mapping(value, field_name)
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_value(item, field_name) for item in value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{field_name} floating-point values must be finite")
        return value
    raise TypeError(f"{field_name} contains an unsupported value")


def _require_aware_datetime(value: datetime | None, field_name: str, *, allow_none: bool = False) -> None:
    if value is None and allow_none:
        return
    _validated_timestamp(value, field_name)


def _validated_timestamp(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime):
        raise TypeError(f"{field_name} must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value
