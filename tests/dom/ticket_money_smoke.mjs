// The ticket's money, on screen and on paper.
//
// A vehicle page shows the same car's cost twice: "This Ticket" in the main
// column, and "Vehicle Total — All Tickets" in the details drawer. The second
// comes from the server (cost_rollup); the first was worked out in the browser
// with its own arithmetic, and the two disagreed. A vendor credit -- stored
// positive, the way the vendor prints it -- was summed as an ordinary cost, so
// it pushed the ticket card UP by the size of the refund while pushing the
// board and the Lot Report down. The printed ticket did the same, on paper
// that gets handed to someone.
//
// One car, one ticket, one set of figures: this drives the real page and holds
// the two cards, the job subtotals, the live-typing totals and the printout to
// the same answer.

import { boot } from "./harness.mjs";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19);

// A completely ordinary recon ticket after a wrong part went back:
//   Windshield        1 x 180   ordered, not here yet
//   Alternator (wrong)1 x 500   received, then returned to the vendor
//   Alternator        1 x 520   received
//   Shop supplies     1 x  25   fee
//   Warranty credit   1 x  60   credit (subtracts)
//
// Quote  = 180 + 520 + 25 - 60  = 665   (the returned line is not money we'll spend)
// Actual = 520 + 25             = 545   (only what has landed; a credit counts for nothing)
const QUOTED = 665;
const ACTUAL = 545;

const items = [
  { id: 1, kind: "part", description: "Windshield", part_number: "WS-1", quantity: 1, unit_cost: 180,
    received_quantity: 0, status: "ordered", part_returned: false, core_charge: 0, job_id: 7 },
  { id: 2, kind: "part", description: "Alternator (wrong one)", part_number: "ALT-1", quantity: 1, unit_cost: 500,
    received_quantity: 1, status: "received", part_returned: true, core_charge: 0, job_id: 7 },
  { id: 3, kind: "part", description: "Alternator", part_number: "ALT-2", quantity: 1, unit_cost: 520,
    received_quantity: 1, status: "received", received_invoice_number: "INV-B", part_returned: false,
    core_charge: 0, job_id: 7 },
  { id: 4, kind: "fee", description: "Shop supplies", part_number: "", quantity: 1, unit_cost: 25,
    received_quantity: 0, status: "quoted", part_returned: false, core_charge: 0, job_id: null },
  { id: 5, kind: "credit", description: "Warranty credit, coil pack", part_number: "", quantity: 1, unit_cost: 60,
    received_quantity: 1, status: "received", part_returned: false, core_charge: 0, job_id: null },
];

// What the server says about the same car. Hard-coded rather than derived, so
// a browser-side rule that drifts away from cost_rollup fails here.
const vehicle = {
  id: 7, stock_number: "R-7788", year: 2018, make: "Honda", model: "Accord", vin: "1HGCV1F34JA123456",
  mileage: 52300, trim: "", engine: "", color: "", purchase_price: 4200, sale_price: null,
  status: "in_repair", archived_at: "", edit_version: 3, created_at: daysAgo(30),
  updated_at: daysAgo(0), orders: [], total_cost: ACTUAL, quoted_cost: QUOTED, labor_hours: 0, profit: null,
  last_activity: { at: daysAgo(1), idle_days: 1, action: "parts_received", actor: "Dana Ruiz" },
};

const order = {
  id: 42, number: "RO-1042", concern: "Front end recon prep", status: "in_progress", voided: 0,
  segment: "recon", recon_vehicle_id: 7, we_owe_id: null, created_at: daysAgo(20),
  estimate: { id: 1, edit_version: 1, items, jobs: [{ id: 7, title: "Front end", technician_id: null }] },
  notes: [], activity: [], assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
};

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "renderPrintTicket", "updateEstimateTotalsFromDom"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) return [];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/staff")) return [{ id: 3, name: "Dana Ruiz", role: "technician", active: 1 }];
    return [];
  },
});

await settle();
await w.openVehicleDetail("recon", 7);
await settle();

const text = (sel) => (doc.querySelector(sel)?.textContent || "").trim();

/* ---------- the two cards on the page have to agree ---------- */
ok(text("#vd-quoted-cost") === "$665.00", `This Ticket quote reads ${text("#vd-quoted-cost")}, expected $665.00`);
ok(text("#vd-actual-cost") === "$545.00", `This Ticket actual reads ${text("#vd-actual-cost")}, expected $545.00`);

