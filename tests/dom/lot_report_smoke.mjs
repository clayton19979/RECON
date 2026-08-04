// Lot Status report — the sheet the owner reads.
//
// This one is different from every other screen in the app: it leaves the
// building. Walt gets it as a PDF in his email, on his own, with nobody
// beside him to explain a heading or a column. So the things worth pinning
// aren't just "does it render" — they're the things that make it readable by
// somebody who wasn't there when it was generated:
//
//   * a specific car is findable (stock-number order, not dollar order)
//   * every section says in a sentence what being in it means
//   * a section with nothing in it says so instead of vanishing
//   * the money columns line up their decimal points
//   * no signature block, and the date said once
//
// The Python side (tests/test_lot_report.py) owns which pile a car belongs in
// and what its Needs sentence says. This owns the reading of it.

import { boot, click } from "./harness.mjs";

const car = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "estimate", status_bucket: "open",
  technicians: [], purchase_price: 0, quoted_cost: 0, actual_cost: 0, remaining_cost: 0,
  customer_paid: 0, net_cost: 0, parts_pending: 0, parts_pending_value: 0,
  idle_days: 0, age_days: 1, updated_at: "2026-07-01T09:00:00", lot_bucket: "working",
  needs: "work under way", ...over,
});

/* Two piles with cars in them and one deliberately empty.

   The two "In the shop" cars are the load-bearing pair: R-0044 is the cheaper
   and the fresher of the two, so stock order (R-0044 first) is the ONLY one of
   the three plausible orders that puts it first. Sorted by money or by how
   long it's sat, R-1002 would lead. */
const lot = [
  car({
    lot_bucket: "ready", recon_id: 3, stock_number: "R-0997", vehicle: "2016 Ford Fusion",
    status: "complete", status_bucket: "finished", actual_cost: 380, quoted_cost: 380,
    remaining_cost: 0, idle_days: 1, needs: "Nothing — ready to go",
  }),
  // The car whose money is wrong. Its ticket is closed, so nobody is going to
  // spend anything more on it -- and $95 of what was already spent was never
  // marked received, so every "spent" figure on this sheet is short by that
  // much until somebody clears it.
  car({
    lot_bucket: "ready", segment: "we_owe", we_owe_id: 5, vehicle: "2018 Honda Accord",
    customer_name: "Marcus Doyle", status: "fulfilled", status_bucket: "finished",
    actual_cost: 0, remaining_cost: 0, idle_days: 21,
    unreceived_closed_cost: 95, unreceived_closed_parts: 1,
    needs: "Ready to go — but 1 part never marked received ($95.00 not in the cost)",
  }),
  car({
    lot_bucket: "working", recon_id: 9, stock_number: "R-1002", vehicle: "2017 Hyundai Elantra",
    actual_cost: 900, quoted_cost: 900, remaining_cost: 0, idle_days: 30,
    needs: "Untouched 30 days",
  }),
  car({
    lot_bucket: "working", recon_id: 4, stock_number: "R-0044", vehicle: "2020 Kia Soul",
    actual_cost: 100, quoted_cost: 340, remaining_cost: 240, idle_days: 2, parts_pending: 1,
    parts_pending_value: 240, needs: "1 part on order ($240.00) · $240.00 of work left",
  }),
];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "loadReportsView", "sittingText", "reportCountText"],
  fetch: async (url) => {
    if (url.startsWith("/api/reports/lot")) return lot;
    if (url.startsWith("/api/reports/")) return [];
    return [];
  },
  // Land straight on the lot report rather than clicking through a spend
  // report first -- and with no saved prefs, which is what a fresh shop PC
  // looks like.
  beforeBoot: (win) => win.localStorage.setItem("dao-report-view", JSON.stringify({ type: "lot" })),
});

click(w, doc.querySelector('.rail-item[data-view="reports"]'));
await settle();
await settle();

const table = doc.querySelector("#report-output table");
ok(!!table, "the lot report rendered no table at all");

/* ---------- the columns ---------- */
const heads = [...doc.querySelectorAll("#report-output thead th")].map((h) => h.textContent.replace(/[▲▼]/g, "").trim());
ok(heads.length === 6, `expected 6 columns, got ${heads.length}: ${JSON.stringify(heads)}`);
for (const want of ["Stock #", "Vehicle", "Still Needs", "Spent So Far", "Still To Spend", "Sitting"]) {
  ok(heads.includes(want), `no "${want}" column — headers are ${JSON.stringify(heads)}`);
}
// The two columns that used to sit between Vehicle and Still Needs. The
// section heading is the status, in Walt's words; a raw ticket status beside
// it contradicted the heading as often as it agreed.
ok(!heads.includes("Type") && !heads.includes("Status"),
   `Type/Status are back as columns: ${JSON.stringify(heads)}`);

