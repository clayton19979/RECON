// Tasks screen smoke test.
//
// The board can turn eight stalled cars into eight follow-ups in one click,
// and it creates them unassigned and undated on purpose -- who and when are
// decisions you make looking at the list. Until this run the only way to
// record those decisions was to open eight rows one at a time, which is why
// nobody used the feature. So the assertions here are weighted toward the
// three things that close that loop: selection that means what the screen
// shows, one request for N rows, and an assignment picker that adds a person
// without dropping whoever was already there.
//
// The grouping and the stat cards are the other half. A flat list sorted by
// date gives no answer to the only question anyone opens this screen with.

import { boot, click, press } from "./harness.mjs";

const NOW = Date.now();
const iso = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const stamp = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 19);

const STAFF = [
  { id: 1, name: "Dana Ruiz", role: "technician", active: 1 },
  { id: 2, name: "Antonio Vega", role: "technician", active: 1 },
];

// One task per bucket, plus the pair the bulk assignment cases need.
// Deliberately out of display order in the array: a test whose fixture is
// already sorted can't tell a working comparator from no comparator at all.
let tasks = [
  { id: 1, title: "Later: order shop rags", notes: "", assigned_to: [], due_date: iso(20), urgent: 0, done: 0,
    order_id: null, created_by: "Clay", created_at: stamp(1), completed_at: "", order_label: null, order_segment: null,
    order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null },
  { id: 2, title: "Follow up: R-0981 — no work in 41 days", notes: "", assigned_to: [], due_date: "", urgent: 0, done: 0,
    order_id: 42, created_by: "Clay", created_at: stamp(1), completed_at: "", order_label: "R-0981", order_segment: "recon",
    order_recon_vehicle_id: 7, order_we_owe_id: null, order_number: "RO-1042" },
  { id: 3, title: "Overdue: call John about his Civic", notes: "", assigned_to: ["Dana Ruiz"], due_date: iso(-4), urgent: 0, done: 0,
    order_id: null, created_by: "Clay", created_at: stamp(2), completed_at: "", order_label: null, order_segment: null,
    order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null },
  { id: 4, title: "Today: pick up the brake pads", notes: "", assigned_to: ["Dana Ruiz", "Antonio Vega"], due_date: iso(0), urgent: 1, done: 0,
    order_id: null, created_by: "Clay", created_at: stamp(3), completed_at: "", order_label: null, order_segment: null,
    order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null },
  { id: 5, title: "This week: inspect the loaner", notes: "", assigned_to: [], due_date: iso(3), urgent: 0, done: 0,
    order_id: null, created_by: "Clay", created_at: stamp(4), completed_at: "", order_label: null, order_segment: null,
    order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null },
  { id: 6, title: "Done: rotate the tires", notes: "", assigned_to: [], due_date: "", urgent: 0, done: 1,
    order_id: null, created_by: "Clay", created_at: stamp(9), completed_at: stamp(1), order_label: null, order_segment: null,
    order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null },
];

const bulkCalls = [];

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "loadTasksView", "renderTasksList", "visibleTasks", "taskBucket", "taskScopeLabel", "showView"],
  fetch: async (url, opts) => {
    if (url === "/api/tasks") return tasks;
    if (url === "/api/tasks/bulk" || url === "/api/tasks/bulk-delete") {
      const body = JSON.parse(opts.body);
      bulkCalls.push({ url, body });
      if (url === "/api/tasks/bulk-delete") {
        tasks = tasks.filter((t) => !body.ids.includes(t.id));
        return { deleted: body.ids.length };
      }
      // Mirror the server's semantics closely enough that the UI's next render
      // is driven by real data rather than by what the UI already believed.
      tasks = tasks.map((t) => {
        if (!body.ids.includes(t.id)) return t;
        const next = { ...t };
        if (body.due_date !== undefined) next.due_date = body.due_date;
        if (body.urgent !== undefined) next.urgent = body.urgent ? 1 : 0;
        if (body.done !== undefined) next.done = body.done ? 1 : 0;
        if (body.assigned_to !== undefined) {
          if (body.assign_mode === "add") next.assigned_to = [...new Set([...t.assigned_to, ...body.assigned_to])];
          else if (body.assign_mode === "remove") next.assigned_to = t.assigned_to.filter((n) => !body.assigned_to.includes(n));
          else next.assigned_to = body.assigned_to;
        }
        return next;
      });
      return { updated: body.ids.length, tasks: tasks.filter((t) => body.ids.includes(t.id)) };
    }
    if (url.startsWith("/api/tasks/")) return tasks.find((t) => t.id === Number(url.split("/").pop())) || tasks[0];
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [];
    if (url.startsWith("/api/staff")) return STAFF;
    if (url.startsWith("/api/vehicles-board")) return [];
    return [];
  },
});

