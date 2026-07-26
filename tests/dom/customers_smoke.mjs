// Customers screen smoke test.
//
// The rolodex screen: searchable by anything you'd know mid-phone-call,
// stat cards that double as filters, rows that expand in place to show
// vehicles and repair orders, and the shared customer editor reachable
// without going through a vehicle. The assertions lean on the behaviors
// that make it a rolodex -- digit-insensitive phone search, alphabetical
// order, the expansion's lazy detail fetch, and the editor writing back
// into both the row and the (invalidated) expansion cache.

import { boot, click } from "./harness.mjs";

let customers = [
  { id: 1, name: "Marta Alvarez", phone: "(219) 555-0142", email: "marta@example.com",
    address_line1: "12 Oak St", address_line2: "", city: "Merrillville", state: "IN", postal_code: "46410",
    is_shop_owned: 0, created_at: "2025-03-10T12:00:00", vehicle_count: 2, order_count: 3, open_orders: 1,
    last_visit_at: "2026-07-01T09:30:00" },
  { id: 2, name: "Ben Cho", phone: "", email: "",
    address_line1: "", address_line2: "", city: "Gary", state: "IN", postal_code: "",
    is_shop_owned: 0, created_at: "2026-01-05T12:00:00", vehicle_count: 1, order_count: 1, open_orders: 0,
    last_visit_at: "2026-02-14T15:00:00" },
  { id: 3, name: "Ada Zimm", phone: "(313) 555-0100", email: "",
    address_line1: "", address_line2: "", city: "", state: "", postal_code: "",
    is_shop_owned: 0, created_at: "2026-06-20T12:00:00", vehicle_count: 0, order_count: 0, open_orders: 0,
    last_visit_at: null },
];

// Marta's detail: one vehicle with a jumpable we-owe RO plus a voided one,
// a second vehicle with a retail RO (no page of its own -> inert chip).
const DETAILS = {
  1: {
    ...customers[0],
    vehicles: [
      { id: 11, year: 2020, make: "Kia", model: "Soul", plate: "ABC123", plate_state: "IN", vin: "VIN0001",
        orders: [
          { id: 101, number: "RO-2607-0101", segment: "we_owe", status: "in_progress", voided: 0,
            created_at: "2026-07-01T09:30:00", recon_vehicle_id: null, we_owe_id: 71, concern: "Mirror" },
          { id: 100, number: "RO-2602-0100", segment: "we_owe", status: "complete", voided: 1,
            created_at: "2026-02-01T09:30:00", recon_vehicle_id: null, we_owe_id: 71, concern: "Old" },
        ] },
      { id: 12, year: 2015, make: "Jeep", model: "Patriot", plate: "", plate_state: "", vin: "",
        orders: [
          { id: 99, number: "RO-2601-0099", segment: "retail", status: "complete", voided: 0,
            created_at: "2026-01-10T09:30:00", recon_vehicle_id: null, we_owe_id: null, concern: "Brakes" },
        ] },
    ],
  },
  3: { ...customers[2], vehicles: [] },
};

const detailFetches = [];
const patches = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView", "loadCustomersView", "renderCustomersTable", "toggleCustomerExpand"],
  fetch: async (url, opts) => {
    if (url === "/api/customers" && opts.method === "GET") return customers;
    const detail = url.match(/^\/api\/customers\/(\d+)$/);
    if (detail && opts.method === "GET") {
      detailFetches.push(url);
      return DETAILS[Number(detail[1])] || { __status: 404, body: { detail: "Customer not found" } };
    }
    if (detail && opts.method === "PATCH") {
      const id = Number(detail[1]);
      const body = JSON.parse(opts.body);
      patches.push({ id, body });
      customers = customers.map((c) => (c.id === id ? { ...c, ...body } : c));
      return customers.find((c) => c.id === id);
    }
    // The we-owe chip jump loads the vehicle detail page.
    if (url === "/api/we-owe/71") return { id: 71, description: "Mirror", customer_id: 1, vehicle_id: 11, status: "open", archived_at: "", edit_version: 1 };
    if (url.startsWith("/api/orders")) return [];
    if (url.startsWith("/api/staff")) return [];
    if (url.startsWith("/api/vehicles-board")) return [];
    return [];
  },
});

w.showView("customers");
await settle();

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const row = (id) => $(`#customers-table tr[data-id="${id}"]`);
const input = (el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};

/* ---------- stats describe the book of business ---------- */
const statValues = $$("#customers-stats .stat-value").map((el) => el.textContent.trim());
ok(statValues[0] === "3", `Customers card should read 3, reads "${statValues[0]}"`);
ok(statValues[1] === "3", `Vehicles on File should sum to 3, reads "${statValues[1]}"`);
ok(statValues[2] === "1", `With Open ROs should count Marta only, reads "${statValues[2]}"`);
ok(statValues[3] === "1", `Missing Contact should count Ben only, reads "${statValues[3]}"`);

/* ---------- alphabetical order, not insertion order ---------- */
const names = $$("#customers-table tr[data-id] td:first-child strong").map((el) => el.textContent);
ok(names.join(" | ") === "Ada Zimm | Ben Cho | Marta Alvarez",
   `rows should sort alphabetically, got "${names.join(" | ")}"`);
