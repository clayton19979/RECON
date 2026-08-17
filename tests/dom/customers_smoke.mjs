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
    we_owe_count: 2, we_owe_open: 1, last_visit_at: "2026-07-01T09:30:00" },
  { id: 2, name: "Ben Cho", phone: "", email: "",
    address_line1: "", address_line2: "", city: "Gary", state: "IN", postal_code: "",
    is_shop_owned: 0, created_at: "2026-01-05T12:00:00", vehicle_count: 1, order_count: 1, open_orders: 0,
    we_owe_count: 0, we_owe_open: 0, last_visit_at: "2026-02-14T15:00:00" },
  // Ada is the case the screen used to hide entirely: promised work, no
  // ticket ever written, so every ticket-shaped column on her row is empty.
  { id: 3, name: "Ada Zimm", phone: "(313) 555-0100", email: "",
    address_line1: "", address_line2: "", city: "", state: "", postal_code: "",
    is_shop_owned: 0, created_at: "2026-06-20T12:00:00", vehicle_count: 1, order_count: 0, open_orders: 0,
    we_owe_count: 1, we_owe_open: 1, last_visit_at: null },
];

// Marta's detail: one vehicle with a jumpable we-owe RO plus a voided one and
// two promises (one still open, one settled), a second vehicle with a retail
// RO (jumps to the vehicle's retail page; only the voided chip stays inert).
const DETAILS = {
  1: {
    ...customers[0],
    vehicles: [
      { id: 11, year: 2020, make: "Kia", model: "Soul", plate: "ABC123", plate_state: "IN", vin: "VIN0001",
        we_owe: [
          { id: 71, vehicle_id: 11, description: "Replace worn tie rod", category: "other", status: "open",
            target_date: "2026-08-15", promised_at: "", archived_at: "", created_at: "2026-06-30T09:00:00", order_count: 1 },
          { id: 70, vehicle_id: 11, description: "Second key", category: "other", status: "fulfilled",
            target_date: "", promised_at: "", archived_at: "", created_at: "2026-02-01T09:00:00", order_count: 0 },
        ],
        orders: [
          { id: 101, number: "RO-2607-0101", segment: "we_owe", status: "in_progress", voided: 0,
            created_at: "2026-07-01T09:30:00", recon_vehicle_id: null, we_owe_id: 71, concern: "Mirror" },
          { id: 100, number: "RO-2602-0100", segment: "we_owe", status: "complete", voided: 1,
            created_at: "2026-02-01T09:30:00", recon_vehicle_id: null, we_owe_id: 71, concern: "Old" },
        ] },
      { id: 12, year: 2015, make: "Jeep", model: "Patriot", plate: "", plate_state: "", vin: "",
        we_owe: [],
        orders: [
          { id: 99, number: "RO-2601-0099", segment: "retail", status: "complete", voided: 0,
            created_at: "2026-01-10T09:30:00", recon_vehicle_id: null, we_owe_id: null, concern: "Brakes" },
        ] },
    ],
  },
  3: {
    ...customers[2],
    vehicles: [
      { id: 31, year: 2019, make: "Toyota", model: "RAV4", plate: "", plate_state: "", vin: "VIN0031",
        we_owe: [
          { id: 90, vehicle_id: 31, description: "Fix the clunk", category: "other", status: "open",
            target_date: "", promised_at: "", archived_at: "", created_at: "2026-06-21T09:00:00", order_count: 0 },
        ],
        orders: [] },
    ],
  },
};