// localStorage carries prefs between sessions; a stale one from another run
// would silently filter the fixture out from under every assertion below.
w.localStorage.removeItem("dao-task-prefs");
w.showView("tasks");
await settle();

const rowsIn = (sel) => [...doc.querySelectorAll(`${sel} .task-row`)];
const bucketOf = (id) => doc.querySelector(`.task-row[data-id="${id}"]`)?.closest(".task-group")?.dataset.bucket;
// Scoped to the open list on purpose: the completed list renders too (just
// hidden), so an unscoped lookup would happily find a row the open list never
// showed and every assertion below it would be testing the wrong element.
const rowFor = (id) => doc.querySelector(`#tasks-list .task-row[data-id="${id}"]`);

/* ---------- grouping ---------- */
ok(rowsIn("#tasks-list").length === 5, `expected the 5 open tasks, got ${rowsIn("#tasks-list").length}`);
ok(!rowFor(6), "a completed task is rendering in the open list");
ok(bucketOf(3) === "overdue", `task 3 landed in "${bucketOf(3)}" rather than overdue`);
ok(bucketOf(4) === "today", `task 4 landed in "${bucketOf(4)}" rather than today`);
ok(bucketOf(5) === "week", `task 5 landed in "${bucketOf(5)}" rather than week`);
ok(bucketOf(1) === "later", `task 1 landed in "${bucketOf(1)}" rather than later`);
ok(bucketOf(2) === "none", `an undated task landed in "${bucketOf(2)}" rather than the no-due-date group`);

// Headers exist only where there are rows under them -- five headings over two
// tasks is worse than no headings.
const heads = [...doc.querySelectorAll(".task-group-head")];
ok(heads.length === 5, `expected 5 populated group headings, got ${heads.length}`);
ok(/Overdue/.test(heads[0].textContent), `the first heading is "${heads[0].textContent.trim()}" -- overdue should lead`);
ok(heads.every((h) => /\d/.test(h.textContent)), "a group heading rendered without its count");

// Display order is what shift+click ranges walk, so it has to match the DOM.
const domOrder = rowsIn("#tasks-list").map((r) => Number(r.dataset.id));
ok(JSON.stringify(domOrder) === JSON.stringify(w.visibleTasks().map((t) => t.id)),
   `visibleTasks() order ${JSON.stringify(w.visibleTasks().map((t) => t.id))} != DOM order ${JSON.stringify(domOrder)}`);

/* ---------- stat cards ---------- */
const cardValue = (id) => doc.querySelector(`#stat-tasks-${id}`).textContent;
ok(cardValue("open") === "5", `Open card reads ${cardValue("open")}, expected 5`);
ok(cardValue("overdue") === "1", `Overdue card reads ${cardValue("overdue")}, expected 1`);
ok(cardValue("today") === "1", `Due Today card reads ${cardValue("today")}, expected 1`);
ok(cardValue("unassigned") === "3", `Unassigned card reads ${cardValue("unassigned")}, expected 3`);
ok(doc.querySelector("#stat-tasks-overdue").classList.contains("crit"), "an overdue count isn't toned as critical");
ok(/4 days late/.test(doc.querySelector("#stat-tasks-overdue-sub").textContent),
   `overdue subtitle reads "${doc.querySelector("#stat-tasks-overdue-sub").textContent}"`);

/* A card is a filter, and pressing it must not renumber the card that did the
   filtering -- a number that changes when you press it reads as the data
   moving underneath you. This is the exact case that survived mutation
   testing on the board's Stalled card, so it's asserted rather than assumed. */
const overdueCard = doc.querySelector('[data-task-card="overdue"]');
overdueCard.click();
await settle();
ok(rowsIn("#tasks-list").length === 1, `the Overdue card left ${rowsIn("#tasks-list").length} rows, expected 1`);
ok(cardValue("overdue") === "1", `the Overdue card renumbered itself to ${cardValue("overdue")} when pressed`);
/* The neighbours are the real test of that rule, and the Overdue card alone
   can't see it: filtered to the one overdue row, "overdue" counts 1 either
   way. Open and Unassigned would drop to 1 and 0 if the cards counted the
   filtered list -- pressing one card must not blank out the others, or the
   row of cards stops being a summary the moment you use it. */
