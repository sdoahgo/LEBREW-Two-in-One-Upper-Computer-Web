import queue
import math
import threading
import time
import unittest
from unittest import mock

from aw_calibrator.protocol import (
    CaptureResult,
    Command,
    DeviceParameters,
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
from aw_calibrator.simulator import SimulatedTransport
from aw_calibrator.transport import SerialTransport


CAPTURE_ID_A = 0x1020304050607080
CAPTURE_ID_B = 0x8877665544332211


class ManualClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FrameSink:
    def __init__(self) -> None:
        self.decoder = StreamDecoder()
        self.frames = []

    def receive(self, data: bytes) -> None:
        self.frames.extend(self.decoder.feed(data))

    def take(self):
        frames, self.frames = self.frames, []
        return frames


class SimulatedTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock()
        self.sink = FrameSink()
        self.transport = SimulatedTransport(clock=self.clock, seed=17)
        self.transport.set_receiver(self.sink.receive)
        self.transport.open()

    def tearDown(self) -> None:
        self.transport.close()

    def send(self, command: int, sequence: int, payload: bytes = b"", *, fragmented=False):
        frame = encode_frame(command, sequence, payload)
        if fragmented:
            self.transport.write(frame[:3])
            self.transport.write(frame[3:8])
            self.transport.write(frame[8:])
        else:
            self.transport.write(frame)
        return self.sink.take()

    def test_fragmented_info_and_default_parameter_requests_use_framed_bytes(self):
        frames = self.send(Command.GET_INFO, 11, fragmented=True)
        self.assertEqual((frames[0].command, frames[0].sequence), (response_command(Command.GET_INFO), 11))
        info = unpack_device_info(frames[0].payload)
        self.assertEqual(info.status, Status.OK)
        self.assertEqual(info.device_id, "SIM-AW-0001")

        frames = self.send(Command.GET_PARAMS, 12)
        parameters = unpack_device_parameters(frames[0].payload)
        self.assertEqual(parameters.status, Status.OK)
        self.assertEqual((parameters.slope_k, parameters.offset_b), (1.0, 0.0))
        self.assertTrue(parameters.params_valid)
        self.assertTrue(parameters.cal_dew_valid)

    def test_set_get_and_reset_parameters_invalidate_cal_dew_and_emit_notices(self):
        frames = self.send(Command.SET_PARAMS, 20, pack_set_params_request(0.85, 6.0))
        response = unpack_device_parameters(frames[0].payload)
        self.assertEqual(response.status, Status.OK)
        self.assertAlmostEqual(response.slope_k, 0.85, places=6)
        self.assertAlmostEqual(response.offset_b, 6.0, places=6)
        self.assertFalse(response.cal_dew_valid)
        self.assertEqual([unpack_notice(frame.payload).notice_code for frame in frames[1:]], [1, 2])

        parameters = unpack_device_parameters(self.send(Command.GET_PARAMS, 21)[0].payload)
        self.assertEqual(parameters.param_version, 1)
        self.assertAlmostEqual(parameters.slope_k, 0.85, places=6)
        self.assertFalse(parameters.cal_dew_valid)

        frames = self.send(Command.RESET_PARAMS, 22)
        reset = unpack_device_parameters(frames[0].payload)
        self.assertEqual((reset.slope_k, reset.offset_b), (1.0, 0.0))
        self.assertEqual(reset.param_version, 1)
        self.assertFalse(reset.cal_dew_valid)
        self.assertEqual([unpack_notice(frame.payload).notice_code for frame in frames[1:]], [1, 2])

    def test_all_commands_validate_lengths_parameters_busy_and_unknown_statuses(self):
        bad_length_cases = (
            (Command.GET_INFO, b"x"),
            (Command.GET_PARAMS, b"x"),
            (Command.SET_PARAMS, b"x"),
            (Command.RESET_PARAMS, b"x"),
            (Command.START_CAPTURE, b""),
            (Command.CANCEL_CAPTURE, b"x"),
            (Command.HEARTBEAT, b"x"),
            (Command.SET_STREAM, b"x"),
        )
        for sequence, (command, payload) in enumerate(bad_length_cases, 1):
            with self.subTest(command=command):
                response = self.send(command, sequence, payload)[0]
                self.assertEqual(response.payload, bytes((Status.BAD_LENGTH,)))

        heartbeat = self.send(Command.HEARTBEAT, 30)[0]
        self.assertEqual(heartbeat.command, response_command(Command.HEARTBEAT))
        self.assertEqual(heartbeat.payload, bytes((Status.OK,)))
        self.assertEqual(self.send(0x09, 31)[0].payload, bytes((Status.UNKNOWN_COMMAND,)))
        invalid = self.send(Command.SET_PARAMS, 32, pack_set_params_request(0.24, 0.0))[0]
        self.assertEqual(invalid.payload, bytes((Status.INVALID_PARAMETER,)))
        invalid_point = self.send(Command.START_CAPTURE, 33, pack_start_capture_request(4, CAPTURE_ID_A))[0]
        self.assertEqual(
            unpack_start_capture_response(invalid_point.payload),
            (Status.INVALID_PARAMETER, 4, CAPTURE_ID_A),
        )

        zero_capture_id = bytes.fromhex("00 00 00 00 00 00 00 00 00")
        invalid_id = self.send(Command.START_CAPTURE, 34, zero_capture_id)[0]
        self.assertEqual(invalid_id.payload, bytes((Status.INVALID_PARAMETER,)))

        started = self.send(Command.START_CAPTURE, 35, pack_start_capture_request(0, CAPTURE_ID_A))[0]
        self.assertEqual(unpack_start_capture_response(started.payload), (Status.OK, 0, CAPTURE_ID_A))
        busy = self.send(Command.START_CAPTURE, 36, pack_start_capture_request(1, CAPTURE_ID_B))[0]
        self.assertEqual(
            unpack_start_capture_response(busy.payload),
            (Status.BUSY, 1, CAPTURE_ID_B),
        )

    def test_stream_interval_disable_and_full_telemetry_calculation(self):
        invalid = self.send(Command.SET_STREAM, 40, pack_set_stream_request(True, 99))[0]
        self.assertEqual(invalid.payload, bytes((Status.INVALID_PARAMETER,)))

        response = self.send(Command.SET_STREAM, 41, pack_set_stream_request(True, 100))[0]
        self.assertEqual(unpack_set_stream_response(response.payload), (Status.OK, True, 100))
        self.clock.advance(0.1)
        self.transport.pump()
        telemetry_frames = [frame for frame in self.sink.take() if frame.command == Command.TELEMETRY]
        self.assertEqual(len(telemetry_frames), 1)
        telemetry = unpack_telemetry(telemetry_frames[0].payload)
        self.assertEqual(telemetry.flags, 0x07)
        self.assertAlmostEqual(telemetry.humidity_corrected, telemetry.humidity_raw, places=5)
        self.assertGreater(telemetry.aw_unclamped, 0.0)
        self.assertGreaterEqual(telemetry.aw_final, 0.288660)
        self.assertLessEqual(telemetry.aw_final, 1.0)

        response = self.send(Command.SET_STREAM, 42, pack_set_stream_request(False, 100))[0]
        self.assertEqual(unpack_set_stream_response(response.payload), (Status.OK, False, 100))
        self.clock.advance(1.0)
        self.transport.pump()
        self.assertFalse(any(frame.command == Command.TELEMETRY for frame in self.sink.take()))

    def test_stable_capture_uses_150_samples_and_selected_center(self):
        response = self.send(Command.START_CAPTURE, 50, pack_start_capture_request(2, CAPTURE_ID_A))[0]
        self.assertEqual(unpack_start_capture_response(response.payload), (Status.OK, 2, CAPTURE_ID_A))
        self.clock.advance(15.0)
        self.transport.pump()
        frames = self.sink.take()
        progress = [unpack_capture_progress(frame.payload) for frame in frames if frame.command == Command.CAPTURE_PROGRESS]
        results = [unpack_capture_result(frame.payload) for frame in frames if frame.command == Command.CAPTURE_RESULT]
        self.assertTrue(progress)
        self.assertTrue(all(value.capture_id == CAPTURE_ID_A for value in progress))
        self.assertEqual((progress[0].sample_count, progress[0].elapsed_ms), (1, 100))
        self.assertEqual((progress[-1].sample_count, progress[-1].elapsed_ms), (150, 15000))
        self.assertEqual(results[0].result_code, 0)
        self.assertEqual(results[0].capture_id, CAPTURE_ID_A)
        self.assertEqual(results[0].sample_count, 150)
        self.assertEqual(results[0].elapsed_ms, 15000)
        self.assertAlmostEqual(results[0].mean_rh_raw, 77.687, delta=0.01)
        self.assertLess(results[0].stddev_rh_raw, 0.05)

    def test_capture_timeout_cancel_and_sensor_unavailable_paths_are_protocol_visible(self):
        timeout_clock = ManualClock()
        timeout_sink = FrameSink()
        timeout_transport = SimulatedTransport(
            clock=timeout_clock,
            seed=1,
            capture_timeout_s=0.5,
        )
        timeout_transport.set_receiver(timeout_sink.receive)
        timeout_transport.open()
        timeout_transport.write(encode_frame(Command.START_CAPTURE, 60, pack_start_capture_request(0, CAPTURE_ID_A)))
        timeout_sink.take()
        timeout_clock.advance(0.5)
        timeout_transport.pump()
        timeout_result = next(
            unpack_capture_result(frame.payload)
            for frame in timeout_sink.take()
            if frame.command == Command.CAPTURE_RESULT
        )
        self.assertEqual(timeout_result.result_code, 1)
        self.assertEqual(timeout_result.capture_id, CAPTURE_ID_A)
        self.assertLess(timeout_result.sample_count, 150)
        timeout_transport.close()

        self.send(Command.CANCEL_CAPTURE, 61)
        self.send(Command.START_CAPTURE, 62, pack_start_capture_request(1, CAPTURE_ID_B))
        frames = self.send(Command.CANCEL_CAPTURE, 63)
        self.assertEqual(frames[0].payload, bytes((Status.OK,)))
        cancelled = unpack_capture_result(next(frame.payload for frame in frames if frame.command == Command.CAPTURE_RESULT))
        self.assertEqual(cancelled.result_code, 2)
        self.assertEqual(cancelled.capture_id, CAPTURE_ID_B)

        offline_sink = FrameSink()
        offline = SimulatedTransport(clock=self.clock, sensor_available=False)
        offline.set_receiver(offline_sink.receive)
        offline.open()
        offline.write(encode_frame(Command.START_CAPTURE, 64, pack_start_capture_request(0, CAPTURE_ID_A)))
        self.assertEqual(
            unpack_start_capture_response(offline_sink.take()[0].payload),
            (Status.SENSOR_UNAVAILABLE, 0, CAPTURE_ID_A),
        )
        offline.close()

    def test_large_clock_jump_matches_incremental_pumps_byte_for_byte(self):
        def run(incremental: bool):
            clock = ManualClock()
            chunks = []
            transport = SimulatedTransport(clock=clock, seed=991)
            transport.set_receiver(chunks.append)
            transport.open()
            transport.write(encode_frame(Command.SET_STREAM, 1, pack_set_stream_request(True, 100)))
            chunks.clear()
            transport.write(encode_frame(Command.START_CAPTURE, 2, pack_start_capture_request(1, CAPTURE_ID_A)))
            chunks.clear()
            if incremental:
                for _ in range(150):
                    clock.advance(0.1)
                    transport.pump()
            else:
                clock.advance(15.0)
                transport.pump()
            transport.close()
            return chunks

        self.assertEqual(run(False), run(True))

    def test_capture_rng_is_invariant_to_stream_enablement(self):
        def capture_result_with_stream(enabled: bool):
            clock = ManualClock()
            sink = FrameSink()
            transport = SimulatedTransport(clock=clock, seed=321)
            transport.set_receiver(sink.receive)
            transport.open()
            if enabled:
                transport.write(encode_frame(Command.SET_STREAM, 1, pack_set_stream_request(True, 100)))
                sink.take()
            transport.write(encode_frame(Command.START_CAPTURE, 2, pack_start_capture_request(3, CAPTURE_ID_A)))
            sink.take()
            clock.advance(15.0)
            transport.pump()
            result = next(
                frame.payload for frame in sink.take() if frame.command == Command.CAPTURE_RESULT
            )
            transport.close()
            return result

        self.assertEqual(capture_result_with_stream(False), capture_result_with_stream(True))

    def test_cancel_first_advances_due_stable_timeout_and_active_samples(self):
        stable_clock = ManualClock()
        stable_sink = FrameSink()
        stable = SimulatedTransport(clock=stable_clock, seed=5)
        stable.set_receiver(stable_sink.receive)
        stable.open()
        stable.write(encode_frame(Command.START_CAPTURE, 1, pack_start_capture_request(0, CAPTURE_ID_A)))
        stable_sink.take()
        stable_clock.advance(15.0)
        stable.write(encode_frame(Command.CANCEL_CAPTURE, 2))
        stable_frames = stable_sink.take()
        stable_result_index = next(i for i, frame in enumerate(stable_frames) if frame.command == Command.CAPTURE_RESULT)
        cancel_response_index = next(i for i, frame in enumerate(stable_frames) if frame.command == response_command(Command.CANCEL_CAPTURE))
        self.assertLess(stable_result_index, cancel_response_index)
        self.assertEqual(unpack_capture_result(stable_frames[stable_result_index].payload).result_code, 0)
        self.assertEqual(sum(frame.command == Command.CAPTURE_RESULT for frame in stable_frames), 1)
        stable.close()

        timeout_clock = ManualClock()
        timeout_sink = FrameSink()
        timeout = SimulatedTransport(clock=timeout_clock, seed=5, capture_timeout_s=0.5)
        timeout.set_receiver(timeout_sink.receive)
        timeout.open()
        timeout.write(encode_frame(Command.START_CAPTURE, 3, pack_start_capture_request(0, CAPTURE_ID_A)))
        timeout_sink.take()
        timeout_clock.advance(0.5)
        timeout.write(encode_frame(Command.CANCEL_CAPTURE, 4))
        timeout_frames = timeout_sink.take()
        timeout_result = next(unpack_capture_result(frame.payload) for frame in timeout_frames if frame.command == Command.CAPTURE_RESULT)
        self.assertEqual(timeout_result.result_code, 1)
        self.assertEqual(timeout_result.sample_count, 5)
        self.assertLess(
            next(i for i, frame in enumerate(timeout_frames) if frame.command == Command.CAPTURE_RESULT),
            next(i for i, frame in enumerate(timeout_frames) if frame.command == response_command(Command.CANCEL_CAPTURE)),
        )
        timeout.close()

        active_clock = ManualClock()
        active_sink = FrameSink()
        active = SimulatedTransport(clock=active_clock, seed=5)
        active.set_receiver(active_sink.receive)
        active.open()
        active.write(encode_frame(Command.START_CAPTURE, 5, pack_start_capture_request(0, CAPTURE_ID_A)))
        active_sink.take()
        active_clock.advance(0.55)
        active.write(encode_frame(Command.CANCEL_CAPTURE, 6))
        active_result = next(
            unpack_capture_result(frame.payload)
            for frame in active_sink.take()
            if frame.command == Command.CAPTURE_RESULT
        )
        self.assertEqual((active_result.result_code, active_result.sample_count), (2, 5))
        self.assertEqual(active_result.elapsed_ms, 550)
        active.close()

    def test_capture_timeout_must_be_finite_and_positive(self):
        for invalid in (0.0, -1.0, math.nan, math.inf, -math.inf):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "finite and positive"):
                    SimulatedTransport(capture_timeout_s=invalid)

    def test_telemetry_uses_exact_correction_polynomial_cal_dew_and_limits(self):
        clock = ManualClock()
        sink = FrameSink()
        transport = SimulatedTransport(clock=clock, seed=77, initial_cal_dew=0.125)
        transport.set_receiver(sink.receive)
        transport.open()
        transport.write(encode_frame(Command.SET_STREAM, 1, pack_set_stream_request(True, 100)))
        sink.take()
        clock.advance(0.1)
        transport.pump()
        telemetry = unpack_telemetry(next(frame.payload for frame in sink.take() if frame.command == Command.TELEMETRY))
        expected_polynomial = (
            (-0.000004422697519 * telemetry.humidity_corrected + 0.000868044735923)
            * telemetry.humidity_corrected
            - 0.041082199067613
        ) * telemetry.humidity_corrected + 0.859771431117290
        self.assertAlmostEqual(telemetry.humidity_corrected, telemetry.humidity_raw, places=6)
        self.assertAlmostEqual(telemetry.aw_unclamped, expected_polynomial - 0.125, places=6)
        transport.close()

        for offset, expected_final in ((-20.0, 0.288660), (70.0, 1.0)):
            with self.subTest(offset=offset):
                limit_clock = ManualClock()
                limit_sink = FrameSink()
                limited = SimulatedTransport(clock=limit_clock, seed=77)
                limited.set_receiver(limit_sink.receive)
                limited.open()
                limited.write(encode_frame(Command.SET_PARAMS, 2, pack_set_params_request(0.85, offset)))
                limit_sink.take()
                limited.write(encode_frame(Command.SET_STREAM, 3, pack_set_stream_request(True, 100)))
                limit_sink.take()
                limit_clock.advance(0.1)
                limited.pump()
                value = unpack_telemetry(next(frame.payload for frame in limit_sink.take() if frame.command == Command.TELEMETRY))
                self.assertAlmostEqual(value.humidity_corrected, 0.85 * value.humidity_raw + offset, places=5)
                exact_polynomial = (
                    (-0.000004422697519 * value.humidity_corrected + 0.000868044735923)
                    * value.humidity_corrected
                    - 0.041082199067613
                ) * value.humidity_corrected + 0.859771431117290
                self.assertAlmostEqual(value.aw_unclamped, exact_polynomial, places=6)
                self.assertAlmostEqual(value.aw_final, expected_final, places=6)
                limited.close()


