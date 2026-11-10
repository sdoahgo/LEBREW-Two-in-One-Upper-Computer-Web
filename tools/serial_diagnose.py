"""Read-only serial probe: no capture, parameter writes, or reset commands."""

from __future__ import annotations

import argparse
from collections import Counter
import time

from aw_calibrator.protocol import (
    Command, StreamDecoder, encode_frame, response_command,
    unpack_device_info, unpack_device_parameters, pack_set_stream_request,
)
from aw_calibrator.transport import SerialTransport


def probe(port: str, repeats: int = 5, pause_stream: bool = False) -> int:
    decoder = StreamDecoder()
    counts = Counter()
    matched = 0
    serial_port = SerialTransport._default_serial_factory(
        port=port, baudrate=115200, timeout=0.05, write_timeout=0.5,
    )
    def set_stream(enabled: bool, sequence: int) -> None:
        packet = encode_frame(Command.SET_STREAM, sequence, pack_set_stream_request(enabled, 100))
        for attempt in range(3):
            serial_port.write(packet)
            started = time.monotonic()
            while time.monotonic() - started < 1.0:
                raw = serial_port.read(max(1, serial_port.in_waiting))
                for frame in decoder.feed(raw):
                    if frame.command == response_command(Command.SET_STREAM) and frame.sequence == sequence:
                        print(f"STREAM enabled={enabled} attempt={attempt + 1} response={frame.payload.hex()}", flush=True)
                        return
        print(f"STREAM_ACK_MISSING enabled={enabled}", flush=True)
    try:
        if pause_stream:
            set_stream(False, 9_000)
        sequence = 10_000
        for repeat in range(repeats):
            for command in (Command.GET_INFO, Command.GET_PARAMS, Command.HEARTBEAT):
                sequence += 1
                packet = encode_frame(command, sequence)
                started = time.monotonic()
                written = serial_port.write(packet)
                print(f"TX round={repeat + 1} cmd={command.name} seq={sequence} bytes={written} hex={packet.hex()}", flush=True)
                received = False
                while time.monotonic() - started < 1.5:
                    raw = serial_port.read(max(1, serial_port.in_waiting))
                    for frame in decoder.feed(raw):
                        counts[frame.command] += 1
                        if frame.command >= 0x80:
                            print(f"RX cmd=0x{frame.command:02x} seq={frame.sequence} age_ms={(time.monotonic() - started) * 1000:.0f} payload={frame.payload.hex()}", flush=True)
                        if frame.command == response_command(command) and frame.sequence == sequence:
                            matched += 1
                            received = True
                            if command == Command.GET_INFO and len(frame.payload) == 37:
                                print(f"DEVICE {unpack_device_info(frame.payload)}", flush=True)
                            if command == Command.GET_PARAMS and len(frame.payload) == 17:
                                print(f"PARAMS {unpack_device_parameters(frame.payload)}", flush=True)
                    if received:
                        break
                if not received:
                    print(f"NO_MATCH cmd={command.name} seq={sequence}", flush=True)
                time.sleep(0.15)
        print(f"SUMMARY matched={matched}/{repeats * 3} frame_counts={dict(counts)}", flush=True)
        return 0 if matched == repeats * 3 else 1
    finally:
        try:
            if pause_stream:
                set_stream(True, 9_001)
        finally:
            serial_port.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="只读串口诊断：不启动采集、不改标定参数")
    parser.add_argument("--port", required=True)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--pause-stream", action="store_true", help="临时暂停实时发送，结束时恢复 100 ms 实时流；不改变传感器采样")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 20:
        parser.error("repeats must be between 1 and 20")
    return probe(args.port, args.repeats, args.pause_stream)


if __name__ == "__main__":
    raise SystemExit(main())
