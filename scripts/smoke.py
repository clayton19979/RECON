"""Boots RECON on a spare port, checks the screens answer, and shuts it down.

    .venv/Scripts/python scripts/smoke.py

Prints one line per endpoint and exits nonzero if any of them failed. Use it
before driving the app by hand -- it catches the "server didn't come up" and
"the board query throws on this data" cases in ten seconds, so browser time is
spent on the things only a person can see.

This is not a substitute for actually using the app. It cannot see a broken
layout or a console error; it only proves the server starts and the endpoints
behind each screen return data.

    --port N   use a specific port (default: an unused one)
    --keep     leave the server running and print the URL
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The endpoint behind each screen, plus the page itself. A screen whose data
# call 500s looks like an empty screen in the browser, not an error.
ENDPOINTS = [
    ("/api/health", "health"),
    ("/", "app page"),
    ("/api/dashboard", "dashboard"),
    ("/api/customers", "customers"),
    ("/api/vehicles", "vehicles"),
    ("/api/orders", "orders"),
]


def python_exe() -> str:
    for candidate in (ROOT / ".venv/Scripts/python.exe", ROOT / ".venv/bin/python"):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for_health(base: str, proc: subprocess.Popen, timeout: float = 45.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False  # died during startup; caller prints its output
        try:
            with urllib.request.urlopen(f"{base}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.4)
    return False


def drain(proc: subprocess.Popen, echo: bool = False) -> deque[str]:
    """Keep reading the server's output so the pipe can never fill up.

    The server's stdout is a pipe to this script, and a pipe nobody reads has
    a small OS buffer -- a few KB. Uvicorn logs a line per request, so a server
    left up with --keep wedged solid after a minute of real use: the buffer
    filled, uvicorn's next log line blocked, and every request from then on
    hung with it. The freeze looked exactly like an app bug, on the one tool
    meant to prove the app works.

    A daemon thread reads lines forever and keeps the recent ones, so startup
    failures can still be shown. With echo the lines also stream through to
    this script's own stdout, which is what --keep wants -- the person driving
    the app sees requests land, same as running uvicorn by hand.
    """
    tail: deque[str] = deque(maxlen=200)

    def pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            tail.append(line)
            if echo:
                sys.stdout.write(line)
                sys.stdout.flush()

    threading.Thread(target=pump, daemon=True).start()
    return tail


def probe(base: str, path: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(f"{base}{path}", timeout=15) as r:
            body = r.read()
            if r.status != 200:
                return False, f"HTTP {r.status}"
            # A JSON endpoint that returns an HTML error page is still a 200.
            if path.startswith("/api/"):
                try:
                    payload = json.loads(body)
                except json.JSONDecodeError:
                    return False, "200 but body was not JSON"
                size = len(payload) if isinstance(payload, list) else len(str(payload))
                return True, f"{len(body)}b, {size} items" if isinstance(payload, list) else f"{len(body)}b"
            return True, f"{len(body)}b"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 -- any failure here is a failed probe
        return False, type(e).__name__


def main() -> int:
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args else free_port()
    keep = "--keep" in args
    base = f"http://127.0.0.1:{port}"

    proc = subprocess.Popen(
        [python_exe(), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    server_output = drain(proc, echo=keep)

    try:
        if not wait_for_health(base, proc):
            print(f"FAIL  server never became healthy on {base}")
            if proc.poll() is not None:
                time.sleep(0.5)  # let the reader thread finish draining a dead process
                if server_output:
                    print("\n--- server output ---")
                    print("".join(server_output).rstrip())
            return 1

        failed = 0
        for path, label in ENDPOINTS:
            ok, detail = probe(base, path)
            if not ok:
                failed += 1
            print(f"{'PASS' if ok else 'FAIL'}  {label:<12} {path:<18} {detail}")

        print(f"\n{'ALL CLEAN' if not failed else str(failed) + ' FAILED'}")
        if keep:
            print(f"\nStill running at {base} -- Ctrl+C here to stop.")
            proc.wait()
        return 1 if failed else 0
    finally:
        if not keep and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
