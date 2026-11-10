"""Exercise streaming plus capture start/progress/cancel; never write calibration."""

from __future__ import annotations

import argparse
import time

from aw_calibrator.controller import CalibrationController
from aw_calibrator.main import configure_communication_logging


def verify(port: str) -> None:
    configure_communication_logging()
    controller = CalibrationController()
    telemetry_count = 0
    last_heartbeat = time.monotonic()
    all_events = []

    def wait_for(kind, *, sequence=None, timeout=5.0):
        nonlocal telemetry_count, last_heartbeat
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now - last_heartbeat >= 2.0:
                controller.send_heartbeat()
                last_heartbeat = now
            for event in controller.poll_events():
                all_events.append(event)
                if event.kind == "telemetry":
                    telemetry_count += 1
                if event.kind in ("error", "request_timeout"):
                    raise RuntimeError(event.message)
            for index, event in enumerate(all_events):
                if event.kind == kind and (sequence is None or event.sequence == sequence):
                    del all_events[index]
                    return event
            time.sleep(0.02)
        raise TimeoutError(f"Missing event {kind}, sequence {sequence}")

    controller.connect_serial(port, 115200)
    try:
        wait_for("stream_configured")
        info = wait_for("info", sequence=controller.read_info()).data
        assert info.firmware_version == "usbfix-1013", info
        before = wait_for("parameters", sequence=controller.read_parameters()).data
        for repeat in range(3):
            for point in range(4):
                started = wait_for("capture_started", sequence=controller.start_capture(point))
                assert started.data["point_id"] == point
                progress = wait_for("capture_progress").data
                assert (progress.point_id, progress.capture_id) == (point, started.data["capture_id"])
                wait_for("capture_cancelled", sequence=controller.cancel_capture())
                terminal = wait_for("capture_result").data
                assert (terminal.point_id, terminal.result_code) == (point, "cancelled"), terminal
                print(f"CAPTURE_OK repeat={repeat + 1} point={point} samples_before_cancel={progress.sample_count}", flush=True)
        for _ in range(30):
            parameters = wait_for("parameters", sequence=controller.read_parameters()).data
            assert parameters == before, (before, parameters)
        assert telemetry_count >= 50, telemetry_count
        assert not any(controller._session.accepted_runs_by_point.values())
        print(f"VERIFIED firmware={info.firmware_version} capture_cycles=12 parameter_reads=31 telemetry={telemetry_count} calibration_unchanged=True", flush=True)
    finally:
        controller.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser(description="实机通信验证：启用实时流并测试四点开始/进度/取消；不修改标定参数")
    parser.add_argument("--port", required=True)
    verify(parser.parse_args().port)


if __name__ == "__main__":
    main()
