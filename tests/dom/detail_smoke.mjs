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
  plate: "TK7Q419", plate_state: "IN",
  purchase_price: 4200, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 3, created_at: daysAgo(30), updated_at: new Date(NOW - 120000).toISOString().slice(0, 19),
  // status_bucket is what tells this page a car has gone quiet rather than
  // simply finished -- the same field the board's rows carry.
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
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

// Address autocomplete: the suggest endpoint's behavior is switchable so the
// failure paths (which must all just hide the dropdown) can be driven too.
let suggestCalls = [];
let suggestMode = "results"; // "results" | "empty" | "error"
const customerPatchBodies = []; // what the editor actually saved
const reconPatchBodies = []; // ...and what the Edit Vehicle dialog saved

// The Assigned card's two Save buttons each write their own half of one
// record; these capture exactly what each one puts on the wire.
const assignmentPuts = [];
let assignmentStale = false;

/* The shop's shared follow-ups. Two on this car (one of them past its due
   date), one on a different car, so the page has to filter rather than print
   whatever the queue happens to contain. */
const taskPatches = [];
let openTasks = [
  { id: 11, title: "Check the trunk struts", notes: "Walt asked", assigned_to: ["Dana Ruiz"],
    due_date: new Date(NOW - 3 * 86400000).toISOString().slice(0, 10), urgent: 0, done: 0,
    order_id: 42, recon_vehicle_id: 7, we_owe_id: null, order_vehicle_id: 71, created_by: "Clay",
    created_at: daysAgo(4), completed_at: "", order_label: "R-0997", order_state: "" },
  { id: 12, title: "Call Walt about the second key", notes: "", assigned_to: [], due_date: "", urgent: 1, done: 0,
    order_id: null, recon_vehicle_id: 7, we_owe_id: null, order_vehicle_id: null, created_by: "Clay",
    created_at: daysAgo(1), completed_at: "", order_label: "R-0997", order_state: "" },
  { id: 13, title: "Somebody else's car", notes: "", assigned_to: [], due_date: "", urgent: 0, done: 0,
    order_id: null, recon_vehicle_id: 99, we_owe_id: null, order_vehicle_id: null, created_by: "Clay",
    created_at: daysAgo(1), completed_at: "", order_label: "R-0000", order_state: "" },
  { id: 14, title: "Already handled", notes: "", assigned_to: [], due_date: "", urgent: 0, done: 1,
    order_id: null, recon_vehicle_id: 7, we_owe_id: null, order_vehicle_id: null, created_by: "Clay",
    created_at: daysAgo(6), completed_at: daysAgo(5), order_label: "R-0997", order_state: "" },
];

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "renderLastWorked", "activityLabel", "ACTIVITY_LABEL",
           "STALLED_AFTER_DAYS", "loadTasksView"],
  fetch: async (url, opts = {}) => {
    if (url === "/api/customers/55" && opts.method === "PATCH") {
      customerPatchBodies.push(JSON.parse(opts.body));
      return { id: 55 };
    }
    if (url.startsWith("/api/address-suggest")) {
      suggestCalls.push(decodeURIComponent(url.split("q=")[1] || ""));
      if (suggestMode === "error") return { __status: 502, body: { detail: "geocoder down" } };
      if (suggestMode === "empty") return [];
      return [
        { label: "123 Main St, Springfield, IL 62701", line1: "123 Main St", city: "Springfield", state: "IL", postal_code: "62701" },
        { label: "123 Maine Ave, Portland, ME 04101", line1: "123 Maine Ave", city: "Portland", state: "ME", postal_code: "04101" },
      ];
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    if (/^\/api\/recon\/vehicles\/7$/.test(url) && opts.method === "PATCH") {
      reconPatchBodies.push(JSON.parse(opts.body));
      return vehicle;
    }
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    // The Tasks screen builds its link dropdown from this, so it has to
    // answer before the /api/tasks catch-all below. Getting it wrong is what
    // an empty dropdown -- and a "+ Task" that doesn't preselect this car --
    // looks like.
    if (url === "/api/tasks/linkable-orders") {
      return [{ value: "order:42", id: 42, order_id: 42, recon_vehicle_id: 7, we_owe_id: null,
                segment: "recon", group: "Recon", label: "R-0981 — 2019 Ford Edge" }];
    }
    if (url === "/api/orders/42/assignment" && opts.method === "PUT") {
      assignmentPuts.push(JSON.parse(opts.body));
      if (assignmentStale) {
        return { __status: 409, body: { detail: "Someone else changed this ticket since you loaded it -- reload to see their update" } };
      }
      return order.assignment;
    }
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/staff")) {
      return [
        { id: 1, name: "Dana Ruiz", role: "technician", active: 1 },
        { id: 9, name: "Pat Nolan", role: "advisor", active: 1 },
      ];
    }
    if (url === "/api/tasks") return openTasks;
    if (url.startsWith("/api/tasks/") && opts.method === "PATCH") {
      taskPatches.push({ url, body: JSON.parse(opts.body) });
      openTasks = openTasks.filter((t) => !url.endsWith(`/${t.id}`));
      return {};
    }
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

/* ---------- the follow-ups somebody left on this car ----------
   Tasks were a one-way street: + Task files one onto the Tasks screen and the
   car's own page never mentioned it again, so a note left for the other
   advisor was invisible on the one screen he opens to work on that car. */
const tasksCard = doc.querySelector("#vd-tasks-card");
ok(tasksCard && tasksCard.style.display !== "none", "the car's follow-ups aren't shown on its page");
const taskRows = [...doc.querySelectorAll("#vd-tasks-list .vd-task")];
ok(taskRows.length === 2, `expected this car's 2 open follow-ups, got ${taskRows.length}`);
ok(taskRows.map((r) => r.dataset.id).join(",") === "11,12",
   `follow-ups on screen are ${taskRows.map((r) => r.dataset.id).join(",")} -- another car's, or a finished one, leaked in`);
ok(/Check the trunk struts/.test(taskRows[0].textContent), "the follow-up's own words aren't on screen");
ok(/Dana Ruiz/.test(taskRows[0].textContent), "the follow-up doesn't say who it's for");
ok(/nobody yet/.test(taskRows[1].textContent), "a follow-up nobody has picked up doesn't say so");
// Past its date is the thing worth catching on the way past, so it is said on
// the row and again on the card's heading.
ok(taskRows[0].querySelector(".vd-task-due.overdue"), "a follow-up past its due date isn't flagged");
ok(/1 PAST DUE/.test(doc.querySelector("#vd-tasks-card .section-eyebrow").textContent),
   `card heading reads "${doc.querySelector("#vd-tasks-card .section-eyebrow").textContent}"`);
ok(/2 follow-ups/.test(doc.querySelector("#vd-tasks-title").textContent),
   `card title reads "${doc.querySelector("#vd-tasks-title").textContent}"`);
// Ticking one off happens here, not on another screen.
taskRows[0].querySelector(".vd-task-done").click();
await settle();
ok(taskPatches.some((c) => c.url === "/api/tasks/11" && c.body.done === true),
   "Done on a follow-up didn't mark it done");
ok([...doc.querySelectorAll("#vd-tasks-list .vd-task")].length === 1,
   "a ticked-off follow-up is still on the car's page");

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
ok(doc.querySelector("#task-order-input").value === "order:42",
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

/* ---------- a car that's finished, however long it has sat ----------

   The board's Stalled card stopped counting finished cars because their idle
   count only ever climbs; the same rule has to hold here or the two screens
   disagree about the car in front of you. A car whose work is done isn't
   waiting on anybody, and offering to raise a follow-up task about it is
   busywork the advisor then has to close.

   The line itself stays: "last worked on 40 days ago" is still worth knowing
   about a completed car. It's the alarm tone and the nudge that go. */
vehicle = {
  ...vehicle, status_bucket: "finished",
  last_activity: { at: daysAgo(40), idle_days: 40, action: "status_changed", actor: "Priya" },
};
await w.openVehicleDetail("recon", 7);
await settle();
ok(!worked.classList.contains("stalled"),
   "a car whose work is finished is still flagged as stalled after sitting 40 days");
ok(!doc.querySelector("#vd-worked-nudge"),
   "a finished car still offers to make a follow-up task about work that's done");
ok(/Last worked on/.test(worked.textContent),
   `the last-worked line vanished on a finished car: "${worked.textContent.trim()}"`);
// Back to an ordinary in-progress car for everything below, so a later
// section can't quietly inherit "finished" and stop testing what it says.
vehicle = { ...vehicle, status_bucket: "in_progress" };

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

/* ------------------------------------------------------------------
   Address autocomplete in the customer editor. As-you-type suggestions
   from /api/address-suggest; picking one fills Street/City/State/ZIP;
   every failure path just hides the dropdown and leaves manual entry.
   ------------------------------------------------------------------ */
const waitSuggest = () => new Promise((r) => setTimeout(r, 400)); // debounce is 250ms

// The detail page is a recon vehicle, so give it a customer to edit and
// open the editor the way an advisor would.
w.state.detail.item = {
  ...w.state.detail.item,
  customer_id: 55, customer_name: "Maria Alvarez", customer_phone: "555-0101",
  customer_email: "m@example.com", customer_address_line1: "", customer_address_line2: "",
  customer_city: "", customer_state: "", customer_postal_code: "",
};
doc.querySelector("#vd-edit-customer").click();
const addr1 = doc.querySelector("#customer-edit-address1");
const suggBox = doc.querySelector("#customer-edit-address-suggestions");
ok(addr1 && suggBox, "customer editor is missing the street field or its suggestion box");
ok(suggBox.hidden, "the suggestion dropdown starts visible");

const type = (value) => {
  addr1.focus();
  addr1.value = value;
  addr1.dispatchEvent(new w.Event("input", { bubbles: true }));
};

// Under three characters: no request at all, dropdown stays down.
type("12");
await waitSuggest();
await settle();
ok(suggestCalls.length === 0, `a 2-character query hit the suggest endpoint (${suggestCalls.length} calls)`);
ok(suggBox.hidden, "the dropdown opened for a 2-character query");

// Keystrokes debounce into one request; results render as buttons.
type("123 Ma");
type("123 Mai");
type("123 Main");
await waitSuggest();
await settle();
ok(suggestCalls.length === 1, `three quick keystrokes should collapse to one request, made ${suggestCalls.length}`);
ok(suggestCalls[0] === "123 Main", `the request should carry the latest text, sent "${suggestCalls[0]}"`);
ok(!suggBox.hidden, "results arrived but the dropdown stayed hidden");
const suggestions = [...suggBox.querySelectorAll(".addr-suggestion")];
ok(suggestions.length === 2, `expected 2 rendered suggestions, found ${suggestions.length}`);
ok(/123 Main St, Springfield/.test(suggestions[0].textContent), `first suggestion reads "${suggestions[0].textContent}"`);

// Picking one fills Street + City/State/ZIP, closes the list, and moves
// focus along to the second address line.
suggestions[0].click();
ok(addr1.value === "123 Main St", `street should be replaced by the pick, reads "${addr1.value}"`);
ok(doc.querySelector("#customer-edit-city").value === "Springfield", "city was not filled from the pick");
ok(doc.querySelector("#customer-edit-state").value === "IL", "state was not filled from the pick");
ok(doc.querySelector("#customer-edit-postal").value === "62701", "ZIP was not filled from the pick");
ok(suggBox.hidden, "the dropdown should close after a pick");
ok(doc.activeElement === doc.querySelector("#customer-edit-address2"),
   "focus should land on address line 2 after a pick");

// Escape dismisses an open list.
suggestCalls = [];
type("456 Oak Street");
await waitSuggest();
await settle();
ok(!suggBox.hidden, "the dropdown should reopen for a fresh query");
addr1.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
ok(suggBox.hidden, "Escape should dismiss the dropdown");

// An empty answer and a failed request both just hide the list -- the
// fields keep working as plain manual entry either way.
suggestMode = "empty";
type("789 Nowhere Lane");
await waitSuggest();
await settle();
ok(suggBox.hidden, "an empty result set should hide the dropdown");
suggestMode = "error";
type("500 Broken Geocoder Way");
await waitSuggest();
await settle();
ok(suggBox.hidden, "a failed request should hide the dropdown, not surface an error");
ok(addr1.value === "500 Broken Geocoder Way", "a failed request clobbered the typed street");

// A response that lands after the advisor has tabbed away must not pop
// the dropdown back open over whatever they're doing now.
suggestMode = "results";
type("321 Elm");
doc.querySelector("#customer-edit-address2").focus(); // tab away while the request is in flight
await waitSuggest();
await settle();
ok(suggBox.hidden, "a stale response reopened the dropdown after focus left the street field");

// City/State/ZIP validation. Both fields are optional, but filled-in values
// have to be real: a two-letter USPS code and a 5-digit (or ZIP+4) ZIP. Bad
// values are refused with an error toast, focus lands on the offending
// field, and nothing is PATCHed.
const stateEl = doc.querySelector("#customer-edit-state");
const zipEl = doc.querySelector("#customer-edit-postal");
const form = doc.querySelector("#customer-edit-form");
const toastEl = doc.querySelector("#toast");
// Validation messages stand next to the field they're about (issue #126:
// a toast is invisible behind an open modal dialog). This reads the note
// currently standing in a field's label, or "" when the field is clean.
const fieldNote = (el) => el.closest("label")?.querySelector(".field-error")?.textContent || "";
const setField = (el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};
const submitForm = () => form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
const customerPatches = () => fetchLog.filter((f) => f.method === "PATCH" && f.url === "/api/customers/55").length;

// The state box normalizes as you type: lowercase comes out upper, and
// anything that isn't a letter never lands. Same idea for ZIP and digits.
setField(stateEl, "mi");
ok(stateEl.value === "MI", `state input should uppercase itself, reads "${stateEl.value}"`);
setField(stateEl, "M1");
ok(stateEl.value === "M", `state input should drop non-letters, reads "${stateEl.value}"`);
setField(zipEl, "48z03");
ok(zipEl.value === "4803", `ZIP input should drop non-digits, reads "${zipEl.value}"`);

// Two letters that aren't a state: refused, focused, not saved.
setField(stateEl, "XX");
setField(zipEl, "48203");
submitForm();
await settle();
ok(customerPatches() === 0, "a made-up state code still reached the customer PATCH");
ok(/isn't a state code/.test(fieldNote(stateEl)),
   `expected the state-code note beside the field, got "${fieldNote(stateEl)}"`);
ok(stateEl.classList.contains("field-invalid"), "the refused state field should be outlined");
ok(doc.activeElement === stateEl, "focus should land on the state field after a bad code");

// Short ZIP: refused the same way.
setField(stateEl, "MI");
setField(zipEl, "482");
submitForm();
await settle();
ok(customerPatches() === 0, "a 3-digit ZIP still reached the customer PATCH");
ok(/ZIP should be 5 digits/.test(fieldNote(zipEl)),
   `expected the ZIP note beside the field, got "${fieldNote(zipEl)}"`);
ok(doc.activeElement === zipEl, "focus should land on the ZIP field after a bad ZIP");
// Fixing the state already cleared its note -- a message about a keystroke
// someone already made must not outlive it.
ok(!fieldNote(stateEl), `the fixed state field should be clean again, still says "${fieldNote(stateEl)}"`);
ok(!stateEl.classList.contains("field-invalid"), "the fixed state field should lose its outline");

// Valid values (including ZIP+4) sail through and close the dialog.
setField(zipEl, "48203-1234");
submitForm();
await settle();
ok(customerPatches() === 1, `a valid state+ZIP should PATCH exactly once, saw ${customerPatches()}`);
ok(!doc.querySelector("#customer-edit-dialog").open, "the dialog should close after a valid save");

// Empty is fine too -- both fields are optional. (The successful save above
// reloaded the detail view, which rebuilt state.detail.item from the mock
// vehicle -- put the customer back before reopening the editor.)
w.state.detail.item = { ...w.state.detail.item, customer_id: 55, customer_name: "Maria Alvarez" };
doc.querySelector("#vd-edit-customer").click();
setField(stateEl, "");
setField(zipEl, "");
submitForm();
await settle();
ok(customerPatches() === 2, `empty state and ZIP should be allowed, saw ${customerPatches()} PATCHes`);

doc.querySelector("#customer-edit-cancel")?.click();

/* ------------------------------------------------------------------
   Phone: masks as you type, saves only whole numbers -- but an untouched
   legacy value (stored before the mask existed) must never block an
   unrelated edit.
   ------------------------------------------------------------------ */
w.state.detail.item = { ...w.state.detail.item, customer_id: 55, customer_name: "Maria Alvarez", customer_phone: "555-0101" };
doc.querySelector("#vd-edit-customer").click();
const phoneEl = doc.querySelector("#customer-edit-phone");
ok(phoneEl.value === "555-0101", `the editor should load the stored phone untouched, reads "${phoneEl.value}"`);

// The legacy 7-digit value passes through untouched on save: the advisor
// came to fix the address, not to be held up by a 1998-era phone record.
submitForm();
await settle();
ok(customerPatches() === 3, `an untouched legacy phone blocked the save (saw ${customerPatches()} PATCHes)`);
ok(customerPatchBodies[2].phone === "555-0101", `legacy phone should save as-is, sent "${customerPatchBodies[2].phone}"`);

// The mask formats digits progressively and refuses everything else.
w.state.detail.item = { ...w.state.detail.item, customer_id: 55, customer_name: "Maria Alvarez", customer_phone: "555-0101" };
doc.querySelector("#vd-edit-customer").click();
setField(phoneEl, "313");
ok(phoneEl.value === "(313", `3 digits should read "(313", reads "${phoneEl.value}"`);
setField(phoneEl, "313555");
ok(phoneEl.value === "(313) 555", `6 digits should read "(313) 555", reads "${phoneEl.value}"`);
setField(phoneEl, "3a1b3!555.0142");
ok(phoneEl.value === "(313) 555-0142", `letters and punctuation should never land, reads "${phoneEl.value}"`);
setField(phoneEl, "+1 (313) 555-0142");
ok(phoneEl.value === "(313) 555-0142", `a +1 country code should fold away, reads "${phoneEl.value}"`);
setField(phoneEl, "31355501429999");
ok(phoneEl.value === "(313) 555-0142", `input should cap at 10 digits, reads "${phoneEl.value}"`);

// A partial number is refused: toast, focus on the field, nothing PATCHed.
setField(phoneEl, "313555");
submitForm();
await settle();
ok(customerPatches() === 3, "a 6-digit phone still reached the customer PATCH");
ok(/all 10 digits/.test(fieldNote(phoneEl)),
   `expected the phone note beside the field, got "${fieldNote(phoneEl)}"`);
ok(doc.activeElement === phoneEl, "focus should land on the phone field after a partial number");

// A complete number sails through, already in canonical shape.
setField(phoneEl, "2195550100");
submitForm();
await settle();
ok(customerPatches() === 4, `a valid phone should PATCH exactly once more, saw ${customerPatches()}`);
ok(customerPatchBodies[3].phone === "(219) 555-0100", `phone should save masked, sent "${customerPatchBodies[3].phone}"`);

/* ------------------------------------------------------------------
   The Assigned card. Two Save buttons write one record between them --
   who is on the ticket, and the dates. Each must send only its own half.

   Sending both halves from either button had a specific everyday cost: the
   advisor dropdown pre-selects whoever is "working as" on a ticket nobody
   has assigned, so saving a *mileage* on the Timing side quietly stamped
   that name onto the ticket as the advisor of record -- and it then printed
   on the ticket. The other half of the same bug was that either save blindly
   overwrote whatever the other workstation had just put there.
   ------------------------------------------------------------------ */
order.assignment = {
  order_id: 42, advisor_id: null, technician_id: 1,
  date_in: "2026-01-15", odometer_in: 98000, promised_at: "", version: 4,
  advisor_name: null, technician_name: "Dana Ruiz",
};
w.state.currentUser = "Pat Nolan"; // an advisor, so the pre-selection kicks in
await w.openVehicleDetail("recon", 7);
await settle();

// The pre-selection is the setup, not the bug: the dropdown offers Pat while
// the record still has no advisor at all.
ok(doc.querySelector("#vd-advisor").value === "9",
   `the advisor dropdown should pre-select the current user, reads "${doc.querySelector("#vd-advisor").value}"`);
ok(order.assignment.advisor_id === null, "the fixture should start with no advisor on the record");

// Save the Timing half.
doc.querySelector("#vd-odometer").value = "142300";
doc.querySelector("#vd-save-timing").click();
await settle();
const timing = assignmentPuts.at(-1);
ok(timing && timing.odometer_in === 142300, `the timing save should send the odometer, sent ${JSON.stringify(timing)}`);
ok(timing && !("advisor_id" in timing),
   `saving a mileage still writes the advisor: ${JSON.stringify(timing)}`);
ok(timing && !("technician_id" in timing),
   `saving a mileage still writes the technician: ${JSON.stringify(timing)}`);
ok(timing && timing.expected_version === 4,
   `the timing save should carry the version the page loaded, sent ${timing && timing.expected_version}`);

// Save the who-is-on-it half.
doc.querySelector("#vd-save-assignment").click();
await settle();
const assign = assignmentPuts.at(-1);
ok(assign && assign.advisor_id === 9 && assign.technician_id === 1,
   `the assign save should send both people, sent ${JSON.stringify(assign)}`);
ok(assign && !("date_in" in assign) && !("odometer_in" in assign) && !("promised_at" in assign),
   `assigning somebody still rewrites the dates: ${JSON.stringify(assign)}`);

// "Unassigned" is a real choice and has to reach the server as one -- leaving
// the field out would mean "don't touch it", which is the opposite.
doc.querySelector("#vd-technician").value = "";
doc.querySelector("#vd-save-assignment").click();
await settle();
ok(assignmentPuts.at(-1).technician_id === -1,
   `picking Unassigned should clear the slot, sent ${JSON.stringify(assignmentPuts.at(-1))}`);

// A save refused because someone else got there first has to say so.
assignmentStale = true;
doc.querySelector("#vd-save-timing").click();
await settle();
ok(toastEl.classList.contains("error") && /reload/.test(toastEl.textContent),
   `a stale save should surface the reload message, toast reads "${toastEl.textContent}"`);
assignmentStale = false;

/* ---------- the plate, on the page and in the editor ----------

   The write-up form has always asked for a plate; nothing ever showed one
   back, and there was no way to correct one. Both halves are checked here: the
   header and the Vehicle Info card say it, and the Edit Vehicle dialog loads
   it, tidies what gets typed into it, and puts it on the wire. */
ok(doc.querySelector("#vd-sub").textContent.includes("TK7Q419 (IN)"),
   `the header should carry the plate, reads "${doc.querySelector("#vd-sub").textContent}"`);
ok(doc.querySelector("#vd-vehicle-info-summary").textContent.includes("TK7Q419 (IN)"),
   "the Vehicle Info card should list the plate alongside the VIN");

doc.querySelector("#vd-edit-vehicle").click();
await settle();
ok(doc.querySelector("#vd-recon-plate").value === "TK7Q419",
   `the editor should open holding the plate on file, held "${doc.querySelector("#vd-recon-plate").value}"`);
ok(doc.querySelector("#vd-recon-plate-state").value === "IN", "the editor lost the plate's state");

// Typed off a bumper with the punctuation the reader felt like, in lower case.
const plateField = doc.querySelector("#vd-recon-plate");
plateField.value = "bb2-9x40";
plateField.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(plateField.value === "BB29X40",
   `the box should show what the record will say, shows "${plateField.value}"`);

doc.querySelector("#vd-recon-info-save").click();
await settle();
const saved = reconPatchBodies.at(-1);
ok(saved && saved.plate === "BB29X40", `the plate never reached the server: ${JSON.stringify(saved)}`);
ok(saved && saved.plate_state === "IN", `the plate's state never reached the server: ${JSON.stringify(saved)}`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("vehicle detail: last-worked-on line, stalled nudge, activity labels, address autocomplete + validation, assigned-card saves, plate display + editing");
