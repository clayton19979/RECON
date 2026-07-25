// Vehicle detail header smoke test.
//
// The board's Idle column tells you a car has been sitting. This page is where
// you land after reading that, and until now the only timestamp on it said
// "Updated 3 minutes ago" -- the *vehicle record*, moved by a VIN correction,
// which is exactly the edit the idle clock is built to ignore. The two lines
// side by side are the thing worth testing: they describe different facts and
// must not read as contradicting each other.
//
// The stalled nudge is the other half. A red line telling you a car has sat
// for nine days with no way to act on it from the page is the same
// half-feature the chart's bars fixed on the board.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

// Recon vehicle, ticket in progress, worked on nine days ago by a named tech:
// stalled, and attributable.
let vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "EX-L", color: "Grey",
  purchase_price: 4200, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 3, created_at: daysAgo(30), updated_at: new Date(NOW - 120000).toISOString().slice(0, 19),
  orders: [], total_cost: 0, quoted_cost: 0, profit: null,
  last_activity: { at: daysAgo(9), idle_days: 9, action: "parts_received", actor: "Dana Ruiz" },
};

const order = {
  id: 42, number: "RO-1042", concern: "Front end recon prep", status: "in_progress",
  voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: daysAgo(20), estimate: { id: 1, items: [], jobs: [] },
  notes: [], activity: [
    { id: 1, action: "order_created", actor: "Dana Ruiz", details: {}, created_at: daysAgo(20) },
    { id: 2, action: "ap_invoice_voided", actor: "Priya Raman", details: {}, created_at: daysAgo(12) },
    { id: 3, action: "parts_received", actor: "Dana Ruiz", details: {}, created_at: daysAgo(9) },
  ],
  assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
  quoted_cost: 0, actual_cost: 0,
};

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "renderLastWorked", "activityLabel", "ACTIVITY_LABEL",
           "STALLED_AFTER_DAYS", "loadTasksView"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) return [];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    // Plain /api/orders is what the Tasks screen builds its link dropdown
    // from, so it has to answer too -- not just the detail page's ?segment=
    // variant. Getting this wrong is what an empty dropdown looks like.
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/staff")) return [{ id: 1, name: "Dana Ruiz", role: "technician", active: 1 }];
    if (url.startsWith("/api/tasks")) return [];
    return [];
  },
});

await settle();
await w.openVehicleDetail("recon", 7);
await settle();

const worked = doc.querySelector("#vd-last-worked");
const updated = doc.querySelector("#vd-updated");

/* ---------- the line itself ---------- */
ok(worked && !worked.hidden, "the last-worked line isn't rendered on a vehicle that has activity");
ok(/Last worked on/.test(worked.textContent), `last-worked line reads "${worked.textContent.trim()}"`);
ok(/9 days ago/.test(worked.textContent), `expected "9 days ago" in "${worked.textContent.trim()}"`);

/* Attribution. The raw action is `parts_received`; printing that with the
   underscore swapped for a space ("parts received") is how the activity log
   used to read, and it looks broken at the top of a page an advisor uses. */
ok(/Parts received by Dana Ruiz/.test(worked.textContent),
   `expected "Parts received by Dana Ruiz", got "${worked.textContent.trim()}"`);
ok(!/parts_received|parts received/.test(worked.textContent), "the raw action name leaked into the header");

/* The two lines describe different facts and are ordered on purpose. An
   unqualified "Updated 2 minutes ago" under "Last worked on 9 days ago" reads
   as a contradiction; it isn't, and the label is what says so. */
ok(/^Record updated/.test(updated.textContent.trim()),
   `the record-updated line reads "${updated.textContent.trim()}" -- unqualified, it contradicts the line above it`);
ok(worked.compareDocumentPosition(updated) & w.Node.DOCUMENT_POSITION_FOLLOWING,
   "the record-updated line comes first, burying the fact the board sent you here with");

/* ---------- stalled tone and the nudge ---------- */
ok(worked.classList.contains("stalled"), "a car untouched for 9 days isn't flagged as stalled");
const nudge = doc.querySelector("#vd-worked-nudge");
ok(nudge && /Stalled 9 days/.test(nudge.textContent), `nudge reads "${nudge && nudge.textContent}"`);

