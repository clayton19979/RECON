// Ticket close-out smoke test.
//
// The parts get bought at the counter and thrown on the car; marking them
// received in the app is a separate step, and it is the step a busy morning
// eats. The ticket closes, the car drops to READY, and its Cost reads $0.00
// for a car that just had four tires put on it.
//
// So closing a ticket asks first, at the one moment the paperwork is still in
// reach. What has to hold:
//
//   - the question only appears when parts really are outstanding
//   - "Close Anyway" closes it, exactly as before
//   - backing out (Escape / Cancel) changes nothing, and leaves the status
//     dropdown reading what the ticket actually says rather than "Complete"
//   - "Receive Them Now" ticks those exact lines and opens the receive
//     dialog, and posting the invoice is what finally closes the ticket
//   - abandoning that dialog does not leave a close-out primed to fire on
//     some unrelated receive an hour later
//   - filing the car away says what money the app cannot see
//
// All of it is render and flow logic, unreachable from the Python tests.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

let unreceivedOnRecord = { unreceived_cost: 380, unreceived_parts: 2 };
const vehicle = () => ({
  id: 7, stock_number: "R-0997", year: 2016, make: "Ford", model: "Fusion",
  vin: "3FA6P0H70GR123456", mileage: 92000, trim: "", color: "Silver",
  purchase_price: 0, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 1, created_at: daysAgo(30), updated_at: daysAgo(0),
  status_bucket: "in_progress", total_cost: 60, quoted_cost: 380, profit: null,
  // What the board and the Lot sheet read off this car. A voided ticket is
  // in the list on purpose: its money must not reach the warning.
  orders: [
    { id: 42, voided: 0, ...unreceivedOnRecord },
    { id: 43, voided: 1, unreceived_cost: 900, unreceived_parts: 5 },
  ],
  last_activity: { at: daysAgo(1), idle_days: 1, action: "order_created", actor: "Dana Ruiz" },
});

/* Two parts nobody receipted, one already in, one labour line, and a part
   that went back to the vendor. Only the first two are money the car is short
   by -- labour is real the moment it is written down, and a returned part is
   not money the shop is going to spend. 4 x $80 + 2 x $30 = $380. */
const mkOrder = () => ({
  id: 42, number: "RO-1042", ro_number: 42, concern: "Recon prep", status: "in_progress",
  voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: daysAgo(20), last_activity_at: daysAgo(1), notes: [], activity: [], findings: [],
  assignment: null, inspection: null, authorization: null, invoice: null,
  purchase_orders: [], quoted_cost: 380, actual_cost: 60,
  estimate: {
    id: 1, edit_version: 1, jobs: [],
    items: [
      { id: 11, kind: "part", description: "Tires, set of 4", part_number: "T-205", quantity: 4, unit_cost: 80, core_charge: 0, status: "ordered", received_quantity: 0, job_id: null },
      { id: 12, kind: "part", description: "Wiper blades", part_number: "WB-22", quantity: 2, unit_cost: 30, core_charge: 0, status: "ordered", received_quantity: 0, job_id: null },
      { id: 13, kind: "part", description: "Cabin filter", part_number: "CF-1", quantity: 1, unit_cost: 60, core_charge: 0, status: "received", received_quantity: 1, job_id: null },
      { id: 14, kind: "labor", description: "Fit and align", quantity: 2, unit_cost: 0, status: "quoted", received_quantity: 0, job_id: null },
      { id: 15, kind: "part", description: "Wrong caliper", part_number: "CAL-9", quantity: 1, unit_cost: 140, core_charge: 0, status: "ordered", received_quantity: 0, part_returned: 1, job_id: null },
    ],
  },
});

const statusPatches = [];
const receivePosts = [];
const archivePosts = [];
let order = mkOrder();