class FakeSerial:
    def __init__(self, *, read_error=None, write_error=None) -> None:
        self.inbound = queue.Queue()
        self.writes = []
        self.closed = False
        self.read_error = read_error
        self.write_error = write_error
        self.write_event = threading.Event()
        self.close_event = threading.Event()

    def read(self, size: int) -> bytes:
        if self.read_error is not None:
            error, self.read_error = self.read_error, None
            raise error
        item = self.inbound.get()
        return b"" if item is None else item

    def write(self, data: bytes) -> int:
        if self.write_error is not None:
            error, self.write_error = self.write_error, None
            raise error
        self.writes.append(bytes(data))
        self.write_event.set()
        return len(data)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.inbound.put(None)
            self.close_event.set()


class StubbornFakeSerial(FakeSerial):
    def __init__(self) -> None:
        super().__init__()
        self.read_entered = threading.Event()
        self.release_read = threading.Event()
        self.read_exited = threading.Event()
        self.read_calls = 0

    def read(self, size: int) -> bytes:
        self.read_calls += 1
        self.read_entered.set()
        if not self.release_read.wait(2.0):
            raise RuntimeError("stubborn read test barrier timed out")
        self.read_exited.set()
        return b""

    def close(self) -> None:
        self.closed = True
        self.close_event.set()


