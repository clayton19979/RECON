// Staff screen smoke test.
//
// The staff list is the app's identity table: every assignment dropdown,
// technician report and task owner reads from it, which is why the screen
// deactivates instead of deleting and why the assertions here lean on the
// consequences -- the active/inactive split (state.staff vs state.allStaff),
// the duplicate-name guard (pickers show names only, so two "Ray Ortiz" rows
// would be indistinguishable forever), and the deactivate confirm that warns
// about a person's open tasks before pulling them out of every dropdown.

import { boot, click } from "./harness.mjs";

// One of each role plus a second tech and one deactivated tech: enough for
// the role grouping, the active/inactive filters and the stats to all have
// something real to count. active is 0/1, matching the SQLite rows the
// server actually returns.
// open_orders rides along on every row: how many unfinished tickets that
// person is still on, which is what the deactivate confirm has to say out
// loud before anybody is pulled off the floor.
let staffData = [
  { id: 1, name: "Ray Ortiz", role: "technician", active: 1, open_orders: 0 },
  { id: 2, name: "Dana Wu", role: "technician", active: 1, open_orders: 2 },
  { id: 3, name: "Sam Patel", role: "advisor", active: 1, open_orders: 1 },
  { id: 4, name: "Lee Grant", role: "manager", active: 1, open_orders: 0 },
  { id: 5, name: "Wally Burke", role: "technician", active: 0, open_orders: 0 },
];

// Ray: two open, one done (done must not count). Dana+Sam share one open
// task -- it counts once for the stat card but once *each* per person.
// The unassigned open task counts for nobody and not for the stat card.
const TASKS = [
  { id: 101, title: "Order struts", done: 0, completed_at: null, assigned_to: ["Ray Ortiz"] },
  { id: 102, title: "Call customer", done: 0, completed_at: null, assigned_to: ["Ray Ortiz"] },
  { id: 103, title: "Old sublet", done: 1, completed_at: "2026-07-01T12:00:00Z", assigned_to: ["Ray Ortiz"] },
  { id: 104, title: "Shared detail", done: 0, completed_at: null, assigned_to: ["Dana Wu", "Sam Patel"] },
  { id: 105, title: "Nobody's yet", done: 0, completed_at: null, assigned_to: [] },
];

const posts = [];
const patches = [];
let nextId = 6;

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["state", "showView", "loadStaffView", "renderStaffTable", "applyStaffFilter"],
  fetch: async (url, opts) => {
    if (url.startsWith("/api/staff") && opts.method === "GET") {
      return url.includes("include_inactive=true") ? staffData : staffData.filter((s) => s.active);
    }
    if (url === "/api/staff" && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      posts.push({ url, body });
      const row = { id: nextId++, active: 1, ...body };
      staffData = [...staffData, row];
      return row;
    }
    if (url.startsWith("/api/staff/") && opts.method === "PATCH") {
      const id = Number(url.split("/")[3]);
      const body = JSON.parse(opts.body);
      patches.push({ url, body });
      // Mirror the real API: a rename reports how many tasks followed the
      // name (done ones included), so the UI can announce the follow-through.
      const oldName = staffData.find((s) => s.id === id)?.name;
      const tasksMoved = body.name && body.name !== oldName
        ? TASKS.filter((t) => (t.assigned_to || []).includes(oldName)).length
        : 0;
      staffData = staffData.map((s) => (s.id === id
        ? { ...s, ...body, active: "active" in body ? (body.active ? 1 : 0) : s.active }
        : s));
      return { ...staffData.find((s) => s.id === id), tasks_moved: tasksMoved };
    }
    if (url === "/api/tasks") return TASKS;
    if (url === "/api/orders") return [];
    if (url.startsWith("/api/reports/")) return [];
    if (url.startsWith("/api/vehicles-board")) return [];
    return [];
  },
});

w.showView("staff");
await settle();

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const row = (id) => $(`#staff-table tr[data-id="${id}"]`);
const input = (el, value) => {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};

/* ---------- stats describe the shop ---------- */
const statValues = $$("#staff-stats .stat-value").map((el) => el.textContent.trim());
ok(statValues[0] === "2", `Technicians card should count the 2 active techs, reads "${statValues[0]}"`);
ok(statValues[1] === "2", `Advisors & Managers card should count advisor+manager, reads "${statValues[1]}"`);
// Open tasks with at least one owner: 101, 102, 104 -- not the done 103, not
// the unassigned 105.
ok(statValues[2] === "3", `Assigned Tasks card should read 3, reads "${statValues[2]}"`);
ok(statValues[3] === "1", `Inactive card should count Wally, reads "${statValues[3]}"`);
ok(!$("#staff-stats .stat-value.crit"), "no card should be critical while techs exist");
ok(!$('[data-staff-stat="tasks"]').disabled, "the Assigned Tasks card should be clickable when tasks exist");
ok(!$('[data-staff-stat="inactive"]').disabled, "the Inactive card should be clickable when someone is inactive");

