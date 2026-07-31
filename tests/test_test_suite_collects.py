"""Regression test for a bug in the test suite itself: test_single_instance.py
used to import its ctypes/Windows dependency unconditionally at module level,
so on a Mac or Linux dev machine pytest crashed during collection -- with
"Interrupted: 1 error during collection" -- instead of cleanly skipping the
Windows-only tests. That took the whole suite down, not just those tests."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_single_instance_module_collects_without_error():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "tests/test_single_instance.py"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
