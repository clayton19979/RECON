// Parts & Labor grid smoke test.
//
// The static checks in tests/test_static_assets.py hold app.js and index.html
// to each other, but nothing actually *ran* the front end -- a render function
// could throw on every ticket and the suite would stay green. This boots the
// real index.html in jsdom (see harness.mjs), evaluates the real app.js, and
// drives the densest screen in the app (Parts & Labor) with fixture data.

import { boot } from "./harness.mjs";

// Scriptable fetch: POST /api/orders/N/estimate hands back whatever the
// current test staged, everything else returns an empty list. Lets the autosave
// round-trip (change -> persistEstimate -> applyEstimateResponse) be driven
// end to end without a server.
let stagedEstimate = null;
const { w, fetchLog, settle, ok, fails } = await boot({
  expose: ["state", "renderEstimate", "collectEstimateItems", "addEstimateRow", "confirmAction",
           "renderViewFailure", "wireConfirmDialog", "wireViewRetry", "estimateShape",
           "applyEstimateResponse", "syncEstimateInPlace", "captureEstimateFocus",
           "restoreEstimateFocus", "persistEstimate", "setEstimateSaveState", "toast", "messageLog"],
  fetch: async (url) => (stagedEstimate && /\/estimate$/.test(url) ? stagedEstimate : []),
});

const doc0 = (sel) => w.document.querySelector(sel).textContent;

const mkOrder = (jobs) => ({
  id: 1, number: "RO-1", status: "in_progress", concern: "",
  estimate: {
    edit_version: 1, jobs,
    items: [
      { id: 1, kind: "part", description: "Front pads", part_number: "PD-9", quantity: 2, unit_cost: 41.5, core_charge: 12, status: "quoted", received_quantity: 0, job_id: jobs[0]?.id ?? null },
      { id: 2, kind: "labor", description: "R&R front brakes", quantity: 1.5, unit_cost: 95, status: "quoted", received_quantity: 0, job_id: jobs[0]?.id ?? null },
      { id: 3, kind: "part", description: "Rotor", part_number: "RT-1", quantity: 2, unit_cost: 60, core_charge: 0, status: "received", received_quantity: 2, received_invoice_number: "INV-7", part_returned: false, job_id: null },
    ],
  },
});

for (const [label, jobs] of [["flat", []], ["jobs", [{ id: 7, title: "Front brakes", technician_id: null }]]]) {
  w.state.detail = { segment: "recon", id: 1, item: {}, order: mkOrder(jobs) };
  w.state.staff = [{ id: 3, name: "Tech A", role: "technician", active: true }];
  w.renderEstimate(w.state.detail.order);
  const box = w.document.querySelector("#vd-estimate-items");
  const heads = [...box.querySelectorAll(".part-row.head")];
  const rows = [...box.querySelectorAll(".part-row:not(.head)")];
  ok(rows.length === 3, `${label}: expected 3 data rows, got ${rows.length}`);
  ok(heads.length >= 1, `${label}: no header row rendered`);
  for (const h of heads) {
    for (const r of rows) {
      const hc = h.children.length, rc = r.children.length;
      ok(hc === rc, `${label}: header has ${hc} cells but a row has ${rc}`);
    }
  }
  // every direct child is a .pr-cell (no bare inputs escaping the wrapper)
  for (const r of [...rows, ...heads]) {
    const bad = [...r.children].filter((c) => !c.classList.contains("pr-cell"));
    ok(bad.length === 0, `${label}: ${bad.length} non-.pr-cell child in a part-row (${bad.map((b) => b.tagName).join(",")})`);
  }
  // captions present for the stacked layout
  for (const name of ["kind", "desc", "part", "qty", "cost", "status"]) {
    const c = rows[0].querySelector(`.pr-${name}`);
    ok(c && c.dataset.label, `${label}: .pr-${name} is missing its data-label caption`);
  }
  // the fields the rest of app.js reaches for still resolve
  for (const sel of [".ei-kind", ".ei-desc", ".ei-part", ".ei-qty", ".ei-cost", ".rm-btn"]) {
    ok(rows[0].querySelector(sel), `${label}: ${sel} missing from a rendered row`);
  }
  ok(rows[2].querySelector(".part-return-btn"), `${label}: received part has no Mark Returned button`);
  ok(box.classList.contains("has-jobs") === (jobs.length > 0), `${label}: has-jobs class wrong`);
  const collected = w.collectEstimateItems();
  ok(collected.length === 3, `${label}: collectEstimateItems returned ${collected.length}, expected 3`);
  ok(collected[0].description === "Front pads" && collected[0].quantity === 2 && collected[0].unit_cost === 41.5,
     `${label}: collectEstimateItems lost field values: ${JSON.stringify(collected[0])}`);
  ok(w.document.querySelector("#vd-ticket-total").textContent !== "$0.00", `${label}: ticket total not computed`);
}

