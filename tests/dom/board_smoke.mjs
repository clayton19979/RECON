// Vehicles board smoke test.
//
// The board is the app's home screen and the densest bit of pure list logic
// in it: filter by segment, filter by status, sort by any of eight columns,
// select rows (click, shift-range, select-all, keyboard), and re-render all of
// that without rebuilding <tr> nodes that didn't change. None of that is
// reachable from the Python tests, and all of it is the kind of thing that
// breaks quietly -- a comparator that sorts blanks to the top, a select-all
// that also selects the rows the filter is hiding.

import { boot, press, click } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "in_progress", status_bucket: "in_progress",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  age_days: 1, parts_pending: 0, parts_pending_value: 0, ...over,
});

/* Deliberately not in any column's sorted order, so "did it sort?" can't pass
   by accident on the server's own ordering.

   Every summary number this fixture produces is checkable by hand, which is
   the only way an assertion about a card is worth anything:

     whole board  5 vehicles (3 recon / 2 we-owe), $2,940 of $3,000 quoted,
                  2 waiting on parts worth $425, 1 over quote by $550
     recon only   3 vehicles, $2,630 of $2,700, 1 waiting ($340), 1 over ($550)
     we-owe only  2 vehicles, $310 of $300,     1 waiting ($85),  0 over

   The Camry is the over-quote slack case on purpose: $310 against a $300
   quote is past the estimate but inside the 10% band, so a card that counted
   "actual > quoted" rather than the band would report 2 instead of 1 and
   disagree with the one red cell in the table. */
let board = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150", vin: "1FTEW1E5XKF", status: "in_progress", technicians: ["Dana"], age_days: 22, quoted_cost: 900, actual_cost: 1450, parts_pending: 2, parts_pending_value: 340 }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic", vin: "2HGFC2F69MH", status: "estimate", technicians: [], age_days: 3, quoted_cost: 600, actual_cost: 0 }),
  veh({ segment: "we_owe", we_owe_id: 5, stock_number: "", vehicle: "2017 Toyota Camry", customer_name: "R. Alvarez", status: "pending_approval", status_bucket: "in_progress", technicians: ["Chris", "Dana"], age_days: 41, quoted_cost: 300, actual_cost: 310, parts_pending: 1, parts_pending_value: 85 }),
  veh({ recon_id: 3, stock_number: "C007", vehicle: "2015 Chevy Silverado", vin: "3GCUKREC0FG", status: "complete", status_bucket: "finished", technicians: ["Bo"], age_days: 9, quoted_cost: 1200, actual_cost: 1180 }),
  veh({ segment: "we_owe", we_owe_id: 6, stock_number: "D451", vehicle: "2020 Subaru Outback", customer_name: "T. Nguyen", status: "fulfilled", status_bucket: "finished", technicians: [], age_days: 15, quoted_cost: 0, actual_cost: 0 }),
];

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "renderVehiclesTable", "loadVehiclesView", "visibleVehicles", "sortVehicleRows",
           "vehicleKey", "loadVehicleViewPrefs", "renderVehicleStatusOptions", "VEHICLE_SORTS",
           "VEHICLE_PREFS_KEY", "resetVehicleView", "boardStats", "isOverQuote", "BOARD_COLUMNS"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) return url.includes("archived=true") ? [] : board;
    if (/^\/api\/(recon\/vehicles|we-owe)\/\d+$/.test(url)) return { id: 1, archived_at: "", stock_number: "B204", vehicle: "2019 Ford F-150" };
    return [];
  },
});

await settle();

const body = doc.querySelector("#vehicles-table");
const dataRows = () => [...body.querySelectorAll("tr.clickable")];
const stocks = () => dataRows().map((tr) => tr.children[1].textContent.trim());
const th = (key) => doc.querySelector(`#view-vehicles th[data-sort-key="${key}"]`);

/* ---------- initial render ---------- */
ok(dataRows().length === 5, `expected 5 rows on first load, got ${dataRows().length}`);
ok(doc.querySelector("#vehicles-count").textContent === "5 vehicles", `row count reads "${doc.querySelector("#vehicles-count").textContent}"`);
const headCells = doc.querySelectorAll("#view-vehicles thead th").length;
ok(dataRows()[0].children.length === headCells,
   `row has ${dataRows()[0].children.length} cells but the header has ${headCells}`);
