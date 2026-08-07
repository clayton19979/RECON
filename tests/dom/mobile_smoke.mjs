// Phone app smoke test.
//
// The phone is a second front end over the same API, and the thing that would
// make it worse than useless is disagreeing with the desk about a car. So the
// assertions here are mostly about *not re-deriving*: the four piles come from
// the server's lot_bucket, the "still needs" sentence is printed verbatim, and
// a parts line is priced off unit_cost -- never unit_price, which is a
// shared-schema leftover that is always 0 on recon work and would render every
// outstanding part as free.
//
// The one write the phone is allowed to make -- ticking a repair off from
// under the hood -- is driven end to end.

import { boot, flatMobileJs, mobileHtml } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

const board = [
  { segment: "recon", recon_id: 1, we_owe_id: null, stock_number: "R-1001", vehicle: "2018 Kia Sorento",
    vin: "KNDPB3AC4J7123456", color: "Silver", plate: "TK7Q419", plate_state: "IN", status: "acquired",
    status_bucket: "in_progress", lot_bucket: "waiting", needs: "No ticket written yet", actual_cost: 0,
    quoted_cost: 0, age_days: 16, idle_days: 14, ro_number: 0, order_id: null, technicians: [] },
  { segment: "recon", recon_id: 2, we_owe_id: null, stock_number: "R-1002", vehicle: "2017 Hyundai Elantra",
    vin: "5NPD84LF0HH123456", color: "Grey", plate: "AB94421", plate_state: "IN", status: "in_progress",
    status_bucket: "in_progress", lot_bucket: "working", needs: "Windshield, Front + rear brakes (1 of 3 done)",
    actual_cost: 240, quoted_cost: 420, age_days: 28, idle_days: 6, ro_number: 8, order_id: 8, technicians: ["Ray Ortiz"] },
  { segment: "we_owe", recon_id: null, we_owe_id: 5, stock_number: "", vehicle: "2019 Toyota RAV4",
    vin: "", color: "Blue", plate: "", plate_state: "", customer_name: "Renata Silva", status: "open",
    status_bucket: "in_progress", lot_bucket: "working", needs: "8 days past the promised date", actual_cost: 0,
    quoted_cost: 0, age_days: 11, idle_days: 11, ro_number: 0, order_id: null, technicians: [] },
  { segment: "recon", recon_id: 3, we_owe_id: null, stock_number: "R-0997", vehicle: "2016 Ford Fusion",
    vin: "3FA6P0H74GR123456", color: "White", plate: "", plate_state: "", status: "complete",
    status_bucket: "finished", lot_bucket: "ready", needs: "Ready to go", actual_cost: 610, quoted_cost: 610,
    age_days: 40, idle_days: 3, ro_number: 9, order_id: 9, technicians: [] },
  // A bucket nobody recognises. It must land somewhere visible rather than
  // dropping off the lot silently -- the same rule the desktop board follows.
  { segment: "recon", recon_id: 4, we_owe_id: null, stock_number: "R-0955", vehicle: "2014 Buick Verano",
    vin: "", color: "", plate: "", plate_state: "", status: "acquired", status_bucket: "in_progress",
    lot_bucket: "wat", needs: "No ticket written yet", actual_cost: 0, quoted_cost: 0,
    age_days: 4, idle_days: 1, ro_number: 0, order_id: null, technicians: [] },
];

// unit_price is 0 on every line, exactly as the real database has it. If the
// phone reads that field the parts section prints $0.00 and quietly says the
// shop owes nothing.
const items = [
  { id: 1, kind: "part", description: "Windshield", part_number: "WG-17", quantity: 1, unit_price: 0,
    unit_cost: 180, quoted_unit_cost: 180, status: "ordered", received_quantity: 0, received_cost: 0,
    core_charge: 0, part_returned: 0, job_id: 11 },
  { id: 2, kind: "part", description: "Brake pads + rotors", part_number: "BR-4", quantity: 4, unit_price: 0,
    unit_cost: 60, quoted_unit_cost: 60, status: "quoted", received_quantity: 0, received_cost: 0,
    core_charge: 0, part_returned: 0, job_id: 12 },
  // Already landed: not news, must not be listed as outstanding.
  { id: 3, kind: "part", description: "Wiper blades", part_number: "WB-1", quantity: 1, unit_price: 0,
    unit_cost: 22, quoted_unit_cost: 22, status: "received", received_quantity: 1, received_cost: 22,
    core_charge: 0, part_returned: 0, job_id: null },
  // Sent back to the vendor: not money the shop is going to spend.
  { id: 4, kind: "part", description: "Compressor (returned)", part_number: "AC-9", quantity: 1, unit_price: 0,
    unit_cost: 310, quoted_unit_cost: 310, status: "received", received_quantity: 1, received_cost: 310,
    core_charge: 0, part_returned: 1, job_id: null },
];

