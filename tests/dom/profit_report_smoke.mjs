// Profit report smoke test.
//
// The Profit report is the one Walt reads to ask "what did we spend on that
// car, and what did it make". Its four summary cards, its table footer and its
// printed copy are three separate pieces of arithmetic over the same rows, and
// nothing but a real DOM checks that they agree.
//
// Two things they used to get wrong, both of which put a number in front of
// the owner that wasn't true:
//   - "still in stock" counted every row, including we-owe cars, which belong
//     to the customer who already bought and drove them away.
//   - "N sold" in the footer counted cars whose profit could be worked out,
//     not cars that sold -- so a car sold with no purchase price on file was
//     missing from the count, and the footer disagreed with the card above it.
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

ok(s[1].value === "$6,800.00", `Total Invested reads ${s[1].value}, expected $6,800.00`);
ok(s[2].value === "$2,200.00", `Profit On Sold reads ${s[2].value}, expected $2,200.00`);
ok(s[2].sub.includes("1 without a purchase price"),
   `the card doesn't own up to the sold car it can't price: "${s[2].sub}"`);
ok(s[3].value === "$300.00", `We-Owe Cost reads ${s[3].value}, expected $300.00`);

/* ---------- the footer under it ---------- */
const foot = doc.querySelector("#report-output tfoot").textContent;
ok(foot.includes("4 vehicles, 2 sold"),
   `footer reads "${foot.trim().split("\n")[0]}" -- a car sold without a purchase price still sold`);
ok(foot.includes("$6,800.00"), `footer total invested doesn't match the card: "${foot}"`);

/* ---------- and the printed copy ---------- */
const print = doc.querySelector("#print-report").textContent;
ok(print.includes("4 vehicles, 2 sold"), `the printed footer disagrees with the screen: "${print.slice(-200)}"`);
ok(print.includes("R-1") && print.includes("2017 Toyota Camry"), "the printed copy is missing rows");

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
// touching any profit figure. It belongs in Total Invested and nowhere else.
profit[2].unreceived_closed_cost = 45;
profit[2].unreceived_closed_parts = 1;
await w.loadReportsView();
await settle();

const m = stats();
ok(m[1].value === "$6,800.00", `Total Invested moved: ${m[1].value} -- what landed is still what landed`);
ok(m[1].sub.includes("$345.00") && m[1].sub.includes("never marked received"),
   `Total Invested doesn't say what it is short by: "${m[1].sub}"`);
ok(m[2].value === "$2,200.00", `Profit On Sold moved: ${m[2].value}`);
ok(m[2].sub.includes("overstated by $300.00"),
   `the profit card doesn't own up to the margin it never made: "${m[2].sub}"`);
ok(!m[2].sub.includes("margin on"),
   `the margin percentage is still in front of the correction: "${m[2].sub}" -- it is what stops the correction being read`);
ok(m[2].sub.includes("$300.00") && !m[2].sub.includes("$345.00"),
   `the profit card counted an unsold car's shortfall as overstated margin: "${m[2].sub}"`);

// Per car, under Total In -- the column the money is missing from.
const flagged = [...doc.querySelectorAll("#report-output tbody .cost-missing")];
ok(flagged.length === 2, `expected 2 flagged rows, got ${flagged.length}`);
ok(flagged[0].closest("td").textContent.includes("$5,800.00"),
   "the shortfall badge isn't under the Total In figure it corrects");

const footRow = doc.querySelector("#report-output tfoot tr.total-missing");
ok(footRow, "the profit sheet's footer carries no correction row");
ok(footRow.textContent.includes("3 parts on 2 cars") && footRow.textContent.includes("$345.00"),
   `the correction row reads "${footRow.textContent.trim()}"`);
const heads = [...doc.querySelectorAll("#report-output thead th")];
const investedCol = heads.findIndex((h) => h.dataset.reportSort === "cost");
const before = [...footRow.children]
  .slice(0, [...footRow.children].indexOf(footRow.querySelector(".cost-unreceipted")))
  .reduce((n, td) => n + (Number(td.getAttribute("colspan")) || 1), 0);
ok(before === investedCol,
   `the correction figure sits in column ${before}, but Total In is column ${investedCol}`);

// The printed copy is what gets emailed out as a PDF, so it has to carry the
// same sentence -- there is no colour on the printer and nobody beside it.
const printedProfit = doc.querySelector("#print-report").textContent;
ok(printedProfit.includes("never marked received") && printedProfit.includes("$345.00"),
   "the printed profit sheet drops the correction the screen carries");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("profit report: stock count excludes we-owe cars, sold count survives a missing purchase price, margin owns up to unreceipted parts");
