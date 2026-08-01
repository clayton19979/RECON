// Accounts Payable screen smoke test.
//
// This is the screen where typed numbers become posted money, so the
// assertions are weighted toward the invoice editor's arithmetic contract:
// the subtotal on screen is exactly the sum of the countable lines, the
// payload is exactly what the subtotal counted, and a line that can't be
// both (money with no description) blocks the post rather than being
// counted on screen and silently dropped from the POST -- the drift that
// makes the server hold an invoice for a mismatch the user can't see.
//
// The other half is what happens when the server pushes back: a held or
// duplicate invoice must keep the user's vendor/PO picks on screen (a form
// that blanks itself under a rejection destroys the correction in progress),
// and voiding is destructive so it has to ask first.

import { boot, click } from "./harness.mjs";

const VENDORS = [
  { id: 1, name: "WorldPac", aliases: ["World Pac"], account_number: "A-100" },
  { id: 2, name: "NAPA", aliases: [], account_number: null },
];

// One open recon RO, one open we-owe, one *complete* recon (must not be
// offered as a PO), one open retail (offered -- retail can buy parts too,
// it just has no vehicle page to jump to from the table).
const ORDERS = [
  { id: 42, segment: "recon", status: "in_progress", stock_number: "R-1042", number: "RO-2607-0001", year: 2019, make: "Ford", model: "Edge", customer_name: null },
  { id: 55, segment: "we_owe", status: "authorized", stock_number: null, number: "RO-2607-0002", year: 2021, make: "Kia", model: "Sorento", customer_name: "Maria Soto" },
  { id: 60, segment: "recon", status: "complete", stock_number: "R-0999", number: "RO-2607-0003", year: 2018, make: "Honda", model: "Civic", customer_name: null },
];

const AUDITS = [
  { invoice_number: "INV-9001", status: "review_required", issues: ["total does not match line items"], created_at: new Date().toISOString().slice(0, 19) },
  { invoice_number: "INV-8990", status: "posted", issues: [], created_at: new Date().toISOString().slice(0, 19) },
];

// A posted recon invoice (clickable), a voided one, a retail one (a plain row
// -- there is no vehicle page behind it), and one covering two cars at once.
// `coverage` is what the row is actually built from: which cars the invoice's
// lines paid for, and how much went to each.
const covers = (o) => ({ recon_vehicle_id: null, we_owe_id: null, vehicle_id: null, stock_number: null, ...o });
let invoices = [
  { id: 1, invoice_number: "INV-8990", posted_at: "2026-07-20T10:00:00", vendor_name: "WorldPac", po_number: "R-1042",
    vehicle_label: "R-1042", total: 250, status: "posted", segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
    coverage: [covers({ order_id: 42, ro_number: "RO-2607-0001", segment: "recon", recon_vehicle_id: 7, vehicle_label: "R-1042", amount: 250 })] },
  { id: 2, invoice_number: "INV-7777", posted_at: "2026-07-18T10:00:00", vendor_name: "NAPA", po_number: "R-1042",
    vehicle_label: "R-1042", total: 90, status: "voided", segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
    coverage: [covers({ order_id: 42, ro_number: "RO-2607-0001", segment: "recon", recon_vehicle_id: 7, vehicle_label: "R-1042", amount: 90 })] },
  { id: 3, invoice_number: "INV-6001", posted_at: "2026-07-19T10:00:00", vendor_name: "NAPA", po_number: "RO-2607-0009",
    vehicle_label: "Retail: Walk-in", total: 40, status: "posted", segment: "retail", recon_vehicle_id: null, we_owe_id: null,
    coverage: [covers({ order_id: 90, ro_number: "RO-2607-0009", segment: "retail", vehicle_label: "Retail: Walk-in", amount: 40 })] },
  // The shared invoice. order_id/ro_number/segment are null on purpose -- once
  // an invoice covers two tickets it belongs to neither, and the screen used
  // to read that null and print "No ticket" over $100 of real parts.
  { id: 4, invoice_number: "INV-5567", posted_at: "2026-07-21T10:00:00", vendor_name: "NAPA", po_number: "RO-2607-0001",
    vehicle_label: "R-1042 +1 more", total: 100, status: "posted", segment: null, recon_vehicle_id: null, we_owe_id: null,
    coverage: [
      covers({ order_id: 42, ro_number: "RO-2607-0001", segment: "recon", recon_vehicle_id: 7, vehicle_label: "R-1042", amount: 70 }),
      covers({ order_id: 55, ro_number: "RO-2607-0002", segment: "we_owe", we_owe_id: 9, vehicle_label: "We-Owe: Maria Soto", amount: 30 }),
    ] },
];