/* ---------- the Assigned Tasks card breaks the load down per person ----------
   Busiest first (Ray 2), ties alphabetical (Dana before Sam, both 1), the
   shared task counting once per owner, Lee with zero open tasks absent.
   Each row is a button that lands on Tasks filtered to that person -- the
   same trip the workload column's count links make. */
const personRows = $$('#staff-stats [data-staff-stat="tasks"] .stat-person');
ok(personRows.length === 3, `expected 3 per-person rows on the card, got ${personRows.length}`);
const personSummary = personRows.map((r) =>
  `${r.querySelector(".stat-person-name")?.textContent.trim()} ${r.querySelector(".stat-person-count")?.textContent.trim()}`).join(" | ");
ok(personSummary === "Ray Ortiz 2 | Dana Wu 1 | Sam Patel 1",
   `breakdown should read busiest-first with alphabetical ties, reads "${personSummary}"`);
// The bar scales against the busiest person: Ray full, the others half.
const rayBar = personRows[0]?.querySelector(".stat-person-bar > span");
const danaBar = personRows[1]?.querySelector(".stat-person-bar > span");
ok(rayBar?.style.width === "100%", `the busiest bar should be full width, got "${rayBar?.style.width}"`);
ok(danaBar?.style.width === "50%", `a half-load bar should be half width, got "${danaBar?.style.width}"`);
personRows[1].click();
await settle();
ok($("#view-tasks").classList.contains("active"), "a per-person row should land on the Tasks screen");
ok(w.state.taskAssignee === "Dana Wu",
   `the Tasks screen should arrive pre-filtered to the clicked person, got "${w.state.taskAssignee}"`);
w.showView("staff");
await settle();

/* ---------- default filter: active only, grouped by role ---------- */
ok(row(1) && row(2) && row(3) && row(4), "the four active people didn't all render");
ok(!row(5), "an inactive person is showing under the Active filter");
const groups = $$("#staff-table .group-row").map((r) => r.textContent.replace(/\s+/g, " ").trim());
ok(groups.length === 3, `expected 3 role group headers, got ${groups.length}: ${groups.join(" | ")}`);
ok(/^Technicians\s*2/.test(groups[0] || ""), `first group should be "Technicians 2", reads "${groups[0]}"`);
ok(/^Advisors\s*1/.test(groups[1] || ""), `second group should be "Advisors 1", reads "${groups[1]}"`);
ok(/^Managers\s*1/.test(groups[2] || ""), `third group should be "Managers 1", reads "${groups[2]}"`);
ok(/4 staff members/.test($("#staff-count").textContent), `count reads "${$("#staff-count").textContent}"`);

// Ray's open-task cell links his 2 open tasks; done tasks don't count. Lee
// has none and gets an em-dash, not a zero-count button.
ok(row(1).querySelector(".stf-task-link")?.textContent.trim() === "2",
   "Ray's open-task cell should link a count of 2");
ok(row(3).querySelector(".stf-task-link")?.textContent.trim() === "1",
   "Sam's shared task should count once for him");
ok(!row(4).querySelector(".stf-task-link") && row(4).querySelector(".muted-dash"),
   "Lee (no tasks) should show an em-dash, not a task link");

/* ---------- the Inactive stat card and the chips drive one filter ---------- */
click(w, $('[data-staff-stat="inactive"]'));
ok(row(5), "clicking the Inactive card didn't reveal the inactive person");
ok(row(5).classList.contains("staff-inactive"), "the inactive row isn't muted with .staff-inactive");
ok(row(5).querySelector(".pill-inactive"), "the inactive row's status pill should read Inactive");
ok($('[data-staff-filter="all"]').classList.contains("active"),
   "revealing inactive via the stat card should light the Include-inactive chip");
ok($('[data-staff-stat="inactive"]').getAttribute("aria-pressed") === "true",
   "the Inactive card should read pressed while showing inactive staff");
ok(/5 staff members · 4 active, 1 inactive/.test($("#staff-count").textContent),
   `count under Include-inactive reads "${$("#staff-count").textContent}"`);
// Browsing stays grouped by role even with inactive shown, and the inactive
// tech sorts to the bottom of his own group (after Dana and Ray, who order
// alphabetically) rather than interleaving with working staff.
{
  const ids = $$("#staff-table tr[data-id]").map((r) => Number(r.dataset.id));
  ok(ids.join(",") === "2,1,5,3,4",
     `expected grouped order Dana,Ray,Wally(inactive) | Sam | Lee -- got ${ids.join(",")}`);
}
click(w, $('[data-staff-stat="inactive"]'));
ok(!row(5), "clicking the Inactive card again didn't hide inactive staff");
ok($('[data-staff-filter="active"]').classList.contains("active"),
   "hiding inactive should hand the Active chip back its lit state");