const jobs = [
  { id: 11, estimate_id: 8, title: "Windshield", technician_id: null, technician_name: "Ray Ortiz", completed_at: "", completed_by: "" },
  { id: 12, estimate_id: 8, title: "Front + rear brakes", technician_id: null, technician_name: "Ray Ortiz", completed_at: "", completed_by: "" },
  { id: 13, estimate_id: 8, title: "Detail", technician_id: null, technician_name: null, completed_at: daysAgo(3), completed_by: "Ray Ortiz" },
];

const order = {
  id: 8, number: "RO-2608-0008", ro_number: 8, status: "in_progress", voided: 0, segment: "recon",
  recon_vehicle_id: 2, we_owe_id: null, concern: "Recon prep", created_at: daysAgo(28),
  estimate: { id: 8, edit_version: 1, items, jobs },
  notes: [{ id: 1, text: "Auction buy, needs brakes.", actor: "Antonio", created_at: daysAgo(2) }],
  activity: [], assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
};

const reconDetail = {
  id: 2, stock_number: "R-1002", year: 2017, make: "Hyundai", model: "Elantra", vin: "5NPD84LF0HH123456",
  mileage: 84500, color: "Grey", plate: "AB94421", plate_state: "IN", engine: "2.0L", notes: "",
  acquisition_date: "2026-07-10", total_cost: 240, quoted_cost: 420, status: "in_progress",
  status_bucket: "in_progress", orders: [{ id: 8, voided: 0, number: "RO-2608-0008", ro_number: 8 }],
};

const tasks = [
  { id: 1, title: "Call about the coil estimate", assigned_to: ["Antonio"], due_date: "2026-07-23", urgent: 1, done: 0, order_label: "R-1002", completed_at: "" },
  { id: 2, title: "Restock brake cleaner", assigned_to: [], due_date: "", urgent: 0, done: 0, order_label: "", completed_at: "" },
  // Somebody else's. The phone shows yours and the shop's, not everybody's.
  { id: 3, title: "Reconcile the NAPA statement", assigned_to: ["Dana Whitfield"], due_date: "", urgent: 0, done: 0, order_label: "", completed_at: "" },
];

const patched = [];

const handler = (url, opts) => {
  if (opts.method === "PATCH" && /\/jobs\/\d+\/done$/.test(url)) {
    const body = JSON.parse(opts.body);
    patched.push({ url, body });
    const id = Number(url.match(/\/jobs\/(\d+)\/done/)[1]);
    const job = jobs.find((j) => j.id === id);
    job.completed_at = body.done ? daysAgo(0) : "";
    job.completed_by = body.done ? body.actor || "" : "";
    return job;
  }
  if (url.startsWith("/api/staff")) return [{ id: 1, name: "Antonio", role: "advisor", active: 1 }, { id: 2, name: "Dana Whitfield", role: "manager", active: 1 }];
  if (url.startsWith("/api/vehicles-board")) return board;
  if (url.startsWith("/api/recon/vehicles/2")) return reconDetail;
  if (url.startsWith("/api/orders/8")) return order;
  if (url.startsWith("/api/tasks")) return tasks;
  return null;
};

const { w, doc, settle, ok, finish, fetchLog } = await boot({
  fetch: handler,
  html: mobileHtml(),
  js: flatMobileJs(),
  beforeBoot: (win) => {
    win.localStorage.setItem("dao-current-user", "Antonio");
    win.localStorage.setItem("dao-theme", "cobalt");
  },
});

await settle(12);

/* ---------- the lot ---------- */

const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

ok(doc.documentElement.getAttribute("data-theme") === "cobalt",
   "the phone should open in the theme the desk is set to");

ok(fetchLog.some((f) => f.url === "/api/vehicles-board?view=active"),
   `the lot should ask for the active board, asked: ${fetchLog.map((f) => f.url).join(", ")}`);

const piles = [...doc.querySelectorAll(".m-pile")].map((p) => ({
  key: p.dataset.pile,
  label: text(p.querySelector("h2")),
  count: Number(text(p.querySelector(".m-pile-count"))),
}));
ok(piles.length === 4, `four piles, got ${piles.length}`);
ok(piles.map((p) => p.key).join(",") === "waiting,working,ready,settled",
   `piles in the order a car moves through them, got ${piles.map((p) => p.key).join(",")}`);
ok(piles[0].label === "Not started" && piles[3].label === "Finished — file away",
   `piles keep the board's wording, got ${piles.map((p) => p.label).join(" / ")}`);

// One waiting, three working (two real plus the unknown bucket), one ready.
ok(piles[0].count === 1, `waiting should hold 1, got ${piles[0].count}`);
ok(piles[1].count === 3, `an unrecognised bucket must land in the middle pile, got ${piles[1].count}`);
ok(piles[2].count === 1, `ready should hold 1, got ${piles[2].count}`);
ok(piles[3].count === 0, `settled should be empty, got ${piles[3].count}`);
ok(text(doc.querySelector('.m-pile[data-pile="settled"] .m-pile-blank')) === "Nothing waiting to be filed.",
   "an empty pile still prints, with the board's own blank line");

