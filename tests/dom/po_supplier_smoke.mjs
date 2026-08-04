// "Who did we order this from?" -- on the ticket, and on the chase desk.
//
// RECON hands out a PO number to say to a vendor and never asked which vendor
// it was said to. Two screens are driven here because the answer is only worth
// anything if it travels between them: the box on the ticket's PO strip, which
// is typed with the vendor still on the phone, and the Ordered From column on
// Parts & Cores, which is where somebody stands three days later wondering who
// to ring.
//
// The assertions lean on the things a plain input parked inside a chip gets
// wrong: the box must not double as the chip's click target (that toggles the
// parts highlight underneath), it must not save on every keystroke, and a
// batch nobody recorded a supplier for must say so rather than render blank --
// blank reads as "no supplier involved", and there is always a supplier.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

const vehicle = {
  id: 7, stock_number: "R-1002", year: 2017, make: "Hyundai", model: "Elantra",
  vin: "5NPD84LF0HH123456", mileage: 84500, trim: "SE", color: "Silver",
  purchase_price: null, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 1, created_at: daysAgo(25), updated_at: daysAgo(1),
  orders: [], total_cost: 0, quoted_cost: 420, profit: null, status_bucket: "in_progress",
  last_activity: { at: daysAgo(1), idle_days: 1, action: "parts_ordered", actor: "Antonio" },
};

// Two batches, deliberately in the two states that matter. R8-1 is still out
// with parts on it and nobody written against it -- the one worth nagging
// about. R8-2 has fully turned up, so the question has stopped mattering and
// it must not nag.
let purchaseOrders = [
  { id: 91, order_id: 42, sequence: 1, number: "R8-1", vendor_id: null, vendor_name: null,
    note: "", line_count: 2, received_count: 0, closed_at: daysAgo(3), created_at: daysAgo(3) },
  { id: 92, order_id: 42, sequence: 2, number: "R8-2", vendor_id: 4, vendor_name: "NAPA",
    note: "", line_count: 1, received_count: 1, closed_at: daysAgo(2), created_at: daysAgo(2) },
];

const order = {
  id: 42, ro_number: 8, number: "RO-2608-0008", concern: "Windshield + brakes",
  status: "in_progress", voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: daysAgo(25), notes: [], activity: [],
  assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
  quoted_cost: 420, actual_cost: 0,
  estimate: { id: 1, jobs: [], items: [
    { id: 1, kind: "part", description: "Windshield", part_number: "WS-4471", quantity: 1,
      unit_price: 180, unit_cost: 180, line_total: 180, status: "ordered", po_number: "R8-1",
      received_quantity: 0, core_charge: 0, job_id: null, source: "manual" },
    { id: 2, kind: "part", description: "Brake pads + rotors", part_number: "BR-KIT-90", quantity: 1,
      unit_price: 240, unit_cost: 240, line_total: 240, status: "ordered", po_number: "R8-1",
      received_quantity: 0, core_charge: 0, job_id: null, source: "manual" },
  ] },
  purchase_orders: purchaseOrders,
};

// Parts on order, as the chase desk sees them: one batch with a supplier
// recorded and two lines outstanding, one batch with nobody against it.
const partsOnOrder = [
  { id: 1, description: "Windshield", part_number: "WS-4471", quantity: 1, received_quantity: 0,
    unit_cost: 180, ordered_at: daysAgo(9), core_charge: 0, order_id: 42, ro_number: "RO-2608-0008",
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, vehicle_id: 3, vehicle: "2017 Hyundai Elantra",
    vehicle_label: "R-1002", stock_number: "R-1002", outstanding_quantity: 1, value: 180, days_waiting: 9,
    po_id: 91, po_number: "R8-1", vendor_id: 2, vendor_name: "Cal's Auto Salvage", po_outstanding: 2 },
  { id: 2, description: "Brake pads + rotors", part_number: "BR-KIT-90", quantity: 1, received_quantity: 0,
    unit_cost: 240, ordered_at: daysAgo(9), core_charge: 0, order_id: 42, ro_number: "RO-2608-0008",
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, vehicle_id: 3, vehicle: "2017 Hyundai Elantra",
    vehicle_label: "R-1002", stock_number: "R-1002", outstanding_quantity: 1, value: 240, days_waiting: 9,
    po_id: 91, po_number: "R8-1", vendor_id: 2, vendor_name: "Cal's Auto Salvage", po_outstanding: 2 },
  { id: 3, description: "Mounting bracket kit", part_number: "RB-BRK-20", quantity: 1, received_quantity: 0,
    unit_cost: 95, ordered_at: daysAgo(2), core_charge: 0, order_id: 43, ro_number: "RO-2608-0010",
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 5, vehicle_id: 4, vehicle: "2020 Kia Soul",
    vehicle_label: "We-Owe: Jordan Whitfield", stock_number: null, outstanding_quantity: 1, value: 95,
    days_waiting: 2, po_id: 93, po_number: "R10-1", vendor_id: null, vendor_name: "", po_outstanding: 1 },
  // Ordered before RECON recorded batches at all: no PO, no supplier, and it
  // must not borrow either from the rows above it.
  { id: 4, description: "Sway bar links", part_number: "SB-9", quantity: 1, received_quantity: 0,
    unit_cost: 40, ordered_at: "", core_charge: 0, order_id: 44, ro_number: "RO-2607-0001",
    segment: "recon", recon_vehicle_id: 8, we_owe_id: null, vehicle_id: 5, vehicle: "2016 Ford Fusion",
    vehicle_label: "R-0997", stock_number: "R-0997", outstanding_quantity: 1, value: 40,
    days_waiting: null, po_id: null, po_number: null, vendor_id: null, vendor_name: "", po_outstanding: 0 },
];

