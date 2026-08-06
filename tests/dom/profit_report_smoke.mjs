// Profit report smoke test.
//
// The Profit report is the one Walt reads to ask "what did we spend on that
// car, and what did it make". Its four summary cards, its table footer and its
// printed copy are three separate pieces of arithmetic over the same rows, and
// nothing but a real DOM checks that they agree.
//
// Things they used to get wrong, all of which put a number in front of the
// owner that wasn't true:
//   - "still in stock" counted every row, including we-owe cars, which belong
//     to the customer who already bought and drove them away.
//   - "N sold" in the footer counted cars whose profit could be worked out,
//     not cars that sold -- so a car sold with no purchase price on file was
//     missing from the count, and the footer disagreed with the card above it.
//   - the second card was captioned "what the shop spent: recon + we-owe" and
//     showed the sum of Total In, which carries the lot's purchase price on
//     any car that still has one. On the seeded lot it read $15,770 for a shop
//     that had spent $370. What the lot paid is not this app's record to keep
//     (CLAUDE.md), so the card now shows the shop's own spend and the columns
//     that need a purchase price say so when they haven't got one.
//
// reports_smoke.mjs covers the screen's plumbing (ranges, sorting, prefs) on
// the spend and technician shapes; this one covers the profit shape's numbers.

import { boot, click } from "./harness.mjs";

const car = (over) => ({
  stock_number: "", vehicle: "", vin: "", labor_hours: 0, purchase_price: 0,
  recon_cost: 0, we_owe_cost: 0, we_owe_customer_paid: 0, we_owe_net_cost: 0,
  total_invested: 0, sale_price: null, sale_date: null, profit: null,
  margin_pct: null, recon_count: 1, we_owe_count: 0, acquired_at: "2026-07-01T09:00:00", ...over,
});

// Three of the lot's own cars and one we-owe:
//   R-1  sold, purchase price on file  -> 8000 - 5000 - 800 = 2200 profit
//   R-2  sold, no purchase price       -> sold, but no honest profit
//   R-3  still on the lot
//   the Camry: a customer's car the shop owes work on, 300 net
// So: 2 sold, 1 still in stock, 1 we-owe -- and the three add up to 4 rows.
const profit = [
  car({ stock_number: "R-1", vehicle: "2019 Ford F-150", vin: "1FTEW1EG5GKE12345", labor_hours: 3,
        purchase_price: 5000, recon_cost: 800, total_invested: 5800, sale_price: 8000,
        profit: 2200, margin_pct: 27.5 }),
  car({ stock_number: "R-2", vehicle: "2021 Honda Civic", vin: "2HGFC2F59MH000111",
        purchase_price: 0, recon_cost: 700, total_invested: 700, sale_price: 6000 }),
  car({ stock_number: "R-3", vehicle: "2015 Chevy Malibu", vin: "1G11C5SL2FF123456",
        purchase_price: 0, recon_cost: 0, total_invested: 0 }),
  car({ vehicle: "2017 Toyota Camry", vin: "4T1BF1FK5HU123456", recon_count: 0, we_owe_count: 1,
        we_owe_cost: 300, we_owe_net_cost: 300, total_invested: 300 }),
];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "loadReportsView"],
  fetch: async (url) => {
    if (url.startsWith("/api/reports/vehicle-profit")) return profit;
    return [];
  },
});

const stats = () => [...doc.querySelectorAll("#report-stats .stat")].map((s) => ({
  label: s.querySelector(".stat-label").textContent,
  value: s.querySelector(".stat-value").textContent,
  sub: s.querySelector(".stat-sub").textContent,
}));

click(w, doc.querySelector('.rail-item[data-view="reports"]'));
await settle();
click(w, doc.querySelector('[data-report-type="vehicle-profit"]'));
await settle();

const rows = [...doc.querySelectorAll("#report-output tbody tr")];
ok(rows.length === 4, `expected 4 rows on the profit report, got ${rows.length}`);

/* ---------- the count above the table ---------- */
const s = stats();
ok(s.length === 4, `expected 4 summary cards, got ${s.length}`);
ok(s[0].value === "4", `Vehicles card reads ${s[0].value}, expected 4 -- the row count`);
ok(s[0].sub === "2 sold · 1 still in stock · 1 we-owe",
   `stock split reads "${s[0].sub}"; a we-owe car is the customer's, not stock on hand`);

