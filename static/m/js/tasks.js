/* Follow-ups, filtered to whoever is holding the phone.
 *
 * The desk shows everybody's list with bulk edit and multi-assign. A phone
 * shows yours, with a checkbox. Anything else and it stops being glanceable
 * in the thirty seconds between jobs, which is when it actually gets read. */

import { $, get, patch } from "../../js/core.js";
import { esc, fmtDay } from "./format.js";
import { renderFailure, state, toast } from "./shell.js";

/* Mine, plus anything assigned to nobody -- an unassigned follow-up is the
   shop's, and hiding it until somebody claims it is how it gets forgotten.
   With no name picked, the phone shows everything rather than nothing. */
export function mine(rows, user) {
  if (!user) return rows;
  return rows.filter((t) => {
    const who = t.assigned_to || [];
    return who.length === 0 || who.includes(user);
  });
}

function dueLabel(task) {
  if (!task.due_date) return "";
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // Compared as strings, both shop-local calendar dates. Handing a bare
  // YYYY-MM-DD to Date would make it UTC midnight, which is the evening
  // before in Indiana -- the same trap fmtDay exists to avoid.
  if (task.due_date < stamp) return `Overdue — was due ${fmtDay(task.due_date)}`;
  if (task.due_date === stamp) return "Due today";
  return `Due ${fmtDay(task.due_date)}`;
}

export function tasksHtml(rows) {
  if (!rows.length) {
    return `<p class="m-empty">Nothing to follow up on.</p>`;
  }
  return rows.map((t) => {
    const done = Boolean(t.done);
    const meta = [dueLabel(t), t.order_label ? esc(t.order_label) : ""].filter(Boolean).join(" · ");
    return `
      <button class="m-task" type="button" data-task="${t.id}" data-done="${done ? 1 : 0}"
              data-urgent="${t.urgent && !done ? 1 : 0}" aria-pressed="${done}">
        <span class="m-job-box" aria-hidden="true">${done ? "&#10003;" : ""}</span>
        <span class="m-task-body">
          <span class="m-task-title">${esc(t.title)}</span>
          ${meta ? `<span class="m-task-meta">${meta}</span>` : ""}
        </span>
      </button>`;
  }).join("");
}

export async function loadTasks() {
  const target = $("#m-tasks");
  target.innerHTML = `<p class="m-loading">Loading follow-ups…</p>`;
  try {
    const rows = await get("/api/tasks");
    // Done ones stay visible but sink, so ticking one off doesn't make it
    // vanish before you've seen it register.
    const list = mine(rows, state.user).filter((t) => !t.done || t.completed_at);
    target.innerHTML = tasksHtml(list);
  } catch (err) {
    renderFailure(target, err, loadTasks);
  }
}

export function wireTasks() {
  $("#m-tasks").addEventListener("click", async (e) => {
    const button = e.target.closest(".m-task");
    if (!button) return;
    if (button.getAttribute("aria-busy") === "true") return;
    const id = Number(button.dataset.task);
    const done = button.dataset.done !== "1";
    button.setAttribute("aria-busy", "true");
    try {
      await patch(`/api/tasks/${id}`, { done });
      await loadTasks();
      toast(done ? "Done." : "Put back on the list.");
    } catch (err) {
      button.setAttribute("aria-busy", "false");
      toast(err.message || "Couldn't save that.", true);
    }
  });
}