const posts = [];
const patches = [];
// Flipped per-case to script the server's answer to a process-invoice POST.
let processAnswer = () => ({ status: "posted", issues: [] });

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView", "loadAccountingView", "renderApTable", "filterApInvoices", "computeQuickRange"],
  fetch: async (url, opts) => {
    if (url === "/api/vendors" && opts.method === "GET") return VENDORS;
    if (url === "/api/vendors" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      posts.push({ url, body });
      VENDORS.push({ id: 3, ...body });
      return { id: 3, ...body };
    }
    if (url.startsWith("/api/vendors/") && opts.method === "PATCH") {
      const body = JSON.parse(opts.body);
      patches.push({ url, body });
      const v = VENDORS.find((x) => x.id === Number(url.split("/").pop()));
      if (v) Object.assign(v, body);
      return v;
    }
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return ORDERS;
    if (url === "/api/accounting/audits") return AUDITS;
    if (url.startsWith("/api/ap/invoices?")) return invoices;
    if (url.endsWith("/void") && opts.method === "PATCH") {
      patches.push({ url, body: JSON.parse(opts.body) });
      const id = Number(url.split("/")[4]);
      invoices = invoices.map((a) => (a.id === id ? { ...a, status: "voided" } : a));
      // The server reports what the void undid on the tickets behind the
      // invoice -- two parts put back on order, $250 off the car.
      return { ok: true, unreceived_items: 2, unreceived_value: 250, credits_cleared: 0 };
    }
    if (url === "/api/agent/invoices/process" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      posts.push({ url, body });
      return processAnswer(body);
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return [];
    return [];
  },
});

w.showView("accounting");
await settle();

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const input = (el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};

/* ---------- stats know the difference between live and voided ---------- */
const stats = $("#ap-stats").textContent;
ok(/plus 1 voided/.test(stats), `the Invoices card doesn't call out the voided invoice: "${stats.replace(/\s+/g, " ").trim()}"`);
// 250 + 40 + 100, never the voided 90.
ok(/\$390\.00/.test(stats), "Total Posted isn't the sum of the live invoices only");
ok(!/\$480/.test(stats), "the voided invoice leaked into Total Posted");
const heldValue = $$("#ap-stats .stat-value").find((el) => el.classList.contains("warn"));
ok(heldValue && heldValue.textContent === "1", "one review_required audit should light the Held for Review card");

/* ---------- vendor and PO selects ---------- */
ok($$("#ap-vendor option").map((o) => o.value).join("|") === "WorldPac|NAPA",
   `vendor select holds ${$$("#ap-vendor option").map((o) => o.value).join("|")}`);
// The ticket picker posts an order id; the reference it prefills into the PO
// box is the stock number where there is one, which rides along in data-po.
// (These assertions used to read option.value, from back when the select held
// PO strings and the server reverse-matched them to a ticket.)
const ticketOptions = $$("#ap-order option").filter((o) => o.value);
const ticketIds = ticketOptions.map((o) => o.value);
const ticketRefs = ticketOptions.map((o) => o.dataset.po);
ok(ticketIds.includes("42"), `the open recon ticket isn't offered: ${JSON.stringify(ticketIds)}`);
ok(ticketRefs.includes("R-1042"), `the recon ticket's reference isn't its stock number: ${JSON.stringify(ticketRefs)}`);
ok(ticketRefs.includes("RO-2607-0002"), "the we-owe ticket (no stock number) doesn't fall back to its RO number");
ok(!ticketIds.includes("60"), "a completed RO is still being offered as a ticket");