ok(dataRows().every((tr) => tr.dataset.key && tr.dataset.sig),
   "rows are missing the data-key/data-sig the incremental renderer keys off");
ok(doc.querySelector("#vehicles-bulk-bar").style.display === "none", "bulk bar is showing with nothing selected");

/* ---------- summary cards ----------
   The cards summarize the rows on screen. Unfiltered, that's the whole
   board, so this run also pins the arithmetic before the filtering section
   starts moving it around. */
const card = (id) => doc.querySelector(`#${id}`).textContent.trim();
const cards = () => ({
  count: card("stat-veh-count"), split: card("stat-veh-split"),
  parts: card("stat-parts-waiting"), partsSub: card("stat-parts-waiting-sub"),
  cost: card("stat-actual-total"), costSub: card("stat-quoted-sub"),
  over: card("stat-over-quote"), overSub: card("stat-over-quote-sub"),
  scope: card("vehicles-scope"),
});

let c = cards();
ok(c.count === "5", `Vehicles card reads "${c.count}", expected 5`);
ok(c.split === "3 recon · 2 we-owe", `Vehicles sub reads "${c.split}"`);
ok(c.cost === "$2,940.00", `Cost card reads "${c.cost}", expected $2,940.00`);
ok(c.costSub === "of $3,000.00 quoted", `Cost sub reads "${c.costSub}"`);
ok(c.parts === "2", `Waiting on Parts reads "${c.parts}", expected 2 vehicles`);
ok(c.partsSub === "$425.00 on order", `parts sub reads "${c.partsSub}", expected $425.00`);
ok(c.over === "1", `Over Quote reads "${c.over}", expected 1 (the Camry is inside the 10% band)`);
ok(c.overSub === "$550.00 past estimate", `over-quote sub reads "${c.overSub}"`);
ok(c.scope === "Every vehicle on the board.", `scope line reads "${c.scope}" on an unfiltered board`);

// The card and the red cells are two renderings of one rule; if they can
// disagree, neither is trustworthy.
ok(Number(c.over) === dataRows().filter((tr) => tr.querySelector("td.over-quote")).length,
   "the Over Quote card and the red Cost cells disagree about how many cars are past estimate");
ok(w.boardStats(w.state.vehicles).overCount === w.state.vehicles.filter(w.isOverQuote).length,
   "boardStats and isOverQuote disagree");

// Tone: the two "go look at something" cards carry color, the neutral ones
// must not (a permanently-orange card stops meaning anything).
ok(doc.querySelector("#stat-parts-waiting").classList.contains("warn"), "a non-zero parts count isn't flagged");
ok(doc.querySelector("#stat-over-quote").classList.contains("crit"), "a non-zero over-quote count isn't flagged");
ok(!doc.querySelector("#stat-veh-count").classList.contains("warn"), "the plain Vehicles count is flagged");

/* ---------- parts column ---------- */
const partsCell = (key) => dataRows().find((tr) => tr.dataset.key === key).querySelector("td.col-parts");
ok(partsCell("recon:1").textContent.trim() === "2", `parts badge reads "${partsCell("recon:1").textContent.trim()}", expected 2`);
ok(/2 parts ordered, not yet received · \$340/.test(partsCell("recon:1").querySelector(".parts-badge").title),
   `parts tooltip reads "${partsCell("recon:1").querySelector(".parts-badge").title}"`);
ok(/^1 part ordered/.test(partsCell("we_owe:5").querySelector(".parts-badge").title),
   "a single pending part is pluralised");
ok(!partsCell("recon:2").querySelector(".parts-badge") && partsCell("recon:2").textContent.trim() === "",
   "a car waiting on nothing still draws something in the Parts column");

/* ---------- sorting ---------- */
click(w, th("stock"));
ok(stocks()[0] === "D451", `first click on Stock # should sort descending, got ${stocks().join(",")}`);
ok(stocks().at(-1) === "—", `blank stock numbers must sort last descending, got ${stocks().join(",")}`);
click(w, th("stock"));
ok(stocks()[0] === "A118", `second click should sort ascending, got ${stocks().join(",")}`);
ok(stocks().at(-1) === "—", `blank stock numbers must sort last ascending too, got ${stocks().join(",")}`);
ok(th("stock").getAttribute("aria-sort") === "ascending", "aria-sort not reflecting the active direction");
ok(th("stock").classList.contains("sorted"), "the sorted column isn't marked");
click(w, th("stock"));
ok(!th("stock").classList.contains("sorted"), "a third click should clear the sort");
ok(stocks()[0] === "B204", `clearing the sort should fall back to the server's order, got ${stocks().join(",")}`);

