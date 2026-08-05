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


# The two dialogs with nothing to type in them. confirm-dialog is two buttons
# and a sentence, and picks which button to focus by how dangerous the answer
# is (see confirm.js); shortcuts-dialog is a read-only cheat sheet. Everything
# else is a form somebody fills in, and has to open ready for them to type.
NOTHING_TO_TYPE = {"confirm-dialog", "shortcuts-dialog"}

FIELD = re.compile(r"<(input|select|textarea)\b[^>]*>", re.IGNORECASE)


def test_every_dialog_with_fields_opens_on_one_of_them():
    """Open a box, start typing, and the typing has to land in the box.

    showModal() focuses the first element carrying `autofocus`, and with none
    it falls back to the first focusable thing in the dialog -- which in every
    one of these is the "x" close button in the corner. So the whole app
    opened its forms with the keyboard pointed at Cancel: the first thing
    Clayton or Antonio typed at a new car went nowhere, and every single
    write-up cost a mouse trip to the first field before it could start.

    Declaring it in the markup rather than calling .focus() after each
    showModal() is what keeps it true. Four of the fifteen dialogs used to do
    it by hand and the other eleven were simply forgotten -- there was no one
    place to forget it in.
    """
    for path in dialog_files(STATIC):
        body = path.read_text(encoding="utf-8")
        focused = [m.group(0) for m in FIELD.finditer(body) if re.search(r"\bautofocus\b", m.group(0))]
        if path.stem in NOTHING_TO_TYPE:
            assert not FIELD.search(body), f"{path.name} grew a field -- take it out of NOTHING_TO_TYPE"
            assert not focused, f"{path.name} has nothing to type in, so nothing to focus"
            continue
        assert FIELD.search(body), f"{path.name} has no fields -- add it to NOTHING_TO_TYPE"
        assert len(focused) == 1, (
            f"{path.name} declares {len(focused)} autofocus fields; it needs exactly one, "
            "or it opens with the keyboard on the close button"
        )


def test_the_focused_field_is_never_hidden_or_disabled():
    """A dialog pointed at a field the browser can't focus is the bug again,
    just harder to see: focus falls straight back to the close button."""
    for path in dialog_files(STATIC):
        for match in FIELD.finditer(path.read_text(encoding="utf-8")):
            tag = match.group(0)
            if not re.search(r"\bautofocus\b", tag):
                continue
            for dead in ("disabled", "hidden", 'type="hidden"'):
                assert dead not in tag, f"{path.name} autofocuses a {dead} field: {tag}"


def test_dialogs_land_between_the_views_and_the_scripts():
    """Position isn't arbitrary: the app's wiring runs on DOMContentLoaded and
    queries these by id, so they have to be parsed before the module script."""
    page = render_index(STATIC)
    first_dialog = page.index("<dialog")
    assert first_dialog > page.index('id="view-vehicles"'), "dialogs are parsed before the views they belong to"
    assert first_dialog < page.index("/assets/js/main.js"), "the app script is parsed before the dialogs exist"