const poPatches = [];
let vendorCalls = 0;
let patchFails = false;

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "loadCoresView"],
  fetch: async (url, opts = {}) => {
    if (/^\/api\/orders\/42\/purchase-orders\/\d+$/.test(url) && opts.method === "PATCH") {
      poPatches.push({ url, body: JSON.parse(opts.body) });
      if (patchFails) return { __status: 409, body: { detail: "This car has been sent to History" } };
      const po = purchaseOrders.find((p) => String(p.id) === url.split("/").pop());
      po.vendor_name = JSON.parse(opts.body).vendor_name || null;
      po.vendor_id = po.vendor_name ? 2 : null;
      return po;
    }
    if (url === "/api/vendors") {
      vendorCalls += 1;
      return [{ id: 2, name: "Cal's Auto Salvage", aliases: [] }, { id: 4, name: "NAPA", aliases: [] }];
    }
    if (url === "/api/parts/on-order") return partsOnOrder;
    if (url === "/api/cores" || url === "/api/returns") return [];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return [{ id: 1, name: "Antonio", role: "technician", active: 1 }];
    if (url.startsWith("/api/tasks")) return [];
    return [];
  },
});

await settle();
await w.openVehicleDetail("recon", 7);
await settle();

/* ---------- the box on the ticket ---------- */

const boxes = [...doc.querySelectorAll("#vd-po-strip .po-chip-vendor")];
ok(boxes.length === 2, `expected a supplier box on each of the 2 batches, found ${boxes.length}`);

const openBox = boxes[0];
const doneBox = boxes[1];
ok(openBox.value === "", `the unrecorded batch should start empty, got "${openBox.value}"`);
ok(doneBox.value === "NAPA", `a recorded supplier should show, got "${doneBox.value}"`);

// The nag is only on a batch still waiting on parts. An empty box shouting on
// every finished PO in a car's history trains people to ignore all of them.
ok(openBox.classList.contains("po-chip-vendor-wanted"),
   "a batch still out with nobody recorded against it isn't asking for a supplier");
ok(!doneBox.classList.contains("po-chip-vendor-wanted"),
   "a fully-received batch is still nagging for a supplier it no longer needs");

// Autocomplete is fetched on first reach, not on every ticket open -- opening
// a ticket is the commonest thing in the app.
ok(vendorCalls === 0, "the vendor list was fetched just for opening a ticket");
openBox.dispatchEvent(new w.FocusEvent("focusin", { bubbles: true }));
await settle();
ok(vendorCalls === 1, `focusing the supplier box should fetch vendors once, got ${vendorCalls}`);
const options = [...doc.querySelectorAll("#po-vendor-options option")].map((o) => o.value);
ok(options.includes("Cal's Auto Salvage") && options.includes("NAPA"),
   `the supplier box offers no known vendors, got ${JSON.stringify(options)}`);

/* Typing must not save. `change` is what fires on Enter, tab and clicking
   away -- an input handler would post a vendor per keystroke, creating "C",
   "Ca", "Cal" as three vendor records. */
openBox.value = "Cal";
openBox.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(poPatches.length === 0, `typing saved ${poPatches.length} time(s) before the name was finished`);

openBox.value = "Cal's Auto Salvage";
openBox.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(poPatches.length === 1, `finishing the name should save exactly once, saved ${poPatches.length} times`);
ok(poPatches[0].url.endsWith("/purchase-orders/91"),
   `the supplier went to the wrong batch: ${poPatches[0].url}`);
