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
// Local calendar dates, NOT toISOString(): the app buckets due dates against
// the *local* midnight (taskDueInfo parses `T00:00:00`), so a UTC-sliced
// fixture goes stale for the hours around midnight UTC -- iso(0) would name
// tomorrow, "due today" would land in the wrong group, and this suite would
// fail only when run in the evening (US time). It did.
const iso = (n) => {
  const d = new Date(NOW + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
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

// What the vehicle picker gets from /api/orders. All three segments are
// offered now that retail ROs have a vehicle page of their own.
const ORDERS = [
  { id: 42, segment: "recon", stock_number: "R-0981", year: 2019, make: "Ford", model: "Edge", customer_name: null, number: "RO-1042" },
  { id: 55, segment: "we_owe", stock_number: null, year: 2021, make: "Kia", model: "Sorento", customer_name: "Maria Soto", number: "RO-1077" },
  { id: 60, segment: "retail", stock_number: null, year: 2020, make: "Ford", model: "F-150", customer_name: "Bob Lang", number: "RO-1080" },
];

// The JOIN fields /api/tasks carries for each linkable order, so the PATCH
// handler below can answer a link the way the real server would.
const ORDER_JOIN = {
  42: { order_label: "R-0981", order_segment: "recon", order_recon_vehicle_id: 7, order_we_owe_id: null, order_number: "RO-1042" },
  55: { order_label: "Maria Soto", order_segment: "we_owe", order_recon_vehicle_id: null, order_we_owe_id: 9, order_number: "RO-1077" },
};
const NO_ORDER = { order_id: null, order_label: null, order_segment: null, order_recon_vehicle_id: null, order_we_owe_id: null, order_number: null };

const bulkCalls = [];
const patchCalls = [];

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
    // A single-row PATCH applies to the fixture rather than echoing the row
    // back unchanged: the inline editors below all re-read the list after
    // saving, so a handler that lies about the result would let an editor that
    // sends the wrong field pass on the strength of its own optimistic render.
    if (url.startsWith("/api/tasks/") && opts.method === "PATCH") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse(opts.body);
      patchCalls.push({ id, body });
      tasks = tasks.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t, ...body };
        if (body.urgent !== undefined) next.urgent = body.urgent ? 1 : 0;
        if (body.done !== undefined) next.done = body.done ? 1 : 0;
        // Server semantics for the link: -1 clears, an id fills in the join
        // fields the task list view is built from. A fixture that only echoed
        // order_id back would let the UI pass while rendering a chip with no
        // label and a jump that goes nowhere.
        if (body.order_id !== undefined) {
          if (body.order_id === -1) Object.assign(next, NO_ORDER);
          else Object.assign(next, { order_id: body.order_id }, ORDER_JOIN[body.order_id] || {});
        }
        return next;
      });
      return tasks.find((t) => t.id === id);
    }
    if (url.startsWith("/api/tasks/")) return tasks.find((t) => t.id === Number(url.split("/").pop())) || tasks[0];
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return ORDERS;
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
// The search box re-renders on a 120ms debounce, and settle() only spins
// zero-length timers -- typing into it has to outwait the real timer or every
// assertion after it reads the un-filtered list.
const typeSearch = async (value) => {
  const box = doc.querySelector("#task-search");
  box.value = value;
  box.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  await settle();
};

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
await typeSearch("nothing matches this");
ok(doc.querySelector('[data-task-card="today"]').disabled, "a zero-count card is still clickable");
await typeSearch("");

/* ---------- selection ---------- */
// Visibility is the [hidden] attribute, not style.display -- asserting the
// latter here quietly tested nothing (jsdom leaves style untouched either way).
ok(doc.querySelector("#tasks-bulk-bar").hidden, "the bulk bar is showing with nothing selected");
// Completed rows get no checkbox: every bulk action here is an edit to work
// that still has to happen, and "reopen these six" isn't one of them.
const doneRow = doc.querySelector('#tasks-completed-list .task-row[data-id="6"]');
ok(doneRow, "the completed task didn't render in the completed list");
ok(doneRow && !doneRow.querySelector(".task-select"), "a completed task offers a bulk-edit checkbox");

