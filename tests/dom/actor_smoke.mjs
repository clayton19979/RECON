// Who did it: attribution smoke test.
//
// One shop PC, two people. The server writes an `actor` onto every logged
// event and the ticket's history prints it back as the person who did it, so
// "who received these parts" and "who ticked this repair off" are questions
// the app is supposed to answer. It didn't:
//
//   - Getting the name onto the request was left to each call site. About a
//     dozen writes sent it and the rest -- opening a ticket, adding or
//     ticking off a job, saving the assignment, the estimate autosave --
//     sent nothing, so the server stored its own placeholder and the log read
//     "Ticket opened by ui".
//   - The picker in the header defaulted to the word "Unspecified" and the
//     front end sent *that* as the name, so the ones that did send something
//     filed the work under a colleague who doesn't exist.
//
// Both halves are asserted here: what goes on the wire (core.js attaches the
// name once, for every write) and what comes back on screen (a placeholder
// captions nothing rather than captioning a person).

import { boot } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

const STAFF = [
  { id: 1, name: "Antonio Reyes", role: "technician", active: 1 },
  { id: 2, name: "Clayton Swallow", role: "advisor", active: 1 },
];

const vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "", color: "", purchase_price: null,
  sale_price: null, status: "in_repair", archived_at: "", edit_version: 1,
  created_at: daysAgo(30), updated_at: daysAgo(0),
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
  // The server's placeholder, verbatim: this is what a request that never
  // said who it was gets recorded as.
  last_activity: { at: daysAgo(2), idle_days: 2, action: "assignment_updated", actor: "ui" },
};

const order = {
  id: 42, number: "RO-1042", ro_number: "RO-2608-0042", concern: "Recon prep",
  status: "in_progress", voided: 0, segment: "recon", recon_vehicle_id: 7, we_owe_id: null,
  created_at: daysAgo(20),
  estimate: {
    id: 1, edit_version: 1, labor_rate: 0, tax_rate: 0, items: [],
    jobs: [
      // Finished by a real person, and finished by nobody-in-particular.
      { id: 1, title: "Front brakes", technician_id: null, completed_at: daysAgo(1), completed_by: "Antonio Reyes" },
      { id: 2, title: "Windshield", technician_id: null, completed_at: daysAgo(1), completed_by: "ui" },
    ],
  },
  purchase_orders: [],
  notes: [
    { id: 1, text: "Customer heard a clunk", visibility: "internal", actor: "Antonio Reyes", created_at: daysAgo(3) },
    { id: 2, text: "Left a message", visibility: "internal", actor: "ui", created_at: daysAgo(2) },
    { id: 3, text: "Second key is in the drawer", visibility: "internal", actor: "Unspecified", created_at: daysAgo(1) },
  ],
  activity: [
    { id: 1, action: "order_created", actor: "ui", details: {}, created_at: daysAgo(20) },
    { id: 2, action: "parts_received", actor: "Antonio Reyes", details: {}, created_at: daysAgo(3) },
    { id: 3, action: "assignment_updated", actor: "Unspecified", details: {}, created_at: daysAgo(2) },
  ],
  assignment: null, inspection: null, authorization: null, invoice: null, findings: [],
  quoted_cost: 0, actual_cost: 0,
};

/** Boot the app with or without a name remembered in this browser. */
async function bootAs(who) {
  const writes = [];
  const booted = await boot({
    expose: ["state", "openVehicleDetail", "post", "patch", "put", "withActorParam"],
    beforeBoot: (w) => {
      if (who) w.localStorage.setItem("dao-current-user", who);
      else w.localStorage.removeItem("dao-current-user");
    },
    fetch: async (url, opts = {}) => {
      if (opts.method !== "GET") {
        writes.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      }
      if (url.startsWith("/api/staff")) return STAFF;
      if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
      if (/^\/api\/orders\/42$/.test(url)) return order;
      if (url === "/api/orders" || url.startsWith("/api/orders?")) return [order];
      if (url.startsWith("/api/vehicles-board")) return [];
      if (url === "/api/tasks") return [];
      return [];
    },
  });
  return { ...booted, writes };
}

