// The Vehicles board's Show dropdown: three separate piles, one control.
//
// Which kind of work (recon / we-owe) and which pile the record is in were
// one row of chips, with "History" sitting in among the segments as though it
// were a third kind of work. There was nowhere to put a third state at all,
// so a car whose only ticket had been voided stayed in with the live work
// looking like a car nobody had started.
//
// What is checked here and nowhere else: that the dropdown asks the server
// for the right pile, that the segment chips still narrow inside whichever
// pile is showing, and -- the part that matters most -- that taking void cars
// off the live board does not make them vanish. A car that silently stops
// being anywhere is the exact failure voiding used to cause.

import { boot, click } from "./harness.mjs";

const ACTIVE = [
  { segment: "recon", recon_id: 1, id: 1, stock_number: "A-100", vehicle: "2019 Ford F-150", status: "in_progress",
    status_bucket: "in_progress", lot_bucket: "working", actual_cost: 0, open_cost: 0, quoted_cost: 0, parts_pending: 0,
    age_days: 3, idle_days: 1, archived_at: "", days_on_lot: null, voided_order_count: 0, order_id: 11, technicians: [] },
  { segment: "we_owe", we_owe_id: 2, id: 2, stock_number: "", vehicle: "2020 Kia Soul", customer_name: "Renata Silva",
    status: "complete", status_bucket: "finished", lot_bucket: "ready", actual_cost: 0, open_cost: 0, quoted_cost: 0,
    parts_pending: 0, age_days: 5, idle_days: 2, archived_at: "", days_on_lot: null, voided_order_count: 0,
    order_id: 12, technicians: [] },
];

const VOIDED = [
  { segment: "recon", recon_id: 3, id: 3, stock_number: "V-300", vehicle: "2016 Ford Fusion", status: "acquired",
    status_bucket: "in_progress", lot_bucket: "waiting", actual_cost: 0, open_cost: 0, quoted_cost: 0, parts_pending: 0,
    age_days: 40, idle_days: 40, archived_at: "", days_on_lot: null, voided_order_count: 1, order_id: null,
    technicians: [] },
];

const ARCHIVED = [
  { segment: "recon", recon_id: 4, id: 4, stock_number: "H-400", vehicle: "2015 Ford Focus", status: "complete",
    status_bucket: "finished", lot_bucket: "ready", actual_cost: 0, open_cost: 0, quoted_cost: 0, parts_pending: 0,
    age_days: 90, idle_days: 60, archived_at: "2026-07-02T10:00:00", days_on_lot: 30, voided_order_count: 0,
    order_id: 14, technicians: [] },
];

const asked = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["loadVehiclesView", "renderVehiclesTable", "state"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) {
      asked.push(url);
      if (url.includes("view=history")) return ARCHIVED;
      if (url.includes("view=void")) return VOIDED;
      return ACTIVE;
    }
    if (url === "/api/staff" || url === "/api/tasks" || url === "/api/orders" || url === "/api/customers") return [];
    return null;
  },
});

const $ = (sel) => doc.querySelector(sel);
const select = () => $("#vehicles-view-filter");
// Both layouts are in the DOM at once (only one is shown), so the same car
// answers twice -- deduped rather than scoped to one, so this reads the same
// whichever layout the prefs happen to have left on.
const stocks = () => [...new Set(
  Array.from(doc.querySelectorAll("#vehicles-columns .veh-card, #vehicles-table tr.clickable"))
    .map((el) => el.dataset.key).filter(Boolean))];
const pick = async (value) => {
  select().value = value;
  select().dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle();
};

await w.loadVehiclesView();
await settle();

/* ---------- the live board asks for the active pile ---------- */
ok(select(), "the Show dropdown is not on the screen");
ok(select().value === "active", `the board opened on "${select().value}"`);
ok(asked.some((u) => u.includes("view=active")), `the board never asked for the active pile: ${asked.join(", ")}`);
ok(!doc.querySelector('#view-vehicles .filters .chip[data-filter="history"]'),
   "History is still a segment chip, alongside the kinds of work it is not one of");

/* ---------- a voided car is off the live board, but says so ---------- */
ok(!stocks().some((k) => k === "recon:3"), "a car with only a voided ticket is sitting in with the live work");
const nudge = $("#vehicles-void-nudge");
ok(!nudge.hidden, "the live board says nothing about the car it is holding back");
ok(/1 car has only a voided ticket/.test(nudge.textContent),
   `the nudge reads "${nudge.textContent.replace(/\s+/g, " ").trim()}"`);

/* ---------- and one click gets to it ---------- */
click(w, nudge.querySelector('[data-search-reach="show-void"]'));
await settle();
ok(w.state.boardView === "void", `Show them left the board on "${w.state.boardView}"`);
ok(stocks().includes("recon:3"), `the Void pile didn't hold the car: ${stocks().join(", ")}`);
ok(select().value === "void", "the dropdown didn't follow the jump into Void");
ok($("#vehicles-void-nudge").hidden, "the nudge is still pointing at the pile you are already looking at");

/* ---------- History is its own pile, off the same control ---------- */
await pick("history");
ok(asked.some((u) => u.includes("view=history")), "History never asked the server for the archived list");
ok(stocks().includes("recon:4"), `History didn't hold the archived car: ${stocks().join(", ")}`);
ok(!stocks().includes("recon:1"), "a live car turned up in History");

/* ---------- back to the live work ---------- */
await pick("active");
ok(stocks().includes("recon:1") && stocks().includes("we_owe:2"), `the live board came back as: ${stocks().join(", ")}`);
ok(!stocks().includes("recon:3"), "the voided car came back with the live work");

/* ---------- the chips still narrow inside the pile ---------- */
click(w, doc.querySelector('#view-vehicles .filters .chip[data-filter="we_owe"]'));
await settle();
ok(stocks().length === 1 && stocks()[0] === "we_owe:2",
   `We-Owe inside the active pile shows: ${stocks().join(", ")}`);
ok(w.state.boardView === "active", "picking a segment chip changed which pile is showing");

/* ---------- a finished we-owe is in Ready to go, not In the shop ---------- */
click(w, doc.querySelector('#view-vehicles .filters .chip[data-filter=""]'));
await settle();
const readyCol = doc.querySelector('[data-lot-column="ready"]');
ok(readyCol, "the board has no Ready column");
ok(/Ready to go/.test(readyCol.textContent),
   `the finished column is still called "${readyCol.querySelector(".veh-col-title")?.textContent}"`);
ok(readyCol.textContent.includes("Kia Soul"),
   "the finished we-owe is not in the Ready column, which is the whole complaint");

/* ---------- nothing in Void can be filed away ---------- */
// A car whose only ticket was a mistake has no finished work to file, so the
// archive action is off the bulk bar there -- offering it is how a loose end
// gets buried instead of dealt with.
await pick("void");
w.state.vehicleSelection.add("recon:3");
w.renderVehiclesTable();
await settle();
ok($("#vehicles-bulk-archive").hidden, "Send to History is offered on a car whose only ticket was voided");
await pick("active");
w.state.vehicleSelection.clear();
w.renderVehiclesTable();
await settle();
ok(!$("#vehicles-bulk-archive").hidden || !w.state.vehicleSelection.size,
   "the archive action did not come back on the live board");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((r) => r && r.message).join("; ")}`);

finish("board views: Active, History and Void are three piles, and a voided car is held back without going missing");