rowFor(3).querySelector(".task-select").click();
await settle();
ok(!doc.querySelector("#tasks-bulk-bar").hidden, "the bulk bar stayed hidden after selecting a row");
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
ok(doc.querySelector("#tasks-bulk-bar").hidden, "the bulk bar survived Escape");

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
await typeSearch("call John");        // matches task 3 only
ok(rowsIn("#tasks-list").length === 1, `the search left ${rowsIn("#tasks-list").length} rows, expected 1`);
ok(w.state.taskSelection.size === 1 && w.state.taskSelection.has(3),
   `the selection didn't follow the search down: ${JSON.stringify([...w.state.taskSelection])}`);
ok(/1 selected/.test(doc.querySelector("#tasks-bulk-count").textContent),
   `bulk bar reads "${doc.querySelector("#tasks-bulk-count").textContent}" over 1 visible row`);
await typeSearch("");
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

/* Title and notes were the last two write-once fields on this row, and they're
   the two the board's bulk button is worst at: it generates titles like
   "Follow up: R-0981 — no work in 41 days" and no note at all. A generated
   title is a fine prompt and a poor permanent name. */
const titleEl = rowFor(3).querySelector(".task-title");
ok(titleEl && titleEl.tagName === "BUTTON", "the task title isn't a control anyone can click or tab to");
titleEl.click();
await settle();
let titleInput = rowFor(3).querySelector(".task-inline-edit");
ok(titleInput, "clicking the title didn't swap in an editor");
ok(titleInput.value === "Overdue: call John about his Civic",
   `the title editor opened holding "${titleInput.value}" rather than the current title`);
titleInput.value = "Call John — his Civic is ready";
titleInput.dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
const titlePatch = patchCalls.find((c) => c.id === 3 && c.body.title);
ok(titlePatch, "committing a title edit sent no PATCH");
ok(titlePatch && titlePatch.body.title === "Call John — his Civic is ready",
   `the title PATCH carried "${titlePatch && titlePatch.body.title}"`);
ok(!("notes" in (titlePatch?.body || {})), "the title editor sent the notes field along with it");
ok(rowFor(3).querySelector(".task-title").textContent.trim() === "Call John — his Civic is ready",
   "the row didn't re-render with the new title");

/* Escape has to abandon, and abandoning has to be silent. An editor that
   saves on the way out of an Escape is worse than one that can't be escaped
   at all, because the user believes they cancelled. */
const patchesBefore = patchCalls.length;
rowFor(3).querySelector(".task-title").click();
await settle();
titleInput = rowFor(3).querySelector(".task-inline-edit");
titleInput.value = "typed then thought better of it";
press(w, "Escape", { target: titleInput });
await settle();
ok(patchCalls.length === patchesBefore, "Escape out of a title edit still saved");
ok(rowFor(3).querySelector(".task-title").textContent.trim() === "Call John — his Civic is ready",
   "Escape left the abandoned text on the row");

// An unchanged value is not an edit. Opening a title and clicking away is the
// most common thing that happens to an inline editor by accident.
rowFor(3).querySelector(".task-title").click();
await settle();
titleInput = rowFor(3).querySelector(".task-inline-edit");
titleInput.dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
ok(patchCalls.length === patchesBefore, "opening and closing a title with no change still sent a PATCH");

// An empty title is the one edit the server rejects outright, so the row
// refuses it rather than trading a 422 for the user's text.
rowFor(3).querySelector(".task-title").click();
await settle();
titleInput = rowFor(3).querySelector(".task-inline-edit");
titleInput.value = "   ";
titleInput.dispatchEvent(new w.Event("blur", { bubbles: false }));
await settle();
ok(patchCalls.length === patchesBefore, "a blanked title was sent to the server anyway");
ok(rowFor(3).querySelector(".task-title").textContent.trim() === "Call John — his Civic is ready",
   "a blanked title wiped the row's heading on screen");

/* Notes: the board creates every task without one, so the affordance to add
   the first note matters more than editing an existing one. */
ok(!rowFor(3).querySelector(".task-notes"), "a task with no notes is rendering an empty note block");
const addNote = rowFor(3).querySelector(".task-notes-add");
ok(addNote, "a task without notes offers no way to add one");
addNote.click();
await settle();
const noteInput = rowFor(3).querySelector(".task-inline-notes");
ok(noteInput && noteInput.tagName === "TEXTAREA",
   "the note editor isn't a textarea -- notes run to more than one line");