/* ---------- table rows: clickable, voided, retail ---------- */
const apRows = $$("#ap-table tr");
ok(apRows.length === 4, `expected 4 invoice rows, got ${apRows.length}`);
const rowByInv = (n) => $$("#ap-table tr").find((tr) => tr.textContent.includes(n));
ok(rowByInv("INV-8990").classList.contains("clickable"), "a recon invoice row isn't clickable");
ok(rowByInv("INV-8990").getAttribute("role") === "button", "a clickable row is invisible to the keyboard");
ok(rowByInv("INV-7777").classList.contains("voided-row"), "a voided invoice isn't struck as voided");
ok(!rowByInv("INV-7777").querySelector(".ap-void"), "a voided invoice still offers a Void button");
ok(!rowByInv("INV-6001").classList.contains("clickable"), "a retail invoice row pretends to open a vehicle page");
ok(/3 invoices/.test($("#ap-count").textContent) === false, "sanity: count should include all 4");
ok(/4 invoices/.test($("#ap-count").textContent), `count line reads "${$("#ap-count").textContent}"`);
ok(/\$390\.00/.test($("#ap-count").textContent), "the count line's total counts voided money");

/* ---------- an invoice covering two cars names both of them ---------- */
// The bug this replaced: the cell said "No ticket" -- the same words used for
// a genuine shop-supplies bill -- so the biggest invoices named no car at all.
const shared = rowByInv("INV-5567");
ok(!/No ticket/.test(shared.textContent), "a shared invoice still reads as belonging to no ticket");
ok(/R-1042/.test(shared.textContent) && /Maria Soto/.test(shared.textContent),
   `the shared invoice names ${shared.textContent.replace(/\s+/g, " ").trim()}`);
ok(/\$70\.00/.test(shared.textContent) && /\$30\.00/.test(shared.textContent),
   "the shared invoice doesn't say how much of the bill went to each car");
ok(!shared.classList.contains("clickable"),
   "a row covering two cars still claims to open one particular vehicle");
const coverLines = [...shared.querySelectorAll(".ap-cover-line.clickable")];
ok(coverLines.length === 2, `expected both cars to be openable, got ${coverLines.length}`);
ok(coverLines[1].dataset.segment === "we_owe" && coverLines[1].dataset.refId === "9",
   "the second car's link doesn't point at that car");

/* ---------- search narrows, empty state offers the way back ---------- */
input($("#ap-search"), "worldpac");
ok($$("#ap-table tr").length === 1, `searching a vendor left ${$$("#ap-table tr").length} rows`);
// The second car on a shared invoice is findable, not just the summary label.
input($("#ap-search"), "maria soto");
ok($$("#ap-table tr").length === 1 && /INV-5567/.test($("#ap-table").textContent),
   "searching the second car on a shared invoice doesn't find it");
input($("#ap-search"), "zzz-nothing");
ok(/No invoices match/.test($("#ap-table").textContent), "a no-match search shows no explanation");
const clearBtn = $('#ap-table [data-empty-action="ap-clear-search"]');
ok(clearBtn, "the search empty state has no Clear search action");
clearBtn && clearBtn.click();
await settle();
ok($$("#ap-table tr").length === 4, "Clear search didn't restore the table");
ok($("#ap-search").value === "", "Clear search left the stale query in the box");

/* ---------- the invoice editor's arithmetic contract ---------- */
// The view opens with exactly one blank line ready to type into.
ok($$("#ap-invoice-items tr").length === 1, `expected 1 starter line, got ${$$("#ap-invoice-items tr").length}`);

