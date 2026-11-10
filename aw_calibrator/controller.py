"""Thread-safe request controller for real and simulated framed transports."""

from __future__ import annotations

from dataclasses import dataclass
import math
import logging
import queue
import secrets
import threading
import time
from typing import Any, Callable

from .calibration import calculate_report
from .models import CalibrationSession, CaptureRun, MasterProfile
from .protocol import (
    Command,
    DeviceParameters,
    Frame,
    Status,
    StreamDecoder,
    encode_frame,
    pack_set_params_request,
    pack_set_stream_request,
    pack_start_capture_request,
    response_command,
    unpack_capture_progress,
    unpack_capture_result,
    unpack_device_info,
    unpack_device_parameters,
    unpack_notice,
    unpack_set_stream_response,
    unpack_start_capture_response,
    unpack_telemetry,
)
from .simulator import SimulatedTransport
from .transport import ByteTransport, SerialTransport


_UINT64_MASK = (1 << 64) - 1
_SAFE_RETRY_COMMANDS = frozenset((Command.GET_INFO, Command.GET_PARAMS, Command.SET_STREAM))
_LOGGER = logging.getLogger(__name__)
_OPERATION_LABELS = {
    "read_info": "读取设备信息", "read_parameters": "读取参数",
    "write_readback": "写后回读", "enable_stream": "开启实时数据",
    "start_capture": "开始采集", "cancel_capture": "取消采集",
    "write_parameters": "写入参数", "reset_parameters": "恢复参数",
}


class _CaptureIdGenerator:
    """Emit a full-cycle permutation of nonzero uint64 values without history."""

    def __init__(self, *, state: int | None = None, increment: int | None = None) -> None:
        if state is None:
            state = secrets.randbits(64)
        if increment is None:
            increment = secrets.randbits(64) | 1
        if type(state) is not int or not 0 <= state <= _UINT64_MASK:
            raise ValueError("state must be a uint64")
        if (
            type(increment) is not int
            or not 1 <= increment <= _UINT64_MASK
            or increment % 2 == 0
        ):
            raise ValueError("increment must be an odd nonzero uint64")
        self._state = state
        self._increment = increment
        self._lock = threading.Lock()

    def __call__(self) -> int:
        with self._lock:
            while True:
                self._state = (self._state + self._increment) & _UINT64_MASK
                if self._state != 0:
                    return self._state


@dataclass(frozen=True)
class ControllerEvent:
    kind: str
    data: Any = None
    sequence: int | None = None
    message: str = ""


@dataclass
class _PendingRequest:
    generation: int
    command: int
    sequence: int
    deadline: float
    operation: str
    context: dict[str, Any]
    frame: bytes
    started_at: float
    final_deadline: float
    retries: int = 0
    recovering: bool = False


@dataclass(frozen=True)
class _ActiveCapture:
    generation: int
    point_id: int
    capture_id: int
    request_sequence: int


@dataclass(frozen=True)
class _WriteTicket:
    generation: int
    transport: ByteTransport
    pending: _PendingRequest
    frame: bytes


