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
# Vehicles board
#
# The board's header lives in index.html and its rows are emitted from a
# template literal in app.js, with a third copy of the column count in the
# empty state's colspan. Nothing connects the three, so adding a column in one
# place shifts every cell in the rows below the header, or leaves the empty
# state short of the table's width.
# ---------------------------------------------------------------------------

def _vehicles_thead(html: str) -> str:
    section = html[html.index('id="view-vehicles"'):]
    return section[section.index("<thead"):section.index("</thead>")]


def _function_source(js: str, name: str) -> str:
    start = js.index(f"function {name}(")
    end = js.index("\nfunction ", start + 1)
    return js[start:end]


def test_board_row_cells_match_the_header(js: str, html: str) -> None:
    """A row a cell out of step with its header puts every number under the
    wrong label -- and Cost and Quoted sit next to each other."""
    columns = len(re.findall(r"<th\b", _vehicles_thead(html)))
    cells = len(re.findall(r"<td\b", _function_source(js, "vehicleRowHtml")))
    assert columns == cells, f"the vehicles header has {columns} columns but vehicleRowHtml emits {cells} cells"


def _board_columns(js: str) -> int:
    declared = re.search(r"^const BOARD_COLUMNS = (\d+);", js, re.M)
    assert declared, "BOARD_COLUMNS is gone -- the skeleton and empty state have no shared width"
    return int(declared.group(1))


def test_board_columns_constant_matches_the_header(js: str, html: str) -> None:
    """The one number the loading skeleton and the empty state are both built
    from. Adding a <th> without bumping it is the mistake it exists to catch --
    exactly what happened when the Parts column went in."""
    columns = len(re.findall(r"<th\b", _vehicles_thead(html)))
    assert _board_columns(js) == columns, (
        f"BOARD_COLUMNS is {_board_columns(js)} but the vehicles header has {columns} columns"
    )


def test_board_empty_state_spans_the_whole_table(js: str) -> None:
    assert re.search(r"emptyRow\(BOARD_COLUMNS, vehiclesEmptyState\(\)\)", js), (
        "the vehicles empty state no longer spans BOARD_COLUMNS -- a hardcoded "
        "colspan goes stale the next time a column is added"
    )


def test_board_loading_skeleton_matches_the_header(js: str) -> None:
    """The skeleton is the first thing drawn on every load; a short one makes
    the table visibly jump a column wider the moment the data lands."""
    assert re.search(r'vehicles:\s*\[\["#vehicles-table",\s*BOARD_COLUMNS\]\]', js), (
        "the vehicles loading placeholder no longer draws BOARD_COLUMNS columns"
    )


def test_every_sortable_header_has_a_comparator(js: str, html: str) -> None:
    """A `data-sort-key` with no VEHICLE_SORTS entry is a header that looks
    clickable, highlights when clicked, and sorts nothing."""
    declared = set(re.findall(r'data-sort-key="([^"]+)"', _vehicles_thead(html)))
    block = js[js.index("const VEHICLE_SORTS"):js.index("function sortVehicleRows")]
    comparators = set(re.findall(r"^\s{2}(\w+): \{ label:", block, re.M))
    assert declared, "no sortable headers found on the vehicles board"
    assert declared == comparators, (
        f"sortable headers without a comparator: {sorted(declared - comparators)}; "
        f"comparators no header can reach: {sorted(comparators - declared)}"
    )