/* ---------- a specific car is where you'd look for it ---------- */
ok(doc.querySelector('#report-output th[data-report-sort="stock"]')?.classList.contains("sorted"),
   "the report didn't open sorted by Stock #");
const dataRows = [...doc.querySelectorAll("#report-output tbody tr:not(.lot-group-head)")];
const stockOf = (tr) => tr.children[0].textContent.trim();
ok(dataRows.length === 4, `expected 4 car rows, got ${dataRows.length}`);
const working = dataRows.filter((tr) => ["R-0044", "R-1002"].includes(stockOf(tr))).map(stockOf);
ok(JSON.stringify(working) === JSON.stringify(["R-0044", "R-1002"]),
   `In-the-shop cars are in ${JSON.stringify(working)} order — that's dollars or idle days, not stock number`);

/* ---------- each section explains itself, empty ones included ---------- */
const bands = [...doc.querySelectorAll("#report-output tr.lot-group-head")];
ok(bands.length === 3, `expected all 3 sections, got ${bands.length} — an empty pile disappeared`);
const bandText = bands.map((b) => b.textContent.replace(/\s+/g, " ").trim());
ok(bandText.some((t) => /Ready to go/.test(t) && /2 cars/.test(t) && /\$380\.00 spent/.test(t)),
   `Ready-to-sell band is wrong: ${JSON.stringify(bandText)}`);
ok(bandText.some((t) => /In the shop/.test(t) && /\$1,000\.00 spent/.test(t) && /\$240\.00 still to spend/.test(t)),
   `In-the-shop band doesn't carry its money: ${JSON.stringify(bandText)}`);
const emptyBand = bands.find((b) => b.classList.contains("is-empty"));
ok(!!emptyBand, "the empty section rendered as a normal band with no rows under it");
ok(/Every car has been started/.test(emptyBand?.textContent || ""),
   `empty section says "${emptyBand?.textContent.trim()}" instead of explaining itself`);

/* ---------- money already spent that this sheet doesn't count ----------
   "Spent so far" only counts parts somebody marked received, and on recon
   work receiving is the step that gets skipped. A sheet that answers "what
   did we spend on this car" with a number it knows is short, and says nothing,
   is the one thing this report cannot do. */
const spentCard = [...doc.querySelectorAll("#report-stats .stat")]
  .find((el) => /Spent On The Lot/i.test(el.querySelector(".stat-label").textContent));
ok(!!spentCard, "the lot report has no Spent On The Lot card");
const spentText = spentCard.textContent.replace(/\s+/g, " ");
ok(/\$1,380\.00/.test(spentText), `the headline spend is wrong: "${spentText.trim()}"`);
ok(/\$95\.00 spent but never marked received/.test(spentText),
   `the card doesn't say its own figure is short: "${spentText.trim()}"`);
ok(/\$240\.00 still to spend/.test(spentText),
   `money still ahead got lost when the correction went in: "${spentText.trim()}"`);
ok(spentCard.querySelector(".stat-value").classList.contains("warn"),
   "a spend figure that is knowably short isn't toned as a warning");

// The pile the money is missing from says so on its own band, so the reader
// doesn't have to carry the total down from the top of the sheet.
const readyBand = bandText.find((t) => /Ready to go/.test(t));
ok(/\$95\.00 never marked received/.test(readyBand || ""),
   `the Ready band doesn't flag its own shortfall: "${readyBand}"`);
ok(!/never marked received/.test(bandText.find((t) => /In the shop/.test(t)) || ""),
   "a pile with nothing missing is still printing a shortfall line");

// And the footer -- the number somebody writes down or reads out -- carries
// the correction on its own row, lined up under the column it corrects.
const correction = doc.querySelector("#report-output tfoot tr.lot-total-missing");
ok(!!correction, "the whole-lot total is short with nothing under it saying so");
const correctionText = correction.textContent.replace(/\s+/g, " ");
ok(/1 part on 1 finished car never marked received/.test(correctionText),
   `the correction row doesn't say what it's counting: "${correctionText.trim()}"`);
ok(/\$95\.00/.test(correctionText), `the correction row doesn't carry the money: "${correctionText.trim()}"`);
ok(correction.querySelector("td.cost-unreceipted"),
   "the correction's money isn't marked as the figure that's missing");