class CalibrationController:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        request_timeout_s: float = 5.0,
        read_retry_count: int = 2,
        capture_start_grace_s: float = 10.0,
        sequence_start: int = 1,
        master_profile: MasterProfile | None = None,
        capture_id_factory: Callable[[], int] | None = None,
        serial_transport_factory: Callable[[str, int, Callable[[Exception], None]], ByteTransport] | None = None,
        simulator_factory: Callable[[], ByteTransport] | None = None,
    ) -> None:
        if request_timeout_s <= 0 or not math.isfinite(request_timeout_s):
            raise ValueError("request_timeout_s must be positive and finite")
        if type(read_retry_count) is not int or not 0 <= read_retry_count <= 5:
            raise ValueError("read_retry_count must be an integer from 0 to 5")
        if capture_start_grace_s < 0 or not math.isfinite(capture_start_grace_s):
            raise ValueError("capture_start_grace_s must be nonnegative and finite")
        if type(sequence_start) is not int or not 1 <= sequence_start <= 0xFFFF:
            raise ValueError("sequence_start must be a nonzero uint16")
        if capture_id_factory is not None and not callable(capture_id_factory):
            raise TypeError("capture_id_factory must be callable")
        self._clock = clock
        self._request_timeout_s = float(request_timeout_s)
        self._read_retry_count = read_retry_count
        self._capture_start_grace_s = float(capture_start_grace_s)
        self._sequence_start = sequence_start
        self._next_sequence = sequence_start
        self._master_profile = master_profile or MasterProfile()
        if capture_id_factory is None:
            self._capture_id_factory = _CaptureIdGenerator()
            self._custom_issued_capture_ids: set[int] | None = None
        else:
            self._capture_id_factory = capture_id_factory
            # Only the explicitly injected path retains history so deterministic
            # and custom factories still fail loudly if they repeat an ID.
            self._custom_issued_capture_ids = set()
        self._serial_factory = serial_transport_factory or self._make_serial_transport
        self._simulator_factory = simulator_factory or SimulatedTransport
        self._state_lock = threading.RLock()
        self._pending: dict[int, _PendingRequest] = {}
        self._events: queue.Queue[ControllerEvent] = queue.Queue()
        self._transport: ByteTransport | None = None
        self._connecting = False
        self._connected = False
        self._generation = 0
        self._active_capture: _ActiveCapture | None = None
        self._session = CalibrationSession(self._master_profile)

    def connect_serial(self, port: str, baudrate: int) -> None:
        if not isinstance(port, str) or not port:
            raise ValueError("port must be a nonempty string")
        if type(baudrate) is not int or baudrate <= 0:
            raise ValueError("baudrate must be a positive integer")
        generation = self._begin_connection()
        try:
            transport = self._serial_factory(port, baudrate, self._error_handler(generation))
        except Exception as error:
            self._fail_connection(generation, None, error)
            raise
        self._finish_connection(transport, generation, {"mode": "serial", "port": port, "baudrate": baudrate})

    def connect_simulator(self) -> None:
        generation = self._begin_connection()
        try:
            transport = self._simulator_factory()
        except Exception as error:
            self._fail_connection(generation, None, error)
            raise
        self._finish_connection(transport, generation, {"mode": "simulator"})

    def disconnect(self) -> None:
        with self._state_lock:
            if not self._connected and not self._connecting and self._transport is None:
                return
            transport = self._transport
            self._transport = None
            self._connecting = False
            self._connected = False
            self._generation += 1
            self._active_capture = None
            pending = tuple(self._pending.values())
            self._pending.clear()
            for request in pending:
                if request.operation == "heartbeat":
                    continue
                public_sequence = self._public_sequence(request)
                details = {"operation": request.operation, "reason": "disconnected"}
                if public_sequence != request.sequence:
                    details["request_sequence"] = request.sequence
                self._emit(
                    "error",
                    details,
                    public_sequence,
                    "request failed because the transport disconnected",
                )
            self._emit("disconnected")
        if transport is not None:
            transport.close()

    def read_info(self) -> int:
        return self._send_request(Command.GET_INFO, b"", "read_info")

    def read_parameters(self) -> int:
        return self._send_request(Command.GET_PARAMS, b"", "read_parameters")

    def write_parameters(self, slope_k: float, offset_b: float) -> int:
        payload = pack_set_params_request(slope_k, offset_b)
        return self._send_request(
            Command.SET_PARAMS,
            payload,
            "write_parameters",
            {"slope_k": float(slope_k), "offset_b": float(offset_b)},
        )

    def reset_parameters(self) -> int:
        return self._send_request(Command.RESET_PARAMS, b"", "reset_parameters")

    def start_capture(self, point_id: int) -> int:
        with self._state_lock:
            capture_id = self._capture_id_factory()
            payload = pack_start_capture_request(point_id, capture_id)
            issued_ids = self._custom_issued_capture_ids
            if issued_ids is not None and capture_id in issued_ids:
                raise ValueError("capture_id_factory must return a unique capture_id")
            ticket = self._register_request_locked(
                Command.START_CAPTURE,
                payload,
                "start_capture",
                {"point_id": point_id, "capture_id": capture_id},
            )
            if issued_ids is not None:
                issued_ids.add(capture_id)
        self._write_ticket(ticket)
        return ticket.pending.sequence

    def cancel_capture(self) -> int:
        return self._send_request(Command.CANCEL_CAPTURE, b"", "cancel_capture")
    def send_heartbeat(self) -> int:
        with self._state_lock:
            for request in self._pending.values():
                if (
                    request.generation == self._generation
                    and request.operation == "heartbeat"
                ):
                    return request.sequence
            ticket = self._register_request_locked(
                Command.HEARTBEAT,
                b"",
                "heartbeat",
            )
        self._write_ticket(ticket)
        return ticket.pending.sequence


    def poll_events(self) -> list[ControllerEvent]:
        with self._state_lock:
            transport = self._transport
        pump = getattr(transport, "pump", None)
        if callable(pump):
            pump()
        self._expire_requests()
        events = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except queue.Empty:
                return events

    def _begin_connection(self) -> int:
        self.disconnect()
        with self._state_lock:
            self._generation += 1
            generation = self._generation
            self._connecting = True
            self._connected = False
            self._next_sequence = self._sequence_start
            self._active_capture = None
            self._session = CalibrationSession(self._master_profile)
            self._pending.clear()
        return generation

    def _finish_connection(self, transport: ByteTransport, generation: int, metadata: dict[str, Any]) -> None:
        decoder = StreamDecoder()
        decoder_lock = threading.Lock()
        transport.set_receiver(
            lambda data: self._receive_bytes(generation, decoder, decoder_lock, data)
        )
        with self._state_lock:
            current = generation == self._generation and self._connecting
            if current:
                self._transport = transport
        if not current:
            transport.close()
            return
        try:
            transport.open()
        except Exception as error:
            self._fail_connection(generation, transport, error)
            raise
        stream_payload = pack_set_stream_request(True, 100)
        stream_context = {"enabled": True, "interval_ms": 100}
        stream_ticket = None
        with self._state_lock:
            current = (
                generation == self._generation
                and self._connecting
                and self._transport is transport
            )
            if current:
                self._connecting = False
                self._connected = True
                self._session = CalibrationSession(self._master_profile, connection_metadata=metadata)
                self._emit("connected", metadata)
                stream_ticket = self._register_request_locked(
                    Command.SET_STREAM,
                    stream_payload,
                    "enable_stream",
                    stream_context,
                )
        if not current:
            transport.close()
            return
        assert stream_ticket is not None
        self._write_ticket(stream_ticket)

    def _send_request(
        self,
        command: Command,
        payload: bytes,
        operation: str,
        context: dict[str, Any] | None = None,
    ) -> int:
        with self._state_lock:
            ticket = self._register_request_locked(command, payload, operation, context)
        self._write_ticket(ticket)
        return ticket.pending.sequence

    def _register_request_locked(
        self,
        command: Command,
        payload: bytes,
        operation: str,
        context: dict[str, Any] | None = None,
    ) -> _WriteTicket:
        if not self._connected or self._transport is None:
            raise RuntimeError("controller is not connected")
        transport = self._transport
        generation = self._generation
        sequence = self._allocate_sequence_locked()
        now = self._clock()
        frame = encode_frame(command, sequence, payload)
        budget = self._request_timeout_s
        if command in _SAFE_RETRY_COMMANDS:
            budget *= self._read_retry_count + 1
        elif command == Command.START_CAPTURE:
            budget += self._capture_start_grace_s
        pending = _PendingRequest(
            generation,
            int(command),
            sequence,
            now + self._request_timeout_s,
            operation,
            dict(context or {}),
            frame,
            now,
            now + budget,
        )
        self._pending[sequence] = pending
        return _WriteTicket(
            generation,
            transport,
            pending,
            frame,
        )

    def _write_ticket(self, ticket: _WriteTicket) -> None:
        with self._state_lock:
            if (
                ticket.generation != self._generation
                or self._pending.get(ticket.pending.sequence) is not ticket.pending
                or self._transport is not ticket.transport
            ):
                return
            _LOGGER.info(
                "TX_QUEUED operation=%s seq=%s attempt=%s age_ms=%.0f",
                ticket.pending.operation, ticket.pending.sequence,
                ticket.pending.retries + 1,
                (self._clock() - ticket.pending.started_at) * 1000,
            )
        try:
            ticket.transport.write(ticket.frame)
            return
        except Exception as error:
            write_error = error

        close_transport = None
        with self._state_lock:
            pending = ticket.pending
            owns_failure = (
                pending.generation == ticket.generation
                and self._pending.get(pending.sequence) is pending
            )
            if not owns_failure:
                return
            del self._pending[pending.sequence]
            if (
                pending.operation == "enable_stream"
                and ticket.generation == self._generation
                and self._transport is ticket.transport
            ):
                self._emit(
                    "error",
                    {"operation": "connect", "reason": str(write_error)},
                    pending.sequence,
                    str(write_error),
                )
                close_transport = self._abort_connection_locked(ticket.generation, ticket.transport)
            elif pending.operation == "heartbeat":
                self._diagnostic(f"heartbeat write failed: {write_error}", pending.sequence)
            else:
                public_sequence = self._public_sequence(pending)
                details = {"operation": pending.operation, "reason": str(write_error)}
                if public_sequence != pending.sequence:
                    details["request_sequence"] = pending.sequence
                self._emit(
                    "error",
                    details,
                    public_sequence,
                    str(write_error),
                )
        if close_transport is not None:
            close_transport.close()

    def _allocate_sequence_locked(self) -> int:
        for _ in range(0xFFFF):
            candidate = self._next_sequence
            self._next_sequence = 1 if candidate == 0xFFFF else candidate + 1
            if candidate not in self._pending:
                return candidate
        raise RuntimeError("sequence space exhausted")

    def _receive_bytes(
        self,
        generation: int,
        decoder: StreamDecoder,
        decoder_lock: threading.Lock,
        data: bytes,
    ) -> None:
        try:
            with decoder_lock:
                before = tuple(getattr(decoder, name, 0) for name in ("crc_errors", "length_errors", "version_errors"))
                frames = decoder.feed(data)
                after = tuple(getattr(decoder, name, 0) for name in ("crc_errors", "length_errors", "version_errors"))
                if before != after:
                    _LOGGER.warning("RX_REJECTED generation=%s crc=%s length=%s version=%s bytes=%s",
                                    generation, *after, data.hex())
        except Exception as error:
            with self._state_lock:
                if generation == self._generation and self._connected:
                    self._diagnostic(f"decoder rejected bytes: {error}")
            return
        for frame in frames:
            self._handle_frame(generation, frame)

    def _handle_frame(self, generation: int, frame: Frame) -> None:
        if frame.command != Command.TELEMETRY:
            _LOGGER.info("RX_FRAME generation=%s command=0x%02x seq=%s payload=%s",
                         generation, frame.command, frame.sequence, frame.payload.hex())
        if frame.command >= 0x80:
            self._handle_response(generation, frame)
        elif frame.command in (Command.TELEMETRY, Command.CAPTURE_PROGRESS, Command.CAPTURE_RESULT, Command.NOTICE):
            self._handle_async_event(generation, frame)
        else:
            with self._state_lock:
                if generation == self._generation and self._connected:
                    self._diagnostic(f"unknown device frame command 0x{frame.command:02X}", frame.sequence)

    def _handle_response(self, generation: int, frame: Frame) -> None:
        followup = None
        with self._state_lock:
            if generation != self._generation or not self._connected:
                return
            pending = self._pending.get(frame.sequence)
            if pending is None:
                self._diagnostic("stale or unknown response sequence", frame.sequence)
                return
            if pending.generation != generation:
                return
            if frame.command != response_command(pending.command):
                self._diagnostic("response command does not match pending request", frame.sequence)
                return
            _LOGGER.info(
                "RX operation=%s seq=%s age_ms=%.0f",
                pending.operation, pending.sequence,
                (self._clock() - pending.started_at) * 1000,
            )
            if self._clock() >= pending.final_deadline:
                del self._pending[pending.sequence]
                self._finish_timeout_locked(pending)
                return

            if pending.command == Command.START_CAPTURE:
                self._handle_start_capture_response_locked(pending, frame.payload)
                return

            if not frame.payload:
                del self._pending[pending.sequence]
                self._finish_malformed_response_locked(pending, "response payload is missing status")
                return
            try:
                status = Status(frame.payload[0])
            except ValueError:
                del self._pending[pending.sequence]
                self._finish_malformed_response_locked(pending, "response contains unknown status")
                return
            if status is not Status.OK:
                del self._pending[pending.sequence]
                self._finish_status_error_locked(pending, status)
                return
            try:
                decoded = self._decode_success_response(pending.command, frame.payload)
            except (TypeError, ValueError) as error:
                del self._pending[pending.sequence]
                self._finish_malformed_response_locked(
                    pending,
                    f"malformed response payload: {error}",
                )
                return
            del self._pending[pending.sequence]
            followup = self._complete_request_locked(pending, decoded)
        if followup is not None:
            self._write_ticket(followup)

    def _decode_success_response(self, command: int, payload: bytes):
        if command == Command.GET_INFO:
            return unpack_device_info(payload)
        if command in (Command.GET_PARAMS, Command.SET_PARAMS, Command.RESET_PARAMS):
            return unpack_device_parameters(payload)
        if command in (Command.CANCEL_CAPTURE, Command.HEARTBEAT):
            if len(payload) != 1:
                raise ValueError("payload length must be exactly 1")
            return Status(payload[0])
        if command == Command.SET_STREAM:
            return unpack_set_stream_response(payload)
        raise ValueError("unexpected response command")

    def _handle_start_capture_response_locked(
        self,
        pending: _PendingRequest,
        payload: bytes,
    ) -> None:
        try:
            decoded = unpack_start_capture_response(payload)
        except (TypeError, ValueError) as error:
            self._diagnostic(
                f"uncorrelated capture start response retained pending request: {error}",
                pending.sequence,
            )
            return

        expected_identity = (
            pending.context["point_id"],
            pending.context["capture_id"],
        )
        actual_identity = (decoded[1], decoded[2])
        if actual_identity != expected_identity:
            self._diagnostic(
                "capture start identity mismatch: "
                f"expected point {expected_identity[0]} capture_id {expected_identity[1]}, "
                f"received point {actual_identity[0]} capture_id {actual_identity[1]}",
                pending.sequence,
            )
            return

        del self._pending[pending.sequence]
        if decoded[0] is not Status.OK:
            self._finish_status_error_locked(pending, decoded[0])
            return
        self._complete_request_locked(pending, decoded)

    def _finish_status_error_locked(self, pending: _PendingRequest, status: Status) -> None:
        self._record_parameter_failure_if_needed(pending, status.name)
        if pending.operation == "heartbeat":
            self._diagnostic(f"heartbeat failed: {status.name}", pending.sequence)
            return
        public_sequence = self._public_sequence(pending)
        details = {"operation": pending.operation, "status": status, "reason": status.name}
        if public_sequence != pending.sequence:
            details["request_sequence"] = pending.sequence
        self._emit(
            "error",
            details,
            public_sequence,
            f"{pending.operation} failed: {status.name}",
        )

    def _complete_request_locked(self, pending: _PendingRequest, decoded: Any) -> _WriteTicket | None:
        if pending.command == Command.GET_INFO:
            self._session.device_id = decoded.device_id
            self._emit("info", decoded, pending.sequence)
        elif pending.command == Command.GET_PARAMS:
            if "write_verify" in pending.context:
                self._verify_write_readback(pending, decoded)
            else:
                self._session.record_parameter_operation("read", "ok", self._parameter_details(decoded))
                self._emit("parameters", decoded, pending.sequence)
        elif pending.command == Command.SET_PARAMS:
            verification = {
                "slope_k": pending.context["slope_k"],
                "offset_b": pending.context["offset_b"],
                "param_version": decoded.param_version,
                "params_valid": True,
                "cal_dew_valid": False,
                "origin_sequence": pending.sequence,
            }
            return self._register_request_locked(
                Command.GET_PARAMS,
                b"",
                "write_readback",
                {"write_verify": verification},
            )
        elif pending.command == Command.RESET_PARAMS:
            if decoded.cal_dew_valid or not decoded.params_valid or decoded.slope_k != 1.0 or decoded.offset_b != 0.0:
                self._session.record_parameter_operation("reset", "error", self._parameter_details(decoded))
                self._emit("error", {"operation": "reset_parameters", "reason": "reset readback mismatch"}, pending.sequence)
            else:
                self._session.record_parameter_operation("reset", "ok", self._parameter_details(decoded))
                self._emit("reset", decoded, pending.sequence)
        elif pending.command == Command.START_CAPTURE:
            self._active_capture = _ActiveCapture(
                pending.generation,
                decoded[1],
                decoded[2],
                pending.sequence,
            )
            self._emit(
                "capture_started",
                {"point_id": decoded[1], "capture_id": decoded[2]},
                pending.sequence,
            )
        elif pending.command == Command.CANCEL_CAPTURE:
            self._emit("capture_cancelled", sequence=pending.sequence)
        elif pending.command == Command.SET_STREAM:
            expected = (pending.context["enabled"], pending.context["interval_ms"])
            actual = (decoded[1], decoded[2])
            if actual != expected:
                self._emit(
                    "error",
                    {
                        "operation": pending.operation,
                        "reason": "stream response mismatch",
                        "expected": expected,
                        "actual": actual,
                    },
                    pending.sequence,
                )
            else:
                self._emit(
                    "stream_configured",
                    {"enabled": decoded[1], "interval_ms": decoded[2]},
                    pending.sequence,
                )
        elif pending.command == Command.HEARTBEAT:
            self._emit("heartbeat", sequence=pending.sequence)
        return None

    def _verify_write_readback(self, pending: _PendingRequest, parameters: DeviceParameters) -> None:
        expected = pending.context["write_verify"]
        matches = (
            abs(parameters.slope_k - expected["slope_k"]) <= 1e-6
            and abs(parameters.offset_b - expected["offset_b"]) <= 1e-6
            and parameters.param_version == expected["param_version"]
            and parameters.params_valid is expected["params_valid"]
            and parameters.cal_dew_valid is expected["cal_dew_valid"]
        )
        if matches:
            self._session.record_parameter_operation("write", "verified", self._parameter_details(parameters))
            self._emit("write_verified", parameters, expected["origin_sequence"])
        else:
            details = {
                "reason": "readback mismatch",
                "expected": expected,
                "actual": self._parameter_details(parameters),
            }
            self._session.record_parameter_operation("write", "error", details)
            self._emit("error", details, expected["origin_sequence"], "parameter readback mismatch")

    def _handle_async_event(self, generation: int, frame: Frame) -> None:
        with self._state_lock:
            if generation != self._generation or not self._connected:
                return
            try:
                if frame.command == Command.TELEMETRY:
                    telemetry = unpack_telemetry(frame.payload)
                    self._session.record_telemetry(telemetry)
                    self._emit("telemetry", telemetry, frame.sequence)
                elif frame.command == Command.CAPTURE_PROGRESS:
                    self._record_capture_progress(
                        unpack_capture_progress(frame.payload),
                        frame.sequence,
                        generation,
                    )
                elif frame.command == Command.CAPTURE_RESULT:
                    self._record_capture_result(
                        unpack_capture_result(frame.payload),
                        frame.sequence,
                        generation,
                    )
                elif frame.command == Command.NOTICE:
                    self._emit("notice", unpack_notice(frame.payload), frame.sequence)
            except (TypeError, ValueError) as error:
                self._diagnostic(f"malformed asynchronous payload: {error}", frame.sequence)

    def _record_capture_progress(self, progress, sequence: int, generation: int) -> None:
        if progress.point_id not in range(4):
            raise ValueError("capture progress point_id is out of range")
        if progress.stddev_rh_raw < 0:
            raise ValueError("capture progress stddev_rh_raw must be nonnegative")
        self._recover_capture_from_event(progress, generation)
        active = self._active_capture
        if active is None or active.generation != generation:
            self._diagnostic("ignored capture progress without an active capture", sequence)
            return
        if progress.point_id != active.point_id:
            self._diagnostic(
                f"ignored capture progress point mismatch: active {active.point_id}, "
                f"progress {progress.point_id}",
                sequence,
            )
            return
        if progress.capture_id != active.capture_id:
            self._diagnostic(
                f"ignored capture progress capture_id mismatch: active {active.capture_id}, "
                f"progress {progress.capture_id}",
                sequence,
            )
            return
        self._emit("capture_progress", progress, sequence)

    def _record_capture_result(self, result, sequence: int, generation: int) -> None:
        names = {0: "stable", 1: "timeout", 2: "cancelled", 3: "sensor_error"}
        if result.point_id not in range(4):
            raise ValueError("capture result point_id is out of range")
        if result.result_code not in names:
            raise ValueError("unknown capture result code")
        if result.stddev_rh_raw < 0:
            raise ValueError("capture result stddev_rh_raw must be nonnegative")
        run = CaptureRun(
            result.point_id,
            result.mean_rh_raw,
            result.mean_rh_corrected,
            result.stddev_rh_raw,
            result.sample_count,
            result.elapsed_ms,
            names[result.result_code],
        )
        self._recover_capture_from_event(result, generation)
        active = self._active_capture
        if active is None or active.generation != generation:
            self._diagnostic("ignored capture result without an active capture", sequence)
            return
        if run.point_id != active.point_id:
            self._diagnostic(
                f"ignored capture result point mismatch: active {active.point_id}, result {run.point_id}",
                sequence,
            )
            return
        if result.capture_id != active.capture_id:
            self._diagnostic(
                f"ignored capture result capture_id mismatch: active {active.capture_id}, "
                f"result {result.capture_id}",
                sequence,
            )
            return
        self._active_capture = None
        self._session.record_capture(run)
        self._emit("capture_result", run, sequence)
        if run.result_code == "stable":
            accepted = self._session.accepted_runs_by_point
            if all(len(accepted[point_id]) >= 3 for point_id in range(4)):
                means = self._session.device_point_means()
                report = calculate_report(self._session.master_profile.rh, means)
                self._session.set_report(report)
                self._emit("report", report, sequence)

    def _recover_capture_from_event(self, event, generation: int) -> None:
        """A fresh matching capture ID proves acceptance even if its ACK was lost."""
        if self._active_capture is not None:
            return
        for pending in tuple(self._pending.values()):
            if (
                pending.command == Command.START_CAPTURE
                and pending.generation == generation
                and pending.context["point_id"] == event.point_id
                and pending.context["capture_id"] == event.capture_id
                and self._clock() < pending.final_deadline
            ):
                del self._pending[pending.sequence]
                self._diagnostic("已通过匹配的采集 ID 确认设备正在采集", pending.sequence)
                self._complete_request_locked(
                    pending, (Status.OK, event.point_id, event.capture_id),
                )
                return

    def _expire_requests(self) -> None:
        tickets = []
        with self._state_lock:
            now = self._clock()
            expired = [
                request
                for request in self._pending.values()
                if request.generation == self._generation and request.deadline <= now
            ]
            for request in expired:
                if self._pending.get(request.sequence) is not request or request.generation != self._generation:
                    continue
                if now < request.final_deadline:
                    if request.command in _SAFE_RETRY_COMMANDS and request.retries < self._read_retry_count:
                        request.retries += 1
                        request.deadline = min(now + self._request_timeout_s, request.final_deadline)
                        assert self._transport is not None
                        tickets.append(_WriteTicket(request.generation, self._transport, request, request.frame))
                        self._emit(
                            "request_retry",
                            {"operation": request.operation, "attempt": request.retries + 1},
                            self._public_sequence(request),
                            f"{_OPERATION_LABELS.get(request.operation, request.operation)}应答未到，自动重试 {request.retries}/{self._read_retry_count}",
                        )
                        continue
                    if request.command == Command.START_CAPTURE and not request.recovering:
                        request.recovering = True
                        request.deadline = request.final_deadline
                        self._emit(
                            "capture_recovering",
                            {"point_id": request.context["point_id"]},
                            request.sequence,
                            "采集确认应答未到，正在等待对应采集进度或结果",
                        )
                        continue
                self._pending.pop(request.sequence, None)
                self._finish_timeout_locked(request)
        for ticket in tickets:
            self._write_ticket(ticket)

    def _finish_timeout_locked(self, request: _PendingRequest) -> None:
        self._record_parameter_failure_if_needed(request, "timeout")
        origin_sequence = self._public_sequence(request)
        if request.operation == "heartbeat":
            self._diagnostic("心跳应答超时；实时数据更新不代表命令应答正常", request.sequence)
            return
        uncertain = request.command == Command.START_CAPTURE
        label = _OPERATION_LABELS.get(request.operation, request.operation)
        message = (
            "开始采集未确认，请先取消当前采集后重试"
            if uncertain else f"{label}应答超时，请检查设备通信"
        )
        _LOGGER.warning("TIMEOUT operation=%s seq=%s age_ms=%.0f retries=%s",
                        request.operation, request.sequence,
                        (self._clock() - request.started_at) * 1000, request.retries)
        self._emit(
            "request_timeout",
            {
                "operation": request.operation,
                "reason": "timeout",
                "request_sequence": request.sequence,
                "capture_uncertain": uncertain,
            },
            origin_sequence,
            message,
        )

    def _finish_malformed_response_locked(self, request: _PendingRequest, reason: str) -> None:
        self._diagnostic(reason, request.sequence)
        self._record_parameter_failure_if_needed(request, reason)
        public_sequence = self._public_sequence(request)
        if request.operation == "heartbeat":
            return
        details = {"operation": request.operation, "reason": "malformed response"}
        if public_sequence != request.sequence:
            details["request_sequence"] = request.sequence
        self._emit(
            "error",
            details,
            public_sequence,
            reason,
        )

    def _error_handler(self, generation: int) -> Callable[[Exception], None]:
        return lambda error: self._transport_error(generation, error)

    def _fail_connection(
        self,
        generation: int,
        transport: ByteTransport | None,
        error: Exception,
    ) -> None:
        close_transport = transport
        with self._state_lock:
            current = (
                generation == self._generation
                and self._connecting
                and (transport is None or self._transport is transport)
            )
            if current:
                self._emit("error", {"operation": "connect", "reason": str(error)}, message=str(error))
                close_transport = self._abort_connection_locked(generation, transport)
        if close_transport is not None:
            close_transport.close()

    def _transport_error(self, generation: int, error: Exception) -> None:
        message = self._describe_transport_error(error)
        with self._state_lock:
            if generation != self._generation or not (self._connecting or self._connected):
                return
            transport = self._abort_connection_locked(
                generation,
                self._transport,
                skip_pending_operation="enable_stream",
            )
            # Emit the root transport failure after derived pending-request and
            # disconnect events so the UI does not overwrite it with the less
            # useful "request failed because ... disconnected" message.
            self._emit(
                "error",
                {"operation": "transport", "reason": message},
                message=message,
            )
        if transport is not None:
            transport.close()

    @staticmethod
    def _describe_transport_error(error: Exception) -> str:
        detail = str(error).strip() or type(error).__name__
        if (
            type(error).__name__ == "SerialTimeoutException"
            or "write timeout" in detail.lower()
        ):
            return (
                "串口写入超时：设备未响应结构化协议。"
                "请确认已烧录本项目配套固件，并关闭占用该 COM 口的其他串口工具。"
            )
        return f"串口通信中断：{detail}"

    def _abort_connection_locked(
        self,
        generation: int,
        transport: ByteTransport | None,
        *,
        skip_pending_operation: str | None = None,
    ) -> ByteTransport | None:
        if generation != self._generation:
            return None
        close_transport = self._transport if self._transport is not None else transport
        self._transport = None
        self._connecting = False
        self._connected = False
        self._generation += 1
        self._active_capture = None
        pending = tuple(self._pending.values())
        self._pending.clear()
        for request in pending:
            if request.operation == skip_pending_operation:
                continue
            public_sequence = self._public_sequence(request)
            if request.operation == "heartbeat":
                continue
            details = {"operation": request.operation, "reason": "disconnected"}
            if public_sequence != request.sequence:
                details["request_sequence"] = request.sequence
            self._emit(
                "error",
                details,
                public_sequence,
                "request failed because the transport disconnected",
            )
        self._emit("disconnected")
        return close_transport

    def _record_parameter_failure_if_needed(self, pending: _PendingRequest, reason: str) -> None:
        if pending.command in (Command.GET_PARAMS, Command.SET_PARAMS, Command.RESET_PARAMS):
            self._session.record_parameter_operation(pending.operation, "error", {"reason": reason})

    @staticmethod
    def _public_sequence(request: _PendingRequest) -> int:
        verification = request.context.get("write_verify")
        if isinstance(verification, dict):
            origin_sequence = verification.get("origin_sequence")
            if type(origin_sequence) is int and 1 <= origin_sequence <= 0xFFFF:
                return origin_sequence
        return request.sequence

    def _diagnostic(self, message: str, sequence: int | None = None) -> None:
        _LOGGER.info("DIAGNOSTIC seq=%s %s", sequence, message)
        self._emit("diagnostic", {"reason": message}, sequence, message)

    def _emit(self, kind: str, data: Any = None, sequence: int | None = None, message: str = "") -> None:
        self._events.put(ControllerEvent(kind, data, sequence, message))

    @staticmethod
    def _parameter_details(parameters: DeviceParameters) -> dict[str, Any]:
        return {
            "param_version": parameters.param_version,
            "params_valid": parameters.params_valid,
            "cal_dew_valid": parameters.cal_dew_valid,
            "slope_k": parameters.slope_k,
            "offset_b": parameters.offset_b,
            "cal_dew": parameters.cal_dew,
        }

    @staticmethod
    def _make_serial_transport(port: str, baudrate: int, error_callback: Callable[[Exception], None]) -> ByteTransport:
        return SerialTransport(port, baudrate, error_callback=error_callback)