/* ------------------------------------------------------------------
   A part billed at something other than its estimate.

   The receive dialog already showed the difference while the invoice was
   being keyed in; the ticket has to keep showing it afterwards, and the
   ticket's Quoted total has to stay the quote rather than following the
   bill. Both used to be impossible -- receiving overwrote unit_cost and
   there was nothing left to compare against.
   ------------------------------------------------------------------ */
{
  const quotedOrder = {
    id: 1, number: "RO-1", status: "in_progress", concern: "",
    estimate: {
      edit_version: 1, jobs: [],
      items: [
        { id: 11, kind: "part", description: "Alternator", part_number: "ALT-1", quantity: 1,
          unit_cost: 175, quoted_unit_cost: 100, status: "received", received_quantity: 1,
          received_invoice_number: "INV-9", part_returned: false, job_id: null },
        { id: 12, kind: "part", description: "Belt", part_number: "BLT-1", quantity: 1,
          unit_cost: 30, quoted_unit_cost: 30, status: "received", received_quantity: 1,
          received_invoice_number: "INV-9", part_returned: false, job_id: null },
      ],
    },
  };
  w.state.detail = { segment: "recon", id: 1, item: {}, order: quotedOrder };
  w.renderEstimate(quotedOrder);
  const qRows = [...w.document.querySelector("#vd-estimate-items").querySelectorAll(".part-row:not(.head)")];

  const note = qRows[0].querySelector(".ei-quote-note");
  ok(note, "a part billed over its estimate has no Quoted note on the row");
  ok(note.textContent.includes("$100.00"), `Quoted note says "${note && note.textContent}", expected the $100.00 quote`);
  ok(note.classList.contains("over"), "a part that cost MORE than quoted is not marked as over");
  ok(qRows[0].querySelector(".pr-cost").classList.contains("has-quote-note"),
     "the cost cell is not marked to stack the note under the price -- it renders beside it and squeezes the field");
  ok(qRows[0].dataset.quotedUnitCost === "100",
     `row is not carrying the frozen quote for live totals (got "${qRows[0].dataset.quotedUnitCost}")`);
  ok(!qRows[1].querySelector(".ei-quote-note"),
     "a line that came in at exactly its quoted price printed the same number twice");

  ok(doc0("#vd-ticket-total") === "$130.00", `written-up total is ${doc0("#vd-ticket-total")}, expected $130.00`);
  ok(doc0("#vd-actual-cost") === "$205.00", `ticket actual total is ${doc0("#vd-actual-cost")}, expected $205.00`);
  ok(!w.document.querySelector("#vd-cost-delta"), "the over/under-quote badge is back on the ticket card");

  // Correcting a mis-keyed invoice price moves what the car cost, never the
  // quote -- the same rule the server applies when it saves the grid.
  const costBox = qRows[0].querySelector(".ei-cost");
  costBox.focus();
  costBox.value = "185";
  costBox.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(doc0("#vd-actual-cost") === "$215.00", `live actual did not follow the corrected price: ${doc0("#vd-actual-cost")}`);
  ok(doc0("#vd-ticket-total") === "$130.00",
     `retyping the price of a received part rewrote the written-up total to ${doc0("#vd-ticket-total")}`);

  // A line still being quoted works the other way round: the cost box IS the
  // quote until the part lands, so typing in it has to move both.
  const beltBox = qRows[1].querySelector(".ei-cost");
  qRows[1].dataset.receivedQuantity = "0";
  beltBox.focus();
  beltBox.value = "50";
  beltBox.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok(doc0("#vd-ticket-total") === "$150.00",
     `repricing a part nobody has received left a stale written-up total: ${doc0("#vd-ticket-total")}`);
}