const { w, doc, settle, ok, finish } = await boot({
  expose: ["state", "openVehicleDetail"],
  fetch: async (url, opts = {}) => {
    if (/\/orders\/42\/status$/.test(url)) { statusPatches.push(JSON.parse(opts.body)); return {}; }
    if (/receive-parts$/.test(url)) { receivePosts.push(JSON.parse(opts.body)); return { ap_invoice_id: 5, received_items: 2 }; }
    if (/\/archive$/.test(url)) { archivePosts.push(url); return {}; }
    if (url === "/api/vendors") return [{ id: 3, name: "Pull-A-Part", last_invoice_at: "2026-06-01T09:00:00" }];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle();
    if (url.startsWith("/api/orders?")) return [{ id: 42, recon_vehicle_id: 7, status: order.status, voided: 0, number: "RO-1042", created_at: order.created_at }];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/staff")) return [{ id: 1, name: "Dana Ruiz", role: "technician", active: 1 }];
    return [];
  },
});

const dlg = () => doc.querySelector("#confirm-dialog");
const confirmText = () => `${doc.querySelector("#confirm-title").textContent} ${doc.querySelector("#confirm-body").textContent}`;
const statusSelect = () => doc.querySelector("#vd-status-select");
const receiveDialog = () => doc.querySelector("#receive-dialog");
const tickedIds = () => [...doc.querySelectorAll("#vd-estimate-items .ei-receive-check")]
  .filter((cb) => cb.checked).map((cb) => cb.dataset.id).sort().join(",");

async function openTicket(next = mkOrder()) {
  order = next;
  await w.openVehicleDetail("recon", 7);
  await settle();
}

// Pick a status the way a person does -- change the dropdown and let the app
// react -- then let the confirmation appear.
async function chooseStatus(value) {
  statusSelect().value = value;
  statusSelect().dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle();
}

await openTicket();
ok(statusSelect().value === "in_progress", `the page did not load onto the ticket: ${statusSelect().value}`);

/* ---------- moving to any other status still just happens ---------- */
await chooseStatus("pending_approval");
ok(!dlg().open, "changing to a status other than Complete stopped to ask about parts");
ok(statusPatches.length === 1 && statusPatches[0].status === "pending_approval",
   `an ordinary status change did not post: ${JSON.stringify(statusPatches)}`);

/* ---------- closing with parts outstanding asks, and names them ---------- */
await openTicket();
statusPatches.length = 0;
await chooseStatus("complete");
ok(dlg().open, "closing a ticket with unreceipted parts asked nothing");
ok(/2 parts on this ticket were never marked received/.test(confirmText()),
   `the warning did not say how many parts: ${confirmText()}`);
ok(/\$380\.00/.test(confirmText()), `the warning's figure is wrong: ${confirmText()}`);
ok(/Tires, set of 4/.test(confirmText()) && /Wiper blades/.test(confirmText()),
   `the warning did not name the parts: ${confirmText()}`);
ok(!/Cabin filter|Fit and align|Wrong caliper/.test(confirmText()),
   `the warning counted a received, labour or returned line: ${confirmText()}`);
ok(statusPatches.length === 0, "the ticket closed before anyone answered");

/* ---------- backing out leaves the ticket exactly where it was ---------- */
doc.querySelector("#confirm-cancel").click();
await settle();
ok(statusPatches.length === 0, "Cancel closed the ticket anyway");
ok(statusSelect().value === "in_progress",
   `the dropdown kept claiming Complete on a ticket that is still open: ${statusSelect().value}`);

/* ---------- Escape means back out, not "close anyway" ---------- */
await chooseStatus("complete");
ok(dlg().open, "the warning did not come back a second time");
dlg().close(); // what Escape and a backdrop click do
await settle();
ok(statusPatches.length === 0, "Escape closed the ticket");
ok(statusSelect().value === "in_progress", `Escape left the dropdown lying: ${statusSelect().value}`);

/* ---------- "Close Anyway" closes it, exactly as before ---------- */
await chooseStatus("complete");
doc.querySelector("#confirm-alt").click();
await settle();
ok(statusPatches.length === 1 && statusPatches[0].status === "complete",
   `Close Anyway did not close the ticket: ${JSON.stringify(statusPatches)}`);