/* ---------- what the shop spent, which is not what the lot paid ----------
   800 + 700 + 0 recon and 300 of we-owe. The $5,000 the lot paid for R-1 is
   Walt's number, not the shop's, and must not be anywhere in this figure. */
ok(s[1].label === "Spent Fixing Them",
   `the second card is labelled "${s[1].label}" -- it reports the shop's own spend`);
ok(s[1].value === "$1,800.00",
   `Spent Fixing Them reads ${s[1].value}, expected $1,800.00 (800 + 700 + 300 recon and we-owe)`);
ok(!s[1].value.includes("6,800"),
   "the card is still summing Total In, which carries the lot's purchase price");
ok(s[1].sub.includes("not what the lot paid"),
   `the card doesn't say what it is deliberately leaving out: "${s[1].sub}"`);

ok(s[2].value === "$2,200.00", `Profit On Sold reads ${s[2].value}, expected $2,200.00`);
ok(s[2].sub.includes("1 without a purchase price"),
   `the card doesn't own up to the sold car it can't price: "${s[2].sub}"`);
ok(s[3].value === "$300.00", `We-Owe Cost reads ${s[3].value}, expected $300.00`);

/* ---------- a column that means one thing on every row ----------
   Three of the four cars have no purchase price on file. A zero there would
   read as "this car was free"; a Total In built on a zero would read as the
   whole of what the lot has in it. Both are dashes, and the footer totals of
   those two columns cover only the car that has the figure. */
