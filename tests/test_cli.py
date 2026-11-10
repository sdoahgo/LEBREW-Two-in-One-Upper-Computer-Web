import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CliSmokeTests(unittest.TestCase):
    def test_simulated_gui_smoke_test_finishes_with_marker(self):
        project_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as appdata:
            environment = os.environ.copy()
            environment["APPDATA"] = appdata
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "aw_calibrator.main",
                    "--simulate",
                    "--smoke-test",
                ],
                cwd=project_root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertTrue(completed.stdout.strip().splitlines())
        self.assertEqual(completed.stdout.strip().splitlines()[-1], "SMOKE_TEST_OK")


if __name__ == "__main__":
    unittest.main()