ok(cardValue("open") === "5", `Open collapsed to ${cardValue("open")} while the Overdue filter was on`);
ok(cardValue("unassigned") === "3", `Unassigned collapsed to ${cardValue("unassigned")} while the Overdue filter was on`);
ok(overdueCard.getAttribute("aria-pressed") === "true", "a pressed card doesn't report aria-pressed");
ok(/past due/.test(doc.querySelector("#tasks-scope").textContent),
   `scope line reads "${doc.querySelector("#tasks-scope").textContent}"`);
ok(!doc.querySelector("#tasks-reset-view").hidden, "Reset view stays hidden while a filter is on");
overdueCard.click();
await settle();
ok(rowsIn("#tasks-list").length === 5, "clicking a lit card didn't clear the filter");

// Zero cards are disabled: "0 overdue" is good news and clicking it could only
// ever produce an empty list.
doc.querySelector("#task-search").value = "nothing matches this";
doc.querySelector("#task-search").dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(doc.querySelector('[data-task-card="today"]').disabled, "a zero-count card is still clickable");
doc.querySelector("#task-search").value = "";
doc.querySelector("#task-search").dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();

/* ---------- selection ---------- */
ok(doc.querySelector("#tasks-bulk-bar").style.display === "none", "the bulk bar is showing with nothing selected");
// Completed rows get no checkbox: every bulk action here is an edit to work
// that still has to happen, and "reopen these six" isn't one of them.
const doneRow = doc.querySelector('#tasks-completed-list .task-row[data-id="6"]');
ok(doneRow, "the completed task didn't render in the completed list");
ok(doneRow && !doneRow.querySelector(".task-select"), "a completed task offers a bulk-edit checkbox");

rowFor(3).querySelector(".task-select").click();
await settle();
ok(doc.querySelector("#tasks-bulk-bar").style.display !== "none", "the bulk bar stayed hidden after selecting a row");
ok(/1 selected/.test(doc.querySelector("#tasks-bulk-count").textContent),
   `bulk bar reads "${doc.querySelector("#tasks-bulk-count").textContent}"`);
ok(rowFor(3).classList.contains("selected"), "a selected row isn't marked as such");

/* Shift+click takes everything between the two rows *as displayed*. The pair
   is chosen so the two orders disagree: on screen it's 3,4,5,1,2, so anchoring
   on 4 and shift-clicking 1 spans {4,5,1}, while walking the underlying array
   would span {1,2,3,4} -- four rows, two of which sit above the anchor. An
   earlier version of this used the first three rows, where both orders give
   the same answer and a comparator-free implementation passed. */
w.state.taskSelection.clear();
w.renderTasksList();
rowFor(4).querySelector(".task-select").click();
await settle();
const shiftBox = rowFor(1).querySelector(".task-select");
shiftBox.checked = true;
click(w, shiftBox, { shiftKey: true });
await settle();
ok(JSON.stringify([...w.state.taskSelection].sort()) === "[1,4,5]",
   `shift+click spanned ${JSON.stringify([...w.state.taskSelection].sort())}, expected the displayed range [1,4,5]`);

// Escape is the way out, same as the board.
press(w, "Escape");
await settle();
ok(w.state.taskSelection.size === 0, "Escape didn't clear the selection");
ok(doc.querySelector("#tasks-bulk-bar").style.display === "none", "the bulk bar survived Escape");

// Select-all covers exactly what's on screen -- not the whole table.
doc.querySelector('[data-task-card="unassigned"]').click();
await settle();
const selectAll = doc.querySelector("#tasks-select-all");
selectAll.checked = true;
selectAll.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(w.state.taskSelection.size === 3, `select-all took ${w.state.taskSelection.size} rows while showing 3`);
ok(selectAll.checked && !selectAll.indeterminate, "select-all didn't settle into a fully-checked state");

/* A selection that outlived its filter would act on rows nobody can see: the
   bar would say "3 selected" over a list of one. The chips and cards drop the
   selection outright when they change. */
doc.querySelector('[data-task-card="unassigned"]').click();
await settle();
ok(w.state.taskSelection.size === 0, `${w.state.taskSelection.size} rows stayed selected through a filter change`);

