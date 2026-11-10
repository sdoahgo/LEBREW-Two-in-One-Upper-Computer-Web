"""Headless presentation reducer shared by the Tkinter desktop interface."""

from __future__ import annotations

from dataclasses import dataclass, replace
import importlib
import math
from pathlib import Path
import statistics
import tkinter as tk
from tkinter import filedialog, ttk

from . import __version__
from .calibration import calculate_report
from .chart import calibration_chart_data, draw_chart, realtime_chart_data
from .config_store import MasterProfileStore
from .controller import ControllerEvent
from .exporter import ExportError, SessionExporter
from .models import (
    CalibrationReport,
    CalibrationSession,
    CaptureRun,
    MasterProfile,
)
from .protocol import CaptureProgress, DeviceInfo, DeviceParameters, Telemetry


POINT_LABELS = ("0.328", "0.529", "0.753", "水(1.000)")
BAUD_RATES = (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600)
DEFAULT_BAUD_RATE = 115200
def configure_clickable_styles(root) -> ttk.Style:
    """Make every interactive control large and easy to identify."""
    style = ttk.Style(root)
    style.configure(
        "TButton",
        font=("Microsoft YaHei UI", 11, "bold"),
        padding=(14, 8),
    )
    style.configure(
        "Primary.TButton",
        font=("Microsoft YaHei UI", 11, "bold"),
        padding=(16, 9),
        foreground="#005fb8",
    )
    style.configure(
        "Warning.TButton",
        font=("Microsoft YaHei UI", 11, "bold"),
        padding=(14, 8),
        foreground="#b42318",
    )
    style.configure(
        "Capture.TButton",
        font=("Microsoft YaHei UI", 12, "bold"),
        padding=(18, 10),
        foreground="#075985",
    )
    style.configure(
        "TCheckbutton",
        font=("Microsoft YaHei UI", 10, "bold"),
        padding=(8, 5),
    )
    style.configure(
        "TCombobox",
        font=("Microsoft YaHei UI", 10),
        padding=(8, 6),
    )
    style.configure(
        "TNotebook.Tab",
        font=("Microsoft YaHei UI", 10, "bold"),
        padding=(16, 8),
    )
    style.map(
        "Primary.TButton",
        foreground=[("disabled", "#94a3b8"), ("active", "#003f7d")],
    )
    style.map(
        "Warning.TButton",
        foreground=[("disabled", "#b7a0a0"), ("active", "#7f1d1d")],
    )
    style.map(
        "Capture.TButton",
        foreground=[("disabled", "#94a3b8"), ("active", "#0c4a6e")],
    )
    return style


RECALIBRATION_NOTICE = "K/B 已变更，必须重新执行 0.753 校准"


@dataclass(frozen=True)
class PendingRequest:
    sequence: int
    operation: str


@dataclass(frozen=True)
class PresentationState:
    connection_state: str = "disconnected"
    connection_pending: str | None = None
    pending_requests: tuple[PendingRequest, ...] = ()
    profile_valid: bool = True
    capture_point: int | None = None
    capture_retry_point: int | None = None
    orphan_capture_recovery: bool = False
    accepted_counts: tuple[int, int, int, int] = (0, 0, 0, 0)
    capture_results: tuple[CaptureRun, ...] = ()
    report: CalibrationReport | None = None
    selected_method: str | None = None
    warning_text: str = ""
    recalibration_notice: str = ""
    status_text: str = "未连接"
    error_text: str = ""
    diagnostic_text: str = ""
    device_info: DeviceInfo | None = None
    parameters: DeviceParameters | None = None
    latest_telemetry: Telemetry | None = None
    recent_telemetry: tuple[Telemetry, ...] = ()
    sample_count: int = 0
    rolling_mean_raw: float | None = None
    rolling_stdev_raw: float | None = None
    capture_progress: CaptureProgress | None = None

    @property
    def pending_operation(self) -> str | None:
        """Compatibility display value; pending_requests remains authoritative."""
        if self.connection_pending is not None:
            return self.connection_pending
        return self.pending_requests[0].operation if self.pending_requests else None

    @property
    def pending_sequences(self) -> tuple[int, ...]:
        return tuple(request.sequence for request in self.pending_requests)

    def operation_for_sequence(self, sequence: int | None) -> str | None:
        if sequence is None:
            return None
        return next(
            (request.operation for request in self.pending_requests if request.sequence == sequence),
            None,
        )

    @property
    def device_id(self) -> str:
        return self.device_info.device_id if self.device_info is not None else ""

    @property
    def connect_enabled(self) -> bool:
        return (
            self.connection_state == "disconnected"
            and self.connection_pending is None
            and not self.pending_requests
        )

    @property
    def disconnect_enabled(self) -> bool:
        return self.connection_state == "connected" and self.connection_pending != "disconnect"

    @property
    def capture_enabled(self) -> tuple[bool, bool, bool, bool]:
        enabled = (
            self.connection_state == "connected"
            and self.connection_pending is None
            and not self.pending_requests
            and self.capture_point is None
            and not self.orphan_capture_recovery
            and self.capture_retry_point is None
        )
        return (enabled, enabled, enabled, enabled)

    @property
    def cancel_enabled(self) -> bool:
        return (
            self.connection_state == "connected"
            and (self.capture_point is not None or self.capture_retry_point is not None or self.orphan_capture_recovery)
            and self.connection_pending is None
            and not self.pending_requests
        )

    @property
    def device_command_enabled(self) -> bool:
        return (
            self.connection_state == "connected"
            and self.connection_pending is None
            and not self.pending_requests
            and self.capture_point is None
            and self.capture_retry_point is None
            and not self.orphan_capture_recovery
        )

    @property
    def write_enabled(self) -> bool:
        return (
            self.device_command_enabled
            and self.profile_valid
            and self.report is not None
            and self.selected_method in ("endpoint", "least_squares")
            and all(count >= 3 for count in self.accepted_counts)
        )

    @property
    def point_count_labels(self) -> tuple[str, str, str, str]:
        return tuple(
            f"{label}：{count}/3 次稳定"
            for label, count in zip(POINT_LABELS, self.accepted_counts)
        )

    @property
    def sample_sequence(self) -> int | None:
        return self.latest_telemetry.sample_sequence if self.latest_telemetry else None


