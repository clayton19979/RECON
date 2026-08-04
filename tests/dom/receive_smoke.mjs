// Receive Parts dialog smoke test.
//
// Receiving writes two records from one figure: the estimate line (which is
// what the car cost) and a vendor A/P invoice (which is what the shop owes).
// The dialog is where the price on the paper invoice is typed in, so the
// things worth pinning down are that the arithmetic on screen matches what
// gets posted, that only genuinely corrected lines are sent as overrides, and
// that an empty price box stops the post instead of billing the vendor $0.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

const vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "", color: "Grey",
  purchase_price: 0, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 1, created_at: daysAgo(30), updated_at: daysAgo(0),
  orders: [], total_cost: 0, quoted_cost: 0, profit: null,
  last_activity: { at: daysAgo(1), idle_days: 1, action: "order_created", actor: "Dana Ruiz" },
};

const mkOrder = () => ({
  id: 42, number: "RO-1042", concern: "Recon prep", status: "in_progress",
  voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: daysAgo(20), notes: [], activity: [], findings: [],
  assignment: null, inspection: null, authorization: null, invoice: null,
  quoted_cost: 89, actual_cost: 0,
  estimate: {
    id: 1, edit_version: 1, jobs: [],
    items: [
      { id: 11, kind: "part", description: "Used tail light, right", part_number: "TL-R", quantity: 1, unit_cost: 60, core_charge: 0, status: "ordered", received_quantity: 0, job_id: null },
      { id: 12, kind: "part", description: "Wiper blades", part_number: "WB-22", quantity: 2, unit_cost: 14.5, core_charge: 0, status: "ordered", received_quantity: 0, job_id: null },
      { id: 13, kind: "labor", description: "Fit and align", quantity: 1, unit_cost: 0, status: "quoted", received_quantity: 0, job_id: null },
    ],
  },
});

const receivePosts = [];
// Swapped per-case by the vendor-default tests below; the rest of the file
// runs against the single-vendor list it has always used.
let vendorList = [{ id: 3, name: "Pull-A-Part", last_invoice_at: "" }];
const { w, doc, settle, ok, finish } = await boot({
  expose: ["state", "renderEstimate", "openReceiveDialog", "toast"],
  fetch: async (url, opts = {}) => {
    if (/receive-parts$/.test(url)) {
      receivePosts.push(JSON.parse(opts.body));
      return { ap_invoice_id: 5, received_items: 2 };
    }
    if (url === "/api/vendors") return vendorList;
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url.startsWith("/api/orders?")) return [mkOrder()];
    return [];
  },
});

const lineRows = () => [...doc.querySelectorAll("#receive-lines .receive-line:not(.head)")];
const costBoxes = () => [...doc.querySelectorAll("#receive-lines .rl-cost")];
const summary = () => doc.querySelector("#receive-total-summary").textContent.replace(/\s+/g, " ").trim();
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
};