const cards = [...doc.querySelectorAll(".m-car")];
ok(cards.length === 5, `every car on the board gets a card, got ${cards.length}`);
ok(cards.some((c) => text(c).includes("Windshield, Front + rear brakes (1 of 3 done)")),
   "the server's 'still needs' sentence is printed as written");
ok(!text(doc.body).includes("undefined") && !text(doc.body).includes("NaN"),
   "no undefined or NaN anywhere on the lot");

const weowe = doc.querySelector('.m-car[data-segment="we_owe"]');
ok(weowe && text(weowe).includes("We-Owe") && text(weowe).includes("Renata Silva"),
   "a we-owe card is marked as one and names the customer");
ok(weowe && weowe.dataset.kind === "we_owe", "a we-owe card opens the we-owe record, not a recon one");

// $240 spent against $420 written up -- the money the board shows.
const elantra = cards.find((c) => text(c).includes("R-1002"));
ok(text(elantra).includes("$240.00"), `the card shows what was spent, got: ${text(elantra)}`);

/* ---------- one car ---------- */

elantra.click();
await settle(12);

ok(doc.body.dataset.screen === "car", "tapping a card opens the car");
ok(text(doc.querySelector(".m-detail-name")) === "2017 Hyundai Elantra", "the car is named");
ok(text(doc.querySelector(".m-detail-sub")).includes("84,500 mi"), "mileage reads as miles, with a thousands separator");
ok(text(doc.querySelector(".m-detail-spend-value")) === "$240.00", "the big number is what the car has cost");
ok(text(doc.querySelector(".m-detail-head")).includes("written up $420.00"),
   "and what was written up, because the two differ here");

const partsText = text([...doc.querySelectorAll(".m-sec")].find((s) => text(s).startsWith("Parts not here yet")));
ok(partsText.includes("$180.00"), `an outstanding part is priced off unit_cost, got: ${partsText}`);
ok(partsText.includes("$240.00"), `four rotors at $60 is $240 outstanding, got: ${partsText}`);
ok(!partsText.includes("Wiper blades"), "a part that has landed is not still 'not here yet'");
ok(!partsText.includes("Compressor"), "a part sent back to the vendor is not money the shop will spend");
ok(!partsText.includes("$0.00"), "no line prices itself at nothing");

const jobRows = [...doc.querySelectorAll(".m-job")];
ok(jobRows.length === 3, `every repair on the ticket is listed, got ${jobRows.length}`);
ok(jobRows[2].dataset.done === "1" && text(jobRows[2]).includes("Ray Ortiz"),
   "a finished repair shows as done, and who did it");

/* ---------- the one write the phone makes ---------- */

jobRows[0].click();
await settle(14);

ok(patched.length === 1, `ticking a repair saves it once, got ${patched.length}`);
ok(patched[0].url === "/api/orders/8/jobs/11/done", `...to the right ticket and repair, got ${patched[0].url}`);
ok(patched[0].body.done === true, "...as done");
ok(patched[0].body.actor === "Antonio",
   `...recorded against whoever is holding the phone, got ${JSON.stringify(patched[0].body.actor)}`);

const afterTick = [...doc.querySelectorAll(".m-job")];
ok(afterTick[0].dataset.done === "1", "and the row redraws as done only once the shop PC agrees");

/* Going back must re-read the lot. The card you are returning to is the one
   you just changed -- its "still needs" sentence and its done-count are stale
   the moment the tick lands, and a stale card is the phone disagreeing with
   the desk about the car in front of you. */
const boardCalls = () => fetchLog.filter((f) => f.url === "/api/vehicles-board?view=active").length;
const beforeBack = boardCalls();
doc.querySelector("#m-back").click();
await settle(12);
ok(doc.body.dataset.screen === "lot", "back returns to the lot");
ok(boardCalls() > beforeBack, "back re-reads the lot rather than revealing the stale one behind it");

/* ---------- follow-ups ---------- */

doc.querySelector('.m-tab[data-tab="tasks"]').click();
await settle(12);

const taskRows = [...doc.querySelectorAll(".m-task")];
ok(taskRows.length === 2, `mine plus the shop's, not everybody's -- got ${taskRows.length}`);
ok(taskRows.every((t) => !text(t).includes("NAPA statement")), "somebody else's follow-up stays off my phone");
ok(text(taskRows[0]).includes("Overdue"), "a follow-up past its date says so");
ok(taskRows[0].dataset.urgent === "1", "an urgent one is marked urgent");

/* ---------- the frame ---------- */

ok(doc.querySelectorAll(".m-tab").length === 3, "three tabs");
doc.querySelector('.m-tab[data-tab="lot"]').click();
await settle(4);
ok(doc.body.dataset.screen === "lot", "the tab bar gets back to the lot");

finish("mobile");
