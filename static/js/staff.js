import { $, $$, get, patch, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { esc } from "./shortcuts.js";
import { emptyRow } from "./empty-states.js";
import { refreshCurrentUserOptions, state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { saveReportPrefs } from "./reports.js";

/* ==================================================================
   STAFF
   ================================================================== */
const STAFF_ROLE_LABEL = { technician: "Technician", advisor: "Advisor", manager: "Manager" };
const STAFF_ROLE_ORDER = { technician: 0, advisor: 1, manager: 2 };

export async function loadStaffView() {
  try {
    // Two slots on purpose: state.staff (active only) feeds every assignment
    // dropdown in the app. Overwriting it with the include_inactive list --
    // as this loader used to -- made deactivated people reappear in every
    // technician/advisor/task picker until the next reload, where the server
    // then rejected the pick.
    const [allStaff, tasks] = await Promise.all([
      get("/api/staff?include_inactive=true"),
      get("/api/tasks").catch(() => []),
    ]);
    state.allStaff = allStaff;
    state.staff = allStaff.filter((s) => s.active);
    state.staffTasks = tasks;
  } catch (err) {
    return renderViewFailure("staff", err);
  }
  refreshCurrentUserOptions();
  renderStaffStats();
  renderStaffTable();
}

function openTasksPerson(s) {
  return state.staffTasks.filter((t) => !t.done && !t.completed_at && (t.assigned_to || []).includes(s.name)).length;
}

// The one path from "this person's name" to "their open tasks" -- the
// workload column's count links and the Assigned Tasks card's per-person
// rows both land on the Tasks screen pre-filtered the same way.
function openTasksAssignedTo(name) {
  state.taskFilter = "";
  state.taskAssignee = name;
  $('.rail-item[data-view="tasks"]')?.click();
}

// Single writer for state.staffFilter, so the toolbar chips and the
// Inactive stat card (which drives the same filter) can never fall out of
// sync with each other.
function applyStaffFilter(filter) {
  state.staffFilter = filter;
  $$('#view-staff [data-staff-filter]').forEach((c) => c.classList.toggle("active", c.dataset.staffFilter === filter));
  renderStaffStats();
  renderStaffTable();
}

function renderStaffStats() {
  const active = state.allStaff.filter((s) => s.active);
  const techs = active.filter((s) => s.role === "technician").length;
  const advisors = active.filter((s) => s.role === "advisor" || s.role === "manager").length;
  const inactive = state.allStaff.length - active.length;
  const openTasks = state.staffTasks.filter((t) => !t.done && !t.completed_at && (t.assigned_to || []).length).length;
  const showingInactive = state.staffFilter === "all";
  $("#staff-stats").innerHTML = `
    <div class="stat">
      <div class="stat-label">Technicians</div>
      <div class="stat-value${techs ? "" : " crit"}">${techs}</div>
      <div class="stat-sub">${techs ? "assignable on repair orders" : "add one to assign work"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Advisors &amp; Managers</div>
      <div class="stat-value">${advisors}</div>
      <div class="stat-sub">write and advise tickets</div>
    </div>
    ${assignedTasksCardHtml(openTasks)}
    <button type="button" class="stat stat-action" data-staff-stat="inactive" aria-pressed="${showingInactive ? "true" : "false"}" ${inactive || showingInactive ? "" : "disabled"} title="${showingInactive ? "Showing inactive — click to hide" : (inactive ? "Show inactive staff" : "")}">
      <div class="stat-label">Inactive</div>
      <div class="stat-value">${inactive}</div>
      <div class="stat-sub">${inactive ? "hidden from all dropdowns" : "nobody deactivated"}</div>
    </button>`;
}

/* The Assigned Tasks card, grown from a bare count into a per-person
   breakdown: the number said three tasks have owners, but the question a
   manager brings to this screen is *whose plate is full* -- and answering it
   meant scanning the workload column row by row. The card now shows the
   three busiest people with a bar scaled against the busiest, each row a
   button that lands on the Tasks screen filtered to that person (same path
   as the workload column's count links), with a "+N more" line when the
   load spreads wider than three.

   A <div role="button"> rather than the <button> the other action cards
   use, because the person rows are buttons themselves and buttons can't
   nest -- the card keeps its click (jump to Tasks unfiltered) on the
   container, person rows stop propagation, and the staff-stats keydown
   handler gives the div back Enter/Space. */
function assignedTasksCardHtml(openTasks) {
  const load = state.allStaff
    .filter((s) => s.active)
    .map((s) => ({ name: s.name, count: openTasksPerson(s) }))
    .filter((p) => p.count)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const top = load.slice(0, 3);
  const overflow = load.length - top.length;
  const max = top.length ? top[0].count : 1;
  const people = top.map((p) => `
      <button type="button" class="stat-person" data-name="${esc(p.name)}" title="See ${esc(p.name)}'s open tasks">
        <span class="stat-person-name">${esc(p.name)}</span>
        <span class="stat-person-bar"><span style="width:${Math.max(8, Math.round((p.count / max) * 100))}%"></span></span>
        <span class="stat-person-count">${p.count}</span>
      </button>`).join("");
  return `
    <div class="stat${openTasks ? " stat-action stat-breakdown" : ""}" data-staff-stat="tasks" ${openTasks ? `role="button" tabindex="0" title="Go to Tasks" aria-label="Go to Tasks (${openTasks} open with an owner)"` : `aria-disabled="true"`}>
      <div class="stat-label">Assigned Tasks</div>
      <div class="stat-value">${openTasks}</div>
      ${top.length
        ? `<div class="stat-people">${people}</div>${overflow ? `<div class="stat-sub">+${overflow} more with open tasks</div>` : ""}`
        : `<div class="stat-sub">no open task has an owner</div>`}
    </div>`;
}

function staffRowHtml(s) {
  const openTasks = openTasksPerson(s);
  return `
    <tr data-id="${s.id}" class="${s.active ? "" : "staff-inactive"}">
      <td><input class="stf-name" value="${esc(s.name)}" title="Click to rename" aria-label="Name of ${esc(s.name)}"></td>
      <td><button type="button" class="role-badge role-${esc(s.role)} stf-role-badge" title="Click to change role">${STAFF_ROLE_LABEL[s.role] || esc(s.role)}</button></td>
      <td class="num-col">${openTasks
        ? `<button type="button" class="stf-task-link" data-name="${esc(s.name)}" title="See ${esc(s.name)}'s open tasks">${openTasks}</button>`
        : '<span class="muted-dash">—</span>'}</td>
      <td><span class="pill ${s.active ? "pill-done" : "pill-inactive"}">${s.active ? "Active" : "Inactive"}</span></td>
      <td class="actions-col"><button type="button" class="btn btn-ghost btn-xs stf-toggle${s.active ? " btn-warn-ghost" : ""}" aria-label="${s.active ? "Deactivate" : "Activate"} ${esc(s.name)}">${s.active ? "Deactivate" : "Activate"}</button></td>
    </tr>`;
}

function renderStaffTable() {
  const query = (state.staffSearch || "").toLowerCase();
  let rows = state.allStaff.filter((s) => {
    if (state.staffFilter === "active" && !s.active) return false;
    return !query || s.name.toLowerCase().includes(query) || s.role.toLowerCase().includes(query);
  });
  // Active first, then in role order, then by name -- the org structure of
  // the shop instead of a flat alphabet that interleaves retired employees.
  rows = [...rows].sort((a, b) =>
    (b.active - a.active) || (STAFF_ROLE_ORDER[a.role] - STAFF_ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));
  const activeCount = state.allStaff.filter((s) => s.active).length;
  const inactiveCount = state.allStaff.length - activeCount;
  $("#staff-count").textContent = query
    ? `${rows.length} of ${state.allStaff.length} staff members`
    : `${rows.length} staff member${rows.length === 1 ? "" : "s"}${inactiveCount && state.staffFilter !== "active" ? ` · ${activeCount} active, ${inactiveCount} inactive` : ""}`;

  if (!rows.length) {
    $("#staff-table").innerHTML = emptyRow(5, query
      ? { icon: "search", title: "No staff match that search", hint: `Nothing matched "${state.staffSearch}".`,
          actions: `<button type="button" class="btn btn-ghost btn-sm" id="staff-empty-clear">Clear search</button>` }
      : { icon: "staff", title: "No staff added yet", hint: "Add your technicians and advisors above so work can be assigned and productivity reported.",
          actions: `<button type="button" class="btn btn-primary btn-sm" id="staff-empty-add">Add your first staff member</button>` });
    $("#staff-empty-add")?.addEventListener("click", () => $("#staff-form").name.focus());
    $("#staff-empty-clear")?.addEventListener("click", () => {
      state.staffSearch = "";
      $("#staff-search").value = "";
      renderStaffTable();
    });
    return;
  }

  // Group header rows by role while browsing; search results stay flat.
  let html = "";
  if (query) {
    html = rows.map(staffRowHtml).join("");
  } else {
    for (const role of ["technician", "advisor", "manager"]) {
      const group = rows.filter((s) => s.role === role);
      if (!group.length) continue;
      html += `<tr class="group-row"><td colspan="5">${STAFF_ROLE_LABEL[role]}s<span class="group-count">${group.length}</span></td></tr>`;
      html += group.map(staffRowHtml).join("");
    }
  }
  $("#staff-table").innerHTML = html;

  // Name auto-saves on blur like everywhere else in the app -- editing then
  // navigating away used to silently discard the edit.
  $$(".stf-name", $("#staff-table")).forEach((input) => {
    input.addEventListener("blur", async () => {
      const tr = input.closest("tr");
      const person = state.allStaff.find((s) => s.id === Number(tr.dataset.id));
      const name = input.value.trim();
      if (!name || name === person.name) { input.value = person.name; return; }
      try {
        const updated = await patch(`/api/staff/${tr.dataset.id}`, { name });
        // The server follows a rename through task assignments; surface how
        // much actually moved so the rename doesn't look like a no-op.
        const moved = updated?.tasks_moved || 0;
        toast(moved
          ? `Renamed to ${name} — ${moved} task${moved === 1 ? "" : "s"} moved with them`
          : `Renamed to ${name}`);
        await loadStaffView();
      } catch (err) {
        toast(err.message, true);
        input.value = person.name;
      }
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  });

  // Role renders as a badge; clicking it swaps in the select, so the column
  // reads as data, not a grid of live dropdowns one slip from re-roling
  // someone.
  $$(".stf-role-badge", $("#staff-table")).forEach((badge) => {
    badge.addEventListener("click", () => {
      const tr = badge.closest("tr");
      const person = state.allStaff.find((s) => s.id === Number(tr.dataset.id));
      const select = document.createElement("select");
      select.className = "stf-role-select";
      select.innerHTML = `
        <option value="technician" ${person.role === "technician" ? "selected" : ""}>Technician</option>
        <option value="advisor" ${person.role === "advisor" ? "selected" : ""}>Advisor / Service Writer</option>
        <option value="manager" ${person.role === "manager" ? "selected" : ""}>Manager</option>`;
      badge.replaceWith(select);
      select.focus();
      const restore = () => renderStaffTable();
      select.addEventListener("blur", restore);
      select.addEventListener("change", async () => {
        select.removeEventListener("blur", restore);
        try {
          await patch(`/api/staff/${tr.dataset.id}`, { role: select.value });
          toast(`${person.name} is now ${STAFF_ROLE_LABEL[select.value] === "Advisor" ? "an" : "a"} ${STAFF_ROLE_LABEL[select.value]}`);
          await loadStaffView();
        } catch (err) {
          toast(err.message, true);
          renderStaffTable();
        }
      });
    });
  });

  $$(".stf-task-link", $("#staff-table")).forEach((btn) =>
    btn.addEventListener("click", () => openTasksAssignedTo(btn.dataset.name)));

  $$(".stf-toggle", $("#staff-table")).forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const person = state.allStaff.find((s) => s.id === Number(tr.dataset.id));
    const openTasks = openTasksPerson(person);
    // What the person is still holding, said before the decision rather than
    // discovered afterwards. Cars first: a technician with four unfinished
    // tickets is somebody whose work has to be handed to a name, and nothing
    // else on this screen says so. Tasks are the smaller half of the same
    // question and keep the wording they had.
    const held = person.open_orders || 0;
    const stillOn = [
      held ? `${held} unfinished ticket${held === 1 ? "" : "s"}` : "",
      openTasks ? `${openTasks} open task${openTasks === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ");
    // Deactivating pulls this person out of every technician/advisor
    // dropdown app-wide -- a bigger consequence than most of the guarded
    // deletes elsewhere, so it asks first too.
    if (person.active && !(await confirmAction({
      eyebrow: "STAFF",
      title: `Deactivate ${person.name}?`,
      body: `They stop being offered for new work. Everything already assigned to them keeps their name and stays editable.${stillOn ? ` They are still on ${stillOn}.` : ""}`,
      confirmLabel: "Deactivate",
    }))) return;
    try {
      await patch(`/api/staff/${tr.dataset.id}`, { active: !person.active });
      toast(person.active ? `${person.name} deactivated` : `${person.name} activated`);
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

export function wireStaffView() {
  $("#staff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    // namedItem, not the named getter -- see openVendorForEdit.
    const name = form.elements.namedItem("name").value.trim();
    // Assignment pickers show names only, so two "Ray Ortiz" rows would be
    // indistinguishable forever -- catch it before the POST.
    if (state.allStaff.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return toast("Someone with that name is already on staff", true);
    }
    try {
      await post("/api/staff", { name, role: form.elements.namedItem("role").value });
      form.reset();
      toast(`${name} added`);
      await loadStaffView();
      form.elements.namedItem("name").focus();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#staff-search").addEventListener("input", (e) => {
    state.staffSearch = e.target.value.trim();
    renderStaffTable();
  });
  $("#staff-search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      state.staffSearch = "";
      e.target.value = "";
      renderStaffTable();
    }
  });
  $$('#view-staff [data-staff-filter]').forEach((chip) => {
    chip.addEventListener("click", () => applyStaffFilter(chip.dataset.staffFilter));
  });
  $("#staff-stats").addEventListener("click", (e) => {
    // A person row inside the Assigned Tasks card is the narrower target;
    // it wins over the card's own jump-to-Tasks and doesn't also fire it.
    const person = e.target.closest(".stat-person");
    if (person) {
      openTasksAssignedTo(person.dataset.name);
      return;
    }
    const btn = e.target.closest("[data-staff-stat]");
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
    if (btn.dataset.staffStat === "inactive") {
      applyStaffFilter(state.staffFilter === "all" ? "active" : "all");
    } else if (btn.dataset.staffStat === "tasks") {
      const railItem = $('.rail-item[data-view="tasks"]');
      if (railItem) railItem.click();
    }
  });
  // The Assigned Tasks card is a <div role="button"> (buttons can't nest);
  // this hands it back the Enter/Space a real button would have.
  $("#staff-stats").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches('[role="button"][data-staff-stat]')) {
      e.preventDefault();
      e.target.click();
    }
  });
  $("#staff-report-link").addEventListener("click", () => {
    state.reportType = "technicians";
    saveReportPrefs();
    const railItem = $('.rail-item[data-view="reports"]');
    if (railItem) railItem.click();
  });
}
