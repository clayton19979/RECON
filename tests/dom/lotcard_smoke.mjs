// Lot card smoke test.
//
// The lot card is the sheet that rides on the car -- stock number readable
// through the windshield, the work list with a tick box per repair, and never
// a dollar figure anywhere, because it sits in a window anyone on the lot can
// read. Three cars cover its three lives: a ticketed recon car (the list, done
// strikes, the parts-on-order note, and no money even though every line has a
// cost), a car nobody has written up (write-in rules and it says so), and a
// we-owe past its promised date (the promise, in words, past due). A car
// filed to History has left the lot, so its page must not offer the card.

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);
const dayOnly = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// Every line carries a real cost, so "no dollars on the card" is proven
// against a ticket that has dollars to leak.
const items = [
  { id: 1, kind: "part", description: "Windshield glass", part_number: "WG-17", quantity: 1, unit_cost: 180,
    quoted_unit_cost: 180, status: "ordered", received_quantity: 0, core_charge: 0, part_returned: 0, job_id: 11 },
  { id: 2, kind: "labor", description: "Replace front pads and rotors", part_number: "", quantity: 2, unit_cost: 0,
    quoted_unit_cost: 0, status: "quoted", received_quantity: 0, core_charge: 0, part_returned: 0, job_id: 12 },
  { id: 3, kind: "labor", description: "Wheel alignment", part_number: "", quantity: 1, unit_cost: 0,
    quoted_unit_cost: 0, status: "quoted", received_quantity: 0, core_charge: 0, part_returned: 0, job_id: null },
  { id: 4, kind: "fee", description: "Shop supplies", part_number: "", quantity: 1, unit_cost: 25,
    quoted_unit_cost: 25, status: "quoted", received_quantity: 0, core_charge: 0, part_returned: 0, job_id: null },
  { id: 5, kind: "part", description: "Compressor (sent back)", part_number: "AC-9", quantity: 1, unit_cost: 310,
    quoted_unit_cost: 310, status: "received", received_quantity: 1, core_charge: 0, part_returned: 1, job_id: null },
];

const order = {
  id: 42, number: "RO-2608-0042", ro_number: 42, concern: "Front end recon prep", status: "in_progress", voided: 0,
  segment: "recon", recon_vehicle_id: 7, we_owe_id: null, created_at: daysAgo(6),
  estimate: { id: 1, edit_version: 1, items, jobs: [
    { id: 11, title: "Windshield", technician_id: null, completed_at: null },
    { id: 12, title: "Front + rear brakes", technician_id: null, completed_at: daysAgo(1), completed_by: "Dana Ruiz" },
  ] },
  notes: [], activity: [], assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
};

const reconTicketed = {
  id: 7, stock_number: "R-1002", year: 2017, make: "Hyundai", model: "Elantra",
  vin: "5NPD84LF0HH123456", mileage: 60000, trim: "", color: "Grey", plate: "AB94421", plate_state: "IN",
  status: "in_progress", status_bucket: "in_progress", archived_at: "", edit_version: 1,
  created_at: daysAgo(20), updated_at: daysAgo(1), orders: [], total_cost: 0, quoted_cost: 0, profit: null,
  last_activity: { at: daysAgo(1), idle_days: 1, action: "parts_ordered", actor: "Dana Ruiz" },
};

const reconTicketless = {
  ...reconTicketed, id: 8, stock_number: "R-1001", year: 2018, make: "Kia", model: "Sorento",
  vin: "5XYPGDA31JG123456", plate: "", plate_state: "", color: "White", status: "acquired", status_bucket: "not_started",
};

const reconArchived = {
  ...reconTicketed, id: 9, stock_number: "R-0900", status: "sold", archived_at: daysAgo(2),
};

const weOweLate = {
  id: 3, year: 2019, make: "Toyota", model: "RAV4", vin: "", color: "Blue", plate: "", plate_state: "",
  customer_name: "Renata Silva", customer_phone: "", customer_email: "",
  description: "Touch up paint on rear bumper", status: "open", status_bucket: "not_started",
  target_date: dayOnly(7), archived_at: "", edit_version: 1, created_at: daysAgo(11), updated_at: daysAgo(11),
  orders: [], payments: [], customer_paid: 0, net_cost: 0,
  last_activity: { at: daysAgo(11), idle_days: 11, action: "created", actor: "" },
};

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "renderPrintLotCard"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) return [];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return reconTicketed;
    if (/^\/api\/recon\/vehicles\/8$/.test(url)) return reconTicketless;
    if (/^\/api\/recon\/vehicles\/9$/.test(url)) return reconArchived;
    if (/^\/api\/we-owe\/3$/.test(url)) return weOweLate;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url.startsWith("/api/staff")) return [];
    if (url.startsWith("/api/tasks")) return [];
    return [];
  },
});

await settle();

/* ---------- a ticketed recon car ---------- */
await w.openVehicleDetail("recon", 7);
await settle();

