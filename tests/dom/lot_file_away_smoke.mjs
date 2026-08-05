// Filing the finished pile away from the Lot Status sheet.
//
// The sheet's last section is cars whose only remaining step is to be filed --
// every row of it prints "send to History". Doing that one car at a time is
// why the pile grows, and while it does, the counts above it describe a bigger
// lot than the shop has.
//
// What this owns is the reading of the button and the asking: the Python side
// (tests/test_lot_file_away.py) owns which cars may actually be filed. The
// things worth pinning here are the ones that make a bulk action safe to press
// on a busy morning:
//
//   * the button only appears on the finished pile, and only when it has cars
//   * it asks first, and the ask NAMES every car -- this is the last screen
//     any of them appear on, so a count is not something you can check
//   * a car in the pile whose cost is short a part nobody receipted is said
//     out loud, because filing is when a car stops being looked at
//   * cancel sends nothing
//   * what the server refused is reported, not swallowed

import { boot, click } from "./harness.mjs";

const car = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "estimate", status_bucket: "open", archived: false,
  technicians: [], purchase_price: 0, quoted_cost: 0, actual_cost: 0, remaining_cost: 0,
  customer_paid: 0, net_cost: 0, parts_pending: 0, parts_pending_value: 0,
  idle_days: 0, age_days: 1, updated_at: "2026-07-01T09:00:00", edit_version: 1, lot_bucket: "working",
  needs: "work under way", ...over,
});

/* One car still in the shop and three whose lot life is over -- a sold lot
   car, a kept promise and a waived one. The waived one carries $380 of parts
   nobody receipted, which is the money the ask has to mention. */
const lot = [
  car({
    lot_bucket: "working", recon_id: 9, stock_number: "R-1002", vehicle: "2017 Hyundai Elantra",
    actual_cost: 100, remaining_cost: 240, needs: "1 part on order ($240.00)",
  }),
  car({
    lot_bucket: "settled", recon_id: 11, stock_number: "R-0981", vehicle: "2015 Chevrolet Malibu",
    status: "sold", status_bucket: "finished", idle_days: 41, edit_version: 4,
    needs: "Sold — send to History",
  }),
  car({
    lot_bucket: "settled", segment: "we_owe", we_owe_id: 5, vehicle: "2018 Honda Accord",
    customer_name: "Marcus Doyle", status: "fulfilled", status_bucket: "finished", idle_days: 21,
    edit_version: 2, needs: "Fulfilled — send to History",
  }),
  car({
    lot_bucket: "settled", segment: "we_owe", we_owe_id: 7, vehicle: "2017 Jeep Cherokee",
    customer_name: "Iris Chandler", status: "waived", status_bucket: "finished", idle_days: 34,
    edit_version: 9, unreceived_closed_cost: 380, unreceived_closed_parts: 1,
    needs: "Waived — but 1 part never marked received ($380.00 not in the cost)",
  }),
];

// What the server answers the file-away call with. Swapped mid-test to cover
// the "one of them stayed" case.
let fileAwayAnswer = {
  filed: [
    { segment: "recon", id: 11, label: "R-0981 — 2015 Chevrolet Malibu" },
    { segment: "we_owe", id: 5, label: "2018 Honda Accord — Marcus Doyle" },
    { segment: "we_owe", id: 7, label: "2017 Jeep Cherokee — Iris Chandler" },
  ],
  skipped: [],
};
const posts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state"],
  fetch: async (url, opts) => {
    if (url === "/api/lot/file-away") {
      posts.push(JSON.parse(opts.body));
      return fileAwayAnswer;
    }
    if (url.startsWith("/api/reports/lot")) return lot;
    if (url.startsWith("/api/reports/")) return [];
    return [];
  },
  beforeBoot: (win) => win.localStorage.setItem("dao-report-view", JSON.stringify({ type: "lot" })),
});

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];

click(w, $('.rail-item[data-view="reports"]'));
await settle();
await settle();

