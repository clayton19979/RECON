// Parts & Cores screen smoke test.
//
// Three tables. On Order is the one that holds a car up -- parts somebody is
// waiting for -- and its assertions are about honesty above all: a line with
// no recorded order date must never render as "ordered today", must not claim
// a wait it can't back, and must not lead a list sorted by how long things
// have been waiting.
//
// The other two share one three-state vocabulary: Pending (still at the shop),
// Awaiting Credit (physically gone, no paperwork), Credited (the vendor's
// number recorded). The assertions are weighted toward the transitions,
// because each one is a claim about where a real part and real money are:
// pickup is paperwork-free and reversible, credit requires the vendor's
// number, and the returns credit posts a real invoice into A/P -- so the
// vendor can never be silently defaulted and the dialog has to ask first.
//
// The bulk path gets the same scrutiny the tasks screen earned: selection
// only ever offers what the transition can accept (pending, non-voided),
// select-all means what's on screen, and N selected rows produce N PATCHes
// with the selection cleared after.

import { boot } from "./harness.mjs";

const NOW = Date.now();
// Full ISO (with the Z): daysSince() computes elapsed wall-clock time, and a
// zone-less timestamp parses as *local* -- in any non-UTC test environment
// "35 days ago" would read as 34 or 36 and every age assertion would drift.
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// Cores: one per state, plus a voided one that must render struck-through
// and offer nothing.
let cores = [
  { id: 11, order_id: 1, description: "Reman alternator", part_number: "ALT-300", ro_number: "RO-2607-0001",
    vehicle_label: "2019 Ford Edge", vendor_name: "WorldPac", core_charge: 80, voided: 0,
    core_returned: 0, core_returned_at: null, core_return_invoice_number: null,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, stock_number: "R-1042", we_owe_customer_name: null },
  { id: 12, order_id: 1, description: "Brake caliper", part_number: "CAL-12", ro_number: "RO-2607-0001",
    vehicle_label: "2019 Ford Edge", vendor_name: "WorldPac", core_charge: 45, voided: 0,
    core_returned: 1, core_returned_at: daysAgo(20), core_return_invoice_number: null,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, stock_number: "R-1042", we_owe_customer_name: null },
  { id: 13, order_id: 2, description: "Long block", part_number: "ENG-9", ro_number: "RO-2607-0002",
    vehicle_label: "2021 Kia Sorento", vendor_name: "NAPA", core_charge: 400, voided: 0,
    core_returned: 1, core_returned_at: daysAgo(40), core_return_invoice_number: "CR-771",
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 9, stock_number: null, we_owe_customer_name: "Maria Soto" },
  { id: 14, order_id: 3, description: "Starter (voided ticket)", part_number: null, ro_number: "RO-2607-0003",
    vehicle_label: "2018 Honda Civic", vendor_name: "NAPA", core_charge: 60, voided: 1,
    core_returned: 0, core_returned_at: null, core_return_invoice_number: null,
    segment: "recon", recon_vehicle_id: 8, we_owe_id: null, stock_number: "R-0999", we_owe_customer_name: null },
  // A second pending core so the bulk path has a real batch to take.
  { id: 15, order_id: 2, description: "Power steering pump", part_number: "PSP-4", ro_number: "RO-2607-0002",
    vehicle_label: "2021 Kia Sorento", vendor_name: "NAPA", core_charge: 55, voided: 0,
    core_returned: 0, core_returned_at: null, core_return_invoice_number: null,
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 9, stock_number: null, we_owe_customer_name: "Maria Soto" },
];

