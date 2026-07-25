"""Static front-end integrity checks.

The UI is plain HTML/CSS/JS with no build step, so nothing catches a selector
that points at an element which was renamed or deleted -- it just silently
returns null and the feature stops working at runtime, usually on a screen
nobody opened that day. These tests are the missing compile step: they hold
app.js and index.html to each other, and hold the rail's navigation to the
views it claims to switch between.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parent.parent / "static"
APP_JS = STATIC / "app.js"
INDEX_HTML = STATIC / "index.html"

# IDs that app.js legitimately looks up but index.html never declares, because
# they're created at runtime. Keep this list short and explain every entry --
# a growing allowlist means the real check is being eroded.
RUNTIME_CREATED_IDS: set[str] = set()


@pytest.fixture(scope="module")
def js() -> str:
    return APP_JS.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def html() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def declared_ids(html: str) -> set[str]:
    return set(re.findall(r'id="([^"]+)"', html))


def referenced_ids(js: str) -> dict[str, int]:
    """Every `$("#foo")` / `$$("#foo .bar")` lookup, keyed by the leading id."""
    found: dict[str, int] = {}
    for match in re.finditer(r'\$\$?\(\s*"(#[A-Za-z0-9_-]+)', js):
        name = match.group(1)[1:]
        found[name] = found.get(name, 0) + 1
    return found


def test_every_referenced_element_id_exists(js: str, declared_ids: set[str]) -> None:
    """A `$("#thing")` that resolves to null is a feature that silently does
    nothing -- there's no error until something dereferences it."""
    missing = sorted(set(referenced_ids(js)) - declared_ids - RUNTIME_CREATED_IDS)
    assert not missing, "app.js looks up element ids that index.html doesn't define: " + ", ".join(f"#{m}" for m in missing)


def test_rail_navigation_targets_real_views(html: str) -> None:
    """Each rail button switches to `view-<data-view>`; a typo there produces a
    nav button that blanks the screen instead of navigating."""
    nav_targets = set(re.findall(r'class="rail-item[^"]*"\s+data-view="([^"]+)"', html))
    view_ids = set(re.findall(r'class="view[^"]*"\s+id="view-([^"]+)"', html))
    assert nav_targets, "no rail navigation buttons found -- has the markup changed?"
    assert nav_targets <= view_ids, f"rail buttons point at views that don't exist: {sorted(nav_targets - view_ids)}"


def test_stylesheets_and_scripts_referenced_by_index_exist(html: str) -> None:
    """index.html hardcodes /assets/... paths that are served straight off
    disk, so a renamed file 404s with no other warning."""
    for asset in re.findall(r'(?:href|src)="/assets/([^"]+)"', html):
        assert (STATIC / asset).is_file(), f"index.html references /assets/{asset}, which is missing from static/"


def test_no_duplicate_element_ids(html: str) -> None:
    """Duplicate ids make `$("#x")` return whichever came first, which is a
    genuinely confusing class of bug to track down by hand."""
    all_ids = re.findall(r'id="([^"]+)"', html)
    duplicates = sorted({name for name in all_ids if all_ids.count(name) > 1})
    assert not duplicates, f"index.html declares these ids more than once: {duplicates}"


def test_empty_states_go_through_the_shared_component(js: str) -> None:
    """Empty states used to be hand-rolled inline-styled one-liners at each
    call site, which is how the copy and spacing drifted apart. Keep new ones
    going through emptyState()/emptyRow() rather than reintroducing that."""
    strays = re.findall(r'color:var\(--ink-faint\);font-size:[^"]*"[^>]*>\s*No ', js)
    assert not strays, f"{len(strays)} inline-styled empty state(s) found -- use emptyState() or emptyRow() instead"
