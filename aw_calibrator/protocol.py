"""Version 1 framed binary protocol for the water-activity calibrator."""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import math
import struct


_HEADER = b"\xA5\x5A"
_VERSION = 1
_MIN_BODY_LENGTH = 4
_MAX_BODY_LENGTH = 132
_FRAME_PREFIX = struct.Struct("<HBBH")
_U16 = struct.Struct("<H")
_SET_PARAMS = struct.Struct("<ff")
_DEVICE_PARAMETERS = struct.Struct("<BHBBfff")
_START_CAPTURE_REQUEST = struct.Struct("<BQ")
_START_CAPTURE_RESPONSE = struct.Struct("<BBQ")
_SET_STREAM_REQUEST = struct.Struct("<BH")
_SET_STREAM_RESPONSE = struct.Struct("<BBH")
_TELEMETRY = struct.Struct("<BIfffff")
_CAPTURE_PROGRESS = struct.Struct("<BQHIff")
_CAPTURE_RESULT = struct.Struct("<BBQHIfff")


class Command(IntEnum):
    """Locked request and asynchronous-event command identifiers."""

    GET_INFO = 0x01
    GET_PARAMS = 0x02
    SET_PARAMS = 0x03
    RESET_PARAMS = 0x04
    START_CAPTURE = 0x05
    CANCEL_CAPTURE = 0x06
    SET_STREAM = 0x07
    HEARTBEAT = 0x08
    TELEMETRY = 0x40
    CAPTURE_PROGRESS = 0x41
    CAPTURE_RESULT = 0x42
    NOTICE = 0x43


class Status(IntEnum):
    """Locked status byte used at the start of every response payload."""

    OK = 0
    UNKNOWN_COMMAND = 1
    BAD_LENGTH = 2
    INVALID_PARAMETER = 3
    BUSY = 4
    SENSOR_UNAVAILABLE = 5
    CAPTURE_TIMEOUT = 6
    STORAGE_ERROR = 7
    INTERNAL_ERROR = 8


@dataclass(frozen=True)
class Frame:
    command: int
    sequence: int
    payload: bytes
    version: int = _VERSION


@dataclass(frozen=True)
class DeviceInfo:
    status: Status
    device_id: str
    firmware_version: str


@dataclass(frozen=True)
class DeviceParameters:
    """Wire parameters; ``param_version`` is the fixed NVS record schema version."""

    status: Status
    param_version: int
    params_valid: bool
    cal_dew_valid: bool
    slope_k: float
    offset_b: float
    cal_dew: float


@dataclass(frozen=True)
class Telemetry:
    flags: int
    sample_sequence: int
    temperature_c: float
    humidity_raw: float
    humidity_corrected: float
    aw_unclamped: float
    aw_final: float


@dataclass(frozen=True)
class CaptureProgress:
    point_id: int
    capture_id: int
    sample_count: int
    elapsed_ms: int
    mean_rh_raw: float
    stddev_rh_raw: float


@dataclass(frozen=True)
class CaptureResult:
    point_id: int
    result_code: int
    capture_id: int
    sample_count: int
    elapsed_ms: int
    mean_rh_raw: float
    mean_rh_corrected: float
    stddev_rh_raw: float


@dataclass(frozen=True)
class Notice:
    notice_code: int


def crc16_ccitt_false(data: bytes) -> int:
    """Return the CRC16-CCITT-FALSE checksum for *data*."""

    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def encode_frame(command: int, sequence: int, payload: bytes = b"") -> bytes:
    """Encode one version-1 frame using explicit little-endian fields."""

    _check_uint(command, 8, "command")
    _check_uint(sequence, 16, "sequence")
    if not isinstance(payload, bytes):
        raise TypeError("payload must be bytes")
    body_length = _MIN_BODY_LENGTH + len(payload)
    if not _MIN_BODY_LENGTH <= body_length <= _MAX_BODY_LENGTH:
        raise ValueError("body length must be between 4 and 132")
    body = _FRAME_PREFIX.pack(body_length, _VERSION, command, sequence) + payload
    return _HEADER + body + _U16.pack(crc16_ccitt_false(body))