// The board's own per-car badge already owns .cost-missing, and it is styled
// display:block with a help cursor for a card, not a table cell. Borrowing
// the name here would have recoloured that badge and stretched these cells.
ok(!doc.querySelector("#report-output .cost-missing"),
   "the lot sheet is reusing the board badge's class instead of its own");

/* ---------- days read as days ---------- */
ok(w.sittingText(0) === "today", `sittingText(0) is "${w.sittingText(0)}"`);
ok(w.sittingText(1) === "1 day", `sittingText(1) is "${w.sittingText(1)}"`);
ok(w.sittingText(21) === "21 days", `sittingText(21) is "${w.sittingText(21)}"`);
const sittingCells = dataRows.map((tr) => tr.children[5].textContent.trim());
ok(!sittingCells.some((c) => /^\d+d$/.test(c)), `a Sitting cell still prints a code: ${JSON.stringify(sittingCells)}`);
ok(sittingCells.includes("21 days"), `expected "21 days" among ${JSON.stringify(sittingCells)}`);

/* ---------- "8 rows" is a database word ---------- */
ok(w.reportCountText(4, "lot") === "4 cars on the lot", `lot count reads "${w.reportCountText(4, "lot")}"`);
ok(w.reportCountText(1, "lot") === "1 car on the lot", `singular lot count reads "${w.reportCountText(1, "lot")}"`);
ok(w.reportCountText(4, "vehicle-spend") === "4 rows", "the spend report stopped counting rows");
ok(/4 cars on the lot/.test(doc.querySelector("#report-scope").textContent),
   `scope line reads "${doc.querySelector("#report-scope").textContent}"`);

/* ---------- the sheet that leaves the building ---------- */
const printed = doc.querySelector("#print-report");
const printText = printed.textContent.replace(/\s+/g, " ");

ok(!printed.querySelector(".print-sign"), "the report still has a sign-here block on it");
ok(!/Reviewed by/i.test(printText), "the printed report still says 'Reviewed by'");

// One timestamp, at the top. "Generated" underneath "As it stands" stamped
// the very same instant twice.
ok(!/Generated/.test(printText), "the printed lot report still carries a second 'Generated' stamp");
const stamps = printText.match(/As it stands/g) || [];
ok(stamps.length >= 1, "the printed report lost its date and time");

// Money that lines up. num-col right-aligns and turns on tabular figures;
// `num` is the identifier style and leaves $1,000.00 and $100.00 with their
// decimal points in different places.
const moneyCells = [...printed.querySelectorAll(".print-table.report tbody td")]
  .filter((td) => /^\$/.test(td.textContent.trim()));
ok(moneyCells.length > 0, "found no money cells on the printed sheet");
ok(moneyCells.every((td) => td.classList.contains("num-col")),
   `${moneyCells.filter((td) => !td.classList.contains("num-col")).length} money cell(s) print left-aligned in the identifier style`);

// Every section, its sentence, and its own subtotal.
ok(/Work on these is finished/.test(printText), "the Ready section lost its plain-English sentence");
ok(/These are in the shop now/.test(printText), "the In-the-shop section lost its sentence");
ok(/Every car has been started/.test(printText), "the empty section isn't on the printed sheet");
const foots = [...printed.querySelectorAll(".print-table.report tfoot")];
ok(foots.length === 2, `expected a subtotal under each of the 2 non-empty sections, got ${foots.length}`);
ok(/Spent on the whole lot/.test(printText) && /\$1,380\.00/.test(printText),
   "the whole-lot total is missing or wrong (380 + 1000)");

// Paper has no colour and nobody standing beside it, so the correction has to
// be a sentence -- under the pile's own subtotal and again in the totals
// block, before "still to spend", because it is money already gone.
ok(/Not in that total — 1 part on 1 car never marked received/.test(printText),
   "the printed section subtotal doesn't say what it's leaving out");
ok(/Spent but never marked received — not in the figure above/.test(printText),
   "the printed whole-lot total doesn't say it's short");
ok(/\$95\.00/.test(printText), "the printed sheet doesn't carry the missing money at all");
const noteRows = [...printed.querySelectorAll(".print-table.report tfoot tr.print-foot-note")];
ok(noteRows.length === 1,
   `expected the correction under exactly the one pile that's missing money, got ${noteRows.length}`);

ok(rejections.length === 0, `unhandled rejections: ${rejections.map((e) => e && e.message).join(", ")}`);

finish("lot report reads as a sheet somebody else can pick up");