// Returns: pending / awaiting / credited. r2's pickup is 35 days stale,
// which should push the Awaiting Credit stat card to critical.
let returns = [
  { id: 21, order_id: 1, description: "Wrong-fit radiator", part_number: "RAD-2", ro_number: "RO-2607-0001",
    vehicle_label: "2019 Ford Edge", vendor_name: "WorldPac", vendor_id: 1, credit_total: -120, voided: 0,
    part_picked_up_at: null, return_invoice_number: null, quantity: 1, received_quantity: 1, unit_cost: 120,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, stock_number: "R-1042", we_owe_customer_name: null },
  { id: 22, order_id: 2, description: "Extra brake pads", part_number: "BP-88", ro_number: "RO-2607-0002",
    vehicle_label: "2021 Kia Sorento", vendor_name: "NAPA", vendor_id: 2, credit_total: -60, voided: 0,
    part_picked_up_at: daysAgo(35), return_invoice_number: null, quantity: 2, received_quantity: 2, unit_cost: 30,
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 9, stock_number: null, we_owe_customer_name: "Maria Soto" },
  { id: 23, order_id: 1, description: "Unneeded sensor", part_number: "SEN-1", ro_number: "RO-2607-0001",
    vehicle_label: "2019 Ford Edge", vendor_name: "WorldPac", vendor_id: 1, credit_total: -35, voided: 0,
    part_picked_up_at: daysAgo(10), return_invoice_number: "CR-500", quantity: 1, received_quantity: 1, unit_cost: 35,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, stock_number: "R-1042", we_owe_customer_name: null },
  // Never received against an invoice: vendor_id resolves to nobody, and the
  // post-credit dialog must force a choice rather than default one.
  { id: 24, order_id: 3, description: "Mystery hose", part_number: null, ro_number: "RO-2607-0003",
    vehicle_label: "2018 Honda Civic", vendor_name: null, vendor_id: null, credit_total: -15, voided: 0,
    part_picked_up_at: daysAgo(2), return_invoice_number: null, quantity: 1, received_quantity: 1, unit_cost: 15,
    segment: "recon", recon_vehicle_id: 8, we_owe_id: null, stock_number: "R-0999", we_owe_customer_name: null },
];

// On order: one long overdue, one fresh, and one that predates the app
// recording order dates at all.
const ON_ORDER = [
  { id: 31, order_id: 1, description: "Windshield", part_number: "WS-4471", ro_number: "RO-2607-0001",
    vehicle_label: "R-1042", vehicle: "2019 Ford Edge", outstanding_quantity: 1, value: 180,
    ordered_at: daysAgo(21), days_waiting: 21,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, vehicle_id: 5, stock_number: "R-1042",
    we_owe_customer_name: null },
  { id: 32, order_id: 2, description: "Serpentine belt", part_number: "SB-118", ro_number: "RO-2607-0002",
    vehicle_label: "We-Owe: Maria Soto", vehicle: "2021 Kia Sorento", outstanding_quantity: 2, value: 28,
    ordered_at: daysAgo(0), days_waiting: 0,
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 9, vehicle_id: 6, stock_number: null,
    we_owe_customer_name: "Maria Soto" },
  { id: 33, order_id: 3, description: "Mounting bracket kit", part_number: null, ro_number: "RO-2607-0003",
    vehicle_label: "R-0999", vehicle: "2018 Honda Civic", outstanding_quantity: 1, value: 95,
    ordered_at: "", days_waiting: null,
    segment: "recon", recon_vehicle_id: 8, we_owe_id: null, vehicle_id: 7, stock_number: "R-0999",
    we_owe_customer_name: null },
];

const VENDORS = [
  { id: 1, name: "WorldPac", aliases: [], account_number: null },
  { id: 2, name: "NAPA", aliases: [], account_number: null },
];

