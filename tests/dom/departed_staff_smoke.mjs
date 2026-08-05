// What a car's page shows once the technician on it has left the shop.
//
// state.staff is active-only on purpose -- somebody who has gone must not be
// offered new work. But a <select> can only show what is in it, so every
// technician picker on a car whose tech had since been deactivated fell back
// to its first option: the ticket header said "Ray / Dana" and the picker two
// lines under it said "Unassigned", about a ticket the database still had Ray
// on. Save the popover as shown and the screen would have made itself right by
// wiping him.
//
// So the person actually in the slot stays in the list, marked, and round
// trips through a save untouched. Deactivating is the only way this app has of
// retiring somebody (there is no delete, so finished work keeps their name),
// which is why this is the screen that has to tell the truth about it.

import { boot } from "./harness.mjs";

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19);

// Ray Ortiz (id 1) is gone: /api/staff no longer returns him, exactly as the
// server behaves once he's deactivated. He is still the ticket's technician
// and still owns the brake job.
const STAFF = [
  { id: 2, name: "Sam Klein", role: "technician", active: 1, open_orders: 0 },
  { id: 9, name: "Dana Whitfield", role: "advisor", active: 1, open_orders: 1 },
];

const vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "", color: "", purchase_price: 4200,
  sale_price: null, status: "in_repair", archived_at: "", edit_version: 3,
  created_at: daysAgo(30), updated_at: daysAgo(1), orders: [], total_cost: 0, quoted_cost: 0,
  profit: null, status_bucket: "in_progress",
  last_activity: { at: daysAgo(1), idle_days: 1, action: "", actor: "" },
};

const order = {
  id: 42, number: "RO-1042", concern: "Recon prep", status: "in_progress", voided: 0,
  segment: "recon", recon_vehicle_id: 7, we_owe_id: null, created_at: daysAgo(20),
  estimate: {
    id: 1, edit_version: 2,
    items: [{ id: 100, kind: "part", description: "Pads", part_number: "", quantity: 2,
              unit_price: 0, unit_cost: 30, quoted_unit_cost: 30, received_quantity: 0,
              line_total: 0, status: "quoted", job_id: 5, core_charge: 0, sort_order: 0 }],
    jobs: [{ id: 5, title: "Front brakes", technician_id: 1, technician_name: "Ray Ortiz",
             sort_order: 0, completed_at: "", completed_by: "" }],
  },
  notes: [], activity: [], inspection: null, authorization: null, invoice: null, findings: [],
  quoted_cost: 60, actual_cost: 0,
  assignment: { order_id: 42, technician_id: 1, technician_name: "Ray Ortiz",
                advisor_id: 9, advisor_name: "Dana Whitfield",
                date_in: "", odometer_in: null, promised_at: "", version: 4 },
};

const assignmentPuts = [];
const jobPuts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "openVehicleDetail", "openJobDialog"],
  fetch: async (url, opts = {}) => {
    if (url === "/api/orders/42/assignment" && opts.method === "PUT") {
      assignmentPuts.push(JSON.parse(opts.body));
      return order.assignment;
    }
    if (/^\/api\/orders\/42\/jobs\/5$/.test(url) && opts.method === "PUT") {
      jobPuts.push(JSON.parse(opts.body));
      return order.estimate.jobs[0];
    }
    if (/^\/api\/orders\/42$/.test(url)) return order;
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return STAFF;
    return [];
  },
});

await settle();
await w.openVehicleDetail("recon", 7);
await settle();

/* ---------- the ticket's own technician ---------- */
const tech = doc.querySelector("#vd-technician");
const chosen = tech.options[tech.selectedIndex];
ok(tech.value === "1", `the ticket's technician picker reads "${chosen && chosen.text}" -- the ticket is Ray's`);
ok(/Ray Ortiz/.test(chosen.text), `the departed technician's name is missing: "${chosen.text}"`);
ok(/inactive/i.test(chosen.text), `"${chosen.text}" doesn't say he has left -- it reads as somebody still on the floor`);
// The people who are still here are all still offered.
ok([...tech.options].some((o) => o.text === "Sam Klein"), "an active technician dropped out of the picker");
ok([...tech.options].filter((o) => /Ray Ortiz/.test(o.text)).length === 1, "the departed tech is listed twice");

/* An advisor who is still here must not pick up the "(inactive)" wording. */
const advisor = doc.querySelector("#vd-advisor");
ok(advisor.value === "9" && advisor.options[advisor.selectedIndex].text === "Dana Whitfield",
   `the advisor picker reads "${advisor.options[advisor.selectedIndex].text}"`);

/* ---------- the repair he owns ---------- */
const jobTech = doc.querySelector('.ei-job-tech[data-job-id="5"]');
ok(jobTech, "the repair's technician picker isn't on the page");
ok(jobTech.value === "1", `the brake job reads "${jobTech.options[jobTech.selectedIndex].text}" -- it is Ray's`);
ok(/Ray Ortiz \(inactive\)/.test(jobTech.options[jobTech.selectedIndex].text),
   `the repair's picker reads "${jobTech.options[jobTech.selectedIndex].text}"`);

/* ---------- and a save leaves him where he is ----------
   This is the whole point. A picker showing "Unassigned" would have posted
   "Unassigned", so the screen being wrong for one render was enough to lose
   who did the work. */
doc.querySelector("#vd-save-assignment").click();
await settle();
const sent = assignmentPuts.at(-1);
ok(sent && sent.technician_id === 1,
   `saving the assignment should keep the departed tech on the ticket, sent ${JSON.stringify(sent)}`);

/* Renaming the repair does the same -- it is the other everyday edit that
   used to come back "Technician is not an active technician". */
w.openJobDialog(order.estimate.jobs[0]);
await settle();
const dialogTech = doc.querySelector("#job-technician-input");
ok(dialogTech.value === "1" && /Ray Ortiz/.test(dialogTech.options[dialogTech.selectedIndex].text),
   `the rename dialog reads "${dialogTech.options[dialogTech.selectedIndex].text}" instead of the job's own tech`);
doc.querySelector("#job-title-input").value = "Front + rear brakes";
doc.querySelector("#job-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(jobPuts.at(-1) && jobPuts.at(-1).technician_id === 1,
   `renaming the repair should keep its technician, sent ${JSON.stringify(jobPuts.at(-1))}`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("vehicle detail: a technician who has left the shop stays visible, and stays on the work that is his");
