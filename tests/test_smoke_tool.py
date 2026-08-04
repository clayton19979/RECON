"""The test-drive tool must never freeze the app it exists to prove.

scripts/smoke.py boots the server with its output on a pipe. A pipe nobody
reads has an OS buffer of a few KB, and uvicorn logs a line per request -- so
a server left up with --keep wedged solid after a minute of real clicking:
the buffer filled, the server's next log line blocked, and every request from
then on hung with it. The freeze looked exactly like an app bug, found on the
one tool whose job is showing the app works.

The fix is a reader thread that drains the pipe for the life of the process.
The test here is the failure in miniature: a child that writes far more than
any pipe buffer holds, which only ever finishes if something is reading.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("smoke", REPO / "scripts" / "smoke.py")
assert _spec is not None and _spec.loader is not None
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

# Far past any OS pipe buffer (a few KB on Windows, 64KB on Linux): a child
# writing this much blocks forever unless the parent is actually reading.
NOISY_CHILD = "import sys\nfor _ in range(20000): sys.stdout.write('x' * 100 + '\\n')"


def test_a_chatty_server_is_drained_rather_than_left_to_block():
    proc = subprocess.Popen(
        [sys.executable, "-c", NOISY_CHILD],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        tail = smoke.drain(proc)
        # Without the drain the child blocks on a full pipe and this wait
        # times out -- which is the app freezing mid-click, in miniature.
        assert proc.wait(timeout=60) == 0, "the child never finished writing"
    finally:
        if proc.poll() is None:
            proc.kill()

    # The reader thread is still swallowing whatever the pipe held when the
    # child exited; give it until EOF rather than asserting mid-drain.
    deadline = time.monotonic() + 30
    while len(tail) < (tail.maxlen or 0) and time.monotonic() < deadline:
        time.sleep(0.05)

    # Keeping recent lines is the point (startup failures get shown), but only
    # recent ones -- two million access-log lines held forever would be the
    # drain's own slow leak on a server left up all day.
    assert tail.maxlen is not None and len(tail) == tail.maxlen


def test_keep_mode_wires_the_drain_in():
    """main() has to route the server through drain() -- a drain that exists
    but isn't attached protects nobody, and the old direct stdout.read() on
    the failure path would fight the reader thread for the same stream."""
    source = (REPO / "scripts" / "smoke.py").read_text(encoding="utf-8")
    assert "drain(proc" in source, "smoke.py no longer attaches the drain to the server process"
    assert "proc.stdout.read()" not in source, "smoke.py reads the server's stdout directly again"
