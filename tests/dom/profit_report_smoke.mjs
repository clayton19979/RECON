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

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("profit report: stock count excludes we-owe cars, sold count survives a missing purchase price");
