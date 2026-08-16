// A/P invoice editor: picking a ticket pulls its unbilled parts in.
//
// The stack-of-bills morning: the parts on a vendor's bill are almost always
// already written on the ticket the bill belongs to, because that is how they
// got ordered. The editor used to make the person posting the bill retype
// every one of them -- kind, part number, description, quantity, cost -- into
// a second screen. Now picking the ticket pulls its unbilled part lines into
// the grid, prefilled from what the ticket says, and the job becomes checking
// costs against paper.
//
// The contract has sharp edges worth guarding:
//   * only part lines with a part number are pulled -- posting matches lines
//     to the ticket by part number, so a line without one would be ADDED to
//     the ticket as a second received line and the car would carry the part
//     twice. The note must say so and point at the car page's receive flow.
//   * returned, fully-received and labor lines are not a bill's business.
//   * a split delivery prefills the remaining quantity, not the original.
//   * a grid the user has typed in is never overwritten -- switching tickets
//     offers a button instead. An untouched auto-fill may be replaced when
//     the pick changes, so picking the wrong car first costs nothing.

import { boot } from "./harness.mjs";

const VENDORS = [{ id: 1, name: "NAPA", aliases: [], account_number: null }];

const ORDERS = [
  { id: 42, segment: "recon", status: "in_progress", stock_number: "R-1042", number: "RO-2607-0001", year: 2019, make: "Ford", model: "Edge", customer_name: null, accepts_parts_bill: true },
  { id: 55, segment: "we_owe", status: "authorized", stock_number: null, number: "RO-2607-0002", year: 2021, make: "Kia", model: "Sorento", customer_name: "Maria Soto", accepts_parts_bill: true },
  { id: 60, segment: "recon", status: "complete", stock_number: "R-0999", number: "RO-2607-0003", year: 2018, make: "Honda", model: "Civic", customer_name: null, accepts_parts_bill: true },
];

// R-1042's ticket: two lines a bill can be matched to (one of them a split
// delivery), and one of everything the pull must leave alone.
const item = (over) => ({
  id: 0, kind: "part", part_number: "", description: "", quantity: 1,
  unit_cost: 0, unit_price: 0, received_quantity: 0, part_returned: 0,
  status: "quoted", ...over,
});
const DETAIL_42 = {
  id: 42, number: "RO-2607-0001",
  estimate: {
    id: 7,
    items: [
      item({ id: 1, part_number: "BP-2201", description: "Front brake pads", quantity: 2, unit_cost: 45 }),
      // Split delivery: 1 of 4 already billed, so this bill covers 3.
      item({ id: 2, part_number: "RT-1188", description: "Front rotors", quantity: 4, unit_cost: 30, received_quantity: 1, status: "ordered" }),
      // Fully received: already billed, nothing left for this bill.
      item({ id: 3, part_number: "FULL-9", description: "Cabin filter", quantity: 1, unit_cost: 12, received_quantity: 1, status: "received" }),
      // Returned: went back to the vendor, not this bill's business.
      item({ id: 4, part_number: "OLD-1", description: "Wrong caliper", quantity: 1, unit_cost: 60, part_returned: 1 }),
      // Labor is never on a parts bill.
      item({ id: 5, kind: "labor", description: "Brake service", quantity: 1.5 }),
      // No part number: a posted bill can't find it -- must be called out,
      // never prefilled.
      item({ id: 6, description: "Used bumper, black", quantity: 1, unit_cost: 80 }),
    ],
  },
};
const DETAIL_55 = {
  id: 55, number: "RO-2607-0002",
  estimate: { id: 8, items: [item({ id: 9, part_number: "TR-77", description: "Tie rod end", quantity: 1, unit_cost: 40 })] },
};
// A ticket whose only outstanding part has no part number: nothing to pull,
// but the trap ("just type it in here") is at its worst, so the note must
// still show the pointer to the car page.
const DETAIL_60 = {
  id: 60, number: "RO-2607-0003",
  estimate: { id: 9, items: [item({ id: 11, description: "Used tail light", quantity: 1, unit_cost: 35 })] },
};

