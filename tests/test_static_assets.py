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

from app.pages import render_index

STATIC = Path(__file__).resolve().parent.parent / "static"
JS_DIR = STATIC / "js"
MAIN_JS = JS_DIR / "main.js"
INDEX_HTML = STATIC / "index.html"


def js_module_order() -> list[Path]:
    """The front-end's modules in main.js import order, main.js last."""
    main = MAIN_JS.read_text(encoding="utf-8")
    names = re.findall(r'"\./([-\w]+\.js)"', main)
    assert names, "main.js imports nothing -- has the entry point moved?"
    return [JS_DIR / name for name in names] + [MAIN_JS]


def flat_app_js() -> str:
    """The modules concatenated back into the flat script they were split
    from: import lines dropped, `export ` prefixes stripped. Module bodies
    are declaration-only by convention (tests/dom/harness.mjs evals this
    same reconstruction), so this is behavior-identical to the old app.js
    and every regex below keeps meaning what it always meant."""
    parts = []
    for path in js_module_order():
        src = path.read_text(encoding="utf-8")
        lines = [ln.removeprefix("export ") for ln in src.split("\n") if not ln.startswith("import ")]
        parts.append("\n".join(lines))
    return "\n;\n".join(parts)


# IDs that app.js legitimately looks up but index.html never declares, because
# they're created at runtime. Keep this list short and explain every entry --
# a growing allowlist means the real check is being eroded.
# Ids that app.js writes into the DOM itself and then looks back up, so
# index.html correctly doesn't declare them.
RUNTIME_CREATED_IDS: set[str] = {
    # rendered into #vd-last-worked, and only for a stalled vehicle
    "vd-worked-nudge",
    # rendered into the staff table's empty state (no rows / no search hits)
    "staff-empty-add",
    "staff-empty-clear",
    # rendered into the customers table's filtered empty state
    "customers-empty-clear",
    # rendered at the tail of the completed-tasks list once it's capped
    "tasks-show-all-completed",
}


@pytest.fixture(scope="module")
def js() -> str:
    return flat_app_js()


@pytest.fixture(scope="module")
def html() -> str:
    """The assembled page, dialogs spliced in -- what a browser actually gets.
    Reading index.html raw would report every dialog's ids as missing."""
    return render_index(STATIC)


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


def test_module_bodies_are_declaration_only() -> None:
    """The DOM harness and this file's js fixture rebuild the flat script by
    concatenating the modules, which is only sound while module bodies declare
    things rather than do things -- main.js is the one place statements live
    (the wire calls). A top-level statement in any other module would run in
    concatenation order in the harness but in import-graph order in the real
    app, and that divergence is exactly what this split was designed to
    avoid. Wrap it in a wire function instead."""
    offenders = []
    for path in js_module_order():
        if path.name == "main.js":
            continue
        in_template = False
        for n, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            starts_statement = (
                not in_template
                and re.match(r"[A-Za-z_$]", line)
                and not re.match(r"(import|export|function|async|const|let|var|class)\b", line)
            )
            if starts_statement:
                offenders.append(f"{path.name}:{n}: {line[:70]}")
            if (line.count("`") - line.count("\\`")) % 2:
                in_template = not in_template
    assert not offenders, "top-level statements outside main.js:\n" + "\n".join(offenders)


def test_every_referenced_element_id_exists(js: str, declared_ids: set[str]) -> None:
    """A `$("#thing")` that resolves to null is a feature that silently does
    nothing -- there's no error until something dereferences it."""
    missing = sorted(set(referenced_ids(js)) - declared_ids - RUNTIME_CREATED_IDS)
    assert not missing, "app.js looks up element ids that index.html doesn't define: " + ", ".join(
        f"#{m}" for m in missing
    )


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
    head = head[head.index("const headRow") :]
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
    declared = dict(re.findall(r"#vd-estimate-items(\.has-jobs)?\s*\{\s*--pr-cols:\s*([^;]+);", css))
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
    init = js[js.index('document.addEventListener("DOMContentLoaded"') :]
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
    section = html[html.index('id="view-vehicles"') :]
    return section[section.index("<thead") : section.index("</thead>")]


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
    declared = re.search(r"^const BOARD_COLUMNS = (\d+);", js, re.MULTILINE)
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
    block = js[js.index("const VEHICLE_SORTS") : js.index("function sortVehicleRows")]
    comparators = set(re.findall(r"^\s{2}(\w+): \{ label:", block, re.MULTILINE))
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
    strays = re.findall(r"(?<![.\w])confirm\(", js)
    # confirmAction(...) / settleConfirm(...) / wireConfirmDialog() don't match
    # the pattern above; anything left is a bare window.confirm call.
    assert not strays, f"{len(strays)} raw window.confirm() call(s) left -- use confirmAction() instead"