def test_board_rows_are_not_wired_one_by_one(js: str) -> None:
    """Board rows are recycled between renders now, so a listener bound per row
    would either double up or be lost depending on whether that row survived
    the last render. Everything goes through the delegated handler."""
    strays = re.findall(r"\.addEventListener\(", _function_source(js, "renderVehiclesTable"))
    assert not strays, (
        f"{len(strays)} addEventListener call(s) inside renderVehiclesTable -- board row events "
        "belong in the delegated handler in wireVehiclesView()"
    )


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
    STATIC_VIEWS: set[str] = set()  # every rail view fetches something on open
    assert nav_targets - loaders <= STATIC_VIEWS, f"rail views with no loader: {sorted(nav_targets - loaders - STATIC_VIEWS)}"


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def test_every_report_sort_key_in_the_markup_has_a_spec(js: str) -> None:
    """A th whose data-report-sort doesn't match a REPORT_SORTS entry looks
    sortable, clicks, and then sorts by nothing at all."""
    block = js[js.index("const REPORT_SORTS"):js.index("function sortReportRows")]
    specced = set(re.findall(r"^\s{4}(\w+):\s*\{", block, re.M))
    used = set(re.findall(r'reportSortHeader\("[\w-]+",\s*"(\w+)"', js))
    assert used, "no reportSortHeader calls found"
    assert used <= specced, f"report columns sorted by an undefined key: {sorted(used - specced)}"


def test_report_sort_specs_are_partitioned_by_shape(js: str) -> None:
    """The two report shapes have different columns, so a key from one is
    meaningless in the other -- generateReport() resets the sort on a shape
    change and needs both tables keyed independently."""
    block = js[js.index("const REPORT_SORTS"):js.index("function sortReportRows")]
    shapes = re.split(r'^  (?:"vehicle-spend"|technicians): \{$', block, flags=re.M)[1:]
    assert len(shapes) == 2, f"expected 2 report shapes in REPORT_SORTS, found {len(shapes)}"
    # Both must offer "cost" -- that's what generateReport falls back to when
    # the saved sort key belongs to the other shape.
    for body in shapes:
        assert re.search(r"^\s{4}cost:", body, re.M), "a report shape has no cost sort to fall back to"


def test_report_controls_refetch_rather_than_waiting_for_a_button(html: str, js: str) -> None:
    """Every control on the screen is live; a leftover Generate button would
    mean two ways to ask the same question, one of which goes stale."""
    assert "report-generate" not in html and "report-generate" not in js
    assert 'id="report-csv"' in html, "the Download CSV link is gone"
    for control in ("report-start", "report-end"):
        assert f'id="{control}"' in html, f"the Reports toolbar lost {control}"

    # Every report the code knows how to build needs a way to ask for it, and
    # every range setReportRange understands needs a chip -- one dropped
    # attribute and an option is simply unreachable.
    types = set(re.findall(r'data-report-type="([\w-]+)"', html))
    titled = set(re.findall(r'^  (?:"([\w-]+)"|(\w+)):\s*"', js[js.index("const REPORT_TITLES"):js.index("const REPORT_SEGMENT")], re.M))
    assert types == {a or b for a, b in titled}, f"report toolbar and REPORT_TITLES disagree: {types}"

    ranges = re.findall(r'data-report-range="(\w+)"', html)
    assert len(ranges) == len(set(ranges)) == 5, f"expected 5 distinct range chips, found {ranges}"
    known = set(re.findall(r'"(\w+)"', re.search(r'const match = \[([^\]]+)\]', js).group(1)))
    assert set(ranges) == known, f"range chips {sorted(ranges)} don't match the ranges the app can detect {sorted(known)}"


def test_board_cards_are_scoped_to_the_visible_rows(js: str) -> None:
    """The bug the board's cards exist to have fixed: they were computed from
    every vehicle in state.vehicles while the table below them was filtered,
    so filtering to We-Owe left a recon count on screen. renderStats has to
    take the rows the table is about to draw, and has to be driven from the
    render rather than from the fetch -- called once at load time it would go
    stale on the very next filter click."""
    assert re.search(r"function renderStats\(rows\)", js), (
        "renderStats no longer takes the visible rows -- it's summarizing something else"
    )
    assert not re.search(r"renderStats\(state\.vehicles\)", js), (
        "renderStats is being handed the whole board again instead of the filtered rows"
    )
    table = _function_source(js, "renderVehiclesTable")
    assert "renderStats(rows)" in table, (
        "renderStats isn't called from renderVehiclesTable, so the cards won't follow the filters"
    )