/* ---------- search: flat results, role terms match, Escape clears ---------- */
input($("#staff-search"), "ray");
ok(row(1) && !row(2), "searching a name should narrow to that person");
ok(!$("#staff-table .group-row"), "search results should render flat, without role group headers");
ok(/1 of 5 staff members/.test($("#staff-count").textContent),
   `search count reads "${$("#staff-count").textContent}"`);

// Role text is searchable -- "advisor" finds Sam even though it's not his name.
input($("#staff-search"), "advisor");
ok(row(3) && !row(1), "searching a role term should match people by role");

input($("#staff-search"), "zz-nobody");
ok(!$("#staff-table tr[data-id]"), "an unmatched search still renders rows");
ok(/No staff match that search/.test($("#staff-table").textContent),
   "the no-match empty state should say nothing matched");
$("#staff-empty-clear")?.click();
ok(row(1) && row(2) && row(3) && row(4), "the empty state's Clear button didn't restore the list");
ok($("#staff-search").value === "", "Clear should also empty the search box itself");

input($("#staff-search"), "dana");
$("#staff-search").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
ok(row(1), "Escape in the search box didn't clear the filter");

/* ---------- add form: duplicate names refused before the POST ---------- */
const form = $("#staff-form");
form.elements.namedItem("name").value = "ray ortiz"; // case-insensitive clash
form.elements.namedItem("role").value = "advisor";
form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === 0, "a duplicate name (case-insensitively) should never reach the server");
ok($("#toast").classList.contains("error") && /already on staff/.test($("#toast").textContent),
   `the duplicate should be refused with a toast, got "${$("#toast").textContent}"`);

form.elements.namedItem("name").value = "Noah Reyes";
form.elements.namedItem("role").value = "advisor";
form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(posts.length === 1 && posts[0].body.name === "Noah Reyes" && posts[0].body.role === "advisor",
   `adding should POST name+role, sent ${JSON.stringify(posts)}`);
const noahRow = $$("#staff-table tr[data-id]").find((r) => r.textContent.includes("Noah") || r.querySelector("input")?.value === "Noah Reyes");
ok(noahRow, "the new advisor should appear in the table after adding");
ok(form.elements.namedItem("name").value === "", "the add form should reset after a successful add");
ok(doc.activeElement === form.elements.namedItem("name"),
   "focus should return to the name box, ready for the next hire");

/* ---------- rename saves on blur, reverts on nonsense ---------- */
const rayName = row(1).querySelector(".stf-name");
rayName.value = "Raymond Ortiz";
rayName.dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
ok(patches.some((p) => p.url === "/api/staff/1" && p.body.name === "Raymond Ortiz"),
   "renaming should PATCH the new name on blur");
ok(row(1).querySelector(".stf-name").value === "Raymond Ortiz", "the rename didn't survive the reload");
// Ray had three tasks keyed to his old name (two open + one done); the toast
// announces they moved with him instead of the rename looking like a no-op.
ok(/Renamed to Raymond Ortiz — 3 tasks moved with them/.test($("#toast").textContent),
   `the rename toast should report the tasks that followed, reads "${$("#toast").textContent}"`);

const patchCountBefore = patches.length;
const unchanged = row(2).querySelector(".stf-name");
unchanged.dispatchEvent(new w.Event("blur", { bubbles: false }));
const blanked = row(2).querySelector(".stf-name");
blanked.value = "   ";
blanked.dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
ok(patches.length === patchCountBefore, "an unchanged or blanked name should not PATCH");
ok(row(2).querySelector(".stf-name").value === "Dana Wu", "a blanked name should snap back to the saved one");

/* ---------- role: badge by default, select on demand ---------- */
ok(row(2).querySelector(".stf-role-badge") && !row(2).querySelector("select.stf-role-select"),
   "roles should render as badges, not live selects");
click(w, row(2).querySelector(".stf-role-badge"));
const roleSelect = row(2).querySelector("select.stf-role-select");
ok(roleSelect, "clicking the badge should swap in a select");
ok(roleSelect && !row(2).querySelector(".stf-role-badge"), "the badge should be gone while the select is up");
roleSelect.value = "advisor";
roleSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(patches.some((p) => p.url === "/api/staff/2" && p.body.role === "advisor"),
   "changing the role select should PATCH the role");