ok(noteInput.value === "", "the note editor opened pre-filled on a task that has no note");
noteInput.value = "Left a voicemail Tuesday.\nTry the shop number next.";
// Ctrl+Enter rather than Enter: a bare Enter has to keep making newlines here.
press(w, "Enter", { target: noteInput, ctrlKey: true });
await settle();
const notePatch = patchCalls.find((c) => c.id === 3 && c.body.notes);
ok(notePatch, "saving a note sent no PATCH");
ok(notePatch && /voicemail Tuesday/.test(notePatch.body.notes), `the note PATCH carried "${notePatch && notePatch.body.notes}"`);
ok(!("title" in (notePatch?.body || {})), "the note editor sent the title field along with it");
const noteEl = rowFor(3).querySelector(".task-notes");
ok(noteEl && /Try the shop number next/.test(noteEl.textContent), "the saved note didn't render on the row");
ok(!rowFor(3).querySelector(".task-notes-add"), "the + note chip is still offered on a task that now has a note");

// And an existing note reopens holding what's there, newlines intact.
noteEl.click();
await settle();
const reopened = rowFor(3).querySelector(".task-inline-notes");
ok(reopened && reopened.value.split("\n").length === 2,
   `reopening a two-line note gave ${JSON.stringify(reopened && reopened.value)}`);
press(w, "Escape", { target: reopened });
await settle();

/* ---------- vehicle link / unlink ----------
   The vehicle link was the last write-once field on this row. The API took
   order_id via PATCH (with -1 as the clear sentinel) all along; the UI never
   offered a control, so tasks created without a car could never gain one and
   tasks created against the wrong car were stuck with it. */
const linkedRow = rowFor(2);
ok(linkedRow.querySelector(".task-order-link"), "a linked row lost its jump chip");
ok(linkedRow.querySelector(".task-link-clear"), "a linked row offers no way to unlink");
ok(!linkedRow.querySelector(".task-link-add"), "a linked row still offers the + vehicle slot");
ok(rowFor(3).querySelector(".task-link-add"), "an unlinked row offers no + vehicle slot");
// A done task's link is history, not a decision anyone should still be making.
const doneRow2 = doc.querySelector('#tasks-completed-list .task-row[data-id="6"]');
ok(doneRow2 && !doneRow2.querySelector(".task-link-add") && !doneRow2.querySelector(".task-link-clear"),
   "a completed task still offers link editors");

// Link: the slot swaps for a picker in place; choosing saves; the row
// re-renders off what the server sent back, not an optimistic label.
rowFor(3).querySelector(".task-link-add").click();
await settle();
const linkSelect = rowFor(3).querySelector(".task-link-edit");
ok(linkSelect && linkSelect.tagName === "SELECT", "clicking + vehicle didn't swap in a picker");
ok([...linkSelect.options].some((o) => /R-0981/.test(o.textContent)), "the picker is missing the recon vehicle");
ok([...linkSelect.options].some((o) => /Maria Soto/.test(o.textContent)), "the picker is missing the we-owe vehicle");
// Retail ROs have a vehicle page now -- the picker offers them too.
ok([...linkSelect.options].some((o) => /Bob Lang/.test(o.textContent)), "the picker is missing the retail vehicle");
linkSelect.value = "55";
linkSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
const linkPatch = patchCalls.find((c) => c.id === 3 && c.body.order_id === 55);
ok(linkPatch, "choosing a vehicle sent no PATCH");
const newChip = rowFor(3).querySelector(".task-order-link");
ok(newChip && /Maria Soto/.test(newChip.textContent), "the newly linked row didn't render its vehicle chip");
ok(rowFor(3).querySelector(".task-link-clear"), "the newly linked row can't be unlinked");

// Escape abandons silently -- same contract as every other editor on the row.
const linkPatchesBefore = patchCalls.length;
rowFor(1).querySelector(".task-link-add").click();
await settle();
const abandonedPicker = rowFor(1).querySelector(".task-link-edit");
ok(abandonedPicker, "the second + vehicle slot didn't open a picker");
press(w, "Escape", { target: abandonedPicker });
await settle();
ok(patchCalls.length === linkPatchesBefore, "Escape out of the vehicle picker still saved");
ok(rowFor(1).querySelector(".task-link-add"), "Escape didn't put the + vehicle slot back");