// addEstimateRow's transient row matches the rendered ones
w.state.detail.order = mkOrder([]);
w.renderEstimate(w.state.detail.order);
w.addEstimateRow("part");
const allRows = [...w.document.querySelectorAll("#vd-estimate-items .part-row:not(.head)")];
const head = w.document.querySelector("#vd-estimate-items .part-row.head");
ok(allRows.at(-1).children.length === head.children.length,
   `addEstimateRow row has ${allRows.at(-1).children.length} cells, header has ${head.children.length}`);

// confirm dialog: resolves false on cancel, true on accept, and never leaves a stale resolver
const dlg = w.document.querySelector("#confirm-dialog");
dlg.showModal = function () { this.open = true; };
dlg.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
let p = w.confirmAction({ title: "T", body: "B", danger: true });
ok(w.document.querySelector("#confirm-title").textContent === "T", "confirm title not set");
ok(dlg.classList.contains("danger"), "danger class not applied");
ok(w.document.querySelector("#confirm-accept").className.includes("btn-danger"), "danger button style not applied");
w.document.querySelector("#confirm-cancel").click();
ok((await p) === false, "cancel did not resolve false");
p = w.confirmAction({ title: "T2" });
w.document.querySelector("#confirm-accept").click();
ok((await p) === true, "accept did not resolve true");
p = w.confirmAction({ title: "T3" });
dlg.close(); // Esc / backdrop
ok((await p) === false, "Esc close did not resolve false");

// error boundary paints into the view's own container
w.renderViewFailure("vehicles", new Error("boom"));
const vt = w.document.querySelector("#vehicles-table").innerHTML;
ok(vt.includes("boom") && vt.includes("retry-view"), "view failure state missing message or retry button");

/* ------------------------------------------------------------------
   Autosave: delegated listeners, in-place sync, focus survival.

   The bug this guards against: every field on the grid saves on change, the
   save returns the whole estimate, and re-rendering from it destroyed the
   controls the advisor was standing in -- so tabbing Description -> Qty fired
   the Description save, and its response yanked focus back out of Qty a beat
   later, eating whatever had been typed in between.
   ------------------------------------------------------------------ */
const doc = w.document;
const grid = doc.querySelector("#vd-estimate-items");
const order2 = mkOrder([]);
w.state.detail = { segment: "recon", id: 1, item: {}, order: order2 };
w.renderEstimate(order2);

// estimateShape has to ignore exactly the fields that live inside inputs, or
// the cheap path never triggers and nothing above is worth anything.
const shapeOf = (over) => w.estimateShape({ estimate: { jobs: [], items: [{ id: 1, kind: "part", job_id: null, status: "quoted", quantity: 1, received_quantity: 0, ...over }] } });
ok(shapeOf({}) === shapeOf({ quantity: 9, unit_cost: 42, description: "changed", part_number: "X", core_charge: 3 }),
   "estimateShape reacts to editable values -- the in-place path will never trigger");
ok(shapeOf({}) !== shapeOf({ status: "ordered" }), "estimateShape ignores a status change");
ok(shapeOf({}) !== shapeOf({ part_returned: true }), "estimateShape ignores a vendor return");
ok(shapeOf({}) !== shapeOf({ quantity: 1, received_quantity: 1 }), "estimateShape ignores a line becoming fully received");

// --- same shape: sync in place, never touch the focused control ---
const rowsA = [...grid.querySelectorAll(".part-row:not(.head)")];
const descA = rowsA[0].querySelector(".ei-desc");
stagedEstimate = JSON.parse(JSON.stringify(order2.estimate));
stagedEstimate.edit_version = 2;
stagedEstimate.items[1].unit_cost = 120; // a value changed on a *different* line

descA.focus();
descA.value = "Front pads (mid-edit)";
descA.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();

ok(fetchLog.some((f) => f.method === "POST" && /\/estimate$/.test(f.url)),
   "editing a field did not trigger a save -- the delegated change listener is not wired");
ok(doc.activeElement === descA, "the autosave round-trip stole focus from the field being edited");
ok(grid.querySelectorAll(".part-row:not(.head)")[0] === rowsA[0],
   "a same-shape save redrew the grid instead of syncing in place");
ok(descA.value === "Front pads (mid-edit)", "a same-shape save clobbered the focused field's value");
ok(rowsA[1].querySelector(".ei-cost").value === "120",
   "a same-shape save did not push the server's value into an unfocused field");
