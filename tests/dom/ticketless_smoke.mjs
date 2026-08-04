// A car with no repair order shows its own record, and nobody else's.
//
// Three of the eight cars on the seeded board have no ticket written, and on a
// real lot that pile is the one Walt asks about: the cars that have sat
// longest because nothing has been started on them. Opening one used to be
// handled by bailing out of the render early, which hid the parts grid and
// left every other ticket-scoped panel showing whatever the *previous* car
// had put there.
//
// So the whole test is one navigation: open a car with a ticket, read what
// its page says, then open a car without one and check that none of it
// survived. Everything asserted below was observed leaking in the running app
// -- the odometer of the car before it, that car's notes, that car's activity
// log -- and the last section covers what happened when somebody then tried
// to use the controls those panels sit next to.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

// The car with the ticket: worked on this morning, notes on it, a full
// activity log, a technician, and 84,500 miles written on its ticket.
const ticketed = {
  id: 2, stock_number: "R-1002", year: 2017, make: "Hyundai", model: "Elantra",
  vin: "5NPD84LF0HH123456", mileage: 84500, trim: "SE", color: "Silver",
  purchase_price: 6100, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 2, created_at: daysAgo(25), updated_at: daysAgo(0),
  orders: [], total_cost: 420, quoted_cost: 420, profit: null, status_bucket: "in_progress",
  last_activity: { at: daysAgo(0), idle_days: 0, action: "parts_received", actor: "Ray Ortiz" },
};

// The car without one: acquired twelve days ago, nobody has written it up.
// Its real mileage is 71,200, which is what makes the leak legible -- the
// Timing card read 84,500 three inches under a Vehicle Info card correctly
// reading 71,200.
const ticketless = {
  id: 1, stock_number: "R-1001", year: 2018, make: "Kia", model: "Sorento",
  vin: "5XYPGDA31JG123456", mileage: 71200, trim: "LX", color: "White",
  purchase_price: 5200, sale_price: null, status: "acquired", archived_at: "",
  edit_version: 1, created_at: daysAgo(13), updated_at: daysAgo(13),
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
  last_activity: { at: daysAgo(12), idle_days: 12, action: "", actor: "" },
};

const order = {
  id: 8, number: "RO-2608-0008", ro_number: 8, concern: "Front end recon prep",
  status: "in_progress", voided: 0, segment: "recon", recon_vehicle_id: 2, we_owe_id: null,
  created_at: daysAgo(25),
  estimate: {
    id: 3,
    jobs: [{ id: 11, title: "Windshield", completed_at: daysAgo(1), technician_id: null }],
    items: [{
      id: 101, kind: "part", description: "Windshield", part_number: "WP-5501",
      quantity: 1, unit_price: 180, unit_cost: 180, quoted_unit_cost: 180, core_charge: 0,
      status: "received", received_quantity: 1, part_returned: 0, core_return_invoice_number: "",
      job_id: 11, vendor_name: "WorldPac", invoice_number: "WP-5501", purchase_order_number: "R8-1",
    }],
  },
  purchase_orders: [{ id: 1, number: "R8-1", sequence: 1, line_count: 1, received_count: 1, closed_at: daysAgo(1), vendor_name: "WorldPac" }],
  notes: [{ id: 5, text: "Customer wants the windshield done before Friday", visibility: "internal", actor: "ui", created_at: daysAgo(0) }],
  activity: [
    { id: 1, action: "order_created", actor: "ui", details: {}, created_at: daysAgo(25) },
    { id: 2, action: "job_created", actor: "ui", details: {}, created_at: daysAgo(2) },
    { id: 3, action: "parts_received", actor: "Ray Ortiz", details: {}, created_at: daysAgo(0) },
  ],
  assignment: {
    order_id: 8, advisor_id: 9, technician_id: 1,
    date_in: "2026-07-11", odometer_in: 84500, promised_at: "", version: 2,
    advisor_name: "Dana Whitfield", technician_name: "Ray Ortiz",
  },
  inspection: null, authorization: null, invoice: null, findings: [],
  quoted_cost: 420, actual_cost: 420,
};

const writes = []; // anything this page tried to send while showing a ticketless car

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail"],
  fetch: async (url, opts = {}) => {
    if (opts.method && opts.method !== "GET") {
      writes.push({ url, method: opts.method });
      return {};
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    if (/^\/api\/recon\/vehicles\/2$/.test(url)) return ticketed;
    if (/^\/api\/recon\/vehicles\/1$/.test(url)) return ticketless;
    // The ticketless car genuinely has no row here -- that is what "no ticket
    // written yet" means -- so the list is filtered by the page, not by us.
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/8$/.test(url)) return order;
    if (url.startsWith("/api/staff")) {
      return [
        { id: 1, name: "Ray Ortiz", role: "technician", active: 1 },
        { id: 9, name: "Dana Whitfield", role: "advisor", active: 1 },
      ];
    }
    if (url.startsWith("/api/tasks")) return [];
    return [];
  },
});

await settle();

/* ---------- the car with the ticket, so the leak has something to leak ---- */
await w.openVehicleDetail("recon", 2);
await settle();

const notes = doc.querySelector("#vd-note-list");
const activity = doc.querySelector("#vd-activity-list");
const odometer = doc.querySelector("#vd-odometer");
const dateIn = doc.querySelector("#vd-date-in");

ok(/windshield done before Friday/.test(notes.textContent),
   "setup failed: the ticketed car isn't showing its note, so nothing can leak from it");
ok(/Parts received/.test(activity.textContent),
   "setup failed: the ticketed car isn't showing its activity log");