def test_board_card_elements_all_exist(declared_ids: set[str], js: str) -> None:
    """renderStats writes into eight elements by id; a renamed card silently
    stops updating and shows its placeholder markup forever."""
    written = set(re.findall(r'[$]\("#(stat-[a-z-]+|vehicles-scope)"\)', _function_source(js, "renderStats")))
    assert len(written) >= 5, f"renderStats only writes {written} -- did the cards move?"
    missing = written - declared_ids
    assert not missing, f"renderStats writes into ids index.html doesn't declare: {sorted(missing)}"


def test_over_quote_rule_has_exactly_one_definition(js: str) -> None:
    """The Over Quote card counts the cars whose Cost cell is red. Two copies
    of the 10%-past-estimate rule is two chances for the count and the
    coloring to disagree, which makes both of them useless."""
    assert len(re.findall(r"quoted_cost \* 1\.1", js)) == 1, (
        "the over-quote threshold appears more than once -- isOverQuote should be the only definition"
    )
    assert "isOverQuote(v) ? \"over-quote\"" in js, "costCellClass no longer defers to isOverQuote"


def test_parts_filter_toggle_is_not_a_segment_chip(js: str, html: str) -> None:
    """The 'Waiting on parts' toggle sits in the same row as the four
    mutually exclusive segment chips and carries the same .chip class. Both
    the radio-group wiring and the prefs loader select those chips by class,
    so an unscoped selector either clears the toggle on every segment click
    or lights it up on every page load. Both must ask for [data-filter]."""
    assert 'id="vehicles-parts-filter"' in html, "the parts toggle is gone from the board toolbar"
    assert 'data-filter' not in re.search(
        r'<button[^>]*id="vehicles-parts-filter"[^>]*>', html
    ).group(0), "the parts toggle grew a data-filter and will be treated as a fifth segment"
    unscoped = re.findall(r'\$\$\("#view-vehicles \.filters \.chip"\)', js)
    assert not unscoped, (
        "a segment-chip selector isn't scoped to [data-filter] and will sweep up the parts toggle"
    )
    assert len(re.findall(r'\$\$\("#view-vehicles \.filters \.chip\[data-filter\]"\)', js)) >= 3, (
        "the segment chips are no longer selected by [data-filter] in all three places"
    )


def test_board_view_preferences_round_trip_every_filter(js: str) -> None:
    """Anything the toolbar can change has to survive a refresh, and has to
    count toward whether Reset view is offered -- a filter that persists but
    doesn't light up Reset leaves the advisor with a narrowed board and no
    visible way back."""
    save = _function_source(js, "saveVehicleViewPrefs")
    load = _function_source(js, "loadVehicleViewPrefs")
    for key in ("filter", "status", "sort", "partsOnly"):
        assert key in save, f"{key} isn't persisted with the board's view preferences"
    assert "partsOnly" in load, "the parts toggle is saved but never restored"
    assert "state.vehiclePartsOnly" in save, "Reset view won't appear for a board filtered to parts-only"


def test_idle_column_is_wired_end_to_end(js: str, html: str) -> None:
    """The Idle column is a header, a sort comparator and a cell renderer that
    have to agree, and it must read idle_days rather than age_days -- they're
    different questions and the two columns sit next to each other."""
    header = re.search(r'<th[^>]*data-sort-key="idle"[^>]*>', html)
    assert header, "the board has no Idle column header"
    assert "sortable" in header.group(0), "the Idle column isn't sortable"
    assert re.search(r'idle:\s*\{[^}]*value:\s*\(v\)\s*=>\s*v\.idle_days', js), (
        "the Idle sort comparator doesn't read idle_days"
    )
    assert "idleCellHtml(v)" in _function_source(js, "vehicleRowHtml"), "the Idle cell isn't rendered"
    assert "v.idle_days" in _function_source(js, "idleCellHtml"), "the Idle cell doesn't read idle_days"
    assert "idle_days" in _function_source(js, "vehicleRowSignature"), (
        "idle_days isn't in the row signature, so a row whose idle time changed won't re-render"
    )