ok(doc.querySelector("#vd-ticket-total").textContent !== "$0.00", "totals not recomputed after an in-place sync");
ok(doc.querySelector("#vd-estimate-save-state").textContent.length > 0, "the autosave indicator never said anything");

// --- shape changed: full redraw, but focus lands back where it was ---
const rowsB = [...grid.querySelectorAll(".part-row:not(.head)")];
const qtyB = rowsB[0].querySelector(".ei-qty");
qtyB.focus();
stagedEstimate = JSON.parse(JSON.stringify(order2.estimate));
stagedEstimate.items[0].status = "ordered";
qtyB.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();

const rowsC = [...grid.querySelectorAll(".part-row:not(.head)")];
ok(rowsC[0] !== rowsB[0], "a structural change (status flip) should have redrawn the grid");
ok(rowsC[0].querySelector(".ei-status") === null || rowsC[0].querySelector(".ei-status").value === "ordered",
   "the redraw did not pick up the new status");
ok(doc.activeElement === rowsC[0].querySelector(".ei-qty"),
   "focus was not restored to the same field after a full re-render");

// --- delegated click handlers reach rows that never had a listener bound ---
stagedEstimate = JSON.parse(JSON.stringify(order2.estimate));
stagedEstimate.items = stagedEstimate.items.slice(1);
rowsC[0].querySelector(".rm-btn").click();
doc.querySelector("#confirm-accept").click(); // the delegated handler asks first
await settle();
const rowsD = [...grid.querySelectorAll(".part-row:not(.head)")];
ok(rowsD.length === 2, `delegated × button left ${rowsD.length} rows, expected 2`);
ok(rowsD[0].querySelector(".ei-desc").value === "R&R front brakes", "the wrong row was removed");

/* ------------------------------------------------------------------
   Keystroke-level behaviour: live totals, debounced autosave, and
   Tab-out-of-the-last-row adding the next line.

   Grid state here: two rows -- "R&R front brakes" (labor, 1.5 x $120
   after the in-place-sync test above pushed 120 into it) and "Rotor"
   (part, 2 x $60, fully received). Typing qty 3 into the labor line
   makes quoted = 3*120 + 2*60 = $480, actual the same (rotor counts
   its received qty, labor counts as logged).
   ------------------------------------------------------------------ */
const waitDebounce = () => new Promise((r) => setTimeout(r, 950)).then(() => settle());
const estimatePosts = () => fetchLog.filter((f) => f.method === "POST" && /\/estimate$/.test(f.url)).length;

// --- typing a qty updates every total immediately, with no save yet ---
let postsBefore = estimatePosts();
const laborQty = rowsD[0].querySelector(".ei-qty");
laborQty.focus();
laborQty.value = "3";
laborQty.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(doc.querySelector("#vd-ticket-total").textContent === "$480.00",
   `live ticket total wrong after typing: ${doc.querySelector("#vd-ticket-total").textContent}, expected $480.00`);
ok(doc.querySelector("#vd-actual-cost").textContent === "$480.00",
   `live actual total wrong after typing: ${doc.querySelector("#vd-actual-cost").textContent}`);
ok(!doc.querySelector("#vd-cost-delta"), "the over/under-quote badge is back on the ticket");
ok(estimatePosts() === postsBefore, "a single keystroke fired an immediate save instead of debouncing");

// --- after a pause in typing, the debounced save lands on its own ---
stagedEstimate = JSON.parse(JSON.stringify(w.state.detail.order.estimate));
stagedEstimate.items[0].quantity = 3;
await waitDebounce();
ok(estimatePosts() === postsBefore + 1,
   `debounced autosave never fired (${estimatePosts() - postsBefore} saves after pause)`);

// --- a row with its description cleared is never autosaved away ---
postsBefore = estimatePosts();
const descClear = rowsD[0].querySelector(".ei-desc");
descClear.value = "";
descClear.dispatchEvent(new w.Event("input", { bubbles: true }));
await waitDebounce();
ok(estimatePosts() === postsBefore,
   "autosave fired while a description sat empty -- that save deletes the line");
descClear.value = "R&R front brakes"; // put it back, no events

