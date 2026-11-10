"""Deterministic, paired JSON and CSV exports for calibration sessions."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime, timezone
import io
import json
import math
import os
from pathlib import Path
import tempfile
import uuid
from typing import Any, Iterable, Mapping

from .models import CalibrationReport, CalibrationSession, CaptureRun, FitResult, validate_calibration_report


EXPORT_SCHEMA_VERSION = 1


class ExportError(RuntimeError):
    """A paired export failed before commit, during rollback, or after commit cleanup.

    Ordinary staging and pair-commit failures are rolled back.  If only
    obsolete backup deletion fails after both replacements, the new JSON/CSV
    outputs remain committed and their recovery backups are intentionally
    retained; the exception states that distinct outcome.
    """


@dataclass(frozen=True)
class ExportPaths:
    json_path: Path
    csv_path: Path


class SessionExporter:
    """Serialize each session in two formats with a single committed outcome.

    Staging or pair-commit failures raise :class:`ExportError`, remove newly
    created outputs, and restore pre-existing files.  A backup-cleanup failure
    occurs after commit: it raises :class:`ExportError` while retaining the new
    outputs and recovery backups, rather than falsely reporting a rollback.
    """

    CSV_HEADER = (
        "record_type", "timestamp", "device_id", "flags", "sample_sequence",
        "point_id", "result_code", "sample_count", "elapsed_ms", "temperature_c", "humidity_raw",
        "humidity_corrected", "aw_unclamped", "aw_final", "mean_rh_raw",
        "mean_rh_corrected", "stddev_rh_raw", "fit_method", "slope_k",
        "offset_b", "corrected_rh", "residual", "rmse", "recommended_method",
        "operation", "status", "details", "metadata",
    )

    def export(self, session: CalibrationSession, directory: str | Path, *, stem: str = "calibration_session") -> ExportPaths:
        if not isinstance(session, CalibrationSession):
            raise TypeError("session must be a CalibrationSession")
        if not isinstance(stem, str) or not stem or Path(stem).name != stem:
            raise ValueError("stem must be a simple file name")
        output_directory = Path(directory)
        paths = ExportPaths(output_directory / f"{stem}.json", output_directory / f"{stem}.csv")
        try:
            document = _session_document(session)
            _require_finite(document)
            json_bytes = (json.dumps(
                document, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False,
            ) + "\n").encode("utf-8")
            csv_bytes = _csv_bytes(session, document)
        except (TypeError, ValueError) as error:
            raise ExportError(f"会话包含无法导出的有限数据：{error}") from error

        temporary_paths: list[Path] = []
        try:
            output_directory.mkdir(parents=True, exist_ok=True)
            json_temp = _write_sibling_temp(paths.json_path, json_bytes)
            temporary_paths.append(json_temp)
            csv_temp = _write_sibling_temp(paths.csv_path, csv_bytes)
            temporary_paths.append(csv_temp)
            _commit_pair(((json_temp, paths.json_path), (csv_temp, paths.csv_path)))
        except OSError as error:
            raise ExportError(f"会话导出失败，已回滚：{error}") from error
        except ExportError:
            raise
        finally:
            for temporary_path in temporary_paths:
                if temporary_path.exists():
                    temporary_path.unlink()
        return paths


def _session_document(session: CalibrationSession) -> dict[str, Any]:
    return {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "device_id": session.device_id,
        "started_at": _timestamp(session.started_at),
        "ended_at": _timestamp(session.ended_at),
        "connection_metadata": _plain_value(session.connection_metadata),
        "master_profile": {"rh": list(session.master_profile.rh)},
        "telemetry": [_telemetry_record(value) for value in session.telemetry],
        "captures": [_capture_record(value) for value in session.capture_results],
        "accepted_runs_by_point": {
            str(point_id): [_capture_record(value) for value in runs]
            for point_id, runs in session.accepted_runs_by_point.items()
        },
        "parameter_operations": [
            {
                "operation": value.operation,
                "status": value.status,
                "details": _plain_value(value.details),
                "timestamp": _timestamp(value.timestamp),
            }
            for value in session.parameter_operations
        ],
        "report": _report_record(session.report),
    }


def _telemetry_record(value: Any) -> dict[str, Any]:
    return {
        "flags": value.flags,
        "sample_sequence": value.sample_sequence,
        "temperature_c": value.temperature_c,
        "humidity_raw": value.humidity_raw,
        "humidity_corrected": value.humidity_corrected,
        "aw_unclamped": value.aw_unclamped,
        "aw_final": value.aw_final,
    }


def _capture_record(value: CaptureRun) -> dict[str, Any]:
    return {
        "point_id": value.point_id,
        "mean_rh_raw": value.mean_rh_raw,
        "mean_rh_corrected": value.mean_rh_corrected,
        "stddev_rh_raw": value.stddev_rh_raw,
        "sample_count": value.sample_count,
        "elapsed_ms": value.elapsed_ms,
        "result_code": value.result_code,
    }


def _report_record(report: CalibrationReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    validate_calibration_report(report)
    return {
        "fits": {
            report.endpoint.method: _fit_record(report.endpoint),
            report.least_squares.method: _fit_record(report.least_squares),
        },
        "recommended_method": report.recommended_method,
        "warning_reasons": list(report.warning_reasons),
    }


def _fit_record(value: FitResult) -> dict[str, Any]:
    return {
        "slope_k": value.slope_k,
        "offset_b": value.offset_b,
        "corrected_rh": list(value.corrected_rh),
        "residuals": list(value.residuals),
        "rmse": value.rmse,
    }


def _csv_bytes(session: CalibrationSession, document: Mapping[str, Any]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=SessionExporter.CSV_HEADER, lineterminator="\n")
    writer.writeheader()
    writer.writerow(_row(
        "metadata", device_id=session.device_id, timestamp=document["started_at"],
        metadata=_compact_json({
            "schema_version": EXPORT_SCHEMA_VERSION,
            "connection_metadata": document["connection_metadata"],
            "master_profile": document["master_profile"],
            "ended_at": document["ended_at"],
        }),
    ))
    for value in document["telemetry"]:
        writer.writerow(_row("telemetry", device_id=session.device_id, **value))
    for value in document["captures"]:
        writer.writerow(_row("capture", device_id=session.device_id, **value))
    for value in document["parameter_operations"]:
        writer.writerow(_row(
            "parameter_operation", device_id=session.device_id, timestamp=value["timestamp"],
            operation=value["operation"], status=value["status"], details=_compact_json(value["details"]),
        ))
    report = document["report"]
    if report is not None:
        for method, fit in report["fits"].items():
            for point_id in range(4):
                writer.writerow(_row(
                    "fit_point", device_id=session.device_id, point_id=point_id,
                    fit_method=method, slope_k=fit["slope_k"], offset_b=fit["offset_b"],
                    corrected_rh=fit["corrected_rh"][point_id], residual=fit["residuals"][point_id], rmse=fit["rmse"],
                ))
        writer.writerow(_row(
            "report_summary", device_id=session.device_id,
            recommended_method=report["recommended_method"],
            details=_compact_json({"warning_reasons": report["warning_reasons"]}),
        ))
    return stream.getvalue().encode("utf-8")


def _row(record_type: str, **values: Any) -> dict[str, Any]:
    row = {column: "" for column in SessionExporter.CSV_HEADER}
    row["record_type"] = record_type
    row.update(values)
    return row


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise TypeError("timestamp must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat()


def _plain_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain_value(nested) for key, nested in value.items()}
    if isinstance(value, tuple):
        return [_plain_value(nested) for nested in value]
    return value


def _require_finite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("all numeric values must be finite")
    if isinstance(value, Mapping):
        for nested in value.values():
            _require_finite(nested)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            _require_finite(nested)


def _write_sibling_temp(final_path: Path, contents: bytes) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{final_path.name}.", suffix=".tmp", dir=final_path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if temporary_path.exists():
            temporary_path.unlink()
        raise
    return temporary_path


def _commit_pair(temporary_and_final: Iterable[tuple[Path, Path]]) -> None:
    pairs = tuple(temporary_and_final)
    for _, final_path in pairs:
        if final_path.exists() and not final_path.is_file():
            raise ExportError(f"导出目标不是文件：{final_path}")

    backups: list[tuple[Path, Path]] = []
    committed: list[Path] = []
    try:
        for _, final_path in pairs:
            if final_path.exists():
                backup_path = final_path.with_name(f".{final_path.name}.{uuid.uuid4().hex}.bak")
                os.replace(final_path, backup_path)
                backups.append((backup_path, final_path))
        for temporary_path, final_path in pairs:
            os.replace(temporary_path, final_path)
            committed.append(final_path)
    except OSError as error:
        rollback_errors = []
        for final_path in committed:
            try:
                final_path.unlink()
            except OSError as rollback_error:
                rollback_errors.append(rollback_error)
        for backup_path, final_path in backups:
            try:
                if backup_path.exists():
                    os.replace(backup_path, final_path)
            except OSError as rollback_error:
                rollback_errors.append(rollback_error)
        if rollback_errors:
            raise ExportError(f"会话导出失败且回滚不完整：{error}") from error
        raise ExportError(f"会话导出失败，已回滚：{error}") from error
    else:
        try:
            for backup_path, _ in backups:
                if backup_path.exists():
                    backup_path.unlink()
        except OSError as error:
            raise ExportError(f"会话导出已提交，但无法清理备份：{error}") from error