const detailFetches = [];
const patches = [];
const roPosts = [];
const vehiclePosts = [];
const decodePosts = [];

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
    // The we-owe chip jump loads the vehicle detail page -- from a ticket's
    // chip (71) or straight off a promise that has no ticket at all (90).
    if (url === "/api/we-owe/71") return { id: 71, description: "Mirror", customer_id: 1, vehicle_id: 11, status: "open", archived_at: "", edit_version: 1 };
    if (url === "/api/we-owe/90") return { id: 90, description: "Fix the clunk", customer_id: 3, vehicle_id: 31, status: "open", archived_at: "", edit_version: 1 };
    // The retail chip / Write RO jump loads the vehicle's retail page. The
    // Patriot's payload carries the Soul as the customer's other vehicle so
    // the Other Vehicles card has something to render (and to click).
    const retail = url.match(/^\/api\/retail\/vehicles\/(\d+)$/);
    if (retail) return { id: Number(retail[1]), customer_id: 1, customer_name: "Marta Alvarez", year: 2015, make: "Jeep", model: "Patriot",
      vin: "", mileage: 0, trim: "", color: "", archived_at: "", edit_version: 0, orders: [], total_cost: 0, quoted_cost: 0,
      last_activity: { at: "2026-01-10T09:30:00", idle_days: 0, action: "", actor: "" },
      other_vehicles: Number(retail[1]) === 12
        ? [{ id: 11, year: 2020, make: "Kia", model: "Soul", plate: "ABC123", plate_state: "IN", vin: "VIN0001", order_count: 2, open_orders: 1 }]
        : [] };
    if (url === "/api/vehicles/decode-vin" && opts.method === "POST") {
      decodePosts.push(JSON.parse(opts.body));
      return { vin: "1HGCM82633A004352", year: 2003, make: "HONDA", model: "Accord", trim: "EX", engine: "2.4L 4-cyl", color: "" };
    }
    if (url === "/api/vehicles" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      vehiclePosts.push(body);
      return { id: 77, ...body };
    }
    if (url === "/api/orders" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      roPosts.push(body);
      return { id: 555, number: "RO-2607-0555", ...body };
    }
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
ok(statValues[1] === "4", `Vehicles on File should sum to 4, reads "${statValues[1]}"`);
ok(statValues[2] === "1", `With Open ROs should count Marta only, reads "${statValues[2]}"`);
ok(statValues[3] === "2", `Owed a We-Owe should count Marta and Ada, reads "${statValues[3]}"`);
ok(statValues[4] === "1", `Missing Contact should count Ben only, reads "${statValues[4]}"`);
ok($('[data-customer-filter="owed"]').textContent.includes("2 promises still open"),
   "the We-Owe card counts promises, not just the people who are owed them");

/* ---------- alphabetical order, not insertion order ---------- */
const names = $$("#customers-table tr[data-id] td:first-child strong").map((el) => el.textContent);
ok(names.join(" | ") === "Ada Zimm | Ben Cho | Marta Alvarez",
   `rows should sort alphabetically, got "${names.join(" | ")}"`);
ok(row(3).textContent.includes("never"), "a customer with no orders shows 'never' for last visit");
ok(row(1).textContent.includes("1 open"), "Marta's RO cell should flag her open ticket");

/* ---------- the We-Owe column: what the shop still owes, ticket or not ----
   Ada has no repair order at all, which is exactly how the promise used to
   go missing -- every other column on her row is empty. */
const oweCell = (id) => row(id).querySelectorAll("td")[5];
ok(oweCell(3).textContent.includes("1 owed"),
   `Ada's We-Owe cell should say she is owed one, says "${oweCell(3).textContent.trim()}"`);
ok(oweCell(2).textContent.includes("—"),
   `a customer who was never promised anything shows a dash, shows "${oweCell(2).textContent.trim()}"`);
ok(oweCell(1).textContent.includes("1 owed"), "Marta's one open promise counts, her settled one doesn't");

/* ---------- the stat cards are filters ---------- */
click(w, $('[data-customer-filter="open"]'));
ok($$("#customers-table tr[data-id]").length === 1 && row(1), "With Open ROs filters to Marta");
ok($("#customers-reset-view") && !$("#customers-reset-view").hidden, "Reset view appears while a filter is on");
click(w, $('[data-customer-filter="open"]'));
ok($$("#customers-table tr[data-id]").length === 3, "clicking the lit card again clears the filter");
click(w, $('[data-customer-filter="owed"]'));
ok($$("#customers-table tr[data-id]").length === 2 && row(1) && row(3),
   "Owed a We-Owe filters to the two people the shop owes work");
click(w, $('[data-customer-filter="owed"]'));
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
ok(jumpable.length === 2, `the live we-owe and retail ROs should both be jumpable, got ${jumpable.length}`);
ok(expand.textContent.includes("Voided"), "the voided RO stays visible, flagged");
ok(expand.querySelectorAll(".cust-new-ro").length === 2, "every vehicle offers a Write RO button");

/* ---------- promises show under the car they were made about ---------- */
const oweChips = [...expand.querySelectorAll(".cust-owe-chip")];
ok(oweChips.length === 2, `both of the Soul's promises should show as chips, got ${oweChips.length}`);
ok(oweChips[0].textContent.includes("Replace worn tie rod") && oweChips[0].textContent.includes("Open"),
   "the open promise says what was promised and that it is still open");
ok(oweChips[0].textContent.includes("due Aug 15, 2026"), "a promise with a target date says when it is due");
ok(!oweChips[0].textContent.includes("no ticket yet"),
   "this promise already has a ticket, so it must not be nudged for one");
ok(oweChips[1].textContent.includes("Second key") && oweChips[1].textContent.includes("Fulfilled"),
   "a settled promise stays visible, marked settled");
const patriot = [...expand.querySelectorAll(".cust-vehicle")].find((el) => el.textContent.includes("Patriot"));
ok(patriot && !patriot.querySelector(".cust-owe-chip"), "the car nothing was promised on shows no promise chips");

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

/* ---------- a promise with no ticket is still reachable and actionable ----
   This is the whole point: Ada has no repair order, so before the promise
   chips existed there was nothing on this screen to click at all. */
