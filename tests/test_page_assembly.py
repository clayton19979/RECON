"""index.html is assembled from parts now; these hold the seams together.

The failure mode this guards against is quiet: a dialog partial that never
gets spliced in leaves the app with a button that opens nothing, and no error
anywhere. app/pages.py raises if the marker is gone, but nothing else notices
if a partial stops being a dialog, if two partials claim the same id, or if
someone puts a new dialog straight back into index.html.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.pages import DIALOG_MARKER, dialog_files, render_index

STATIC = Path(__file__).resolve().parent.parent / "static"
INDEX = STATIC / "index.html"


def test_index_holds_the_marker_and_no_dialogs_of_its_own():
    """A dialog added inline would work in the browser and be invisible to the
    per-file layout -- the exact drift that made this file 1,483 lines."""
    template = INDEX.read_text(encoding="utf-8")
    assert DIALOG_MARKER in template, f"index.html lost its {DIALOG_MARKER}"
    # `<dialog id=` rather than `<dialog`, so prose about dialogs stays legal.
    assert "<dialog id=" not in template, "a <dialog> is inline in index.html -- it belongs in static/dialogs/"


def test_every_partial_is_one_dialog_named_after_its_file():
    """The filename is how you find a dialog's markup; it has to be true."""
    files = dialog_files(STATIC)
    assert len(files) >= 15, f"only {len(files)} dialog partials found -- did some get lost?"
    for path in files:
        body = path.read_text(encoding="utf-8")
        opens = re.findall(r"<dialog id=\"([-\w]+)\">", body)
        assert len(opens) == 1, f"{path.name} holds {len(opens)} dialogs; one file, one dialog"
        assert body.count("</dialog>") == 1, f"{path.name} has an unbalanced </dialog>"
        assert opens[0] == path.stem, f"{path.name} contains #{opens[0]} -- name the file after the dialog"


def test_assembly_produces_every_dialog_exactly_once():
    page = render_index(STATIC)
    ids = re.findall(r"<dialog id=\"([-\w]+)\">", page)
    assert sorted(ids) == sorted({p.stem for p in dialog_files(STATIC)})
    assert len(ids) == len(set(ids)), "the assembled page repeats a dialog"
    assert page.count("<dialog id=") == page.count("</dialog>"), "assembled page has unbalanced dialog tags"
    assert DIALOG_MARKER not in page, "the marker survived assembly"


def test_dialogs_land_between_the_views_and_the_scripts():
    """Position isn't arbitrary: the app's wiring runs on DOMContentLoaded and
    queries these by id, so they have to be parsed before the module script."""
    page = render_index(STATIC)
    first_dialog = page.index("<dialog")
    assert first_dialog > page.index('id="view-vehicles"'), "dialogs are parsed before the views they belong to"
    assert first_dialog < page.index("/assets/js/main.js"), "the app script is parsed before the dialogs exist"