ok(poPatches[0].body.vendor_name === "Cal's Auto Salvage",
   `sent ${JSON.stringify(poPatches[0].body)}`);

// Tabbing across a box nobody edited must write nothing.
const untouched = [...doc.querySelectorAll("#vd-po-strip .po-chip-vendor")][1];
untouched.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(poPatches.length === 1, "leaving an unedited supplier box still saved it");

/* ---------- the box must not be the chip's click target ---------- */

const chip = doc.querySelector("#vd-po-strip .po-chip");
chip.querySelector(".po-chip-main").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await settle();
ok(doc.querySelectorAll(".po-chip-active").length === 1,
   "clicking the PO number no longer highlights its batch");
ok(doc.querySelectorAll("#vd-estimate-items .part-row.po-highlight").length === 2,
   "clicking the PO number no longer lights up its own parts below");

const before = doc.querySelectorAll(".po-chip-active").length;
chip.querySelector(".po-chip-vendor").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await settle();
ok(doc.querySelectorAll(".po-chip-active").length === before,
   "clicking into the supplier box toggles the parts highlight underneath it");

/* A refused save must put the box back to what it said before, not leave a
   name on screen the server never took. */
patchFails = true;
const box = doc.querySelector("#vd-po-strip .po-chip-vendor");
const was = box.value;
box.value = "Somewhere Else";
box.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(box.value === was,
   `a refused save left "${box.value}" on screen when the record still says "${was}"`);
ok(doc.querySelector("#toast").classList.contains("error"), "a refused save said nothing");
patchFails = false;

/* ---------- the chase desk ---------- */

await w.loadCoresView();
await settle();

const headers = [...doc.querySelectorAll("#view-cores .desk-order thead th")].map((h) => h.textContent.trim());
ok(headers.includes("Ordered From"), `the chase desk has no supplier column: ${JSON.stringify(headers)}`);

const rows = [...doc.querySelectorAll("#on-order-table tr")];
ok(rows.length === 4, `expected 4 parts on order, rendered ${rows.length}`);
ok(rows.every((r) => r.cells.length === headers.length),
   `a row has a different number of cells than the header has columns`);

const supplierOf = (i) => rows[i].cells[headers.indexOf("Ordered From")].textContent;
ok(/Cal's Auto Salvage/.test(supplierOf(0)), `row 1 supplier reads "${supplierOf(0).trim()}"`);
ok(/R8-1/.test(supplierOf(0)), `row 1 doesn't say which PO to quote: "${supplierOf(0).trim()}"`);

// One call, not two. Two lines on one batch is one phone number.
ok(/2 parts on this PO/.test(supplierOf(0)),
   `row 1 doesn't say its batch has another part on it: "${supplierOf(0).trim()}"`);
ok(!/parts on this PO/.test(supplierOf(2)),
   `row 3 is the only part on its batch and claims otherwise: "${supplierOf(2).trim()}"`);

// Nobody wrote it down -- said plainly, and not confused with a part that
// predates batches entirely.
ok(/supplier not recorded/.test(supplierOf(2)), `row 3 reads "${supplierOf(2).trim()}"`);
ok(/R10-1/.test(supplierOf(2)), `row 3 lost its PO number: "${supplierOf(2).trim()}"`);
ok(/not recorded/.test(supplierOf(3)) && !/R\d+-\d+/.test(supplierOf(3)),
   `a part with no batch at all borrowed a PO number: "${supplierOf(3).trim()}"`);
ok(!/undefined|null/.test(rows.map((r) => r.textContent).join(" ")),
   "a missing supplier rendered as undefined/null on the chase desk");

// Searching by supplier is the whole reason it's on screen: "what am I
// waiting on from Cal's" has to be one box, not four rows read by eye.
const search = doc.querySelector("#on-order-search");
search.value = "cal's";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(doc.querySelectorAll("#on-order-table tr").length === 2,
   `searching a supplier should leave its 2 parts, left ${doc.querySelectorAll("#on-order-table tr").length}`);

search.value = "R10-1";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(doc.querySelectorAll("#on-order-table tr").length === 1,
   "searching a PO number doesn't find the parts that went out on it");

search.value = "";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();

// The empty state has to span the widened table, or it sits under one column.
search.value = "nothing matches this";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
const emptyCell = doc.querySelector("#on-order-table td[colspan]");
ok(emptyCell && Number(emptyCell.getAttribute("colspan")) === headers.length,
   `the empty state spans ${emptyCell && emptyCell.getAttribute("colspan")} of ${headers.length} columns`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("purchase order supplier: the box on the ticket, and Ordered From on the parts-chase desk");
