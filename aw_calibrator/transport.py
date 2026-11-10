"""Byte-oriented real serial transport with ordered background I/O."""

from __future__ import annotations

from collections.abc import Callable
import importlib
import logging
import queue
import threading
from typing import Protocol

_LOGGER = logging.getLogger(__name__)


class ByteTransport(Protocol):
    def open(self) -> None: ...
    def close(self) -> None: ...
    def write(self, data: bytes) -> None: ...
    def set_receiver(self, receiver: Callable[[bytes], None]) -> None: ...


class SerialTransport:
    """Transport framed bytes over pyserial without importing it at module load."""

    _WRITE_QUEUE_CAPACITY = 256
    _WRITE_TIMEOUT_S = 0.5
    _WRITE_STOP = object()

    def __init__(
        self,
        port: str,
        baudrate: int,
        *,
        serial_factory: Callable[..., object] | None = None,
        error_callback: Callable[[Exception], None] | None = None,
    ) -> None:
        self._port = port
        self._baudrate = baudrate
        self._serial_factory = serial_factory or self._default_serial_factory
        self._error_callback = error_callback
        self._receiver: Callable[[bytes], None] | None = None
        self._serial: object | None = None
        self._state_lock = threading.Lock()
        self._reader_stop_event: threading.Event | None = None
        self._reader_thread: threading.Thread | None = None
        self._write_queue: queue.Queue[bytes | object] | None = None
        self._writer_thread: threading.Thread | None = None
        self._generation = 0
        self._failure_reported_generation: int | None = None

    @property
    def reader_thread(self) -> threading.Thread:
        thread = self._reader_thread
        if thread is None:
            raise RuntimeError("transport is not open")
        return thread

    @property
    def writer_thread(self) -> threading.Thread:
        thread = self._writer_thread
        if thread is None:
            raise RuntimeError("transport is not open")
        return thread

    def set_receiver(self, receiver: Callable[[bytes], None]) -> None:
        if not callable(receiver):
            raise TypeError("receiver must be callable")
        with self._state_lock:
            self._receiver = receiver

    def open(self) -> None:
        error: Exception | None = None
        with self._state_lock:
            if self._serial is not None:
                return
            if self._reader_thread is not None and self._reader_thread.is_alive():
                raise RuntimeError("previous serial reader is still stopping")
            if self._writer_thread is not None and self._writer_thread.is_alive():
                raise RuntimeError("previous serial writer is still stopping")
            try:
                serial_port = self._serial_factory(
                    port=self._port,
                    baudrate=self._baudrate,
                    timeout=0.05,
                    write_timeout=self._WRITE_TIMEOUT_S,
                )
            except Exception as caught:
                error = caught
            else:
                self._generation += 1
                generation = self._generation
                stop_event = threading.Event()
                write_queue: queue.Queue[bytes | object] = queue.Queue(
                    maxsize=self._WRITE_QUEUE_CAPACITY
                )
                self._serial = serial_port
                self._reader_stop_event = stop_event
                self._write_queue = write_queue
                self._failure_reported_generation = None
                writer_thread = threading.Thread(
                    target=self._writer_loop,
                    args=(serial_port, generation, stop_event, write_queue),
                    name=f"aw-serial-writer-{self._port}",
                    daemon=True,
                )
                reader_thread = threading.Thread(
                    target=self._reader_loop,
                    args=(serial_port, generation, stop_event),
                    name=f"aw-serial-reader-{self._port}",
                    daemon=True,
                )
                self._writer_thread = writer_thread
                self._reader_thread = reader_thread
                writer_thread.start()
                reader_thread.start()
        if error is not None:
            self._report_error(error)
            raise error

    def close(self) -> None:
        with self._state_lock:
            serial_port = self._serial
            self._serial = None
            stop_event = self._reader_stop_event
            if stop_event is not None:
                stop_event.set()
            write_queue = self._write_queue
            reader_thread = self._reader_thread
            writer_thread = self._writer_thread
            generation = self._generation
        self._wake_writer(write_queue)
        if serial_port is not None:
            try:
                serial_port.close()
            except Exception as error:
                self._report_error_once(error, generation)
        for thread in (reader_thread, writer_thread):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=1.0)

    def write(self, data: bytes) -> None:
        if not isinstance(data, bytes):
            raise TypeError("data must be bytes")
        with self._state_lock:
            serial_port = self._serial
            stop_event = self._reader_stop_event
            write_queue = self._write_queue
            if (
                serial_port is None
                or stop_event is None
                or write_queue is None
                or stop_event.is_set()
            ):
                raise RuntimeError("transport is not open")
            try:
                write_queue.put_nowait(data)
            except queue.Full as error:
                raise RuntimeError("serial write queue is full") from error

    def _writer_loop(
        self,
        serial_port: object,
        generation: int,
        stop_event: threading.Event,
        write_queue: queue.Queue[bytes | object],
    ) -> None:
        while not stop_event.is_set():
            try:
                item = write_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                if item is self._WRITE_STOP or stop_event.is_set():
                    return
                with self._state_lock:
                    current = (
                        self._serial is serial_port
                        and self._generation == generation
                        and self._write_queue is write_queue
                        and not stop_event.is_set()
                    )
                if not current:
                    return
                written = serial_port.write(item)
                _LOGGER.info("SERIAL_WRITE port=%s bytes=%s written=%s hex=%s",
                             self._port, len(item), written, item.hex())
                if written is not None and written != len(item):
                    raise OSError("short serial write")
            except Exception as error:
                if not stop_event.is_set():
                    self._fail(error, serial_port, generation, stop_event)
                return
            finally:
                write_queue.task_done()

    @classmethod
    def _wake_writer(cls, write_queue: queue.Queue[bytes | object] | None) -> None:
        if write_queue is None:
            return
        try:
            write_queue.put_nowait(cls._WRITE_STOP)
        except queue.Full:
            pass

    def _reader_loop(
        self,
        serial_port: object,
        generation: int,
        stop_event: threading.Event,
    ) -> None:
        while not stop_event.is_set():
            try:
                data = serial_port.read(4096)
            except Exception as error:
                if not stop_event.is_set():
                    self._fail(error, serial_port, generation, stop_event)
                return
            if stop_event.is_set():
                return
            if not data:
                continue
            with self._state_lock:
                if (
                    self._serial is not serial_port
                    or self._generation != generation
                    or stop_event.is_set()
                ):
                    return
                receiver = self._receiver
            if receiver is not None:
                try:
                    receiver(bytes(data))
                except Exception as error:
                    self._fail(error, serial_port, generation, stop_event)
                    return

    def _fail(
        self,
        error: Exception,
        serial_port: object,
        generation: int,
        stop_event: threading.Event,
    ) -> None:
        with self._state_lock:
            if self._serial is not serial_port or self._generation != generation:
                return
            self._serial = None
            stop_event.set()
            write_queue = self._write_queue
        self._wake_writer(write_queue)
        try:
            serial_port.close()
        except Exception:
            pass
        self._report_error_once(error, generation)

    def _report_error_once(self, error: Exception, generation: int) -> None:
        with self._state_lock:
            if self._failure_reported_generation == generation:
                return
            self._failure_reported_generation = generation
        self._report_error(error)

    def _report_error(self, error: Exception) -> None:
        callback = self._error_callback
        if callback is not None:
            callback(error)

    @staticmethod
    def _default_serial_factory(**kwargs):
        serial_module = importlib.import_module("serial")
        settings = dict(kwargs)
        requested_port = settings.pop("port")
        serial_port = serial_module.Serial(port=None, **settings)
        try:
            # Match ESP-IDF monitor's no-reset open sequence.  pySerial's
            # defaults assert both CDC control lines; leaving them asserted on
            # ESP USB-Serial/JTAG (VID:PID 303A:1001) can reset the target.
            serial_port.setRTS(True)
            serial_port.setDTR(True)
            serial_port.port = requested_port
            serial_port.open()

            # Release reset first, then boot.  Re-applying DTR after RTS is the
            # usbser.sys workaround used by ESP-IDF on Windows.
            serial_port.setRTS(False)
            serial_port.setDTR(serial_port.dtr)
            serial_port.setDTR(False)
            return serial_port
        except Exception:
            try:
                serial_port.close()
            except Exception:
                pass
            raise
