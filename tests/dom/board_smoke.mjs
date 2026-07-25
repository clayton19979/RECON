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
  age_days: 1, ...over,
});

// Deliberately not in any column's sorted order, so "did it sort?" can't pass
// by accident on the server's own ordering.
let board = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150", vin: "1FTEW1E5XKF", status: "in_progress", technicians: ["Dana"], age_days: 22, quoted_cost: 900, actual_cost: 1450 }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic", vin: "2HGFC2F69MH", status: "estimate", technicians: [], age_days: 3, quoted_cost: 600, actual_cost: 0 }),
  veh({ segment: "we_owe", we_owe_id: 5, stock_number: "", vehicle: "2017 Toyota Camry", customer_name: "R. Alvarez", status: "pending_approval", status_bucket: "in_progress", technicians: ["Chris", "Dana"], age_days: 41, quoted_cost: 300, actual_cost: 310 }),
  veh({ recon_id: 3, stock_number: "C007", vehicle: "2015 Chevy Silverado", vin: "3GCUKREC0FG", status: "complete", status_bucket: "finished", technicians: ["Bo"], age_days: 9, quoted_cost: 1200, actual_cost: 1180 }),
  veh({ segment: "we_owe", we_owe_id: 6, stock_number: "D451", vehicle: "2020 Subaru Outback", customer_name: "T. Nguyen", status: "fulfilled", status_bucket: "finished", technicians: [], age_days: 15, quoted_cost: 0, actual_cost: 0 }),
];

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "renderVehiclesTable", "loadVehiclesView", "visibleVehicles", "sortVehicleRows",
           "vehicleKey", "loadVehicleViewPrefs", "renderVehicleStatusOptions", "VEHICLE_SORTS",
           "VEHICLE_PREFS_KEY", "resetVehicleView"],
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
