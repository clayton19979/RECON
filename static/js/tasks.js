import { $, $$, api, patch } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { actorLabel, byActor, currentActor, esc, relativeTime } from "./shortcuts.js";
import { EMPTY_ICONS, emptyState } from "./empty-states.js";
import { state } from "./state.js";
import { openVehicleDetail } from "./vehicle-detail.js";
import { assigneeSummaryLabel, renderAssigneeMenu, wireAssigneeToggle } from "./multi-picker.js";
import { loadTasks, renderTaskBulkBar, saveTaskPrefs, selectTaskRange, syncTaskSelectAll, taskLinkFields, taskOrderOptionsHtml } from "./task-bulk.js";

/* ==================================================================
   TASKS
   ================================================================== */
// Due-date coloring mirrors the Vehicles board's age-severity pattern --
// outliers (overdue, due today/tomorrow) jump out without reading every row.
// `days` is exposed alongside because the buckets, the stat cards and the
// chip all have to agree on what "overdue" means; three separate date
// comparisons would eventually disagree by a day at some timezone boundary.
export function taskDueInfo(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDate}T00:00:00`);
  const diffDays = Math.round((due - today) / 86400000);
  const cls = diffDays < 0 ? "overdue" : diffDays <= 1 ? "soon" : "";
  const label = diffDays === 0 ? "today"
    : diffDays === 1 ? "tomorrow"
    : diffDays === -1 ? "yesterday"
    : due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { cls, label, days: diffDays };
}

/* The list is grouped by when the work is due rather than shown flat. A flat
   list sorted by date reads as one undifferentiated column and gives no
   answer to the only question anyone opens this screen with -- what has to
   happen today. The headers are the answer, and they carry their own counts
   so an empty morning is visible without counting rows. */
const TASK_BUCKETS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due Today" },
  { key: "week", label: "Next 7 Days" },
  { key: "later", label: "Later" },
  { key: "none", label: "No Due Date" },
];

function taskBucket(t) {
  const due = taskDueInfo(t.due_date);
  if (!due) return "none";
  if (due.days < 0) return "overdue";
  if (due.days === 0) return "today";
  if (due.days <= 7) return "week";
  return "later";
}

// The one emoji in an otherwise all-SVG icon system rendered differently on
// every platform -- the board's own vehicle glyph replaces it.
const TASK_VEHICLE_SVG = `<svg viewBox="0 0 24 24">${EMPTY_ICONS.vehicle}</svg>`;

/* The vehicle link was the last write-once field on this row: settable in the
   quick-add form (and by the board's bulk button), then frozen forever. The
   API has taken order_id via PATCH -- with -1 as the unlink sentinel -- for a
   long time; the UI just never offered a control. So: an unlinked open row
   gets "+ vehicle" in the same dashed open-slot style as "+ due date", and a
   linked open row grows a small × beside the jump chip. Completed rows keep
   the jump chip but lose both editors -- a done task's link is history, not a
   decision anyone should still be making.

   A linked-but-unjumpable chip (a segment the detail view can't open, or a
   row missing its ref id) renders as static text instead of vanishing, because the × needs
   something to sit next to -- unlink is exactly what you want for a task
   pointing at a record you can no longer visit. */
/* A ticket that's been voided, or a car that's been sold and archived to
   History, is still the car the task is about -- the link stays. But an open
   follow-up on a car that left the lot a month ago used to be indistinguishable
   from one on a car sitting in the bay, and it's the first thing you'd want to
   know before spending the morning on it. The picker never offers these; this
   is only for links made before the car moved on. */
const TASK_ORDER_STATE_NOTE = { voided: "voided", archived: "in History" };
const TASK_ORDER_STATE_TITLE = {
  voided: "This ticket was voided — open the vehicle anyway",
  archived: "This car has been sent to History — open it anyway",
};

function taskVehicleChip(t, linkable, refId) {
  if (t.order_label || t.order_id) {
    const label = esc(t.order_label || t.order_number || `#${t.order_id}`);
    const note = TASK_ORDER_STATE_NOTE[t.order_state] || "";
    const body = `${TASK_VEHICLE_SVG}${label}${note ? `<span class="task-order-state">${note}</span>` : ""}`;
    const jump = linkable
      ? `<button type="button" class="task-order-link" data-segment="${t.link_segment}" data-ref-id="${refId}" title="${TASK_ORDER_STATE_TITLE[t.order_state] || "Open this vehicle"}">${body}</button>`
      : `<span class="task-order-link is-static">${body}</span>`;
    return `<span class="task-order-wrap">${jump}${t.done ? "" : `<button type="button" class="task-link-clear" title="Unlink this vehicle" aria-label="Unlink ${label} from ${esc(t.title)}">×</button>`}</span>`;
  }
  return t.done ? "" : `<button type="button" class="task-link-add" title="Link this task to a vehicle">+ vehicle</button>`;
}