const vehicleTotals = doc.querySelector("#vd-cost-summary").textContent;
ok(vehicleTotals.includes("$665.00"), `Vehicle Total quote disagrees with the ticket: ${vehicleTotals}`);
ok(vehicleTotals.includes("$545.00"), `Vehicle Total actual disagrees with the ticket: ${vehicleTotals}`);

/* ---------- the over/under badge reads off those same two ---------- */
const delta = doc.querySelector("#vd-cost-delta");
ok(delta && !delta.hidden, "the over/under-quote badge isn't showing on a ticket that has a quote");
ok(text("#vd-cost-delta") === "$120.00 under quote",
   `badge reads "${text("#vd-cost-delta")}", expected "$120.00 under quote" (665 - 545)`);

/* ---------- every line the totals were built from is on screen ----------
   This ticket is grouped into jobs, and the grouped layout used to render only
   Parts, Labor and Fees. A vendor credit was subtracted from the total with no
   row anywhere to say where the money went. */
const gridRows = [...doc.querySelectorAll(".part-row:not(.head)")];
ok(gridRows.length === items.length,
   `${gridRows.length} rows on screen for ${items.length} lines -- something isn't being shown`);
const creditGridRow = gridRows.find((r) => r.dataset.id === "5");
ok(!!creditGridRow, "the vendor credit line has no row in the grid");
ok(creditGridRow?.querySelector(".ei-kind")?.value === "credit",
   "the credit row's kind isn't 'credit' -- the next autosave would resend it as something else");
ok(doc.querySelector('.kind-subgroup[data-kind="credit"]')?.textContent.includes("Credits"),
   "the credit lines have no 'Credits' heading");

/* ---------- job subtotals still add up to the ticket ---------- */
const subtotals = [...doc.querySelectorAll(".job-group-subtotal")].map((el) => el.textContent.trim());
ok(subtotals.includes("$700.00"), `Front end job subtotal missing from ${JSON.stringify(subtotals)} (180 + 520)`);
ok(subtotals.includes("-$35.00"), `General subtotal missing from ${JSON.stringify(subtotals)} (25 fee - 60 credit)`);

/* ---------- typing in the grid uses the same rule as the saved ticket ----------
   The live path reads the inputs rather than state, and used to be a second
   copy of the arithmetic. Nudging a quantity and putting it straight back has
   to leave every figure where it was. */
const qtyInput = doc.querySelector('.part-row[data-id="1"] .ei-qty');
ok(!!qtyInput, "no quantity input on the windshield row");
if (qtyInput) {
  qtyInput.value = "2";
  w.updateEstimateTotalsFromDom();
  ok(text("#vd-quoted-cost") === "$845.00",
     `typing a second windshield gave ${text("#vd-quoted-cost")}, expected $845.00 (665 + 180)`);
  qtyInput.value = "1";
  w.updateEstimateTotalsFromDom();
  ok(text("#vd-quoted-cost") === "$665.00",
     `putting the quantity back gave ${text("#vd-quoted-cost")}, expected $665.00`);
  ok(text("#vd-actual-cost") === "$545.00",
     `live actual reads ${text("#vd-actual-cost")}, expected $545.00`);
}

/* ---------- and so does the paper ---------- */
w.renderPrintTicket();
const printed = doc.querySelector("#print-report");
const printedText = printed.textContent;
ok(printedText.includes("Total Quote") && printedText.includes("$665.00"),
   "the printed ticket's Total Quote doesn't match the screen");
ok(printedText.includes("$545.00"), "the printed ticket's Actual Cost doesn't match the screen");

const printedRows = [...printed.querySelectorAll("table.ticket tbody tr")];
const creditRow = printedRows.find((r) => r.textContent.includes("Warranty credit"));
ok(!!creditRow, "the credit line isn't on the printed ticket at all");
if (creditRow) {
  const cells = [...creditRow.querySelectorAll("td")].map((td) => td.textContent.trim());
  ok(cells.includes("-$60.00"), `credit prints as ${JSON.stringify(cells)} -- a refund has to read negative`);
}
const returnedRow = printedRows.find((r) => r.textContent.includes("Alternator (wrong one)"));
ok(!!returnedRow && returnedRow.textContent.includes("Returned"), "the returned part lost its Returned status");
if (returnedRow) {
  const cells = [...returnedRow.querySelectorAll("td")].map((td) => td.textContent.trim());
  ok(!cells.includes("$500.00"), `a returned part still prints its cost: ${JSON.stringify(cells)}`);
}

ok(rejections.length === 0, `unhandled rejections: ${rejections.map((e) => e && e.message).join(", ")}`);

finish("ticket money agrees on screen and on paper");