w.showView("customers");
await settle();
click(w, row(3));
await settle();
const adaChip = $('#customers-table tr[data-expand-for="3"] .cust-owe-chip');
ok(adaChip, "a customer with a promise and no ticket still gets something to click");
ok(adaChip.textContent.includes("no ticket yet"),
   `an open promise nobody has written up says so, says "${adaChip.textContent.replace(/\s+/g, " ").trim()}"`);
click(w, adaChip);
await settle();
ok(w.state.detail.segment === "we_owe" && w.state.detail.id === 90,
   `the promise chip should open we-owe 90, got ${w.state.detail.segment}:${w.state.detail.id}`);

/* ---------- a retail chip jumps to the vehicle's retail page ---------- */
w.showView("customers");
await settle();
click(w, row(1));
await settle();
click(w, $('#customers-table button.cust-ro-chip[data-seg="retail"]'));
await settle();
ok($("#view-vehicle-detail").classList.contains("active"), "a retail chip should land on the vehicle detail page");
ok(w.state.detail.segment === "retail" && w.state.detail.id === 12,
   `the detail page should be on retail vehicle 12, got ${w.state.detail.segment}:${w.state.detail.id}`);
ok($("#back-to-vehicles-label").textContent === "Back to Customers",
   "the back link on a retail page points home to Customers");
ok($("#vd-archive-vehicle").style.display === "none" && $("#vd-reopen-vehicle").style.display === "none",
   "retail vehicles offer no archive/reopen -- the RO's status is the lifecycle");
ok($("#vd-we-owe-status-card").style.display === "none" && $("#vd-deposits-card").style.display === "none",
   "the we-owe promise cards stay hidden on a retail page");
ok($("#vd-customer-info-card").style.display !== "none", "the customer card shows on a retail page");

/* ---------- Other Vehicles card: the household's cars, one click apart ---------- */
const otherCard = $("#vd-other-vehicles-card");
ok(otherCard.style.display !== "none", "the Other Vehicles card shows on a retail page");
const otherRow = $("#vd-other-vehicles .mini-item");
ok(otherRow && otherRow.textContent.includes("Kia Soul"), "the card lists the customer's other car");
ok(otherRow.textContent.includes("2 ROs · 1 open"),
   `the pill answers hop-or-not with RO counts, got "${otherRow?.textContent.trim()}"`);
ok(otherRow.textContent.includes("ABC123 (IN)") && otherRow.textContent.includes("VIN0001"),
   "plate and VIN identify which car this is");
click(w, otherRow);
await settle();
ok(w.state.detail.segment === "retail" && w.state.detail.id === 11,
   `clicking the row should land on the Soul's retail page, got ${w.state.detail.segment}:${w.state.detail.id}`);
ok($("#vd-other-vehicles").textContent.includes("No other vehicles on file"),
   "an empty list still shows the card with its empty state (the Add button is its other job)");

/* ---------- Add Vehicle from the retail page -> the new car's page ---------- */
click(w, $("#vd-add-other-vehicle"));
const addDialog = $("#vehicle-add-dialog");
ok(addDialog && addDialog.open, "+ Add Vehicle opens the dialog");
ok($("#vehicle-add-customer").textContent === "Marta Alvarez", "the dialog names the customer");

/* ---------- Decode VIN: the dash plate types the car for you ----------
   Same decoder the intake and edit dialogs have. The button lights up the
   moment the VIN proves its check digit while make/model are still empty,
   and one click fills year/make/model. */
const decodeBtn = $("#vehicle-add-decode-vin");
ok(decodeBtn && !decodeBtn.classList.contains("btn-decode-ready"),
   "an empty form should leave the Decode button at rest");
input($("#vehicle-add-vin"), "1hgcm82633a004352");
ok($("#vehicle-add-vin").value === "1HGCM82633A004352", "the VIN box masks to the stored shape");
ok($("#vehicle-add-vin-verdict").classList.contains("ok"),
   "a VIN whose check digit works out should say so here too");
ok(decodeBtn.classList.contains("btn-decode-ready"),
   "a proven VIN over an empty make/model should light up Decode VIN");
click(w, decodeBtn);
await settle();
ok(decodePosts.length === 1 && decodePosts[0].vin === "1HGCM82633A004352",
   `the decode POST carries the VIN, got ${JSON.stringify(decodePosts)}`);
ok($("#vehicle-add-year").value === "2003" && $("#vehicle-add-make").value === "HONDA"
   && $("#vehicle-add-model").value === "Accord",
   `decoding fills year/make/model, got "${$("#vehicle-add-year").value} ${$("#vehicle-add-make").value} ${$("#vehicle-add-model").value}"`);
ok(!decodeBtn.classList.contains("btn-decode-ready"),
   "a filled make/model puts the Decode button back to rest");

