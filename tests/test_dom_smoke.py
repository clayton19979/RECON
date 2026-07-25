"""Runs the jsdom front-end smoke test (tests/dom/estimate_smoke.mjs).

Everything else in this suite checks the front end without running it. This
one boots index.html + app.js in a real DOM and drives the Parts & Labor grid,
the confirm dialog and the view error boundary, which is the only way to catch
a render function that throws on every ticket.

It needs node and jsdom, neither of which the app itself depends on, so it
skips when they're missing rather than failing on a machine that only has
Python. To enable it:

    cd tests/dom && npm install jsdom

or point NODE_PATH at an existing jsdom install.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "dom" / "estimate_smoke.mjs"
LOCAL_MODULES = SCRIPT.parent / "node_modules"


def test_front_end_renders_in_a_real_dom() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed -- see this module's docstring")

    env = dict(os.environ)
    if LOCAL_MODULES.is_dir():
        env["NODE_PATH"] = os.pathsep.join(filter(None, [str(LOCAL_MODULES), env.get("NODE_PATH", "")]))

    result = subprocess.run([node, str(SCRIPT)], capture_output=True, text=True, env=env, timeout=120)
    if result.returncode != 0 and "Cannot find module 'jsdom'" in result.stderr:
        pytest.skip("jsdom is not installed -- run `npm install jsdom` in tests/dom")
    assert result.returncode == 0, f"front-end smoke test failed:\n{result.stderr or result.stdout}"