/* ---------- "Receive Them Now" hands the exact lines to the receive dialog ---------- */
await openTicket();
statusPatches.length = 0;
await chooseStatus("complete");
doc.querySelector("#confirm-accept").click();
await settle();
ok(receiveDialog().open, "Receive Them Now never opened the receive dialog");
ok(tickedIds() === "11,12", `the wrong lines were handed to the receive dialog: ${tickedIds()}`);
ok(statusPatches.length === 0, "the ticket closed before the invoice was posted");

// Posting the invoice is what finishes the close-out: one trip, not two.
doc.querySelector("#receive-invoice-number").value = "PAP-8812";
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 1 && String(receivePosts[0].item_ids) === "11,12",
   `the receive post carried the wrong lines: ${JSON.stringify(receivePosts)}`);
ok(statusPatches.length === 1 && statusPatches[0].status === "complete",
   `receiving the parts did not go on to close the ticket: ${JSON.stringify(statusPatches)}`);

/* ---------- abandoning the receive dialog cancels the close-out ---------- */
await openTicket();
statusPatches.length = 0;
receivePosts.length = 0;
await chooseStatus("complete");
doc.querySelector("#confirm-accept").click();
await settle();
doc.querySelector("#receive-cancel").click();
await settle();
ok(statusPatches.length === 0, "walking away from the receive dialog closed the ticket");
ok(w.state.afterReceive == null, "an abandoned close-out stayed primed to fire");

// ...and an ordinary receive afterwards must not inherit it.
for (const cb of doc.querySelectorAll("#vd-estimate-items .ei-receive-check")) {
  cb.checked = cb.dataset.id === "11";
  cb.dispatchEvent(new w.Event("change", { bubbles: true }));
}
doc.querySelector("#vd-receive-parts").click();
await settle();
doc.querySelector("#receive-invoice-number").value = "PAP-9000";
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 1, `the ordinary receive did not post: ${JSON.stringify(receivePosts)}`);
ok(statusPatches.length === 0, "an unrelated receive closed a ticket nobody asked it to");

/* ---------- a fully receipted ticket closes without a word ---------- */
const clean = mkOrder();
for (const item of clean.estimate.items) item.received_quantity = item.quantity;
await openTicket(clean);
statusPatches.length = 0;
await chooseStatus("complete");
ok(!dlg().open, "a ticket with nothing outstanding still stopped to ask");
ok(statusPatches.length === 1 && statusPatches[0].status === "complete",
   `a clean ticket did not close: ${JSON.stringify(statusPatches)}`);

/* ---------- filing the car away says what the app cannot see ---------- */
await openTicket();
doc.querySelector("#vd-archive-vehicle").click();
await settle();
ok(dlg().open, "Send to History asked nothing at all");
ok(/2 parts were never marked received/.test(confirmText()) && /\$380\.00/.test(confirmText()),
   `archiving said nothing about the unreceipted parts: ${confirmText()}`);
ok(!/\$1,280\.00|\$900\.00/.test(confirmText()),
   `archiving counted a voided ticket's parts: ${confirmText()}`);
ok(doc.querySelector("#confirm-alt").hidden,
   "the archive confirmation grew a third button it never asked for");
doc.querySelector("#confirm-accept").click();
await settle();
ok(archivePosts.length === 1, `Send to History did not archive: ${JSON.stringify(archivePosts)}`);

/* ---------- a car with nothing outstanding gets the plain wording back ---------- */
unreceivedOnRecord = { unreceived_cost: 0, unreceived_parts: 0 };
await openTicket();
doc.querySelector("#vd-archive-vehicle").click();
await settle();
ok(!/never marked received/.test(confirmText()),
   `a car with nothing outstanding was warned anyway: ${confirmText()}`);
doc.querySelector("#confirm-cancel").click();
await settle();

finish("ticket close-out: unreceipted parts guard, receive-then-close, archive warning");