// It lands on Tasks with the vehicle's ticket selected and a title composed --
// the whole point being that noticing a stalled car and writing down what to
// do about it shouldn't require retyping the car.
nudge.click();
await settle();
ok(doc.querySelector("#view-tasks").classList.contains("active"), "the nudge didn't navigate to Tasks");
ok(doc.querySelector("#task-order-input").value === "42",
   `the vehicle's ticket wasn't pre-selected (got "${doc.querySelector("#task-order-input").value}")`);
const titleInput = doc.querySelector("#task-title-input");
ok(/R-0997 — 2018 Honda Accord — no work in 9 days/.test(titleInput.value),
   `prefilled title reads "${titleInput.value}"`);
// Caret at the end, not a selection: typing should extend the suggestion
// rather than silently wiping it.
ok(titleInput.selectionStart === titleInput.value.length && titleInput.selectionEnd === titleInput.value.length,
   "the prefilled title is selected, so the first keystroke deletes it");
// Nothing is created until the advisor says so -- a queue full of
// auto-generated rows is worse than an empty one.
ok(!fetchLog.some((f) => f.method === "POST" && f.url === "/api/tasks"),
   "the nudge created a task by itself");

/* ---------- a car that isn't stalled ---------- */
vehicle = { ...vehicle, last_activity: { at: daysAgo(0), idle_days: 0, action: "status_changed", actor: "Priya" } };
await w.openVehicleDetail("recon", 7);
await settle();
ok(!worked.classList.contains("stalled"), "a car worked on today is flagged as stalled");
ok(!doc.querySelector("#vd-worked-nudge"), "a car worked on today still shows the stalled nudge");
ok(/Last worked on today/.test(worked.textContent),
   `expected "today" rather than a relative time, got "${worked.textContent.trim()}"`);

/* ---------- an unlogged write: when, but not who ----------
   The estimate grid autosaves without logging an event, so a car worked on
   all morning may have no event to name. "— by unknown" would be worse than
   saying nothing, so the server sends action/actor empty and the line has to
   stand on its own. */
vehicle = { ...vehicle, last_activity: { at: daysAgo(2), idle_days: 2, action: "", actor: "" } };
await w.openVehicleDetail("recon", 7);
await settle();
ok(/Last worked on 2 days ago/.test(worked.textContent), `unattributed line reads "${worked.textContent.trim()}"`);
ok(!worked.querySelector(".detail-worked-what"), "an unattributable timestamp still got a caption");
ok(!/unknown|undefined|null|by\s*$/i.test(worked.textContent),
   `the missing attribution leaked as text: "${worked.textContent.trim()}"`);

/* ---------- no activity at all ---------- */
vehicle = { ...vehicle, last_activity: { at: "", idle_days: 0, action: "", actor: "" } };
await w.openVehicleDetail("recon", 7);
await settle();
ok(worked.hidden && !worked.textContent, "with no last-activity data the line should be hidden, not blank-but-present");

/* ---------- the activity log reads the same vocabulary ---------- */
vehicle = { ...vehicle, last_activity: { at: daysAgo(9), idle_days: 9, action: "parts_received", actor: "Dana Ruiz" } };
await w.openVehicleDetail("recon", 7);
await settle();
const log = doc.querySelector("#vd-activity-list").textContent;
ok(/Vendor invoice voided/.test(log), `the activity log still prints raw action names: "${log.replace(/\s+/g, " ").trim()}"`);
ok(!/ap invoice voided/.test(log), "de-underscored identifiers are still leaking into the activity log");
ok(w.activityLabel("something_new_the_server_added") === "something new the server added",
   "an unlabelled action should fall back to de-underscoring rather than rendering blank");

/* ---------- escaping ---------- */
vehicle = { ...vehicle, last_activity: { at: daysAgo(9), idle_days: 9, action: "note_added", actor: '<img src=x onerror="window.__pwned=1">' } };
await w.openVehicleDetail("recon", 7);
await settle();
ok(!worked.querySelector("img") && !w.__pwned, "the last-worked line renders raw HTML out of an actor name");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("vehicle detail: last-worked-on line, stalled nudge, activity labels");