def reduce_presentation(state: PresentationState, event: ControllerEvent) -> PresentationState:
    """Return a new UI state for a controller or UI-domain event."""
    if not isinstance(state, PresentationState):
        raise TypeError("state must be a PresentationState")
    if not isinstance(event, ControllerEvent):
        raise TypeError("event must be a ControllerEvent")
    kind = event.kind
    data = event.data

    if kind == "connect_requested":
        return replace(
            state,
            connection_state="connecting",
            connection_pending="connect",
            status_text="正在连接…",
            error_text="",
        )
    if kind == "connected":
        mode = data.get("mode", "device") if isinstance(data, dict) else "device"
        return replace(
            state,
            connection_state="connected",
            connection_pending=None,
            pending_requests=(),
            capture_point=None,
            capture_retry_point=None,
            accepted_counts=(0, 0, 0, 0),
            capture_results=(),
            report=None,
            selected_method=None,
            warning_text="",
            recalibration_notice="",
            device_info=None,
            parameters=None,
            latest_telemetry=None,
            recent_telemetry=(),
            sample_count=0,
            rolling_mean_raw=None,
            rolling_stdev_raw=None,
            capture_progress=None,
            status_text=f"已连接（{mode}）",
            error_text="",
        )
    if kind == "disconnect_requested":
        return replace(state, connection_pending="disconnect", status_text="正在断开…")
    if kind == "disconnected":
        return replace(
            state,
            connection_state="disconnected",
            connection_pending=None,
            pending_requests=(),
            capture_point=None,
            capture_retry_point=None,
            orphan_capture_recovery=(
                state.orphan_capture_recovery or state.capture_point is not None
            ),
            capture_progress=None,
            status_text="未连接",
        )
    if kind == "command_pending":
        operation = data.get("operation") if isinstance(data, dict) else None
        sequence = event.sequence
        if sequence is None and isinstance(data, dict):
            sequence = data.get("sequence")
        if type(sequence) is not int or not 1 <= sequence <= 0xFFFF:
            return replace(state, error_text="device command did not return a nonzero uint16 sequence")
        pending = tuple(request for request in state.pending_requests if request.sequence != sequence)
        return replace(
            state,
            pending_requests=(*pending, PendingRequest(sequence, str(operation or "device_command"))),
            error_text="",
            status_text=f"正在执行：{operation or '设备命令'}",
        )
    if kind == "info" and isinstance(data, DeviceInfo):
        return replace(
            state,
            device_info=data,
            pending_requests=_resolve_pending(state, event.sequence),
            status_text="设备信息已读取",
            error_text="",
        )
    if kind == "parameters" and isinstance(data, DeviceParameters):
        return replace(
            state,
            parameters=data,
            pending_requests=_resolve_pending(state, event.sequence),
            status_text="设备参数已读取",
            error_text="",
        )
    if kind in ("request_retry", "capture_recovering"):
        if state.operation_for_sequence(event.sequence) is None:
            return state
        return replace(state, status_text=event.message, error_text="")
    if kind == "write_verified" and isinstance(data, DeviceParameters):
        return replace(
            state,
            parameters=data,
            pending_requests=_resolve_pending(state, event.sequence),
            recalibration_notice=RECALIBRATION_NOTICE,
            status_text="K/B 写入并回读验证成功",
            error_text="",
        )
    if kind == "reset" and isinstance(data, DeviceParameters):
        return replace(
            state,
            parameters=data,
            pending_requests=_resolve_pending(state, event.sequence),
            recalibration_notice=RECALIBRATION_NOTICE,
            status_text="已恢复 K=1、B=0",
            error_text="",
        )
    if kind == "telemetry" and isinstance(data, Telemetry):
        recent = (*state.recent_telemetry, data)[-1_200:]
        raw_values = tuple(item.humidity_raw for item in recent)
        return replace(
            state,
            latest_telemetry=data,
            recent_telemetry=recent,
            sample_count=state.sample_count + 1,
            rolling_mean_raw=statistics.fmean(raw_values),
            rolling_stdev_raw=statistics.stdev(raw_values) if len(raw_values) > 1 else None,
        )
    if kind == "capture_started" and isinstance(data, dict):
        if state.operation_for_sequence(event.sequence) != "start_capture":
            return replace(state, diagnostic_text="已忽略未匹配请求的采集开始响应")
        point_id = data.get("point_id")
        return replace(
            state,
            pending_requests=_resolve_pending(state, event.sequence),
            capture_point=point_id if type(point_id) is int and point_id in range(4) else None,
            capture_retry_point=None,
            orphan_capture_recovery=False,
            status_text=f"正在采集 {POINT_LABELS[point_id]}" if type(point_id) is int and point_id in range(4) else "采集已开始",
            error_text="",
        )
    if kind == "capture_progress" and isinstance(data, CaptureProgress):
        if data.point_id not in range(4):
            return replace(state, diagnostic_text=f"已忽略无效采集点进度：{data.point_id}")
        if state.capture_point is not None and data.point_id != state.capture_point:
            return replace(
                state,
                diagnostic_text=(
                    f"已保留延迟的 {POINT_LABELS[data.point_id]} 进度；"
                    f"当前仍在采集 {POINT_LABELS[state.capture_point]}"
                ),
            )
        return replace(
            state,
            capture_point=data.point_id,
            capture_retry_point=None,
            capture_progress=data,
            status_text=f"采集中：{data.sample_count} 点，{data.elapsed_ms / 1000:.1f} 秒",
        )
    if kind == "capture_result" and isinstance(data, CaptureRun):
        counts = list(state.accepted_counts)
        if data.result_code == "stable" and data.point_id in range(4):
            counts[data.point_id] += 1
        retry_requested = (
            state.capture_point == data.point_id
            and data.point_id in range(4)
            and data.result_code not in ("stable", "cancelled")
        )
        result_status = (
            f"{POINT_LABELS[data.point_id]} 稳定采集完成"
            if data.result_code == "stable" and data.point_id in range(4)
            else (
                f"{POINT_LABELS[data.point_id]} 采集失败（{data.result_code}），1 秒后自动继续"
                if retry_requested
                else f"采集结果：{data.result_code}（未计入）"
            )
        )
        common = {
            "accepted_counts": tuple(counts),
            "capture_results": (*state.capture_results, data),
        }
        if state.capture_point is not None and data.point_id != state.capture_point:
            return replace(
                state,
                **common,
                diagnostic_text=(
                    f"已记录延迟的采集点 {data.point_id} 结果；"
                    f"当前仍在采集 {POINT_LABELS[state.capture_point]}"
                ),
            )
        return replace(
            state,
            **common,
            capture_point=None,
            orphan_capture_recovery=False,
            capture_retry_point=data.point_id if retry_requested else None,
            capture_progress=None,
            status_text=result_status,
        )
    if kind == "capture_retry_cancelled":
        return replace(
            state,
            capture_retry_point=None,
            status_text="已取消失败后的自动继续采集",
            error_text="",
        )
    if kind == "capture_cancelled":
        if state.operation_for_sequence(event.sequence) != "cancel_capture":
            return replace(state, diagnostic_text="已忽略未匹配请求的采集取消响应")
        return replace(
            state,
            pending_requests=_resolve_pending(state, event.sequence),
            orphan_capture_recovery=False,
            capture_retry_point=None,
            status_text=(
                "取消命令已确认，等待采集终态"
                if state.capture_point is not None
                else "取消已确认且采集已结束"
            ),
        )
    if kind == "stream_configured":
        return replace(state, status_text="实时数据流已启用")
    if kind == "report":
        return replace(state, diagnostic_text="已忽略 controller report，并使用当前基准与原始采集本地重算")
    if kind == "local_report":
        if data is None:
            return replace(state, report=None, selected_method=None, warning_text="")
        if not state.profile_valid:
            return replace(state, diagnostic_text="基准 RH 无效时已忽略本地标定结果")
        if not isinstance(data, CalibrationReport):
            return replace(state, error_text="local calibration report is invalid")
        selected_method = (
            state.selected_method
            if state.selected_method in ("endpoint", "least_squares")
            else data.recommended_method
        )
        return replace(
            state,
            report=data,
            selected_method=selected_method,
            warning_text=data.warning_reasons[0] if data.warning_reasons else "",
            status_text=state.status_text if state.capture_point is not None else "标定计算已更新",
            error_text="",
        )
    if kind == "profile_invalid":
        message = event.message or _event_reason(data) or "基准 RH 输入无效"
        return replace(
            state,
            profile_valid=False,
            report=None,
            selected_method=None,
            warning_text="",
            error_text=message,
            status_text="基准 RH 输入无效",
        )
    if kind == "profile_valid":
        return replace(state, profile_valid=True, error_text="", status_text="基准 RH 输入有效")
    if kind == "method_selected":
        method = data.get("method") if isinstance(data, dict) else None
        if method not in ("endpoint", "least_squares"):
            return replace(state, error_text=f"unsupported calibration method: {method}")
        return replace(state, selected_method=method, error_text="")
    if kind == "notice":
        notice_code = getattr(data, "notice_code", None)
        if notice_code == 2:
            return replace(state, recalibration_notice=RECALIBRATION_NOTICE)
        if notice_code == 1:
            return replace(state, status_text="设备参数已变化")
        return replace(state, diagnostic_text=f"未知设备通知：{notice_code}")
    if kind in ("request_timeout", "error"):
        message = event.message or _event_reason(data) or kind
        connection_state = state.connection_state
        connection_pending = state.connection_pending
        if isinstance(data, dict) and data.get("operation") == "connect":
            connection_state = "disconnected"
            connection_pending = None
        return replace(
            state,
            connection_state=connection_state,
            connection_pending=connection_pending,
            pending_requests=_resolve_pending(state, event.sequence),
            orphan_capture_recovery=(
                state.orphan_capture_recovery
                or (isinstance(data, dict) and data.get("capture_uncertain") is True)
            ),
            error_text=message,
            status_text="操作失败",
        )
    if kind == "runtime_error":
        return replace(state, error_text=event.message or _event_reason(data), status_text="界面事件处理失败")
    if kind == "diagnostic":
        return replace(state, diagnostic_text=event.message or _event_reason(data))
    if kind == "profile_saved":
        return replace(state, status_text="基准 RH 已保存", error_text="")
    if kind == "profile_error":
        return replace(state, error_text=event.message or _event_reason(data))
    if kind == "exported":
        return replace(state, status_text=event.message or "会话已导出", error_text="")

    if kind == "heartbeat":
        if state.diagnostic_text.startswith("心跳应答超时"):
            return replace(state, diagnostic_text="心跳通信已恢复")
        return state
    return replace(state, diagnostic_text=f"未识别事件：{kind}")