const cells = (tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
const byStock = Object.fromEntries(rows.map((tr) => [cells(tr)[0], cells(tr)]));
ok(byStock["R-1"][4] === "$800.00", `R-1's Spent reads ${byStock["R-1"][4]}, expected $800.00`);
ok(byStock["R-1"][5] === "$5,000.00", `R-1's Purchase reads ${byStock["R-1"][5]}`);
ok(byStock["R-1"][6] === "$5,800.00", `R-1's Total In reads ${byStock["R-1"][6]}`);
ok(byStock["R-2"][4] === "$700.00", `R-2's Spent reads ${byStock["R-2"][4]}, expected $700.00`);
ok(byStock["R-2"][5] === "—",
   `R-2 has no purchase price on file but its Purchase cell reads ${byStock["R-2"][5]} -- a zero there reads as a free car`);
ok(byStock["R-2"][6] === "—",
   `R-2's Total In reads ${byStock["R-2"][6]} -- without a purchase price that column can only show the spend, which is the column beside it`);

/* ---------- the footer under it ---------- */
const foot = doc.querySelector("#report-output tfoot").textContent;
ok(foot.includes("4 vehicles, 2 sold"),
   `footer reads "${foot.trim().split("\n")[0]}" -- a car sold without a purchase price still sold`);
ok(foot.includes("$1,800.00"), `footer spend doesn't match the card: "${foot}"`);
ok(foot.includes("$5,000.00") && foot.includes("$5,800.00"),
   `the Purchase and Total In totals should cover the one priced car: "${foot}"`);
ok(!foot.includes("$6,800.00"),
   `the footer is still totalling Total In across cars that have no purchase price: "${foot}"`);
const note = doc.querySelector("#report-output tfoot tr.total-note");
ok(note && note.textContent.includes("1 of 4 cars"),
   `the footer doesn't say how many cars its Purchase total covers: "${note ? note.textContent.trim() : "no note row"}"`);

/* ---------- and the printed copy ---------- */
const print = doc.querySelector("#print-report").textContent;
ok(print.includes("4 vehicles, 2 sold"), `the printed footer disagrees with the screen: "${print.slice(-200)}"`);
ok(print.includes("R-1") && print.includes("2017 Toyota Camry"), "the printed copy is missing rows");
ok(print.includes("1 of 4 cars"),
   "the printed sheet drops the line saying which cars its Purchase total covers -- it is read away from the app");

/* ---------- profit the lot never made ----------
   A part bought at the counter, thrown on the car and never marked received
   is money that is in no cost figure -- and on this sheet a shortfall in cost
   comes out the other end as profit. R-1 sold for $8,000 against $5,800 in,
   reading $2,200 of margin; if $300 of that recon was never receipted, $300
   of the margin is imaginary. This is the only number on any screen in the
   app that is not merely incomplete but wrong in a flattering direction, so
   the card says so instead of the margin rather than after it. */
profit[0].unreceived_closed_cost = 300;
profit[0].unreceived_closed_parts = 2;
// ...and one on an unsold car, which understates what is in that car without
// touching any profit figure. It belongs in the spend figure and nowhere else.
profit[2].unreceived_closed_cost = 45;
profit[2].unreceived_closed_parts = 1;
await w.loadReportsView();
await settle();

const m = stats();
ok(m[1].value === "$1,800.00", `Spent Fixing Them moved: ${m[1].value} -- what landed is still what landed`);
ok(m[1].sub.includes("$345.00") && m[1].sub.includes("never marked received"),
   `the spend card doesn't say what it is short by: "${m[1].sub}"`);
ok(m[2].value === "$2,200.00", `Profit On Sold moved: ${m[2].value}`);
ok(m[2].sub.includes("overstated by $300.00"),
   `the profit card doesn't own up to the margin it never made: "${m[2].sub}"`);
ok(!m[2].sub.includes("margin on"),
   `the margin percentage is still in front of the correction: "${m[2].sub}" -- it is what stops the correction being read`);
ok(m[2].sub.includes("$300.00") && !m[2].sub.includes("$345.00"),
   `the profit card counted an unsold car's shortfall as overstated margin: "${m[2].sub}"`);

// Per car, under Spent -- the column the money is missing from. Not Total In:
// on a car with no purchase price that cell is a dash with nothing to correct,
// and the shortfall is in the spend either way.
const flagged = [...doc.querySelectorAll("#report-output tbody .cost-missing")];
ok(flagged.length === 2, `expected 2 flagged rows, got ${flagged.length}`);
ok(flagged[0].closest("td").textContent.includes("$800.00"),
   "the shortfall badge isn't under the Spent figure it corrects");

const footRow = doc.querySelector("#report-output tfoot tr.total-missing");
ok(footRow, "the profit sheet's footer carries no correction row");
ok(footRow.textContent.includes("3 parts on 2 cars") && footRow.textContent.includes("$345.00"),
   `the correction row reads "${footRow.textContent.trim()}"`);
const heads = [...doc.querySelectorAll("#report-output thead th")];
const spentCol = heads.findIndex((h) => h.dataset.reportSort === "spent");
const before = [...footRow.children]
  .slice(0, [...footRow.children].indexOf(footRow.querySelector(".cost-unreceipted")))
  .reduce((n, td) => n + (Number(td.getAttribute("colspan")) || 1), 0);
ok(before === spentCol,
   `the correction figure sits in column ${before}, but Spent is column ${spentCol}`);

// The printed copy is what gets emailed out as a PDF, so it has to carry the
// same sentence -- there is no colour on the printer and nobody beside it.
const printedProfit = doc.querySelector("#print-report").textContent;
ok(printedProfit.includes("never marked received") && printedProfit.includes("$345.00"),
   "the printed profit sheet drops the correction the screen carries");

/* ---------- the lot as it will actually look ----------
   Purchase price has no entry field any more, so every car written down from
   here on has none. Eventually that is the whole sheet, and it has to keep
   reading as "we don't hold that figure" rather than as a lot of free cars
   that broke even. What the shop spent is unaffected -- it always is, which is
   the point of keeping the two apart. */
profit.forEach((r) => { r.purchase_price = 0; r.profit = null; r.margin_pct = null; });
await w.loadReportsView();
await settle();

const bare = stats();
ok(bare[1].value === "$1,800.00",
   `losing every purchase price moved the spend figure to ${bare[1].value} -- it never depended on one`);
ok(bare[2].value === "—", `Profit On Sold reads ${bare[2].value} with nothing priced; expected a dash`);
const bareFoot = doc.querySelector("#report-output tfoot").textContent;
ok(!bareFoot.includes("$0.00"),
   `the footer is reporting a zero it can't stand behind: "${bareFoot.replace(/\s+/g, " ").trim()}"`);
ok(bareFoot.includes("No purchase price on file for any of these 4 cars"),
   `the footer doesn't explain its dashes: "${bareFoot.replace(/\s+/g, " ").trim()}"`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("profit report: the spend card reports what the shop spent and not what the lot paid, "
  + "Purchase and Total In dash out and total only where a purchase price is on file, "
  + "stock count excludes we-owe cars, sold count survives a missing purchase price, "
  + "margin owns up to unreceipted parts");
