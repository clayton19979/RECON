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
# ---------------------------------------------------------------------------
# Parts & Labor grid
#
# The estimate row is a CSS grid whose column tracks live in styles.css while
# its cells are emitted from a template literal in app.js. Nothing connects
# the two, so adding a cell without adding a track (or vice versa) silently
# shifts every column on the densest screen in the app. These pin them
# together, and pin the header row to the data rows it labels.
# ---------------------------------------------------------------------------

STYLES_CSS = STATIC / "styles.css"


@pytest.fixture(scope="module")
def css() -> str:
    return STYLES_CSS.read_text(encoding="utf-8")


def _render_estimate_source(js: str) -> str:
    start = js.index("function renderEstimate(")
    end = js.index("function updateReceiveButtonState(")
    return js[start:end]


def estimate_row_cells(js: str) -> list[str]:
    """Cell names in the order rowHtml() emits them, job column included."""
    return re.findall(r'\n\s+\$\{(?:jobs\.length \? )?cell\("([a-z]+)"', _render_estimate_source(js))


def estimate_head_cells(js: str) -> list[str]:
    head = _render_estimate_source(js)
    head = head[head.index("const headRow"):]
    head = head[: head.index("</div>`;")]
    return re.findall(r'class="pr-cell pr-([a-z]+)"', head)


def test_estimate_header_columns_match_the_data_row(js: str) -> None:
    """A header that's a cell out of step with its rows mislabels every column
    to its right -- and it's the header that tells you which unlabelled number
    box is Qty and which is Cost."""
    rows, head = estimate_row_cells(js), estimate_head_cells(js)
    assert rows, "no cell() calls found in renderEstimate -- has rowHtml changed shape?"
    assert rows == head, f"estimate row cells {rows} don't line up with the header row {head}"


def test_estimate_grid_tracks_match_the_number_of_cells(js: str, css: str) -> None:
    """--pr-cols has to declare exactly as many tracks as there are cells: one
    too few and the extra cell wraps onto a phantom second row."""
    cells = estimate_row_cells(js)
    flat, with_jobs = len(cells) - 1, len(cells)  # the Job cell only renders once a ticket has jobs
    declared = dict(re.findall(r'#vd-estimate-items(\.has-jobs)?\s*\{\s*--pr-cols:\s*([^;]+);', css))
    assert declared, "no --pr-cols declaration found in styles.css"
    assert len(declared[""].split()) == flat, f"--pr-cols declares {len(declared[''].split())} tracks for {flat} cells"
    assert len(declared[".has-jobs"].split()) == with_jobs, (
        f"--pr-cols (.has-jobs) declares {len(declared['.has-jobs'].split())} tracks for {with_jobs} cells"
    )


def test_estimate_rows_are_not_wired_one_by_one(js: str) -> None:
    """renderEstimate() used to bind a dozen listeners per row on every render,
    which is what made an autosave round-trip rip the DOM out from under the
    field being edited. #vd-estimate-items now carries one delegated set,
    wired once -- re-adding per-row binding here reintroduces the focus loss.
    """
    strays = re.findall(r"\.addEventListener\(", _render_estimate_source(js))
    assert not strays, (
        f"{len(strays)} addEventListener call(s) inside renderEstimate -- estimate row "
        "events belong in the delegated handler set in wireEstimateGrid()"
    )


def test_estimate_grid_delegation_is_wired_at_startup(js: str) -> None:
    """The delegated handlers are useless if nothing calls wireEstimateGrid();
    the symptom would be a grid where no field saves at all."""
    assert "function wireEstimateGrid(" in js, "wireEstimateGrid() is gone -- who owns the grid's events now?"
    init = js[js.index("document.addEventListener(\"DOMContentLoaded\""):]
    assert "wireEstimateGrid();" in init, "wireEstimateGrid() is never called from init"


def test_every_estimate_cell_is_reachable_from_css(js: str, css: str) -> None:
    """Each cell's caption/width rules key off its .pr-<name> class; a renamed
    cell just loses its styling with no other symptom."""
    missing = [name for name in set(estimate_row_cells(js)) if f".pr-{name}" not in css]
    assert not missing, f"estimate cells with no .pr-<name> rule in styles.css: {sorted(missing)}"


# ---------------------------------------------------------------------------
# Destructive actions and the error boundary
# ---------------------------------------------------------------------------

def test_destructive_actions_use_the_in_app_confirm(js: str) -> None:
    """window.confirm() renders OS chrome with no room for context and no way
    to mark an action as destructive -- confirmAction() is the replacement."""
    strays = re.findall(r'(?<![.\w])confirm\(', js)
    # confirmAction(...) / settleConfirm(...) / wireConfirmDialog() don't match
    # the pattern above; anything left is a bare window.confirm call.
    assert not strays, f"{len(strays)} raw window.confirm() call(s) left -- use confirmAction() instead"


def test_every_view_loader_can_report_its_own_failure(js: str) -> None:
    """renderViewFailure() paints into VIEW_PLACEHOLDERS, so a loader with no
    placeholder entry can only fall back to a toast that leaves the skeleton
    rows on screen forever."""
    loaders = set(re.findall(r'^\s{2}(\w+): \(\) => load', js[js.index("const VIEW_LOADERS"):js.index("/* ---------- render error boundary")], re.M))
    placeholders = set(re.findall(r'^\s{2}(\w+):\s*\[', js[js.index("const VIEW_PLACEHOLDERS"):js.index("function showPlaceholders")], re.M))
    assert loaders, "no VIEW_LOADERS entries found"
    assert loaders <= placeholders, f"views with a loader but no placeholder/error target: {sorted(loaders - placeholders)}"


def test_rail_views_all_have_a_loader_or_are_static(html: str, js: str) -> None:
    """Clicking a rail button runs runViewLoader(); a view missing from
    VIEW_LOADERS is either static on purpose or a screen that silently never
    fetches anything."""
    nav_targets = set(re.findall(r'class="rail-item[^"]*"\s+data-view="([^"]+)"', html))
    loaders = set(re.findall(r'^\s{2}(\w+): \(\) => load', js[js.index("const VIEW_LOADERS"):js.index("/* ---------- render error boundary")], re.M))
    STATIC_VIEWS = {"reports"}  # renders on demand from its own form, nothing to fetch on open
    assert nav_targets - loaders <= STATIC_VIEWS, f"rail views with no loader: {sorted(nav_targets - loaders - STATIC_VIEWS)}"
