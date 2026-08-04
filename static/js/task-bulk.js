import { $, $$, get, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { esc } from "./shortcuts.js";
import { state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { wireListKeyboard } from "./list-keyboard.js";
import { assigneeSummaryLabel, renderAssigneeMenu, wireAssigneeToggle } from "./multi-picker.js";
import { renderTasksList, resetTaskView, visibleTasks } from "./tasks.js";

/* ==================================================================
   TASK SELECTION + BULK EDIT
   ==================================================================
   The board can already turn eight stalled cars into eight follow-ups in one
   click. It creates them unassigned and undated, because who and when are
   decisions you make once you're looking at the list -- and until now the only
   way to record those decisions was to open eight rows. Everything below
   exists to close that loop. */

export function selectTaskRange(fromId, toId) {
  const ids = visibleTasks().map((t) => t.id);
  const a = ids.indexOf(fromId), b = ids.indexOf(toId);
  if (a === -1 || b === -1) return state.taskSelection.add(toId);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.taskSelection.add(ids[i]);
}

export function syncTaskSelectAll(rows) {
  const box = $("#tasks-select-all");
  if (!box) return;
  const n = rows.filter((t) => state.taskSelection.has(t.id)).length;
  box.checked = rows.length > 0 && n === rows.length;
  box.indeterminate = n > 0 && n < rows.length;
  box.disabled = !rows.length;
}

function selectedTaskIds() {
  return [...state.taskSelection];
}

export function renderTaskBulkBar() {
  const n = state.taskSelection.size;
  const bar = $("#tasks-bulk-bar");
  if (!bar) return;
  bar.hidden = !n;
  if (!n) return;
  $("#tasks-bulk-count").textContent = `${n} selected`;
  const chosen = state.tasks.filter((t) => state.taskSelection.has(t.id));
  // "Flag Urgent" flips to "Clear Urgent" once everything selected already
  // carries the flag -- otherwise the button is a no-op you can press forever.
  const allUrgent = chosen.length > 0 && chosen.every((t) => t.urgent);
  $("#tasks-bulk-urgent").textContent = allUrgent ? "Clear Urgent" : "Flag Urgent";
  $("#tasks-bulk-urgent").dataset.next = allUrgent ? "0" : "1";
  $("#tasks-bulk-done").textContent = n === 1 ? "Complete" : `Complete ${n}`;
  renderBulkAssigneeMenu(chosen);
}

/* Tri-state on purpose. Checked means every selected task has that person,
   indeterminate means some do. Checking adds them to the rest rather than
   overwriting the row, and unchecking takes them off -- an assignment picker
   that replaced the list would silently drop whoever else was already on a
   task that happened to be in the selection, which is the kind of data loss
   nobody notices until the person who was dropped doesn't show up. */
function renderBulkAssigneeMenu(chosen) {
  const menuEl = $("#tasks-bulk-assignee-menu");
  const toggleEl = $("#tasks-bulk-assignee-toggle");
  if (!menuEl || !toggleEl) return;
  const countFor = (name) => chosen.filter((t) => t.assigned_to.includes(name)).length;
  menuEl.innerHTML = state.staff.length
    ? state.staff.map((s) => {
        const has = countFor(s.name);
        const all = has === chosen.length && chosen.length > 0;
        return `<label class="ms-option"><input type="checkbox" value="${esc(s.name)}" ${all ? "checked" : ""} data-some="${has && !all ? "1" : ""}"> ${esc(s.name)}${has && !all ? ` <span class="ms-partial">${has}/${chosen.length}</span>` : ""}</label>`;
      }).join("")
    : `<div class="ms-empty">No staff yet</div>`;
  const everyone = state.staff.filter((s) => countFor(s.name) === chosen.length && chosen.length);
  toggleEl.textContent = everyone.length ? `Assigned: ${assigneeSummaryLabel(everyone.map((s) => s.name))}` : "Assign to…";
  $$("input[type=checkbox]", menuEl).forEach((cb) => {
    if (cb.dataset.some) cb.indeterminate = true;
    cb.addEventListener("change", async () => {
      await applyTaskBulk({ assigned_to: [cb.value], assign_mode: cb.checked ? "add" : "remove" },
                          cb.checked ? `Assigned to ${cb.value}` : `Removed ${cb.value}`);
    });
  });
}

/* One request for N rows rather than N requests. Beyond the round trips, the
   server applies them in a single transaction and refuses the whole batch if
   any id is missing -- so the toast's count is one the server actually
   verified, instead of an optimistic tally of promises that mostly settled. */
async function applyTaskBulk(patchBody, successMessage) {
  const ids = selectedTaskIds();
  if (!ids.length) return;
  try {
    const res = await post("/api/tasks/bulk", { ids, ...patchBody });
    await loadTasks();
    toast(`${successMessage} · ${res.updated} task${res.updated === 1 ? "" : "s"}`);
  } catch (err) {
    toast(err.message, true);
  }
}

function wireTaskBulkActions() {
  wireAssigneeToggle($("#tasks-bulk-assignee-toggle"), $("#tasks-bulk-assignee-menu"));

  $("#tasks-select-all").addEventListener("change", (e) => {
    const rows = visibleTasks();
    if (e.target.checked) rows.forEach((t) => state.taskSelection.add(t.id));
    else state.taskSelection.clear();
    renderTasksList();
  });

  $("#tasks-bulk-clear").addEventListener("click", () => {
    state.taskSelection.clear();
    state.taskAnchor = null;
    renderTasksList();
  });

  $("#tasks-bulk-due").addEventListener("change", async (e) => {
    const value = e.target.value;
    if (!value) return;
    e.target.value = "";
    await applyTaskBulk({ due_date: value }, `Due ${value}`);
  });

  // Setting a date could always be done in bulk; clearing one couldn't.
  $("#tasks-bulk-due-clear").addEventListener("click", async () => {
    await applyTaskBulk({ due_date: "" }, "Due date cleared");
  });

  $("#tasks-bulk-urgent").addEventListener("click", async (e) => {
    const on = e.currentTarget.dataset.next === "1";
    await applyTaskBulk({ urgent: on }, on ? "Flagged urgent" : "Urgent cleared");
  });

  // Completing and deleting both confirm, because both make a selection you
  // can no longer see -- and unlike the per-row buttons, they take the whole
  // batch with them.
  $("#tasks-bulk-done").addEventListener("click", async () => {
    const n = state.taskSelection.size;
    if (!(await confirmAction({
      eyebrow: "TASKS",
      title: n === 1 ? "Complete this task?" : `Complete ${n} tasks?`,
      body: "They move to the completed list and drop off the board's counts.",
      confirmLabel: n === 1 ? "Complete Task" : `Complete ${n} Tasks`,
    }))) return;
    await applyTaskBulk({ done: true }, "Completed");
  });

  $("#tasks-bulk-delete").addEventListener("click", async () => {
    const n = state.taskSelection.size;
    if (!(await confirmAction({
      eyebrow: "TASKS",
      title: n === 1 ? "Delete this task?" : `Delete ${n} tasks?`,
      body: "This can't be undone. Complete them instead if you want a record.",
      confirmLabel: n === 1 ? "Delete Task" : `Delete ${n} Tasks`,
      danger: true,
    }))) return;
    const ids = selectedTaskIds();
    try {
      const res = await post("/api/tasks/bulk-delete", { ids });
      state.taskSelection.clear();
      await loadTasks();
      toast(`Deleted ${res.deleted} task${res.deleted === 1 ? "" : "s"}`);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- preferences ----------
   Same rule as the board and Reports: the screen opens on the view you were
   last using. Selection is deliberately not persisted -- a selection restored
   from a previous session is a set of rows you don't remember picking sitting
   in front of a Delete button. */
const TASK_PREFS_KEY = "dao-task-prefs";

function loadTaskPrefs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(TASK_PREFS_KEY) || "null"); } catch { saved = null; }
  if (!saved) return;
  if (typeof saved.filter === "string") state.taskFilter = saved.filter;
  if (["", "overdue", "today", "unassigned"].includes(saved.card)) state.taskCard = saved.card;
  if (typeof saved.assignee === "string") state.taskAssignee = saved.assignee;
  state.taskUrgentOnly = !!saved.urgentOnly;
  state.showCompletedTasks = !!saved.showCompleted;
  $$('#view-tasks [data-task-filter]').forEach((c) => c.classList.toggle("active", c.dataset.taskFilter === state.taskFilter));
}

export function saveTaskPrefs() {
  try {
    localStorage.setItem(TASK_PREFS_KEY, JSON.stringify({
      filter: state.taskFilter,
      card: state.taskCard,
      assignee: state.taskAssignee,
      urgentOnly: state.taskUrgentOnly,
      showCompleted: state.showCompletedTasks,
    }));
  } catch {}
}

/* The options for every vehicle picker on this screen -- the quick-add box and
   the per-row "+ vehicle" slot -- built once here.

   Rows come from /api/tasks/linkable-orders already labelled, already in
   display order, and already stripped of the two kinds of ticket nobody wants
   offered: voided ones, and cars sold and archived to History. The screen used
   to build this out of the whole of /api/orders and filter it by segment in
   the browser, which meant a dropdown that grew forever and two hand-written
   copies of the same label formatting.

   Headings come off the row rather than a map here, so Recon / We-Owe / Retail
   are named in exactly one place. */
export function taskOrderOptionsHtml(orders, placeholder) {
  let html = `<option value="">${esc(placeholder)}</option>`;
  let group = null;
  for (const o of orders || []) {
    if (o.group !== group) {
      if (group !== null) html += `</optgroup>`;
      group = o.group;
      html += `<optgroup label="${esc(group || "Other")}">`;
    }
    html += `<option value="${esc(o.value)}">${esc(o.label)}</option>`;
  }
  return group === null ? html : `${html}</optgroup>`;
}

/* What to send for a picked option.

   The option value is "order:8" / "recon:4" / "we_owe:2" rather than a bare
   number, because a follow-up can now name a car that has no ticket on it and
   an id alone can't say which of the two it means. Looked up in the list the
   server sent rather than parsed here, so the browser never invents a link the
   server didn't offer. */
export function taskLinkFields(value) {
  const CLEARED = { order_id: -1, recon_vehicle_id: -1, we_owe_id: -1 };
  if (!value) return CLEARED;
  const entry = (state.taskOrders || []).find((o) => o.value === value);
  if (!entry) return CLEARED;
  return {
    order_id: entry.order_id ?? -1,
    recon_vehicle_id: entry.recon_vehicle_id ?? -1,
    we_owe_id: entry.we_owe_id ?? -1,
  };
}

function renderTaskOrderSelect(orders) {
  $("#task-order-input").innerHTML = taskOrderOptionsHtml(orders, "No vehicle");
}

// Tasks only -- what a checkbox tick, a rename or a bulk edit needs.
// Refetching (and re-rendering) the entire orders list on every one of those
// was most of this screen's latency, and it stomped the vehicle select while
// a user might be mid-pick.
export async function loadTasks() {
  try {
    state.tasks = await get("/api/tasks");
    renderTasksList();
  } catch (err) {
    renderViewFailure("tasks", err);
  }
}

export async function loadTasksView() {
  try {
    if (!state.staff.length) state.staff = await get("/api/staff");
    renderAssigneeMenu($("#task-assignee-menu"), $("#task-assignee-toggle"), state.newTaskAssignees, (names) => {
      state.newTaskAssignees = names;
    });
    renderTaskAssigneeFilter();
    const [tasks, orders] = await Promise.all([get("/api/tasks"), get("/api/tasks/linkable-orders")]);
    state.tasks = tasks;
    // Kept for the per-row "+ vehicle" picker, which builds its select from
    // this list on demand rather than refetching orders on every row edit.
    state.taskOrders = orders;
    renderTaskOrderSelect(orders);
    renderTasksList();
  } catch (err) {
    renderViewFailure("tasks", err);
  }
}

// The per-person filter select -- "what does Antonio have?" without hoping
// his name isn't also in a task title.
function renderTaskAssigneeFilter() {
  const sel = $("#tasks-assignee-filter");
  if (!sel) return;
  sel.innerHTML = `<option value="">Anyone</option>` +
    state.staff.map((s) => `<option value="${esc(s.name)}" ${state.taskAssignee === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  sel.value = state.taskAssignee || "";
}

export function wireTasksView() {
  wireAssigneeToggle($("#task-assignee-toggle"), $("#task-assignee-menu"));

  $("#tasks-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-empty-action]");
    if (!btn) return;
    if (btn.dataset.emptyAction === "tasks-reset-view") resetTaskView();
    else if (btn.dataset.emptyAction === "add-task") $("#task-title-input")?.focus();
  });

  $("#task-quick-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#task-title-input").value.trim();
    if (!title) return;
    // Entering four tasks for the same car on the same day shouldn't mean
    // re-picking the vehicle and date four times: only the title, urgency
    // and assignees reset, and focus goes straight back to the title box.
    const keepOrder = $("#task-order-input").value;
    const keepDue = $("#task-due-input").value;
    try {
      const link = taskLinkFields(keepOrder);
      await post("/api/tasks", {
        title,
        assigned_to: state.newTaskAssignees,
        due_date: keepDue,
        urgent: $("#task-urgent-input").checked,
        // -1 is the PATCH unlink sentinel; a create just wants nothing set.
        order_id: link.order_id === -1 ? null : link.order_id,
        recon_vehicle_id: link.recon_vehicle_id === -1 ? null : link.recon_vehicle_id,
        we_owe_id: link.we_owe_id === -1 ? null : link.we_owe_id,
      });
      $("#task-title-input").value = "";
      $("#task-urgent-input").checked = false;
      state.newTaskAssignees = [];
      renderAssigneeMenu($("#task-assignee-menu"), $("#task-assignee-toggle"), [], (names) => {
        state.newTaskAssignees = names;
      });
      toast("Task added");
      await loadTasks();
      $("#task-order-input").value = keepOrder;
      $("#task-due-input").value = keepDue;
      $("#task-title-input").focus();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $$('#view-tasks [data-task-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      $$('#view-tasks [data-task-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.taskFilter = chip.dataset.taskFilter;
      state.taskSelection.clear();
      saveTaskPrefs();
      renderTasksList();
    });
  });

  // Delegated off the container and keyed on data-task-card rather than bound
  // per button, so the cards keep working across re-renders -- and clicking a
  // lit card clears it, which is the only obvious way back out of a filter you
  // reached by clicking a number.
  $(".stats-tasks").addEventListener("click", (e) => {
    const card = e.target.closest("[data-task-card]");
    if (!card || card.disabled) return;
    state.taskCard = state.taskCard === card.dataset.taskCard ? "" : card.dataset.taskCard;
    state.taskSelection.clear();
    saveTaskPrefs();
    renderTasksList();
  });

  $("#tasks-urgent-filter").addEventListener("click", () => {
    state.taskUrgentOnly = !state.taskUrgentOnly;
    state.taskSelection.clear();
    saveTaskPrefs();
    renderTasksList();
  });

  $("#tasks-reset-view").addEventListener("click", resetTaskView);

  $("#tasks-assignee-filter").addEventListener("change", (e) => {
    state.taskAssignee = e.target.value;
    state.taskSelection.clear();
    saveTaskPrefs();
    renderTasksList();
  });

  // Debounced: every keystroke used to rebuild the full open + completed
  // lists (and rebind every row's listeners) synchronously.
  let taskSearchTimer = null;
  $("#task-search").addEventListener("input", (e) => {
    clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(() => {
      state.taskSearch = e.target.value.trim();
      renderTasksList();
    }, 120);
  });

  $("#tasks-toggle-completed").addEventListener("click", () => {
    state.showCompletedTasks = !state.showCompletedTasks;
    saveTaskPrefs();
    renderTasksList();
  });

  wireTaskBulkActions();
  loadTaskPrefs();

  // The shared triage-list keyboard model (see wireListKeyboard). Enter
  // fires the done-check, not a detail page -- a task *is* its row -- and
  // goes through the row's own button rather than a parallel code path, so
  // the keyboard can never mean something different from the click. Wired
  // after wireShortcutsDialog (see init order) so "?" reaches the overlay
  // before type-to-search can eat it.
  wireListKeyboard({
    view: "#view-tasks",
    search: "#task-search",
    searchEscape: (box) => {
      if (!box.value && !state.taskSearch) return;
      box.value = "";
      state.taskSearch = "";
      renderTasksList();
    },
    move: moveTaskCursor,
    primary: () => {
      if (state.taskCursor == null) return;
      $(`#tasks-list .task-row[data-id="${state.taskCursor}"] .task-check`)?.click();
    },
    select: () => {
      if (state.taskCursor == null) return false;
      if (state.taskSelection.has(state.taskCursor)) state.taskSelection.delete(state.taskCursor);
      else state.taskSelection.add(state.taskCursor);
      state.taskAnchor = state.taskCursor;
      renderTasksList();
    },
    escape: () => {
      if (state.taskSelection.size) {
        state.taskSelection.clear();
        state.taskAnchor = null;
        renderTasksList();
      } else if (state.taskCursor != null) {
        state.taskCursor = null;
        applyTaskCursor();
      }
    },
  });
}

/* Cursor movement over the open list in *display* order. The DOM is the
   source of truth here, not visibleTasks(): the list renders grouped by due
   bucket, so the array's sort order and the order your eyes travel are not
   the same thing, and an ArrowDown that jumped buckets mid-screen would feel
   broken even though it followed the data faithfully. */
function moveTaskCursor(delta) {
  const rows = $$("#tasks-list .task-row");
  if (!rows.length) return;
  const ids = rows.map((r) => Number(r.dataset.id));
  const at = state.taskCursor != null ? ids.indexOf(state.taskCursor) : -1;
  let next;
  if (delta === "first") next = 0;
  else if (delta === "last") next = ids.length - 1;
  else next = at === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
  state.taskCursor = ids[next];
  applyTaskCursor();
  if (rows[next].scrollIntoView) rows[next].scrollIntoView({ block: "nearest" });
}

/* Repaints the cursor class without a full re-render -- arrowing down a long
   list must not rebuild every row's listeners per keystroke. */
function applyTaskCursor() {
  $$("#tasks-list .task-row").forEach((r) =>
    r.classList.toggle("cursor", Number(r.dataset.id) === state.taskCursor));
}