def test_every_view_loader_can_report_its_own_failure(js: str) -> None:
    """renderViewFailure() paints into VIEW_PLACEHOLDERS, so a loader with no
    placeholder entry can only fall back to a toast that leaves the skeleton
    rows on screen forever."""
    loaders = set(
        re.findall(
            r"^\s{2}(\w+): \(\) => load",
            js[js.index("const VIEW_LOADERS") : js.index("/* ---------- render error boundary")],
            re.MULTILINE,
        )
    )
    placeholders = set(
        re.findall(
            r"^\s{2}(\w+):\s*\[",
            js[js.index("const VIEW_PLACEHOLDERS") : js.index("function showPlaceholders")],
            re.MULTILINE,
        )
    )
    assert loaders, "no VIEW_LOADERS entries found"
    assert loaders <= placeholders, (
        f"views with a loader but no placeholder/error target: {sorted(loaders - placeholders)}"
    )


def test_rail_views_all_have_a_loader_or_are_static(html: str, js: str) -> None:
    """Clicking a rail button runs runViewLoader(); a view missing from
    VIEW_LOADERS is either static on purpose or a screen that silently never
    fetches anything."""
    nav_targets = set(re.findall(r'class="rail-item[^"]*"\s+data-view="([^"]+)"', html))
    loaders = set(
        re.findall(
            r"^\s{2}(\w+): \(\) => load",
            js[js.index("const VIEW_LOADERS") : js.index("/* ---------- render error boundary")],
            re.MULTILINE,
        )
    )
    # Help is genuinely static: its content is HELP_TOPICS, shipped in the
    # page, so help.js builds the whole screen once at load and there is
    # nothing to fetch or to fail. Every other rail view hits the server.
    STATIC_VIEWS: set[str] = {"help"}
    assert nav_targets - loaders <= STATIC_VIEWS, (
        f"rail views with no loader: {sorted(nav_targets - loaders - STATIC_VIEWS)}"
    )


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


def test_every_report_sort_key_in_the_markup_has_a_spec(js: str) -> None:
    """A th whose data-report-sort doesn't match a REPORT_SORTS entry looks
    sortable, clicks, and then sorts by nothing at all."""
    block = js[js.index("const REPORT_SORTS") : js.index("function sortReportRows")]
    specced = set(re.findall(r"^\s{4}(\w+):\s*\{", block, re.MULTILINE))
    used = set(re.findall(r'reportSortHeader\("[\w-]+",\s*"(\w+)"', js))
    assert used, "no reportSortHeader calls found"
    assert used <= specced, f"report columns sorted by an undefined key: {sorted(used - specced)}"