const posts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView"],
  fetch: async (url, opts) => {
    if (url === "/api/vendors") return VENDORS;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return ORDERS;
    if (url === "/api/orders/42") return DETAIL_42;
    if (url === "/api/orders/55") return DETAIL_55;
    if (url === "/api/orders/60") return DETAIL_60;
    if (url === "/api/accounting/audits") return [];
    if (url.startsWith("/api/ap/invoices")) return [];
    if (url === "/api/agent/invoices/process" && opts.method === "POST") {
      posts.push(JSON.parse(opts.body));
      return { status: "posted", issues: [] };
    }
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
const pickOrder = async (value) => {
  const sel = $("#ap-order");
  sel.value = value;
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  await settle();
};
const rows = () => $$("#ap-invoice-items tr");
const rowValues = (tr) => ({
  part: tr.querySelector(".apl-part").value,
  desc: tr.querySelector(".apl-desc").value,
  qty: tr.querySelector(".apl-qty").value,
  cost: tr.querySelector(".apl-cost").value,
});

/* ---------- a blank grid fills itself from the ticket ---------- */
ok($("#ap-prefill-note").hidden, "the note is showing before any ticket is picked");
await pickOrder("42");

ok(rows().length === 2, `expected the 2 matchable lines, got ${rows().length}`);
const [padRow, rotorRow] = rows().map(rowValues);
ok(padRow.part === "BP-2201" && padRow.desc === "Front brake pads" && padRow.qty === "2" && padRow.cost === "45",
   `the pads line prefilled as ${JSON.stringify(padRow)}`);
ok(rotorRow.part === "RT-1188" && rotorRow.qty === "3",
   `a split delivery should prefill the remaining 3, got ${JSON.stringify(rotorRow)}`);
ok($("#ap-subtotal").textContent === "$180.00",
   `subtotal reads "${$("#ap-subtotal").textContent}", expected $180.00 (2×45 + 3×30)`);
const grid = rows().map(rowValues);
ok(!grid.some((r) => r.part === "FULL-9"), "a fully received part was pulled in again");
ok(!grid.some((r) => r.part === "OLD-1"), "a returned part was pulled onto a new bill");
ok(!grid.some((r) => /Brake service/.test(r.desc)), "a labor line was pulled onto a parts bill");
ok(!grid.some((r) => /bumper/.test(r.desc)), "a part with no part number was prefilled -- posting would double it on the car");

const note1 = $("#ap-prefill-note").textContent.replace(/\s+/g, " ").trim();
ok(!$("#ap-prefill-note").hidden, "pulling lines in said nothing");
ok(/Pulled 2 unbilled parts from R-1042/.test(note1), `the note reads "${note1}"`);
ok(/check each cost/.test(note1), "the note doesn't say to check costs against the bill");
ok(/1 more part on the ticket has no part number/.test(note1) && /car's own page/.test(note1),
   `the unmatchable part isn't called out: "${note1}"`);
// Picking the ticket also filled the vendor's reference, as it always has.
ok($("#ap-po").value === "R-1042", `the PO box reads "${$("#ap-po").value}"`);

/* ---------- an untouched auto-fill follows the pick ---------- */
await pickOrder("55");
ok(rows().length === 1 && rowValues(rows()[0]).part === "TR-77",
   `switching tickets untouched should swap to the new ticket's 1 part, got ${rows().map((r) => rowValues(r).part).join("|")}`);
ok($("#ap-subtotal").textContent === "$40.00", `subtotal reads "${$("#ap-subtotal").textContent}" after the swap`);

/* ---------- a grid the user touched is offered, never overwritten ---------- */
input(rows()[0].querySelector(".apl-cost"), "50"); // the bill says $50, not $40
await pickOrder("42");
ok(rows().length === 1, `switching tickets clobbered a grid the user had corrected (${rows().length} rows)`);
ok(rowValues(rows()[0]).cost === "50", "the user's typed cost was overwritten");
const note2 = $("#ap-prefill-note").textContent.replace(/\s+/g, " ").trim();
ok(/R-1042's ticket already has 2 unbilled parts/.test(note2), `the offer note reads "${note2}"`);
const pull = $("#ap-prefill-pull");
ok(pull, "the offer note has no button to pull the lines in");
pull.click();
await settle();
ok(rows().length === 3, `the offer should append 2 lines under the user's 1, got ${rows().length}`);
ok($("#ap-subtotal").textContent === "$230.00",
   `subtotal reads "${$("#ap-subtotal").textContent}", expected $230.00 (50 + 180)`);
ok(!$("#ap-prefill-pull"), "the offer button is still there after being used");

/* ---------- prefilled lines post exactly like typed ones ---------- */
$("#ap-vendor").value = "NAPA";
$("#ap-invoice-number").value = "INV-7001";
$("#ap-invoice-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === 1, "the filled invoice never posted");
if (posts.length) {
  const b = posts[0];
  ok(b.order_id === 42, `the post went to order ${b.order_id}, expected 42`);
  ok(b.items.length === 3, `the post carried ${b.items.length} items, expected 3`);
  const parts = b.items.map((i) => i.part_number).sort().join("|");
  ok(parts === "BP-2201|RT-1188|TR-77", `the post carried part numbers ${parts}`);
  ok(b.subtotal === 230, `the post carried subtotal=${b.subtotal}, expected 230`);
}
// Posting cleared the editor, and the note went with it.
ok($("#ap-prefill-note").hidden, "posting left a stale prefill note under an empty grid");

/* ---------- nothing pullable still warns about the unmatchable ---------- */
await pickOrder("60");
ok(rows().length === 1 && rowValues(rows()[0]).part === "",
   "a ticket with nothing matchable still wrote rows");
const note3 = $("#ap-prefill-note").textContent.replace(/\s+/g, " ").trim();
ok(/no part number/.test(note3) && /car's own page/.test(note3),
   `the no-part-number ticket's note reads "${note3}"`);

/* ---------- No ticket clears the note and touches nothing ---------- */
input(rows()[0].querySelector(".apl-desc"), "Shop towels");
await pickOrder("");
ok($("#ap-prefill-note").hidden, "clearing the ticket left the note up");
ok(rowValues(rows()[0]).desc === "Shop towels", "clearing the ticket wiped a typed line");

/* ---------- Clear resets the whole story ---------- */
await pickOrder("42");
$("#ap-clear-invoice").click();
await settle();
ok(rows().length === 1 && rowValues(rows()[0]).part === "", "Clear didn't reset the grid to one blank line");
ok($("#ap-prefill-note").hidden, "Clear left the prefill note up");

ok(rejections.length === 0, `unhandled rejections: ${rejections.map(String).join(", ")}`);
finish("A/P editor pulls the picked ticket's unbilled parts");