click(w, th("parts"));
ok(dataRows().slice(0, 2).map((tr) => tr.dataset.key).join(",") === "recon:1,we_owe:5",
   `sorting by Parts descending should surface the two cars waiting on something, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
// no need to clear -- the next click sets a different sort key
click(w, th("age"));
ok(dataRows()[0].dataset.key === "we_owe:5", "sorting by Age descending should put the 41-day car first");
click(w, th("cost"));
ok(dataRows()[0].dataset.key === "recon:1", "sorting by Cost descending should put the $1450 car first");
ok(th("age").getAttribute("aria-sort") === "none", "the previously sorted column kept its aria-sort");
// numeric sort, not lexicographic: "1450" vs "310" vs "0"
ok(dataRows().map((tr) => tr.dataset.key).join(",").startsWith("recon:1,recon:3,we_owe:5"),
   "Cost sorted lexicographically instead of numerically");

/* ---------- node reuse: a re-render must not rebuild unchanged rows ---------- */
click(w, th("cost")); // -> ascending, same five rows, different order
const before = new Map(dataRows().map((tr) => [tr.dataset.key, tr]));
w.renderVehiclesTable();
const after = new Map(dataRows().map((tr) => [tr.dataset.key, tr]));
ok([...before].every(([key, tr]) => after.get(key) === tr),
   "an identical re-render replaced the row nodes -- scroll position and focus are lost every time");
click(w, th("cost")); // clear
click(w, th("age"));  // reorder
ok([...before].every(([key, tr]) => dataRows().includes(tr)),
   "re-sorting rebuilt every row instead of moving the existing nodes");

// a row whose data changed *is* rebuilt, and picks up the new value
const reused = before.get("recon:1");
board = board.map((v) => (v.recon_id === 1 ? { ...v, actual_cost: 2500 } : v));
w.state.vehicles = board;
w.renderVehiclesTable();
ok(reused.textContent.includes("2,500") || dataRows().some((tr) => tr.textContent.includes("2,500")),
   "a changed cost never made it into the table");
board = board.map((v) => (v.recon_id === 1 ? { ...v, actual_cost: 1450 } : v));
w.state.vehicles = board;
w.renderVehiclesTable();

/* ---------- over-quote highlight ---------- */
const overRow = dataRows().find((tr) => tr.dataset.key === "recon:1");
ok(overRow.querySelector("td.over-quote"), "a car $550 past its estimate isn't flagged");
const underRow = dataRows().find((tr) => tr.dataset.key === "recon:3");
ok(!underRow.querySelector("td.over-quote"), "a car under its estimate is flagged as over");

/* ---------- segment + status filtering ---------- */
const chip = (f) => doc.querySelector(`#view-vehicles .filters .chip[data-filter="${f}"]`);
chip("we_owe").click();
ok(dataRows().length === 2, `We-Owe filter should leave 2 rows, got ${dataRows().length}`);
ok(chip("we_owe").classList.contains("active") && !chip("").classList.contains("active"),
   "the active chip didn't move");

/* ---------- the cards follow the filter ----------
   The bug this whole section exists for: the cards were computed from every
   vehicle in state.vehicles while the table below them was filtered, so
   filtering to We-Owe left "3 recon" on screen above two we-owe rows. */
c = cards();
ok(c.count === "2", `filtered to We-Owe the Vehicles card should read 2, got "${c.count}"`);
ok(c.split === "0 recon · 2 we-owe", `Vehicles sub reads "${c.split}" with the board filtered to We-Owe`);
ok(c.cost === "$310.00", `Cost card reads "${c.cost}" for the We-Owe rows, expected $310.00 (not the lot's $2,940.00)`);
ok(c.costSub === "of $300.00 quoted", `Cost sub reads "${c.costSub}"`);
ok(c.parts === "1" && c.partsSub === "$85.00 on order",
   `parts card reads "${c.parts}" / "${c.partsSub}" for We-Owe, expected 1 / $85.00 on order`);
ok(c.over === "0" && c.overSub === "none past estimate",
   `over-quote reads "${c.over}" for We-Owe, where nothing is past estimate`);
ok(!doc.querySelector("#stat-over-quote").classList.contains("crit"), "a zero over-quote count is still flagged");
ok(c.scope === "Showing vehicles: we-owe.", `scope line reads "${c.scope}"`);

chip("recon").click();
c = cards();
ok(c.count === "3" && c.cost === "$2,630.00" && c.costSub === "of $2,700.00 quoted",
   `Recon cards read ${c.count} / ${c.cost} / ${c.costSub}, expected 3 / $2,630.00 / of $2,700.00 quoted`);
ok(c.over === "1" && c.parts === "1" && c.partsSub === "$340.00 on order",
   `Recon cards read over=${c.over} parts=${c.parts} (${c.partsSub})`);

chip("we_owe").click();

const statusSel = doc.querySelector("#vehicles-status-filter");
ok([...statusSel.options].map((o) => o.value).includes("pending_approval"),
   "the status dropdown wasn't built from the statuses actually on the board");
ok(![...statusSel.options].some((o) => o.value === "waived"),
   "the status dropdown offers a status no vehicle has");
statusSel.value = "pending_approval";
statusSel.dispatchEvent(new w.Event("change", { bubbles: true }));
ok(dataRows().length === 1 && dataRows()[0].dataset.key === "we_owe:5",
   `segment + status should compose down to one row, got ${dataRows().length}`);

/* ---------- select-all only takes what the filter shows ---------- */
const selectAll = doc.querySelector("#vehicles-select-all");
selectAll.checked = true;
selectAll.dispatchEvent(new w.Event("change", { bubbles: true }));
ok(w.state.vehicleSelection.size === 1,
   `select-all took ${w.state.vehicleSelection.size} rows -- it must respect the active filter`);
ok(doc.querySelector("#vehicles-bulk-bar").style.display !== "none", "bulk bar stayed hidden with a row selected");
ok(doc.querySelector("#vehicles-bulk-count").textContent === "1 selected",
   `bulk count reads "${doc.querySelector("#vehicles-bulk-count").textContent}"`);
doc.querySelector("#vehicles-bulk-clear").click();
ok(w.state.vehicleSelection.size === 0, "Clear selection didn't clear it");

/* ---------- preferences survive a reload ---------- */
const saved = JSON.parse(w.localStorage.getItem("dao-vehicle-view"));
ok(saved && saved.filter === "we_owe" && saved.status === "pending_approval",
   `view preferences not persisted: ${JSON.stringify(saved)}`);
ok(!doc.querySelector("#vehicles-reset-view").hidden, "Reset view stayed hidden with filters applied");
w.state.filter = ""; w.state.vehicleStatus = ""; w.state.vehicleSort = { key: "", dir: "desc" };
w.loadVehicleViewPrefs();
ok(w.state.filter === "we_owe" && w.state.vehicleStatus === "pending_approval",
   "saved preferences were not restored on load");
ok(chip("we_owe").classList.contains("active"), "restoring preferences didn't move the active chip");

w.resetVehicleView();
await settle();
ok(w.state.filter === "" && w.state.vehicleStatus === "" && !w.state.vehicleSort.key, "Reset view didn't clear the view");
ok(dataRows().length === 5, `after reset the whole board should be back, got ${dataRows().length}`);
ok(doc.querySelector("#vehicles-reset-view").hidden, "Reset view stayed visible on a clean view");

/* ---------- "Waiting on parts" toggle ----------
   An independent on/off sitting in the same row as the four mutually
   exclusive segment chips, which is exactly the shape that goes wrong: it's
   a .chip, so the radio-group wiring and the prefs loader both used to
   collect it by selector and would either clear it on every segment click or
   light it up on every page load. */
const partsChip = doc.querySelector("#vehicles-parts-filter");
ok(partsChip && !partsChip.classList.contains("active") && partsChip.getAttribute("aria-pressed") === "false",
   "the parts toggle starts switched on");

partsChip.click();
ok(partsChip.classList.contains("active") && partsChip.getAttribute("aria-pressed") === "true",
   "clicking the parts toggle didn't switch it on (or didn't update aria-pressed)");
ok(dataRows().length === 2 && dataRows().map((tr) => tr.dataset.key).sort().join(",") === "recon:1,we_owe:5",
   `the parts toggle should leave the 2 cars waiting on something, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
c = cards();
ok(c.count === "2" && c.parts === "2" && c.cost === "$1,760.00",
   `parts-only cards read ${c.count} / ${c.parts} / ${c.cost}, expected 2 / 2 / $1,760.00`);
ok(c.scope === "Showing vehicles: waiting on parts.", `scope line reads "${c.scope}"`);

// composes with the segment chips rather than replacing them
chip("we_owe").click();
ok(partsChip.classList.contains("active"),
   "clicking a segment chip switched the parts toggle off -- it's being swept into the segment radio group");
ok(dataRows().length === 1 && dataRows()[0].dataset.key === "we_owe:5",
   `We-Owe + waiting on parts should compose to one row, got ${dataRows().length}`);
ok(cards().scope === "Showing vehicles: we-owe · waiting on parts.", `scope line reads "${cards().scope}"`);

// persisted, and restored without lighting up the wrong chip
const savedParts = JSON.parse(w.localStorage.getItem("dao-vehicle-view"));
ok(savedParts.partsOnly === true, `the parts toggle wasn't persisted: ${JSON.stringify(savedParts)}`);
w.state.vehiclePartsOnly = false;
partsChip.classList.remove("active");
w.loadVehicleViewPrefs();
ok(w.state.vehiclePartsOnly === true && partsChip.classList.contains("active"),
   "the parts toggle wasn't restored from preferences");
ok(chip("").classList.contains("active") === false,
   "restoring preferences lit the All chip while the board is filtered to We-Owe");

// its own empty state: "no recon vehicles" would be a lie about the lot when
// what's true is that none of them are waiting on a part
chip("recon").click();
w.state.vehicles = board.map((v) => ({ ...v, parts_pending: 0, parts_pending_value: 0 }));
w.renderVehiclesTable();
const partsEmpty = body.querySelector("tr");
ok(partsEmpty.textContent.includes("Nothing is waiting on parts"),
   `parts-only empty state reads "${partsEmpty.textContent.trim().slice(0, 60)}"`);
ok(Number(partsEmpty.querySelector("td").getAttribute("colspan")) === w.BOARD_COLUMNS,
   "the parts empty row doesn't span the table");
ok(cards().count === "0" && cards().cost === "$0.00" && cards().parts === "0",
   "the cards kept the previous view's numbers over an empty board");
ok(!doc.querySelector("#stat-parts-waiting").classList.contains("warn"), "an empty board still flags the parts card");
body.querySelector('[data-empty-action="clear-parts"]').click();
ok(!w.state.vehiclePartsOnly && !partsChip.classList.contains("active"),
   "the empty state's Show all vehicles button didn't switch the toggle off");

w.state.vehicles = board;
w.resetVehicleView();
await settle();
ok(!w.state.vehiclePartsOnly && !partsChip.classList.contains("active"), "Reset view left the parts toggle on");
ok(dataRows().length === 5, `after reset the whole board should be back, got ${dataRows().length}`);

/* ---------- row clicks: open, toggle, shift-range ---------- */
const rowFor = (key) => dataRows().find((tr) => tr.dataset.key === key);
const box = (key) => rowFor(key).querySelector(".veh-select");

// note: dispatching a click on a checkbox runs jsdom's activation behaviour,
// so `checked` flips on its own -- setting it by hand first would flip it back
click(w, box("recon:1"));
ok(w.state.vehicleSelection.has("recon:1"), "clicking a row checkbox didn't select it");
ok(rowFor("recon:1").classList.contains("selected"), "a selected row isn't marked");
ok(!fetchLog.some((f) => /recon\/vehicles\/1$/.test(f.url)),
   "clicking the checkbox also opened the vehicle");

// shift-click extends from the last row touched, in displayed order
click(w, box("recon:3"), { shiftKey: true });
const keysInOrder = w.visibleVehicles().map(w.vehicleKey);
const span = keysInOrder.slice(keysInOrder.indexOf("recon:1"), keysInOrder.indexOf("recon:3") + 1);
ok(span.every((k) => w.state.vehicleSelection.has(k)) && w.state.vehicleSelection.size === span.length,
   `shift-click selected ${[...w.state.vehicleSelection].join(",")}, expected ${span.join(",")}`);

// ctrl-click on the row body toggles instead of navigating
const fetchesBefore = fetchLog.length;
click(w, rowFor("we_owe:6").children[2], { ctrlKey: true });
ok(w.state.vehicleSelection.has("we_owe:6"), "ctrl-click on a row didn't toggle its selection");
ok(fetchLog.length === fetchesBefore, "ctrl-click on a row navigated instead of selecting");

// clicking a row parks the cursor on it (so Arrow keys continue from where
// the mouse left off) -- park it back at the top for the keyboard run
ok(w.state.vehicleCursor === "we_owe:6", "clicking a row didn't move the keyboard cursor to it");
w.state.vehicleSelection.clear();
w.state.vehicleCursor = null;
w.renderVehiclesTable();

/* ---------- keyboard ---------- */
press(w, "ArrowDown");
ok(w.state.vehicleCursor === dataRows()[0].dataset.key, "ArrowDown didn't put the cursor on the first row");
ok(dataRows()[0].classList.contains("cursor"), "the cursor row isn't marked in the DOM");
press(w, "ArrowDown");
press(w, "ArrowDown");
ok(w.state.vehicleCursor === dataRows()[2].dataset.key, "ArrowDown didn't advance the cursor");
press(w, "ArrowUp");
ok(w.state.vehicleCursor === dataRows()[1].dataset.key, "ArrowUp didn't move the cursor back");
press(w, "End");
ok(w.state.vehicleCursor === dataRows().at(-1).dataset.key, "End didn't jump to the last row");
press(w, "Home");
ok(w.state.vehicleCursor === dataRows()[0].dataset.key, "Home didn't jump to the first row");
ok(doc.querySelectorAll("#vehicles-table tr.cursor").length === 1, "more than one row is marked as the cursor");

press(w, " ");
ok(w.state.vehicleSelection.has(dataRows()[0].dataset.key), "Space didn't select the cursor row");
press(w, " ");
ok(w.state.vehicleSelection.size === 0, "Space didn't toggle the selection back off");

press(w, " ");
press(w, "Escape");
ok(w.state.vehicleSelection.size === 0, "Escape didn't clear the selection");

// "/" focuses search, and typing in it must not be read as navigation
press(w, "/");
ok(doc.activeElement === doc.querySelector("#global-search"), "'/' didn't focus the search box");
const cursorBefore = w.state.vehicleCursor;
press(w, "j", { target: doc.querySelector("#global-search") });
ok(w.state.vehicleCursor === cursorBefore, "a keystroke inside the search box moved the row cursor");

const search = doc.querySelector("#global-search");
search.value = "civic";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(dataRows().length === 1 && dataRows()[0].dataset.key === "recon:2",
   `search should have narrowed to the Civic, got ${dataRows().length} rows`);
ok(w.state.vehicleCursor === null || w.state.vehicleCursor === "recon:2",
   "the cursor survived on a row the search filtered away");
press(w, "Escape", { target: search });
ok(dataRows().length === 5, "Escape in the search box didn't clear it");

// enter opens the cursor row
press(w, "ArrowDown");
press(w, "Enter");
await settle();
ok(fetchLog.some((f) => /\/api\/(recon\/vehicles|we-owe)\/\d+$/.test(f.url)), "Enter didn't open the cursor row");

/* ---------- empty states ---------- */
doc.querySelector('#view-vehicles .filters .chip[data-filter=""]').click();
search.value = "zzzznothing";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
const empty = body.querySelector("tr");
ok(empty && empty.textContent.includes("No vehicles match"), "no empty state for a search that matched nothing");
ok(empty && Number(empty.querySelector("td").getAttribute("colspan")) === headCells,
   `the empty row spans ${empty && empty.querySelector("td").getAttribute("colspan")} of ${headCells} columns`);
body.querySelector('[data-empty-action="clear-search"]').click();
ok(dataRows().length === 5, "the empty state's Clear search button didn't restore the board");

/* ---------- escaping ---------- */
w.state.vehicles = [veh({ recon_id: 9, stock_number: '<img src=x onerror="window.__pwned=1">', vehicle: "X" })];
w.renderVehiclesTable();
ok(!body.querySelector("img") && !w.__pwned, "the board renders raw HTML out of vehicle fields");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("vehicles board: sorting, filtering, selection, keyboard nav, incremental render");