/* Search is the case that can't just clear, because you type it one letter at
   a time -- wiping the selection on every keystroke would make it impossible
   to select anything while narrowing down to it. So the render prunes to what
   survived instead, and the count has to follow the rows down.

   Asserted because a mutation that deleted the pruning outright still passed:
   every other path clears explicitly, leaving this the only place the line is
   observable. Without this it was defensive code no test could see. */
rowFor(3).querySelector(".task-select").click();
rowFor(4).querySelector(".task-select").click();
await settle();
ok(w.state.taskSelection.size === 2, `expected 2 selected before narrowing, got ${w.state.taskSelection.size}`);
const search = doc.querySelector("#task-search");
search.value = "call John";           // matches task 3 only
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(rowsIn("#tasks-list").length === 1, `the search left ${rowsIn("#tasks-list").length} rows, expected 1`);
ok(w.state.taskSelection.size === 1 && w.state.taskSelection.has(3),
   `the selection didn't follow the search down: ${JSON.stringify([...w.state.taskSelection])}`);
ok(/1 selected/.test(doc.querySelector("#tasks-bulk-count").textContent),
   `bulk bar reads "${doc.querySelector("#tasks-bulk-count").textContent}" over 1 visible row`);
search.value = "";
search.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
w.state.taskSelection.clear();
w.renderTasksList();

/* ---------- bulk edit ---------- */
rowFor(1).querySelector(".task-select").click();
rowFor(2).querySelector(".task-select").click();
await settle();
ok(w.state.taskSelection.size === 2, `expected 2 selected, got ${w.state.taskSelection.size}`);

// Due date: one request for both rows, not one per row.
const before = fetchLog.length;
const bulkDue = doc.querySelector("#tasks-bulk-due");
bulkDue.value = iso(0);
bulkDue.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
const dueCall = bulkCalls.find((c) => c.url === "/api/tasks/bulk" && c.body.due_date);
ok(dueCall, "setting a bulk due date didn't hit /api/tasks/bulk");
ok(dueCall && dueCall.body.ids.length === 2, `the bulk call carried ${dueCall && dueCall.body.ids.length} ids, expected 2`);
ok(fetchLog.slice(before).filter((f) => /^\/api\/tasks\/\d+$/.test(f.url)).length === 0,
   "the bulk due date fell back to one PATCH per row");
ok(bucketOf(1) === "today" && bucketOf(2) === "today",
   `after a bulk due date the rows sit in ${bucketOf(1)}/${bucketOf(2)} rather than today`);

/* Assignment is the case that matters most. Task 4 already has two people on
   it; adding a third must not drop them, which a plain replace would do
   silently -- the kind of data loss nobody notices until the person who was
   dropped doesn't turn up. */
w.state.taskSelection.clear();
w.renderTasksList();
rowFor(4).querySelector(".task-select").click();
rowFor(5).querySelector(".task-select").click();
await settle();
const menu = doc.querySelector("#tasks-bulk-assignee-menu");
const danaBox = [...menu.querySelectorAll("input")].find((i) => i.value === "Dana Ruiz");
const antonioBox = [...menu.querySelectorAll("input")].find((i) => i.value === "Antonio Vega");
// Dana is on task 4 but not task 5: partial, and the picker has to say so
// rather than showing a bare checked box that implies both.
ok(danaBox.indeterminate, "an assignee on some of the selection isn't shown as indeterminate");
ok(/1\/2/.test(menu.textContent), `the partial count is missing from the menu: "${menu.textContent.replace(/\s+/g, " ").trim()}"`);

danaBox.checked = true;
danaBox.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
const addCall = bulkCalls.find((c) => c.body.assign_mode === "add");
ok(addCall, "checking an assignee didn't send assign_mode=add");
ok(addCall && JSON.stringify(addCall.body.assigned_to) === '["Dana Ruiz"]',
   `the add call carried ${addCall && JSON.stringify(addCall.body.assigned_to)}`);
ok(tasks.find((t) => t.id === 4).assigned_to.includes("Antonio Vega"),
   "bulk-assigning Dana dropped Antonio, who was already on the task");
ok(tasks.find((t) => t.id === 5).assigned_to.includes("Dana Ruiz"), "the row that lacked Dana didn't get her");

// Unchecking removes rather than replacing.
antonioBox.checked = false;
antonioBox.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
const removeCall = bulkCalls.find((c) => c.body.assign_mode === "remove");
ok(removeCall, "unchecking an assignee didn't send assign_mode=remove");
ok(!tasks.find((t) => t.id === 4).assigned_to.includes("Antonio Vega"), "unchecking didn't take Antonio off");
ok(tasks.find((t) => t.id === 4).assigned_to.includes("Dana Ruiz"), "the remove dropped an assignee it wasn't asked about");

