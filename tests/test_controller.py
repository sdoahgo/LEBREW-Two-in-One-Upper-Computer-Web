import queue
import struct
import threading
import unittest
from unittest.mock import patch

import aw_calibrator.controller as controller_module
from aw_calibrator.calibration import calculate_report
from aw_calibrator.controller import CalibrationController
from aw_calibrator.models import MasterProfile
from aw_calibrator.protocol import (
    CaptureProgress,
    CaptureResult,
    Command,
    DeviceInfo,
    DeviceParameters,
    Notice,
    Status,
    StreamDecoder,
    encode_frame,
    pack_capture_progress,
    pack_capture_result,
    pack_device_info,
    pack_device_parameters,
    pack_notice,
    pack_set_stream_response,
    pack_start_capture_response,
    pack_telemetry,
    response_command,
    unpack_start_capture_request,
    Telemetry,
)
from aw_calibrator.simulator import SimulatedTransport
from aw_calibrator.transport import SerialTransport


class ManualClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class ScriptedTransport:
    def __init__(self) -> None:
        self.receiver = None
        self.decoder = StreamDecoder()
        self.requests = []
        self.opened = False
        self.closed = False

    def set_receiver(self, receiver) -> None:
        self.receiver = receiver

    def open(self) -> None:
        self.opened = True
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def write(self, data: bytes) -> None:
        for request in self.decoder.feed(data):
            if request.command == Command.SET_STREAM:
                self.reply(request, pack_set_stream_response(Status.OK, True, 100))
            else:
                self.requests.append(request)

    def reply(self, request, payload: bytes, *, command=None, fragmented=False) -> None:
        data = encode_frame(
            response_command(request.command) if command is None else command,
            request.sequence,
            payload,
        )
        if fragmented:
            self.receiver(data[:2])
            self.receiver(data[2:7])
            self.receiver(data[7:])
        else:
            self.receiver(data)

    def event(self, command: Command, sequence: int, payload: bytes) -> None:
        self.receiver(encode_frame(command, sequence, payload))


class SequenceRecordingTransport(ScriptedTransport):
    def __init__(self) -> None:
        super().__init__()
        self.sequences = []

    def write(self, data: bytes) -> None:
        sequence = struct.unpack_from("<H", data, 6)[0]
        self.sequences.append(sequence)
        if data[5] == Command.SET_STREAM:
            self.receiver(encode_frame(
                response_command(Command.SET_STREAM),
                sequence,
                pack_set_stream_response(Status.OK, True, 100),
            ))


class SilentScriptedTransport(ScriptedTransport):
    def write(self, data: bytes) -> None:
        self.requests.extend(self.decoder.feed(data))


class BlockingDecoder:
    def __init__(self) -> None:
        self.decoder = StreamDecoder()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.armed = False

    def feed(self, data: bytes):
        if self.armed:
            self.entered.set()
            if not self.release.wait(1.0):
                raise RuntimeError("decoder test barrier timed out")
        return self.decoder.feed(data)


class CloseUnblocksWriteTransport(ScriptedTransport):
    def __init__(self) -> None:
        super().__init__()
        self.write_entered = threading.Event()
        self.close_called = threading.Event()

    def close(self) -> None:
        super().close()
        self.close_called.set()

    def write(self, data: bytes) -> None:
        request = self.decoder.feed(data)[0]
        if request.command == Command.SET_STREAM:
            self.reply(request, pack_set_stream_response(Status.OK, True, 100))
            return
        self.write_entered.set()
        if not self.close_called.wait(1.0):
            raise RuntimeError("write test barrier timed out")
        raise OSError("transport closed")


class CrossThreadCallbackTransport(ScriptedTransport):
    def __init__(self) -> None:
        super().__init__()
        self.callback_finished = threading.Event()

    def write(self, data: bytes) -> None:
        request = self.decoder.feed(data)[0]
        if request.command == Command.SET_STREAM:
            self.reply(request, pack_set_stream_response(Status.OK, True, 100))
            return

        def reply_on_reader_thread():
            self.reply(request, pack_device_info(DeviceInfo(Status.OK, "THREAD", "1")))
            self.callback_finished.set()

        threading.Thread(target=reply_on_reader_thread, daemon=True).start()
        if not self.callback_finished.wait(1.0):
            raise RuntimeError("controller callback deadlocked with write")


class OpenCallbackFailureTransport(ScriptedTransport):
    def __init__(self, error_callback) -> None:
        super().__init__()
        self.error_callback = error_callback
        self.callback_finished = threading.Event()
        self.close_called = threading.Event()

    def open(self) -> None:
        super().open()

        def fail_reader():
            self.error_callback(OSError("reader died during open"))
            self.callback_finished.set()

        threading.Thread(target=fail_reader, daemon=True).start()
        if not self.callback_finished.wait(1.0):
            raise RuntimeError("open error callback deadlocked")

    def close(self) -> None:
        super().close()
        self.close_called.set()


class StreamWriteFailureTransport(ScriptedTransport):
    def __init__(self) -> None:
        super().__init__()
        self.close_called = threading.Event()

    def close(self) -> None:
        super().close()
        self.close_called.set()

    def write(self, data: bytes) -> None:
        request = self.decoder.feed(data)[0]
        if request.command == Command.SET_STREAM:
            raise OSError("stream setup failed")
        self.requests.append(request)


class AsyncWriteFailureSerial:
    def __init__(self) -> None:
        self.inbound = queue.Queue()
        self.decoder = StreamDecoder()
        self.stream_written = threading.Event()
        self.closed = threading.Event()

    def read(self, size: int) -> bytes:
        item = self.inbound.get()
        return b"" if item is None else item

    def write(self, data: bytes) -> int:
        request = self.decoder.feed(data)[0]
        if request.command == Command.SET_STREAM:
            self.inbound.put(encode_frame(
                response_command(Command.SET_STREAM),
                request.sequence,
                pack_set_stream_response(Status.OK, True, 100),
            ))
            self.stream_written.set()
            return len(data)
        raise OSError("background serial write failed")

    def close(self) -> None:
        if not self.closed.is_set():
            self.closed.set()
            self.inbound.put(None)


class StaleCleanupTransport(ScriptedTransport):
    def __init__(self, error_callback) -> None:
        super().__init__()
        self.error_callback = error_callback
        self.open_entered = threading.Event()
        self.release_open = threading.Event()
        self.second_close_finished = threading.Event()
        self.close_count = 0

    def open(self) -> None:
        self.open_entered.set()
        if not self.release_open.wait(1.0):
            raise RuntimeError("open test barrier timed out")

    def close(self) -> None:
        self.close_count += 1
        if self.close_count == 1:
            return

        callback_finished = threading.Event()

        def stale_callback():
            self.error_callback(OSError("stale close callback"))
            callback_finished.set()

        threading.Thread(target=stale_callback, daemon=True).start()
        if not callback_finished.wait(1.0):
            raise RuntimeError("stale cleanup held the controller lock")
        self.second_close_finished.set()


class StreamEchoMismatchTransport(ScriptedTransport):
    def write(self, data: bytes) -> None:
        request = self.decoder.feed(data)[0]
        if request.command == Command.SET_STREAM:
            self.reply(request, pack_set_stream_response(Status.OK, False, 200))
        else:
            self.requests.append(request)


def kinds(events):
    return [event.kind for event in events]