ok(row(2).querySelector(".stf-role-badge")?.textContent.trim() === "Advisor",
   "after the change Dana's badge should read Advisor");
{
  // Techs: Ray alone now. Advisors: Sam + the just-added Noah + Dana = 3.
  const advisorGroup = $$("#staff-table .group-row").map((r) => r.textContent.replace(/\s+/g, " ").trim());
  ok(/^Technicians\s*1/.test(advisorGroup[0] || "") && /^Advisors\s*3/.test(advisorGroup[1] || ""),
     `the role groups should re-count after a re-role: ${advisorGroup.join(" | ")}`);
}

// Opening the select and clicking away must restore the badge, not leave a
// dangling dropdown.
click(w, row(3).querySelector(".stf-role-badge"));
row(3).querySelector("select.stf-role-select").dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
ok(row(3)?.querySelector(".stf-role-badge") && !$("#staff-table select.stf-role-select"),
   "blurring the role select without choosing should restore the badge");

/* ---------- deactivate asks first and says what is being left behind ------ */
// Two different questions, both answered before the decision. Cars: Dana is
// still on 2 unfinished tickets (open_orders, straight off /api/staff) --
// those have to be handed to somebody, and nothing else on this screen says
// so. Tasks: assignment is name-keyed, so Dana (still "Dana Wu") owns 1 open
// task, while Ray's rename to "Raymond Ortiz" orphaned his -- his confirm
// must NOT claim tasks he no longer matches.
click(w, row(2).querySelector(".stf-toggle"));
await settle();
const dlg = $("#confirm-dialog");
ok(dlg.open, "deactivating should open the confirm dialog");
ok(/Dana Wu/.test($("#confirm-title").textContent),
   `the confirm should name the person, reads "${$("#confirm-title").textContent}"`);
ok(/2 unfinished tickets\b/.test($("#confirm-body").textContent),
   `the confirm should say what cars Dana is still on, reads "${$("#confirm-body").textContent}"`);
ok(/1 open task\b/.test($("#confirm-body").textContent),
   `the confirm should warn about Dana's open task, reads "${$("#confirm-body").textContent}"`);
// The promise the whole change exists to make true: what she already holds
// stays hers and stays editable.
ok(/keeps their name and stays editable/.test($("#confirm-body").textContent),
   `the confirm should promise existing work survives, reads "${$("#confirm-body").textContent}"`);
$("#confirm-cancel").click();
await settle();
ok(!patches.some((p) => p.url === "/api/staff/2" && "active" in p.body),
   "cancelling the confirm still deactivated the person");

const rayToggle = row(1).querySelector(".stf-toggle");
ok(/Deactivate/.test(rayToggle.textContent), "an active person's action should read Deactivate");
click(w, rayToggle);
await settle();
ok(dlg.open, "Ray's deactivate should also ask first");
ok(!/open task/.test($("#confirm-body").textContent),
   `a renamed person's confirm must not claim tasks keyed to the old name, reads "${$("#confirm-body").textContent}"`);
$("#confirm-cancel").click();
await settle();

click(w, row(1).querySelector(".stf-toggle"));
await settle();
$("#confirm-accept").click();
await settle();
ok(patches.some((p) => p.url === "/api/staff/1" && p.body.active === false),
   "confirming should PATCH active:false");
ok(!row(1), "a freshly deactivated person should leave the Active list");

// Reactivating is consequence-free and must not nag.
w.applyStaffFilter("all");
const wallyToggle = row(5).querySelector(".stf-toggle");
ok(/Activate/.test(wallyToggle.textContent), "an inactive person's action should read Activate");
click(w, wallyToggle);
await settle();
ok(!$("#confirm-dialog").open, "reactivating should not open a confirm dialog");
ok(patches.some((p) => p.url === "/api/staff/5" && p.body.active === true),
   "activating should PATCH active:true");
ok(row(5) && !row(5).classList.contains("staff-inactive"), "Wally should render active after reactivation");

/* ---------- the task links and stat cards go places ---------- */
w.applyStaffFilter("active");
const danaLink = row(2)?.querySelector(".stf-task-link");
ok(danaLink, "Dana should still link her open task");
if (danaLink) {
  danaLink.click();
  await settle();
  ok($("#view-tasks").classList.contains("active"), "a task-count link should land on the Tasks screen");
  ok(w.state.taskAssignee === "Dana Wu",
     `the Tasks screen should arrive pre-filtered to Dana, got "${w.state.taskAssignee}"`);
}

w.showView("staff");
await settle();
$("#staff-report-link").click();
await settle();
ok($("#view-reports").classList.contains("active"), "Productivity Report should land on Reports");
ok(w.state.reportType === "technicians",
   `the report link should preselect the technicians report, got "${w.state.reportType}"`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((r) => r && r.message).join("; ")}`);

finish("staff screen: stats, role groups, filters, add/rename/re-role, deactivate confirm, cross-links");