const line1 = $("#ap-invoice-items tr");
input(line1.querySelector(".apl-desc"), "Brake caliper");
input(line1.querySelector(".apl-qty"), "2");
input(line1.querySelector(".apl-cost"), "120");
ok(line1.querySelector(".apl-line-total").textContent === "$240.00",
   `line total reads "${line1.querySelector(".apl-line-total").textContent}"`);
ok($("#ap-subtotal").textContent === "$240.00", `subtotal reads "${$("#ap-subtotal").textContent}"`);
ok($("#ap-total").textContent === "$240.00", `total reads "${$("#ap-total").textContent}" with no tax`);

// Tax is the only typed figure in the totals block; Total must follow it.
input($("#ap-tax"), "20");
ok($("#ap-total").textContent === "$260.00", `total reads "${$("#ap-total").textContent}" after $20 tax`);
ok($("#ap-over-threshold").hidden, "the over-$500 warning is showing at $260");

// ＋ Line adds a second row; a blank row is not money.
$("#ap-add-line").click();
ok($$("#ap-invoice-items tr").length === 2, "the ＋ Line button didn't add a line");
ok($("#ap-subtotal").textContent === "$240.00", "an untouched blank line changed the subtotal");

// Push over the hold threshold and the screen says so *before* the post.
input(line1.querySelector(".apl-cost"), "300");
ok($("#ap-subtotal").textContent === "$600.00", `subtotal reads "${$("#ap-subtotal").textContent}"`);
ok(!$("#ap-over-threshold").hidden, "crossing $500 didn't surface the held-for-approval warning");
input(line1.querySelector(".apl-cost"), "120");

// Removing a line takes its money out of the subtotal with it.
$("#ap-add-line").click();
const rows3 = $$("#ap-invoice-items tr");
input(rows3[2].querySelector(".apl-desc"), "Freight");
input(rows3[2].querySelector(".apl-qty"), "1");
input(rows3[2].querySelector(".apl-cost"), "15");
ok($("#ap-subtotal").textContent === "$255.00", `subtotal reads "${$("#ap-subtotal").textContent}" with the freight line`);
rows3[2].querySelector(".rm-btn").click();
ok($("#ap-subtotal").textContent === "$240.00", "removing a line left its money in the subtotal");

