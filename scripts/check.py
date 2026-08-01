"""Every gate RECON has to pass, in one command.

    .venv/Scripts/python scripts/check.py

Exits 0 only when pytest, ruff check, ruff format --check and pyright are all
clean. On failure it prints that tool's output and nothing else, so a failure
is readable without scrolling past three successes.

This exists because the four commands carried environment trivia that had to be
remembered every time: pytest needs node on PATH or the jsdom tests silently
skip, and the venv's .exe shims are dead (see below). Forgetting either one
produced a run that looked green and wasn't.

    --quick   skip pytest (~3 min) and run only the three fast linters
    --tests   run only pytest
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# What ruff and pyright are pointed at. Kept identical to what the project has
# always checked -- widening this to include scripts/ is a real change to the
# green baseline, so it belongs in its own commit, not hidden in this one.
TARGETS = ["app", "tests", "seed_mock_data.py"]

# The jsdom front-end tests skip themselves when node is missing rather than
# failing, so a machine without node on PATH reports a green suite that never
# ran them. CLAUDE.md calls these tests not optional; this makes that true.
NODE_DIR = Path(r"C:\Program Files\nodejs")


def env_with_node() -> dict[str, str]:
    env = os.environ.copy()
    if NODE_DIR.is_dir() and str(NODE_DIR) not in env.get("PATH", ""):
        env["PATH"] = f"{NODE_DIR}{os.pathsep}{env['PATH']}"
    return env


def python_exe() -> str:
    """The venv interpreter, by path.

    Never the bare `pytest`/`pyinstaller` entry points: those .exe trampolines
    embed the absolute path the venv was created at, and this repo has moved
    (it left OneDrive on 2026-07-28), so they fail to canonicalize. python.exe
    resolves its config relative to itself and survives the move.
    """
    for candidate in (ROOT / ".venv/Scripts/python.exe", ROOT / ".venv/bin/python"):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def run(name: str, argv: list[str]) -> tuple[str, bool, str]:
    # check=False: a failing check is the result this function reports, not an
    # exception -- every check has to run so the summary is complete.
    proc = subprocess.run(
        argv, cwd=ROOT, env=env_with_node(), capture_output=True, text=True,
        encoding="utf-8", errors="replace", check=False,
    )
    return name, proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")


def test_summary(output: str) -> str:
    """The '419 passed, 2 skipped' line, so the count is observed and never
    hardcoded. Baselines written down by hand go stale silently -- both
    improvement skills carried numbers 30-60 tests out of date."""
    hits = re.findall(r"^.*?\d+ (?:passed|failed).*$", output, re.MULTILINE)
    return hits[-1].strip() if hits else ""


def main() -> int:
    args = set(sys.argv[1:])
    py = python_exe()

    checks: list[tuple[str, list[str]]] = []
    if "--quick" not in args:
        checks.append(("pytest", [py, "-m", "pytest", "-q"]))
    if "--tests" not in args:
        checks += [
            ("ruff check", ["uv", "run", "ruff", "check", *TARGETS]),
            ("ruff format", ["uv", "run", "ruff", "format", "--check", *TARGETS]),
            ("pyright", ["uv", "run", "pyright"]),
        ]

    failures: list[tuple[str, str]] = []
    for name, argv in checks:
        print(f"... {name}", flush=True)
        name, ok, output = run(name, argv)
        detail = test_summary(output) if name == "pytest" else ""
        # ASCII only: this output gets redirected to a log by the scheduled
        # improvement task, and a non-cp1252 character lands there as a "?".
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail and ok else ''}")
        if not ok:
            failures.append((name, output))

    for name, output in failures:
        print(f"\n{'=' * 60}\n{name}\n{'=' * 60}\n{output.rstrip()}")

    print(f"\n{'ALL CLEAN' if not failures else str(len(failures)) + ' FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
