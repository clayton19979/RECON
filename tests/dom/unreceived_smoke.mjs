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
//
// The other half of this, and the part that is easy to get backwards: only a
// *closed* ticket's unreceived parts are that shortfall. On an open ticket the
// same line is a part that was ordered and hasn't turned up, which is not
// spending at all and which the Waiting on Parts card already reports. The row
// badge has always drawn that line; the Cost card and the column band did not,
// so the board was the one surface whose figure disagreed with the Lot Status
// sheet, the spend and profit reports and the exported files. Everything below
// pins all three to the same rule.

import { boot } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "complete", status_bucket: "finished",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  age_days: 1, parts_pending: 0, parts_pending_value: 0,
  unreceived_cost: 0, unreceived_closed_cost: 0, unreceived_closed_parts: 0,
  // The board draws columns by default, so a row with no pile on it would pile
  // every car into "In the shop" and the column bands below would be testing
  // nothing. A finished car is "Ready to go" -- see add_lot_status.
  lot_bucket: "ready", remaining_cost: 0,
  idle_days: 0, last_activity_at: "2026-07-25T08:00:00", order_id: null, ...over,
});

/* Three cars, each a case the card has to tell apart:
     R-100  finished, $380 quoted, nothing receipted -- the whole bug
     R-200  finished and fully receipted at exactly its quote
     R-300  still open with $95 quoted and nothing landed yet

   Board totals: $600 cost against $1,075 quoted, so the naive card reads
   "$475.00 under" -- and $475 is exactly the two unreceived figures added
   together ($380 + $95). Not a dollar of it was saved.

   Only $380 of that is money the shop has actually spent. R-300's $95 is a
   part on an OPEN ticket: ordered and not delivered yet, which is the Waiting
   on Parts card's business, not the Cost card's. The row-level rule below has
   always said so; the card used to contradict it. */