class CalibrationControllerTests(unittest.TestCase):
    def _start_capture_ok(self, controller, transport, point_id):
        sequence = controller.start_capture(point_id)
        request = transport.requests[-1]
        self.assertEqual(request.command, Command.START_CAPTURE)
        request_point, capture_id = unpack_start_capture_request(request.payload)
        self.assertEqual(request_point, point_id)
        transport.reply(request, pack_start_capture_response(Status.OK, point_id, capture_id))
        events = controller.poll_events()
        started = [event for event in events if event.kind == "capture_started"]
        self.assertEqual(len(started), 1)
        self.assertEqual(
            (started[0].sequence, started[0].data["point_id"], started[0].data["capture_id"]),
            (sequence, point_id, capture_id),
        )
        self._active_capture_id = capture_id
        return sequence

    def _result(
        self,
        point_id,
        result_code=0,
        *,
        capture_id=None,
        mean=38.857,
        sample_count=150,
        elapsed_ms=15_000,
    ):
        if capture_id is None:
            capture_id = self._active_capture_id
        return CaptureResult(point_id, result_code, capture_id, sample_count, elapsed_ms, mean, mean, 0.01)

    def test_replayed_old_ok_start_with_reused_sequence_keeps_live_pending_request(self):
        old_id = 0x1111222233334444
        live_id = 0xAAAABBBBCCCCDDDD
        capture_ids = iter((old_id, live_id))
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            sequence_start=1,
            capture_id_factory=lambda: next(capture_ids),
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-START-REPLAY-1", 115200)
        controller.poll_events()
        old_sequence = controller.start_capture(2)
        old_request = first.requests[-1]
        self.assertEqual(unpack_start_capture_request(old_request.payload), (2, old_id))

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-START-REPLAY-2", 115200)
        controller.poll_events()
        live_sequence = controller.start_capture(2)
        live_request = second.requests[-1]
        self.assertEqual(live_sequence, old_sequence)
        self.assertEqual(unpack_start_capture_request(live_request.payload), (2, live_id))

        second.reply(live_request, pack_start_capture_response(Status.OK, 2, old_id))
        replay_events = controller.poll_events()
        self.assertNotIn("capture_started", kinds(replay_events))
        self.assertNotIn("error", kinds(replay_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "capture" in event.message and "identity" in event.message
            for event in replay_events
        ))

        second.reply(live_request, pack_start_capture_response(Status.OK, 2, live_id))
        real_events = controller.poll_events()
        started = next(event for event in real_events if event.kind == "capture_started")
        self.assertEqual(
            (started.sequence, started.data["point_id"], started.data["capture_id"]),
            (live_sequence, 2, live_id),
        )
        controller.disconnect()

    def test_replayed_old_busy_start_with_reused_sequence_keeps_live_pending_request(self):
        old_id = 0x1111222233334444
        live_id = 0xAAAABBBBCCCCDDDD
        capture_ids = iter((old_id, live_id))
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            sequence_start=1,
            capture_id_factory=lambda: next(capture_ids),
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-START-BUSY-REPLAY-1", 115200)
        controller.poll_events()
        old_sequence = controller.start_capture(2)
        self.assertEqual(
            unpack_start_capture_request(first.requests[-1].payload),
            (2, old_id),
        )

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-START-BUSY-REPLAY-2", 115200)
        controller.poll_events()
        live_sequence = controller.start_capture(2)
        live_request = second.requests[-1]
        self.assertEqual(live_sequence, old_sequence)
        self.assertEqual(unpack_start_capture_request(live_request.payload), (2, live_id))

        second.reply(
            live_request,
            pack_start_capture_response(Status.BUSY, 2, old_id),
        )
        replay_events = controller.poll_events()
        self.assertNotIn("capture_started", kinds(replay_events))
        self.assertNotIn("error", kinds(replay_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "capture" in event.message and "identity" in event.message
            for event in replay_events
        ))

        second.reply(
            live_request,
            pack_start_capture_response(Status.OK, 2, live_id),
        )
        real_events = controller.poll_events()
        started = next(event for event in real_events if event.kind == "capture_started")
        self.assertEqual(
            (started.sequence, started.data["point_id"], started.data["capture_id"]),
            (live_sequence, 2, live_id),
        )
        controller.disconnect()

    def test_status_only_and_malformed_start_replays_leave_pending_until_correlated_ok(self):
        capture_id = 0xA1A2A3A4A5A6A7A8
        transport = ScriptedTransport()
        controller = CalibrationController(
            capture_id_factory=lambda: capture_id,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-START-UNCORRELATED", 115200)
        controller.poll_events()
        sequence = controller.start_capture(1)
        request = transport.requests[-1]

        for payload in (bytes((Status.BUSY,)), b"", bytes((Status.OK, 1))):
            with self.subTest(payload=payload):
                transport.reply(request, payload)
                replay_events = controller.poll_events()
                self.assertNotIn("capture_started", kinds(replay_events))
                self.assertNotIn("error", kinds(replay_events))
                self.assertTrue(any(
                    event.kind == "diagnostic" and "start" in event.message.lower()
                    for event in replay_events
                ))

        transport.reply(
            request,
            pack_start_capture_response(Status.OK, 1, capture_id),
        )
        real_events = controller.poll_events()
        started = next(event for event in real_events if event.kind == "capture_started")
        self.assertEqual(
            (started.sequence, started.data["point_id"], started.data["capture_id"]),
            (sequence, 1, capture_id),
        )
        controller.disconnect()

    def test_matching_busy_start_response_consumes_pending_as_normal_error(self):
        capture_id = 0xB1B2B3B4B5B6B7B8
        transport = ScriptedTransport()
        controller = CalibrationController(
            capture_id_factory=lambda: capture_id,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-START-CURRENT-BUSY", 115200)
        controller.poll_events()
        sequence = controller.start_capture(3)
        request = transport.requests[-1]

        transport.reply(
            request,
            pack_start_capture_response(Status.BUSY, 3, capture_id),
        )
        busy_events = controller.poll_events()
        error = next(event for event in busy_events if event.kind == "error")
        self.assertEqual(error.sequence, sequence)
        self.assertEqual(error.data["status"], Status.BUSY)
        self.assertNotIn("capture_started", kinds(busy_events))
        self.assertNotIn("diagnostic", kinds(busy_events))

        transport.reply(
            request,
            pack_start_capture_response(Status.OK, 3, capture_id),
        )
        late_events = controller.poll_events()
        self.assertNotIn("capture_started", kinds(late_events))
        self.assertIn("diagnostic", kinds(late_events))
        controller.disconnect()

    def test_capture_id_factory_rejects_invalid_or_reused_values_before_write(self):
        for invalid in (0, -1, 1 << 64, True):
            with self.subTest(invalid=invalid):
                transport = ScriptedTransport()
                controller = CalibrationController(
                    capture_id_factory=lambda invalid=invalid: invalid,
                    serial_transport_factory=lambda port, baudrate, error_callback: transport,
                )
                controller.connect_serial("COM-CAPTURE-ID-INVALID", 115200)
                controller.poll_events()
                with self.assertRaisesRegex(ValueError, "capture_id"):
                    controller.start_capture(0)
                self.assertEqual(transport.requests, [])
                controller.disconnect()

        capture_id = 0x123456789ABCDEF0
        transport = ScriptedTransport()
        controller = CalibrationController(
            capture_id_factory=lambda: capture_id,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-ID-REUSED", 115200)
        controller.poll_events()
        controller.start_capture(0)
        with self.assertRaisesRegex(ValueError, "unique"):
            controller.start_capture(1)
        self.assertEqual(len(transport.requests), 1)
        controller.disconnect()

    def test_default_capture_id_generator_is_nonzero_unique_and_skips_zero_on_wrap(self):
        maximum = (1 << 64) - 1
        generator = controller_module._CaptureIdGenerator(
            state=maximum - 1,
            increment=1,
        )
        values = [generator() for _ in range(4)]
        self.assertEqual(values, [maximum, 1, 2, 3])
        self.assertNotIn(0, values)
        self.assertEqual(len(values), len(set(values)))

    def test_default_capture_id_generator_is_thread_safe_without_history(self):
        generator = controller_module._CaptureIdGenerator(state=0, increment=1)
        thread_count = 8
        ids_per_thread = 500
        start = threading.Barrier(thread_count + 1)
        results = []
        results_lock = threading.Lock()

        def generate_ids():
            start.wait()
            local = [generator() for _ in range(ids_per_thread)]
            with results_lock:
                results.extend(local)

        threads = [threading.Thread(target=generate_ids) for _ in range(thread_count)]
        for thread in threads:
            thread.start()
        start.wait()
        for thread in threads:
            thread.join(2.0)
            self.assertFalse(thread.is_alive())

        self.assertEqual(len(results), thread_count * ids_per_thread)
        self.assertNotIn(0, results)
        self.assertEqual(len(results), len(set(results)))
        self.assertNotIn("_issued_capture_ids", vars(generator))

    def test_default_controller_does_not_allocate_capture_id_history(self):
        controller = CalibrationController()
        self.assertNotIn("_issued_capture_ids", vars(controller))
        self.assertIsNone(controller._custom_issued_capture_ids)

    def test_progress_requires_active_generation_point_and_capture_id(self):
        capture_id = 0xCAFEBABE01020304
        transport = ScriptedTransport()
        controller = CalibrationController(
            capture_id_factory=lambda: capture_id,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-PROGRESS", 115200)
        controller.poll_events()

        unowned = CaptureProgress(1, capture_id, 10, 1_000, 59.78, 0.02)
        transport.event(Command.CAPTURE_PROGRESS, 60, pack_capture_progress(unowned))
        self.assertNotIn("capture_progress", kinds(controller.poll_events()))

        self._start_capture_ok(controller, transport, 1)
        wrong_id = CaptureProgress(1, capture_id + 1, 20, 2_000, 59.78, 0.02)
        wrong_point = CaptureProgress(2, capture_id, 20, 2_000, 59.78, 0.02)
        transport.event(Command.CAPTURE_PROGRESS, 61, pack_capture_progress(wrong_id))
        transport.event(Command.CAPTURE_PROGRESS, 62, pack_capture_progress(wrong_point))
        mismatch_events = controller.poll_events()
        self.assertNotIn("capture_progress", kinds(mismatch_events))
        self.assertEqual(kinds(mismatch_events).count("diagnostic"), 2)

        current = CaptureProgress(1, capture_id, 30, 3_000, 59.78, 0.02)
        transport.event(Command.CAPTURE_PROGRESS, 63, pack_capture_progress(current))
        accepted = [event for event in controller.poll_events() if event.kind == "capture_progress"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(
            (
                accepted[0].sequence,
                accepted[0].data.point_id,
                accepted[0].data.capture_id,
                accepted[0].data.sample_count,
                accepted[0].data.elapsed_ms,
            ),
            (63, 1, capture_id, 30, 3_000),
        )
        self.assertAlmostEqual(accepted[0].data.mean_rh_raw, 59.78, places=5)
        self.assertAlmostEqual(accepted[0].data.stddev_rh_raw, 0.02, places=6)
        controller.disconnect()

    def test_unseen_old_terminal_after_new_active_does_not_close_live_capture(self):
        old_id = 0x0101010101010101
        live_id = 0x0202020202020202
        capture_ids = iter((old_id, live_id))
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            capture_id_factory=lambda: next(capture_ids),
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-UNSEEN-OLD-1", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, first, 3)

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-UNSEEN-OLD-2", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, second, 3)

        old_result = self._result(3, capture_id=old_id, mean=98.787)
        second.event(Command.CAPTURE_RESULT, 500, pack_capture_result(old_result))
        replay_events = controller.poll_events()
        self.assertNotIn("capture_result", kinds(replay_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "capture_id" in event.message
            for event in replay_events
        ))

        live_result = self._result(3, capture_id=live_id, mean=98.787)
        second.event(Command.CAPTURE_RESULT, 500, pack_capture_result(live_result))
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual([(event.sequence, event.data.point_id) for event in accepted], [(500, 3)])
        controller.disconnect()

    def test_genuine_identical_new_result_with_new_id_accepts_reused_event_sequence(self):
        first_id = 0x1010101010101010
        second_id = 0x2020202020202020
        capture_ids = iter((first_id, second_id))
        transport = ScriptedTransport()
        controller = CalibrationController(
            capture_id_factory=lambda: next(capture_ids),
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-GENUINE-IDENTICAL", 115200)
        controller.poll_events()

        self._start_capture_ok(controller, transport, 0)
        first_payload = pack_capture_result(self._result(0, capture_id=first_id, mean=38.857))
        transport.event(Command.CAPTURE_RESULT, 77, first_payload)
        self.assertEqual(kinds(controller.poll_events()).count("capture_result"), 1)

        self._start_capture_ok(controller, transport, 0)
        second_payload = pack_capture_result(self._result(0, capture_id=second_id, mean=38.857))
        self.assertNotEqual(first_payload, second_payload)
        self.assertEqual(first_payload[:2], second_payload[:2])
        self.assertEqual(first_payload[10:], second_payload[10:])
        transport.event(Command.CAPTURE_RESULT, 77, second_payload)
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual([event.sequence for event in accepted], [77])
        self.assertAlmostEqual(accepted[0].data.mean_rh_raw, 38.857, places=5)
        controller.disconnect()

    def test_same_connection_duplicate_terminal_is_recorded_once(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-DUP", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, transport, 0)
        payload = pack_capture_result(self._result(0))

        transport.event(Command.CAPTURE_RESULT, 77, payload)
        transport.event(Command.CAPTURE_RESULT, 77, payload)
        events = controller.poll_events()

        results = [event for event in events if event.kind == "capture_result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].sequence, 77)
        self.assertEqual(results[0].data.result_code, "stable")
        self.assertTrue(any(
            event.kind == "diagnostic" and "active capture" in event.message
            for event in events
        ))
        controller.disconnect()

    def test_result_replay_after_disconnect_reconnect_is_unowned(self):
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-CAPTURE-OLD", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, first, 1)
        payload = pack_capture_result(self._result(1, mean=59.78))
        first.event(Command.CAPTURE_RESULT, 91, payload)
        self.assertEqual(kinds(controller.poll_events()).count("capture_result"), 1)

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-CAPTURE-NEW", 115200)
        controller.poll_events()
        second.event(Command.CAPTURE_RESULT, 91, payload)
        replay_events = controller.poll_events()

        self.assertNotIn("capture_result", kinds(replay_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "active capture" in event.message
            for event in replay_events
        ))
        controller.disconnect()

    def test_point_or_capture_id_mismatch_is_ignored_without_closing_active_capture(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-POINT", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, transport, 2)

        transport.event(
            Command.CAPTURE_RESULT,
            100,
            pack_capture_result(self._result(2, capture_id=self._active_capture_id + 1, mean=77.687)),
        )
        id_mismatch_events = controller.poll_events()
        self.assertNotIn("capture_result", kinds(id_mismatch_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "capture_id" in event.message
            for event in id_mismatch_events
        ))

        transport.event(
            Command.CAPTURE_RESULT,
            101,
            pack_capture_result(self._result(1, mean=59.78)),
        )
        mismatch_events = controller.poll_events()
        self.assertNotIn("capture_result", kinds(mismatch_events))
        self.assertTrue(any(
            event.kind == "diagnostic" and "point" in event.message
            for event in mismatch_events
        ))

        transport.event(
            Command.CAPTURE_RESULT,
            102,
            pack_capture_result(self._result(2, mean=77.687)),
        )
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual([(event.sequence, event.data.point_id) for event in accepted], [(102, 2)])
        controller.disconnect()

    def test_reconnect_clears_active_capture_and_new_capture_accepts_reused_event_sequence(self):
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-CAPTURE-GEN-1", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, first, 3)
        old_payload = pack_capture_result(self._result(3, mean=98.787))

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-CAPTURE-GEN-2", 115200)
        controller.poll_events()
        second.event(Command.CAPTURE_RESULT, 123, old_payload)
        self.assertNotIn("capture_result", kinds(controller.poll_events()))

        self._start_capture_ok(controller, second, 3)
        new_payload = pack_capture_result(self._result(3, mean=98.797, elapsed_ms=15_100))
        second.event(Command.CAPTURE_RESULT, 123, new_payload)
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0].sequence, 123)
        self.assertAlmostEqual(accepted[0].data.mean_rh_raw, 98.797, places=4)
        controller.disconnect()

    def test_byte_identical_reconnect_replay_cannot_claim_new_active_capture(self):
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM-CAPTURE-REPLAY-1", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, first, 2)
        old_payload = pack_capture_result(self._result(2, mean=77.687))
        first.event(Command.CAPTURE_RESULT, 144, old_payload)
        self.assertEqual(kinds(controller.poll_events()).count("capture_result"), 1)

        controller.disconnect()
        controller.poll_events()
        controller.connect_serial("COM-CAPTURE-REPLAY-2", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, second, 2)

        second.event(Command.CAPTURE_RESULT, 144, old_payload)
        replay_events = controller.poll_events()
        self.assertNotIn("capture_result", kinds(replay_events))
        self.assertIn("diagnostic", kinds(replay_events))

        new_payload = pack_capture_result(self._result(2, mean=77.697, elapsed_ms=15_100))
        second.event(Command.CAPTURE_RESULT, 144, new_payload)
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0].sequence, 144)
        self.assertAlmostEqual(accepted[0].data.mean_rh_raw, 77.697, places=4)
        controller.disconnect()

    def test_each_terminal_result_code_is_recorded_exactly_once(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-CODES", 115200)
        controller.poll_events()
        expected_names = ("stable", "timeout", "cancelled", "sensor_error")

        for result_code, expected_name in enumerate(expected_names):
            with self.subTest(result_code=result_code):
                self._start_capture_ok(controller, transport, result_code)
                payload = pack_capture_result(self._result(result_code, result_code, mean=40.0 + result_code))
                event_sequence = 200 + result_code
                transport.event(Command.CAPTURE_RESULT, event_sequence, payload)
                transport.event(Command.CAPTURE_RESULT, event_sequence, payload)
                events = controller.poll_events()
                results = [event.data.result_code for event in events if event.kind == "capture_result"]
                self.assertEqual(results, [expected_name])
        controller.disconnect()

    def test_replayed_stable_result_cannot_satisfy_three_repeat_gate(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-GATE", 115200)
        controller.poll_events()
        event_sequence = 300

        for point_id in range(4):
            repeat_count = 2 if point_id == 0 else 3
            for repeat in range(repeat_count):
                self._start_capture_ok(controller, transport, point_id)
                event_sequence += 1
                payload = pack_capture_result(self._result(
                    point_id,
                    mean=(38.857, 59.780, 77.687, 98.787)[point_id] + repeat * 0.01,
                ))
                transport.event(Command.CAPTURE_RESULT, event_sequence, payload)
                events = controller.poll_events()
                self.assertNotIn("report", kinds(events))
                if point_id == 0 and repeat == 1:
                    replay_sequence = event_sequence
                    replay_payload = payload

        transport.event(Command.CAPTURE_RESULT, replay_sequence, replay_payload)
        replay_events = controller.poll_events()
        self.assertNotIn("report", kinds(replay_events))
        self.assertNotIn("capture_result", kinds(replay_events))
        controller.disconnect()

    def test_cancel_response_then_cancelled_result_records_one_terminal(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-CANCEL-LATE", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, transport, 2)
        cancel_sequence = controller.cancel_capture()
        cancel_request = transport.requests[-1]
        transport.reply(cancel_request, bytes((Status.OK,)))
        payload = pack_capture_result(self._result(2, 2, mean=77.687, sample_count=20, elapsed_ms=2_000))
        transport.event(Command.CAPTURE_RESULT, 410, payload)
        transport.event(Command.CAPTURE_RESULT, 410, payload)
        events = controller.poll_events()

        self.assertEqual(
            [(event.kind, event.sequence) for event in events if event.kind in ("capture_cancelled", "capture_result")],
            [("capture_cancelled", cancel_sequence), ("capture_result", 410)],
        )
        controller.disconnect()

    def test_terminal_before_cancel_response_stays_single_and_cancel_response_is_nonterminal(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-CANCEL-DUE", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, transport, 1)
        cancel_sequence = controller.cancel_capture()
        cancel_request = transport.requests[-1]
        payload = pack_capture_result(self._result(1, 1, mean=59.78))
        transport.event(Command.CAPTURE_RESULT, 420, payload)
        transport.reply(cancel_request, bytes((Status.OK,)))
        transport.event(Command.CAPTURE_RESULT, 420, payload)
        events = controller.poll_events()

        self.assertEqual(kinds(events).count("capture_result"), 1)
        self.assertEqual(kinds(events).count("capture_cancelled"), 1)
        self.assertEqual(
            next(event.sequence for event in events if event.kind == "capture_cancelled"),
            cancel_sequence,
        )
        controller.disconnect()

    def test_malformed_terminal_does_not_close_active_capture(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-CAPTURE-MALFORMED", 115200)
        controller.poll_events()
        self._start_capture_ok(controller, transport, 0)

        malformed = CaptureResult(0, 0, self._active_capture_id, 150, 15_000, 38.857, 38.857, -0.01)
        transport.event(Command.CAPTURE_RESULT, 430, pack_capture_result(malformed))
        malformed_events = controller.poll_events()
        self.assertNotIn("capture_result", kinds(malformed_events))
        self.assertIn("diagnostic", kinds(malformed_events))

        transport.event(Command.CAPTURE_RESULT, 431, pack_capture_result(self._result(0)))
        accepted = [event for event in controller.poll_events() if event.kind == "capture_result"]
        self.assertEqual([(event.sequence, event.data.point_id) for event in accepted], [(431, 0)])
        controller.disconnect()

    def test_simulator_workflow_three_repeats_all_points_report_write_readback_and_reset(self):
        clock = ManualClock()
        simulator = SimulatedTransport(clock=clock, seed=23)
        controller = CalibrationController(clock=clock, simulator_factory=lambda: simulator)
        controller.connect_simulator()
        info_sequence = controller.read_info()
        params_sequence = controller.read_parameters()
        self.assertNotEqual(info_sequence, 0)
        self.assertNotEqual(params_sequence, 0)
        events = controller.poll_events()
        self.assertIn("connected", kinds(events))
        self.assertIn("info", kinds(events))
        self.assertIn("parameters", kinds(events))
        clock.advance(0.1)
        telemetry_events = controller.poll_events()
        self.assertIn("telemetry", kinds(telemetry_events))
        events.extend(telemetry_events)

        for _repeat in range(3):
            for point_id in range(4):
                controller.start_capture(point_id)
                clock.advance(15.0)
                events.extend(controller.poll_events())

        stable_results = [event.data for event in events if event.kind == "capture_result" and event.data.result_code == "stable"]
        self.assertEqual(len(stable_results), 12)
        self.assertEqual([sum(run.point_id == point for run in stable_results) for point in range(4)], [3, 3, 3, 3])
        report = [event.data for event in events if event.kind == "report"][-1]
        self.assertEqual(report.recommended_method, "least_squares")
        self.assertAlmostEqual(report.least_squares.slope_k, 0.847543870197, delta=0.001)

        write_sequence = controller.write_parameters(report.least_squares.slope_k, report.least_squares.offset_b)
        write_events = controller.poll_events()
        self.assertNotEqual(write_sequence, 0)
        verified = next(event.data for event in write_events if event.kind == "write_verified")
        self.assertFalse(verified.cal_dew_valid)
        self.assertIn(2, [event.data.notice_code for event in write_events if event.kind == "notice"])

        controller.reset_parameters()
        reset_events = controller.poll_events()
        reset = next(event.data for event in reset_events if event.kind == "reset")
        self.assertEqual((reset.slope_k, reset.offset_b), (1.0, 0.0))
        self.assertFalse(reset.cal_dew_valid)
        controller.disconnect()

    def test_response_matching_fragmentation_malformed_unknown_and_stale_frames_are_diagnostic(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM1", 115200)
        sequence = controller.read_info()
        request = transport.requests[-1]
        self.assertEqual(sequence, request.sequence)

        transport.receiver(encode_frame(
            response_command(Command.GET_INFO),
            sequence + 100,
            pack_device_info(DeviceInfo(Status.OK, "WRONG-SEQUENCE", "0")),
        ))
        transport.reply(request, bytes((Status.OK,)), command=response_command(Command.GET_PARAMS))
        transport.reply(request, bytes((Status.OK,)))
        info_payload = pack_device_info(DeviceInfo(Status.OK, "DUT", "1.2.3"))
        transport.reply(request, info_payload)
        events = controller.poll_events()
        self.assertEqual(kinds(events).count("diagnostic"), 4)
        self.assertNotIn("info", kinds(events))

        valid_sequence = controller.read_info()
        valid_request = transport.requests[-1]
        transport.reply(valid_request, info_payload, fragmented=True)
        unknown = encode_frame(response_command(Command.GET_INFO), sequence + 1, info_payload)
        transport.receiver(unknown)
        final_events = controller.poll_events()
        self.assertEqual(next(event.data.device_id for event in final_events if event.kind == "info"), "DUT")
        diagnostics = [event for event in final_events if event.kind == "diagnostic"]
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(next(event.sequence for event in final_events if event.kind == "info"), valid_sequence)
        controller.disconnect()

    def test_old_callback_already_inside_decoder_cannot_claim_reused_sequence_after_reconnect(self):
        decoders = []

        def decoder_factory():
            decoder = BlockingDecoder()
            decoders.append(decoder)
            return decoder

        first = SilentScriptedTransport()
        second = SilentScriptedTransport()
        transports = iter((first, second))
        with patch("aw_calibrator.controller.StreamDecoder", side_effect=decoder_factory):
            controller = CalibrationController(
                sequence_start=1,
                serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
            )
            controller.connect_serial("COM11", 115200)
            old_sequence = controller.read_info()
            old_request = first.requests[-1]
            old_decoder = decoders[-1]
            old_decoder.armed = True
            callback_done = threading.Event()
            old_payload = pack_device_info(DeviceInfo(Status.OK, "OLD", "1"))
            callback_thread = threading.Thread(
                target=lambda: (first.reply(old_request, old_payload), callback_done.set()),
            )
            callback_thread.start()
            self.assertTrue(old_decoder.entered.wait(1.0))

            controller.connect_serial("COM12", 115200)
            new_sequence = controller.read_info()
            self.assertEqual(new_sequence, old_sequence)
            new_request = second.requests[-1]
            old_decoder.release.set()
            self.assertTrue(callback_done.wait(1.0))
            callback_thread.join(1.0)
            self.assertNotIn("info", kinds(controller.poll_events()))

            second.reply(new_request, pack_device_info(DeviceInfo(Status.OK, "NEW", "2")))
            events = controller.poll_events()
            self.assertEqual(next(event.data.device_id for event in events if event.kind == "info"), "NEW")
            controller.disconnect()

    def test_disconnect_closes_transport_promptly_to_unblock_write_with_one_terminal_outcome(self):
        clock = ManualClock()
        transport = CloseUnblocksWriteTransport()
        controller = CalibrationController(
            clock=clock,
            request_timeout_s=0.5,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM13", 115200)
        controller.poll_events()
        request_done = threading.Event()
        sequence_holder = []

        def send_request():
            sequence_holder.append(controller.read_info())
            request_done.set()

        request_thread = threading.Thread(target=send_request)
        request_thread.start()
        self.assertTrue(transport.write_entered.wait(1.0))
        disconnect_done = threading.Event()
        disconnect_thread = threading.Thread(target=lambda: (controller.disconnect(), disconnect_done.set()))
        disconnect_thread.start()
        self.assertTrue(transport.close_called.wait(0.2))
        self.assertTrue(disconnect_done.wait(0.2))
        self.assertTrue(request_done.wait(1.0))
        request_thread.join(1.0)
        disconnect_thread.join(1.0)
        sequence = sequence_holder[0]
        events = controller.poll_events()
        terminal = [event for event in events if event.sequence == sequence and event.kind in ("info", "error", "request_timeout")]
        self.assertEqual([(event.kind, event.data["reason"]) for event in terminal], [("error", "disconnected")])
        clock.advance(1.0)
        self.assertFalse(any(event.sequence == sequence for event in controller.poll_events()))

    def test_transport_write_can_wait_for_cross_thread_callback_without_lock_inversion(self):
        transport = CrossThreadCallbackTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM17", 115200)
        controller.poll_events()
        request_done = threading.Event()

        def read_info():
            controller.read_info()
            request_done.set()

        request_thread = threading.Thread(target=read_info)
        request_thread.start()
        self.assertTrue(request_done.wait(0.2))
        self.assertTrue(transport.callback_finished.is_set())
        request_thread.join(1.0)
        events = controller.poll_events()
        self.assertEqual(next(event.data.device_id for event in events if event.kind == "info"), "THREAD")
        self.assertNotIn("error", kinds(events))
        controller.disconnect()

    def test_error_callback_during_open_aborts_connecting_generation_once(self):
        transports = []

        def factory(port, baudrate, error_callback):
            transport = OpenCallbackFailureTransport(error_callback)
            transports.append(transport)
            return transport

        controller = CalibrationController(serial_transport_factory=factory)
        controller.connect_serial("COM18", 115200)
        events = controller.poll_events()
        self.assertNotIn("connected", kinds(events))
        transport_errors = [event for event in events if event.kind == "error"]
        self.assertEqual(len(transport_errors), 1)
        self.assertIn("reader died during open", transport_errors[0].data["reason"])
        self.assertTrue(transports[0].close_called.is_set())
        with self.assertRaisesRegex(RuntimeError, "not connected"):
            controller.read_info()

    def test_automatic_stream_write_failure_closes_and_aborts_connection_once(self):
        transport = StreamWriteFailureTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM19", 115200)
        events = controller.poll_events()
        errors = [event for event in events if event.kind == "error"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].data["reason"], "stream setup failed")
        self.assertTrue(transport.close_called.is_set())
        with self.assertRaisesRegex(RuntimeError, "not connected"):
            controller.read_info()

    def test_background_serial_write_failure_closes_and_fails_pending_request(self):
        serial_port = AsyncWriteFailureSerial()

        def factory(port, baudrate, error_callback):
            return SerialTransport(
                port,
                baudrate,
                serial_factory=lambda **kwargs: serial_port,
                error_callback=error_callback,
            )

        controller = CalibrationController(serial_transport_factory=factory)
        controller.connect_serial("COM-ASYNC-CONTROLLER", 115200)
        self.assertTrue(serial_port.stream_written.wait(1.0))
        controller.poll_events()

        sequence = controller.read_info()

        self.assertTrue(serial_port.closed.wait(1.0))
        events = controller.poll_events()
        transport_errors = [
            event for event in events
            if event.kind == "error" and event.data.get("operation") == "transport"
        ]
        request_errors = [
            event for event in events
            if event.kind == "error" and event.data.get("operation") == "read_info"
        ]
        self.assertEqual(len(transport_errors), 1)
        self.assertIn("background serial write failed", transport_errors[0].message)
        self.assertEqual(
            [(event.sequence, event.data["reason"]) for event in request_errors],
            [(sequence, "disconnected")],
        )
        self.assertEqual(kinds(events).count("disconnected"), 1)
        self.assertEqual(events[-1].data.get("operation"), "transport")

    def test_serial_write_timeout_message_explains_firmware_and_port_checks(self):
        serial_timeout = type("SerialTimeoutException", (Exception,), {})

        message = CalibrationController._describe_transport_error(
            serial_timeout("Write timeout")
        )

        self.assertIn("串口写入超时", message)
        self.assertIn("配套固件", message)
        self.assertIn("串口工具", message)

    def test_stale_open_completion_closes_outside_state_lock(self):
        stale_holder = []
        replacement = ScriptedTransport()
        factory_calls = 0
        stale_created = threading.Event()

        def factory(port, baudrate, error_callback):
            nonlocal factory_calls
            factory_calls += 1
            if factory_calls == 1:
                stale = StaleCleanupTransport(error_callback)
                stale_holder.append(stale)
                stale_created.set()
                return stale
            return replacement

        controller = CalibrationController(serial_transport_factory=factory)
        first_connect_done = threading.Event()
        first_connect = threading.Thread(
            target=lambda: (controller.connect_serial("COM20", 115200), first_connect_done.set()),
        )
        first_connect.start()
        self.assertTrue(stale_created.wait(1.0))
        stale = stale_holder[0]
        self.assertTrue(stale.open_entered.wait(1.0))

        controller.connect_serial("COM21", 115200)
        stale.release_open.set()
        self.assertTrue(first_connect_done.wait(0.2))
        self.assertTrue(stale.second_close_finished.is_set())
        first_connect.join(1.0)

        controller.poll_events()
        sequence = controller.read_info()
        replacement.reply(
            replacement.requests[-1],
            pack_device_info(DeviceInfo(Status.OK, "CURRENT", "2")),
        )
        events = controller.poll_events()
        self.assertEqual(next(event.data.device_id for event in events if event.kind == "info"), "CURRENT")
        self.assertEqual(next(event.sequence for event in events if event.kind == "info"), sequence)
        controller.disconnect()

    def test_response_at_exact_deadline_is_timeout_and_cannot_also_succeed(self):
        clock = ManualClock()
        transport = ScriptedTransport()
        controller = CalibrationController(
            clock=clock,
            request_timeout_s=0.5,
            read_retry_count=0,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM14", 115200)
        controller.poll_events()
        sequence = controller.read_info()
        request = transport.requests[-1]
        clock.value = 0.5
        transport.reply(request, pack_device_info(DeviceInfo(Status.OK, "TOO-LATE", "1")))
        events = controller.poll_events()
        self.assertNotIn("info", kinds(events))
        terminal = [event for event in events if event.sequence == sequence and event.kind in ("info", "error", "request_timeout")]
        self.assertEqual([event.kind for event in terminal], ["request_timeout"])
        self.assertFalse(any(event.sequence == sequence for event in controller.poll_events()))
        controller.disconnect()

    def test_stream_echo_mismatch_is_error_but_capture_identity_mismatch_is_diagnostic(self):
        stream_transport = StreamEchoMismatchTransport()
        stream_controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: stream_transport,
        )
        stream_controller.connect_serial("COM15", 115200)
        stream_events = stream_controller.poll_events()
        self.assertNotIn("stream_configured", kinds(stream_events))
        self.assertEqual(
            next(event.data["reason"] for event in stream_events if event.kind == "error"),
            "stream response mismatch",
        )
        stream_controller.disconnect()

        capture_transport = ScriptedTransport()
        capture_controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: capture_transport,
        )
        capture_controller.connect_serial("COM16", 115200)
        capture_controller.poll_events()
        sequence = capture_controller.start_capture(2)
        request = capture_transport.requests[-1]
        _point_id, capture_id = unpack_start_capture_request(request.payload)
        capture_transport.reply(request, pack_start_capture_response(Status.OK, 1, capture_id))
        capture_events = capture_controller.poll_events()
        self.assertNotIn("capture_started", kinds(capture_events))
        mismatch = next(event for event in capture_events if event.kind == "diagnostic")
        self.assertEqual(mismatch.sequence, sequence)
        self.assertIn("identity", mismatch.message)

        capture_transport.reply(request, pack_start_capture_response(Status.OK, 2, capture_id))
        started = next(event for event in capture_controller.poll_events() if event.kind == "capture_started")
        self.assertEqual((started.sequence, started.data["point_id"]), (sequence, 2))
        capture_transport.event(
            Command.CAPTURE_RESULT,
            88,
            pack_capture_result(self._result(2, capture_id=capture_id, mean=77.687)),
        )
        accepted = capture_controller.poll_events()
        self.assertIn("capture_result", kinds(accepted))
        capture_controller.disconnect()

    def test_poll_at_exact_deadline_expires_request_with_injected_clock(self):
        clock = ManualClock()
        transport = ScriptedTransport()
        controller = CalibrationController(
            clock=clock,
            request_timeout_s=0.5,
            read_retry_count=0,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM2", 115200)
        sequence = controller.read_parameters()
        controller.poll_events()
        clock.advance(0.49)
        self.assertNotIn("request_timeout", kinds(controller.poll_events()))
        clock.value = 0.5
        timeout = next(event for event in controller.poll_events() if event.kind == "request_timeout")
        self.assertEqual(timeout.sequence, sequence)
        controller.disconnect()

    def test_uint16_sequences_wrap_without_zero_and_exhaustion_never_collides(self):
        wrapping = SequenceRecordingTransport()
        controller = CalibrationController(
            sequence_start=0xFFFF,
            serial_transport_factory=lambda port, baudrate, error_callback: wrapping,
        )
        controller.connect_serial("COM3", 115200)
        self.assertEqual((controller.read_info(), controller.read_parameters()), (1, 2))
        self.assertEqual(wrapping.sequences[:3], [0xFFFF, 1, 2])

        full = SequenceRecordingTransport()
        full_controller = CalibrationController(
            sequence_start=1,
            serial_transport_factory=lambda port, baudrate, error_callback: full,
        )
        full_controller.connect_serial("COM4", 115200)
        for _ in range(0xFFFF):
            full_controller.read_info()
        self.assertEqual(len(set(full.sequences)), 0xFFFF)
        self.assertNotIn(0, full.sequences)
        with self.assertRaisesRegex(RuntimeError, "sequence space exhausted"):
            full_controller.read_info()

    def test_write_waits_for_ok_then_requires_matching_version_flags_and_values(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM5", 115200)
        controller.poll_events()
        write_sequence = controller.write_parameters(0.85, 6.0)
        self.assertEqual(len(transport.requests), 1)
        set_request = transport.requests[0]
        set_response = DeviceParameters(Status.OK, 4, True, False, 0.85, 6.0, 0.0)
        transport.reply(set_request, pack_device_parameters(set_response))
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(transport.requests[1].command, Command.GET_PARAMS)
        self.assertNotEqual(transport.requests[1].sequence, write_sequence)

        mismatch = DeviceParameters(Status.OK, 4, True, False, 0.85001, 6.0, 0.0)
        transport.reply(transport.requests[1], pack_device_parameters(mismatch))
        events = controller.poll_events()
        self.assertNotIn("write_verified", kinds(events))
        mismatch_event = next(event for event in events if event.kind == "error")
        self.assertEqual(mismatch_event.data["reason"], "readback mismatch")
        self.assertEqual(mismatch_event.sequence, write_sequence)

        failed_transport = ScriptedTransport()
        failed = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: failed_transport,
        )
        failed.connect_serial("COM6", 115200)
        failed.poll_events()
        failed.write_parameters(0.85, 6.0)
        failed_transport.reply(failed_transport.requests[0], bytes((Status.STORAGE_ERROR,)))
        self.assertEqual(len(failed_transport.requests), 1)
        self.assertIn("error", kinds(failed.poll_events()))

    def test_write_readback_timeout_reports_the_originating_write_sequence(self):
        clock = ManualClock()
        transport = ScriptedTransport()
        controller = CalibrationController(
            clock=clock,
            request_timeout_s=0.5,
            read_retry_count=0,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-WRITE-TIMEOUT", 115200)
        controller.poll_events()
        write_sequence = controller.write_parameters(0.85, 6.0)
        response = DeviceParameters(Status.OK, 4, True, False, 0.85, 6.0, 0.0)
        transport.reply(transport.requests[0], pack_device_parameters(response))
        readback_sequence = transport.requests[1].sequence
        self.assertNotEqual(readback_sequence, write_sequence)

        clock.advance(0.5)
        timeout = next(event for event in controller.poll_events() if event.kind == "request_timeout")

        self.assertEqual(timeout.sequence, write_sequence)
        self.assertEqual(timeout.data["request_sequence"], readback_sequence)
        self.assertEqual(timeout.data["operation"], "write_readback")
        controller.disconnect()

    def test_write_readback_protocol_error_reports_the_originating_write_sequence(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-WRITE-ERROR", 115200)
        controller.poll_events()
        write_sequence = controller.write_parameters(0.85, 6.0)
        response = DeviceParameters(Status.OK, 4, True, False, 0.85, 6.0, 0.0)
        transport.reply(transport.requests[0], pack_device_parameters(response))
        readback_sequence = transport.requests[1].sequence

        transport.reply(transport.requests[1], bytes((Status.BAD_LENGTH,)))
        error = next(event for event in controller.poll_events() if event.kind == "error")

        self.assertEqual(error.sequence, write_sequence)
        self.assertEqual(error.data["request_sequence"], readback_sequence)
        controller.disconnect()

    def test_simulator_set_notices_stay_ahead_of_nested_readback_verification(self):
        clock = ManualClock()
        simulator = SimulatedTransport(clock=clock, seed=9)
        controller = CalibrationController(clock=clock, simulator_factory=lambda: simulator)
        controller.connect_simulator()
        controller.poll_events()
        controller.write_parameters(0.85, 6.0)
        events = controller.poll_events()
        relevant = [
            (event.kind, event.data.notice_code if event.kind == "notice" else None)
            for event in events
            if event.kind in ("notice", "write_verified")
        ]
        self.assertEqual(relevant, [("notice", 1), ("notice", 2), ("write_verified", None)])
        controller.disconnect()

    def test_disconnect_fails_pending_ignores_late_callback_and_reconnect_starts_clean(self):
        first = ScriptedTransport()
        second = ScriptedTransport()
        transports = iter((first, second))
        controller = CalibrationController(
            sequence_start=1,
            serial_transport_factory=lambda port, baudrate, error_callback: next(transports),
        )
        controller.connect_serial("COM7", 115200)
        controller.poll_events()
        sequence = controller.read_info()
        request = first.requests[-1]
        late_receiver = first.receiver
        controller.disconnect()
        disconnected = controller.poll_events()
        self.assertIn("disconnected", kinds(disconnected))
        self.assertEqual(next(event.sequence for event in disconnected if event.kind == "error"), sequence)

        late_receiver(encode_frame(
            response_command(Command.GET_INFO),
            sequence,
            pack_device_info(DeviceInfo(Status.OK, "LATE", "0")),
        ))
        self.assertEqual(controller.poll_events(), [])

        controller.connect_serial("COM8", 115200)
        self.assertEqual(controller.read_info(), sequence)
        second.reply(
            second.requests[-1],
            pack_device_info(DeviceInfo(Status.OK, "NEW", "2")),
        )
        events = controller.poll_events()
        self.assertEqual(next(event.data.device_id for event in events if event.kind == "info"), "NEW")
        controller.disconnect()

    def test_timeout_cancel_and_sensor_error_stay_history_but_are_excluded_from_report(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM9", 115200)
        controller.poll_events()

        events = []
        result_codes = (1, 2, 3)
        for sequence, code in enumerate(result_codes, 1):
            self._start_capture_ok(controller, transport, 0)
            transport.event(
                Command.CAPTURE_RESULT,
                sequence,
                pack_capture_result(self._result(
                    0,
                    code,
                    mean=38.0 + code,
                    sample_count=10,
                    elapsed_ms=1000,
                )),
            )
            events.extend(controller.poll_events())
        centers = (38.857, 59.780, 77.687, 98.787)
        event_sequence = 10
        for _repeat in range(2):
            for point_id in range(4):
                event_sequence += 1
                self._start_capture_ok(controller, transport, point_id)
                transport.event(
                    Command.CAPTURE_RESULT,
                    event_sequence,
                    pack_capture_result(self._result(point_id, mean=centers[point_id])),
                )
                events.extend(controller.poll_events())
        outcomes = [event.data.result_code for event in events if event.kind == "capture_result"]
        self.assertEqual(outcomes[:3], ["timeout", "cancelled", "sensor_error"])
        self.assertNotIn("report", kinds(events))

        final_events = []
        for point_id in range(4):
            event_sequence += 1
            self._start_capture_ok(controller, transport, point_id)
            transport.event(
                Command.CAPTURE_RESULT,
                event_sequence,
                pack_capture_result(self._result(point_id, mean=centers[point_id])),
            )
            final_events.extend(controller.poll_events())
            if point_id < 3:
                self.assertNotIn("report", kinds(final_events))
        self.assertEqual(kinds(final_events).count("report"), 1)
        controller.disconnect()

    def test_controller_report_uses_raw_means_when_corrected_means_are_different(self):
        transport = ScriptedTransport()
        profile = MasterProfile()
        controller = CalibrationController(
            master_profile=profile,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-RAW-REPORT", 115200)
        controller.poll_events()
        raw_means = (30.0, 50.0, 70.0, 90.0)
        corrected_means = (40.0, 50.0, 60.0, 70.0)
        report_events = []

        for repeat in range(3):
            for point_id in range(4):
                self._start_capture_ok(controller, transport, point_id)
                transport.event(
                    Command.CAPTURE_RESULT,
                    200 + repeat * 4 + point_id,
                    pack_capture_result(CaptureResult(
                        point_id,
                        0,
                        self._active_capture_id,
                        150,
                        15_000,
                        raw_means[point_id],
                        corrected_means[point_id],
                        0.01,
                    )),
                )
                report_events.extend(
                    event for event in controller.poll_events() if event.kind == "report"
                )

        self.assertEqual(len(report_events), 1)
        expected = calculate_report(profile.rh, raw_means)
        incorrect = calculate_report(profile.rh, corrected_means)
        emitted = report_events[0].data
        self.assertEqual(emitted, expected)
        self.assertEqual(controller._session.report, expected)
        self.assertNotEqual(emitted.endpoint.slope_k, incorrect.endpoint.slope_k)
        controller.disconnect()

    def test_malformed_async_payload_and_cal_dew_notices_are_diagnostic_events_only(self):
        transport = ScriptedTransport()
        controller = CalibrationController(
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM10", 115200)
        controller.poll_events()
        transport.event(Command.CAPTURE_RESULT, 1, b"bad")
        transport.event(Command.NOTICE, 2, pack_notice(Notice(1)))
        transport.event(Command.NOTICE, 3, pack_notice(Notice(2)))
        events = controller.poll_events()
        self.assertIn("diagnostic", kinds(events))
        self.assertEqual([event.data.notice_code for event in events if event.kind == "notice"], [1, 2])
        controller.disconnect()

    def test_heartbeat_is_framed_and_background_failures_do_not_pollute_user_errors(self):
        clock = ManualClock()
        transport = ScriptedTransport()
        controller = CalibrationController(
            clock=clock,
            request_timeout_s=1.0,
            serial_transport_factory=lambda port, baudrate, error_callback: transport,
        )
        controller.connect_serial("COM-HB", 115200)
        controller.poll_events()

        sequence = controller.send_heartbeat()
        request = transport.requests[-1]
        self.assertEqual(
            (request.command, request.sequence, request.payload),
            (Command.HEARTBEAT, sequence, b""),
        )
        transport.reply(request, bytes((Status.OK,)))
        self.assertEqual(kinds(controller.poll_events()), ["heartbeat"])

        timeout_sequence = controller.send_heartbeat()
        self.assertEqual(controller.send_heartbeat(), timeout_sequence)
        clock.advance(1.0)
        events = controller.poll_events()
        self.assertNotIn("error", kinds(events))
        self.assertNotIn("request_timeout", kinds(events))
        self.assertIn("diagnostic", kinds(events))

        controller.send_heartbeat()
        controller.disconnect()
        events = controller.poll_events()
        self.assertNotIn("error", kinds(events))
        self.assertIn("disconnected", kinds(events))


class CommunicationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = ManualClock()
        self.transport = ScriptedTransport()
        self.controller = CalibrationController(
            clock=self.clock, request_timeout_s=1.0,
            read_retry_count=2, capture_start_grace_s=3.0,
            serial_transport_factory=lambda port, baudrate, error_callback: self.transport,
        )
        self.controller.connect_serial("COM-RECOVERY", 115200)
        self.controller.poll_events()
        self.addCleanup(self.controller.disconnect)

    def parameters(self, *, k=1.0, b=0.0, calibrated=True):
        return DeviceParameters(Status.OK, 1, True, calibrated, k, b, 0.0)

    def start(self, point=1):
        sequence = self.controller.start_capture(point)
        request = self.transport.requests[-1]
        _, capture_id = unpack_start_capture_request(request.payload)
        return sequence, request, capture_id

    def result(self, capture_id, point=1):
        return CaptureResult(point, 0, capture_id, 150, 15_000, 59.780, 59.780, 0.02)

    def test_read_retries_identical_sequence_and_finishes_once(self):
        sequence = self.controller.read_parameters()
        original = self.transport.requests[-1]
        self.clock.advance(1.0)
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["request_retry"])
        self.assertEqual(events[0].sequence, sequence)
        retry = self.transport.requests[-1]
        self.assertEqual(retry, original)
        self.transport.reply(retry, pack_device_parameters(self.parameters()))
        self.assertEqual(kinds(self.controller.poll_events()), ["parameters"])
        self.transport.reply(original, pack_device_parameters(self.parameters()))
        self.assertEqual(kinds(self.controller.poll_events()), ["diagnostic"])

    def test_late_read_reply_is_accepted_before_overall_budget_without_extra_send(self):
        self.controller.read_parameters()
        self.clock.advance(1.5)
        self.transport.reply(self.transport.requests[-1], pack_device_parameters(self.parameters()))
        self.assertEqual(kinds(self.controller.poll_events()), ["parameters"])
        self.assertEqual(len(self.transport.requests), 1)

    def test_retry_limit_and_final_deadline_are_bounded(self):
        sequence = self.controller.read_parameters()
        for attempt in range(2):
            self.clock.advance(1.0)
            events = self.controller.poll_events()
            self.assertEqual(kinds(events), ["request_retry"])
            self.assertEqual(events[0].data["attempt"], attempt + 2)
        self.clock.advance(1.0)
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["request_timeout"])
        self.assertEqual(events[0].sequence, sequence)
        self.assertEqual(len(self.transport.requests), 3)
        self.transport.reply(self.transport.requests[0], pack_device_parameters(self.parameters()))
        self.assertNotIn("parameters", kinds(self.controller.poll_events()))

    def test_poll_after_final_budget_does_not_send_expired_retry(self):
        self.controller.read_info()
        self.clock.advance(20.0)
        self.assertEqual(kinds(self.controller.poll_events()), ["request_timeout"])
        self.assertEqual(len(self.transport.requests), 1)

    def test_capture_progress_recovers_missing_ack_and_terminal_is_counted_once(self):
        sequence, request, capture_id = self.start()
        progress = CaptureProgress(1, capture_id, 10, 1_000, 59.78, 0.03)
        self.transport.event(Command.CAPTURE_PROGRESS, 99, pack_capture_progress(progress))
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["diagnostic", "capture_started", "capture_progress"])
        self.assertEqual(events[1].sequence, sequence)
        self.clock.advance(1.1)
        self.transport.reply(request, pack_start_capture_response(Status.OK, 1, capture_id))
        self.assertEqual(kinds(self.controller.poll_events()), ["diagnostic"])
        payload = pack_capture_result(self.result(capture_id))
        self.transport.event(Command.CAPTURE_RESULT, 100, payload)
        self.assertEqual(kinds(self.controller.poll_events()), ["capture_result"])
        self.transport.event(Command.CAPTURE_RESULT, 100, payload)
        self.assertEqual(kinds(self.controller.poll_events()), ["diagnostic"])
        self.assertEqual(len(self.controller._session.accepted_runs_by_point[1]), 1)
        self.assertEqual(len(self.transport.requests), 1)

    def test_matching_terminal_alone_can_recover_capture(self):
        sequence, _, capture_id = self.start()
        self.transport.event(Command.CAPTURE_RESULT, 101, pack_capture_result(self.result(capture_id)))
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["diagnostic", "capture_started", "capture_result"])
        self.assertEqual(events[1].sequence, sequence)

    def test_capture_waits_for_delayed_ack_without_resending_start(self):
        sequence, request, capture_id = self.start()
        self.clock.advance(1.0)
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["capture_recovering"])
        self.assertEqual(events[0].sequence, sequence)
        self.clock.advance(1.5)
        self.transport.reply(request, pack_start_capture_response(Status.OK, 1, capture_id))
        self.assertEqual(kinds(self.controller.poll_events()), ["capture_started"])
        self.assertEqual(len(self.transport.requests), 1)

    def test_wrong_identity_and_realtime_stream_cannot_prove_capture_start(self):
        sequence, _, capture_id = self.start()
        self.transport.event(Command.TELEMETRY, 8, pack_telemetry(Telemetry(7, 8, 25.0, 59.0, 59.0, 0.5, 0.5)))
        for point, identity in ((0, capture_id), (1, capture_id ^ 1)):
            self.transport.event(Command.CAPTURE_PROGRESS, 9,
                                 pack_capture_progress(CaptureProgress(point, identity, 10, 1_000, 59.0, 0.03)))
        self.assertNotIn("capture_started", kinds(self.controller.poll_events()))
        self.clock.advance(1.0)
        self.assertEqual(kinds(self.controller.poll_events()), ["capture_recovering"])
        self.clock.advance(3.0)
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["request_timeout"])
        self.assertEqual(events[0].sequence, sequence)
        self.assertTrue(events[0].data["capture_uncertain"])

    def test_capture_result_at_final_deadline_does_not_recover(self):
        _, _, capture_id = self.start()
        self.clock.advance(4.0)
        self.transport.event(Command.CAPTURE_RESULT, 12, pack_capture_result(self.result(capture_id)))
        events = self.controller.poll_events()
        self.assertNotIn("capture_started", kinds(events))
        self.assertNotIn("capture_result", kinds(events))
        self.assertIn("request_timeout", kinds(events))

    def test_write_and_reset_are_never_automatically_replayed(self):
        for command in (lambda: self.controller.write_parameters(0.85, 6.0), self.controller.reset_parameters):
            before = len(self.transport.requests)
            command()
            self.clock.advance(1.0)
            self.assertEqual(kinds(self.controller.poll_events()), ["request_timeout"])
            self.assertEqual(len(self.transport.requests), before + 1)

    def test_write_readback_retries_preserve_original_write_identity(self):
        sequence = self.controller.write_parameters(0.85, 6.0)
        self.transport.reply(self.transport.requests[-1], pack_device_parameters(self.parameters(k=0.85, b=6.0, calibrated=False)))
        original = self.transport.requests[-1]
        self.clock.advance(1.0)
        retry = self.controller.poll_events()[0]
        self.assertEqual((retry.kind, retry.sequence), ("request_retry", sequence))
        self.assertEqual(self.transport.requests[-1], original)
        self.transport.reply(original, pack_device_parameters(self.parameters(k=0.85, b=6.0, calibrated=False)))
        events = self.controller.poll_events()
        self.assertEqual(kinds(events), ["write_verified"])
        self.assertEqual(events[0].sequence, sequence)
        self.assertEqual(sum(request.command == Command.SET_PARAMS for request in self.transport.requests), 1)

    def test_disconnect_during_retry_notification_cancels_unsent_retry(self):
        self.controller.read_info()
        original_emit = self.controller._emit

        def disconnect_on_retry(kind, *args, **kwargs):
            original_emit(kind, *args, **kwargs)
            if kind == "request_retry":
                self.controller.disconnect()

        self.controller._emit = disconnect_on_retry
        self.clock.advance(1.0)
        # A real disconnect can race with retry scheduling; no frame may be sent on the retired transport.
        self.controller.poll_events()
        self.assertEqual(len(self.transport.requests), 1)


if __name__ == "__main__":
    unittest.main()
