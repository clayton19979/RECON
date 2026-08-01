// Parts & Labor autosave concurrency smoke test.
//
// estimate_smoke.mjs proves the grid renders and that one save round-trips
// without stealing focus. This one is about what happens when two saves are
// asked for close together, which is the ordinary case rather than the exotic
// one: the keystroke debounce fires 800ms after the last character typed, and
// tabbing out of the field an instant later fires the change save on top of it.
//
// Every save carries the edit_version it was written against and the server
// bumps that version as it writes. A second save started before the first one
// answers therefore quotes a version the server has already moved past, and
// comes back 409 "Someone else changed this estimate" -- with nobody else in
// the building. The 409 handler then reloads the ticket, discarding whatever
// was being typed. So: at most one save in flight, and a follow-up that reads
// the DOM and the version *after* the first response lands.

import { boot } from "./harness.mjs";

/* A POST /estimate that answers only when the test says so, so a second save
   can be attempted while the first is genuinely still in the air. Every held
   request keeps its own resolver: the whole point is to allow more than one at
   a time, and a single shared one would strand the earlier request forever and
   turn a failing assertion into a hung test. */
const posted = [];
const held = [];
let nextStatus = 200;
let serverVersion = 1;

const estimateBody = (items) => ({
  edit_version: ++serverVersion,
  jobs: [],
  items: items.map((i, n) => ({
    id: i.id ?? 100 + n,
    kind: i.kind,
    description: i.description,
    part_number: i.part_number || "",
    quantity: i.quantity,
    unit_cost: i.unit_cost,
    core_charge: i.core_charge || 0,
    status: "quoted",
    received_quantity: 0,
    job_id: null,
  })),
});

// The 409 path reloads the vehicle, so the handler has to be able to answer
// that too -- with no orders, which parks the page on its "no repair order"
// branch instead of dragging the whole order panel into this test.
let failMessage = "";
const { w, fetchLog, settle, ok, finish } = await boot({
  expose: ["state", "renderEstimate", "persistEstimate"],
  fetch: async (url, opts) => {
    if (/\/estimate$/.test(url) && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      posted.push({ expected_version: body.expected_version, items: body.items });
      await new Promise((resolve) => held.push(resolve));
      if (nextStatus !== 200) return { __status: nextStatus, body: { detail: failMessage } };
      return estimateBody(body.items);
    }
    if (/\/api\/recon\/vehicles\/1$/.test(url)) {
      return { id: 1, stock_number: "R-1", year: 2017, make: "Hyundai", model: "Elantra", vin: "", mileage: 84500, edit_version: 1, archived_at: null };
    }
    if (/\/api\/staff/.test(url)) return [];
    return [];
  },
});

const doc = w.document;
const mkOrder = () => ({
  id: 1, number: "RO-1", status: "in_progress", concern: "",
  estimate: {
    edit_version: serverVersion, jobs: [],
    items: [
      { id: 1, kind: "part", description: "Front pads", part_number: "PD-9", quantity: 2, unit_cost: 41.5, core_charge: 0, status: "quoted", received_quantity: 0, job_id: null },
      { id: 2, kind: "part", description: "Rotor", part_number: "RT-1", quantity: 2, unit_cost: 60, core_charge: 0, status: "quoted", received_quantity: 0, job_id: null },
    ],
  },
});

const reset = () => {
  posted.length = 0;
  held.length = 0;
  w.state.detail = { segment: "recon", id: 1, item: {}, order: mkOrder() };
  w.state.staff = [];
  w.renderEstimate(w.state.detail.order);
};

/* Answer every request currently in the air and let the .then chains (and any
   follow-up save they start) run. settle() alone only drains a few turns. */
const answer = async () => {
  held.splice(0).forEach((go) => go());
  await settle(12);
};

/* ------------------------------------------------------------------
   1. Two saves asked for while the first is in flight: one request goes
      out, not two -- and the second one quotes the version the server just
      handed back rather than the one it has already moved past.
   ------------------------------------------------------------------ */
reset();
const startVersion = w.state.detail.order.estimate.edit_version;
const first = w.persistEstimate();
await settle();
ok(posted.length === 1, `expected 1 save in flight, saw ${posted.length}`);

// The advisor keeps typing while that first save is still posting. Whatever
// they type has to ride along on the follow-up, so change a value here and
// check it reaches the server. Focused, because that is where the cursor
// actually is -- an unfocused field is the one the in-place sync is entitled
// to overwrite with the server's copy.
const typing = doc.querySelectorAll("#vd-estimate-items .part-row:not(.head)")[1].querySelector(".ei-cost");
typing.focus();
typing.value = "72.25";
const second = w.persistEstimate();
await settle();
ok(posted.length === 1, `a second save was posted while the first was still in flight (${posted.length} requests)`);