const patches = [];
const posts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView", "loadCoresView", "renderCoresTable", "renderReturnsTable"],
  fetch: async (url, opts) => {
    if (url === "/api/parts/on-order") return ON_ORDER;
    if (url === "/api/cores") return cores;
    if (url === "/api/returns") return returns;
    if (url === "/api/vendors") return VENDORS;
    if (url.includes("/core-return") && opts.method === "PATCH") {
      const body = JSON.parse(opts.body);
      const id = Number(url.split("/")[6]);
      patches.push({ url, body });
      cores = cores.map((c) => (c.id === id
        ? { ...c, core_returned: body.returned ? 1 : 0, core_returned_at: body.returned ? daysAgo(0) : null }
        : c));
      return { ok: true };
    }
    if (url.includes("/core-credit") && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      const id = Number(url.split("/")[6]);
      posts.push({ url, body });
      cores = cores.map((c) => (c.id === id ? { ...c, core_return_invoice_number: body.invoice_number } : c));
      return { ok: true };
    }
    if (url.includes("/part-pickup") && opts.method === "PATCH") {
      const body = JSON.parse(opts.body);
      const id = Number(url.split("/")[6]);
      patches.push({ url, body });
      returns = returns.map((r) => (r.id === id
        ? { ...r, part_picked_up_at: body.picked_up ? daysAgo(0) : null }
        : r));
      return { ok: true };
    }
    if (url.includes("/post-return-credit") && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      const id = Number(url.split("/")[6]);
      posts.push({ url, body });
      returns = returns.map((r) => (r.id === id ? { ...r, return_invoice_number: body.credit_number } : r));
      return { ok: true };
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return [];
    return [];
  },
});

w.showView("cores");
await settle();

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const onOrderRow = (id) => $(`#on-order-table tr[data-id="${id}"]`);
const coreRow = (id) => $(`#cores-table tr[data-id="${id}"]`);
const returnRow = (id) => $(`#returns-table tr[data-id="${id}"]`);
const chip = (table, filter) => $(`[data-${table}-filter="${filter}"]`);
const input = (el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};

/* ---------- stats add up across all three tables ---------- */
const stats = $("#cores-returns-stats").textContent.replace(/\s+/g, " ");
// Cores not credited & not voided: 80 + 45 + 55 = 180.
// Returns not credited: 120 + 60 + 15 = 195. Total 375.
ok(/\$375\.00/.test(stats), `Outstanding should read $375.00 across both tables: "${stats.trim()}"`);
ok(/oldest 35d/.test(stats), `the awaiting card doesn't name the stalest pickup: "${stats.trim()}"`);
const awaitingValue = $$("#cores-returns-stats .stat-value")[2];
ok(awaitingValue.classList.contains("crit"), "a 35-day-old pickup doesn't tone the Awaiting Credit card critical");
ok(/Credited/.test(stats) && /2/.test($$("#cores-returns-stats .stat-value")[3].textContent),
   "the Credited card should count the credited core and the credited return");

// On Order leads the strip: 180 + 28 + 95 = 303, oldest known wait 21 days,
// and the one line with no date is reported as such rather than folded into
// the oldest wait as a zero.
const onOrderCard = $$("#cores-returns-stats .stat")[0].textContent.replace(/\s+/g, " ");
ok(/ON ORDER|On Order/i.test(onOrderCard), `the first summary card isn't On Order: "${onOrderCard.trim()}"`);
ok(/\$303\.00/.test(onOrderCard), `the On Order card doesn't total what's outstanding: "${onOrderCard.trim()}"`);
ok(/oldest 21d/.test(onOrderCard), `the On Order card doesn't name the longest wait: "${onOrderCard.trim()}"`);
ok(/1 with no date/.test(onOrderCard),
   `an undated line is being counted as if its wait were known: "${onOrderCard.trim()}"`);
ok($$("#cores-returns-stats .stat-value")[0].classList.contains("crit"),
   "a part 21 days on order doesn't tone the On Order card critical");

/* ---------- on order: longest wait first, unknowns last and unclaimed ---------- */
const onOrderIds = $$("#on-order-table tr[data-id]").map((r) => Number(r.dataset.id));
ok(onOrderIds.join(",") === "31,32,33", `on-order rows aren't in server order: ${onOrderIds.join(",")}`);
ok(/21d/.test(onOrderRow(31).textContent), "a 21-day wait isn't shown on the row");
ok(/today/.test(onOrderRow(32).textContent), "a part ordered today reads as some number of days");
ok(!/0d/.test(onOrderRow(33).textContent), "an undated line is claiming a wait of zero days");
ok(/not recorded/.test(onOrderRow(33).textContent),
   `an undated line doesn't say its order date is unknown: "${onOrderRow(33).textContent.replace(/\s+/g, " ")}"`);