async function openDialogWithBothParts(order = mkOrder()) {
  w.state.detail = { segment: "recon", id: 7, item: vehicle, order };
  w.state.staff = [];
  w.renderEstimate(w.state.detail.order);
  for (const cb of doc.querySelectorAll("#vd-estimate-items .ei-receive-check")) {
    cb.checked = true;
    cb.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  await w.openReceiveDialog();
  await settle();
}

const vendorSelect = () => doc.querySelector("#receive-vendor");
const newVendorShown = () => doc.querySelector("#receive-new-vendor").style.display !== "none";
const whyNote = () => {
  const el = doc.querySelector("#receive-vendor-why");
  return el.hidden ? "" : el.textContent.trim();
};

await openDialogWithBothParts();

/* ---------- the dialog opens priced at the quote ---------- */
ok(doc.querySelector("#receive-dialog").open, "the receive dialog never opened");
ok(lineRows().length === 2, `expected the 2 selected part lines, got ${lineRows().length}`);
ok(costBoxes().map((i) => i.value).join(",") === "60,14.5",
   `price boxes did not start at the quoted cost: ${costBoxes().map((i) => i.value).join(",")}`);
ok(/Subtotal\s*\$89\.00/.test(summary()), `opening subtotal wrong: ${summary()}`);
ok(!/Quoted for these lines/.test(summary()),
   "the quote-comparison line is showing before anything has been changed");
ok(lineRows().every((r) => r.querySelector(".rl-note").hidden),
   "a line is flagged as changed before anything was typed");

/* ---------- typing a real invoice price repaints every number ---------- */
type(costBoxes()[0], "45");    // the yard charged less
type(costBoxes()[1], "16.25"); // the wipers cost more
ok(lineRows()[0].querySelector(".rl-total").textContent === "$45.00",
   `line total not recomputed: ${lineRows()[0].querySelector(".rl-total").textContent}`);
ok(lineRows()[1].querySelector(".rl-total").textContent === "$32.50",
   `a multi-quantity line total ignored the quantity: ${lineRows()[1].querySelector(".rl-total").textContent}`);
ok(/Written up at \$60\.00 . \$15\.00 less each/.test(lineRows()[0].querySelector(".rl-note").textContent),
   `the "written up at" note is wrong: ${lineRows()[0].querySelector(".rl-note").textContent}`);
ok(lineRows()[0].querySelector(".rl-note").classList.contains("under")
   && lineRows()[1].querySelector(".rl-note").classList.contains("over"),
   "cheaper and dearer than the line are not toned differently");
// 45 + 2 x 16.25 = 77.50, plus 6.20 tax. The per-line notes above are the
// data-entry check; nothing totals them into an over/under figure, because
// the shop doesn't quote recon work -- there is no estimate to come in under.
type(doc.querySelector("#receive-tax"), "6.20");
ok(!/Quoted for these lines|the quote/i.test(summary()), `a quote comparison is back on the receive dialog: ${summary()}`);
ok(/Subtotal\s*\$77\.50/.test(summary()), `subtotal ignored the entered prices: ${summary()}`);
ok(/Total\s*\$83\.70/.test(summary()), `total ignored tax: ${summary()}`);

/* ---------- an empty price box blocks the post ---------- */
type(costBoxes()[1], "");
ok(lineRows()[1].classList.contains("bad"), "an empty price box is not flagged");
doc.querySelector("#receive-vendor").value = "3";
doc.querySelector("#receive-invoice-number").value = "PAP-8812";
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 0, "a blank price posted a $0 line to the vendor's bill");
ok(doc.querySelector("#receive-dialog").open, "the dialog closed on a rejected post");
ok(doc.activeElement === costBoxes()[1], "the blocked post did not put the cursor on the offending price");
ok(/Enter the invoice price/.test(doc.querySelector("#notif-list").textContent),
   "the blocked post said nothing about why");

/* ---------- posting sends overrides only for the lines that moved ---------- */
type(costBoxes()[1], "14.5"); // put the wipers back to the quoted price
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 1, `expected exactly one post, got ${receivePosts.length}`);
const body = receivePosts[0] || {};
ok(String(body.item_ids) === "11,12", `posted the wrong lines: ${JSON.stringify(body.item_ids)}`);
ok(body.invoice_number === "PAP-8812" && body.vendor_id === 3, `vendor/invoice not carried: ${JSON.stringify(body)}`);
ok(body.tax === 6.2, `tax not carried: ${JSON.stringify(body.tax)}`);
ok(JSON.stringify(body.cost_overrides) === '{"11":45}',
   `only the corrected line should be overridden, got ${JSON.stringify(body.cost_overrides)}`);
ok(/1 price updated from the invoice/.test(doc.querySelector("#notif-list").textContent),
   "a corrected price landed without saying so");

/* ---------- everything at the quoted price sends no overrides at all ---------- */
await openDialogWithBothParts();
ok(!/Quoted for these lines/.test(summary()), "a reopened dialog kept the previous edit's comparison line");
doc.querySelector("#receive-vendor").value = "3";
doc.querySelector("#receive-invoice-number").value = "PAP-9000";
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 2, `the untouched-price post never landed (${receivePosts.length} posts)`);
ok(JSON.stringify(receivePosts[1].cost_overrides) === "{}",
   `an untouched dialog invented overrides: ${JSON.stringify(receivePosts[1].cost_overrides)}`);

/* ---------- the vendor row: selection, name box and note agree ----------

   The dropdown's first option is "＋ New vendor…" and a <select> opens on its
   first option, so this dialog used to open claiming a new vendor while
   hiding the box to name one (that box was tied to whether any vendors
   existed, not to what was selected). Post & Receive then said "Enter the
   vendor's name" with nowhere to type it. */