// --- Tab in the middle of the grid just moves along it ---
postsBefore = estimatePosts();
const midTab = new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
rowsD[0].querySelector(".ei-cost").dispatchEvent(midTab);
ok(!midTab.defaultPrevented, "Tab on a middle row was hijacked");
ok(grid.querySelectorAll(".part-row:not(.head)").length === 2, "Tab on a middle row added a line");

// --- Tab out of the last money field on the last row adds the next line ---
stagedEstimate = JSON.parse(JSON.stringify(w.state.detail.order.estimate));
stagedEstimate.items[0].quantity = 3;
stagedEstimate.items.push({ id: 9, kind: "part", description: "New part", quantity: 1, unit_cost: 0, core_charge: 0, status: "quoted", received_quantity: 0, job_id: null });
const lastRow = [...grid.querySelectorAll(".part-row:not(.head)")].at(-1);
const lastField = lastRow.querySelector(".ei-core") || lastRow.querySelector(".ei-cost");
ok(lastField, "last row has no money field to tab out of");
const endTab = new w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
lastField.dispatchEvent(endTab);
ok(endTab.defaultPrevented, "Tab out of the last row was not intercepted");
const rowsAfterTab = [...grid.querySelectorAll(".part-row:not(.head)")];
ok(rowsAfterTab.length === 3, `Tab out of the last row left ${rowsAfterTab.length} rows, expected 3`);
ok(rowsAfterTab.at(-1).querySelector(".ei-kind").value === "part",
   "the tabbed-in line did not inherit the previous row's kind");
await settle(); // let the add's save round-trip finish before moving on

/* ------------------------------------------------------------------
   Enter completes the spreadsheet feel: on the last line it advances
   Description -> Qty -> Cost -> Core, and from the last money field
   starts the next line -- while Enter anywhere else keeps its default
   meaning. Grid state: three rows, the last being "New part" (a part,
   so it carries a Core field).
   ------------------------------------------------------------------ */
