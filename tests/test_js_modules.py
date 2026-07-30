"""The missing compile step for the front-end's ES modules.

The DOM smoke tests (tests/test_dom_smoke.py) drive real screens, but they do
it by concatenating the modules into one flat script -- so every name is in
scope there whether it was imported or not. A module that reads another
module's function without importing it passes every one of those tests and
then throws ReferenceError in the actual app, on whichever screen happens to
call it. That is precisely the failure this file exists to catch.
"""

from __future__ import annotations

import re
from pathlib import Path

from tests.js_source import (
    declared_identifiers,
    exported_identifiers,
    imported_identifiers,
    imports_by_source,
    referenced_identifiers,
)

STATIC = Path(__file__).resolve().parent.parent / "static"
JS_DIR = STATIC / "js"
MAIN_JS = JS_DIR / "main.js"


def module_paths() -> list[Path]:
    """Every module main.js pulls in, in import order, main.js last."""
    names = re.findall(r'"\./([-\w]+\.js)"', MAIN_JS.read_text(encoding="utf-8"))
    assert names, "main.js imports nothing -- has the entry point moved?"
    return [JS_DIR / name for name in names] + [MAIN_JS]


def test_every_module_file_is_reachable_from_main() -> None:
    """A module nobody imports is dead code that still looks live on disk."""
    listed = {p.name for p in module_paths()}
    on_disk = {p.name for p in JS_DIR.glob("*.js")}
    assert on_disk - listed == set(), f"module files main.js never imports: {sorted(on_disk - listed)}"
    assert listed - on_disk == set(), f"main.js imports files that don't exist: {sorted(listed - on_disk)}"


def test_cross_module_references_are_imported() -> None:
    """Every name a module borrows has to arrive through an import.

    Without this, the only thing standing between a missing import and a
    ReferenceError in front of an advisor is whether anyone happened to open
    that screen before shipping.
    """
    sources = {p.name: p.read_text(encoding="utf-8") for p in module_paths()}
    # Where each exportable name lives.
    home = {}
    for name, src in sources.items():
        for decl in declared_identifiers(src, top_level_only=True):
            home.setdefault(decl, name)

    problems = []
    for name, src in sources.items():
        # Anything this file binds anywhere (params, locals, destructuring)
        # resolves locally and needs no import.
        local = declared_identifiers(src)
        available = local | imported_identifiers(src)
        for ident in sorted(referenced_identifiers(src) - available):
            owner = home.get(ident)
            if owner and owner != name:
                problems.append(f"{name} uses {ident}() from {owner} without importing it")
    assert not problems, "missing imports:\n" + "\n".join(problems)


def test_every_imported_name_is_actually_exported() -> None:
    """An import of a name the other module doesn't export is a load-time
    SyntaxError that takes the whole app down -- a blank window, not a broken
    screen. The flat-script tests can't see it, because concatenation makes
    every name reachable whether it was exported or not."""
    sources = {p.name: p.read_text(encoding="utf-8") for p in module_paths()}
    exports = {name: exported_identifiers(src) for name, src in sources.items()}
    problems = []
    for name, src in sources.items():
        for source_file, wanted in imports_by_source(src).items():
            assert source_file in exports, f"{name} imports from unknown module {source_file}"
            for missing in sorted(wanted - exports[source_file]):
                problems.append(f"{name} imports {missing} but {source_file} does not export it")
    assert not problems, "imports that would fail at load time:\n" + "\n".join(problems)


def test_no_module_imports_a_name_it_never_uses() -> None:
    """An import that nothing reads is a stale dependency -- it survives the
    deletion of its last call site and makes the module graph read as more
    tangled than it is."""
    problems = []
    for path in module_paths():
        src = path.read_text(encoding="utf-8")
        used = referenced_identifiers(src)
        for ident in sorted(imported_identifiers(src) - used):
            problems.append(f"{path.name} imports {ident} but never uses it")
    assert not problems, "unused imports:\n" + "\n".join(problems)
