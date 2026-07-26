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

// A posted recon invoice (clickable), a voided one, and a retail one (a
// plain row -- there is no vehicle page behind it).
let invoices = [
  { id: 1, invoice_number: "INV-8990", posted_at: "2026-07-20T10:00:00", vendor_name: "WorldPac", po_number: "R-1042",
    vehicle_label: "2019 Ford Edge", total: 250, status: "posted", segment: "recon", recon_vehicle_id: 7, we_owe_id: null },
  { id: 2, invoice_number: "INV-7777", posted_at: "2026-07-18T10:00:00", vendor_name: "NAPA", po_number: "R-1042",
    vehicle_label: "2019 Ford Edge", total: 90, status: "voided", segment: "recon", recon_vehicle_id: 7, we_owe_id: null },
  { id: 3, invoice_number: "INV-6001", posted_at: "2026-07-19T10:00:00", vendor_name: "NAPA", po_number: "RO-2607-0009",
    vehicle_label: "Walk-in — 2015 Toyota Camry", total: 40, status: "posted", segment: "retail", recon_vehicle_id: null, we_owe_id: null },
];

const posts = [];
const patches = [];
// Flipped per-case to script the server's answer to a process-invoice POST.
let processAnswer = () => ({ status: "posted", issues: [] });

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView", "loadAccountingView", "renderApTable", "filterApInvoices"],
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
      return { ok: true };
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
// 250 + 40, never the voided 90.
ok(/\$290\.00/.test(stats), "Total Posted isn't the sum of the live invoices only");
ok(!/\$380/.test(stats), "the voided invoice leaked into Total Posted");
const heldValue = $$("#ap-stats .stat-value").find((el) => el.classList.contains("warn"));
ok(heldValue && heldValue.textContent === "1", "one review_required audit should light the Held for Review card");

/* ---------- vendor and PO selects ---------- */
ok($$("#ap-vendor option").map((o) => o.value).join("|") === "WorldPac|NAPA",
   `vendor select holds ${$$("#ap-vendor option").map((o) => o.value).join("|")}`);
const poValues = $$("#ap-po option").map((o) => o.value);
// The PO you give a vendor is the stock number where there is one.
ok(poValues.includes("R-1042"), `the recon PO isn't offered by stock number: ${JSON.stringify(poValues)}`);
ok(poValues.includes("RO-2607-0002"), "the we-owe RO (no stock number) isn't offered by RO number");
ok(!poValues.includes("R-0999"), "a completed RO is still being offered as a PO");

/* ---------- table rows: clickable, voided, retail ---------- */
const apRows = $$("#ap-table tr");
ok(apRows.length === 3, `expected 3 invoice rows, got ${apRows.length}`);
const rowByInv = (n) => apRows.find((tr) => tr.textContent.includes(n));
ok(rowByInv("INV-8990").classList.contains("clickable"), "a recon invoice row isn't clickable");
ok(rowByInv("INV-8990").getAttribute("role") === "button", "a clickable row is invisible to the keyboard");
ok(rowByInv("INV-7777").classList.contains("voided-row"), "a voided invoice isn't struck as voided");
ok(!rowByInv("INV-7777").querySelector(".ap-void"), "a voided invoice still offers a Void button");
ok(!rowByInv("INV-6001").classList.contains("clickable"), "a retail invoice row pretends to open a vehicle page");
ok(/2 invoices/.test($("#ap-count").textContent) === false, "sanity: count should include all 3");
ok(/3 invoices/.test($("#ap-count").textContent), `count line reads "${$("#ap-count").textContent}"`);
ok(/\$290\.00/.test($("#ap-count").textContent), "the count line's total counts voided money");

/* ---------- search narrows, empty state offers the way back ---------- */
input($("#ap-search"), "worldpac");
ok($$("#ap-table tr").length === 1, `searching a vendor left ${$$("#ap-table tr").length} rows`);
input($("#ap-search"), "zzz-nothing");
ok(/No invoices match/.test($("#ap-table").textContent), "a no-match search shows no explanation");
const clearBtn = $('#ap-table [data-empty-action="ap-clear-search"]');
ok(clearBtn, "the search empty state has no Clear search action");
clearBtn && clearBtn.click();
await settle();
ok($$("#ap-table tr").length === 3, "Clear search didn't restore the table");
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
$("#confirm-cancel").click();
await settle();
ok(patches.length === patchesBefore, "cancelling a void sent the PATCH anyway");

rowByInv("INV-8990").querySelector(".ap-void").click();
await settle();
$("#confirm-accept").click();
await settle();
ok(patches.some((p) => p.url === "/api/ap/invoices/1/void"), "confirming the void never hit the endpoint");
ok($$("#ap-table .voided-row").length === 2, "the voided invoice didn't re-render as voided");

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

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("accounting: stats, PO/vendor selects, table states, search, line math + validation, post payload, held/duplicate feedback, void confirm, vendor edit");
