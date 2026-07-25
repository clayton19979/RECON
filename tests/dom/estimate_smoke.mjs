// Front-end smoke test.
//
// The static checks in tests/test_static_assets.py hold app.js and index.html
// to each other, but nothing actually *ran* the front end -- a render function
// could throw on every ticket and the suite would stay green. This boots the
// real index.html in jsdom, evaluates the real app.js, and drives the densest
// screen in the app (Parts & Labor) with fixture data.
//
// Requires jsdom, which is not a dependency of the app itself:
//     cd tests/dom && npm install jsdom
// tests/test_dom_smoke.py skips when node or jsdom isn't there, so this is
// strictly a bonus check on machines that have them.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// CommonJS resolution, so NODE_PATH works and jsdom can live anywhere the
// caller points at rather than only in a node_modules beside this file.
const { JSDOM } = createRequire(import.meta.url)("jsdom");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "static");
const html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
const js = fs.readFileSync(`${ROOT}/app.js`, "utf8");

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;

// Scriptable fetch: POST /api/orders/N/estimate hands back whatever the
// current test staged, everything else returns an empty list. Lets the autosave
// round-trip (change -> persistEstimate -> applyEstimateResponse) be driven
// end to end without a server.
let stagedEstimate = null;
const fetchLog = [];
w.fetch = async (url, opts = {}) => {
  fetchLog.push({ url: String(url), method: opts.method || "GET" });
  return {
    ok: true,
    status: 200,
    json: async () => (stagedEstimate && /\/estimate$/.test(String(url)) ? stagedEstimate : []),
  };
};
w.eval(js + "\n;Object.assign(window, { state, renderEstimate, collectEstimateItems, addEstimateRow, confirmAction, renderViewFailure, wireConfirmDialog, wireViewRetry, estimateShape, applyEstimateResponse, syncEstimateInPlace, captureEstimateFocus, restoreEstimateFocus, persistEstimate, setEstimateSaveState, toast, messageLog });");
// Wait for jsdom's *own* DOMContentLoaded rather than dispatching one.
// Dispatching it manually ran the app's whole init twice (jsdom fires the real
// event a tick after the constructor returns), which quietly doubled every
// listener the app binds at startup -- so a toggle handler bound at init ran
// twice per click and appeared not to work at all.
await new Promise((resolve) => {
  if (w.document.readyState === "loading") w.document.addEventListener("DOMContentLoaded", resolve, { once: true });
  else { w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true })); resolve(); }
});

// Give queued promise callbacks (fetch -> json -> render) a chance to run.
const settle = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

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
  ok(w.document.querySelector("#vd-quoted-cost").textContent !== "$0.00", `${label}: quoted total not computed`);
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
ok(doc.querySelector("#vd-quoted-cost").textContent !== "$0.00", "totals not recomputed after an in-place sync");
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
console.log("PASS -- estimate grid, autosave/focus behaviour, message log, confirm dialog and error boundary");