input($("#vehicle-add-year"), "2020");
input($("#vehicle-add-make"), "Ford");
input($("#vehicle-add-model"), "F-150");
input($("#vehicle-add-plate"), "trk 42");
ok($("#vehicle-add-plate").value === "TRK42", "plate uppercases and strips as you type");
input($("#vehicle-add-plate-state"), "mi");
ok($("#vehicle-add-plate-state").value === "MI", "plate state uppercases");
$("#vehicle-add-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(vehiclePosts.length === 1 && vehiclePosts[0].customer_id === 1 && vehiclePosts[0].make === "Ford" && vehiclePosts[0].plate === "TRK42",
   `the POST carries the customer and the car, got ${JSON.stringify(vehiclePosts[0])}`);
ok(!addDialog.open, "the dialog closes after adding");
ok(w.state.detail.segment === "retail" && w.state.detail.id === 77,
   "the advisor lands on the new car's page (where Start Repair Order is the next click)");

/* ---------- Write RO: dialog -> POST -> the new ticket's page ---------- */
w.showView("customers");
await settle();
click(w, row(1));
await settle();
// The Patriot is owed nothing, so the promise reminder must stay out of the way.
click(w, $('.cust-new-ro[data-vehicle-id="12"]'));
ok($("#retail-ro-owe-note").hidden, "no promise on this car means no reminder in the dialog");
$("#retail-ro-dialog").close();

click(w, $('.cust-new-ro[data-vehicle-id="11"]'));
const roDialog = $("#retail-ro-dialog");
ok(roDialog && roDialog.open, "Write RO opens the dialog");
ok($("#retail-ro-customer").textContent === "Marta Alvarez", "the dialog names the customer");
ok($("#retail-ro-vehicle").textContent.includes("Kia Soul"), "the dialog names the vehicle");
// Writing promised work as retail bills it at the wrong price on the wrong
// side and leaves the promise open forever. It stays allowed -- a customer
// who is owed a tie rod can still pay for brakes -- but it gets said out loud.
ok(!$("#retail-ro-owe-note").hidden && $("#retail-ro-owe-note").textContent.includes("Replace worn tie rod"),
   "a car that is still owed something names the promise before a retail ticket is written");
ok(!$("#retail-ro-owe-note").textContent.includes("Second key"),
   "a promise already kept is not something to warn about");
input($("#retail-ro-concern"), "Brakes grinding");
$("#retail-ro-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(roPosts.length === 1 && roPosts[0].segment === "retail" && roPosts[0].customer_id === 1 && roPosts[0].vehicle_id === 11,
   `the POST carries segment/customer/vehicle, got ${JSON.stringify(roPosts[0])}`);
ok(!roDialog.open, "the dialog closes after starting the RO");
ok(w.state.detail.segment === "retail" && w.state.detail.id === 11,
   "the advisor lands on the new ticket's vehicle page");
ok(!(1 in w.state.customerDetails), "the cached expansion is dropped -- its RO list is stale now");

/* ---------- Add Vehicle from the Customers expansion ---------- */
w.showView("customers");
await settle();
click(w, row(1));
await settle();
ok($("#customers-table .cust-add-vehicle"), "the expansion offers + Add Vehicle");
click(w, $("#customers-table .cust-add-vehicle"));
ok(addDialog.open, "it opens the same dialog");
ok($("#vehicle-add-customer").textContent === "Marta Alvarez", "prefilled with the row's customer");
ok($("#vehicle-add-make").value === "", "the form arrives blank, not with the last car's values");
ok($("#vehicle-add-vin-verdict").hidden && !$("#vehicle-add-decode-vin").classList.contains("btn-decode-ready"),
   "the last car's VIN verdict and lit Decode button don't greet the next one");
input($("#vehicle-add-year"), "2012");
input($("#vehicle-add-make"), "Honda");
input($("#vehicle-add-model"), "Odyssey");
$("#vehicle-add-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(vehiclePosts.length === 2 && vehiclePosts[1].model === "Odyssey",
   `the second POST carries the van, got ${JSON.stringify(vehiclePosts[1])}`);
ok(row(1).querySelectorAll("td")[3].textContent.includes("3"),
   "the list row's vehicle count bumps without a full reload");
ok($('#customers-table tr[data-expand-for="1"]'), "the expansion stays open, refreshed");

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
// A mangled email must not save -- same deal as a bad phone or ZIP.
input($("#customer-edit-email"), "marta at example");
$("#customer-edit-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(patches.length === 0 && dialog.open, "an email without a name@domain shape blocks the save");
input($("#customer-edit-email"), "marta@newmail.com");
$("#customer-edit-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(patches.length === 1 && patches[0].id === 1 && patches[0].body.city === "Hobart" && patches[0].body.email === "marta@newmail.com",
   "saving PATCHes the customer with the edited city and the corrected email");
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
