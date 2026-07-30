"""Assembling index.html out of its pieces.

The page's dialogs live one-per-file under `static/dialogs/` rather than
inline, and this is what puts them back together for the browser. It runs per
request, so editing a dialog is still a save-and-refresh away -- the whole
front end stays buildless, which is the property that makes fixing something
on the shop PC at 7am possible at all.

The substitution is deliberately the dumbest thing that works: one marker, one
concatenation, filename order. tests/dom/harness.mjs reimplements it in five
lines of JavaScript for the jsdom tests, and that only stays true while there
is nothing here worth reimplementing.
"""

from __future__ import annotations

from pathlib import Path

DIALOG_MARKER = "<!--DIALOGS-->"


def dialog_files(static: Path) -> list[Path]:
    return sorted((static / "dialogs").glob("*.html"))


def render_index(static: Path) -> str:
    """index.html with every dialog partial spliced in."""
    template = (static / "index.html").read_text(encoding="utf-8")
    if DIALOG_MARKER not in template:
        # Failing loudly beats serving a page whose every modal silently does
        # nothing -- the buttons would all be there and none would open.
        raise RuntimeError(f"index.html is missing its {DIALOG_MARKER} marker")
    dialogs = "\n".join(path.read_text(encoding="utf-8").rstrip("\n") for path in dialog_files(static))
    return template.replace(DIALOG_MARKER, dialogs)
