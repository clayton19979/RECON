"""Runs the jsdom front-end smoke tests (tests/dom/*_smoke.mjs).

Everything else in this suite checks the front end without running it. These
boot index.html + app.js in a real DOM and drive a screen end to end, which is
the only way to catch a render function that throws on every ticket, a sort
comparator that puts blanks first, or a delegated handler that stopped
matching. One test case per screen, discovered from the directory -- dropping
a new <screen>_smoke.mjs beside the others is all it takes to add one.

They need node and jsdom, neither of which the app itself depends on, so they
skip when those are missing rather than failing on a machine that only has
Python. To enable them:

    cd tests/dom && npm install jsdom

or point NODE_PATH at an existing jsdom install.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

DOM_DIR = Path(__file__).resolve().parent / "dom"
LOCAL_MODULES = DOM_DIR / "node_modules"
SMOKE_SCRIPTS = sorted(DOM_DIR.glob("*_smoke.mjs"))


def test_smoke_scripts_are_discovered() -> None:
    """A rename that stops matching *_smoke.mjs would silently run nothing at
    all, and an empty parametrize list still reports as passing."""
    assert SMOKE_SCRIPTS, f"no *_smoke.mjs files found in {DOM_DIR}"


@pytest.mark.parametrize("script", SMOKE_SCRIPTS, ids=lambda p: p.stem)
def test_front_end_screen_runs_in_a_real_dom(script: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed -- see this module's docstring")

    env = dict(os.environ)
    if LOCAL_MODULES.is_dir():
        env["NODE_PATH"] = os.pathsep.join(filter(None, [str(LOCAL_MODULES), env.get("NODE_PATH", "")]))

    result = subprocess.run([node, str(script)], capture_output=True, text=True, env=env, timeout=180)
    if result.returncode != 0 and "Cannot find module 'jsdom'" in result.stderr:
        pytest.skip("jsdom is not installed -- run `npm install jsdom` in tests/dom")
    assert result.returncode == 0, f"{script.name} failed:\n{result.stderr or result.stdout}"