def test_every_report_shape_opens_on_a_sort_it_actually_has(js: str) -> None:
    """Each report shape has its own columns, so a key from one is meaningless
    in the other -- generateReport() resets the sort on a shape change and
    falls back to that shape's DEFAULT_SORT. A default naming a column the
    shape doesn't define sorts by nothing at all, silently.

    This used to assert instead that every shape offered a "cost" key, from
    when a single shared fallback was how the reset worked. It isn't any more:
    defaultSortFor() is per shape, and the technician report has no money
    column to fall back to (labor here is never charged out).
    """
    block = js[js.index("const REPORT_SORTS") : js.index("function sortReportRows")]
    names = [a or b for a, b in re.findall(r'^  (?:"([\w-]+)"|(\w+)): \{$', block, flags=re.MULTILINE)]
    bodies = re.split(r'^  (?:"[\w-]+"|\w+): \{$', block, flags=re.MULTILINE)[1:]
    keys_by_shape = {
        name: set(re.findall(r"^\s{4}(\w+):\s*\{", body, re.MULTILINE))
        for name, body in zip(names, bodies, strict=True)
    }
    assert len(keys_by_shape) >= 2, f"expected several report shapes in REPORT_SORTS, found {sorted(keys_by_shape)}"

    defaults = js[js.index("const DEFAULT_SORT") : js.index("function defaultSortFor")]
    chosen = {
        (name or bare): key
        for name, bare, key in re.findall(r'^  (?:"([\w-]+)"|(\w+)): \{ key: "(\w+)"', defaults, re.MULTILINE)
    }
    assert set(chosen) == set(keys_by_shape), (
        f"DEFAULT_SORT and REPORT_SORTS disagree about the report shapes: {sorted(set(chosen) ^ set(keys_by_shape))}"
    )
    for shape, key in chosen.items():
        assert key in keys_by_shape[shape], f"{shape} opens sorted by {key!r}, which it has no column spec for"


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
    titled = set(
        re.findall(
            r'^  (?:"([\w-]+)"|(\w+)):\s*"',
            js[js.index("const REPORT_TITLES") : js.index("const REPORT_SEGMENT")],
            re.MULTILINE,
        )
    )
    assert types == {a or b for a, b in titled}, f"report toolbar and REPORT_TITLES disagree: {types}"

    ranges = re.findall(r'data-report-range="(\w+)"', html)
    assert len(ranges) == len(set(ranges)) == 5, f"expected 5 distinct range chips, found {ranges}"
    # QUICK_RANGES is the one list: what a chip may be called, what a
    # hand-typed pair is matched back to, and -- the part that matters -- which
    # ranges get re-resolved against today instead of replayed from the day
    # they were saved. A chip missing from it silently opts out of that.
    quick = re.search(r"const QUICK_RANGES = \[([^\]]+)\]", js)
    assert quick is not None, "QUICK_RANGES is gone from app.js"
    known = set(re.findall(r'"(\w+)"', quick.group(1)))
    assert set(ranges) == known, (
        f"range chips {sorted(ranges)} don't match the ranges the app can detect {sorted(known)}"
    )
    assert "const match = QUICK_RANGES.find(" in js, (
        "hand-typed dates are matched against their own list again; it will drift from the chips"
    )


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


def test_ticket_money_has_exactly_one_definition() -> None:
    """A ticket's quote and actual cost are shown in four places -- the cost
    card, the totals that follow each keystroke, the job subtotals and the
    printed ticket -- and each one used to do the arithmetic itself. That is
    how a vendor credit came to ADD to the ticket card while subtracting from
    the board and the Lot Report an inch away, and how paper went out of the
    printer disagreeing with the screen it was printed from.

    estimate-money.js is the only place the rule lives now. Anything summing
    quantity times unit_cost by hand somewhere else is a fifth copy waiting to
    drift, so it fails here rather than in front of an advisor.
    """
    money_js = (JS_DIR / "estimate-money.js").read_text(encoding="utf-8")
    assert 'kind === "credit"' in money_js, "estimate-money.js no longer applies the credit sign"

    # Scoped to the vehicle screen: the A/P entry form sums its own lines too,
    # but those are a vendor's invoice being typed in, every kind of them
    # positive, and none of this applies to them.
    detail_js = (JS_DIR / "vehicle-detail.js").read_text(encoding="utf-8")
    hand_rolled = [
        line.strip()
        for line in detail_js.split("\n")
        if re.search(r"(?:received_)?quantity\s*\*\s*\w*\.?unit_cost", line)
    ]
    assert not hand_rolled, (
        "the vehicle screen sums ticket money itself instead of asking estimate-money.js:\n" + "\n".join(hand_rolled)
    )


def test_credit_lines_are_never_dropped_from_a_grouped_ticket(js: str) -> None:
    """Vendor-invoice ingest writes kind="credit" lines nobody picked by hand.
    The grid's job layout grouped by a fixed Parts/Labor/Fees list, so those
    lines had no row on screen at all -- the total moved and nothing explained
    why. Both the grid and the printed ticket group through kindGroupsOf now,
    which is exhaustive over the kinds actually on the ticket."""
    assert js.count("function kindGroupsOf(") == 1, "kindGroupsOf is no longer the single grouping helper"
    grouping = re.findall(r"kindGroupsOf\(", js)
    assert len(grouping) >= 3, (
        f"only {len(grouping)} references to kindGroupsOf -- has a caller gone back to its own list?"
    )
    assert 'credit: "Credits"' in js, "KIND_GROUP_LABEL has no heading for credit lines"


def test_over_quote_rule_has_exactly_one_definition(js: str) -> None:
    """The Over Quote card counts the cars whose Cost cell is red. Two copies
    of the 10%-past-estimate rule is two chances for the count and the
    coloring to disagree, which makes both of them useless."""
    assert len(re.findall(r"quoted_cost \* 1\.1", js)) == 1, (
        "the over-quote threshold appears more than once -- isOverQuote should be the only definition"
    )
    assert 'isOverQuote(v) ? "over-quote"' in js, "costCellClass no longer defers to isOverQuote"


