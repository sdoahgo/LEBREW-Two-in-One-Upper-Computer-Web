import logging
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aw_calibrator.main import configure_communication_logging


class CommunicationLoggingTests(unittest.TestCase):
    def test_existing_unrelated_handler_does_not_disable_file_diagnostics(self):
        logger = logging.Logger("test_aw_logging")
        logger.addHandler(logging.NullHandler())
        with tempfile.TemporaryDirectory() as directory:
            with patch("aw_calibrator.main.logging.getLogger", return_value=logger), patch.dict(os.environ, {"LOCALAPPDATA": directory}), patch("aw_calibrator.main.sys.frozen", False, create=True):
                configure_communication_logging()
                configure_communication_logging()
                managed = [h for h in logger.handlers if getattr(h, "aw_communication_log", False)]
                self.assertEqual(len(managed), 1)
                logger.info("SERIAL_PROBE_COMPLETE")
                for handler in logger.handlers:
                    handler.close()
            text = (Path(directory) / "AwCalibrator/logs/communication.log").read_text(encoding="utf-8")
            self.assertIn("START version=2026.10.13-r2", text)
            self.assertIn("SERIAL_PROBE_COMPLETE", text)

    def test_frozen_application_logs_next_to_executable(self):
        logger = logging.Logger("test_aw_portable_logging")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "AwCalibrator.exe"
            with patch("aw_calibrator.main.logging.getLogger", return_value=logger), patch("aw_calibrator.main.sys.frozen", True, create=True), patch("aw_calibrator.main.sys.executable", str(executable)):
                configure_communication_logging()
                for handler in logger.handlers:
                    handler.close()
            self.assertTrue((Path(directory) / "logs/communication.log").is_file())

    def test_log_permission_failure_does_not_prevent_application_start(self):
        logger = logging.Logger("test_aw_no_write")
        with tempfile.TemporaryDirectory() as directory:
            with patch("aw_calibrator.main.logging.getLogger", return_value=logger), patch.dict(os.environ, {"LOCALAPPDATA": directory}), patch("aw_calibrator.main.sys.frozen", False, create=True), patch("aw_calibrator.main.RotatingFileHandler", side_effect=PermissionError("read only")):
                configure_communication_logging()
            self.assertTrue(any(isinstance(h, logging.NullHandler) for h in logger.handlers))