// Unlink: the × sends the API's -1 sentinel (null means "leave it alone",
// since PATCH bodies simply omit untouched fields).
rowFor(2).querySelector(".task-link-clear").click();
await settle();
ok(patchCalls.some((c) => c.id === 2 && c.body.order_id === -1), "the unlink × didn't send the -1 sentinel");
ok(!rowFor(2).querySelector(".task-order-link"), "an unlinked row kept its vehicle chip");
ok(rowFor(2).querySelector(".task-link-add"), "an unlinked row didn't get the + vehicle slot back");

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
await typeSearch("zzzz-no-such-task");
ok(doc.querySelector("#tasks-list .empty-state"), "an empty filtered list rendered nothing at all");
ok(/No tasks match/.test(doc.querySelector("#tasks-list").textContent),
   "the search empty state doesn't explain why the list is empty");

/* ---------- keyboard model ----------
   The same contract the board's suite pins down, because it's the same model:
   arrows walk a cursor in *display* order (bucket by bucket, not array
   order), Space selects, Enter fires the row's own done-check, "/" and bare
   letters land in this screen's search box, and Escape backs out one layer
   at a time. The cursor assertions read the DOM rather than the fixture so
   they can't drift from what the grouping actually painted. */
await typeSearch("");

const openIds = () => rowsIn("#tasks-list").map((r) => Number(r.dataset.id));
const cursorId = () => {
  const r = doc.querySelector("#tasks-list .task-row.cursor");
  return r ? Number(r.dataset.id) : null;
};
const searchBox = doc.querySelector("#task-search");

const order = openIds();
ok(order.length >= 3, `keyboard cases need at least 3 open rows, got ${order.length}`);

press(w, "ArrowDown");
ok(cursorId() === order[0], "the first ArrowDown didn't land on the first visible row");
press(w, "ArrowDown");
ok(cursorId() === order[1], "the second ArrowDown didn't move to the second visible row");
press(w, "End");
ok(cursorId() === order[order.length - 1], "End didn't jump to the last row");
press(w, "ArrowDown");
ok(cursorId() === order[order.length - 1], "ArrowDown past the end didn't clamp at the last row");
press(w, "Home");
ok(cursorId() === order[0], "Home didn't jump back to the first row");
press(w, "ArrowUp");
ok(cursorId() === order[0], "ArrowUp past the top didn't clamp at the first row");

// Space selects, and the cursor has to survive the re-render selection causes.
press(w, " ");
await settle();
ok(w.state.taskSelection.has(order[0]), "Space didn't select the cursor row");
ok(cursorId() === order[0], "the cursor didn't survive the selection re-render");
press(w, " ");
await settle();
ok(!w.state.taskSelection.has(order[0]), "Space on a selected row didn't deselect it");

// Keys typed into a field belong to the field.
press(w, "ArrowDown", { target: searchBox });
ok(cursorId() === order[0], "an arrow key inside an input still moved the list cursor");

// "/" and type-to-search both land in this screen's search box.
press(w, "/");
ok(doc.activeElement === searchBox, '"/" didn\'t focus the tasks search box');
searchBox.blur();
press(w, "g");
ok(doc.activeElement === searchBox, "type-to-search didn't focus the search box");

// Escape inside the box clears a pending search without leaving the box.
searchBox.value = "civic";
w.state.taskSearch = "civic";
press(w, "Escape", { target: searchBox });
await settle();
ok(w.state.taskSearch === "" && searchBox.value === "", "Escape in the search box didn't clear it");
searchBox.blur();

// Escape backs out one layer at a time: selection first, then the cursor.
press(w, " ");
await settle();
press(w, "Escape");
await settle();
ok(w.state.taskSelection.size === 0, "Escape didn't drop the selection");
ok(cursorId() != null, "the first Escape dropped the cursor along with the selection");
press(w, "Escape");
ok(cursorId() === null && w.state.taskCursor === null, "the second Escape didn't drop the cursor");

// Enter goes through the row's own done-check, so keyboard and click can
// never mean different things.
press(w, "ArrowDown");
const enterTarget = cursorId();
const patchesBeforeEnter = patchCalls.length;
press(w, "Enter");
await settle();
ok(patchCalls.slice(patchesBeforeEnter).some((c) => c.id === enterTarget && c.body.done === true),
   "Enter on the cursor row didn't PATCH it done");
ok(!openIds().includes(enterTarget), "the Enter-completed row is still in the open list");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("tasks: due-date grouping, stat-card filters, selection, bulk assign/due/urgent/delete, inline edits, vehicle link/unlink, keyboard cursor model");