class BlockingWriteFakeSerial(FakeSerial):
    def __init__(self) -> None:
        super().__init__()
        self.write_entered = threading.Event()
        self.release_write = threading.Event()
        self.all_writes_finished = threading.Event()

    def write(self, data: bytes) -> int:
        self.write_entered.set()
        if not self.release_write.wait(1.0):
            raise RuntimeError("blocked write test barrier timed out")
        written = super().write(data)
        if len(self.writes) == 2:
            self.all_writes_finished.set()
        return written


class ShortWriteFakeSerial(FakeSerial):
    def write(self, data: bytes) -> int:
        self.write_event.set()
        return len(data) - 1


class SerialTransportTests(unittest.TestCase):
    def test_default_factory_uses_esp_idf_no_reset_control_line_sequence(self):
        class DeferredSerial:
            def __init__(self, **kwargs):
                self.construct_kwargs = kwargs
                self.port = kwargs.get("port")
                self.rts = True
                self.dtr = True
                self.is_open = False
                self.events = []

            def open(self):
                self.events.append(("open", self.rts, self.dtr, self.port))
                self.is_open = True

            def setRTS(self, value):
                self.rts = value
                self.events.append(("rts", value))

            def setDTR(self, value):
                self.dtr = value
                self.events.append(("dtr", value))

            def close(self):
                self.is_open = False

        serial_port = DeferredSerial()
        serial_module = type("SerialModule", (), {
            "Serial": staticmethod(lambda **kwargs: (
                setattr(serial_port, "construct_kwargs", kwargs),
                setattr(serial_port, "port", kwargs.get("port")),
                serial_port,
            )[-1]),
        })

        with mock.patch(
            "aw_calibrator.transport.importlib.import_module",
            return_value=serial_module,
        ):
            result = SerialTransport._default_serial_factory(
                port="COM5",
                baudrate=115200,
                timeout=0.05,
                write_timeout=0.5,
            )

        self.assertIs(result, serial_port)
        self.assertIsNone(serial_port.construct_kwargs["port"])
        self.assertEqual(serial_port.port, "COM5")
        self.assertEqual(
            serial_port.events,
            [
                ("rts", True),
                ("dtr", True),
                ("open", True, True, "COM5"),
                ("rts", False),
                ("dtr", True),
                ("dtr", False),
            ],
        )
        self.assertFalse(serial_port.rts)
        self.assertFalse(serial_port.dtr)

    def test_write_returns_before_blocked_device_writer_and_preserves_fifo_order(self):
        fake = BlockingWriteFakeSerial()
        transport = SerialTransport(
            "COM-BLOCKED-WRITE",
            115200,
            serial_factory=lambda **kwargs: fake,
        )
        transport.open()
        caller_returned = threading.Event()

        def emergency_release():
            if not caller_returned.wait(0.25):
                fake.release_write.set()

        release_thread = threading.Thread(target=emergency_release, daemon=True)
        release_thread.start()
        try:
            started = time.monotonic()
            transport.write(b"first")
            transport.write(b"second")
            elapsed = time.monotonic() - started
            caller_returned.set()

            self.assertLess(elapsed, 0.1)
            self.assertTrue(fake.write_entered.wait(0.1))
            self.assertFalse(fake.all_writes_finished.is_set())
            fake.release_write.set()
            self.assertTrue(fake.all_writes_finished.wait(1.0))
            self.assertEqual(fake.writes, [b"first", b"second"])
        finally:
            caller_returned.set()
            fake.release_write.set()
            release_thread.join(1.0)
            transport.close()

    def test_factory_receives_finite_write_timeout(self):
        fake = FakeSerial()
        calls = []
        transport = SerialTransport(
            "COM-WRITE-TIMEOUT",
            115200,
            serial_factory=lambda **kwargs: (calls.append(kwargs), fake)[1],
        )
        transport.open()
        try:
            self.assertIn("write_timeout", calls[0])
            self.assertGreater(calls[0]["write_timeout"], 0)
            self.assertTrue(math.isfinite(calls[0]["write_timeout"]))
        finally:
            transport.close()

    def test_write_error_is_reported_asynchronously_once_and_closes_generation(self):
        fake = FakeSerial(write_error=OSError("async write failed"))
        errors = []
        error_event = threading.Event()
        transport = SerialTransport(
            "COM-ASYNC-WRITE-ERROR",
            115200,
            serial_factory=lambda **kwargs: fake,
            error_callback=lambda error: (errors.append(error), error_event.set()),
        )
        transport.open()

        transport.write(b"request")

        self.assertTrue(error_event.wait(1.0))
        self.assertEqual([str(error) for error in errors], ["async write failed"])
        self.assertTrue(fake.closed)
        with self.assertRaisesRegex(RuntimeError, "not open"):
            transport.write(b"later")
        transport.close()

    def test_short_write_uses_the_same_asynchronous_generation_failure_path(self):
        fake = ShortWriteFakeSerial()
        errors = []
        error_event = threading.Event()
        transport = SerialTransport(
            "COM-SHORT-WRITE",
            115200,
            serial_factory=lambda **kwargs: fake,
            error_callback=lambda error: (errors.append(error), error_event.set()),
        )
        transport.open()

        transport.write(b"request")

        self.assertTrue(error_event.wait(1.0))
        self.assertEqual([str(error) for error in errors], ["short serial write"])
        self.assertTrue(fake.closed)
        transport.close()

    def test_injected_factory_open_read_write_and_idempotent_close_need_no_pyserial(self):
        fake = FakeSerial()
        calls = []
        received = []
        read_event = threading.Event()

        def factory(**kwargs):
            calls.append(kwargs)
            return fake

        transport = SerialTransport("COM7", 115200, serial_factory=factory)
        transport.set_receiver(lambda data: (received.append(data), read_event.set()))
        transport.open()
        transport.open()
        self.assertEqual(calls, [{
            "port": "COM7",
            "baudrate": 115200,
            "timeout": 0.05,
            "write_timeout": 0.5,
        }])
        self.assertTrue(transport.reader_thread.daemon)
        self.assertTrue(transport.writer_thread.daemon)

        fake.inbound.put(b"\xA5\x5A")
        self.assertTrue(read_event.wait(1.0))
        self.assertEqual(received, [b"\xA5\x5A"])
        transport.write(b"request")
        self.assertTrue(fake.write_event.wait(1.0))
        self.assertEqual(fake.writes, [b"request"])

        transport.close()
        transport.close()
        self.assertTrue(fake.close_event.wait(1.0))
        self.assertFalse(transport.reader_thread.is_alive())

    def test_read_and_write_exceptions_report_without_transport_lock_and_shutdown_cleanly(self):
        read_fake = FakeSerial(read_error=OSError("read failed"))
        read_errors = []
        read_error_event = threading.Event()
        read_transport = None

        def on_read_error(error):
            read_errors.append(error)
            read_transport.close()
            read_error_event.set()

        read_transport = SerialTransport(
            "COM8",
            9600,
            serial_factory=lambda **kwargs: read_fake,
            error_callback=on_read_error,
        )
        read_transport.open()
        self.assertTrue(read_error_event.wait(1.0))
        self.assertIsInstance(read_errors[0], OSError)
        self.assertTrue(read_fake.closed)

        write_fake = FakeSerial(write_error=OSError("write failed"))
        write_errors = []
        write_error_event = threading.Event()
        write_transport = None

        def on_write_error(error):
            write_errors.append(error)
            write_transport.close()
            write_error_event.set()

        write_transport = SerialTransport(
            "COM9",
            230400,
            serial_factory=lambda **kwargs: write_fake,
            error_callback=on_write_error,
        )
        write_transport.open()
        write_transport.write(b"request")
        self.assertTrue(write_error_event.wait(1.0))
        self.assertEqual(len(write_errors), 1)
        self.assertTrue(write_fake.closed)

    def test_close_timeout_refuses_reopen_until_stubborn_reader_exits(self):
        first = StubbornFakeSerial()
        second = FakeSerial()
        serials = iter((first, second))
        transport = SerialTransport(
            "COM10",
            115200,
            serial_factory=lambda **kwargs: next(serials),
        )
        transport.set_receiver(lambda data: None)
        transport.open()
        self.assertTrue(first.read_entered.wait(1.0))
        transport.close()
        try:
            with self.assertRaisesRegex(RuntimeError, "reader is still stopping"):
                transport.open()
        finally:
            first.release_read.set()
        self.assertTrue(first.read_exited.wait(1.0))
        transport.reader_thread.join(1.0)

        transport.open()
        self.assertEqual(first.read_calls, 1)
        self.assertIsNot(transport.reader_thread, threading.current_thread())
        transport.close()


if __name__ == "__main__":
    unittest.main()