function taskRowHtml(t) {
  const due = taskDueInfo(t.due_date);
  // Which page the chip opens. Worked out by the server now (link_segment /
  // link_ref_id), because a follow-up can name a car with no ticket on it and
  // the ticket's segment is then not there to be read.
  const refId = t.link_ref_id;
  const linkable = refId != null && (t.link_segment === "recon" || t.link_segment === "we_owe" || t.link_segment === "retail");
  const selected = state.taskSelection.has(t.id);
  const unassigned = !(t.assigned_to || []).length;
  // The cursor class rides along in the row markup rather than being painted
  // on afterwards, so it survives every re-render for free. Completed rows
  // never carry it: the keyboard model only walks the open list.
  const cursor = !t.done && state.taskCursor === t.id;
  return `
    <div class="task-row ${t.urgent ? "urgent" : ""} ${t.done ? "done" : ""} ${selected ? "selected" : ""} ${cursor ? "cursor" : ""}" data-id="${t.id}">
      ${t.done ? "" : `<input type="checkbox" class="task-select" ${selected ? "checked" : ""} title="Select for bulk edit" aria-label="Select ${esc(t.title)}">`}
      <button type="button" class="task-check" title="${t.done ? "Mark not done" : "Mark done"}" aria-pressed="${t.done ? "true" : "false"}" aria-label="Mark ${esc(t.title)} ${t.done ? "not done" : "done"}">
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
      </button>
      <div class="task-body">
        <button type="button" class="task-title" title="Click to rename">${esc(t.title)}</button>
        <div class="task-meta">
          <div class="ms-picker" data-id="${t.id}">
            <button type="button" class="ms-toggle task-assignee-toggle${unassigned ? " ms-toggle-empty" : ""}">${unassigned ? "+ assign" : esc(assigneeSummaryLabel(t.assigned_to))}</button>
            <div class="ms-menu task-assignee-menu"></div>
          </div>
          ${due
            ? `<button type="button" class="task-due ${due.cls}" data-due="${esc(t.due_date)}" title="Change the due date">Due ${due.label}</button>`
            : `<button type="button" class="task-due task-due-empty" data-due="" title="Set a due date">+ due date</button>`}
          <button type="button" class="task-flag ${t.urgent ? "on" : ""}" title="${t.urgent ? "Clear the urgent flag" : "Flag this urgent"}">${t.urgent ? "Urgent" : "Flag urgent"}</button>
          ${t.notes ? "" : `<button type="button" class="task-notes-add" title="Add a note">+ note</button>`}
          ${taskVehicleChip(t, linkable, refId)}
          <span>${esc(byActor(t.created_by, "by "))}${actorLabel(t.created_by) ? " · " : ""}${relativeTime(t.created_at)}${t.done && t.completed_at ? ` · done ${relativeTime(t.completed_at)}` : ""}</span>
        </div>
        ${t.notes ? `<button type="button" class="task-notes" title="Click to edit this note">${esc(t.notes)}</button>` : ""}
      </div>
      <button type="button" class="task-delete" title="Delete" aria-label="Delete ${esc(t.title)}">×</button>
    </div>
  `;
}

/* Swap a chip or a line of text for a real input, in place.

   Every editable thing on a task row wants the same five behaviours -- focus
   on open, commit on blur, commit on Enter, abandon on Escape, and never
   commit twice -- and the due-date chip was the only one that had them,
   written inline. Repeating that by hand for the title and the notes is how
   you end up with three subtly different Escape keys, so it lives here once.

   `commit` gets the trimmed value and is only called when it actually differs
   from the original; anything else falls through to a plain re-render, which
   is also what a failed save does. The caller supplies the re-render because
   the notes editor and the title editor have to put back different markup. */