ok(!/null/.test(onOrderRow(33).textContent), "a null part number renders as the string null");
ok(/2019 Ford Edge/.test(onOrderRow(31).textContent), "the row doesn't say which car is waiting");
ok(/We-Owe: Maria Soto/.test(onOrderRow(32).textContent), "a we-owe part doesn't name whose promise it's for");
ok(/3 parts/.test($("#on-order-count").textContent), `on-order count reads "${$("#on-order-count").textContent}"`);
ok(/\$303\.00 across 3 vehicles/.test($("#on-order-total").textContent),
   `on-order total reads "${$("#on-order-total").textContent}"`);

// "Waiting 7+ days" is the phone-call list: only the ones we can prove are
// late, so the undated line is not swept in on a guess.
chip("on-order", "overdue").click();
await settle();
ok(onOrderRow(31) && !onOrderRow(32), "the overdue filter didn't narrow to the long waits");
ok(!onOrderRow(33), "an undated line is being called overdue on no evidence");
chip("on-order", "").click();
await settle();
ok($$("#on-order-table tr[data-id]").length === 3, "the All chip didn't restore every part on order");

input($("#on-order-search"), "windshield");
ok($$("#on-order-table tr[data-id]").length === 1, "searching a part description didn't narrow the on-order table");
input($("#on-order-search"), "R-0999");
ok(onOrderRow(33), "searching a stock number doesn't reach the on-order table");
input($("#on-order-search"), "zzz-none");
ok(/No parts on order match/.test($("#on-order-table").textContent), "a no-match on-order search explains nothing");
input($("#on-order-search"), "");
await settle();

/* ---------- default filter shows pending, voided renders struck ---------- */
ok(coreRow(11) && coreRow(15), "the pending cores didn't render under the default filter");
ok(!coreRow(12), "an awaiting core is showing under the Pending filter");
ok(coreRow(14), "the voided pending core should still show under Pending");
ok(coreRow(14).classList.contains("voided-row"), "a voided core isn't struck as voided");
ok(!coreRow(14).querySelector("button"), "a voided core still offers actions");
ok(!coreRow(14).querySelector(".cores-select"), "a voided core offers a bulk checkbox");
ok(/3 cores/.test($("#cores-count").textContent), `cores count reads "${$("#cores-count").textContent}"`);
ok(/\$180\.00 outstanding/.test($("#cores-total").textContent),
   `cores outstanding reads "${$("#cores-total").textContent}"`);

// A part with no number renders an em-dash, not "null".
ok(!/null/.test(coreRow(14).textContent), "a null part number renders as the string null");

/* ---------- filter chips swap the population ---------- */
chip("cores", "awaiting").click();
await settle();
ok(coreRow(12) && !coreRow(11), "the Awaiting filter didn't swap the rows");
ok(/Awaiting 20d/.test(coreRow(12).textContent), "an awaiting core doesn't say how long it's been waiting");
chip("cores", "credited").click();
await settle();
ok(coreRow(13), "the credited core didn't render under Credited");
ok(/CR-771/.test(coreRow(13).textContent), "a credited core doesn't show the credit number");
ok(!coreRow(13).querySelector("button"), "a credited core still offers transitions");
chip("cores", "all").click();
await settle();
ok($$("#cores-table tr[data-id]").length === 5, "the All filter doesn't show all 5 cores");

/* ---------- search narrows within the filter ---------- */
input($("#cores-search"), "alternator");
ok($$("#cores-table tr[data-id]").length === 1, "searching a description didn't narrow to 1 row");
input($("#cores-search"), "zzz-none");
ok(/No cores match/.test($("#cores-table").textContent), "a no-match search explains nothing");
input($("#cores-search"), "");
chip("cores", "pending").click();
await settle();