def _resolve_pending(state: PresentationState, sequence: int | None) -> tuple[PendingRequest, ...]:
    if sequence is None:
        return state.pending_requests
    return tuple(request for request in state.pending_requests if request.sequence != sequence)


def selected_fit(state: PresentationState):
    if state.report is None or state.selected_method is None:
        return None
    return getattr(state.report, state.selected_method, None)


def _event_reason(data: object) -> str:
    if isinstance(data, dict):
        return str(data.get("reason", ""))
    return ""


def enumerate_com_ports() -> tuple[str, ...]:
    """Enumerate COM devices without making pyserial a simulation dependency."""
    try:
        list_ports = importlib.import_module("serial.tools.list_ports")
    except (ImportError, ModuleNotFoundError) as error:
        raise RuntimeError("未安装 pyserial；模拟模式仍可使用") from error
    try:
        devices = tuple(str(port.device) for port in list_ports.comports())
    except Exception as error:
        raise RuntimeError(f"COM 口枚举失败：{error}") from error
    return tuple(sorted(set(devices)))


def apply_event_to_session(
    session: CalibrationSession,
    event: ControllerEvent,
    *,
    pending_operation: str | None = None,
) -> CalibrationSession:
    """Mirror one public event once, using correlated request context."""
    if not isinstance(session, CalibrationSession):
        raise TypeError("session must be a CalibrationSession")
    if event.kind == "connected":
        metadata = event.data if isinstance(event.data, dict) else {}
        return CalibrationSession(session.master_profile, connection_metadata=metadata)
    if event.kind == "disconnected":
        if session.ended_at is None:
            session.finish()
    elif event.kind == "info" and isinstance(event.data, DeviceInfo):
        session.device_id = event.data.device_id
    elif event.kind == "telemetry" and isinstance(event.data, Telemetry):
        session.record_telemetry(event.data)
    elif event.kind == "capture_result" and isinstance(event.data, CaptureRun):
        session.record_capture(event.data)
    elif event.kind == "parameters" and isinstance(event.data, DeviceParameters) and pending_operation == "read_parameters":
        session.record_parameter_operation("read", "ok", _parameter_details(event.data))
    elif (
        event.kind == "write_verified"
        and isinstance(event.data, DeviceParameters)
        and pending_operation == "write_parameters"
    ):
        session.record_parameter_operation("write", "verified", _parameter_details(event.data))
    elif (
        event.kind == "reset"
        and isinstance(event.data, DeviceParameters)
        and pending_operation == "reset_parameters"
    ):
        session.record_parameter_operation("reset", "ok", _parameter_details(event.data))
    elif event.kind in ("request_timeout", "error"):
        operation = pending_operation
        if operation in {
            "read_parameters",
            "write_parameters",
            "reset_parameters",
        }:
            details = dict(event.data) if isinstance(event.data, dict) else {}
            details["reason"] = event.message or _event_reason(event.data) or event.kind
            session.record_parameter_operation(
                operation,
                "error",
                details,
            )
    return session


def smoke_observation_complete(observed: set[str]) -> bool:
    return {"info", "parameters", "telemetry"}.issubset(observed)


def calibration_data_for_session(
    session: CalibrationSession,
    state: PresentationState,
):
    """Build the categorical chart from raw device means and the chosen fit."""
    if any(not session.accepted_runs_by_point[index] for index in range(4)):
        raise ValueError("all four calibration points are required")
    fit = selected_fit(state)
    if fit is None:
        raise ValueError("a calibration fit must be selected")
    raw_means = tuple(
        session.point_aggregate(index).mean_rh_raw
        for index in range(4)
    )
    return calibration_chart_data(raw_means, fit.corrected_rh, session.master_profile.rh)


class CalibrationWorkflow:
    """Single non-Tk authority for profile, accepted raw runs, report and requests."""

    def __init__(self, controller, profile: MasterProfile | None = None) -> None:
        self.controller = controller
        self.profile = profile or MasterProfile()
        if not isinstance(self.profile, MasterProfile):
            raise TypeError("profile must be a MasterProfile")
        self.state = PresentationState()
        self.session = CalibrationSession(self.profile)
        self.finished_sessions: list[CalibrationSession] = []

    def dispatch(self, event: ControllerEvent) -> None:
        self.state = reduce_presentation(self.state, event)

    def issue(
        self,
        operation: str,
        command,
        *,
        allow_concurrent: bool = False,
    ) -> int:
        if not isinstance(operation, str) or not operation:
            raise ValueError("operation must be a nonempty string")
        if not allow_concurrent:
            allowed = self.state.device_command_enabled
            if operation == "cancel_capture":
                allowed = self.state.cancel_enabled
            if not allowed:
                raise RuntimeError("device command is disabled while disconnected or busy")
        sequence = command()
        if type(sequence) is not int or not 1 <= sequence <= 0xFFFF:
            raise ValueError("device command must return a nonzero uint16 sequence")
        self.dispatch(ControllerEvent(
            "command_pending",
            {"operation": operation, "sequence": sequence},
            sequence,
        ))
        return sequence

    def consume(self, event: ControllerEvent) -> None:
        if not isinstance(event, ControllerEvent):
            raise TypeError("event must be a ControllerEvent")
        pending_operation = self.state.operation_for_sequence(event.sequence)
        if event.kind == "connected":
            self._preserve_current_session()
            metadata = event.data if isinstance(event.data, dict) else {}
            self.session = CalibrationSession(self.profile, connection_metadata=metadata)
        else:
            self.session = apply_event_to_session(
                self.session,
                event,
                pending_operation=pending_operation,
            )
            if event.kind == "disconnected":
                self._preserve_current_session()
        self.dispatch(event)
        if event.kind == "report" or (
            event.kind == "capture_result"
            and isinstance(event.data, CaptureRun)
            and event.data.result_code == "stable"
        ):
            self.recompute_report()

    def set_profile(self, profile: MasterProfile) -> CalibrationReport | None:
        if not isinstance(profile, MasterProfile):
            raise TypeError("profile must be a MasterProfile")
        self.profile = profile
        self.session.master_profile = profile
        self.dispatch(ControllerEvent("profile_valid"))
        return self.recompute_report()

    def set_profile_entries(self, entries) -> MasterProfile:
        """Apply all four displayed entry texts or invalidate the current report."""
        try:
            values = tuple(float(value) for value in entries)
            profile = MasterProfile(values)
        except (TypeError, ValueError, OverflowError) as error:
            message = f"基准 RH 输入无效：{error}"
            self.session.set_report(None)
            self.dispatch(ControllerEvent("profile_invalid", {"reason": message}, message=message))
            raise ValueError(message) from error
        self.set_profile(profile)
        return profile

    def recompute_report(self) -> CalibrationReport | None:
        if not self.state.profile_valid or any(
            not self.session.accepted_runs_by_point[point_id]
            for point_id in range(4)
        ):
            self.session.set_report(None)
            self.dispatch(ControllerEvent("local_report", None))
            return None
        raw_means = tuple(
            self.session.point_aggregate(point_id).mean_rh_raw
            for point_id in range(4)
        )
        try:
            report = calculate_report(self.profile.rh, raw_means)
        except (TypeError, ValueError):
            self.session.set_report(None)
            self.dispatch(ControllerEvent("local_report", None))
            raise
        self.session.set_report(report)
        self.dispatch(ControllerEvent("local_report", report))
        return report

    def select_method(self, method: str) -> None:
        previous = self.state.selected_method
        self.dispatch(ControllerEvent("method_selected", {"method": method}))
        if self.state.selected_method != previous:
            self.session.record_parameter_operation(
                "method_selection",
                "selected",
                {"method": method},
            )

    def write_selected_parameters(self) -> int:
        if not self.state.profile_valid:
            raise ValueError("基准 RH 输入无效，不能写入 K/B")
        accepted_counts = tuple(
            len(self.session.accepted_runs_by_point[point_id])
            for point_id in range(4)
        )
        if any(count < 3 for count in accepted_counts):
            raise RuntimeError("每个标定点至少需要 3 次稳定采集，不能写入 K/B")
        if accepted_counts != self.state.accepted_counts:
            raise RuntimeError("采集计数与会话记录不一致，不能写入 K/B")
        if self.state.report is None or self.session.report is None:
            raise RuntimeError("没有有效的本地标定报告，不能写入 K/B")
        if self.state.report != self.session.report:
            raise RuntimeError("显示报告与会话报告不一致，不能写入 K/B")
        if not self.state.write_enabled:
            raise RuntimeError("当前连接或命令状态不允许写入 K/B")
        fit = selected_fit(self.state)
        if fit is None:
            raise RuntimeError("没有可写入的拟合结果")
        return self.issue(
            "write_parameters",
            lambda: self.controller.write_parameters(fit.slope_k, fit.offset_b),
        )

    def _preserve_current_session(self) -> None:
        if not session_has_activity(self.session):
            return
        if self.session.ended_at is None:
            self.session.finish()
        if not any(session is self.session for session in self.finished_sessions):
            self.finished_sessions.append(self.session)

    @property
    def export_enabled(self) -> bool:
        return session_has_activity(self.session)