/* ================================================================
   Somebody has said who they are
   ================================================================ */
const named = await bootAs("Antonio Reyes");
await named.settle();
const ok = named.ok;
const doc = named.doc;

ok(named.w.state.currentUser === "Antonio Reyes",
   `the remembered name should be in state, got "${named.w.state.currentUser}"`);
ok(doc.querySelector("#current-user").value === "Antonio Reyes",
   "the header picker should show the remembered name once the staff list lands");
ok(!doc.querySelector("#whoami").classList.contains("whoami-unset"),
   "the picker should not be flagged once somebody has claimed it");

/* ---------- every write carries the name, without the call site saying so ----------
   These are the exact shapes the app sends: a status change, a note, ticking
   a repair off, saving the assignment, the estimate autosave. None of them
   pass an actor themselves any more -- if core.js stops attaching it, all
   five go back to being filed under nobody. */
await named.w.patch("/api/orders/42/status", { status: "complete" });
await named.w.post("/api/orders/42/notes", { text: "Ready", visibility: "internal" });
await named.w.patch("/api/orders/42/jobs/1/done", { done: true });
await named.w.put("/api/orders/42/assignment", { technician_id: 1 });
await named.w.post("/api/orders/42/estimate", { labor_rate: 0, tax_rate: 0, items: [] });
await named.settle();

for (const [i, label] of ["status change", "note", "repair ticked off", "assignment", "estimate autosave"].entries()) {
  const sent = named.writes[i];
  ok(sent && sent.body && sent.body.actor === "Antonio Reyes",
     `the ${label} should carry the name, sent ${JSON.stringify(sent && sent.body)}`);
}
// The other fields have to survive the addition -- an actor that replaces the
// body is worse than no actor at all.
ok(named.writes[0].body.status === "complete", "attaching the name dropped the status the call was making");
ok(named.writes[4].body.labor_rate === 0 && Array.isArray(named.writes[4].body.items),
   "attaching the name dropped the estimate's own fields");

// A call site that names somebody itself still wins -- the MCP agent and the
// receive dialog both have a better answer than "whoever is at the keyboard".
await named.w.post("/api/orders/42/notes", { text: "x", actor: "Walt" });
await named.settle();
ok(named.writes[named.writes.length - 1].body.actor === "Walt",
   "an explicit actor should not be overwritten by the header picker");

// A DELETE has no body, so the one delete that logs an event takes it in the
// query string instead.
ok(named.w.withActorParam("/api/orders/42/jobs/2") === "/api/orders/42/jobs/2?actor=Antonio%20Reyes",
   `withActorParam produced "${named.w.withActorParam("/api/orders/42/jobs/2")}"`);
ok(named.w.withActorParam("/api/x?a=1").includes("&actor="), "withActorParam should respect an existing query string");

/* ---------- the car's story names people, and stays quiet about placeholders ---------- */
await named.w.openVehicleDetail("recon", 7);
await named.settle();

const who = [...doc.querySelectorAll("#vd-activity-list .tl-who")].map((el) => el.textContent.trim());
ok(who.includes("Antonio Reyes"), `the log should name the person who received the parts, got ${JSON.stringify(who)}`);
ok(!who.some((n) => n === "ui" || n === "Unspecified"),
   `the log is captioning events with a placeholder: ${JSON.stringify(who)}`);
ok(who.filter((n) => n === "").length === 2,
   `the two placeholder events should caption nothing at all, got ${JSON.stringify(who)}`);

const worked = doc.querySelector("#vd-last-worked").textContent;
ok(/Assignment changed/.test(worked), `the last-worked line lost its event: "${worked.trim()}"`);
ok(!/by ui\b/.test(worked), `the last-worked line reads "${worked.trim()}"`);