const btn = doc.querySelector("#vd-print-card");
ok(!!btn, "the Lot Card button isn't on the page at all");
ok(btn && btn.style.display !== "none", "the Lot Card button is hidden on a live recon car");

w.renderPrintLotCard();
let card = doc.querySelector("#print-report .print-lotcard");
ok(!!card, "printing the lot card rendered nothing");
const cardText = card ? card.textContent : "";

// The identity block, loudest fact first.
ok(card && card.querySelector(".lc-stock")?.textContent === "R-1002",
   "the stock number isn't the card's headline");
ok(cardText.includes("2017 Hyundai Elantra"), "the card doesn't say what car it's on");
ok(cardText.includes("Grey") && cardText.includes("AB94421"),
   "the color and plate fell off the identity line");
ok(cardText.includes("VIN …HH123456") && !cardText.includes("5NPD84LF0HH123456"),
   "the VIN prints in full -- the card carries the last 8, like the board");
ok(cardText.includes("In Progress"), "the card doesn't say where the car stands");

// The work list: jobs as lines, loose wrench lines after them, a box each.
const lines = card ? [...card.querySelectorAll(".lc-line")] : [];
ok(lines.length === 3,
   `${lines.length} lines on the card, expected 3 (two jobs + the loose alignment)`);
ok(lines.some((l) => l.textContent.includes("Windshield")), "the open job fell off the list");
const doneLine = lines.find((l) => l.textContent.includes("Front + rear brakes"));
ok(!!doneLine, "the finished job fell off the list -- 'the brakes are done' is half the story");
ok(doneLine?.classList.contains("done") && !!doneLine?.querySelector(".print-tick.ticked"),
   "the finished job doesn't read as finished (struck text, filled box)");
ok(lines.some((l) => l.textContent.includes("Wheel alignment")),
   "the wrench line that never got a job isn't on the card");
ok(!cardText.includes("Shop supplies"), "a fee line is on the windshield -- bookkeeping, not work");
ok(!cardText.includes("Compressor"), "a returned part is on the card as work the car needs");

// The one reason nobody is working on it right now.
ok(cardText.includes("1 part on order"), "the parts-on-order note is missing");

// Never a dollar figure: the sheet sits in a window.
ok(!/\$/.test(cardText), "there is a dollar figure on the lot card");
ok(cardText.includes("No pricing on this sheet"), "the footer doesn't say the pricing is elsewhere on purpose");
ok(cardText.includes("RO-2608-0042"), "the footer lost the repair order number");

// The shared print surface now belongs to the ticket page, so Reports'
// beforeprint rebuild must leave this card alone.
ok(w.state.printSurfaceOwner === "ticket", "the print surface ownership wasn't claimed");

/* ---------- a car nobody has written up ---------- */
await w.openVehicleDetail("recon", 8);
await settle();
ok(doc.querySelector("#vd-print-card").style.display !== "none",
   "the Lot Card button is hidden on a ticketless car -- that's the car that needs the sheet most");

w.renderPrintLotCard();
card = doc.querySelector("#print-report .print-lotcard");
const bareText = card ? card.textContent : "";
ok(card && card.querySelector(".lc-stock")?.textContent === "R-1001", "the ticketless card lost its stock number");
ok(bareText.includes("No ticket written yet"), "the card doesn't say the car has no ticket");
ok(bareText.includes("Acquired") && !bareText.includes("in_repair"),
   "a ticketless car's standing prints as a database word, not shop English");
ok((card?.querySelectorAll(".writein-rule").length || 0) >= 4,
   "nowhere to write what the walk-around found");
ok(!card?.querySelector(".lc-line"), "a ticketless car printed work lines from somewhere");
ok(!/\$/.test(bareText), "there is a dollar figure on the ticketless card");

/* ---------- a we-owe past its promised date ---------- */
await w.openVehicleDetail("we_owe", 3);
await settle();
w.renderPrintLotCard();
card = doc.querySelector("#print-report .print-lotcard");
const weOweText = card ? card.textContent : "";
ok(card && card.querySelector(".lc-stock")?.textContent === "WE-OWE",
   "a we-owe card doesn't announce which kind of car this is");
ok(weOweText.includes("Renata Silva"), "the customer's name fell off the we-owe card");
ok(weOweText.includes("Promised for"), "the promised date isn't on the card");
ok(/past due/i.test(weOweText) && !!card?.querySelector(".lc-promise.lc-late"),
   "a promise 7 days gone doesn't read as past due");

/* ---------- a car filed to History ---------- */
await w.openVehicleDetail("recon", 9);
await settle();
ok(doc.querySelector("#vd-print-card").style.display === "none",
   "an archived car still offers a windshield card -- it has left the lot");

ok(rejections.length === 0, `unhandled rejections: ${rejections.map((e) => e && e.message).join(", ")}`);

finish("the lot card says what the car is and needs, and never what it cost");