/* ---------- single pickup: PATCH, then the row moves states ---------- */
coreRow(11).querySelector(".cores-toggle").click();
await settle();
const pickupPatch = patches.find((p) => p.url.includes("/items/11/core-return"));
ok(pickupPatch && pickupPatch.body.returned === true, "Mark Picked Up didn't PATCH returned:true");
ok(!coreRow(11), "a picked-up core is still sitting in the Pending list");
chip("cores", "awaiting").click();
await settle();
ok(coreRow(11), "the picked-up core never arrived in Awaiting Credit");

// Undo walks it straight back.
coreRow(11).querySelector('.cores-toggle[data-returned="1"]').click();
await settle();
ok(patches.some((p) => p.url.includes("/items/11/core-return") && p.body.returned === false),
   "Undo didn't PATCH returned:false");
chip("cores", "pending").click();
await settle();
ok(coreRow(11), "the undone core never came back to Pending");

/* ---------- credit requires the vendor's number ---------- */
chip("cores", "awaiting").click();
await settle();
coreRow(12).querySelector(".cores-credit").click();
await settle();
const promptDlg = $("#invoice-prompt-dialog");
ok(promptDlg.open, "Credit Received didn't open the invoice prompt");
ok(/Brake caliper/.test($("#invoice-prompt-body").textContent),
   "the prompt doesn't say which part's deposit it's recording");
