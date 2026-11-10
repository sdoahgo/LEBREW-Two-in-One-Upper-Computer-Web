"""Command-line entry point for the Tkinter water-activity calibrator."""

from __future__ import annotations

import argparse
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import tkinter as tk

from . import __version__
from .config_store import MasterProfileStore
from .controller import CalibrationController
from .ui import AwCalibratorApp


def configure_communication_logging() -> None:
    logger = logging.getLogger("aw_calibrator")
    if any(getattr(handler, "aw_communication_log", False) for handler in logger.handlers):
        return
    directories = [Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AwCalibrator" / "logs"]
    if getattr(sys, "frozen", False):
        directories.insert(0, Path(sys.executable).parent / "logs")
    for directory in directories:
        try:
            directory.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(
                directory / "communication.log", maxBytes=2_000_000,
                backupCount=2, encoding="utf-8",
            )
            handler.aw_communication_log = True
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
            logger.info("START version=%s executable=%s log=%s", __version__, sys.executable, handler.baseFilename)
            return
        except OSError:
            continue
    # Calibration still works even on a computer that refuses both log locations.
    logger.addHandler(logging.NullHandler())


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ESP32-C6 水活标定系统")
    parser.add_argument("--version", action="version", version=f"AwCalibrator {__version__}")
    parser.add_argument("--simulate", action="store_true", help="使用协议模拟设备")
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="创建真实窗口并自动验证信息、参数和遥测后退出",
    )
    return parser


def run(*, simulate: bool = False, smoke_test: bool = False) -> int:
    configure_communication_logging()
    if smoke_test:
        simulate = True
    try:
        root = tk.Tk()
    except tk.TclError as error:
        print(f"SMOKE_TEST_ERROR: Tcl/Tk window creation failed: {error}", file=sys.stderr)
        return 2

    try:
        store = MasterProfileStore()
        profile = store.load().profile
        controller = CalibrationController(master_profile=profile)
        app = AwCalibratorApp(
            root,
            controller,
            profile_store=store,
            simulate=simulate,
            smoke_test=smoke_test,
        )
        if smoke_test:
            app.start_smoke_test()
        root.mainloop()
    except tk.TclError as error:
        try:
            controller.disconnect()
        except Exception:
            pass
        print(f"SMOKE_TEST_ERROR: Tcl/Tk failure: {error}", file=sys.stderr)
        return 3
    except Exception as error:
        try:
            controller.disconnect()
        except Exception:
            pass
        print(f"SMOKE_TEST_ERROR: {error}", file=sys.stderr)
        return 4

    if smoke_test:
        if app.smoke_succeeded:
            print("SMOKE_TEST_OK")
            return 0
        print(f"SMOKE_TEST_ERROR: {app.smoke_error or 'window closed before completion'}", file=sys.stderr)
        return 5
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = build_argument_parser().parse_args(argv)
    return run(simulate=arguments.simulate, smoke_test=arguments.smoke_test)


if __name__ == "__main__":
    raise SystemExit(main())