def test_parts_filter_toggle_is_not_a_segment_chip(js: str, html: str) -> None:
    """The 'Waiting on parts' toggle sits in the same row as the four
    mutually exclusive segment chips and carries the same .chip class. Both
    the radio-group wiring and the prefs loader select those chips by class,
    so an unscoped selector either clears the toggle on every segment click
    or lights it up on every page load. Both must ask for [data-filter]."""
    assert 'id="vehicles-parts-filter"' in html, "the parts toggle is gone from the board toolbar"
    toggle = re.search(r'<button[^>]*id="vehicles-parts-filter"[^>]*>', html)
    assert toggle is not None, "the parts toggle is no longer a <button>"
    assert "data-filter" not in toggle.group(0), (
        "the parts toggle grew a data-filter and will be treated as a fifth segment"
    )
    unscoped = re.findall(r'\$\$\("#view-vehicles \.filters \.chip"\)', js)
    assert not unscoped, "a segment-chip selector isn't scoped to [data-filter] and will sweep up the parts toggle"
    scoped = re.findall(r'\$\$\("#view-vehicles \.filters \.chip\[data-filter\]"\)', js)
    assert scoped, "nothing selects the segment chips any more -- has the toolbar moved?"
    # This used to require three copies, one per place that lit a chip. They
    # are one function now (syncSegmentChips), which is what a fourth caller
    # -- the search reach line's jump into History -- made worth doing: the
    # count is not the property worth holding, having a single writer is.
    assert "function syncSegmentChips" in js, (
        "the segment chips have no single writer -- state.filter and the lit chip will drift apart"
    )
    assert 'classList.add("active")' not in _function_source(js, "wireVehiclesView"), (
        "the board's chip handler lights its own chip again instead of going through syncSegmentChips"
    )


def test_vehicle_search_rule_has_exactly_one_definition(js: str) -> None:
    """Three call sites ask "does this car match what was typed?": the rows on
    screen, the rows this view's filters are hiding, and the rows in the half
    of the board that isn't loaded. A second copy of the rule is how the board
    ends up telling someone a car isn't findable while the same query finds it
    one line further down."""
    assert js.count('(v.customer_name || "").toLowerCase().includes(q)') == 1, (
        "the search-match rule has more than one definition -- matchesVehicleSearch should be the only one"
    )
    assert "matchesVehicleSearch(v, state.search)" in _function_source(js, "visibleVehicles"), (
        "the board's own rows no longer go through the shared search rule"
    )
    assert "matchesVehicleSearch" in _function_source(js, "searchReach"), (
        "the reach count no longer goes through the shared search rule"
    )


