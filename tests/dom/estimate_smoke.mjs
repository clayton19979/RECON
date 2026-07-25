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
w.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
w.eval(js + "\n;Object.assign(window, { state, renderEstimate, collectEstimateItems, addEstimateRow, confirmAction, renderViewFailure, wireConfirmDialog, wireViewRetry });");
w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }));

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

if (fails.length) {
  console.error("FAIL\n" + fails.join("\n"));
  process.exit(1);
}
console.log("PASS -- estimate grid, confirm dialog and error boundary all render");
