// Unreceived-parts smoke test.
//
// The Cost column counts a part once it has been marked received. When a
// ticket gets closed with its parts still sitting at "quoted" -- which is the
// normal way for it to go on a busy morning -- the car reads $0.00 spent, and
// the Cost card then subtracted that $0.00 from the quote and announced, in
// green, that the lot had come in under estimate. Unrecorded spending
// presented as a saving is the single worst thing this board can say.
//
// So: the row has to carry the shortfall, and the card has to stop calling it
// a win. Both are pure render logic, unreachable from the Python tests.

import { boot } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "complete", status_bucket: "finished",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  age_days: 1, parts_pending: 0, parts_pending_value: 0,
  unreceived_cost: 0, unreceived_closed_cost: 0, unreceived_closed_parts: 0,
  idle_days: 0, last_activity_at: "2026-07-25T08:00:00", order_id: null, ...over,
});

/* Three cars, each a case the card has to tell apart:
     R-100  finished, $380 quoted, nothing receipted -- the whole bug
     R-200  finished and fully receipted at exactly its quote
     R-300  still open with $95 quoted and nothing landed yet

   Board totals: $600 cost against $1,075 quoted, so the naive card reads
   "$475.00 under" -- and $475 is exactly the two unreceived figures added
   together ($380 + $95). Not a dollar of it was saved. */
let board = [
  veh({ recon_id: 1, stock_number: "R-100", vehicle: "2016 Ford Fusion",
        quoted_cost: 380, actual_cost: 0, unreceived_cost: 380,
        unreceived_closed_cost: 380, unreceived_closed_parts: 1 }),
  veh({ recon_id: 2, stock_number: "R-200", vehicle: "2018 Kia Sorento",
        quoted_cost: 600, actual_cost: 600 }),
  veh({ recon_id: 3, stock_number: "R-300", vehicle: "2017 Hyundai Elantra",
        status: "in_progress", status_bucket: "in_progress",
        quoted_cost: 95, actual_cost: 0, unreceived_cost: 95 }),
];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "renderVehiclesTable", "loadVehiclesView", "boardStats", "visibleVehicles"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) return url.includes("archived=true") ? [] : board;
    return [];
  },
});

const $ = (sel) => doc.querySelector(sel);
const rowFor = (stock) =>
  [...doc.querySelectorAll("#vehicles-table tr")].find((tr) => tr.textContent.includes(stock));
const costCell = (stock) => rowFor(stock).querySelector("td:last-child");

await w.loadVehiclesView();
await settle();

/* ---------- the shortfall reaches the row ---------- */

const missing = costCell("R-100").querySelector(".cost-missing");
ok(missing, "the finished car with unreceived parts has no shortfall marker in its Cost cell");
ok(missing && missing.textContent.includes("$380.00"),
  `the marker should name the missing money, got "${missing && missing.textContent}"`);
ok(costCell("R-100").textContent.includes("$0.00"),
  "the Cost figure itself must still say what actually landed");
ok(missing && /never marked received/i.test(missing.getAttribute("title") || ""),
  "the marker needs a tooltip saying what to do about it");

ok(!costCell("R-200").querySelector(".cost-missing"),
  "a car whose parts were all receipted must not be flagged");
ok(!costCell("R-300").querySelector(".cost-missing"),
  "an open ticket's unreceived parts are work ahead, not a hole -- flagging them would " +
  "put a warning on most of the board");

/* ---------- the Cost card stops calling it a saving ---------- */

const stats = w.boardStats(w.visibleVehicles());
ok(stats.cost === 600 && stats.quoted === 1075,
  `card totals drifted: ${stats.cost} of ${stats.quoted}`);
ok(stats.unreceived === 475, `unreceived should total 475, got ${stats.unreceived}`);

const sub = $("#stat-quoted-sub").textContent;
ok(!/under the/.test(sub),
  `the Cost card still reports unrecorded spending as coming in under quote: "${sub}"`);
ok(sub.includes("$475.00") && /not marked received/i.test(sub),
  `the Cost card should name the unreceived money instead, got "${sub}"`);
ok(!/var\(--good\)/.test($("#stat-quoted-sub").style.color),
  "the Cost card is still painting this green");

/* ---------- a genuine saving still reads as one ---------- */

board = [veh({ recon_id: 9, stock_number: "R-900", vehicle: "2015 Chevrolet Malibu", quoted_cost: 500, actual_cost: 400 })];
await w.loadVehiclesView();
await settle();
ok(/under the \$500\.00 quoted/.test($("#stat-quoted-sub").textContent),
  `a car that really did come in under quote should still say so, got "${$("#stat-quoted-sub").textContent}"`);
ok($("#stat-quoted-sub").style.color.includes("--good"),
  "a real saving lost its green");

/* ---------- over quote still wins ---------- */

board = [veh({ recon_id: 10, stock_number: "R-910", vehicle: "2019 Toyota RAV4", quoted_cost: 500, actual_cost: 800, unreceived_cost: 120 })];
await w.loadVehiclesView();
await settle();
ok(/over the \$500\.00 quoted/.test($("#stat-quoted-sub").textContent),
  `running past the estimate is real whatever else is outstanding, got "${$("#stat-quoted-sub").textContent}"`);

ok(!rejections.length, `unhandled rejections: ${rejections.map((r) => r && r.message).join(", ")}`);
finish("unreceived parts");