/* ---------- the button is on the finished pile and nowhere else ---------- */
const buttons = $$("#report-output [data-file-away]");
ok(buttons.length === 1, `expected exactly one file-away button, got ${buttons.length}`);
const button = buttons[0];
ok(button?.closest("tr")?.dataset.lotGroup === "settled",
   "the file-away button isn't on the Finished pile's band");
ok(/all 3/.test(button?.textContent || ""),
   `the button doesn't say how many it will file: "${button?.textContent.trim()}"`);
// The working pile has cars in it and must not offer to file them.
ok(!$('#report-output tr.lot-group-head[data-lot-group="working"] [data-file-away]'),
   "a pile of cars still in the shop is offering to file them away");

/* ---------- it asks first, and the ask names every car ----------
   This is the last screen these cars appear on. "File 3 cars away" is not
   something anybody can check; a list of names is. */
click(w, button);
await settle();
ok($("#confirm-dialog").open, "the pile was filed without asking");
const askBody = $("#confirm-body").textContent;
for (const name of ["R-0981", "2015 Chevrolet Malibu", "Marcus Doyle", "Iris Chandler"]) {
  ok(askBody.includes(name), `the ask doesn't name ${name}: "${askBody.replace(/\s+/g, " ").trim()}"`);
}
ok(/reopened/i.test(askBody) && /Nothing is deleted/i.test(askBody),
   `the ask doesn't say the filing can be undone: "${askBody.replace(/\s+/g, " ").trim()}"`);
// A car in this pile whose cost is short says so here or nowhere: once it is
// filed, nobody looks at it again.
ok(/\$380\.00/.test(askBody) && /never marked received/.test(askBody),
   `the ask doesn't warn about the unreceipted part: "${askBody.replace(/\s+/g, " ").trim()}"`);

/* ---------- cancel sends nothing ---------- */
click(w, $("#confirm-cancel"));
await settle();
ok(posts.length === 0, "cancelling the ask filed the cars anyway");

/* ---------- confirming sends both halves of the pile, and only them ---------- */
click(w, $("#report-output [data-file-away]"));
await settle();
click(w, $("#confirm-accept"));
await settle();
await settle();
ok(posts.length === 1, `expected one file-away call, got ${posts.length}`);
const sent = posts[0] || {};
ok(JSON.stringify(sent.recon) === JSON.stringify([{ id: 11, expected_version: 4 }]),
   `the recon half of the pile is wrong: ${JSON.stringify(sent.recon)}`);
// Each car goes with the version the sheet was showing, so one somebody at the
// other desk has since changed is refused rather than written over.
ok(JSON.stringify(sent.we_owe) === JSON.stringify([{ id: 5, expected_version: 2 }, { id: 7, expected_version: 9 }]),
   `the we-owe half of the pile is wrong: ${JSON.stringify(sent.we_owe)}`);
ok(/3 cars sent to History/.test($("#toast").textContent),
   `the toast doesn't report what was filed: "${$("#toast").textContent}"`);

/* ---------- what the server refused is reported, not swallowed ----------
   The other workstation is filing cars too. "3 filed" when only two went is
   how the sheet ends up looking like it lost one. */
fileAwayAnswer = {
  filed: [{ segment: "recon", id: 11, label: "R-0981 — 2015 Chevrolet Malibu" }],
  skipped: [
    { segment: "we_owe", id: 5, label: "2018 Honda Accord — Marcus Doyle", reason: "it is back in the shop" },
    { segment: "we_owe", id: 7, label: "2017 Jeep Cherokee — Iris Chandler", reason: "it is already in History" },
  ],
};
click(w, $("#report-output [data-file-away]"));
await settle();
click(w, $("#confirm-accept"));
await settle();
await settle();
const mixed = $("#toast").textContent;
ok(/1 car sent to History/.test(mixed), `the toast miscounts a partial filing: "${mixed}"`);
ok(/Marcus Doyle/.test(mixed) && /back in the shop/.test(mixed),
   `the toast doesn't say which car stayed or why: "${mixed}"`);
ok(/already in History/.test(mixed), `the second skip got dropped: "${mixed}"`);

ok(rejections.length === 0, `unhandled rejections: ${rejections.map((e) => e && e.message).join("; ")}`);
finish("lot file-away");