const noteMeta = [...doc.querySelectorAll("#vd-note-list .note-by")].map((el) => el.textContent.trim());
ok(/^Antonio Reyes · /.test(noteMeta[0] || ""), `a named note should say who wrote it, reads "${noteMeta[0]}"`);
ok(noteMeta.slice(1).every((m) => !/ui|Unspecified/.test(m)),
   `a note nobody claimed should show only its date, reads ${JSON.stringify(noteMeta.slice(1))}`);
ok(noteMeta.slice(1).every((m) => m.length > 0 && !m.startsWith("·")),
   `an unclaimed note should still show its date cleanly, reads ${JSON.stringify(noteMeta.slice(1))}`);

const titles = [...doc.querySelectorAll(".job-done-toggle")].map((el) => el.getAttribute("title") || "");
ok(titles.some((t) => /Finished by Antonio Reyes/.test(t)),
   `a repair finished by a named person should say so, got ${JSON.stringify(titles)}`);
ok(!titles.some((t) => /by ui\b|by Unspecified/.test(t)),
   `a repair finished by nobody-in-particular should not name one: ${JSON.stringify(titles)}`);

ok(named.rejections.length === 0,
   `unhandled rejections: ${named.rejections.map((r) => r && r.message).join("; ")}`);
if (named.fails.length) named.finish("who did it: attribution (named)");

/* ================================================================
   Nobody has said who they are
   ================================================================
   The name must not be invented. Sending "Unspecified" is what put a
   non-existent colleague on real work, and sending "" would be rejected
   outright by the endpoints whose actor field has a minimum length -- which
   would break the estimate autosave, not just the attribution. */
const anon = await bootAs("");
await anon.settle();

anon.ok(anon.doc.querySelector("#whoami").classList.contains("whoami-unset"),
        "with nobody picked the header control should flag itself");
anon.ok(/Nobody/.test(anon.doc.querySelector("#current-user").options[0].textContent),
        `the blank option should ask for a name, reads "${anon.doc.querySelector("#current-user").options[0].textContent}"`);

await anon.w.patch("/api/orders/42/status", { status: "complete" });
await anon.w.post("/api/orders/42/estimate", { labor_rate: 0, tax_rate: 0, items: [] });
await anon.settle();
anon.ok(anon.writes.every((wr) => !wr.body || !("actor" in wr.body)),
        `nothing should be invented when nobody is picked, sent ${JSON.stringify(anon.writes.map((wr) => wr.body))}`);
anon.ok(anon.writes[0].body.status === "complete", "the call itself should still go out unchanged");
anon.ok(anon.w.withActorParam("/api/orders/42/jobs/2") === "/api/orders/42/jobs/2",
        "withActorParam should add nothing when nobody is picked");

// Picking a name mid-shift takes effect on the next write, without a reload.
const select = anon.doc.querySelector("#current-user");
select.value = "Clayton Swallow";
select.dispatchEvent(new anon.w.Event("change", { bubbles: true }));
await anon.w.patch("/api/orders/42/status", { status: "complete" });
await anon.settle();
anon.ok(anon.writes[anon.writes.length - 1].body.actor === "Clayton Swallow",
        "picking a name should take effect immediately");
anon.ok(!anon.doc.querySelector("#whoami").classList.contains("whoami-unset"),
        "picking a name should clear the flag on the header control");
anon.ok(anon.w.localStorage.getItem("dao-current-user") === "Clayton Swallow",
        "the picked name should be remembered for next time");

anon.ok(anon.rejections.length === 0,
        `unhandled rejections: ${anon.rejections.map((r) => r && r.message).join("; ")}`);

// Both scenarios' failures live in their own collectors; report the first
// booted one so a failure in either half is printed.
for (const msg of anon.fails) named.fails.push(msg);
named.finish("who did it: the name on every write, and placeholders captioning nothing");
