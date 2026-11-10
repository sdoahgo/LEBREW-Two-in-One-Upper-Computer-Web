"""Deterministic framed-protocol simulator implementing ``ByteTransport``."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
import math
import random
import statistics
import threading
import time

from .protocol import (
    CaptureProgress,
    CaptureResult,
    Command,
    DeviceInfo,
    DeviceParameters,
    Notice,
    Status,
    StreamDecoder,
    Telemetry,
    encode_frame,
    pack_capture_progress,
    pack_capture_result,
    pack_device_info,
    pack_device_parameters,
    pack_notice,
    pack_set_stream_response,
    pack_start_capture_response,
    pack_telemetry,
    unpack_set_params_request,
    unpack_set_stream_request,
    unpack_start_capture_request,
)


_CAPTURE_CENTERS = (38.857, 59.780, 77.687, 98.787)
_REQUEST_COMMANDS = frozenset(range(1, 9))
_CAPTURE_SAMPLE_INTERVAL_MS = 100
_CAPTURE_SAMPLE_COUNT = 150
_PARAM_SCHEMA_VERSION = 1


class SimulatedTransport:
    """In-memory device that consumes and produces only version-1 frames."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        seed: int = 1,
        capture_timeout_s: float = 480.0,
        sensor_available: bool | Callable[[], bool] = True,
        initial_cal_dew: float = 0.0,
    ) -> None:
        if (
            isinstance(capture_timeout_s, bool)
            or not isinstance(capture_timeout_s, (int, float))
            or not math.isfinite(capture_timeout_s)
            or capture_timeout_s <= 0
        ):
            raise ValueError("capture_timeout_s must be finite and positive")
        if (
            isinstance(initial_cal_dew, bool)
            or not isinstance(initial_cal_dew, (int, float))
            or not math.isfinite(initial_cal_dew)
        ):
            raise ValueError("initial_cal_dew must be finite")
        self._clock = clock
        self._capture_rng = random.Random(seed ^ 0x43A9_5EED)
        self._telemetry_rng = random.Random(seed ^ 0x7E1E_4E77)
        self._capture_timeout_ms = max(1, int(round(float(capture_timeout_s) * 1000.0)))
        self._sensor_available = sensor_available
        self._decoder = StreamDecoder()
        self._receiver: Callable[[bytes], None] | None = None
        self._lock = threading.Lock()
        self._open = False
        self._slope_k = 1.0
        self._offset_b = 0.0
        self._param_version = _PARAM_SCHEMA_VERSION
        self._params_valid = True
        self._cal_dew = float(initial_cal_dew)
        self._cal_dew_valid = True
        self._stream_enabled = False
        self._stream_interval_ms = 100
        self._next_stream_ms = 0
        self._sample_sequence = 0
        self._event_sequence = 0
        self._capture: dict | None = None
        self._outbound: deque[bytes] = deque()
        self._dispatching = False

    def set_receiver(self, receiver: Callable[[bytes], None]) -> None:
        if not callable(receiver):
            raise TypeError("receiver must be callable")
        with self._lock:
            self._receiver = receiver

    def open(self) -> None:
        with self._lock:
            if self._open:
                return
            self._open = True
            self._next_stream_ms = self._clock_ms() + self._stream_interval_ms

    def close(self) -> None:
        with self._lock:
            self._open = False
            self._capture = None

    def write(self, data: bytes) -> None:
        if not isinstance(data, bytes):
            raise TypeError("data must be bytes")
        with self._lock:
            if not self._open:
                raise RuntimeError("transport is not open")
            now_ms = self._clock_ms()
            output = self._advance_due_locked(now_ms)
            for frame in self._decoder.feed(data):
                output.extend(
                    self._handle_request_locked(
                        frame.command,
                        frame.sequence,
                        frame.payload,
                        now_ms,
                    )
                )
            self._outbound.extend(output)
        self._drain_outbound()

    def pump(self) -> None:
        """Emit all device events due at the injected clock's current tick."""
        with self._lock:
            if not self._open:
                return
            self._outbound.extend(self._advance_due_locked(self._clock_ms()))
        self._drain_outbound()

    def _handle_request_locked(
        self,
        command: int,
        sequence: int,
        payload: bytes,
        now_ms: int,
    ) -> list[bytes]:
        if command not in _REQUEST_COMMANDS:
            return [self._response(command, sequence, bytes((Status.UNKNOWN_COMMAND,)))]
        if command == Command.GET_INFO:
            if payload:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            info = DeviceInfo(Status.OK, "SIM-AW-0001", "sim-1.0")
            return [self._response(command, sequence, pack_device_info(info))]
        if command == Command.GET_PARAMS:
            if payload:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            return [self._response(command, sequence, pack_device_parameters(self._parameters()))]
        if command == Command.SET_PARAMS:
            if len(payload) != 8:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            try:
                slope_k, offset_b = unpack_set_params_request(payload)
            except ValueError:
                return [self._status_response(command, sequence, Status.INVALID_PARAMETER)]
            if not 0.25 <= slope_k <= 4.0 or not -100.0 <= offset_b <= 100.0:
                return [self._status_response(command, sequence, Status.INVALID_PARAMETER)]
            self._slope_k = slope_k
            self._offset_b = offset_b
            self._cal_dew = 0.0
            self._cal_dew_valid = False
            return [
                self._response(command, sequence, pack_device_parameters(self._parameters())),
                self._event(Command.NOTICE, pack_notice(Notice(1))),
                self._event(Command.NOTICE, pack_notice(Notice(2))),
            ]
        if command == Command.RESET_PARAMS:
            if payload:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            self._slope_k = 1.0
            self._offset_b = 0.0
            self._cal_dew = 0.0
            self._cal_dew_valid = False
            return [
                self._response(command, sequence, pack_device_parameters(self._parameters())),
                self._event(Command.NOTICE, pack_notice(Notice(1))),
                self._event(Command.NOTICE, pack_notice(Notice(2))),
            ]
        if command == Command.START_CAPTURE:
            if len(payload) != 9:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            try:
                point_id, capture_id = unpack_start_capture_request(payload)
            except ValueError:
                return [self._status_response(command, sequence, Status.INVALID_PARAMETER)]
            if point_id not in range(4):
                return [self._start_capture_response(
                    sequence,
                    Status.INVALID_PARAMETER,
                    point_id,
                    capture_id,
                )]
            if self._capture is not None:
                return [self._start_capture_response(
                    sequence,
                    Status.BUSY,
                    point_id,
                    capture_id,
                )]
            if not self._sensor_is_available():
                return [self._start_capture_response(
                    sequence,
                    Status.SENSOR_UNAVAILABLE,
                    point_id,
                    capture_id,
                )]
            self._capture = {
                "point_id": point_id,
                "capture_id": capture_id,
                "started_ms": now_ms,
                "samples": [],
            }
            return [self._start_capture_response(
                sequence,
                Status.OK,
                point_id,
                capture_id,
            )]
        if command == Command.CANCEL_CAPTURE:
            if payload:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            output = [self._response(command, sequence, bytes((Status.OK,)))]
            if self._capture is not None:
                output.append(self._capture_result_frame(2, now_ms))
                self._capture = None
            return output
        if command == Command.SET_STREAM:
            if len(payload) != 3:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            try:
                enabled, interval_ms = unpack_set_stream_request(payload)
            except ValueError:
                return [self._status_response(command, sequence, Status.INVALID_PARAMETER)]
            if not 100 <= interval_ms <= 1000:
                return [self._status_response(command, sequence, Status.INVALID_PARAMETER)]
            self._stream_enabled = enabled
            self._stream_interval_ms = interval_ms
            self._next_stream_ms = now_ms + interval_ms
            response = pack_set_stream_response(Status.OK, enabled, interval_ms)
            return [self._response(command, sequence, response)]
        if command == Command.HEARTBEAT:
            if payload:
                return [self._status_response(command, sequence, Status.BAD_LENGTH)]
            return [self._status_response(command, sequence, Status.OK)]
        raise AssertionError("unreachable command")

    def _advance_due_locked(self, now_ms: int) -> list[bytes]:
        output: list[bytes] = []
        while True:
            if self._capture is not None and not self._sensor_is_available():
                output.append(self._capture_result_frame(3, now_ms))
                self._capture = None
                continue

            candidates: list[tuple[int, int, str]] = []
            if self._stream_enabled and self._next_stream_ms <= now_ms:
                candidates.append((self._next_stream_ms, 0, "telemetry"))
            if self._capture is not None:
                capture = self._capture
                sample_count = len(capture["samples"])
                deadline_ms = capture["started_ms"] + self._capture_timeout_ms
                if sample_count < _CAPTURE_SAMPLE_COUNT:
                    sample_ms = capture["started_ms"] + (sample_count + 1) * _CAPTURE_SAMPLE_INTERVAL_MS
                    if sample_ms <= now_ms and sample_ms <= deadline_ms:
                        candidates.append((sample_ms, 1, "capture_sample"))
                if deadline_ms <= now_ms:
                    candidates.append((deadline_ms, 2, "capture_timeout"))
            if not candidates:
                return output

            due_ms, _priority, event_type = min(candidates)
            if event_type == "telemetry":
                output.append(self._telemetry_frame())
                self._next_stream_ms += self._stream_interval_ms
            elif event_type == "capture_sample":
                capture = self._capture
                center = _CAPTURE_CENTERS[capture["point_id"]]
                capture["samples"].append(
                    center + self._capture_rng.uniform(-0.015, 0.015)
                )
                sample_count = len(capture["samples"])
                if sample_count == 1 or sample_count % 10 == 0:
                    output.append(self._capture_progress_frame(due_ms))
                if sample_count == _CAPTURE_SAMPLE_COUNT:
                    output.append(self._capture_result_frame(0, due_ms))
                    self._capture = None
            else:
                output.append(self._capture_result_frame(1, due_ms))
                self._capture = None

    def _capture_progress_frame(self, now_ms: int) -> bytes:
        capture = self._capture
        samples = capture["samples"]
        progress = CaptureProgress(
            capture["point_id"],
            capture["capture_id"],
            len(samples),
            max(0, now_ms - capture["started_ms"]),
            statistics.fmean(samples),
            statistics.pstdev(samples),
        )
        return self._event(Command.CAPTURE_PROGRESS, pack_capture_progress(progress))

    def _capture_result_frame(self, result_code: int, now_ms: int) -> bytes:
        capture = self._capture
        samples = capture["samples"]
        center = _CAPTURE_CENTERS[capture["point_id"]]
        mean_raw = statistics.fmean(samples) if samples else center
        stddev = statistics.pstdev(samples) if samples else 0.0
        result = CaptureResult(
            capture["point_id"],
            result_code,
            capture["capture_id"],
            len(samples),
            max(0, now_ms - capture["started_ms"]),
            mean_raw,
            self._slope_k * mean_raw + self._offset_b,
            stddev,
        )
        return self._event(Command.CAPTURE_RESULT, pack_capture_result(result))

    def _telemetry_frame(self) -> bytes:
        self._sample_sequence = (self._sample_sequence + 1) & 0xFFFFFFFF
        raw = _CAPTURE_CENTERS[0] + self._telemetry_rng.uniform(-0.02, 0.02)
        corrected = self._slope_k * raw + self._offset_b
        aw_unclamped = self._aw_polynomial(corrected) - self._cal_dew
        aw_final = self._aw_final(corrected, aw_unclamped)
        flags = 0x01 | (0x02 if self._params_valid else 0) | (0x04 if self._cal_dew_valid else 0)
        telemetry = Telemetry(
            flags,
            self._sample_sequence,
            25.0,
            raw,
            corrected,
            aw_unclamped,
            aw_final,
        )
        return self._event(Command.TELEMETRY, pack_telemetry(telemetry))

    def _parameters(self) -> DeviceParameters:
        return DeviceParameters(
            Status.OK,
            self._param_version,
            self._params_valid,
            self._cal_dew_valid,
            self._slope_k,
            self._offset_b,
            self._cal_dew,
        )

    def _response(self, command: int, sequence: int, payload: bytes) -> bytes:
        return encode_frame(command | 0x80, sequence, payload)

    def _status_response(self, command: int, sequence: int, status: Status) -> bytes:
        return self._response(command, sequence, bytes((status,)))

    def _start_capture_response(
        self,
        sequence: int,
        status: Status,
        point_id: int,
        capture_id: int,
    ) -> bytes:
        return self._response(
            Command.START_CAPTURE,
            sequence,
            pack_start_capture_response(status, point_id, capture_id),
        )

    def _event(self, command: Command, payload: bytes) -> bytes:
        self._event_sequence = self._increment_uint16(self._event_sequence)
        return encode_frame(command, self._event_sequence, payload)

    def _sensor_is_available(self) -> bool:
        value = self._sensor_available() if callable(self._sensor_available) else self._sensor_available
        return bool(value)

    def _drain_outbound(self) -> None:
        with self._lock:
            if self._dispatching:
                return
            self._dispatching = True
        while True:
            with self._lock:
                if not self._outbound:
                    self._dispatching = False
                    return
                data = self._outbound.popleft()
                receiver = self._receiver
            try:
                if receiver is not None:
                    receiver(data)
            except Exception:
                with self._lock:
                    self._dispatching = False
                raise

    def _clock_ms(self) -> int:
        return int(round(self._clock() * 1000.0))

    @staticmethod
    def _increment_uint16(value: int) -> int:
        value = (value + 1) & 0xFFFF
        return value or 1

    @staticmethod
    def _aw_polynomial(humidity: float) -> float:
        return (
            (-0.000004422697519 * humidity + 0.000868044735923)
            * humidity
            - 0.041082199067613
        ) * humidity + 0.859771431117290

    @staticmethod
    def _aw_final(corrected_humidity: float, aw_unclamped: float) -> float:
        if corrected_humidity <= 31.015400:
            return 0.288660
        if corrected_humidity >= 95.210000:
            return 1.0
        return min(1.0, max(0.288660, aw_unclamped))