let board = [
  veh({ recon_id: 1, stock_number: "R-100", vehicle: "2016 Ford Fusion",
        quoted_cost: 380, actual_cost: 0, unreceived_cost: 380,
        unreceived_closed_cost: 380, unreceived_closed_parts: 1 }),
  veh({ recon_id: 2, stock_number: "R-200", vehicle: "2018 Kia Sorento",
        quoted_cost: 600, actual_cost: 600 }),
  veh({ recon_id: 3, stock_number: "R-300", vehicle: "2017 Hyundai Elantra",
        status: "in_progress", status_bucket: "in_progress", lot_bucket: "working",
        quoted_cost: 95, actual_cost: 0, unreceived_cost: 95,
        remaining_cost: 95, parts_pending: 1, parts_pending_value: 95 }),
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
ok(stats.cost === 600, `Cost card total drifted: ${stats.cost}`);
ok(stats.quoted === undefined, "boardStats is back to computing a quoted total");
// $380, not $475. The card counts the same closed-ticket money the row badge,
// the Lot Status sheet and the spend/profit sheets count. Adding R-300's open
// $95 in reported a part nobody has bought yet as money already gone -- and
// double-reported it, because the card next door already calls it "on order".
ok(stats.unreceived === 380,
  `only closed-ticket money is spent-and-uncounted; expected 380, got ${stats.unreceived}`);
ok(stats.unreceivedCars === 1, `expected 1 car carrying it, got ${stats.unreceivedCars}`);
ok(stats.unreceivedParts === 1, `expected 1 part, got ${stats.unreceivedParts}`);

const sub = $("#stat-cost-sub").textContent;
ok(sub.includes("$380.00") && /never marked received/i.test(sub),
  `the Cost card should name the unreceived money, got "${sub}"`);
ok(!sub.includes("$475.00"), `the Cost card is counting open-ticket parts again: "${sub}"`);
// The follow-up lives on the tooltip so the card stays one line.
const subTitle = $("#stat-cost-sub").title;
ok(/1 part on 1 car/.test(subTitle), `the tooltip should count parts and cars, got "${subTitle}"`);
ok(/Missing Receipts/.test(subTitle), `the tooltip should say where the list is, got "${subTitle}"`);
ok(!/var\(--good\)/.test($("#stat-cost-sub").style.color),
  "the Cost card is still painting this green");

/* ---------- the column band says it too ----------

   Columns is the default layout, so on most mornings the band under a column
   heading is the money figure people actually read. It prints the same three
   numbers as the Lot Report's group bands, in the same order and words. The
   third one used to be missing, and it mattered most in "Ready to go": those
   cars are finished, so they carry no "still to spend" and the band read
   "$600.00 spent" flat over a car whose cost is short by $380. */

const bandFor = (title) => [...doc.querySelectorAll(".veh-col")]
  .find((c) => c.querySelector(".veh-col-title").textContent === title)
  .querySelector("[data-col-money]");

const readyBand = bandFor("Ready to go");
ok(/\$600\.00 spent/.test(readyBand.textContent),
  `the finished pile should say what it spent, got "${readyBand.textContent}"`);
ok(/\$380\.00 never marked received/.test(readyBand.textContent),
  `the finished pile hides its shortfall: "${readyBand.textContent}"`);
ok(readyBand.querySelector(".cost-unreceipted"),
  "the shortfall has to be marked up as a correction, not read as another total");
ok(!/still to spend|left/.test(readyBand.textContent),
  `nothing more gets spent on a finished car: "${readyBand.textContent}"`);

const workingBand = bandFor("In the shop");
ok(/\$95\.00 left/.test(workingBand.textContent),
  `the working pile should say what is left, got "${workingBand.textContent}"`);
ok(!/never marked received/.test(workingBand.textContent),
  `an open ticket's parts are work ahead, not a shortfall: "${workingBand.textContent}"`);

// A pile whose only money is the shortfall still prints the spend it is short
// of. "$380.00 never marked received" on its own doesn't say short of what,
// and "$0.00 spent" beside it is the whole point.
board = [veh({ recon_id: 4, stock_number: "R-400", vehicle: "2014 Jeep Patriot",
               quoted_cost: 380, actual_cost: 0, unreceived_cost: 380,
               unreceived_closed_cost: 380, unreceived_closed_parts: 1 })];
await w.loadVehiclesView();
await settle();
ok(/^\$0\.00 spent · \$380\.00 never marked received$/.test(bandFor("Ready to go").textContent),
  `a pile that reads free needs both halves, got "${bandFor("Ready to go").textContent}"`);

/* ---------- a genuine saving still reads as one ---------- */

board = [veh({ recon_id: 9, stock_number: "R-900", vehicle: "2015 Chevrolet Malibu", quoted_cost: 500, actual_cost: 400 })];
await w.loadVehiclesView();
await settle();
// With nothing unreceived, the sub goes back to saying what the number is
// made of. Deliberately NOT "under the $500 quoted": the shop doesn't quote
// recon work, so there is no estimate for the total to be under.
ok($("#stat-cost-sub").textContent === "received parts + labor",
  `the Cost sub should state its composition, got "${$("#stat-cost-sub").textContent}"`);
ok(!$("#stat-cost-sub").title,
  "the warning's tooltip survived onto a board with nothing missing");
ok(!$("#stat-cost-sub").style.color.includes("--good"),
  "a real saving lost its green");

/* ---------- unreceived money still outranks the plain sub ---------- */

// Closed ticket, so both figures carry the $120 -- which is what the server
// sends for this car. A fixture that set only the all-tickets figure was
// describing a row the app cannot produce.
board = [veh({ recon_id: 10, stock_number: "R-910", vehicle: "2019 Toyota RAV4", quoted_cost: 500, actual_cost: 800,
               unreceived_cost: 120, unreceived_closed_cost: 120, unreceived_closed_parts: 2 })];
await w.loadVehiclesView();
await settle();
// No over-quote reading -- the shop doesn't quote recon work -- but money
// spent and never receipted is a fact about the total, so it still shows.
ok(/\$120\.00 spent but never marked received/.test($("#stat-cost-sub").textContent),
  `unreceipted spending should be named on the Cost card, got "${$("#stat-cost-sub").textContent}"`);
ok(/2 parts on 1 car/.test($("#stat-cost-sub").title),
  `the tooltip should pluralise, got "${$("#stat-cost-sub").title}"`);

/* ---------- a board of nothing but open tickets says nothing ----------

   The everyday case: everything is written up and ordered, nothing has landed
   yet. The Cost card used to shout about $700 of "not marked received" money
   for a lot where nobody had spent a cent and every part was already counted,
   correctly, on the Waiting on Parts card beside it. */

board = [
  veh({ recon_id: 11, stock_number: "R-911", vehicle: "2017 Hyundai Elantra",
        status: "in_progress", status_bucket: "in_progress",
        quoted_cost: 420, actual_cost: 0, unreceived_cost: 420,
        parts_pending: 2, parts_pending_value: 420 }),
  veh({ recon_id: 12, stock_number: "R-912", vehicle: "2020 Kia Soul",
        status: "estimate", status_bucket: "in_progress",
        quoted_cost: 280, actual_cost: 0, unreceived_cost: 280,
        parts_pending: 1, parts_pending_value: 280 }),
];
await w.loadVehiclesView();
await settle();
ok($("#stat-cost-sub").textContent === "received parts + labor",
  `open orders are not spending; got "${$("#stat-cost-sub").textContent}"`);
ok(/\$700\.00 on order/.test($("#stat-parts-waiting-sub").textContent),
  `that money belongs to Waiting on Parts, got "${$("#stat-parts-waiting-sub").textContent}"`);

ok(!rejections.length, `unhandled rejections: ${rejections.map((r) => r && r.message).join(", ")}`);
finish("unreceived parts");