/* ---------- money with no description blocks the post ---------- */
const rows2 = $$("#ap-invoice-items tr");
input(rows2[1].querySelector(".apl-qty"), "1");
input(rows2[1].querySelector(".apl-cost"), "50");   // money, no description
$("#ap-invoice-number").value = "INV-5000";
$("#ap-vendor").value = "NAPA";
const postsBefore = posts.length;
$("#ap-invoice-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === postsBefore, "an invalid line was posted anyway");
ok(rows2[1].classList.contains("apl-invalid"), "the offending line isn't flagged on the field itself");
// Typing into the flagged description clears the flag.
input(rows2[1].querySelector(".apl-desc"), "Shop towels");
ok(!rows2[1].classList.contains("apl-invalid"), "correcting the description didn't clear the invalid flag");

/* ---------- a valid post carries exactly what the screen counted ---------- */
$("#ap-vendor").value = "NAPA";
$("#ap-po").value = "R-1042";
$("#ap-invoice-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
const processed = posts.find((p) => p.url === "/api/agent/invoices/process");
ok(processed, "a valid invoice never reached the process endpoint");
if (processed) {
  const b = processed.body;
  ok(b.vendor_name === "NAPA" && b.invoice_number === "INV-5000" && b.po_number === "R-1042",
     `the post carried ${b.vendor_name}/${b.invoice_number}/${b.po_number}`);
  ok(b.items.length === 2, `the post carried ${b.items.length} items, expected the 2 real lines`);
  ok(b.subtotal === 290 && b.tax === 20 && b.total === 310,
     `the post carried subtotal=${b.subtotal} tax=${b.tax} total=${b.total}, expected 290/20/310`);
  ok(b.items.every((i) => i.part_number), "an empty part number wasn't defaulted");
}
// A posted invoice resets the editor back to one blank line.
ok($$("#ap-invoice-items tr").length === 1, "posting didn't clear the editor");
ok($("#ap-invoice-number").value === "", "posting left the old invoice number in the form");

/* ---------- a held invoice keeps the user's picks on screen ---------- */
processAnswer = () => ({ status: "review_required", issues: ["PO not found", "total mismatch"] });
const held1 = $("#ap-invoice-items tr");
input(held1.querySelector(".apl-desc"), "Alternator");
input(held1.querySelector(".apl-qty"), "1");
input(held1.querySelector(".apl-cost"), "200");
$("#ap-invoice-number").value = "INV-5001";
$("#ap-vendor").value = "WorldPac";
$("#ap-po").value = "RO-2607-0002";
$("#ap-invoice-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(!$("#ap-invoice-note").hidden, "a held invoice shows no alert");
ok(/Held for review — 2 issues/.test($("#ap-invoice-note").textContent),
   `the alert head reads "${$("#ap-invoice-note").textContent.replace(/\s+/g, " ").trim()}"`);
ok(/PO not found/.test($("#ap-invoice-note").textContent), "the server's issues aren't listed");
ok($("#ap-vendor").value === "WorldPac", "a held invoice blanked the vendor the user picked");
ok($("#ap-po").value === "RO-2607-0002", "a held invoice blanked the PO the user picked");
ok($("#ap-invoice-number").value === "INV-5001", "a held invoice cleared the form under the correction");
// Correcting any field takes the stale warning down with it.
input($("#ap-invoice-number"), "INV-5002");
ok($("#ap-invoice-note").hidden, "a corrected invoice still shows the old warning");
processAnswer = () => ({ status: "posted", issues: [] });
$("#ap-clear-invoice").click();
await settle();

/* ---------- duplicate response names the problem ---------- */
processAnswer = () => ({ status: "duplicate", issues: [] });
const dup1 = $("#ap-invoice-items tr");
input(dup1.querySelector(".apl-desc"), "Battery");
input(dup1.querySelector(".apl-qty"), "1");
input(dup1.querySelector(".apl-cost"), "80");
$("#ap-invoice-number").value = "INV-8990";
$("#ap-invoice-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(/Duplicate invoice number/.test($("#ap-invoice-note").textContent),
   `the duplicate alert reads "${$("#ap-invoice-note").textContent.replace(/\s+/g, " ").trim()}"`);
processAnswer = () => ({ status: "posted", issues: [] });
$("#ap-clear-invoice").click();
await settle();

/* ---------- the control log tones severity ---------- */
ok($$("#audit-list .mini-item").length >= 2, "the control log didn't render the audits");
ok($("#audit-list .mini-item.is-review"), "a review_required audit isn't toned as needing review");

/* ---------- voiding asks first, and cancel is a real no-op ---------- */
const patchesBefore = patches.length;
rowByInv("INV-8990").querySelector(".ap-void").click();
await settle();
const confirm = $("#confirm-dialog");
ok(confirm.open, "Void fired without asking");
ok(/INV-8990/.test($("#confirm-title").textContent), "the confirm doesn't name the invoice it's about to void");
// Voiding a bill moves money off a car -- the ask has to say so, because
// that consequence is the whole reason it's the right move for a mis-posted
// invoice and the whole reason it needs confirming.
const confirmBody = $("#confirm-dialog").textContent.replace(/\s+/g, " ");
ok(/go back to Ordered/i.test(confirmBody) && /cost comes off the vehicle/i.test(confirmBody),
   `the confirm doesn't say what voiding does to the car: "${confirmBody.trim()}"`);
$("#confirm-cancel").click();
await settle();
ok(patches.length === patchesBefore, "cancelling a void sent the PATCH anyway");

rowByInv("INV-8990").querySelector(".ap-void").click();
await settle();
$("#confirm-accept").click();
await settle();
ok(patches.some((p) => p.url === "/api/ap/invoices/1/void"), "confirming the void never hit the endpoint");
ok($$("#ap-table .voided-row").length === 2, "the voided invoice didn't re-render as voided");
// "Invoice voided" alone hides the half that matters: a bare confirmation
// beside a car whose cost just dropped by $250 is how the two screens end up
// disagreeing with nobody noticing.
const voidToast = $("#toast").textContent;
ok(/2 parts back on order/.test(voidToast) && /\$250\.00/.test(voidToast),
   `the void toast doesn't report what came off the car: "${voidToast}"`);

/* ---------- vendor chips open the editor pre-filled ---------- */
const chip = $$("#vendor-list .vendor-chip").find((c) => /WorldPac/.test(c.textContent));
ok(chip, "the vendor chips didn't render");
chip.click();
await settle();
// namedItem on purpose: form.name is the form's own name attribute in jsdom
// (no LegacyOverrideBuiltIns), and jsdom's elements collection has the same
// collision on elements.name -- the trap the app code (openVendorForEdit)
// documents and side-steps the same way.
const vfield = (n) => $("#vendor-form").elements.namedItem(n);
ok(vfield("name").value === "WorldPac", `the editor opened holding "${vfield("name").value}"`);
ok(vfield("aliases").value === "World Pac", `aliases opened holding "${vfield("aliases").value}"`);
ok(/Editing WorldPac/.test($("#vendor-form-title").textContent), "the form doesn't say it's editing");
vfield("account_number").value = "A-200";
$("#vendor-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
const vendorPatch = patches.find((p) => p.url === "/api/vendors/1");
ok(vendorPatch, "updating a vendor never sent a PATCH");
ok(vendorPatch && vendorPatch.body.account_number === "A-200",
   `the vendor PATCH carried account "${vendorPatch && vendorPatch.body.account_number}"`);
ok($("#vendor-form-title").textContent === "Vendors", "the form is stuck in editing mode after an update");

/* ---------- the range chips mean today, not the day they were clicked ----------
   Nothing here is saved to localStorage, so the way this screen goes stale is
   being left open: the shop works evenings, and past midnight a lit "Today"
   is showing yesterday's invoices under today's heading. */
$('#view-accounting [data-ap-range="today"]').click();
await settle();
const today = w.computeQuickRange("today");
ok(w.state.apFilter.start === today.start, `clicking Today filtered from ${w.state.apFilter.start}`);
ok(fetchLog.at(-1).url.includes(`start=${today.start}`), `the chip didn't reach the query: ${fetchLog.at(-1).url}`);

// Roll the clock: put yesterday's answer back under a chip still reading Today.
w.state.apFilter = { start: "2020-01-01", end: "2020-01-01" };
await w.loadAccountingView();
await settle();
ok(w.state.apFilter.start === today.start,
   `a lit Today chip kept covering ${w.state.apFilter.start} after the day rolled over`);
ok($("#ap-filter-start").value === today.start, "the From field kept the stale date");
ok(fetchLog.at(-1).url.includes(`start=${today.start}`), `the stale range still reached the query: ${fetchLog.at(-1).url}`);

// A hand-typed date belongs to no chip, and must not be overwritten by one.
$("#ap-filter-start").value = "2026-02-03";
$("#ap-filter-start").dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(!$("#view-accounting [data-ap-range].active"), "a range chip stayed lit after the dates were typed by hand");
await w.loadAccountingView();
await settle();
ok(w.state.apFilter.start === "2026-02-03",
   `reloading the screen overwrote the typed date with ${w.state.apFilter.start}`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("accounting: stats, PO/vendor selects, table states, search, line math + validation, post payload, held/duplicate feedback, void confirm, vendor edit, range chips");