def test_idle_severity_and_buckets_share_one_set_of_thresholds(js: str) -> None:
    """A row's color and the bar it lands in are two renderings of one rule. If
    idleClass carried its own numbers they would drift, and the chart's count
    would stop matching the coloured cells under it -- the same trap the
    over-quote card already has a test for."""
    idle_class = _function_source(js, "idleClass")
    assert "idleBucket(days)" in idle_class, "idleClass has its own thresholds instead of using the buckets"
    assert not re.search(r"days\s*>=\s*\d+", idle_class), (
        "idleClass compares day counts directly -- that's a second copy of the bucket boundaries"
    )
    buckets = re.search(r"const IDLE_BUCKETS = \[(.*?)\];", js, re.S)
    assert buckets, "IDLE_BUCKETS is gone"
    keys = re.findall(r'key:\s*"([a-z]+)"', buckets.group(1))
    assert keys == ["today", "recent", "stale", "cold", "frozen"], f"the idle buckets changed shape: {keys}"


def test_board_chart_bars_are_filters(js: str, html: str) -> None:
    """A chart that reports "6 cars idle 14+ days" and gives you no way to see
    which six is decoration. Every bar carries the bucket it stands for, and
    the chart is counted over the board *minus* the idle filter so selecting a
    bucket doesn't collapse the chart that selected it."""
    assert 'id="vehicles-chart"' in html, "the board's chart container is gone"
    assert 'id="vehicles-chart-toggle"' in html, "the chart has no show/hide control"
    chart = _function_source(js, "renderIdleChart")
    assert "data-idle-bucket=" in chart, "the chart's bars don't carry their bucket"
    assert 'role="button"' in chart and "tabindex=" in chart, "the bars aren't reachable or announced as buttons"
    assert "visibleVehicles({ ignoreIdle: true })" in chart, (
        "the chart counts over the idle-filtered rows, so picking a bucket collapses it to one bar"
    )
    assert "ignoreIdle" in _function_source(js, "visibleVehicles"), (
        "visibleVehicles no longer honours ignoreIdle"
    )


def test_hiding_the_board_chart_clears_its_filter(js: str) -> None:
    """The bucket filter can only be seen and cleared from the chart, so
    collapsing the chart while one is applied would leave rows missing with
    nothing on screen explaining why."""
    wiring = _function_source(js, "wireVehiclesView")
    assert re.search(r"state\.vehicleChartOpen = !state\.vehicleChartOpen;\s*(?://[^\n]*\n\s*)*"
                     r"if \(!state\.vehicleChartOpen\) state\.vehicleIdleBucket = \"\";", wiring), (
        "hiding the activity chart doesn't clear the idle filter it owns"
    )


def test_idle_bucket_filter_round_trips_with_the_other_preferences(js: str) -> None:
    save = _function_source(js, "saveVehicleViewPrefs")
    load = _function_source(js, "loadVehicleViewPrefs")
    for key in ("idleBucket", "chartOpen"):
        assert key in save, f"{key} isn't persisted with the board's view preferences"
        assert key in load, f"{key} is saved but never restored"
    assert "state.vehicleIdleBucket" in save, "Reset view won't appear for a board filtered to one idle bucket"
    assert "chartOpen" not in re.search(r"const dirty = [^;]+;", save).group(0), (
        "showing or hiding the chart counts as a dirty view -- it hides no rows"
    )
    assert "state.vehicleIdleBucket = \"\";" in _function_source(js, "resetVehicleView"), (
        "Reset view leaves the idle bucket filter applied"
    )