def test_search_reach_offers_only_actions_the_board_handles(js: str, html: str) -> None:
    """Show all matches and Open History are rendered in two places -- the
    line above the table and the empty state inside it -- and handled in a
    third. A button naming an action nothing handles doesn't fail, it just
    quietly does nothing, on the screen whose whole job is to stop a car being
    lost."""
    assert 'id="vehicles-search-reach"' in html, "the board has nowhere to say a match is somewhere else"
    offered = set(re.findall(r'data-search-reach="([\w-]+)"', js))
    assert offered, "nothing offers to reach past the current view any more"
    handled = set(re.findall(r'name === "([\w-]+)"', _function_source(js, "runSearchReachAction")))
    assert offered == handled, f"offered {sorted(offered)} but runSearchReachAction handles {sorted(handled)}"


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
    assert re.search(r"idle:\s*\{[^}]*value:\s*\(v\)\s*=>\s*v\.idle_days", js), (
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
    buckets = re.search(r"const IDLE_BUCKETS = \[(.*?)\];", js, re.DOTALL)
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
    assert "ignoreIdle" in _function_source(js, "visibleVehicles"), "visibleVehicles no longer honours ignoreIdle"


def test_hiding_the_board_chart_clears_its_filter(js: str) -> None:
    """A bucket filter can only be seen and cleared from the chart, so
    collapsing the chart while one is applied would leave rows missing with
    nothing on screen explaining why.

    "stalled" is the one selection that survives, because the Stalled summary
    card sets it and stays on screen showing it -- see the wiring's comment."""
    wiring = _function_source(js, "wireVehiclesView")
    assert re.search(
        r"state\.vehicleChartOpen = !state\.vehicleChartOpen;\s*(?://[^\n]*\n\s*)*"
        r"if \(!state\.vehicleChartOpen && state\.vehicleIdleBucket !== \"stalled\"\)"
        r" state\.vehicleIdleBucket = \"\";",
        wiring,
    ), "hiding the activity chart doesn't clear the idle filter it owns"


def test_idle_bucket_filter_round_trips_with_the_other_preferences(js: str) -> None:
    save = _function_source(js, "saveVehicleViewPrefs")
    load = _function_source(js, "loadVehicleViewPrefs")
    for key in ("idleBucket", "chartOpen"):
        assert key in save, f"{key} isn't persisted with the board's view preferences"
        assert key in load, f"{key} is saved but never restored"
    assert "state.vehicleIdleBucket" in save, "Reset view won't appear for a board filtered to one idle bucket"
    dirty = re.search(r"const dirty = [^;]+;", save)
    assert dirty is not None, "saveVehicleViewPrefs no longer computes a dirty flag"
    assert "chartOpen" not in dirty.group(0), "showing or hiding the chart counts as a dirty view -- it hides no rows"
    assert 'state.vehicleIdleBucket = "";' in _function_source(js, "resetVehicleView"), (
        "Reset view leaves the idle bucket filter applied"
    )


# ---------------------------------------------------------------------------
# The Stalled card, and the two places its threshold has to agree with itself.
# ---------------------------------------------------------------------------


def test_stalled_threshold_agrees_across_the_stack(js: str) -> None:
    """Three definitions of "stalled" have to be one number: the summary card,
    the idle bucket its span starts at, and the server's own constant.

    The card is derived from the bucket in code (STALLED_AFTER_DAYS reads
    IDLE_BY_KEY.cold.min) so those two can't drift. Python's copy can, and
    a server that thinks 5 days is stalled while the board draws the line at
    7 is the kind of disagreement nobody notices until someone asks why two
    screens report different numbers."""
    from app.recon import STALLED_AFTER_DAYS as server_value

    assert re.search(r"const STALLED_AFTER_DAYS = IDLE_BY_KEY\.cold\.min;", js), (
        "the front end's stalled threshold no longer derives from the cold bucket, "
        "so the Stalled card and the bars it spans can now disagree"
    )
    cold = re.search(r'\{ key: "cold",[^}]*min:\s*(\d+)', js)
    assert cold, "the cold idle bucket is gone"
    assert int(cold.group(1)) == server_value, (
        f"app.js starts 'stalled' at {cold.group(1)} days, app/recon.py at {server_value}"
    )


def test_stalled_excludes_finished_cars_on_both_sides_of_the_wire(js: str) -> None:
    """The threshold is only half the rule. The other half is that a car whose
    work is finished is never stalled, however long it has sat -- and both ends
    have to hold it or the board and the server report different lots.

    The front end carries it as a flag on the Stalled *selection* rather than
    an extra clause wherever stalled is computed, which is what makes the
    card's number and the filter behind it the same question: both go through
    matchesIdleSelection. Spelling it out again at any one call site is how
    they start to drift.
    """
    from app.recon import is_stalled

    assert is_stalled({"status_bucket": "in_progress", "idle_days": 30}), (
        "the server stopped flagging a car that still needs work and has sat a month"
    )
    assert not is_stalled({"status_bucket": "finished", "idle_days": 300}), (
        "the server counts a finished car as stalled, so its Stalled number can only ever go up"
    )

    # The entry ends at the closing brace of IDLE_SELECTIONS, and a plain
    # [^}]* would stop early on the `${STALLED_AFTER_DAYS}` in its own label.
    selections = re.search(r"const IDLE_SELECTIONS = \{.*?\n\};", js, re.DOTALL)
    assert selections, "IDLE_SELECTIONS is gone"
    stalled_selection = selections.group(0)[selections.group(0).index("stalled: {") :]
    assert "unfinishedOnly: true" in stalled_selection, "the front end's Stalled span no longer excludes finished cars"
    assert 'sel.unfinishedOnly && v && v.status_bucket === "finished"' in _function_source(
        js, "matchesIdleSelection"
    ), "matchesIdleSelection doesn't honour unfinishedOnly, so the flag above does nothing"
    assert "matchesIdleSelection(v, IDLE_SELECTIONS.stalled)" in _function_source(js, "isStalled"), (
        "isStalled restates the rule instead of resolving it through the selection the filter uses, "
        "so the Stalled card's count and the rows it filters to can now disagree"
    )


def test_stalled_span_is_matched_by_range_not_bucket_identity(js: str) -> None:
    """ "Stalled" covers two buckets, so filtering by comparing bucket keys
    would silently match nothing. One range test serves both kinds of
    selection, which is also what keeps a span from disagreeing with the
    bars it spans."""
    visible = _function_source(js, "visibleVehicles")
    assert "idleSelection(state.vehicleIdleBucket)" in visible, (
        "the idle filter no longer resolves through IDLE_SELECTIONS, so 'stalled' can't match"
    )
    assert "matchesIdleSelection" in visible, "the idle filter isn't matching by range"


def test_actionable_board_cards_are_buttons_wired_to_a_filter(html: str, js: str) -> None:
    """A number you can read but not act on sends you hunting down the table
    for the rows behind it. These three are controls, and being real <button>s
    is what makes them keyboard-operable and announced as pressed."""
    for which in ("parts", "stalled", "over"):
        assert re.search(rf'<button[^>]*class="stat stat-action"[^>]*data-board-filter="{which}"', html), (
            f'the "{which}" summary card isn\'t a button wired to a board filter'
        )
        assert f'data-board-filter="{which}"' in js, f'nothing in app.js responds to the "{which}" card'
    sync = _function_source(js, "syncBoardStatCards")
    assert 'setAttribute("aria-pressed"' in sync, "the cards' pressed state isn't announced"
    assert "el.disabled = !count && !active" in sync, (
        "a zero card stays clickable, offering a click into a guaranteed-empty table"
    )


def test_the_stalled_card_counts_with_the_idle_filter_lifted(js: str) -> None:
    """The Stalled card and the chart's bars set the same piece of state, so
    picking a bar changes what a naively-computed Stalled card counts -- it'd
    drop to the size of that one bucket while still labelled "Stalled". It
    counts over the pool with the idle filter lifted instead, which is the
    rule the chart's own bars already follow.

    Waiting on Parts and Over Quote deliberately need no equivalent: their
    filters keep exactly the rows they count, so the number is the same
    either way and lifting it would be code no test could observe."""
    stats = _function_source(js, "renderStats")
    assert "visibleVehicles({ ignoreIdle: true })" in stats, (
        "the Stalled card counts over the idle-filtered rows, so picking a bucket relabels it"
    )
    assert "ignoreIdle" in _function_source(js, "visibleVehicles"), "visibleVehicles no longer honours ignoreIdle"


def test_board_card_filters_round_trip_with_the_other_preferences(js: str) -> None:
    save = _function_source(js, "saveVehicleViewPrefs")
    load = _function_source(js, "loadVehicleViewPrefs")
    assert "overOnly" in save and "overOnly" in load, "the over-quote filter isn't a saved view preference"
    assert "IDLE_SELECTIONS[saved.idleBucket]" in load, (
        "restoring preferences validates against the buckets only, so a saved 'stalled' is dropped"
    )
    assert "state.vehicleOverOnly" in _function_source(js, "resetVehicleView"), (
        "Reset view leaves the over-quote filter on"
    )


def test_activity_labels_cover_every_action_the_server_logs(js: str) -> None:
    """The activity log and the detail page's "last worked on" line both print
    these. An action with no entry falls back to de-underscoring, which reads
    as a half-translated identifier ("ap invoice voided") on a screen advisors
    use -- tolerable as a safety net, not as the normal case."""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    logged: set[str] = set()
    for path in app_dir.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        logged |= set(re.findall(r'record_activity\(\s*(?:\n\s*)?db,\s*[^,]+,\s*"([a-z_]+)"', source))
        logged |= set(re.findall(r'record_activity\(\s*(?:\n\s*)?db,\s*[^,]+,\s*"([a-z_]+)" if ', source))
        logged |= set(
            re.findall(r'record_activity\(\s*(?:\n\s*)?db,\s*[^,]+,\s*"[a-z_]+" if [^"]+ else "([a-z_]+)"', source)
        )
    assert logged, "found no record_activity calls to check against -- the scan is broken"

    labelled = set(re.findall(r"^  ([a-z_]+): \"", _label_map(js), re.MULTILINE))
    missing = sorted(logged - labelled)
    assert not missing, "ACTIVITY_LABEL has no wording for: " + ", ".join(missing)


def _label_map(js: str) -> str:
    start = js.index("const ACTIVITY_LABEL = {")
    return js[start : js.index("};", start)]
