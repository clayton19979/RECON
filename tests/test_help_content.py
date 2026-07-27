"""Help content integrity checks.

Help that has drifted from the app is worse than no help: it reads as
authoritative and sends someone to a button that moved or was renamed. These
tests are what stop that -- same job as test_static_assets.py, applied to the
help topics instead of the markup.

The content is a plain JS array with no build step, so it's parsed here the
same way test_static_assets.py reads app.js: with regexes over the source.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parent.parent / "static"
HELP_CONTENT = STATIC / "help-content.js"
HELP_JS = STATIC / "help.js"
INDEX_HTML = STATIC / "index.html"


@pytest.fixture(scope="module")
def source() -> str:
    return HELP_CONTENT.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def html() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


def _field(block: str, name: str) -> str | None:
    match = re.search(rf'(?:^|\n)\s*{name}:\s*"((?:[^"\\]|\\.)*)"', block)
    return match.group(1) if match else None


def _array(block: str, name: str) -> list[str]:
    match = re.search(rf"(?:^|\n)\s*{name}:\s*\[(.*?)\]", block, re.S)
    return re.findall(r'"((?:[^"\\]|\\.)*)"', match.group(1)) if match else []


@pytest.fixture(scope="module")
def topics(source: str) -> list[dict]:
    body = source[source.index("const HELP_TOPICS"): source.index("const HELP_GROUPS")]
    blocks = re.findall(r"\n  \{\n(.*?)\n  \},", body, re.S)
    parsed = [
        {
            "id": _field(b, "id"),
            "title": _field(b, "title"),
            "view": _field(b, "view"),
            "summary": _field(b, "summary"),
            "aliases": _array(b, "aliases"),
            "steps": _array(b, "steps"),
            "related": _array(b, "related"),
        }
        for b in blocks
    ]
    assert parsed, "no help topics parsed -- has the shape of help-content.js changed?"
    return parsed


@pytest.fixture(scope="module")
def groups(source: str) -> list[dict]:
    body = source[source.index("const HELP_GROUPS"):]
    blocks = re.findall(r"\n  \{\n(.*?)\n  \},", body, re.S)
    return [{"title": _field(b, "title"), "ids": _array(b, "ids")} for b in blocks]


@pytest.fixture(scope="module")
def rail_views(html: str) -> set[str]:
    return set(re.findall(r'class="rail-item[^"]*"\s+data-view="([^"]+)"', html))


def test_every_topic_is_complete(topics: list[dict]) -> None:
    """A topic missing its summary or steps renders as an empty card -- it
    looks like the help simply has nothing to say about that feature."""
    for topic in topics:
        label = topic["id"] or "(topic with no id)"
        for field in ("id", "title", "view", "summary"):
            assert topic[field], f"{label}: missing {field}"
        assert topic["steps"], f"{label}: has no steps"
        assert topic["aliases"], f"{label}: has no aliases, so search can only match its own wording"


def test_topic_ids_are_unique(topics: list[dict]) -> None:
    ids = [t["id"] for t in topics]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    assert not dupes, f"duplicate help topic ids: {dupes}"


def test_topics_point_at_real_screens(topics: list[dict], rail_views: set[str]) -> None:
    """`view` is what the topic's "Take me there" button hands to showView().
    A stale one navigates to a screen that no longer exists, blanking the
    page -- from inside the help, which is the worst place for it."""
    bad = sorted({t["view"] for t in topics if t["view"] not in rail_views})
    assert not bad, f"help topics point at views that aren't in the rail: {bad}"


def test_related_links_resolve(topics: list[dict]) -> None:
    ids = {t["id"] for t in topics}
    broken = sorted({f'{t["id"]} -> {r}' for t in topics for r in t["related"] if r not in ids})
    assert not broken, f"'See also' links pointing at topics that don't exist: {broken}"


def test_every_screen_has_at_least_one_topic(topics: list[dict], rail_views: set[str]) -> None:
    """Someone pressing F1 on a screen with no topics gets the whole manual
    instead of an answer about what they're looking at."""
    covered = {t["view"] for t in topics}
    # The Help screen documents everything else; it doesn't document itself.
    missing = sorted(rail_views - covered - {"help"})
    assert not missing, f"these screens have no help topic: {missing}"


def test_every_topic_appears_in_exactly_one_group(topics: list[dict], groups: list[dict]) -> None:
    """The Help screen renders by group, so a topic in no group is written,
    shipped, searchable by F1 -- and invisible to anyone browsing."""
    grouped = [i for group in groups for i in group["ids"]]
    ids = {t["id"] for t in topics}
    ungrouped = sorted(ids - set(grouped))
    unknown = sorted(set(grouped) - ids)
    duplicated = sorted({i for i in grouped if grouped.count(i) > 1})
    assert not ungrouped, f"topics that no group lists, so the Help screen never shows them: {ungrouped}"
    assert not unknown, f"groups list topics that don't exist: {unknown}"
    assert not duplicated, f"topics listed in more than one group: {duplicated}"


def test_help_js_only_looks_up_ids_that_exist(html: str) -> None:
    """The same guarantee test_static_assets.py gives app.js. help.js builds
    most of its own markup, but the handful of elements it reaches for in
    index.html have to actually be there."""
    js = HELP_JS.read_text(encoding="utf-8")
    declared = set(re.findall(r'id="([^"]+)"', html))
    referenced = set(re.findall(r'getElementById\("([^"]+)"\)', js))
    missing = sorted(referenced - declared)
    assert not missing, "help.js looks up element ids index.html doesn't define: " + ", ".join(missing)


def test_help_screen_is_reachable(html: str, rail_views: set[str]) -> None:
    assert "help" in rail_views, "the Help rail button is gone -- the screen is unreachable by mouse"
    assert 'id="view-help"' in html, "the Help rail button has no view to switch to"
    assert 'id="help-dialog"' in html, "the F1 help overlay markup is missing"