/* Urgent flips label once everything selected already carries the flag --
   otherwise it's a button you can press forever with no effect. */
w.state.taskSelection.clear();
w.renderTasksList();
rowFor(4).querySelector(".task-select").click();
await settle();
ok(doc.querySelector("#tasks-bulk-urgent").textContent === "Clear Urgent",
   `bulk urgent button reads "${doc.querySelector("#tasks-bulk-urgent").textContent}" over an already-urgent row`);
doc.querySelector("#tasks-bulk-urgent").click();
await settle();
ok(tasks.find((t) => t.id === 4).urgent === 0, "Clear Urgent didn't clear the flag");

/* ---------- per-row inline edits ---------- */
// Due date and urgency were both write-once, settable in the quick-add form
// and nowhere else -- which is the wrong moment for either of them.
const flag = rowFor(5).querySelector(".task-flag");
ok(flag && /Flag urgent/.test(flag.textContent), "a non-urgent row offers no way to flag it");
flag.click();
await settle();
ok(fetchLog.some((f) => f.method === "PATCH" && f.url === "/api/tasks/5"), "the row's urgent toggle didn't save");

const dueChip = rowFor(2).querySelector(".task-due");
ok(dueChip, "a task row has no due-date control");
dueChip.click();
await settle();
const editor = rowFor(2).querySelector(".task-due-edit");
ok(editor && editor.type === "date", "clicking the due chip didn't swap in a date input");
editor.value = iso(1);
editor.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(fetchLog.some((f) => f.method === "PATCH" && f.url === "/api/tasks/2"), "editing the due date inline didn't save");

/* ---------- destructive actions confirm first ----------
   Both of these take the whole batch with them, so both ask. Written against
   #confirm-accept by id rather than a permissive "whichever button looks like
   a confirm" selector -- the first draft of this test used the latter, matched
   nothing, and skipped the entire section while still reporting PASS. */
const acceptConfirm = async () => {
  const dlg = doc.querySelector("#confirm-dialog");
  ok(dlg.open, "a destructive bulk action fired without asking first");
  doc.querySelector("#confirm-accept").click();
  await settle();
};

// Complete: the selection leaves the open list, so it confirms.
w.state.taskSelection.clear();
w.renderTasksList();
rowFor(5).querySelector(".task-select").click();
await settle();
doc.querySelector("#tasks-bulk-done").click();
await settle();
await acceptConfirm();
ok(bulkCalls.some((c) => c.url === "/api/tasks/bulk" && c.body.done === true),
   "confirming a bulk complete didn't send done:true");
ok(!rowFor(5), "a bulk-completed task is still in the open list");

// Delete: same shape, different endpoint, and it must not go through the
// generic bulk update -- a "delete" that only patched would look identical
// on screen right up until the next reload.
w.state.taskSelection.clear();
w.renderTasksList();
rowFor(1).querySelector(".task-select").click();
await settle();
doc.querySelector("#tasks-bulk-delete").click();
await settle();
await acceptConfirm();
ok(bulkCalls.some((c) => c.url === "/api/tasks/bulk-delete"), "confirming a bulk delete didn't call the endpoint");
ok(!tasks.find((t) => t.id === 1), "the confirmed bulk delete didn't remove the row");
ok(w.state.taskSelection.size === 0, "the deleted rows stayed selected");

// Cancelling has to be a real no-op, not a slower yes.
const callsBefore = bulkCalls.length;
rowFor(3).querySelector(".task-select").click();
await settle();
doc.querySelector("#tasks-bulk-delete").click();
await settle();
doc.querySelector("#confirm-cancel").click();
await settle();
ok(bulkCalls.length === callsBefore, "cancelling a bulk delete still sent the request");
ok(tasks.find((t) => t.id === 3), "cancelling a bulk delete removed the row anyway");
w.state.taskSelection.clear();
w.renderTasksList();

/* ---------- empty states still say something useful ---------- */
doc.querySelector("#task-search").value = "zzzz-no-such-task";
doc.querySelector("#task-search").dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(doc.querySelector("#tasks-list .empty-state"), "an empty filtered list rendered nothing at all");
ok(/No tasks match/.test(doc.querySelector("#tasks-list").textContent),
   "the search empty state doesn't explain why the list is empty");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("tasks: due-date grouping, stat-card filters, selection, bulk assign/due/urgent/delete, inline edits");
