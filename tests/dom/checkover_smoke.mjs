// The check-over sheet: the walk around the car, on the ticket.
//
// The inspection tables and PUT endpoint predate this screen by the app's
// whole life, so the contract worth driving is the wiring between them: the
// sheet starts as one quiet line, Start lays down the standard walk, answers
// and notes autosave as ONE debounced PUT shaped the way InspectionIn expects,
// a flagged line files itself onto the ticket as a job without losing the tick
// that earned it, and Finish folds everything to the verdict while keeping
// only the flagged lines on screen.

import { boot, click } from "./harness.mjs";

const vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "EX-L", color: "Grey",
  plate: "", plate_state: "", purchase_price: null, sale_price: null,
  status: "in_repair", archived_at: "", edit_version: 1,
  created_at: "2026-07-01T09:00:00", updated_at: "2026-07-20T09:00:00",
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
  last_activity: null,
};

const order = {
  id: 42, number: "RO-1042", concern: "Front end recon prep", status: "in_progress",
  voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: "2026-07-02T09:00:00",
  estimate: { id: 1, items: [], jobs: [] },
  notes: [], activity: [], assignment: null, inspection: null, authorization: null,
  invoice: null, findings: [], quoted_cost: 0, actual_cost: 0,
};

const inspectionPuts = [];
const jobPosts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail"],
  fetch: async (url, opts = {}) => {
    if (/^\/api\/orders\/42\/inspection$/.test(url) && opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      inspectionPuts.push(body);
      // Persist like the real server: the next GET of the order carries the
      // sheet back, which is exactly what the post-Write-it-up reload leans on.
      order.inspection = { id: 1, order_id: 42, status: body.status, updated_at: "2026-08-06T19:00:00", items: body.items };
      return order.inspection;
    }
    if (/^\/api\/orders\/42\/jobs$/.test(url) && opts.method === "POST") {
      jobPosts.push(JSON.parse(opts.body));
      return { id: 6, title: JSON.parse(opts.body).title, technician_id: null, technician_name: "" };
    }
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return [];
    return [];
  },
});

await settle();
await w.openVehicleDetail("recon", 7);
await settle();

/* ---------- untouched, the card is one quiet line ---------- */
const card = doc.querySelector("#vd-checkover-card");
ok(card && card.style.display !== "none", "the check-over card should be on a ticket's page");
const startBtn = doc.querySelector("#vd-checkover-start");
ok(startBtn, "an unstarted sheet should offer exactly a start button");
ok(doc.querySelectorAll(".chk-row").length === 0, "no rows should render before the sheet is started");

/* ---------- Start lays down the standard walk ---------- */
click(w, startBtn);
await settle();
const rows = [...doc.querySelectorAll(".chk-row")];
ok(rows.length >= 14, `the standard sheet should be a real walk (${rows.length} rows)`);
const groups = [...doc.querySelectorAll(".chk-group-head")].map((el) => el.textContent);
ok(groups.join("|") === "Road test|Under the hood|Walk-around|Inside",
   `the groups should be the walk in order, got ${groups.join("|")}`);

/* ---------- answers and notes ride one debounced PUT ---------- */
const byName = (name) => [...doc.querySelectorAll(".chk-row")].find((r) => r.querySelector(".chk-name").textContent === name);
click(w, byName("Brakes feel").querySelector(".chk-red"));
await settle();
click(w, byName("Starts & idles").querySelector(".chk-green"));
await settle();
const note = byName("Brakes feel").querySelector(".chk-note");
note.value = "Metal to metal";
note.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(byName("Brakes feel").classList.contains("flagged-red"), "a Fix answer should flag its row");
ok(!byName("Brakes feel").querySelector(".chk-writeup").hidden, "a flagged row should offer Write it up");
ok(byName("Starts & idles").querySelector(".chk-green").classList.contains("on"), "a Good answer should read as pressed");
ok(inspectionPuts.length === 0, "clicks inside the debounce window must not each fire a save");

// Let the debounce fire. The window is 700ms of quiet; on a loaded machine
// (the full check runs every suite at once) timers land late, so this waits
// for the save itself rather than a fixed count of milliseconds.
for (let waited = 0; inspectionPuts.length === 0 && waited < 8000; waited += 100) {
  await new Promise((r) => setTimeout(r, 100));
}
await settle();
ok(inspectionPuts.length === 1, `the run of answers should save as one PUT, got ${inspectionPuts.length}`);
const put1 = inspectionPuts[0];
ok(put1 && put1.status === "draft", "an unfinished sheet saves as a draft");
const savedBrakes = put1.items.find((it) => it.name === "Brakes feel");
ok(savedBrakes && savedBrakes.condition === "red" && savedBrakes.notes === "Metal to metal",
   "the payload should carry the answer and the note exactly as typed");
ok(put1.items.every((it) => ["green", "yellow", "red", "not_checked"].includes(it.condition)),
   "every item must speak the server's condition vocabulary");

/* ---------- pressing the same answer again takes it back ---------- */
click(w, byName("Starts & idles").querySelector(".chk-green"));
await settle();
ok(!byName("Starts & idles").querySelector(".chk-green").classList.contains("on"),
   "pressing the pressed answer should clear it back to unchecked");

/* ---------- a flagged line files onto the ticket as a job ---------- */
click(w, byName("Brakes feel").querySelector(".chk-writeup"));
await settle();
ok(jobPosts.length === 1, "Write it up should post exactly one job");
ok(jobPosts[0] && jobPosts[0].title === "Brakes feel — Metal to metal",
   `the job should carry the line and its note, got "${jobPosts[0] && jobPosts[0].title}"`);

/* ---------- your own line joins the sheet ---------- */
const addName = doc.querySelector("#vd-checkover-add-name");
addName.value = "Sunroof drains";
doc.querySelector("#vd-checkover-add").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(byName("Sunroof drains"), "a typed line should land on the sheet");
ok([...doc.querySelectorAll(".chk-group-head")].some((el) => el.textContent === "More checks"),
   "hand-typed lines get their own group");

/* ---------- Finish folds the sheet to its verdict ---------- */
click(w, doc.querySelector("#vd-checkover-finish"));
await settle();
const summary = doc.querySelector(".chk-summary");
ok(summary, "finishing should fold the sheet to a summary");
ok(summary && summary.textContent.includes("1 to fix"), "the verdict should count what was flagged");
ok([...doc.querySelectorAll(".chk-summary-name")].map((el) => el.textContent).join("|") === "Brakes feel",
   "only the flagged lines stay on screen once the sheet is finished");
ok(!doc.querySelector("#vd-checkover-reopen").hidden, "a finished sheet should offer to reopen");
const lastPut = inspectionPuts[inspectionPuts.length - 1];
ok(lastPut && lastPut.status === "completed", "finishing must save the sheet as completed");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("check-over: the walk around the car lives on the ticket");
