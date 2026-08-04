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

// lot_bucket / needs / remaining_cost are the server's, not the browser's:
// app/recon.py stamps every board row with the pile it's in, what finishing
// it should still cost, and the one-line "what is it waiting on" sentence, so
// the Vehicles screen's columns and the Lot Report's groups cannot disagree.
// The fixture supplies them the way the API does, verbatim.
const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "in_progress", status_bucket: "in_progress",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  // Blank is the common case and the awkward one: most cars have no arrival
  // date on file, and the cell has to say so rather than passing the write-up
  // date off as one. Rows that do carry one set it explicitly below.
  acquired_at: "", age_days: 1, parts_pending: 0, parts_pending_value: 0,
  idle_days: 0, last_activity_at: "2026-07-25T08:00:00", order_id: null,
  // The columns layout reads these three; the table layout ignores them.
  lot_bucket: "working", needs: "work under way", remaining_cost: 0, ...over,
});

/* Deliberately not in any column's sorted order, so "did it sort?" can't pass
   by accident on the server's own ordering.

   Every summary number this fixture produces is checkable by hand, which is
   the only way an assertion about a card is worth anything:

     whole board  5 vehicles (3 recon / 2 we-owe), $2,940 spent,
                  2 waiting on parts worth $425
     recon only   3 vehicles, $2,630 spent, 1 waiting ($340)
     we-owe only  2 vehicles, $310 spent,   1 waiting ($85)

   quoted_cost is still on the fixture rows because the API still sends it --
   it feeds remaining_cost, which is what a car still has coming. Nothing on
   the board compares it against actual_cost: the shop doesn't quote recon
   work, so there is no estimate for a car to come in over.

   Idle is set so each of the five buckets holds exactly one car -- which makes
   every bar in the activity chart a 1, so a chart that miscounted or that fed
   itself the wrong list can't produce a plausible-looking result. Note idle is
   deliberately unrelated to age: the F-150 is the oldest car on the lot at 22
   days and was worked on today, the Civic is 3 days old and has been idle
   nearly as long. A column that quietly read age_days would still pass a
   same-order fixture, and fails this one. */
let board = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150", vin: "1FTEW1E5XKF", status: "in_progress", technicians: ["Dana"], acquired_at: "2026-06-09", age_days: 22, quoted_cost: 900, actual_cost: 1450, parts_pending: 2, parts_pending_value: 340, idle_days: 0, last_activity_at: "2026-07-25T08:15:00", needs: "2 parts on order ($340.00)" }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic", vin: "2HGFC2F69MH", status: "estimate", technicians: [], age_days: 3, quoted_cost: 600, actual_cost: 0, idle_days: 2, last_activity_at: "2026-07-23T11:00:00", lot_bucket: "waiting", remaining_cost: 600, needs: "No ticket written yet · $600.00 of work left" }),
  veh({ segment: "we_owe", we_owe_id: 5, stock_number: "", vehicle: "2017 Toyota Camry", customer_name: "R. Alvarez", status: "pending_approval", status_bucket: "in_progress", technicians: ["Chris", "Dana"], age_days: 41, quoted_cost: 300, actual_cost: 310, parts_pending: 1, parts_pending_value: 85, idle_days: 4, last_activity_at: "2026-07-21T09:30:00", needs: "Waiting on approval · 1 part on order ($85.00)" }),
  // The two stalled cars carry real ticket ids: they're what "Make Tasks"
  // acts on, and the id is what gives the resulting task its jump-to-vehicle
  // chip. Distinct values so a batch that sent one order_id for every item
  // can't pass. The other three stay null -- a car can sit on the board
  // before anyone opens an RO on it, and that has to survive the same path.
  //
  // Both are unfinished, and that is load-bearing rather than incidental: a
  // finished car is never stalled however long it has sat (see isStalled), so
  // a fixture whose only long-idle cars were a completed RO and a fulfilled
  // promise was asserting the exact bug this file now guards against. The
  // finished case gets its own scoped section further down.
  veh({ recon_id: 3, order_id: 71, stock_number: "C007", vehicle: "2015 Chevy Silverado", vin: "3GCUKREC0FG", status: "in_progress", technicians: ["Bo"], age_days: 9, quoted_cost: 1200, actual_cost: 1180, idle_days: 9, last_activity_at: "2026-07-16T14:00:00", remaining_cost: 20, needs: "$20.00 of work left · untouched 9 days" }),
  veh({ segment: "we_owe", we_owe_id: 6, order_id: 72, stock_number: "D451", vehicle: "2020 Subaru Outback", customer_name: "T. Nguyen", status: "open", status_bucket: "in_progress", technicians: [], age_days: 15, quoted_cost: 0, actual_cost: 0, idle_days: 21, last_activity_at: "2026-07-04T10:00:00", lot_bucket: "waiting", needs: "Untouched 21 days" }),
];

/* What History holds. Empty for most of this file -- the board is the live
   list -- and filled in by the search-reach section, which is entirely about
   what happens when the car you're looking for is in the other list. */
let archived = [];

const bulkCreateBodies = [];

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "renderVehiclesTable", "loadVehiclesView", "visibleVehicles", "sortVehicleRows",
           "vehicleKey", "loadVehicleViewPrefs", "renderVehicleStatusOptions", "VEHICLE_SORTS",
           "VEHICLE_PREFS_KEY", "resetVehicleView", "boardStats", "BOARD_COLUMNS",
           "IDLE_BUCKETS", "idleBucket", "IDLE_SELECTIONS", "STALLED_AFTER_DAYS", "isStalled",
           "bulkTaskTitle", "isPromiseLate", "fmtDay",
           "LOT_COLUMNS", "boardColumns", "displayedVehicles", "setVehicleLayout"],
  fetch: async (url, opts) => {
    if (url.startsWith("/api/vehicles-board")) {
      if (url.includes("view=history")) return archived;
      // Nothing in this fixture has a voided ticket, so the Void pile is
      // empty and the live board's nudge stays off.
      if (url.includes("view=void")) return [];
      return board;
    }
    if (/^\/api\/(recon\/vehicles|we-owe)\/\d+$/.test(url)) return { id: 1, archived_at: "", stock_number: "B204", vehicle: "2019 Ford F-150" };
    if (url === "/api/tasks/bulk-create") {
      const body = JSON.parse(opts.body);
      bulkCreateBodies.push(body);
      return { created: body.items.length, tasks: [] };
    }
    return [];
  },
});

await settle();

const body = doc.querySelector("#vehicles-table");
const dataRows = () => [...body.querySelectorAll("tr.clickable")];
// The stock cell carries the ticket's RO number under the stock number now,
// so read the stock number itself rather than the whole cell.
const stocks = () => dataRows().map((tr) => tr.children[1].querySelector(".stock-no").textContent.trim());
const th = (key) => doc.querySelector(`#view-vehicles th[data-sort-key="${key}"]`);

/* ---------- the layout the board opens on ----------
   Asserted first, before anything has had a chance to change it: the columns
   are the default, and index.html's own [hidden] attributes have to agree
   with state.vehicleLayout or the board flashes the wrong layout on every
   load. The table sections below then run in the list layout, which is what
   they are about; the columns get their own section at the end. */
ok(!doc.querySelector("#vehicles-columns").hidden && doc.querySelector("#vehicles-list-panel").hidden,
   "the board doesn't open on the columns layout");
ok(doc.querySelector('#vehicles-layout-switch [data-veh-layout="columns"]').getAttribute("aria-pressed") === "true",
   "the layout switch doesn't mark the layout that's showing");
ok(doc.querySelectorAll("#vehicles-columns .veh-card").length === 5,
   "the columns are empty on first load");
doc.querySelector('#vehicles-layout-switch [data-veh-layout="list"]').click();

/* ---------- initial render ---------- */
ok(dataRows().length === 5, `expected 5 rows on first load, got ${dataRows().length}`);
ok(doc.querySelector("#vehicles-count").textContent === "5 vehicles", `row count reads "${doc.querySelector("#vehicles-count").textContent}"`);
const headCells = doc.querySelectorAll("#view-vehicles thead th").length;
ok(dataRows()[0].children.length === headCells,
   `row has ${dataRows()[0].children.length} cells but the header has ${headCells}`);
ok(dataRows().every((tr) => tr.dataset.key && tr.dataset.sig),
   "rows are missing the data-key/data-sig the incremental renderer keys off");