class StreamDecoder:
    """Incrementally decode frames while retaining the minimum recovery data."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self.crc_errors = 0
        self.length_errors = 0
        self.version_errors = 0

    def feed(self, data: bytes) -> list[Frame]:
        if not isinstance(data, bytes):
            raise TypeError("data must be bytes")
        self._buffer.extend(data)
        frames: list[Frame] = []
        while True:
            header_index = self._buffer.find(_HEADER)
            if header_index < 0:
                if self._buffer[-1:] == _HEADER[:1]:
                    del self._buffer[:-1]
                else:
                    self._buffer.clear()
                return frames
            if header_index:
                del self._buffer[:header_index]
            if len(self._buffer) < 4:
                return frames

            body_length = _U16.unpack_from(self._buffer, 2)[0]
            if not _MIN_BODY_LENGTH <= body_length <= _MAX_BODY_LENGTH:
                self.length_errors += 1
                del self._buffer[0]
                continue

            frame_length = 2 + 2 + body_length + 2
            if len(self._buffer) < frame_length:
                return frames
            body_end = 4 + body_length
            expected_crc = _U16.unpack_from(self._buffer, body_end)[0]
            actual_crc = crc16_ccitt_false(bytes(self._buffer[2:body_end]))
            if actual_crc != expected_crc:
                self.crc_errors += 1
                del self._buffer[0]
                continue

            version = self._buffer[4]
            if version != _VERSION:
                self.version_errors += 1
                del self._buffer[0]
                continue
            command = self._buffer[5]
            sequence = _U16.unpack_from(self._buffer, 6)[0]
            payload = bytes(self._buffer[8:body_end])
            frames.append(Frame(command, sequence, payload, version))
            del self._buffer[:frame_length]


def pack_device_info(value: DeviceInfo) -> bytes:
    return bytes((_pack_status(value.status),)) + _pack_text(value.device_id, 20) + _pack_text(value.firmware_version, 16)


def unpack_device_info(payload: bytes) -> DeviceInfo:
    _require_length(payload, 37)
    return DeviceInfo(_unpack_status(payload[0]), _unpack_text(payload[1:21]), _unpack_text(payload[21:37]))


def pack_device_parameters(value: DeviceParameters) -> bytes:
    _check_uint(value.param_version, 16, "param_version")
    _check_bool(value.params_valid, "params_valid")
    _check_bool(value.cal_dew_valid, "cal_dew_valid")
    _require_finite(value.slope_k, "slope_k")
    _require_finite(value.offset_b, "offset_b")
    _require_finite(value.cal_dew, "cal_dew")
    return _DEVICE_PARAMETERS.pack(
        _pack_status(value.status),
        value.param_version,
        int(value.params_valid),
        int(value.cal_dew_valid),
        value.slope_k,
        value.offset_b,
        value.cal_dew,
    )


def unpack_device_parameters(payload: bytes) -> DeviceParameters:
    _require_length(payload, _DEVICE_PARAMETERS.size)
    status, version, params_valid, cal_dew_valid, slope_k, offset_b, cal_dew = _DEVICE_PARAMETERS.unpack(payload)
    _require_flag(params_valid, "params_valid")
    _require_flag(cal_dew_valid, "cal_dew_valid")
    _require_finite(slope_k, "slope_k")
    _require_finite(offset_b, "offset_b")
    _require_finite(cal_dew, "cal_dew")
    return DeviceParameters(_unpack_status(status), version, bool(params_valid), bool(cal_dew_valid), slope_k, offset_b, cal_dew)


def pack_set_params_response(value: DeviceParameters) -> bytes:
    """Encode the locked SET_PARAMS response payload."""

    return pack_device_parameters(value)


def unpack_set_params_response(payload: bytes) -> DeviceParameters:
    """Decode the locked SET_PARAMS response payload."""

    return unpack_device_parameters(payload)


def pack_reset_params_response(value: DeviceParameters) -> bytes:
    """Encode the locked RESET_PARAMS response payload."""

    return pack_device_parameters(value)


def unpack_reset_params_response(payload: bytes) -> DeviceParameters:
    """Decode the locked RESET_PARAMS response payload."""

    return unpack_device_parameters(payload)


def pack_set_params_request(slope_k: float, offset_b: float) -> bytes:
    _require_finite(slope_k, "slope_k")
    _require_finite(offset_b, "offset_b")
    return _SET_PARAMS.pack(slope_k, offset_b)


def unpack_set_params_request(payload: bytes) -> tuple[float, float]:
    _require_length(payload, _SET_PARAMS.size)
    slope_k, offset_b = _SET_PARAMS.unpack(payload)
    _require_finite(slope_k, "slope_k")
    _require_finite(offset_b, "offset_b")
    return slope_k, offset_b


def pack_start_capture_request(point_id: int, capture_id: int) -> bytes:
    _check_uint(point_id, 8, "point_id")
    _check_nonzero_uint(capture_id, 64, "capture_id")
    return _START_CAPTURE_REQUEST.pack(point_id, capture_id)


def unpack_start_capture_request(payload: bytes) -> tuple[int, int]:
    _require_length(payload, _START_CAPTURE_REQUEST.size)
    point_id, capture_id = _START_CAPTURE_REQUEST.unpack(payload)
    _check_nonzero_uint(capture_id, 64, "capture_id")
    return point_id, capture_id


def pack_start_capture_response(status: Status, point_id: int, capture_id: int) -> bytes:
    """Encode a correlated START response for either OK or an error status."""

    _check_uint(point_id, 8, "point_id")
    _check_nonzero_uint(capture_id, 64, "capture_id")
    return _START_CAPTURE_RESPONSE.pack(_pack_status(status), point_id, capture_id)


def unpack_start_capture_response(payload: bytes) -> tuple[Status, int, int]:
    """Decode the mandatory ten-byte correlated START response schema."""

    _require_length(payload, _START_CAPTURE_RESPONSE.size)
    status, point_id, capture_id = _START_CAPTURE_RESPONSE.unpack(payload)
    _check_nonzero_uint(capture_id, 64, "capture_id")
    return _unpack_status(status), point_id, capture_id


def pack_cancel_capture_response(status: Status) -> bytes:
    return bytes((_pack_status(status),))


def unpack_cancel_capture_response(payload: bytes) -> Status:
    _require_length(payload, 1)
    return _unpack_status(payload[0])


def pack_set_stream_request(enabled: bool, interval_ms: int) -> bytes:
    _check_bool(enabled, "enabled")
    _check_uint(interval_ms, 16, "interval_ms")
    return _SET_STREAM_REQUEST.pack(int(enabled), interval_ms)


def unpack_set_stream_request(payload: bytes) -> tuple[bool, int]:
    _require_length(payload, _SET_STREAM_REQUEST.size)
    enabled, interval_ms = _SET_STREAM_REQUEST.unpack(payload)
    _require_flag(enabled, "enabled")
    return bool(enabled), interval_ms


def pack_set_stream_response(status: Status, enabled: bool, interval_ms: int) -> bytes:
    _check_bool(enabled, "enabled")
    _check_uint(interval_ms, 16, "interval_ms")
    return _SET_STREAM_RESPONSE.pack(_pack_status(status), int(enabled), interval_ms)


def unpack_set_stream_response(payload: bytes) -> tuple[Status, bool, int]:
    _require_length(payload, _SET_STREAM_RESPONSE.size)
    status, enabled, interval_ms = _SET_STREAM_RESPONSE.unpack(payload)
    _require_flag(enabled, "enabled")
    return _unpack_status(status), bool(enabled), interval_ms


def pack_telemetry(value: Telemetry) -> bytes:
    _check_uint(value.flags, 8, "flags")
    _check_uint(value.sample_sequence, 32, "sample_sequence")
    _require_all_finite(value.temperature_c, value.humidity_raw, value.humidity_corrected, value.aw_unclamped, value.aw_final)
    return _TELEMETRY.pack(value.flags, value.sample_sequence, value.temperature_c, value.humidity_raw, value.humidity_corrected, value.aw_unclamped, value.aw_final)


def unpack_telemetry(payload: bytes) -> Telemetry:
    _require_length(payload, _TELEMETRY.size)
    values = _TELEMETRY.unpack(payload)
    _require_all_finite(*values[2:])
    return Telemetry(*values)


def pack_capture_progress(value: CaptureProgress) -> bytes:
    _check_uint(value.point_id, 8, "point_id")
    _check_nonzero_uint(value.capture_id, 64, "capture_id")
    _check_uint(value.sample_count, 16, "sample_count")
    _check_uint(value.elapsed_ms, 32, "elapsed_ms")
    _require_all_finite(value.mean_rh_raw, value.stddev_rh_raw)
    return _CAPTURE_PROGRESS.pack(
        value.point_id,
        value.capture_id,
        value.sample_count,
        value.elapsed_ms,
        value.mean_rh_raw,
        value.stddev_rh_raw,
    )


def unpack_capture_progress(payload: bytes) -> CaptureProgress:
    _require_length(payload, _CAPTURE_PROGRESS.size)
    values = _CAPTURE_PROGRESS.unpack(payload)
    _check_nonzero_uint(values[1], 64, "capture_id")
    _require_all_finite(*values[4:])
    return CaptureProgress(*values)


def pack_capture_result(value: CaptureResult) -> bytes:
    _check_uint(value.point_id, 8, "point_id")
    _check_uint(value.result_code, 8, "result_code")
    _check_nonzero_uint(value.capture_id, 64, "capture_id")
    _check_uint(value.sample_count, 16, "sample_count")
    _check_uint(value.elapsed_ms, 32, "elapsed_ms")
    _require_all_finite(value.mean_rh_raw, value.mean_rh_corrected, value.stddev_rh_raw)
    return _CAPTURE_RESULT.pack(
        value.point_id,
        value.result_code,
        value.capture_id,
        value.sample_count,
        value.elapsed_ms,
        value.mean_rh_raw,
        value.mean_rh_corrected,
        value.stddev_rh_raw,
    )


def unpack_capture_result(payload: bytes) -> CaptureResult:
    _require_length(payload, _CAPTURE_RESULT.size)
    values = _CAPTURE_RESULT.unpack(payload)
    _check_nonzero_uint(values[2], 64, "capture_id")
    _require_all_finite(*values[5:])
    return CaptureResult(*values)


def pack_notice(value: Notice) -> bytes:
    _check_uint(value.notice_code, 8, "notice_code")
    return bytes((value.notice_code,))


def unpack_notice(payload: bytes) -> Notice:
    _require_length(payload, 1)
    return Notice(payload[0])


def response_command(request_command: int) -> int:
    """Return the response command byte corresponding to a request command."""

    _check_uint(request_command, 8, "request_command")
    if request_command & 0x80 or request_command in {
        Command.TELEMETRY,
        Command.CAPTURE_PROGRESS,
        Command.CAPTURE_RESULT,
        Command.NOTICE,
    }:
        raise ValueError("request_command must not be a high-bit response or asynchronous event")
    return request_command | 0x80


def _pack_text(value: str, field_length: int) -> bytes:
    if not isinstance(value, str):
        raise TypeError("text field must be str")
    if "\0" in value:
        raise ValueError("text field must not contain NUL")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("text field must be valid UTF-8") from error
    if len(encoded) > field_length - 1:
        raise ValueError(f"text field must contain at most {field_length - 1} UTF-8 bytes")
    return encoded + bytes(field_length - len(encoded))


def _unpack_text(value: bytes) -> str:
    nul_index = value.find(b"\0")
    if nul_index < 0 or any(value[nul_index + 1:]):
        raise ValueError("text field must be NUL-terminated and zero-padded")
    try:
        return value[:nul_index].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("text field is not valid UTF-8") from error


def _pack_status(value: Status) -> int:
    try:
        return int(Status(value))
    except (TypeError, ValueError) as error:
        raise ValueError("unknown status") from error


def _unpack_status(value: int) -> Status:
    try:
        return Status(value)
    except ValueError as error:
        raise ValueError("unknown status") from error


def _require_length(payload: bytes, expected_length: int) -> None:
    if not isinstance(payload, bytes):
        raise TypeError("payload must be bytes")
    if len(payload) != expected_length:
        raise ValueError(f"payload length must be exactly {expected_length}")


def _check_uint(value: int, bits: int, name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < 1 << bits:
        raise ValueError(f"{name} must be an unsigned {bits}-bit integer")


def _check_nonzero_uint(value: int, bits: int, name: str) -> None:
    _check_uint(value, bits, name)
    if value == 0:
        raise ValueError(f"{name} must be nonzero")


def _check_bool(value: bool, name: str) -> None:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be bool")


def _require_flag(value: int, name: str) -> None:
    if value not in (0, 1):
        raise ValueError(f"{name} must be 0 or 1")


def _require_finite(value: float, name: str) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")


def _require_all_finite(*values: float) -> None:
    for value in values:
        _require_finite(value, "float payload value")