const pressEnter = (el) => {
  const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
const gridRows = () => [...grid.querySelectorAll(".part-row:not(.head)")];

// A middle row's Enter is not hijacked -- a correction upstream must not
// grow the estimate or yank focus.
const midEnter = pressEnter(gridRows()[0].querySelector(".ei-desc"));
ok(!midEnter.defaultPrevented, "Enter on a middle row was hijacked");
ok(gridRows().length === 3, "Enter on a middle row added a line");

// Description -> Qty -> Cost -> Core, walking one keypress at a time.
const enterRow = gridRows().at(-1);
enterRow.querySelector(".ei-desc").focus();
ok(pressEnter(enterRow.querySelector(".ei-desc")).defaultPrevented, "Enter in the last row's description fell through");
ok(doc.activeElement === enterRow.querySelector(".ei-qty"),
   "Enter from the description didn't land on Qty");
pressEnter(enterRow.querySelector(".ei-qty"));
ok(doc.activeElement === enterRow.querySelector(".ei-cost"),
   "Enter from Qty didn't land on Cost");
pressEnter(enterRow.querySelector(".ei-cost"));
ok(doc.activeElement === enterRow.querySelector(".ei-core"),
   "Enter from Cost on a part row didn't land on Core");

// From the last money field, Enter starts the next line -- same contract
// as Tab, including inheriting the kind and focusing the new description.
stagedEstimate = JSON.parse(JSON.stringify(w.state.detail.order.estimate));
stagedEstimate.items.push({ id: 10, kind: "part", description: "", quantity: 1, unit_cost: 0, core_charge: 0, status: "quoted", received_quantity: 0, job_id: null });
ok(pressEnter(enterRow.querySelector(".ei-core")).defaultPrevented, "Enter out of the last money field fell through");
ok(gridRows().length === 4, `Enter out of the last row left ${gridRows().length} rows, expected 4`);
ok(gridRows().at(-1).querySelector(".ei-kind").value === "part",
   "the Enter-added line did not inherit the previous row's kind");
await settle(); // focus lands after the add's save round-trips
ok(doc.activeElement === gridRows().at(-1).querySelector(".ei-desc"),
   "the Enter-added line didn't take focus on its description");

// And a last line whose description has been cleared refuses to chain on --
// the same guard that keeps Tab from minting blank lines.
const blankRow = gridRows().at(-1);
blankRow.querySelector(".ei-desc").value = "";
const blankLast = blankRow.querySelector(".ei-core") || blankRow.querySelector(".ei-cost");
pressEnter(blankLast);
ok(gridRows().length === 4, "Enter chained a new line on from an undescribed one");
blankRow.querySelector(".ei-desc").value = "New part"; // put it back, no events
await settle();

/* ------------------------------------------------------------------
   Shift+Enter walks the same chain backwards -- Core -> Cost -> Qty ->
   Description, then up into the previous line's last money field. It
   never adds a line, so unlike Enter it works from any row. Grid
   state: four rows, the last two are parts (Core fields present).
   ------------------------------------------------------------------ */
const pressShiftEnter = (el) => {
  const ev = new w.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
const backRow = gridRows().at(-1);
backRow.querySelector(".ei-core").focus();
ok(pressShiftEnter(backRow.querySelector(".ei-core")).defaultPrevented,
   "Shift+Enter in Core fell through");
ok(doc.activeElement === backRow.querySelector(".ei-cost"),
   "Shift+Enter from Core didn't land on Cost");
pressShiftEnter(backRow.querySelector(".ei-cost"));
ok(doc.activeElement === backRow.querySelector(".ei-qty"),
   "Shift+Enter from Cost didn't land on Qty");
pressShiftEnter(backRow.querySelector(".ei-qty"));
ok(doc.activeElement === backRow.querySelector(".ei-desc"),
   "Shift+Enter from Qty didn't land on Description");

// From the start of a line, Shift+Enter climbs to the previous row's last
// enabled money field -- the exact spot Enter/Tab would have left from.
pressShiftEnter(backRow.querySelector(".ei-desc"));
const climbRow = gridRows().at(-2);
const climbTarget = climbRow.querySelector(".ei-core") || climbRow.querySelector(".ei-cost");
ok(doc.activeElement === climbTarget,
   "Shift+Enter from a line's description didn't climb to the previous row's last money field");

// Works mid-grid too (it never adds lines, so there's no last-row-only
// guard), and never grows the estimate.
pressShiftEnter(gridRows()[0].querySelector(".ei-qty"));
ok(doc.activeElement === gridRows()[0].querySelector(".ei-desc"),
   "Shift+Enter on a middle row didn't walk backwards");
ok(gridRows().length === 4, "Shift+Enter changed the row count");

// First field of the first line: nowhere further back, keep the default.
const topOut = pressShiftEnter(gridRows()[0].querySelector(".ei-desc"));
ok(!topOut.defaultPrevented, "Shift+Enter at the top of the grid was hijacked");

/* ------------------------------------------------------------------
   Message log: a toast that faded is still recoverable from the bell.
   ------------------------------------------------------------------ */
const notifList = doc.querySelector("#notif-list");
const notifDot = doc.querySelector("#notif-dot");
const notifMenu = doc.querySelector("#notif-menu");
doc.querySelector("#notif-clear").click();
ok(notifList.textContent.includes("Nothing yet"), "empty message log shows no empty state");
ok(notifDot.hidden, "unread dot showing with nothing unread");

w.toast("Saved");
w.toast("Could not reach the server", true);
ok(notifList.querySelectorAll(".notif-item").length === 2, "toasts are not being recorded in the message log");
ok(notifList.querySelector(".notif-item").textContent.includes("Could not reach the server"),
   "message log is not newest-first");
ok(notifList.querySelectorAll(".notif-item.error").length === 1, "the error entry is not marked as one");
ok(!notifDot.hidden && notifDot.textContent === "1", "the unread dot did not count the error");

doc.querySelector("#notif-toggle").click();
ok(notifMenu.classList.contains("open"), "the bell did not open the panel");
ok(notifDot.hidden, "opening the panel did not clear the unread count");

// XSS: the log renders arbitrary server-supplied error text.
w.toast('<img src=x onerror="window.__pwned=1">', true);
ok(!notifList.querySelector("img"), "message log renders raw HTML from an error message");

doc.body.click(); // click-outside closes
ok(!notifMenu.classList.contains("open"), "clicking outside did not close the panel");

if (fails.length) {
  console.error("FAIL\n" + fails.join("\n"));
  process.exit(1);
}
console.log("PASS -- estimate grid, autosave/focus, live totals + debounce + tab-to-add, message log, confirm dialog and error boundary");
// Exit explicitly -- the app leaves its update-check interval running, and a
// passing test would otherwise sit on jsdom's event loop until the timeout.
process.exit(0);