export function inlineEdit(el, { value = "", multiline = false, placeholder = "", commit, cancel }) {
  const input = document.createElement(multiline ? "textarea" : "input");
  input.className = multiline ? "task-inline-edit task-inline-notes" : "task-inline-edit";
  if (!multiline) input.type = "text";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  if (multiline) input.rows = Math.min(6, Math.max(2, value.split("\n").length + 1));
  el.replaceWith(input);
  input.focus();
  // Caret at the end rather than the start: these open on an existing value
  // that people mostly want to append to or fix the tail of.
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (next === value.trim()) return cancel();
    await commit(next);
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      settled = true;
      cancel();
    } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      // A bare Enter in the notes box has to keep making newlines -- notes are
      // the one field on this row where more than one line is normal.
      e.preventDefault();
      finish();
    }
  });
  return input;
}

function wireTaskRowActions(container) {
  /* Title and notes were display-only: set once in the quick-add box and
     frozen after that. Same write-once shape the due date and the urgent flag
     had, and the same reason it matters -- the board's bulk button generates
     titles like "Follow up: R-0981 — no work in 41 days", which is a fine
     starting point and a poor permanent name, and it creates every one of
     them with no note at all. */
  const patchField = async (taskId, body, fallback) => {
    try {
      await patch(`/api/tasks/${taskId}`, body);
      await loadTasks();
    } catch (err) {
      toast(err.message, true);
      fallback();
    }
  };
  $$(".task-title", container).forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.closest(".task-row").dataset.id;
      inlineEdit(el, {
        value: el.textContent.trim(),
        cancel: renderTasksList,
        // An empty title is the one edit the server would reject outright, and
        // silently reverting is friendlier than a 422 for what is almost
        // always a select-all-and-delete on the way to retyping.
        commit: (title) => title
          ? patchField(id, { title }, renderTasksList)
          : (toast("A task needs a title", true), renderTasksList()),
      });
    });
  });
  $$(".task-notes, .task-notes-add", container).forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.closest(".task-row").dataset.id;
      const adding = el.classList.contains("task-notes-add");
      // The "+ note" affordance sits in the meta row, but its editor belongs
      // under it where the note itself will end up -- otherwise a multi-line
      // box appears wedged between two chips. The placeholder div is only ever
      // a location for replaceWith to aim at; a re-render clears it either way.
      const host = adding ? el.closest(".task-body").appendChild(document.createElement("div")) : el;
      inlineEdit(host, {
        value: adding ? "" : el.textContent.trim(),
        multiline: true,
        placeholder: "Note — Ctrl+Enter to save, Esc to cancel",
        cancel: renderTasksList,
        commit: (notes) => patchField(id, { notes }, renderTasksList),
      });
    });
  });
  $$(".task-check", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      try {
        await patch(`/api/tasks/${row.dataset.id}`, { done: !row.classList.contains("done") });
        await loadTasks();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".task-delete", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      if (!(await confirmAction({
        eyebrow: "TASK",
        title: "Delete this task?",
        body: (row?.querySelector(".task-title")?.textContent || "").trim(),
        confirmLabel: "Delete Task",
        danger: true,
      }))) return;
      try {
        await api(`/api/tasks/${row.dataset.id}`, { method: "DELETE" });
        await loadTasks();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  // [data-ref-id] keeps the static (unjumpable) variant of the chip out of
  // the click wiring -- it renders as a span, but a selector is cheaper than
  // trusting that stays true.
  $$(".task-order-link[data-ref-id]", container).forEach((btn) => {
    btn.addEventListener("click", () => openVehicleDetail(btn.dataset.segment, Number(btn.dataset.refId)));
  });
  $$(".task-link-clear", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      // -1 is the API's documented "clear the link" sentinel (null means
      // "leave it alone", since PATCH bodies omit untouched fields).
      await patchField(row.dataset.id, taskLinkFields(""), renderTasksList);
    });
  });
  /* "+ vehicle" swaps in place for the same recon/we-owe picker the quick-add
     form uses, built off the orders list loadTasksView already fetched. Same
     editor contract as the due-date chip: save on change, put the chip back on
     blur or Escape, and never save twice. */
  $$(".task-link-add", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".task-row");
      const linkables = state.taskOrders || [];
      if (!linkables.length) return toast("No recon or customer vehicles to link yet", true);
      const select = document.createElement("select");
      select.className = "task-link-edit";
      select.innerHTML = taskOrderOptionsHtml(linkables, "Pick a vehicle…");
      btn.replaceWith(select);
      select.focus();
      let saving = false;
      select.addEventListener("change", async () => {
        if (saving || !select.value) return;
        saving = true;
        await patchField(row.dataset.id, taskLinkFields(select.value), renderTasksList);
      });
      select.addEventListener("blur", () => { if (!saving) renderTasksList(); });
      select.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { saving = true; renderTasksList(); }
      });
    });
  });
  /* Due date was write-once: settable in the quick-add form and nowhere else,
     which is exactly backwards for the tasks the board creates in bulk (those
     arrive with no date at all). The chip swaps itself for a date input in
     place rather than opening a dialog -- retyping a date is a two-second job
     and a modal for it is heavier than the edit. */
  $$(".task-due", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".task-row");
      const input = document.createElement("input");
      input.type = "date";
      input.className = "task-due-edit";
      input.value = btn.dataset.due || "";
      btn.replaceWith(input);
      input.focus();
      // Not in jsdom, and not in every browser -- worth having where it exists
      // because it saves a click, but never worth throwing over.
      if (typeof input.showPicker === "function") { try { input.showPicker(); } catch {} }
      let saving = false;
      const save = async () => {
        if (saving) return;
        saving = true;
        if (input.value === (btn.dataset.due || "")) return renderTasksList();
        try {
          await patch(`/api/tasks/${row.dataset.id}`, { due_date: input.value });
          await loadTasks();
        } catch (err) {
          toast(err.message, true);
          renderTasksList();
        }
      };
      input.addEventListener("change", save);
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { saving = true; renderTasksList(); }
      });
    });
  });
  // Urgency was also creation-only. Same reasoning: the flag's whole job is to
  // be changed when priorities change, which is after the task exists.
  $$(".task-flag", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      try {
        await patch(`/api/tasks/${row.dataset.id}`, { urgent: !row.classList.contains("urgent") });
        await loadTasks();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".task-select", container).forEach((box) => {
    box.addEventListener("click", (e) => {
      const id = Number(box.closest(".task-row").dataset.id);
      if (e.shiftKey && state.taskAnchor != null) selectTaskRange(state.taskAnchor, id);
      else {
        if (box.checked) state.taskSelection.add(id);
        else state.taskSelection.delete(id);
      }
      state.taskAnchor = id;
      renderTasksList();
    });
  });
  // Each row's assignee picker saves immediately on change (like every other
  // auto-save control in this app) and updates local state directly rather
  // than reloading the whole list -- reloading would tear down and rebuild
  // the row, closing the popover mid-pick.
  $$(".ms-picker[data-id]", container).forEach((picker) => {
    const taskId = Number(picker.dataset.id);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const toggleEl = $(".task-assignee-toggle", picker);
    const menuEl = $(".task-assignee-menu", picker);
    wireAssigneeToggle(toggleEl, menuEl);
    renderAssigneeMenu(menuEl, toggleEl, task.assigned_to, async (names) => {
      task.assigned_to = names;
      try {
        await patch(`/api/tasks/${taskId}`, { assigned_to: names });
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ---------- filtering ----------
   Split from the render so the stat cards, the select-all box, the shift-range
   and every bulk action all read the same list the user is looking at. When
   the board grew selection this was the bug that kept coming back: "select
   all" meaning something subtly different from what the table showed. */
function taskMatchesSearch(t, query) {
  if (!query) return true;
  return t.title.toLowerCase().includes(query)
    || (t.notes || "").toLowerCase().includes(query)
    || t.assigned_to.some((a) => a.toLowerCase().includes(query));
}

// Everything except the stat-card filter. The cards count off this list, so
// clicking "Overdue" narrows the rows without changing the number on the card
// that did the narrowing -- a card that renumbers itself when pressed reads
// as though the data changed underneath you.
function taskBaseList() {
  const actor = currentActor();
  const query = (state.taskSearch || "").toLowerCase();
  return state.tasks.filter((t) => !t.done
    && (state.taskFilter !== "mine" || t.assigned_to.includes(actor))
    && (!state.taskAssignee || t.assigned_to.includes(state.taskAssignee))
    && (!state.taskUrgentOnly || !!t.urgent)
    && taskMatchesSearch(t, query));
}

function taskCardMatches(t, card) {
  if (card === "overdue") return taskBucket(t) === "overdue";
  if (card === "today") return taskBucket(t) === "today";
  if (card === "unassigned") return !t.assigned_to.length;
  return true;
}

export function visibleTasks() {
  const rows = taskBaseList().filter((t) => taskCardMatches(t, state.taskCard));
  // Grouped display order, so a shift+click range covers what the eye sees
  // between the two rows rather than what the array happened to hold.
  const order = new Map(TASK_BUCKETS.map((b, i) => [b.key, i]));
  return rows.sort((a, b) =>
    order.get(taskBucket(a)) - order.get(taskBucket(b))
    || (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)
    || (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99")
    || b.id - a.id);
}

/* ---------- stat cards ---------- */
function syncTaskStatCards() {
  const base = taskBaseList();
  const counts = {
    open: base.length,
    overdue: base.filter((t) => taskBucket(t) === "overdue").length,
    today: base.filter((t) => taskBucket(t) === "today").length,
    unassigned: base.filter((t) => !t.assigned_to.length).length,
  };
  const setValue = (sel, n, tone) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = n;
    el.classList.toggle("warn", tone === "warn");
    el.classList.toggle("crit", tone === "crit");
  };
  setValue("#stat-tasks-open", counts.open, null);
  setValue("#stat-tasks-overdue", counts.overdue, counts.overdue ? "crit" : null);
  setValue("#stat-tasks-today", counts.today, counts.today ? "warn" : null);
  // The card exists because unassigned tasks are a problem -- tone it.
  setValue("#stat-tasks-unassigned", counts.unassigned, counts.unassigned ? "warn" : null);

  const urgent = base.filter((t) => t.urgent).length;
  $("#stat-tasks-open-sub").textContent = counts.open
    ? (urgent ? `${urgent} flagged urgent` : "none flagged urgent")
    : "nothing outstanding";
  const worst = Math.min(...base.map((t) => taskDueInfo(t.due_date)?.days ?? Infinity));
  $("#stat-tasks-overdue-sub").textContent = counts.overdue
    ? `worst ${Math.abs(worst)} day${Math.abs(worst) === 1 ? "" : "s"} late`
    : "nothing past due";
  $("#stat-tasks-today-sub").textContent = counts.today ? "due before close" : "clear for today";
  $("#stat-tasks-unassigned-sub").textContent = counts.unassigned ? "nobody picked these up" : "everything has an owner";

  // A zero card is disabled rather than merely inert, same rule as the board:
  // "0 overdue" is good news and clicking it could only produce an empty list.
  $$("#view-tasks [data-task-card]").forEach((el) => {
    const key = el.dataset.taskCard;
    const active = state.taskCard === key;
    el.classList.toggle("active", active);
    el.setAttribute("aria-pressed", active ? "true" : "false");
    el.disabled = !counts[key] && !active;
    el.title = active ? "Showing only these — click to clear" : (counts[key] ? `Show only these ${counts[key]}` : "");
  });
}

// Describes the filters rather than the result, so it still explains an empty
// screen -- there are no rows to describe in the case that most needs it.
function taskScopeLabel() {
  const parts = [];
  if (state.taskFilter === "mine") parts.push(`assigned to ${currentActor() || "you"}`);
  if (state.taskAssignee) parts.push(`assigned to ${state.taskAssignee}`);
  if (state.taskCard === "overdue") parts.push("past due");
  if (state.taskCard === "today") parts.push("due today");
  if (state.taskCard === "unassigned") parts.push("with nobody assigned");
  if (state.taskUrgentOnly) parts.push("flagged urgent");
  if (state.taskSearch) parts.push(`matching "${state.taskSearch}"`);
  return parts.length ? `Open tasks ${parts.join(", ")}.` : "Every open task.";
}

function taskFiltersActive() {
  return !!(state.taskFilter || state.taskCard || state.taskAssignee || state.taskUrgentOnly || state.taskSearch);
}

export function resetTaskView() {
  state.taskFilter = "";
  state.taskCard = "";
  state.taskUrgentOnly = false;
  state.taskSearch = "";
  state.taskAssignee = "";
  const search = $("#task-search");
  if (search) search.value = "";
  const assignee = $("#tasks-assignee-filter");
  if (assignee) assignee.value = "";
  $$('#view-tasks [data-task-filter]').forEach((c) => c.classList.toggle("active", c.dataset.taskFilter === ""));
  state.taskSelection.clear();
  saveTaskPrefs();
  renderTasksList();
}

export function renderTasksList() {
  const query = (state.taskSearch || "").toLowerCase();
  const rows = visibleTasks();
  // A selection surviving a filter change would act on rows nobody can see --
  // the bulk bar would say "6 selected" over a list of two.
  const shown = new Set(rows.map((t) => t.id));
  [...state.taskSelection].forEach((id) => { if (!shown.has(id)) state.taskSelection.delete(id); });

  let done = state.tasks.filter((t) => t.done);
  if (query) done = done.filter((t) => taskMatchesSearch(t, query));

  const totalOpen = state.tasks.filter((t) => !t.done).length;
  $("#tasks-count").textContent = taskFiltersActive() && rows.length !== totalOpen
    ? `${rows.length} of ${totalOpen} open`
    : `${rows.length} open`;
  $("#tasks-scope").textContent = taskScopeLabel();
  const reset = $("#tasks-reset-view");
  if (reset) reset.hidden = !taskFiltersActive();
  const urgentChip = $("#tasks-urgent-filter");
  if (urgentChip) {
    urgentChip.classList.toggle("active", state.taskUrgentOnly);
    urgentChip.setAttribute("aria-pressed", state.taskUrgentOnly ? "true" : "false");
  }

  const resetAction = `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="tasks-reset-view">Show everything</button>`;
  $("#tasks-list").innerHTML = rows.length
    ? renderTaskGroups(rows)
    : emptyState(query
        ? { icon: "search", title: "No tasks match that search", hint: `Nothing open matched "${state.taskSearch}". Completed tasks are searched too — check the list below.`, actions: resetAction }
        : state.taskCard
        ? { icon: "check", title: `Nothing ${state.taskCard === "unassigned" ? "unassigned" : state.taskCard === "today" ? "due today" : "overdue"}`, hint: "Click the card again to see everything else.", actions: resetAction }
        : state.taskAssignee
        ? { icon: "check", title: `Nothing assigned to ${state.taskAssignee}`, hint: "Switch the assignee filter back to Anyone to see the rest.", actions: resetAction }
        : state.taskFilter === "mine"
        ? { icon: "check", title: "Nothing assigned to you", hint: `No open tasks are assigned to ${currentActor() || "you"}. Switch to All to see everyone else's.`, actions: resetAction }
        : state.taskUrgentOnly
        ? { icon: "check", title: "Nothing flagged urgent", hint: "Turn off the Urgent filter to see the rest.", actions: resetAction }
        : { icon: "task", title: "No open tasks", hint: "Add one above and it syncs to everyone the moment they open RECON.",
            actions: `<button type="button" class="btn btn-primary btn-sm" data-empty-action="add-task">Add a task</button>` });

  // The completed list is unbounded over the shop's whole history -- cap the
  // DOM at the recent tail unless asked for everything.
  const DONE_LIMIT = 25;
  const doneShown = (state.showAllCompleted || query) ? done : done.slice(0, DONE_LIMIT);
  $("#tasks-toggle-completed").textContent = `${state.showCompletedTasks ? "Hide" : "Show"} completed (${done.length})`;
  $("#tasks-completed-list").hidden = !state.showCompletedTasks;
  $("#tasks-completed-list").innerHTML = state.showCompletedTasks && !done.length
    ? emptyState({ icon: "check", title: "Nothing completed yet", compact: true })
    : doneShown.map(taskRowHtml).join("") + (done.length > doneShown.length
        ? `<button type="button" class="btn btn-ghost btn-sm list-tail-btn" id="tasks-show-all-completed">Show all ${done.length}</button>`
        : "");
  $("#tasks-show-all-completed")?.addEventListener("click", () => {
    state.showAllCompleted = true;
    renderTasksList();
  });

  wireTaskRowActions($("#tasks-list"));
  wireTaskRowActions($("#tasks-completed-list"));
  syncTaskStatCards();
  syncTaskSelectAll(rows);
  renderTaskBulkBar();
}

// Empty buckets are dropped rather than rendered as a header over nothing --
// five headings for two tasks is worse than no headings at all.
function renderTaskGroups(rows) {
  return TASK_BUCKETS.map((bucket) => {
    const group = rows.filter((t) => taskBucket(t) === bucket.key);
    if (!group.length) return "";
    return `<div class="task-group" data-bucket="${bucket.key}">
        <div class="task-group-head ${bucket.key}">
          <span class="task-group-label">${bucket.label}</span>
          <span class="task-group-count">${group.length}</span>
        </div>
        ${group.map(taskRowHtml).join("")}
      </div>`;
  }).join("");
}