await answer();
ok(posted.length === 2, `the coalesced follow-up save never went out (${posted.length} requests)`);
ok(posted[0].expected_version === startVersion,
   `first save quoted version ${posted[0].expected_version}, expected ${startVersion}`);
ok(posted[1].expected_version !== posted[0].expected_version,
   `the follow-up save re-sent the stale version ${posted[1].expected_version} -- this is the 409 the shop keeps seeing`);
ok(posted[1].expected_version === w.state.detail.order.estimate.edit_version ||
   posted[1].expected_version === posted[0].expected_version + 1,
   `the follow-up save quoted ${posted[1].expected_version}, not the version the server just wrote`);
ok(posted[1].items.some((i) => i.unit_cost === 72.25),
   "the follow-up save posted a stale snapshot -- the value typed while the first save was in flight was dropped");

await answer();
await Promise.all([first, second]);
ok(doc.querySelector("#vd-estimate-save-state").textContent === "All changes saved",
   `save indicator ended at "${doc.querySelector("#vd-estimate-save-state").textContent}", expected "All changes saved"`);

/* ------------------------------------------------------------------
   2. Many calls in a row collapse into exactly one follow-up. Tabbing
      through Description -> Qty -> Cost fires three; the shop does not need
      three extra round trips to the server for one line.
   ------------------------------------------------------------------ */
reset();
const many = [w.persistEstimate(), w.persistEstimate(), w.persistEstimate(), w.persistEstimate()];
await settle();
ok(posted.length === 1, `${posted.length} requests went out for four rapid edits, expected 1 in flight`);
await answer();
ok(posted.length === 2, `four rapid edits produced ${posted.length} requests, expected exactly 2 (the first plus one follow-up)`);
await answer();
await Promise.all(many);
ok(posted.length === 2, `a coalesced follow-up kept re-firing: ${posted.length} requests`);

/* ------------------------------------------------------------------
   3. Through the real listeners, at the real timing. This is the sequence
      the shop actually performs: type a figure, pause long enough for the
      keystroke save to go out, then tab to the next field while it is still
      posting. Both saves are genuine, both used to be in the air at once,
      and the second one came back 409.
   ------------------------------------------------------------------ */
reset();
const cost = doc.querySelectorAll("#vd-estimate-items .part-row:not(.head)")[0].querySelector(".ei-cost");
cost.focus();
cost.value = "44.00";
cost.dispatchEvent(new w.Event("input", { bubbles: true }));
// The keystroke debounce in wireEstimateGrid is 800ms of real time.
await new Promise((resolve) => setTimeout(resolve, 900));
await settle();
ok(posted.length === 1, `the keystroke save never went out (${posted.length} requests)`);
// ...and now Tab, while that save is still posting.
cost.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(posted.length === 1, `typing then tabbing out put ${posted.length} saves in the air at once`);
await answer();
await answer();
ok(doc.querySelector("#vd-estimate-save-state").textContent !== "Not saved",
   'typing then tabbing out left the grid showing "Not saved"');
ok(!posted.slice(1).some((p) => p.expected_version === posted[0].expected_version),
   "a follow-up save re-used the version the server had already moved past");

/* ------------------------------------------------------------------
   4. A failed save does not get re-sent on top of its own recovery. It has
      already said "Not saved" and left the typing on screen for the next
      edit to carry; a coalesced follow-up would just fail the same way.
   ------------------------------------------------------------------ */
reset();
nextStatus = 503;
failMessage = "Database is locked";
const failing = w.persistEstimate();
await settle();
const alsoFailing = w.persistEstimate();
await settle();
ok(posted.length === 1, `expected 1 request for the failing save, saw ${posted.length}`);
await answer();
await Promise.all([failing, alsoFailing]);
await settle();
ok(posted.length === 1, `a save that failed still fired its queued follow-up (${posted.length} requests)`);
ok(doc.querySelector("#vd-estimate-save-state").textContent === "Not saved",
   `a failed save left the indicator showing "${doc.querySelector("#vd-estimate-save-state").textContent}"`);

/* ------------------------------------------------------------------
   5. A conflict that is real -- somebody else genuinely saved this ticket --
      still reloads it, which is the whole point of keeping the check. After
      the fix that message can only mean what it says.
   ------------------------------------------------------------------ */
reset();
const reloadsBefore = fetchLog.filter((f) => /\/api\/recon\/vehicles\/1$/.test(f.url)).length;
nextStatus = 409;
failMessage = "Someone else changed this estimate since you loaded it -- reload to see their update";
const conflicted = w.persistEstimate();
await settle();
await answer();
await conflicted;
await settle(12);
const reloadsAfter = fetchLog.filter((f) => /\/api\/recon\/vehicles\/1$/.test(f.url)).length;
ok(reloadsAfter === reloadsBefore + 1,
   `a real conflict reloaded the vehicle ${reloadsAfter - reloadsBefore} times, expected 1`);
nextStatus = 200;

finish("estimate autosave never fights itself");
