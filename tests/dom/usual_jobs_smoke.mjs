// Add Job dialog: the shop's usual jobs as one-click fills.
//
// The dialog has always been a bare "type the name" form, and the names typed
// into it are the same handful all year. The chips under the input come from
// /api/jobs/usual-titles -- the shop's own most-written names -- and clicking
// one fills the input. Worth driving in a real DOM because the whole feature
// is wiring: the fetch lands after the dialog is already open, a rename must
// never show the chips, and a chip click has to fill the form without
// submitting it (a stray implicit submit here would write a job on a real
// ticket the moment somebody clicked a suggestion).

import { boot } from "./harness.mjs";

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
  estimate: { id: 1, items: [], jobs: [{ id: 5, title: "Front Brakes", technician_id: null, technician_name: "", sort_order: 0, completed_at: "", completed_by: "" }] },
  notes: [], activity: [], assignment: null, inspection: null, authorization: null,
  invoice: null, findings: [], quoted_cost: 0, actual_cost: 0,
};

const USUAL = ["Front Brakes", "Oil Change", "Windshield"];
let usualCalls = 0;
const jobPosts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "openJobDialog"],
  fetch: async (url, opts = {}) => {
    if (url === "/api/jobs/usual-titles") { usualCalls += 1; return USUAL; }
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

/* ---------- adding a job offers the usual names ---------- */
w.openJobDialog();
await settle();

const usualBox = doc.querySelector("#job-usual");
ok(usualBox && !usualBox.hidden, "the usual-jobs section should be visible when adding a job");
const chips = [...doc.querySelectorAll("#job-usual-grid .job-usual-chip")];
ok(chips.length === USUAL.length, `expected ${USUAL.length} chips, found ${chips.length}`);
ok(chips.map((c) => c.textContent) .join("|") === USUAL.join("|"),
   `chips should carry the shop's own names in order, got ${chips.map((c) => c.textContent).join("|")}`);

/* ---------- a click fills the form and submits nothing ---------- */
chips[1].click();
await settle();
ok(doc.querySelector("#job-title-input").value === "Oil Change",
   `clicking a chip should fill the name box, it reads "${doc.querySelector("#job-title-input").value}"`);
ok(chips[1].classList.contains("active") && !chips[0].classList.contains("active"),
   "the clicked chip should read as the chosen one");
ok(jobPosts.length === 0, "clicking a chip must not save the job by itself");

/* ---------- renaming shows no suggestions ---------- */
const callsBefore = usualCalls;
w.openJobDialog(order.estimate.jobs[0]);
await settle();
ok(usualBox.hidden, "the usual-jobs section should stay hidden while renaming");
ok(usualCalls === callsBefore, "a rename should not fetch suggestions at all");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("add job: the shop's usual jobs are one click away, and only when adding");