// Visibility is the [hidden] attribute, not style.display -- asserting the
// latter tested nothing (jsdom leaves style untouched either way).
ok(doc.querySelector("#vehicles-bulk-bar").hidden, "bulk bar is showing with nothing selected");

/* ---------- summary cards ----------
   The cards summarize the rows on screen. Unfiltered, that's the whole
   board, so this run also pins the arithmetic before the filtering section
   starts moving it around. */
const card = (id) => doc.querySelector(`#${id}`).textContent.trim();
const cards = () => ({
  count: card("stat-veh-count"), split: card("stat-veh-split"),
  parts: card("stat-parts-waiting"), partsSub: card("stat-parts-waiting-sub"),
  cost: card("stat-actual-total"), costSub: card("stat-cost-sub"),
  scope: card("vehicles-scope"),
});

let c = cards();
ok(c.count === "5", `Vehicles card reads "${c.count}", expected 5`);
ok(c.split === "3 recon · 2 we-owe", `Vehicles sub reads "${c.split}"`);
ok(c.cost === "$2,940.00", `Cost card reads "${c.cost}", expected $2,940.00`);
// The sub says what the number is made of. Deliberately not a comparison
// against anything: there is no estimate to be over or under.
ok(c.costSub === "received parts + labor", `Cost sub reads "${c.costSub}"`);
ok(c.parts === "2", `Waiting on Parts reads "${c.parts}", expected 2 vehicles`);
ok(c.partsSub === "$425.00 on order", `parts sub reads "${c.partsSub}", expected $425.00`);
ok(c.scope === "Every vehicle on the board.", `scope line reads "${c.scope}" on an unfiltered board`);

// Nothing anywhere on the board reports a car as past an estimate.
ok(!doc.querySelector("td.over-quote, .veh-card-quoted, #stat-over-quote"),
   "an over-quote reading is back on the board");
ok(w.boardStats(w.state.vehicles).overCount === undefined, "boardStats still computes an over-quote count");

// Tone: the two "go look at something" cards carry color, the neutral ones
// must not (a permanently-orange card stops meaning anything).
ok(doc.querySelector("#stat-parts-waiting").classList.contains("warn"), "a non-zero parts count isn't flagged");
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
ok(c.costSub === "received parts + labor", `Cost sub reads "${c.costSub}"`);
ok(c.parts === "1" && c.partsSub === "$85.00 on order",
   `parts card reads "${c.parts}" / "${c.partsSub}" for We-Owe, expected 1 / $85.00 on order`);
ok(c.scope === "Showing vehicles: we-owe.", `scope line reads "${c.scope}"`);

chip("recon").click();
c = cards();
ok(c.count === "3" && c.cost === "$2,630.00",
   `Recon cards read ${c.count} / ${c.cost}, expected 3 / $2,630.00`);
ok(c.parts === "1" && c.partsSub === "$340.00 on order",
   `Recon cards read parts=${c.parts} (${c.partsSub})`);

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
ok(!doc.querySelector("#vehicles-bulk-bar").hidden, "bulk bar stayed hidden with a row selected");
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

/* ---------- Age column ----------
   Age is "how long has this car been here", counted from the day it arrived
   on the lot -- which is not always the day somebody typed it in. The cell has
   to say which date it came off, or a wrong arrival date is invisible and the
   number is unarguable. A we-owe has no lot arrival: its clock starts at the
   promise, and the tooltip has to say that rather than claiming a date it
   doesn't have. */
// The day count itself is the server's (age_days); the cell only renders it
// and says what it was counted from, so the fixture sets the two separately.
const rowByKey = (key) => dataRows().find((tr) => tr.dataset.key === key);
const ageCell = (key) => rowByKey(key).querySelector("td.age-col .age-cell");

ok(ageCell("recon:1").textContent.trim() === "22d", `Age reads "${ageCell("recon:1").textContent.trim()}", expected 22d`);
ok(/On the lot since 2026-06-09/.test(ageCell("recon:1").title),
   `the Age tooltip should name the arrival date, got "${ageCell("recon:1").title}"`);
ok(/22 days/.test(ageCell("recon:1").title), `the Age tooltip reads "${ageCell("recon:1").title}"`);
// No arrival date on file: say so rather than implying the write-up date is one.
ok(/no arrival date on file/.test(ageCell("recon:2").title),
   `a car with no arrival date reads "${ageCell("recon:2").title}"`);
ok(/Written up 3 days ago/.test(ageCell("recon:2").title), `got "${ageCell("recon:2").title}"`);
ok(/^Promised 41 days ago$/.test(ageCell("we_owe:5").title),
   `a we-owe's Age tooltip should talk about the promise, got "${ageCell("we_owe:5").title}"`);

// Day zero can't take the "N days ago" shape: a promise made this morning was
// reading "Promised today ago", and a same-day write-up "Written up today ago".
w.state.vehicles = board.map((v) => ({ ...v, age_days: 0 }));
w.renderVehiclesTable();
ok(ageCell("we_owe:5").title === "Promised today",
   `a promise made this morning reads "${ageCell("we_owe:5").title}", expected "Promised today"`);
ok(ageCell("recon:2").title === "Written up today — no arrival date on file",
   `a car written up this morning reads "${ageCell("recon:2").title}"`);
w.state.vehicles = board;
w.renderVehiclesTable();

/* ---------- Idle column ----------
   Idle is "days since anything happened on this car's ticket", which is a
   different number from Age and comes from a different place (the server's
   orders.last_activity_at, not the vehicle row). The fixture's idle values are
   deliberately in a different order from its ages, so a cell or comparator
   reading age_days by mistake shows up here rather than looking right. */
const idleCell = (key) => rowByKey(key).querySelector("td.idle-col .idle-cell");

ok(th("idle"), "the board has no sortable Idle column");
ok(idleCell("recon:1").textContent.trim() === "today",
   `a car worked on today reads "${idleCell("recon:1").textContent.trim()}", expected "today" rather than "0d"`);
ok(idleCell("recon:3").textContent.trim() === "9d", `9 days idle reads "${idleCell("recon:3").textContent.trim()}"`);
ok(/Last activity 2026-07-16/.test(idleCell("recon:3").title),
   `the Idle tooltip should name the date work last happened, got "${idleCell("recon:3").title}"`);
ok(/9 days ago/.test(idleCell("recon:3").title), `the Idle tooltip reads "${idleCell("recon:3").title}"`);
ok(/today/.test(idleCell("recon:1").title), `a same-day tooltip reads "${idleCell("recon:1").title}"`);

// Severity has to match the bucket boundaries, since the row color and the bar
// a car lands in are two renderings of one rule.
ok(idleCell("recon:1").classList.contains("age-ok"), "a car touched today is flagged as stale");
ok(idleCell("recon:2").classList.contains("age-ok"), "2 days idle is flagged");
ok(idleCell("we_owe:5").classList.contains("age-warn"), "4 days idle isn't flagged as a warning");
ok(idleCell("recon:3").classList.contains("age-crit"), "9 days idle isn't flagged as critical");
ok(idleCell("we_owe:6").classList.contains("age-crit"), "21 days idle isn't flagged as critical");