// No PO vendor, nothing received yet, no vendor ever invoiced -- the app has
// nothing to go on, so it stays on "＋ New vendor…" and must SHOW the name box.
vendorList = [{ id: 3, name: "Pull-A-Part", last_invoice_at: "" }];
await openDialogWithBothParts();
ok(vendorSelect().value === "__new__", `expected no guess, got ${vendorSelect().value}`);
ok(newVendorShown(), "the new-vendor name box is hidden while '＋ New vendor…' is selected");
ok(whyNote() === "", `an unexplained guess still printed a reason: ${whyNote()}`);

// Falls back to whoever the shop bought from most recently. Alphabetically
// last, to prove it is reading the date and not the list order.
vendorList = [
  { id: 3, name: "Pull-A-Part", last_invoice_at: "2026-01-04T09:00:00" },
  { id: 4, name: "WorldPac", last_invoice_at: "2026-06-30T16:20:00" },
];
await openDialogWithBothParts();
ok(vendorSelect().value === "4", `did not fall back to the most recent vendor: ${vendorSelect().value}`);
ok(!newVendorShown(), "the new-vendor name box is showing while a real vendor is selected");
ok(whyNote() === "", `a shop-wide recency guess should say nothing, said: ${whyNote()}`);

// A vendor written on the purchase order these lines went out on beats it.
const poOrder = mkOrder();
poOrder.purchase_orders = [{ id: 9, number: "R42-1", vendor_id: 3 }];
poOrder.estimate.items[0].purchase_order_id = 9;
poOrder.estimate.items[1].purchase_order_id = 9;
await openDialogWithBothParts(poOrder);
ok(vendorSelect().value === "3", `the PO's own vendor was ignored: ${vendorSelect().value}`);
ok(whyNote() === "On purchase order R42-1", `the PO reason is wrong: ${whyNote()}`);

// Two POs to two different suppliers in one go has no single right answer, so
// it must not state one -- it drops back to the shop-wide guess, unexplained.
const splitOrder = mkOrder();
splitOrder.purchase_orders = [
  { id: 9, number: "R42-1", vendor_id: 3 },
  { id: 10, number: "R42-2", vendor_id: 4 },
];
splitOrder.estimate.items[0].purchase_order_id = 9;
splitOrder.estimate.items[1].purchase_order_id = 10;
await openDialogWithBothParts(splitOrder);
ok(whyNote() === "", `two suppliers in one batch claimed a single PO: ${whyNote()}`);

// Nothing on the PO, but a part on this same ticket was already received from
// someone -- receiving the rest of that order is the everyday case.
const partlyReceived = mkOrder();
partlyReceived.estimate.items.push({
  id: 14, kind: "part", description: "Bulb", part_number: "B-1", quantity: 1,
  unit_cost: 4, core_charge: 0, status: "received", received_quantity: 1,
  received_vendor_id: 3, job_id: null,
});
await openDialogWithBothParts(partlyReceived);
ok(vendorSelect().value === "3", `ignored the vendor already used on this ticket: ${vendorSelect().value}`);
ok(whyNote() === "Last received from on this ticket", `the ticket-history reason is wrong: ${whyNote()}`);

// Overruling the guess by hand drops the explanation and reveals the name box
// when (and only when) "＋ New vendor…" is chosen.
vendorSelect().value = "__new__";
vendorSelect().dispatchEvent(new w.Event("change", { bubbles: true }));
ok(newVendorShown(), "choosing '＋ New vendor…' by hand did not reveal the name box");
ok(whyNote() === "", "the app's reason survived the user overruling it");
vendorSelect().value = "4";
vendorSelect().dispatchEvent(new w.Event("change", { bubbles: true }));
ok(!newVendorShown(), "picking a real vendor left the new-vendor box on screen");

// The whole point: the preselected vendor posts without anyone touching the
// dropdown. Invoice # and Post is the entire interaction.
await openDialogWithBothParts(partlyReceived);
doc.querySelector("#receive-invoice-number").value = "PAP-7010";
doc.querySelector("#receive-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(receivePosts.length === 3, `the preselected vendor did not post (${receivePosts.length} posts)`);
ok(receivePosts[2].vendor_id === 3, `posted against the wrong vendor: ${JSON.stringify(receivePosts[2].vendor_id)}`);

finish("receive parts dialog: invoice pricing, live totals, blank-price guard, override payload, vendor default");