ok(odometer.value === "84500", `setup failed: the ticketed car's odometer reads "${odometer.value}"`);
ok(doc.querySelector("#vd-order-content").style.display !== "none",
   "setup failed: the ticketed car isn't showing its repair order");

/* ---------- now the car with no ticket ---------- */
await w.openVehicleDetail("recon", 1);
await settle();

ok(doc.querySelector("#vd-title").textContent.includes("R-1001"),
   `the page is showing "${doc.querySelector("#vd-title").textContent}" -- the navigation itself failed`);
ok(doc.querySelector("#vd-no-order").style.display !== "none",
   "a car with no ticket should offer to start one");
ok(doc.querySelector("#vd-order-content").style.display === "none",
   "a car with no ticket is showing a repair order panel");

// The three that were visibly wrong on screen.
ok(!/windshield done before Friday/.test(notes.textContent),
   "a car with no ticket is showing the previous car's notes");
ok(!/Parts received|Job added|Ticket opened/.test(activity.textContent),
   `a car nobody has written up is showing the previous car's activity: "${activity.textContent.replace(/\s+/g, " ").trim()}"`);
ok(odometer.value === "",
   `a car with no ticket is showing the previous car's odometer ("${odometer.value}")`);
ok(dateIn.value === "",
   `a car with no ticket is showing the previous car's date-in ("${dateIn.value}")`);

// Both panels still say something -- blank cards read as broken, and the
// hint is where the answer to "so where do notes go?" lives.
ok(/no ticket/i.test(notes.textContent), `the notes card reads "${notes.textContent.replace(/\s+/g, " ").trim()}"`);
ok(/No activity yet/i.test(activity.textContent), `the activity card reads "${activity.textContent.replace(/\s+/g, " ").trim()}"`);

// The rest of the ticket-scoped chrome, which is hidden rather than visibly
// wrong -- but is one un-hide away from being read as this car's, and the
// header buttons are not hidden at all.
ok(doc.querySelector("#vd-estimate-items").textContent.trim() === "",
   "the previous car's parts are still sitting in the grid");
ok(doc.querySelector("#vd-po-strip").textContent.trim() === "",
   "the previous car's purchase orders are still on the strip");
ok(doc.querySelector("#vd-ticket-total").textContent === "$0.00" && doc.querySelector("#vd-actual-cost").textContent === "$0.00",
   "the ticket totals still read the previous car's money");
ok(doc.querySelector("#vd-void-order").style.display === "none", "a car with no ticket offers to void one");
ok(doc.querySelector("#vd-print-ticket").style.display === "none", "a car with no ticket offers to print one");
ok(doc.querySelector("#vd-move-segment").style.display === "none", "a car with no ticket offers to move a ticket");
ok(doc.querySelector("#vd-status-pill").textContent === "",
   `the previous car's status is still on the header ("${doc.querySelector("#vd-status-pill").textContent}")`);

/* ---------- and the controls beside them can't be used ----------

   Disabled because the alternative was worse than doing nothing: the buttons
   stayed live, went looking for a ticket that wasn't there, and answered with
   "Cannot read properties of null (reading 'id')" in a red toast. */
const noteBox = doc.querySelector("#vd-note-text");
ok(noteBox.disabled, "the note box is live on a car with nowhere to file a note");
ok(doc.querySelector("#vd-add-note").disabled, "Add Note is live on a car with no ticket");
ok(doc.querySelector("#vd-save-timing").disabled, "the Timing card's Save is live on a car with no ticket");

const toastEl = doc.querySelector("#toast");
writes.length = 0;
doc.querySelector("#vd-save-timing").click();
doc.querySelector("#vd-add-note").click();
await settle();
ok(writes.length === 0, `a ticketless car still wrote to the server: ${JSON.stringify(writes)}`);
ok(!/Cannot read|null|undefined/i.test(toastEl.textContent),
   `a raw JavaScript error reached the screen: "${toastEl.textContent}"`);

/* ---------- the car's OWN record is still fully editable ----------

   The point of the lock is the ticket, not the car. A car nobody has written
   up is very often the only kind whose VIN or mileage still needs correcting,
   so locking the whole page would have traded one bug for a worse one. */
ok(!doc.querySelector("#vd-recon-vin").disabled, "the VIN field is locked on a car with no ticket");
ok(!doc.querySelector("#vd-recon-mileage").disabled, "the mileage field is locked on a car with no ticket");
ok(!doc.querySelector("#vd-edit-vehicle").disabled, "Edit Vehicle is locked on a car with no ticket");
ok(doc.querySelector("#vd-recon-mileage").value === "71200",
   `the vehicle's own mileage should be its own, reads "${doc.querySelector("#vd-recon-mileage").value}"`);

/* ---------- going back to the ticketed car puts it all back ----------

   The disabling is re-applied on every load, so the failure mode to guard
   against is the mirror image: a page that locks itself the first time it
   meets a ticketless car and stays locked. */
await w.openVehicleDetail("recon", 2);
await settle();
ok(!noteBox.disabled, "the note box stayed locked after visiting a car with no ticket");
ok(!doc.querySelector("#vd-save-timing").disabled, "the Timing save stayed locked after visiting a car with no ticket");
ok(odometer.value === "84500", `the ticketed car's odometer didn't come back (reads "${odometer.value}")`);
ok(/windshield done before Friday/.test(notes.textContent), "the ticketed car's notes didn't come back");
ok(/Parts received/.test(activity.textContent), "the ticketed car's activity log didn't come back");
ok(doc.querySelector("#vd-status-pill").textContent !== "", "the ticketed car's status didn't come back");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("a car with no repair order shows its own record, not the previous car's");