click(w, th("idle"));
ok(dataRows()[0].dataset.key === "we_owe:6",
   `sorting by Idle descending should put the 21-day-idle car first, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
ok(dataRows().at(-1).dataset.key === "recon:1",
   "sorting by Idle descending should put the car worked on today last -- Age would have ordered these differently");
click(w, th("idle")); // ascending
ok(dataRows()[0].dataset.key === "recon:1", "sorting by Idle ascending should lead with the freshest car");
click(w, th("idle")); // clear

/* ---------- the activity chart ----------
   Five buckets, one car each, so every bar is a 1 and a chart fed the wrong
   list (the whole board instead of the visible rows, or the idle-filtered rows
   instead of the pool) reports something visibly different.

   The bars are the board's only chart *and* a filter, which is the part worth
   testing hard: a chart that shows "1 car idle 14+ days" and gives you no way
   to find which car is decoration. */
const chartEl = doc.querySelector("#vehicles-chart");
const bars = () => [...chartEl.querySelectorAll("[data-idle-bucket]")];
const barFor = (key) => bars().find((b) => b.dataset.idleBucket === key);
const barCount = (key) => barFor(key).querySelector(".bar-value").textContent.trim();

ok(chartEl && !chartEl.hidden, "the activity chart isn't rendered on a fresh board");
ok(bars().length === 5, `expected one bar per idle bucket, got ${bars().length}`);
ok(bars().map((b) => b.dataset.idleBucket).join(",") === w.IDLE_BUCKETS.map((b) => b.key).join(","),
   "the chart's bars aren't in bucket order");
ok(bars().every((b) => barCount(b.dataset.idleBucket) === "1"),
   `every bucket holds exactly one car in this fixture, got ${bars().map((b) => barCount(b.dataset.idleBucket)).join(",")}`);
ok(/5 vehicles in view/.test(chartEl.querySelector(".chart-note").textContent),
   `chart note reads "${chartEl.querySelector(".chart-note").textContent}"`);
// Tone follows the same thresholds as the rows: 3+ days warns, 7+ is critical.
ok(!barFor("recent").querySelector(".bar-fill").classList.contains("warn"), "the 1–2 day bucket is coloured as a problem");
ok(barFor("stale").querySelector(".bar-fill").classList.contains("warn"), "the 3–6 day bucket isn't flagged");
ok(barFor("frozen").querySelector(".bar-fill").classList.contains("over"), "the 14+ day bucket isn't flagged critical");

// clicking a bar filters the board to that bucket
barFor("frozen").click();
ok(dataRows().length === 1 && dataRows()[0].dataset.key === "we_owe:6",
   `clicking the 14+ day bar should leave the one 21-day car, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
ok(barFor("frozen").getAttribute("aria-pressed") === "true", "the selected bar isn't marked pressed");
ok(cards().scope === "Showing vehicles: idle 14+ days.", `scope line reads "${cards().scope}"`);
ok(cards().count === "1", `the cards should follow the bucket filter, Vehicles reads "${cards().count}"`);
// The chart counts over the board *minus* the idle filter, so selecting a
// bucket must not collapse the chart down to the bar you just clicked --
// there'd be nothing left to compare against and no way back.
ok(bars().length === 5, `selecting a bucket collapsed the chart to ${bars().length} bar(s)`);
ok(bars().every((b) => barCount(b.dataset.idleBucket) === "1"),
   "selecting a bucket changed the other buckets' counts");
ok(!doc.querySelector("#vehicles-reset-view").hidden, "Reset view stayed hidden with a bucket filter on");

// clicking the same bar again clears it -- the only affordance a one-of-five
// filter needs, and the only one the chart offers
barFor("frozen").click();
ok(dataRows().length === 5 && !w.state.vehicleIdleBucket, "clicking the selected bar again didn't clear the filter");

/* keyboard: role="button" without Enter/Space is a lie to a screen reader.
   The board also binds Enter (open the cursor row) and Space (select it) on
   *document*, so a keystroke on a bar bubbles into both -- with a row under
   the cursor, activating a filter would open a car at the same time. Park a
   cursor first, or this passes whether the bar stops the event or not. It has
   to be a row that survives the filter the bar applies (the Silverado is the
   7–13 day bucket), otherwise the re-render removes it before the document
   handler looks for it and the bug hides itself. */
w.state.vehicleCursor = "recon:3";
const fetchesBeforeBarKeys = fetchLog.length;
press(w, "Enter", { target: barFor("cold") });
ok(w.state.vehicleIdleBucket === "cold" && dataRows().length === 1,
   `Enter on a bar didn't apply it (bucket is "${w.state.vehicleIdleBucket}")`);
ok(fetchLog.length === fetchesBeforeBarKeys,
   "Enter on a chart bar also opened the cursor row -- the bar isn't stopping the board's own key handler");
press(w, " ", { target: barFor("cold") });
ok(!w.state.vehicleIdleBucket, "Space on the selected bar didn't clear it");
ok(w.state.vehicleSelection.size === 0, "Space on a chart bar also selected the cursor row");
w.state.vehicleCursor = null;

// composes with the segment chips, and the counts follow them
chip("recon").click();
ok(bars().length === 3, `Recon has cars in 3 buckets, chart drew ${bars().length} bars`);
ok(bars().map((b) => b.dataset.idleBucket).join(",") === "today,recent,cold",
   `empty buckets should be dropped, got ${bars().map((b) => b.dataset.idleBucket).join(",")}`);
barFor("cold").click();
ok(dataRows().length === 1 && dataRows()[0].dataset.key === "recon:3",
   "Recon + the 7–13 day bucket should compose to the Silverado");
ok(cards().scope === "Showing vehicles: recon · idle 7–13 days.", `scope line reads "${cards().scope}"`);
// With a bucket selected the empty buckets come back (greyed) rather than
// vanishing -- otherwise the chart reflows out from under the next click.
ok(bars().length === 5, `with a bucket selected all five bars should stay, got ${bars().length}`);
ok(barFor("frozen").classList.contains("bar-row-muted"), "an empty bucket isn't greyed out");

// persisted and restored
const savedIdle = JSON.parse(w.localStorage.getItem("dao-vehicle-view"));
ok(savedIdle.idleBucket === "cold" && savedIdle.chartOpen === true,
   `the bucket filter wasn't persisted: ${JSON.stringify(savedIdle)}`);
w.state.vehicleIdleBucket = "";
w.loadVehicleViewPrefs();
ok(w.state.vehicleIdleBucket === "cold", "the bucket filter wasn't restored from preferences");

// its own empty state, phrased as the good news it usually is
w.state.vehicleIdleBucket = "frozen";
w.renderVehiclesTable();
const idleEmpty = body.querySelector("tr");
ok(idleEmpty.textContent.includes("Nothing has been sitting 14+ days"),
   `bucket empty state reads "${idleEmpty.textContent.trim().slice(0, 70)}"`);
ok(Number(idleEmpty.querySelector("td").getAttribute("colspan")) === w.BOARD_COLUMNS,
   "the idle empty row doesn't span the table");
idleEmpty.querySelector('[data-empty-action="clear-idle"]').click();
ok(!w.state.vehicleIdleBucket && dataRows().length === 3, "the empty state's Show all vehicles button didn't clear the bucket");

// hiding the chart must also drop the filter only the chart can see or clear
barFor("today").click();
const chartToggle = doc.querySelector("#vehicles-chart-toggle");
chartToggle.click();
ok(chartEl.hidden, "the chart toggle didn't hide the chart");
ok(chartToggle.getAttribute("aria-expanded") === "false", "the toggle didn't update aria-expanded");
ok(/Show activity chart/.test(chartToggle.textContent), `toggle reads "${chartToggle.textContent.trim()}" while collapsed`);
ok(!w.state.vehicleIdleBucket && dataRows().length === 3,
   "hiding the chart left its filter applied with nothing on screen able to clear it");
ok(JSON.parse(w.localStorage.getItem("dao-vehicle-view")).chartOpen === false, "the collapsed chart wasn't persisted");
chartToggle.click();
ok(!chartEl.hidden && bars().length === 3, "showing the chart again didn't re-render it");

w.resetVehicleView();
await settle();
ok(!w.state.vehicleIdleBucket && dataRows().length === 5, "Reset view left a bucket filter on");

/* ---------- the Stalled card ----------

   The chart says how the lot is distributed; the Stalled card says how much
   of it is in trouble, in the four-or-five numbers people read before
   anything else. It's also a filter, so most of what's worth testing is the
   interaction between it and the chart's bars: they write the same piece of
   state, and "stalled" is a span across the last two buckets rather than a
   sixth bucket, which is exactly the shape that goes wrong.

   This fixture has two stalled cars -- the Silverado at 9 days and the
   Outback at 21 -- so the card should read 2 and name 21 as the worst. */
const stalledCard = () => doc.querySelector('[data-board-filter="stalled"]');
const partsCard = () => doc.querySelector('[data-board-filter="parts"]');

ok(stalledCard() && stalledCard().tagName === "BUTTON",
   "the Stalled card isn't a real button, so it isn't keyboard-operable");
ok(card("stat-stalled") === "2", `Stalled card reads "${card("stat-stalled")}", expected 2 (Silverado 9d, Outback 21d)`);
ok(card("stat-stalled-sub") === "worst sitting 21 days", `Stalled sub reads "${card("stat-stalled-sub")}"`);
ok(doc.querySelector("#stat-stalled").classList.contains("crit"), "a non-zero stalled count isn't flagged");

// The card and the chart derive from one threshold. If the card counted with
// its own 7 it could disagree with the two bars it spans, which is the whole
// reason STALLED_AFTER_DAYS is read off the "cold" bucket.
ok(w.STALLED_AFTER_DAYS === w.IDLE_BUCKETS.find((b) => b.key === "cold").min,
   "the stalled threshold has drifted from the bucket boundary it's meant to track");
ok(Number(card("stat-stalled")) === Number(barCount("cold")) + Number(barCount("frozen")),
   "the Stalled card and the two bars it spans disagree about how many cars are stalled");
ok(w.state.vehicles.filter(w.isStalled).length === 2, "isStalled disagrees with the fixture");

// clicking it filters to the span, not to one bucket
stalledCard().click();
ok(w.state.vehicleIdleBucket === "stalled", `the Stalled card set "${w.state.vehicleIdleBucket}"`);
ok(dataRows().length === 2 && dataRows().map((tr) => tr.dataset.key).sort().join(",") === "recon:3,we_owe:6",
   `Stalled should leave the two 7+ day cars, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
ok(stalledCard().getAttribute("aria-pressed") === "true", "the active Stalled card isn't marked pressed");
ok(cards().scope === "Showing vehicles: stalled 7+ days.", `scope line reads "${cards().scope}"`);

ok(card("stat-veh-count") === "2", "the Vehicles card should follow the table, which is now 2 rows");

/* The card and the chart's bars write the same piece of state, which is what
   makes this worth pinning: with the 14+ day bar selected the board shows one
   car, but "Stalled" must still read 2. A card computed off the filtered rows
   would say 1 -- relabelling the 14+ bucket's count as the stalled count and
   losing the number the advisor was reading when they clicked. */
barFor("frozen").click();
ok(dataRows().length === 1, `the 14+ bar should leave one car, got ${dataRows().length}`);
ok(card("stat-stalled") === "2",
   `Stalled reads "${card("stat-stalled")}" with a bucket selected -- it should count with the idle filter lifted`);
ok(card("stat-veh-count") === "1", "the Vehicles card should follow the table down to 1");
stalledCard().click();
ok(w.state.vehicleIdleBucket === "stalled" && dataRows().length === 2, "the Stalled card didn't take the filter back");

// the two bars inside the span are marked, but not as *pressed*: clicking one
// narrows to that bucket rather than clearing the span, and a control that
// says pressed but won't un-press when clicked is worse than an unmarked one
ok(barFor("cold").classList.contains("bar-row-in-span") && barFor("frozen").classList.contains("bar-row-in-span"),
   "the bars covered by the Stalled span aren't marked");
ok(!barFor("stale").classList.contains("bar-row-in-span"), "a bar outside the span is marked as inside it");
ok(bars().every((b) => b.getAttribute("aria-pressed") === "false"),
   "a bar inside the span claims to be the pressed filter");
ok(bars().length === 5, `the chart collapsed to ${bars().length} bar(s) under the Stalled filter`);

// a bar inside the span narrows to that bucket
barFor("frozen").click();
ok(w.state.vehicleIdleBucket === "frozen" && dataRows().length === 1,
   "clicking a bar inside the span didn't narrow to that bucket");
ok(stalledCard().getAttribute("aria-pressed") === "false", "the Stalled card stayed pressed after a bar took the filter");
ok(!barFor("cold").classList.contains("bar-row-in-span"), "the span marker survived the span being replaced");

// ...and the card takes it back
stalledCard().click();
ok(w.state.vehicleIdleBucket === "stalled" && dataRows().length === 2,
   "the Stalled card didn't take the idle filter back off a bucket");

/* Hiding the chart clears a bucket filter, because nothing else on screen
   could show or clear it. "stalled" is the exception and must survive: the
   card that set it is still there, still lit up. */
chartToggle.click();
ok(chartEl.hidden && w.state.vehicleIdleBucket === "stalled" && dataRows().length === 2,
   "hiding the chart cleared the Stalled filter, which the card can still see and clear");
ok(stalledCard().getAttribute("aria-pressed") === "true", "the Stalled card lost its pressed state with the chart hidden");
chartToggle.click();

// clicking again clears
stalledCard().click();
ok(!w.state.vehicleIdleBucket && dataRows().length === 5, "clicking the active Stalled card didn't clear it");

// persisted like every other view preference, and restored
stalledCard().click();
ok(JSON.parse(w.localStorage.getItem("dao-vehicle-view")).idleBucket === "stalled",
   "the Stalled filter wasn't persisted");
w.state.vehicleIdleBucket = "";
w.loadVehicleViewPrefs();
ok(w.state.vehicleIdleBucket === "stalled", "the Stalled filter wasn't restored from preferences");

// its own empty state, phrased as good news
w.state.filter = "we_owe";
w.renderVehiclesTable();
ok(dataRows().length === 1, `we-owe + stalled should leave the Outback, got ${dataRows().length}`);
w.state.vehicles = board.filter((v) => v.idle_days < 7);
w.renderVehiclesTable();
const stalledEmpty = body.querySelector("tr");
ok(stalledEmpty.textContent.includes("Nothing is stalled"),
   `stalled empty state reads "${stalledEmpty.textContent.trim().slice(0, 60)}"`);
w.state.vehicles = board;
w.state.filter = "";
w.renderVehiclesTable();

// a zero card stops being a control -- clicking it could only ever produce an
// empty table -- but keeps its normal weight, because 0 is the good news
w.state.vehicleIdleBucket = "";
w.state.vehicles = board.filter((v) => v.idle_days < 7);
w.renderVehiclesTable();
ok(card("stat-stalled") === "0" && stalledCard().disabled, "a zero Stalled card is still clickable");
ok(!doc.querySelector("#stat-stalled").classList.contains("crit"), "a zero stalled count is flagged as critical");
ok(card("stat-stalled-sub") === "nothing over 6 days", `zero Stalled sub reads "${card("stat-stalled-sub")}"`);
stalledCard().click();
ok(!w.state.vehicleIdleBucket, "a disabled Stalled card still applied its filter");
w.state.vehicles = board;
w.renderVehiclesTable();

/* ---------- a finished car is never stalled ----------

   The lot's longest-idle rows are usually the ones nobody will ever touch
   again: a completed recon ticket, a we-owe the advisor waived. Nothing moves
   on them, so their idle count climbs forever -- counting them made the red
   Stalled card a number that could only ever go up, until it described the
   shop's history instead of its morning, and it put "Stalled 21 days — make a
   task" on a promise that was closed on purpose.

   Idle and stalled part company here. Idle stays a plain measurement, still
   true of a finished car and still shown: the Idle column and the chart's
   bars don't move. Stalled is the judgement, and it drops them. */
const finishedBoard = board.map((v) =>
  v.recon_id === 3 ? { ...v, status: "complete", status_bucket: "finished" }
    : v.we_owe_id === 6 ? { ...v, status: "fulfilled", status_bucket: "finished" }
      : v);
w.state.vehicleChartOpen = true;
w.state.vehicles = finishedBoard;
w.renderVehiclesTable();
ok(card("stat-stalled") === "0",
   `two finished cars idle 9 and 21 days still read as ${card("stat-stalled")} stalled`);
ok(!finishedBoard.some(w.isStalled), "isStalled still counts a car whose work is finished");
// The measurement is untouched -- it's still true, and the chart still shows
// where the lot's time is going.
ok(idleCell("we_owe:6").textContent.trim() === "21d",
   `a finished car stopped reporting how long it has sat, reads "${idleCell("we_owe:6").textContent.trim()}"`);
ok(barCount("frozen") === "1",
   `the 14+ day bar dropped a car for being finished, reads ${barCount("frozen")}`);
// ...but the row stops shouting about it, because there is nothing to do.
ok(idleCell("we_owe:6").classList.contains("age-ok"),
   "a finished car's Idle cell is still painted as an alarm");
ok(/isn't stalled/.test(idleCell("we_owe:6").title),
   `the Idle tooltip doesn't explain why a long-sitting finished car isn't flagged: "${idleCell("we_owe:6").title}"`);
// The card's filter agrees with the number printed on it, which is the whole
// point of running the count and the filter through one rule.
w.state.vehicleIdleBucket = "stalled";
w.renderVehiclesTable();
ok(dataRows().length === 0,
   `the Stalled filter kept ${dataRows().length} finished car(s) the card didn't count`);
// And a follow-up written off the board stops claiming neglect that isn't there.
const finishedOutback = finishedBoard.find((v) => v.we_owe_id === 6);
ok(w.bulkTaskTitle(finishedOutback) === "Follow up: D451 2020 Subaru Outback",
   `a finished car's task title reads "${w.bulkTaskTitle(finishedOutback)}"`);
w.state.vehicleIdleBucket = "";
w.state.vehicles = board;
w.renderVehiclesTable();

/* ---------- Waiting on Parts as a filter ----------
   Same rule as Stalled: the number you're reading is the thing you click. */
partsCard().click();
ok(w.state.vehiclePartsOnly && dataRows().length === 2,
   `Waiting on Parts should leave 2 rows, got ${dataRows().map((tr) => tr.dataset.key).join(",")}`);
ok(card("stat-parts-waiting") === "2", "the Waiting on Parts card moved when it was clicked");
ok(cards().scope === "Showing vehicles: waiting on parts.", `scope line reads "${cards().scope}"`);
ok(!doc.querySelector("#vehicles-reset-view").hidden, "Reset view stayed hidden with a parts filter on");
ok(JSON.parse(w.localStorage.getItem("dao-vehicle-view")).partsOnly === true, "the parts filter wasn't persisted");

// composes with a status filter, and brings its own empty state. The status
// is set directly rather than through the History chip: that chip refetches,
// and this is asserting on what renders synchronously.
w.state.vehicleStatus = "estimate";   // the Civic, which has nothing on order
w.renderVehiclesTable();
ok(dataRows().length === 0, "estimate + waiting on parts should be empty in this fixture");
const partsEmpty2 = body.querySelector("tr");
ok(partsEmpty2.textContent.includes("Nothing is waiting on parts"),
   `parts empty state reads "${partsEmpty2.textContent.trim().slice(0, 60)}"`);
ok(Number(partsEmpty2.querySelector("td").getAttribute("colspan")) === w.BOARD_COLUMNS,
   "the parts empty row doesn't span the table");
partsEmpty2.querySelector('[data-empty-action="clear-parts"]').click();
ok(!w.state.vehiclePartsOnly, "the empty state's button didn't clear the parts filter");
w.state.vehicleStatus = "";
w.renderVehiclesTable();

// the parts card and the toolbar chip are one filter with two controls, so
// they must never disagree about whether it's on
partsCard().click();
ok(w.state.vehiclePartsOnly, "the parts card didn't apply its filter");
ok(doc.querySelector("#vehicles-parts-filter").getAttribute("aria-pressed") === "true",
   "the parts card left the toolbar chip showing the filter as off");
doc.querySelector("#vehicles-parts-filter").click();
ok(!w.state.vehiclePartsOnly && partsCard().getAttribute("aria-pressed") === "false",
   "the toolbar chip left the parts card showing the filter as on");

w.resetVehicleView();
await settle();
ok(!w.state.vehicleOverOnly && !w.state.vehicleIdleBucket && dataRows().length === 5,
   "Reset view left one of the card filters on");

/* ---------- bulk "Make Tasks" ----------
   The action the Stalled card leads to: filter to stalled, select what you
   can't get to today, write it down. One task per vehicle, each linked to
   its ticket. */
const bulkTaskBtn = doc.querySelector("#vehicles-bulk-task");
ok(bulkTaskBtn, "the bulk bar has no Make Tasks button");
stalledCard().click();
click(w, doc.querySelector("#vehicles-select-all"));
ok(w.state.vehicleSelection.size === 2, `select-all under the Stalled filter picked ${w.state.vehicleSelection.size}`);
ok(bulkTaskBtn.textContent === "Make 2 Tasks", `the button reads "${bulkTaskBtn.textContent}"`);
ok(w.bulkTaskTitle(board.find((v) => v.recon_id === 3)) === "Follow up: C007 2015 Chevy Silverado — no work in 9 days",
   `generated title reads "${w.bulkTaskTitle(board.find((v) => v.recon_id === 3))}"`);

/* One request carrying N items, not N requests. The fan-out version could
   half-land and report "6 created, 2 failed" without being able to name the
   two, leaving the user to re-select the right subset from memory or make
   duplicates. Asserted as "zero single-row POSTs" as well as "one batch",
   because a batch call sent *alongside* the old loop would satisfy the
   batch check on its own. */
const singleBefore = fetchLog.filter((f) => f.url === "/api/tasks" && f.method === "POST").length;
bulkTaskBtn.click();
await settle();
// confirmAction is a real <dialog>; accept it the way a person would
doc.querySelector("#confirm-accept").click();
await settle();
const batchCalls = fetchLog.filter((f) => f.url === "/api/tasks/bulk-create" && f.method === "POST");
ok(batchCalls.length === 1, `expected exactly 1 POST /api/tasks/bulk-create, got ${batchCalls.length}`);
ok(fetchLog.filter((f) => f.url === "/api/tasks" && f.method === "POST").length === singleBefore,
   "Make Tasks still fires a POST per vehicle alongside the batch");
ok(bulkCreateBodies.length === 1 && bulkCreateBodies[0].items.length === 2,
   `the batch carried ${bulkCreateBodies[0] && bulkCreateBodies[0].items.length} items for 2 selected vehicles`);
ok(bulkCreateBodies[0].items.every((i) => i.title),
   `an item went out without a title: ${JSON.stringify(bulkCreateBodies[0].items)}`);
// Each item keeps *its own* car's ticket, not the first one's -- that link is
// the whole reason the resulting task can point back at the vehicle.
ok(JSON.stringify(bulkCreateBodies[0].items.map((i) => i.order_id).sort()) === "[71,72]",
   `the batch carried order ids ${JSON.stringify(bulkCreateBodies[0].items.map((i) => i.order_id))}, expected each car's own`);
ok(w.state.vehicleSelection.size === 0, "the selection survived creating its tasks, inviting a duplicate run");

// History is finished work -- a follow-up task pointing at an archived car is
// a dead end, so the button isn't offered there
w.state.boardView = "history";
w.state.vehicleSelection.add("recon:3");
w.renderVehiclesTable();
ok(bulkTaskBtn.hidden, "Make Tasks is offered on the History board");
w.state.boardView = "active";
w.state.vehicleSelection.clear();
w.resetVehicleView();
await settle();

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

/* ---------- search reaches past the view it's in ----------

   The search box is how a car gets looked up -- typing in it from any screen
   lands here -- but it only ever filtered the rows this view had already
   fetched. So it answered "No vehicles match that search" about cars that are
   in the app, in two everyday ways: the car had been filed to History, or the
   board was still narrowed by a segment/status/toggle left on from a previous
   session. Both told the advisor the car doesn't exist.

   Every assertion below is about a car the app definitely has. */
archived = [
  // Shares a model with the live F-150 on purpose: that's the case where the
  // table has a row to show AND there are more matches somewhere else, which
  // is the reach line rather than the empty state.
  veh({ recon_id: 40, stock_number: "H900", vehicle: "2016 Ford F-150", vin: "1FTFW1EF0GF",
        status: "complete", status_bucket: "finished", age_days: 120, idle_days: 96 }),
];
w.resetVehicleView();
await settle();
// Reloading the board throws away what it knew about the other half -- that
// reload is also how archiving and reopening land, which is exactly the
// operation that moves cars between the two lists.
ok(w.state.searchElsewhereScope === "" && w.state.searchElsewhere === null,
   "a board reload kept a cached copy of the other list");

const reachLine = () => doc.querySelector("#vehicles-search-reach");
const setSearch = (value) => {
  search.value = value;
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
};

setSearch("H900");
// The archived list hasn't been fetched yet at this point, and until it has,
// nothing may claim anything about it either way.
ok(body.textContent.includes("No vehicles match"),
   "the first render of a search with no local match should say so");
ok(!body.textContent.includes("History"),
   "the board claimed something about History before it had looked there");
await settle();
ok(fetchLog.some((f) => f.url.includes("view=history")),
   "searching never asked the server for the archived list");
ok(body.textContent.includes("1 match is in History"),
   `a car in History wasn't reported: ${body.textContent.replace(/\s+/g, " ").trim()}`);
ok(reachLine().hidden, "the reach line duplicated the empty state with no rows on screen");

body.querySelector('[data-search-reach="search-elsewhere"]').click();
await settle();
ok(w.state.boardView === "history", `Open History left the board on "${w.state.boardView}"`);
ok(stocks().includes("H900"), `Open History didn't land on the car: ${stocks().join(", ")}`);
ok(search.value === "H900", "the search was dropped on the way to History");
ok(doc.querySelector("#vehicles-view-filter").value === "history", "the Show dropdown didn't follow into History");

// ...and the same the other way round, which is the case a one-directional
// fix would miss: from History, a car on the live board is just as invisible.
setSearch("D451");
await settle();
ok(body.textContent.includes("1 match is on the active board"),
   `from History, a live car wasn't reported: ${body.textContent.replace(/\s+/g, " ").trim()}`);
body.querySelector('[data-search-reach="search-elsewhere"]').click();
await settle();
ok(w.state.boardView === "active" && stocks().includes("D451"),
   `Back to the board didn't land on the car: ${w.state.boardView} / ${stocks().join(", ")}`);

// Rows on screen and more elsewhere: the line above the table, not the empty
// state, and it counts only the matches this view isn't showing.
setSearch("F-150");
await settle();
ok(dataRows().length === 1, `"F-150" should show the one live F-150, got ${dataRows().length}`);
ok(!reachLine().hidden, "the reach line stayed hidden with a match sitting in History");
ok(reachLine().textContent.includes("1 more match in History"),
   `reach line reads "${reachLine().textContent.replace(/\s+/g, " ").trim()}"`);

// The other half of the bug: filters the advisor set weeks ago and forgot.
chip("recon").click();
const statusFilter = doc.querySelector("#vehicles-status-filter");
statusFilter.value = "in_progress";
statusFilter.dispatchEvent(new w.Event("change", { bubbles: true }));
setSearch("D451");
await settle();
ok(body.textContent.includes("1 match is hidden by the filters on this view"),
   `a filtered-away match wasn't reported: ${body.textContent.replace(/\s+/g, " ").trim()}`);
body.querySelector('[data-search-reach="widen-search"]').click();
ok(w.state.filter === "" && w.state.vehicleStatus === "",
   `Show all matches left filters on: ${w.state.filter} / ${w.state.vehicleStatus}`);
ok(stocks().includes("D451"), `Show all matches didn't reveal the car: ${stocks().join(", ")}`);

// A search that genuinely matches nothing still says so -- and now says it
// having actually looked in both lists.
setSearch("zzzznothing");
await settle();
ok(body.textContent.includes("No vehicles match"), "a search matching nothing lost its empty state");
ok(body.textContent.includes("or in History"),
   `the empty state didn't say History had been checked: ${body.textContent.replace(/\s+/g, " ").trim()}`);
ok(reachLine().hidden, "the reach line showed itself with nothing to report");

setSearch("");
ok(reachLine().hidden, "the reach line outlived the search that produced it");
ok(dataRows().length === 5, `clearing the search should restore the board, got ${dataRows().length}`);
/* ---------- the columns layout ----------

   The same filtered, sorted list read as three piles instead of one stack:
   what hasn't been started, what's in the shop, what can go out. It is a
   presentation switch, not a filter -- the cars on screen must be exactly the
   cars the table was showing, which is most of what's worth pinning here.

   In this fixture:
     Not started    the Civic (quoted, nothing spent) and the Outback
     In the shop    the F-150, the Camry, the Silverado
     Ready to go    nothing, which is the empty-column case
*/
const layoutBtn = (which) => doc.querySelector(`#vehicles-layout-switch [data-veh-layout="${which}"]`);
const columnsHost = doc.querySelector("#vehicles-columns");
const listPanel = doc.querySelector("#vehicles-list-panel");
const colSection = (key) => columnsHost.querySelector(`[data-lot-column="${key}"]`);
const cardsIn = (key) => [...colSection(key).querySelectorAll(".veh-card")];
const allCards = () => [...columnsHost.querySelectorAll(".veh-card")];
const cardFor = (k) => allCards().find((c) => c.dataset.key === k);

ok(layoutBtn("columns") && layoutBtn("list"), "the Vehicles screen has no columns/list switch");
ok(columnsHost.hidden && !listPanel.hidden,
   "the board is still in the columns layout -- the list sections above ran against the wrong one");

layoutBtn("columns").click();
ok(!columnsHost.hidden && listPanel.hidden, "switching to Columns didn't swap the two containers");
ok(layoutBtn("columns").getAttribute("aria-pressed") === "true" && layoutBtn("list").getAttribute("aria-pressed") === "false",
   "the switch didn't move");
ok(allCards().length === 5, `expected a card per visible vehicle, got ${allCards().length}`);

// The piles are the server's, and every car has to land in the one it was
// stamped with -- a browser-side re-derivation is the exact drift this avoids.
ok(cardsIn("waiting").map((c) => c.dataset.key).join(",") === "recon:2,we_owe:6",
   `Not started holds ${cardsIn("waiting").map((c) => c.dataset.key).join(",")}`);
ok(cardsIn("working").map((c) => c.dataset.key).join(",") === "recon:1,we_owe:5,recon:3",
   `In the shop holds ${cardsIn("working").map((c) => c.dataset.key).join(",")}`);
ok(cardsIn("ready").length === 0, "Ready to go has cars in a fixture where nothing is finished");
ok(allCards().every((c) => board.some((v) => w.vehicleKey(v) === c.dataset.key)),
   "a card appeared for a vehicle that isn't on the board");
ok(w.LOT_COLUMNS.map((c) => c.key).join(",") === "waiting,working,ready",
   "the columns aren't in the order a car travels through the shop");

// Counts on the headers, and an empty column that says so rather than sitting
// blank under a "0" as though it failed to load.
const colCount = (key) => colSection(key).querySelector("[data-col-count]").textContent;
const colMoney = (key) => colSection(key).querySelector("[data-col-money]").textContent;
ok(colCount("waiting") === "2" && colCount("working") === "3" && colCount("ready") === "0",
   `column counts read ${colCount("waiting")}/${colCount("working")}/${colCount("ready")}`);
ok(colCount("working") === String(cardsIn("working").length), "a column's count disagrees with the cards under it");
ok(colSection("ready").querySelector(".veh-col-blank"), "an empty column doesn't say it's empty");
ok(!colSection("working").querySelector(".veh-col-blank"), "a full column is showing the empty-column line");
// $1450 + $310 + $1180 spent, $20 of the Silverado's quote still to come.
ok(colMoney("working") === "$2,940.00 spent · $20.00 left", `In the shop reads "${colMoney("working")}"`);
// Nothing spent and nothing quoted-but-unspent: say nothing rather than "$0.00".
ok(colMoney("ready") === "", `an empty column's money reads "${colMoney("ready")}"`);

/* The card's "what does this still need" line is the server's sentence, not
   one the browser assembled -- the whole reason it is computed once. */
ok(cardFor("recon:2").querySelector(".veh-card-needs").textContent === "No ticket written yet · $600.00 of work left",
   `the Civic's needs line reads "${cardFor("recon:2").querySelector(".veh-card-needs").textContent}"`);
ok(cardFor("recon:1").querySelector(".veh-card-needs").textContent === "2 parts on order ($340.00)",
   "a card rewrote the server's needs sentence");
// Idle is spelled out on a card: there is no column header over it, and a bare
// "9d" beside "9d old" is two different day counts with no way to tell which.
ok(cardFor("recon:3").querySelector(".idle-cell").textContent.trim() === "Idle 9d",
   `the Silverado's idle chip reads "${cardFor("recon:3").querySelector(".idle-cell").textContent.trim()}"`);
ok(cardFor("recon:1").querySelector(".idle-cell").textContent.trim() === "Active today",
   "a car worked on today reads as idle on its card");
ok(!cardFor("recon:1").querySelector(".veh-card-quoted"),
   "a card is back to printing what the car was 'quoted'");
ok(/R\. Alvarez/.test(cardFor("we_owe:5").textContent), "a we-owe card doesn't name the customer");
ok(/1FTEW1E5XKF/.test(cardFor("recon:1").querySelector(".veh-card-sub span").title || ""),
   "a recon card doesn't carry the full VIN for hover");

/* Filters and search reach the columns, because they're the same rows. */
chip("recon").click();
ok(allCards().length === 3 && cardsIn("working").length === 2 && cardsIn("waiting").length === 1,
   `the Recon filter left ${allCards().length} cards`);
ok(cards().count === "3", "the summary cards stopped following the board in the columns layout");
chip("").click();
stalledCard().click();
ok(allCards().length === 2 && cardsIn("waiting").length === 1 && cardsIn("working").length === 1,
   `Stalled left ${allCards().length} cards across the columns`);
stalledCard().click();
search.value = "civic";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(allCards().length === 1 && cardsIn("waiting").length === 1, "search didn't narrow the columns");
search.value = "zzzznothing";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(/No vehicles match/.test(columnsHost.textContent), "an empty board shows no empty state in the columns layout");
ok(!columnsHost.querySelector(".veh-col"), "the empty state left the three column shells behind it");
columnsHost.querySelector('[data-empty-action="clear-search"]').click();
ok(allCards().length === 5, "the empty state's Clear search button didn't restore the columns");

/* Clicking a card is clicking a row: open, toggle, shift-range. The two
   layouts share one handler precisely so these can't drift apart. */
const fetchesBeforeCard = fetchLog.length;
click(w, cardFor("recon:3").querySelector(".veh-select"));
ok(w.state.vehicleSelection.has("recon:3"), "the card checkbox didn't select the vehicle");
ok(cardFor("recon:3").classList.contains("selected"), "a selected card isn't marked");
ok(fetchLog.length === fetchesBeforeCard, "the card checkbox also opened the vehicle");
click(w, cardFor("recon:1"), { ctrlKey: true });
ok(w.state.vehicleSelection.has("recon:1") && fetchLog.length === fetchesBeforeCard,
   "ctrl-click on a card navigated instead of selecting");
w.state.vehicleSelection.clear();
w.renderVehiclesTable();

/* Shift-click spans what you can see. In column order the Civic and the Camry
   have two cars between them; down the table they are neighbours -- so a range
   built from the table's order would quietly select two cars instead of four. */
click(w, cardFor("recon:2").querySelector(".veh-select"));
click(w, cardFor("we_owe:5").querySelector(".veh-select"), { shiftKey: true });
ok([...w.state.vehicleSelection].sort().join(",") === "recon:1,recon:2,we_owe:5,we_owe:6",
   `shift-click across the columns selected ${[...w.state.vehicleSelection].sort().join(",")}`);
w.state.vehicleSelection.clear();
w.state.vehicleCursor = null;
w.renderVehiclesTable();

/* Keyboard: the cursor walks the columns in the order they're painted. Down
   the table the order is B204, A118, Camry, C007, D451; in the columns it is
   the two not-started cars first. */
ok(w.displayedVehicles().map(w.vehicleKey).join(",") === "recon:2,we_owe:6,recon:1,we_owe:5,recon:3",
   `displayed order is ${w.displayedVehicles().map(w.vehicleKey).join(",")}`);
press(w, "ArrowDown");
ok(w.state.vehicleCursor === "recon:2", `ArrowDown landed on ${w.state.vehicleCursor}, not the first card`);
ok(cardFor("recon:2").classList.contains("cursor"), "the cursor card isn't marked");
press(w, "ArrowDown");
ok(w.state.vehicleCursor === "we_owe:6", "ArrowDown didn't follow the column, it followed the table");
press(w, "End");
ok(w.state.vehicleCursor === "recon:3", `End landed on ${w.state.vehicleCursor}`);
ok(doc.querySelectorAll("#view-vehicles .cursor").length === 1, "more than one card is marked as the cursor");
press(w, " ");
ok(w.state.vehicleSelection.has("recon:3"), "Space didn't select the cursor card");
press(w, " ");
const fetchesBeforeEnter = fetchLog.length;
press(w, "Enter");
await settle();
ok(fetchLog.length > fetchesBeforeEnter, "Enter didn't open the cursor card");

/* A car that finishes moves to Ready to go without a reload -- the pile is
   read off the row, so new data lands in the right column. */
w.state.vehicles = board.map((v) =>
  v.recon_id === 3 ? { ...v, status: "complete", status_bucket: "finished", lot_bucket: "ready", remaining_cost: 0, needs: "Nothing — ready to go" } : v);
w.renderVehiclesTable();
ok(cardsIn("ready").map((c) => c.dataset.key).join(",") === "recon:3",
   `a finished car didn't move to Ready to go, which holds ${cardsIn("ready").map((c) => c.dataset.key).join(",")}`);
ok(!colSection("ready").querySelector(".veh-col-blank"), "the empty-column line survived the column filling up");
ok(cardsIn("working").length === 2, "the finished car is still in the shop as well");
w.state.vehicles = board;
w.renderVehiclesTable();

/* Which layout you left it on is a working preference like the rest, and
   Reset view is about filters -- it must not throw you back into the table. */
ok(JSON.parse(w.localStorage.getItem("dao-vehicle-view")).layout === "columns", "the layout wasn't persisted");
w.state.vehicleLayout = "list";
w.loadVehicleViewPrefs();
ok(w.state.vehicleLayout === "columns" && !columnsHost.hidden, "the layout wasn't restored from preferences");
ok(doc.querySelector("#vehicles-reset-view").hidden, "picking a layout lit up Reset view -- it hides no cars");
w.resetVehicleView();
await settle();
ok(w.state.vehicleLayout === "columns" && allCards().length === 5, "Reset view threw the board back into the table");

// Raw HTML has to be escaped on a card exactly as it is in a row.
w.state.vehicles = [veh({ recon_id: 9, stock_number: '<img src=x onerror="window.__pwned=1">', vehicle: "X", needs: '<img src=x onerror="window.__pwned=1">' })];
w.renderVehiclesTable();
ok(!columnsHost.querySelector("img") && !w.__pwned, "the columns render raw HTML out of vehicle fields");

w.setVehicleLayout("list");
ok(columnsHost.hidden && !listPanel.hidden, "switching back to List didn't restore the table");
w.state.vehicles = board;
w.renderVehiclesTable();

/* ---------- History reads the same rows a different way ----------

   History is not a lot, it is a record of cars that are gone, and everything
   the live board is built to do is about what to act on this morning. Applied
   to a car that left in the spring, every one of those is a false statement:
   a sold car sat under "Not started", the Stalled clock kept counting on it
   (and the archive itself bumped that clock, so a car filed away in April
   read "Active today"), Age went on climbing after the car was somebody
   else's, and the three columns finished with "Nothing finished yet" printed
   under a screenful of finished cars.

   Dates below are fixed rather than relative, so the assertions say exactly
   what they mean; the two "this month" ones are computed off the clock, which
   is the one number here that has to move with it. */
const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
archived = [
  // Left this month, and the long one: 90 days on the lot.
  veh({ recon_id: 41, stock_number: "H901", vehicle: "2016 Ford Fusion", status: "complete",
        status_bucket: "finished", lot_bucket: "ready", needs: "Nothing — ready to go",
        acquired_at: "2026-01-04", age_days: 400, idle_days: 0, actual_cost: 800,
        archived_at: `${thisMonth}-11T16:20:00`, days_on_lot: 90 }),
  // Also this month, and cheap and quick -- so the averages can't pass by
  // being computed off a single row.
  veh({ recon_id: 42, stock_number: "H902", vehicle: "2018 Kia Soul", status: "complete",
        status_bucket: "finished", lot_bucket: "ready", needs: "Nothing — ready to go",
        acquired_at: "2026-02-01", age_days: 380, idle_days: 3, actual_cost: 200,
        archived_at: `${thisMonth}-02T09:00:00`, days_on_lot: 10 }),
  // Earlier the same year, and one from a previous year: one car per column.
  veh({ recon_id: 43, stock_number: "H903", vehicle: "2015 Chevy Malibu", status: "complete",
        status_bucket: "finished", lot_bucket: "ready", needs: "Nothing — ready to go",
        acquired_at: `${now.getFullYear()}-01-05`, age_days: 300, idle_days: 40, actual_cost: 500,
        archived_at: `${now.getFullYear()}-01-20T11:00:00`, days_on_lot: 15 }),
  veh({ segment: "we_owe", we_owe_id: 44, stock_number: "", vehicle: "2013 Jeep Patriot",
        customer_name: "P. Okafor", status: "fulfilled", status_bucket: "finished",
        lot_bucket: "ready", needs: "Nothing — ready to go", age_days: 900, idle_days: 700,
        actual_cost: 100, archived_at: `${now.getFullYear() - 1}-11-30T10:00:00`, days_on_lot: 20 }),
];
w.resetVehicleView();
await settle();
w.setVehicleLayout("list");

// A live-lot filter left on from the board cannot match an archived car, so
// carrying one into History would show an empty screen and a scope line about
// parts on order. It gets dropped on the way in.
w.state.vehiclePartsOnly = true;
const viewSelect = doc.querySelector("#vehicles-view-filter");
viewSelect.value = "history";
viewSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(w.state.boardView === "history", `the Show dropdown left the board on "${w.state.boardView}"`);
ok(!w.state.vehiclePartsOnly, "a live-lot filter followed the advisor into History");
ok(dataRows().length === 4, `History shows ${dataRows().length} of 4 archived cars`);
ok(doc.querySelector("#vehicles-parts-filter").hidden,
   "the 'waiting on parts' toggle is still on the toolbar in History, where nothing is waiting");

/* The two columns whose question changes. Age stops being "how long ago did
   this arrive" -- a number that goes on growing after the car is sold -- and
   becomes the finished stay; Idle stops being a clock and becomes the date
   the car left. The heading has to follow the cells, or a column of bare
   numbers means nothing. */
const headText = (key) => th(key).textContent.replace(/[▼▲]/g, "").trim();
ok(headText("age") === "Stay", `the Age header reads "${headText("age")}" in History`);
ok(headText("idle") === "Left", `the Idle header reads "${headText("idle")}" in History`);
const stockRow = (stock) => dataRows().find((tr) => tr.children[1].querySelector(".stock-no").textContent.trim() === stock);
const cellText = (stock, sel) => stockRow(stock).querySelector(sel).textContent.trim();
ok(cellText("H901", ".age-cell") === "90d",
   `the Fusion's stay reads "${cellText("H901", ".age-cell")}", not its 90 days on the lot`);
ok(/Jan 20/.test(cellText("H903", ".idle-cell")),
   `the Malibu's Left cell reads "${cellText("H903", ".idle-cell")}"`);
ok(/15 days on the lot/.test(stockRow("H903").querySelector(".idle-cell").title),
   `the Left tooltip reads "${stockRow("H903").querySelector(".idle-cell").title}"`);
// Nothing about a car that has gone is an alarm. The 700-day-idle Jeep would
// have been painted as the worst car on the lot.
ok(!doc.querySelector("#vehicles-table .age-crit") && !doc.querySelector("#vehicles-table .idle-cell.age-crit"),
   "History is still painting finished cars red");

/* The three cards that are live-lot alarms become read-outs about finished
   work. Averages over the four rows: ($800 + $200 + $500 + $100) / 4 = $400,
   and (90 + 10 + 15 + 20) / 4 = 34 days, longest 90. */
const label = (f) => doc.querySelector(`[data-board-filter="${f}"] .stat-label`).textContent.trim();
ok(label("parts") === "Average Per Car" && label("stalled") === "Average Stay"
   && label("late") === "Left This Month",
   `History's cards read ${label("parts")} / ${label("stalled")} / ${label("late")}`);
ok(card("stat-parts-waiting") === "$400.00", `Average Per Car reads "${card("stat-parts-waiting")}"`);
ok(card("stat-parts-waiting-sub") === "across 4 vehicles", `its sub reads "${card("stat-parts-waiting-sub")}"`);
ok(card("stat-stalled") === "34d", `Average Stay reads "${card("stat-stalled")}"`);
ok(card("stat-stalled-sub") === "longest was 90 days", `its sub reads "${card("stat-stalled-sub")}"`);
ok(card("stat-late-promises") === "2", `Left This Month reads "${card("stat-late-promises")}", expected 2`);
ok(card("stat-actual-total") === "$1,600.00", `History's Cost reads "${card("stat-actual-total")}"`);
// Read-outs, not filters: there is nothing in History to narrow to, and left
// clickable they would filter by a live-lot rule that matches nothing.
ok(["parts", "stalled", "late"].every((f) => doc.querySelector(`[data-board-filter="${f}"]`).disabled),
   "a History card is still clickable as a filter");
ok(doc.querySelector("#vehicles-chart").hidden && doc.querySelector("#vehicles-chart-toggle").hidden,
   "the 'time since anything happened' chart is still up in History, measuring a stopped clock");

// Sorting the Left column puts the most recently gone car first, which is the
// order a logbook is read in.
th("idle").click();
ok(stocks()[0] === "H901", `sorted by Left, History starts with ${stocks()[0]} instead of the newest`);

/* The columns become when the car left, not where it is up to. */
w.setVehicleLayout("columns");
ok(w.boardColumns().map((c2) => c2.key).join(",") === "left-this-month,left-this-year,left-earlier",
   "History's columns aren't the three the cards are dealt into");
ok(cardsIn("left-this-month").map((c2) => c2.dataset.key).sort().join(",") === "recon:41,recon:42",
   `Left this month holds ${cardsIn("left-this-month").map((c2) => c2.dataset.key).join(",")}`);
ok(cardsIn("left-this-year").map((c2) => c2.dataset.key).join(",") === "recon:43",
   `Earlier this year holds ${cardsIn("left-this-year").map((c2) => c2.dataset.key).join(",")}`);
ok(cardsIn("left-earlier").map((c2) => c2.dataset.key).join(",") === "we_owe:44",
   `Before this year holds ${cardsIn("left-earlier").map((c2) => c2.dataset.key).join(",")}`);
ok(!columnsHost.textContent.includes("Nothing finished yet"),
   "History is still printing the live board's empty-column lines");
// $800 + $200 this month, and nothing "left" to spend on a car that is gone.
ok(colMoney("left-this-month") === "$1,000.00 spent",
   `Left this month reads "${colMoney("left-this-month")}"`);
ok(cardFor("recon:41").querySelector(".idle-cell").textContent.trim().startsWith("Left "),
   `an archived card's chip reads "${cardFor("recon:41").querySelector(".idle-cell").textContent.trim()}"`);

/* ...and going back restores every one of them. The wording is written on
   each render rather than only on the way in, so the board cannot come back
   with "Average Per Car" sitting over a count of cars waiting on a part.

   Back through the Show dropdown, which is what owns this now -- the All chip
   below it answers a different question (which kind of work) and leaving
   History was never really its job. */
viewSelect.value = "active";
viewSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
w.setVehicleLayout("list");
ok(headText("age") === "Age" && headText("idle") === "Idle",
   `back on the board the headers read ${headText("age")} / ${headText("idle")}`);
ok(label("parts") === "Waiting on Parts" && label("stalled") === "Stalled"
   && label("late") === "Past Promised",
   `back on the board the cards read ${label("parts")} / ${label("stalled")} / ${label("late")}`);
ok(!doc.querySelector("#vehicles-parts-filter").hidden, "the parts toggle didn't come back");
ok(!doc.querySelector("#vehicles-chart-toggle").hidden, "the chart toggle didn't come back");
ok(dataRows().length === 5 && cellText("C007", ".idle-cell") === "9d",
   "the board came back showing History's wording");
w.state.vehicleSort = { key: "", dir: "desc" };
w.renderVehiclesTable();

/* ---------- filing cars away says what money the app can't see ----------

   Sending twenty cars to History at once is exactly where a part nobody
   marked received gets buried, because nobody opens twenty tickets to check.
   The rows already carry the figure; the confirmation has to use it. Its own
   little board, so the hand-checked fixture above stays untouched. */
const archiveBtn = doc.querySelector("#vehicles-bulk-archive");
const confirmBody = () => doc.querySelector("#confirm-body").textContent;
w.state.vehicles = [
  veh({ recon_id: 21, stock_number: "E100", vehicle: "2016 Ford Fusion", unreceived_cost: 380 }),
  veh({ recon_id: 22, stock_number: "E200", vehicle: "2018 Kia Sorento", unreceived_cost: 140 }),
  veh({ recon_id: 23, stock_number: "E300", vehicle: "2017 Hyundai Elantra" }),
];
w.renderVehiclesTable();
w.state.vehicleSelection = new Set(["recon:21", "recon:22", "recon:23"]);
archiveBtn.click();
await settle();
ok(/2 of them have parts that were never marked received/.test(confirmBody()),
   `filing three cars away said nothing about the two that are short: ${confirmBody()}`);
ok(/\$520\.00/.test(confirmBody()), `the shortfall across the selection is wrong: ${confirmBody()}`);
doc.querySelector("#confirm-cancel").click();
await settle();

// The car that is fully receipted gets the plain wording back -- a warning
// printed over every archive is a warning nobody reads.
w.state.vehicleSelection = new Set(["recon:23"]);
archiveBtn.click();
await settle();
ok(!/never marked received/.test(confirmBody()),
   `a fully receipted car was warned about anyway: ${confirmBody()}`);
doc.querySelector("#confirm-cancel").click();
await settle();
w.state.vehicleSelection.clear();

/* ---------- escaping ---------- */
w.state.vehicles = [veh({ recon_id: 9, stock_number: '<img src=x onerror="window.__pwned=1">', vehicle: "X" })];
w.renderVehiclesTable();
ok(!body.querySelector("img") && !w.__pwned, "the board renders raw HTML out of vehicle fields");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("vehicles board: sorting, filtering, selection, keyboard nav, incremental render");