def session_has_activity(session: CalibrationSession) -> bool:
    if not isinstance(session, CalibrationSession):
        raise TypeError("session must be a CalibrationSession")
    return bool(
        session.connection_metadata
        or session.ended_at is not None
        or session.telemetry
        or session.capture_results
        or session.parameter_operations
        or session.device_id
        or session.report
    )


def _parameter_details(parameters: DeviceParameters) -> dict[str, object]:
    return {
        "param_version": parameters.param_version,
        "params_valid": parameters.params_valid,
        "cal_dew_valid": parameters.cal_dew_valid,
        "slope_k": parameters.slope_k,
        "offset_b": parameters.offset_b,
        "cal_dew": parameters.cal_dew,
    }


class AwCalibratorApp:
    """Windows Tkinter/ttk shell around public controller events only."""

    POLL_INTERVAL_MS = 20
    CAPTURE_RETRY_DELAY_MS = 1_000
    HEARTBEAT_INTERVAL_MS = 2_000
    REALTIME_CHART_SAMPLE_STEP = 5
    SMOKE_TIMEOUT_MS = 8_000

    @property
    def state(self) -> PresentationState:
        return self.workflow.state

    @state.setter
    def state(self, value: PresentationState) -> None:
        self.workflow.state = value

    @property
    def session(self) -> CalibrationSession:
        return self.workflow.session

    @session.setter
    def session(self, value: CalibrationSession) -> None:
        self.workflow.session = value

    @property
    def profile(self) -> MasterProfile:
        return self.workflow.profile

    def __init__(
        self,
        root: tk.Tk,
        controller,
        *,
        profile_store: MasterProfileStore | None = None,
        exporter: SessionExporter | None = None,
        simulate: bool = False,
        smoke_test: bool = False,
    ) -> None:
        self.root = root
        self.controller = controller
        self.profile_store = profile_store or MasterProfileStore()
        self.exporter = exporter or SessionExporter()
        load_result = self.profile_store.load()
        self.workflow = CalibrationWorkflow(controller, load_result.profile)
        self.workflow.state = PresentationState(
            error_text=load_result.error or "",
            status_text="基准配置已加载" if not load_result.error else "已恢复内置基准配置",
        )
        self.smoke_test = smoke_test
        self.control_style = configure_clickable_styles(self.root)
        self.smoke_observed: set[str] = set()
        self.smoke_succeeded = False
        self.smoke_error = ""
        self._closed = False
        self._capture_retry_after_id = None
        self._heartbeat_after_id = None
        self._last_realtime_draw_sample_count = -self.REALTIME_CHART_SAMPLE_STEP

        self.root.title(f"ESP32-C6 水活标定系统 · v{__version__}")
        self.root.geometry("1240x820")
        self.root.minsize(1020, 700)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self.simulation_var = tk.BooleanVar(value=simulate)
        self.port_var = tk.StringVar()
        self.baud_var = tk.StringVar(value=str(DEFAULT_BAUD_RATE))
        self.status_var = tk.StringVar()
        self.error_var = tk.StringVar()
        self.diagnostic_var = tk.StringVar()
        self.recalibration_var = tk.StringVar()
        self.profile_status_var = tk.StringVar(value=load_result.error or "使用已保存/内置基准值")
        self.method_var = tk.StringVar()
        self.export_directory_var = tk.StringVar(value=str(Path.cwd() / "exports"))
        self.device_vars = {
            key: tk.StringVar(value="—")
            for key in (
                "device_id",
                "firmware",
                "protocol",
                "param_version",
                "params_valid",
                "cal_dew_valid",
                "slope_k",
                "offset_b",
                "cal_dew",
            )
        }
        self.metric_vars = {
            key: tk.StringVar(value="—")
            for key in (
                "raw",
                "corrected",
                "aw_unclamped",
                "aw_final",
                "sequence",
                "count",
                "rolling_mean",
                "rolling_stdev",
            )
        }
        self.master_vars = [tk.StringVar(value=f"{value:.3f}") for value in self.profile.rh]
        self._updating_master_vars = False
        for variable in self.master_vars:
            variable.trace_add("write", self._master_profile_edited)

        self._build_layout()
        self._render()
        self.root.after(self.POLL_INTERVAL_MS, self._poll_controller)

    def _build_layout(self) -> None:
        root_frame = ttk.Frame(self.root, padding=8)
        root_frame.pack(fill=tk.BOTH, expand=True)
        root_frame.rowconfigure(2, weight=1)
        root_frame.columnconfigure(0, weight=1)

        ttk.Label(
            root_frame,
            text="ESP32-C6 水活标定系统",
            font=("Microsoft YaHei UI", 15, "bold"),
        ).grid(row=0, column=0, sticky="w", pady=(0, 6))
        self._build_status_banners(root_frame)

        paned = ttk.Panedwindow(root_frame, orient=tk.VERTICAL)
        paned.grid(row=2, column=0, sticky="nsew", pady=(6, 0))
        connection = ttk.LabelFrame(paned, text="连接与设备", padding=8)
        notebook_frame = ttk.Frame(paned)
        paned.add(connection, weight=0)
        paned.add(notebook_frame, weight=1)
        self._build_connection_panel(connection)

        self.notebook = ttk.Notebook(notebook_frame)
        self.notebook.pack(fill=tk.BOTH, expand=True)
        live_tab = ttk.Frame(self.notebook, padding=8)
        calibration_tab = ttk.Frame(self.notebook, padding=8)
        records_tab = ttk.Frame(self.notebook, padding=8)
        self.notebook.add(live_tab, text="实时数据")
        self.notebook.add(calibration_tab, text="采集与计算")
        self.notebook.add(records_tab, text="记录与设备参数")
        self._build_live_tab(live_tab)
        self._build_calibration_tab(calibration_tab)
        self._build_records_tab(records_tab)

    def _build_status_banners(self, parent: ttk.Frame) -> None:
        banners = ttk.Frame(parent)
        banners.grid(row=1, column=0, sticky="ew")
        banners.columnconfigure(1, weight=1)
        ttk.Label(banners, text="状态：").grid(row=0, column=0, sticky="w")
        ttk.Label(banners, textvariable=self.status_var).grid(row=0, column=1, sticky="w")
        ttk.Label(banners, text="错误：", foreground="#b91c1c").grid(row=1, column=0, sticky="w")
        ttk.Label(banners, textvariable=self.error_var, foreground="#b91c1c").grid(row=1, column=1, sticky="w")
        ttk.Label(banners, text="提示：", foreground="#9a3412").grid(row=2, column=0, sticky="w")
        ttk.Label(banners, textvariable=self.recalibration_var, foreground="#9a3412").grid(row=2, column=1, sticky="w")
        ttk.Label(banners, textvariable=self.diagnostic_var, foreground="#6b7280").grid(row=3, column=1, sticky="w")

    def _build_connection_panel(self, frame: ttk.LabelFrame) -> None:
        frame.columnconfigure(10, weight=1)
        ttk.Label(frame, text="COM 口").grid(row=0, column=0, padx=3)
        self.port_combo = ttk.Combobox(frame, textvariable=self.port_var, width=12, state="readonly")
        self.port_combo.grid(row=0, column=1, padx=4, pady=4)
        self.refresh_button = ttk.Button(frame, text="刷新 COM", command=self.refresh_ports)
        self.refresh_button.grid(row=0, column=2, padx=4, pady=4)
        ttk.Label(frame, text="波特率").grid(row=0, column=3, padx=(10, 3))
        self.baud_combo = ttk.Combobox(
            frame,
            textvariable=self.baud_var,
            values=tuple(str(value) for value in BAUD_RATES),
            width=10,
            state="readonly",
        )
        self.baud_combo.grid(row=0, column=4, padx=4, pady=4)
        self.simulation_check = ttk.Checkbutton(frame, text="模拟设备", variable=self.simulation_var)
        self.simulation_check.grid(row=0, column=5, padx=8, pady=4)
        self.connect_button = ttk.Button(frame, text="连接", command=self.connect, style="Primary.TButton")
        self.connect_button.grid(row=0, column=6, padx=4, pady=4)
        self.disconnect_button = ttk.Button(frame, text="断开", command=self.disconnect, style="Warning.TButton")
        self.disconnect_button.grid(row=0, column=7, padx=4, pady=4)

        labels = (
            ("设备编号", "device_id"),
            ("固件版本", "firmware"),
            ("协议版本", "protocol"),
            ("参数版本", "param_version"),
            ("参数有效", "params_valid"),
            ("0.753 有效", "cal_dew_valid"),
        )
        for index, (label, key) in enumerate(labels):
            column = (index % 3) * 3
            row = 1 + index // 3
            ttk.Label(frame, text=f"{label}：").grid(row=row, column=column, sticky="e", padx=(3, 0), pady=2)
            ttk.Label(frame, textvariable=self.device_vars[key]).grid(row=row, column=column + 1, columnspan=2, sticky="w", padx=(0, 8))

    def _build_live_tab(self, tab: ttk.Frame) -> None:
        tab.rowconfigure(1, weight=1)
        tab.columnconfigure(0, weight=1)
        metrics = ttk.LabelFrame(tab, text="实时测量", padding=8)
        metrics.grid(row=0, column=0, sticky="ew")
        items = (
            ("原始 RH (%RH)", "raw"),
            ("修正 RH (%RH)", "corrected"),
            ("未限幅 AW", "aw_unclamped"),
            ("最终 AW", "aw_final"),
            ("样本序号", "sequence"),
            ("会话样本数", "count"),
            ("滚动均值 RH", "rolling_mean"),
            ("样本标准差", "rolling_stdev"),
        )
        for index, (label, key) in enumerate(items):
            column = (index % 4) * 2
            row = index // 4
            ttk.Label(metrics, text=f"{label}：").grid(row=row, column=column, sticky="e", padx=4, pady=3)
            ttk.Label(metrics, textvariable=self.metric_vars[key], width=15).grid(row=row, column=column + 1, sticky="w")
        self.realtime_canvas = tk.Canvas(tab, background="white", highlightthickness=1, highlightbackground="#d1d5db")
        self.realtime_canvas.grid(row=1, column=0, sticky="nsew", pady=(8, 0))
        self.realtime_canvas.bind("<Configure>", lambda _event: self._draw_realtime())

    def _build_calibration_tab(self, tab: ttk.Frame) -> None:
        tab.rowconfigure(0, weight=1)
        tab.columnconfigure(0, weight=1)
        horizontal = ttk.Panedwindow(tab, orient=tk.HORIZONTAL)
        horizontal.grid(row=0, column=0, sticky="nsew")
        left = ttk.Frame(horizontal)
        right = ttk.Frame(horizontal)
        horizontal.add(left, weight=1)
        horizontal.add(right, weight=1)
        self._build_capture_side(left)
        self._build_calculation_side(right)

    def _build_capture_side(self, parent: ttk.Frame) -> None:
        parent.rowconfigure(2, weight=1)
        parent.columnconfigure(0, weight=1)
        controls = ttk.LabelFrame(parent, text="四点稳定采集（每点至少 3 次）", padding=8)
        controls.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self.capture_buttons = []
        self.count_vars = []
        for point_id, label in enumerate(POINT_LABELS):
            count_var = tk.StringVar()
            self.count_vars.append(count_var)
            button = ttk.Button(
                controls,
                text=f"采集 {label}",
                command=lambda selected=point_id: self.start_capture(selected),
                style="Capture.TButton",
            )
            button.grid(row=point_id, column=0, sticky="ew", padx=4, pady=4)
            ttk.Label(controls, textvariable=count_var, width=23).grid(row=point_id, column=1, sticky="w", padx=5)
            self.capture_buttons.append(button)
        self.cancel_button = ttk.Button(
            controls,
            text="取消当前采集",
            command=self.cancel_capture,
            style="Warning.TButton",
        )
        self.cancel_button.grid(row=4, column=0, columnspan=2, sticky="ew", padx=4, pady=(8, 4))

        profile = ttk.LabelFrame(parent, text="一号机基准 RH", padding=8)
        profile.grid(row=1, column=0, sticky="ew", padx=(0, 4), pady=6)
        for index, (label, variable) in enumerate(zip(POINT_LABELS, self.master_vars)):
            ttk.Label(profile, text=label).grid(row=0, column=index, padx=3)
            ttk.Entry(profile, textvariable=variable, width=10).grid(row=1, column=index, padx=3)
        ttk.Button(profile, text="保存", command=self.save_profile, style="Primary.TButton").grid(row=2, column=0, sticky="ew", padx=3, pady=6)
        ttk.Button(profile, text="重新加载", command=self.reload_profile).grid(row=2, column=1, sticky="ew", padx=3, pady=6)
        ttk.Button(profile, text="恢复内置默认", command=self.load_default_profile, style="Warning.TButton").grid(row=2, column=2, columnspan=2, sticky="ew", padx=3, pady=6)
        ttk.Label(profile, textvariable=self.profile_status_var).grid(row=3, column=0, columnspan=4, sticky="w")

        runs = ttk.LabelFrame(parent, text="每次采集结果（非稳定结果保留但不计入）", padding=4)
        runs.grid(row=2, column=0, sticky="nsew", padx=(0, 4))
        runs.rowconfigure(0, weight=1)
        runs.columnconfigure(0, weight=1)
        columns = ("point", "raw", "corrected", "window_dev", "count", "elapsed", "result")
        self.run_tree = ttk.Treeview(runs, columns=columns, show="headings", height=10)
        headings = ("点", "原始均值", "修正均值", "窗口偏差", "样本数", "耗时(s)", "结果")
        for column, heading in zip(columns, headings):
            self.run_tree.heading(column, text=heading)
            self.run_tree.column(column, width=82, anchor="center")
        self.run_tree.grid(row=0, column=0, sticky="nsew")
        ttk.Scrollbar(runs, orient=tk.VERTICAL, command=self.run_tree.yview).grid(row=0, column=1, sticky="ns")

    def _build_calculation_side(self, parent: ttk.Frame) -> None:
        parent.rowconfigure(3, weight=1)
        parent.columnconfigure(0, weight=1)
        selector = ttk.Frame(parent)
        selector.grid(row=0, column=0, sticky="ew", padx=(4, 0))
        ttk.Label(selector, text="使用方法：").pack(side=tk.LEFT)
        self.method_combo = ttk.Combobox(
            selector,
            textvariable=self.method_var,
            values=("endpoint", "least_squares"),
            state="readonly",
            width=18,
        )
        self.method_combo.pack(side=tk.LEFT, padx=3)
        self.method_combo.bind("<<ComboboxSelected>>", self._method_changed)
        self.warning_var = tk.StringVar()
        ttk.Label(selector, textvariable=self.warning_var, foreground="#b91c1c").pack(side=tk.LEFT, padx=12)

        fit_frame = ttk.LabelFrame(parent, text="K/B 与 RMSE", padding=4)
        fit_frame.grid(row=1, column=0, sticky="ew", padx=(4, 0), pady=5)
        self.fit_tree = ttk.Treeview(fit_frame, columns=("method", "k", "b", "rmse"), show="headings", height=2)
        for column, heading in zip(("method", "k", "b", "rmse"), ("方法", "K", "B", "RMSE")):
            self.fit_tree.heading(column, text=heading)
            self.fit_tree.column(column, width=115, anchor="center")
        self.fit_tree.pack(fill=tk.X)

        residual_frame = ttk.LabelFrame(parent, text="四点修正 RH / 残差", padding=4)
        residual_frame.grid(row=2, column=0, sticky="ew", padx=(4, 0))
        columns = ("point", "ep_corr", "ep_res", "ls_corr", "ls_res")
        self.residual_tree = ttk.Treeview(residual_frame, columns=columns, show="headings", height=4)
        headings = ("点", "端点修正", "端点残差", "最小二乘修正", "最小二乘残差")
        for column, heading in zip(columns, headings):
            self.residual_tree.heading(column, text=heading)
            self.residual_tree.column(column, width=105, anchor="center")
        self.residual_tree.pack(fill=tk.X)

        self.calibration_canvas = tk.Canvas(parent, background="white", highlightthickness=1, highlightbackground="#d1d5db")
        self.calibration_canvas.grid(row=3, column=0, sticky="nsew", padx=(4, 0), pady=(6, 0))
        self.calibration_canvas.bind("<Configure>", lambda _event: self._draw_calibration())

    def _build_records_tab(self, tab: ttk.Frame) -> None:
        tab.columnconfigure(0, weight=1)
        parameters = ttk.LabelFrame(tab, text="设备参数与回读", padding=8)
        parameters.grid(row=0, column=0, sticky="ew")
        details = (
            ("K", "slope_k"),
            ("B", "offset_b"),
            ("cal_dew", "cal_dew"),
            ("参数版本", "param_version"),
            ("参数有效", "params_valid"),
            ("cal_dew 有效", "cal_dew_valid"),
        )
        for index, (label, key) in enumerate(details):
            ttk.Label(parameters, text=f"{label}：").grid(row=index // 3, column=(index % 3) * 2, sticky="e", padx=4, pady=3)
            ttk.Label(parameters, textvariable=self.device_vars[key], width=18).grid(row=index // 3, column=(index % 3) * 2 + 1, sticky="w")
        self.read_info_button = ttk.Button(parameters, text="读取设备信息", command=lambda: self._issue("read_info", self.controller.read_info))
        self.read_params_button = ttk.Button(parameters, text="读取参数", command=lambda: self._issue("read_parameters", self.controller.read_parameters))
        self.write_button = ttk.Button(parameters, text="写入选定 K/B 并自动回读", command=self.write_selected_parameters, style="Primary.TButton")
        self.reset_button = ttk.Button(parameters, text="恢复 K=1 / B=0", command=lambda: self._issue("reset_parameters", self.controller.reset_parameters), style="Warning.TButton")
        for column, button in enumerate((self.read_info_button, self.read_params_button, self.write_button, self.reset_button)):
            parameters.columnconfigure(column, weight=1)
            button.grid(row=2, column=column, sticky="ew", padx=4, pady=(10, 4))

        aggregate = ttk.LabelFrame(tab, text="稳定重复统计（跨次样本标准差）", padding=4)
        aggregate.grid(row=1, column=0, sticky="ew", pady=8)
        columns = ("point", "count", "raw_mean", "corrected_mean", "raw_stdev", "corrected_stdev")
        self.aggregate_tree = ttk.Treeview(aggregate, columns=columns, show="headings", height=4)
        headings = ("点", "稳定次数", "原始均值", "修正均值", "原始样本偏差", "修正样本偏差")
        for column, heading in zip(columns, headings):
            self.aggregate_tree.heading(column, text=heading)
            self.aggregate_tree.column(column, width=130, anchor="center")
        self.aggregate_tree.pack(fill=tk.X)

        export = ttk.LabelFrame(tab, text="会话导出（JSON + CSV）", padding=8)
        export.grid(row=2, column=0, sticky="ew")
        export.columnconfigure(1, weight=1)
        ttk.Label(export, text="目录：").grid(row=0, column=0)
        ttk.Entry(export, textvariable=self.export_directory_var).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(export, text="浏览", command=self.browse_export_directory).grid(row=0, column=2, padx=4, pady=4)
        self.export_button = ttk.Button(export, text="导出会话", command=self.export_session, style="Primary.TButton")
        self.export_button.grid(row=0, column=3, padx=4, pady=4)

    def refresh_ports(self) -> None:
        try:
            ports = enumerate_com_ports()
        except RuntimeError as error:
            self._dispatch(ControllerEvent("error", {"operation": "com_refresh", "reason": str(error)}, message=str(error)))
            return
        self.port_combo.configure(values=ports)
        if ports and self.port_var.get() not in ports:
            self.port_var.set(ports[0])
        self.state = replace(
            self.state,
            status_text=f"发现 {len(ports)} 个 COM 口" if ports else "未发现 COM 口；可使用模拟模式",
            error_text="",
        )
        self._render()

    def connect(self) -> None:
        if not self.state.connect_enabled:
            return
        self._dispatch(ControllerEvent("connect_requested"))
        try:
            if self.simulation_var.get():
                self.controller.connect_simulator()
            else:
                port = self.port_var.get().strip()
                if not port:
                    raise ValueError("请选择 COM 口或启用模拟设备")
                self.controller.connect_serial(port, int(self.baud_var.get()))
        except Exception as error:
            self._dispatch(ControllerEvent("error", {"operation": "connect", "reason": str(error)}, message=str(error)))

    def disconnect(self) -> None:
        if self.state.connection_state == "disconnected":
            return
        self._cancel_scheduled_capture_retry()
        self._cancel_scheduled_heartbeat()
        self._dispatch(ControllerEvent("disconnect_requested"))
        try:
            self.controller.disconnect()
        except Exception as error:
            self._dispatch(ControllerEvent("error", {"operation": "disconnect", "reason": str(error)}, message=str(error)))

    def start_capture(self, point_id: int) -> None:
        self._issue("start_capture", lambda: self.controller.start_capture(point_id))

    def cancel_capture(self) -> None:
        if self.state.capture_retry_point is not None:
            self._cancel_scheduled_capture_retry()
            self._dispatch(ControllerEvent("capture_retry_cancelled"))
            return
        self._issue("cancel_capture", self.controller.cancel_capture)

    def _schedule_capture_retry(self) -> None:
        point_id = self.state.capture_retry_point
        if self._closed or point_id is None or self.state.connection_state != "connected":
            return
        self._cancel_scheduled_capture_retry()
        self._capture_retry_after_id = self.root.after(
            self.CAPTURE_RETRY_DELAY_MS,
            self._continue_capture_after_failure,
        )

    def _continue_capture_after_failure(self) -> None:
        self._capture_retry_after_id = None
        point_id = self.state.capture_retry_point
        if (
            self._closed
            or point_id is None
            or self.state.connection_state != "connected"
        ):
            return
        sequence = self._issue(
            "start_capture",
            lambda: self.controller.start_capture(point_id),
            allow_concurrent=True,
        )
        if (
            sequence is None
            and not self._closed
            and self.state.capture_retry_point is not None
        ):
            self._schedule_capture_retry()

    def _cancel_scheduled_capture_retry(self) -> None:
        after_id = getattr(self, "_capture_retry_after_id", None)
        if after_id is None:
            return
        self._capture_retry_after_id = None
        try:
            self.root.after_cancel(after_id)
        except (tk.TclError, ValueError):
            pass

    def _schedule_heartbeat(self, delay_ms: int | None = None) -> None:
        if self._closed or self.state.connection_state != "connected":
            return
        self._cancel_scheduled_heartbeat()
        delay = self.HEARTBEAT_INTERVAL_MS if delay_ms is None else delay_ms
        self._heartbeat_after_id = self.root.after(delay, self._send_heartbeat)

    def _send_heartbeat(self) -> None:
        self._heartbeat_after_id = None
        if self._closed or self.state.connection_state != "connected":
            return
        try:
            self.controller.send_heartbeat()
        except Exception:
            # The controller reports actual transport failures through its
            # normal error/disconnect events; heartbeat stays in background.
            pass
        finally:
            if not self._closed and self.state.connection_state == "connected":
                self._schedule_heartbeat()

    def _cancel_scheduled_heartbeat(self) -> None:
        after_id = getattr(self, "_heartbeat_after_id", None)
        if after_id is None:
            return
        self._heartbeat_after_id = None
        try:
            self.root.after_cancel(after_id)
        except (tk.TclError, ValueError):
            pass

    def write_selected_parameters(self) -> None:
        try:
            self.workflow.write_selected_parameters()
        except Exception as error:
            self._dispatch(ControllerEvent("error", {"operation": "write_parameters", "reason": str(error)}, message=str(error)))
        else:
            self._render()

    def _issue(self, operation: str, command, *, allow_concurrent: bool = False) -> int | None:
        try:
            sequence = self.workflow.issue(
                operation,
                command,
                allow_concurrent=allow_concurrent,
            )
        except Exception as error:
            self._dispatch(ControllerEvent("error", {"operation": operation, "reason": str(error)}, message=str(error)))
            return None
        self._render()
        return sequence

    def _poll_controller(self) -> None:
        if self._closed:
            return
        try:
            try:
                events = self.controller.poll_events()
            except Exception as error:
                self._surface_runtime_failure("控制器轮询失败", error)
                events = ()
            for event in events:
                try:
                    self._consume_controller_event(event)
                except Exception as error:
                    self._surface_runtime_failure(f"事件 {event.kind} 处理失败", error)
            if self.smoke_test and smoke_observation_complete(self.smoke_observed):
                self.smoke_succeeded = True
                self.close()
        except Exception as error:
            self._surface_runtime_failure("轮询周期失败", error)
        finally:
            if not self._closed:
                self.root.after(self.POLL_INTERVAL_MS, self._poll_controller)

    def _surface_runtime_failure(self, context: str, error: Exception) -> None:
        message = f"{context}：{error}"
        try:
            self.workflow.dispatch(ControllerEvent(
                "runtime_error",
                {"reason": message},
                message=message,
            ))
        except Exception as state_error:
            self.workflow.state = replace(
                self.workflow.state,
                error_text=f"{message}；状态更新失败：{state_error}",
                status_text="界面事件处理失败",
            )
        try:
            self._render()
        except Exception as render_error:
            self.workflow.state = replace(
                self.workflow.state,
                error_text=f"{self.workflow.state.error_text}；界面刷新失败：{render_error}",
                status_text="界面事件处理失败",
            )

    def _consume_controller_event(self, event: ControllerEvent) -> None:
        self.workflow.consume(event)
        if event.kind in ("info", "parameters", "telemetry"):
            self.smoke_observed.add(event.kind)
        if event.kind == "disconnected":
            self._cancel_scheduled_heartbeat()
            self._cancel_scheduled_capture_retry()
        if event.kind == "capture_result":
            if self.state.capture_retry_point is not None:
                self._schedule_capture_retry()
            else:
                self._cancel_scheduled_capture_retry()
        if event.kind == "connected":
            self._issue("read_info", self.controller.read_info, allow_concurrent=True)
            self._issue("read_parameters", self.controller.read_parameters, allow_concurrent=True)
            self._schedule_heartbeat(0)
        if event.kind == "telemetry":
            self._render_telemetry()
        else:
            self._render()

    def _dispatch(self, event: ControllerEvent) -> None:
        self.workflow.dispatch(event)
        self._render()

    def save_profile(self) -> None:
        try:
            profile = self.workflow.set_profile_entries(
                tuple(variable.get() for variable in self.master_vars),
            )
            self.profile_store.save(profile)
        except (OSError, TypeError, ValueError) as error:
            message = f"基准 RH 保存失败：{error}"
            self.profile_status_var.set(message)
            self._dispatch(ControllerEvent("profile_error", {"reason": message}, message=message))
            return
        self._set_profile(profile)
        self.profile_status_var.set("基准 RH 已保存")
        self._dispatch(ControllerEvent("profile_saved"))

    def reload_profile(self) -> None:
        result = self.profile_store.load()
        self._set_profile(result.profile)
        self.profile_status_var.set(result.error or "基准 RH 已重新加载")
        if result.error:
            self._dispatch(ControllerEvent("profile_error", {"reason": result.error}, message=result.error))
        else:
            self._dispatch(ControllerEvent("profile_saved"))

    def load_default_profile(self) -> None:
        self._set_profile(MasterProfile())
        self.profile_status_var.set("已载入内置默认值（点击保存后持久化）")
        self.state = replace(self.state, status_text="已载入内置默认基准值", error_text="")
        self._render()

    def _set_profile(self, profile: MasterProfile) -> None:
        self._updating_master_vars = True
        try:
            for variable, value in zip(self.master_vars, profile.rh):
                variable.set(f"{value:.3f}")
        finally:
            self._updating_master_vars = False
        self.workflow.set_profile(profile)
        self._render()

    def _master_profile_edited(self, *_args) -> None:
        if self._updating_master_vars:
            return
        try:
            self.workflow.set_profile_entries(
                tuple(variable.get() for variable in self.master_vars),
            )
        except (TypeError, ValueError) as error:
            self.profile_status_var.set(str(error))
            self._render()
            return
        self.profile_status_var.set("基准 RH 已修改（尚未保存）")
        self._render()

    def _recalculate_local_report(self) -> None:
        try:
            self.workflow.recompute_report()
        except ValueError as error:
            self._dispatch(ControllerEvent("error", {"operation": "calculate_report", "reason": str(error)}, message=str(error)))
        else:
            self._render()

    def _method_changed(self, _event=None) -> None:
        method = self.method_var.get()
        self.workflow.select_method(method)
        self._render()

    def browse_export_directory(self) -> None:
        selected = filedialog.askdirectory(parent=self.root, title="选择会话导出目录")
        if selected:
            self.export_directory_var.set(selected)

    def export_session(self) -> None:
        directory = self.export_directory_var.get().strip()
        if not directory:
            self._dispatch(ControllerEvent("error", {"operation": "export", "reason": "请选择导出目录"}, message="请选择导出目录"))
            return
        try:
            paths = self.exporter.export(self.session, directory)
        except (ExportError, OSError, TypeError, ValueError) as error:
            message = f"导出失败：{error}"
            self._dispatch(ControllerEvent("error", {"operation": "export", "reason": message}, message=message))
            return
        self._dispatch(ControllerEvent("exported", message=f"已导出：{paths.json_path.name} / {paths.csv_path.name}"))

    def start_smoke_test(self) -> None:
        if not self.smoke_test:
            return
        self.root.after(0, self.connect)
        self.root.after(self.SMOKE_TIMEOUT_MS, self._smoke_timeout)

    def _smoke_timeout(self) -> None:
        if self._closed or self.smoke_succeeded:
            return
        missing = sorted({"info", "parameters", "telemetry"} - self.smoke_observed)
        self.smoke_error = f"smoke test timeout; missing: {', '.join(missing)}"
        self.close()

    def _render_telemetry(self) -> None:
        self._render_live_metrics()
        last_draw = getattr(
            self,
            "_last_realtime_draw_sample_count",
            -self.REALTIME_CHART_SAMPLE_STEP,
        )
        if self.state.sample_count - last_draw >= self.REALTIME_CHART_SAMPLE_STEP:
            self._draw_realtime()

    def _render_live_metrics(self) -> None:
        telemetry = self.state.latest_telemetry
        if telemetry:
            metrics = {
                "raw": f"{telemetry.humidity_raw:.4f}",
                "corrected": f"{telemetry.humidity_corrected:.4f}",
                "aw_unclamped": f"{telemetry.aw_unclamped:.6f}",
                "aw_final": f"{telemetry.aw_final:.6f}",
                "sequence": str(telemetry.sample_sequence),
                "count": str(self.state.sample_count),
                "rolling_mean": _optional_number(self.state.rolling_mean_raw),
                "rolling_stdev": _optional_number(self.state.rolling_stdev_raw),
            }
            for key, value in metrics.items():
                self.metric_vars[key].set(value)
        else:
            for variable in self.metric_vars.values():
                variable.set("—")


    def _render(self) -> None:
        self.status_var.set(self.state.status_text)
        self.error_var.set(self.state.error_text)
        self.diagnostic_var.set(self.state.diagnostic_text)
        self.recalibration_var.set(self.state.recalibration_notice)
        self.warning_var.set(self.state.warning_text)
        self.connect_button.configure(state=_widget_state(self.state.connect_enabled))
        self.disconnect_button.configure(state=_widget_state(self.state.disconnect_enabled))
        connection_editable = self.state.connect_enabled
        self.port_combo.configure(state="readonly" if connection_editable else "disabled")
        self.baud_combo.configure(state="readonly" if connection_editable else "disabled")
        self.refresh_button.configure(state=_widget_state(connection_editable))
        self.simulation_check.configure(state=_widget_state(connection_editable))
        for button, enabled in zip(self.capture_buttons, self.state.capture_enabled):
            button.configure(state=_widget_state(enabled))
        self.cancel_button.configure(state=_widget_state(self.state.cancel_enabled))
        for variable, label in zip(self.count_vars, self.state.point_count_labels):
            variable.set(label)
        command_enabled = self.state.device_command_enabled
        self.read_info_button.configure(state=_widget_state(command_enabled))
        self.read_params_button.configure(state=_widget_state(command_enabled))
        self.reset_button.configure(state=_widget_state(command_enabled))
        self.write_button.configure(state=_widget_state(self.state.write_enabled))
        self.export_button.configure(state=_widget_state(self.workflow.export_enabled))

        info = self.state.device_info
        self.device_vars["device_id"].set(info.device_id if info else "—")
        self.device_vars["firmware"].set(info.firmware_version if info else "—")
        self.device_vars["protocol"].set("1" if info else "—")
        parameters = self.state.parameters
        if parameters:
            values = {
                "param_version": str(parameters.param_version),
                "params_valid": _yes_no(parameters.params_valid),
                "cal_dew_valid": _yes_no(parameters.cal_dew_valid),
                "slope_k": f"{parameters.slope_k:.9g}",
                "offset_b": f"{parameters.offset_b:.9g}",
                "cal_dew": f"{parameters.cal_dew:.9g}",
            }
            for key, value in values.items():
                self.device_vars[key].set(value)
        else:
            for key in ("param_version", "params_valid", "cal_dew_valid", "slope_k", "offset_b", "cal_dew"):
                self.device_vars[key].set("—")

        self._render_live_metrics()
        selected_method = self.state.selected_method or ""
        if self.method_var.get() != selected_method:
            self.method_var.set(selected_method)
        self._render_capture_tables()
        self._render_report_tables()
        self._draw_realtime()
        self._draw_calibration()

    def _render_capture_tables(self) -> None:
        self.run_tree.delete(*self.run_tree.get_children())
        for run in self.state.capture_results:
            label = POINT_LABELS[run.point_id] if run.point_id in range(4) else str(run.point_id)
            self.run_tree.insert("", tk.END, values=(
                label,
                f"{run.mean_rh_raw:.4f}",
                f"{run.mean_rh_corrected:.4f}",
                f"{run.stddev_rh_raw:.4f}",
                run.sample_count,
                f"{run.elapsed_ms / 1000:.1f}",
                run.result_code,
            ))
        self.aggregate_tree.delete(*self.aggregate_tree.get_children())
        for point_id in range(4):
            if not self.session.accepted_runs_by_point[point_id]:
                continue
            aggregate = self.session.point_aggregate(point_id)
            self.aggregate_tree.insert("", tk.END, values=(
                POINT_LABELS[point_id],
                aggregate.count,
                f"{aggregate.mean_rh_raw:.4f}",
                f"{aggregate.mean_rh_corrected:.4f}",
                _optional_number(aggregate.stdev_rh_raw),
                _optional_number(aggregate.stdev_rh_corrected),
            ))

    def _render_report_tables(self) -> None:
        self.fit_tree.delete(*self.fit_tree.get_children())
        self.residual_tree.delete(*self.residual_tree.get_children())
        report = self.state.report
        if report is None:
            return
        for fit in (report.endpoint, report.least_squares):
            self.fit_tree.insert("", tk.END, values=(fit.method, f"{fit.slope_k:.9f}", f"{fit.offset_b:.9f}", f"{fit.rmse:.6f}"))
        for index, label in enumerate(POINT_LABELS):
            self.residual_tree.insert("", tk.END, values=(
                label,
                f"{report.endpoint.corrected_rh[index]:.4f}",
                f"{report.endpoint.residuals[index]:+.4f}",
                f"{report.least_squares.corrected_rh[index]:.4f}",
                f"{report.least_squares.residuals[index]:+.4f}",
            ))

    def _draw_realtime(self) -> None:
        if not hasattr(self, "realtime_canvas"):
            return
        draw_chart(self.realtime_canvas, realtime_chart_data(self.state.recent_telemetry))
        self._last_realtime_draw_sample_count = self.state.sample_count

    def _draw_calibration(self) -> None:
        if not hasattr(self, "calibration_canvas"):
            return
        if self.state.report is None:
            self.calibration_canvas.delete("all")
            return
        try:
            data = calibration_data_for_session(self.session, self.state)
        except ValueError:
            return
        draw_chart(self.calibration_canvas, data)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._cancel_scheduled_capture_retry()
        self._cancel_scheduled_heartbeat()
        try:
            self.controller.disconnect()
        finally:
            self.workflow.consume(ControllerEvent("disconnected"))
            self.root.destroy()


def _widget_state(enabled: bool) -> str:
    return tk.NORMAL if enabled else tk.DISABLED


def _yes_no(value: bool) -> str:
    return "是" if value else "否"


def _optional_number(value: float | None) -> str:
    return "—" if value is None or not math.isfinite(value) else f"{value:.5f}"