ok(row(3).textContent.includes("never"), "a customer with no orders shows 'never' for last visit");
ok(row(1).textContent.includes("1 open"), "Marta's RO cell should flag her open ticket");

/* ---------- the stat cards are filters ---------- */
click(w, $('[data-customer-filter="open"]'));
ok($$("#customers-table tr[data-id]").length === 1 && row(1), "With Open ROs filters to Marta");
ok($("#customers-reset-view") && !$("#customers-reset-view").hidden, "Reset view appears while a filter is on");
click(w, $('[data-customer-filter="open"]'));
ok($$("#customers-table tr[data-id]").length === 3, "clicking the lit card again clears the filter");
click(w, $('[data-customer-filter="no_contact"]'));
ok($$("#customers-table tr[data-id]").length === 1 && row(2), "Missing Contact filters to Ben");
click(w, $("#customers-reset-view"));
ok($$("#customers-table tr[data-id]").length === 3, "Reset view clears the filter");

/* ---------- phone search matches digits however they're typed ---------- */
input($("#customers-search"), "313-555");
ok($$("#customers-table tr[data-id]").length === 1 && row(3),
   "digit search should find Ada's (313) number through the punctuation");
input($("#customers-search"), "merrill");
ok($$("#customers-table tr[data-id]").length === 1 && row(1), "city search should find Marta");
input($("#customers-search"), "zzz");
ok($("#customers-table .empty-state"), "a hopeless search shows the filtered empty state");
click(w, $("#customers-empty-clear"));
ok($$("#customers-table tr[data-id]").length === 3, "the empty state's clear button restores the list");

/* ---------- expansion: lazy fetch, vehicles, RO chips ---------- */
click(w, row(1));
await settle();
ok(detailFetches.length === 1, `expanding should fetch the detail once, fetched ${detailFetches.length}`);
const expand = $('#customers-table tr[data-expand-for="1"]');
ok(expand, "Marta's row should grow an expansion row");
ok(expand.textContent.includes("Kia") && expand.textContent.includes("Patriot"),
   "the expansion lists both vehicles");
ok(expand.querySelector('a[href="tel:2195550142"]'), "phone renders as a tel: link with bare digits");
ok(expand.querySelector('a[href="mailto:marta@example.com"]'), "email renders as a mailto: link");
const chips = [...expand.querySelectorAll(".cust-ro-chip")];
ok(chips.length === 3, `all three ROs should show as chips, got ${chips.length}`);
const jumpable = expand.querySelectorAll("button.cust-ro-chip[data-seg]");
ok(jumpable.length === 1, `only the live we-owe RO should be jumpable, got ${jumpable.length}`);
ok(expand.textContent.includes("Voided"), "the voided RO stays visible, flagged");

// Re-expanding uses the cache -- no second fetch.
click(w, row(1));
ok(!$('#customers-table tr[data-expand-for="1"]'), "clicking the open row collapses it");
click(w, row(1));
await settle();
ok(detailFetches.length === 1, "re-expanding should come from the cache, not a refetch");

/* ---------- the RO chip jumps to the vehicle detail page ---------- */
click(w, $('#customers-table button.cust-ro-chip[data-seg]'));
await settle();
ok($("#view-vehicle-detail").classList.contains("active"), "a live RO chip should land on the vehicle detail page");
ok(w.state.detail.segment === "we_owe" && w.state.detail.id === 71,
   `the detail page should be on we-owe 71, got ${w.state.detail.segment}:${w.state.detail.id}`);

/* ---------- the shared editor, reachable without a vehicle ---------- */
w.showView("customers");
await settle();
click(w, row(1));
await settle();
click(w, $(".cust-edit"));
const dialog = $("#customer-edit-dialog");
ok(dialog && dialog.open, "Edit Customer opens the shared editor dialog");
ok($("#customer-edit-name").value === "Marta Alvarez", "the editor arrives prefilled from the row");
input($("#customer-edit-city"), "Hobart");
$("#customer-edit-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(patches.length === 1 && patches[0].id === 1 && patches[0].body.city === "Hobart",
   "saving PATCHes the customer with the edited city");
ok(!dialog.open, "the dialog closes on save");
ok(row(1).textContent.includes("Hobart"), "the list row shows the new city without a full reload");

/* ---------- keyboard: /, arrows, Enter, Escape ---------- */
const kd = (key) => doc.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
kd("Escape"); // collapse the still-open expansion first
ok(!$("#customers-table tr[data-expand-for]"), "Escape collapses the open expansion");
kd("Escape"); // the click that expanded Marta also parked the cursor on her
ok(!$("#customers-table tr.cursor"), "a further Escape clears the cursor");
kd("ArrowDown");
ok(row(3).classList.contains("cursor"), "ArrowDown from nowhere lands on the first row (Ada)");
kd("ArrowDown");
ok(row(2).classList.contains("cursor"), "second ArrowDown moves to Ben");
kd("End");
ok(row(1).classList.contains("cursor"), "End jumps to the last row");
kd("Enter");
await settle();
ok($('#customers-table tr[data-expand-for="1"]'), "Enter expands the cursor row");
kd("Escape");
ok(!$("#customers-table tr[data-expand-for]"), "Escape closes it again");

ok(rejections.length === 0, `unhandled rejections: ${rejections.map(String).join("; ")}`);
finish("customers screen");