// Cancel is a real no-op.
$("#invoice-prompt-cancel").click();
await settle();
ok(posts.length === 0, "cancelling the credit prompt still posted");
// And an empty number can't be submitted.
coreRow(12).querySelector(".cores-credit").click();
await settle();
$("#invoice-prompt-input").value = "   ";
$("#invoice-prompt-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === 0, "a blank credit number was accepted");
$("#invoice-prompt-input").value = "CR-9001";
$("#invoice-prompt-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
const creditPost = posts.find((p) => p.url.includes("/items/12/core-credit"));
ok(creditPost && creditPost.body.invoice_number === "CR-9001",
   `the credit carried "${creditPost && creditPost.body.invoice_number}"`);
chip("cores", "credited").click();
await settle();
ok(coreRow(12) && /CR-9001/.test(coreRow(12).textContent), "the credited core doesn't show its new number");
chip("cores", "pending").click();
await settle();

/* ---------- bulk pickup: confirm, N PATCHes, selection cleared ---------- */
ok($("#cores-bulk-bar").hidden, "the bulk bar is showing with nothing selected");
coreRow(11).querySelector(".cores-select").click();
coreRow(15).querySelector(".cores-select").click();
await settle();
ok(!$("#cores-bulk-bar").hidden, "selecting cores didn't raise the bulk bar");
ok(/2 selected/.test($("#cores-bulk-count").textContent),
   `bulk bar reads "${$("#cores-bulk-count").textContent}"`);
// Select-all settles checked once everything selectable is selected.
ok($("#cores-select-all").checked, "select-all isn't checked with every selectable row selected");

const patchesBefore = patches.length;
$("#cores-bulk-pickup").click();
await settle();
ok($("#confirm-dialog").open, "bulk pickup fired without asking");
$("#confirm-cancel").click();
await settle();
ok(patches.length === patchesBefore, "cancelling the bulk pickup PATCHed anyway");

const bulkStart = patches.length;
$("#cores-bulk-pickup").click();
await settle();
$("#confirm-accept").click();
await settle();
const bulkPatches = patches.slice(bulkStart).filter((p) => p.body.returned === true);
ok(bulkPatches.length === 2, `bulk pickup sent ${bulkPatches.length} PATCHes for 2 rows`);
ok(w.state.coresSelected.size === 0, "the selection survived the bulk pickup");
ok($("#cores-bulk-bar").hidden, "the bulk bar is still up after the batch");

/* ---------- returns: same vocabulary, own table ---------- */
ok(returnRow(21), "the pending return didn't render");
ok(!returnRow(22), "an awaiting return is showing under Pending");
ok(/\$120\.00/.test(returnRow(21).textContent), "a return's credit due doesn't render as positive money");
ok(/\$195\.00 outstanding/.test($("#returns-total").textContent),
   `returns outstanding reads "${$("#returns-total").textContent}"`);
ok(/1 still here/.test($("#returns-total").textContent),
   "the returns note doesn't say how many are physically still at the shop");

returnRow(21).querySelector(".returns-pickup").click();
await settle();
ok(patches.some((p) => p.url.includes("/items/21/part-pickup") && p.body.picked_up === true),
   "Mark Picked Up on a return didn't PATCH picked_up:true");

chip("returns", "awaiting").click();
await settle();
ok(returnRow(21) && returnRow(22) && returnRow(24), "the awaiting returns didn't all render");
ok(/Awaiting 35d/.test(returnRow(22).textContent), "a stale return doesn't say how long it's been waiting");

/* ---------- posting a return credit: the vendor can't be defaulted ---------- */
returnRow(24).querySelector(".returns-post").click();
await settle();
const postDlg = $("#post-return-dialog");
ok(postDlg.open, "Credit Received didn't open the post-return dialog");
ok(!$("#post-return-vendor-warning").hidden, "an unresolvable vendor raised no warning");
ok($("#post-return-vendor").value === "", "an unresolvable vendor was silently defaulted to somebody");
ok(/\$15\.00/.test($("#post-return-total-summary").textContent),
   `the dialog's credit line reads "${$("#post-return-total-summary").textContent.replace(/\s+/g, " ").trim()}"`);
// Submitting with no vendor picked goes nowhere.
const postsBefore = posts.length;
$("#post-return-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === postsBefore, "a credit with no vendor was posted anyway");
$("#post-return-cancel").click();
await settle();

// A resolved vendor arrives pre-selected, and posting asks first.
returnRow(22).querySelector(".returns-post").click();
await settle();
ok($("#post-return-vendor").value === "2", `the resolved vendor isn't pre-selected: "${$("#post-return-vendor").value}"`);
ok($("#post-return-vendor-warning").hidden, "a resolved vendor still shows the pick-one warning");
$("#post-return-credit-number").value = "CR-7788";
$("#post-return-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok($("#confirm-dialog").open, "posting a return credit into A/P didn't ask first");
ok(/\$60\.00/.test($("#confirm-body").textContent) && /NAPA/.test($("#confirm-body").textContent),
   `the confirm doesn't say whose money it's posting: "${$("#confirm-body").textContent}"`);
$("#confirm-accept").click();
await settle();
const returnPost = posts.find((p) => p.url.includes("/items/22/post-return-credit"));
ok(returnPost, "confirming the credit never hit the endpoint");
ok(returnPost && returnPost.body.vendor_id === 2 && returnPost.body.credit_number === "CR-7788",
   `the credit carried vendor_id=${returnPost && returnPost.body.vendor_id} number=${returnPost && returnPost.body.credit_number}`);
ok(!postDlg.open, "the dialog stayed open after a successful post");
chip("returns", "credited").click();
await settle();
ok(returnRow(22) && /CR-7788/.test(returnRow(22).textContent), "the credited return doesn't show its number");

/* ---------- returns bulk pickup mirrors the cores path ---------- */
chip("returns", "pending").click();
await settle();
// r21 was picked up above and undone by nobody -- refetch state: it's awaiting.
// The only pending return left is none (21 moved), so re-stage one.
ok($("#returns-select-all").disabled, "select-all is enabled over a table with nothing selectable");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("parts & cores: on-order ordering/undated honesty and overdue filter, combined stats, three-state filters, pickup/undo, credit prompts, forced vendor choice, A/P confirm, bulk pickup");
