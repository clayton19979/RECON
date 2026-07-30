import { $$ } from "./core.js";
import { esc } from "./shortcuts.js";
import { state } from "./state.js";

/* ==================================================================
   MULTI-SELECT PICKER (checkbox popover) -- used for task assignees
   ================================================================== */
export function assigneeSummaryLabel(names) {
  if (!names || !names.length) return "Unassigned";
  // " & " rather than ", " for the two-name case -- a staff name containing
  // its own comma (e.g. "Smith, John") paired with one other assignee would
  // otherwise render indistinguishably from three or four separate people.
  if (names.length <= 2) return names.join(" & ");
  return `${names[0]} +${names.length - 1}`;
}

// (Re)populates a picker's checkbox menu and rewires their change handlers --
// called both once for the quick-add form and once per task row on every
// render, since the row markup (and thus its menu) is rebuilt from scratch.
export function renderAssigneeMenu(menuEl, toggleEl, selectedNames, onChange) {
  menuEl.innerHTML = state.staff.length
    ? state.staff.map((s) => `<label class="ms-option"><input type="checkbox" value="${esc(s.name)}" ${selectedNames.includes(s.name) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")
    : `<div class="ms-empty">No staff yet</div>`;
  // Task-row toggles speak the row's "open slot" dashed language ("+ assign")
  // when empty; the quick-add form keeps the plain "Unassigned" word.
  const isRowToggle = toggleEl.classList.contains("task-assignee-toggle");
  const setLabel = (names) => {
    if (isRowToggle) {
      toggleEl.classList.toggle("ms-toggle-empty", !names.length);
      toggleEl.textContent = names.length ? assigneeSummaryLabel(names) : "+ assign";
    } else {
      toggleEl.textContent = assigneeSummaryLabel(names);
    }
  };
  setLabel(selectedNames);
  $$("input[type=checkbox]", menuEl).forEach((cb) => {
    cb.addEventListener("change", () => {
      const names = $$("input[type=checkbox]:checked", menuEl).map((c) => c.value);
      setLabel(names);
      onChange(names);
    });
  });
}

// Only one picker menu open at a time; clicking anywhere outside the open
// picker closes it, same as the pattern browsers use for native <select>.
let openAssigneeMenuEl = null;
function syncAssigneeToggleExpanded(menuEl, open) {
  const toggle = menuEl?.parentElement?.querySelector(".ms-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function toggleAssigneeMenu(menuEl) {
  // A row can be deleted (e.g. a task removed) while its popover is open,
  // detaching the old menu node from the document -- drop the dangling
  // reference instead of touching a node nothing can see anymore.
  if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) openAssigneeMenuEl = null;
  if (openAssigneeMenuEl && openAssigneeMenuEl !== menuEl) {
    openAssigneeMenuEl.style.display = "none";
    syncAssigneeToggleExpanded(openAssigneeMenuEl, false);
  }
  const opening = menuEl.style.display !== "block";
  menuEl.style.display = opening ? "block" : "none";
  syncAssigneeToggleExpanded(menuEl, opening);
  // Open upward when there's no room below -- a picker on the last row of a
  // long list otherwise opens off-screen.
  if (opening) {
    menuEl.classList.remove("ms-menu-up");
    const rect = menuEl.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) menuEl.classList.add("ms-menu-up");
  }
  openAssigneeMenuEl = opening ? menuEl : null;
}
function closeOpenAssigneeMenu() {
  if (!openAssigneeMenuEl) return;
  if (document.contains(openAssigneeMenuEl)) {
    openAssigneeMenuEl.style.display = "none";
    syncAssigneeToggleExpanded(openAssigneeMenuEl, false);
  }
  openAssigneeMenuEl = null;
}
export function wireAssigneeMenuDismiss() {
  document.addEventListener("click", (e) => {
    if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) {
      openAssigneeMenuEl = null;
      return;
    }
    if (openAssigneeMenuEl && !e.target.closest(".ms-picker")) closeOpenAssigneeMenu();
  });
  // Escape closes the popover like any menu; focus goes back to its toggle.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !openAssigneeMenuEl) return;
    const toggle = openAssigneeMenuEl.parentElement?.querySelector(".ms-toggle");
    closeOpenAssigneeMenu();
    toggle?.focus();
  });
}
// Wired once per toggle button (the quick-add one lives for the app's whole
// life; each row's is rewired on every render since the row itself is new).
export function wireAssigneeToggle(toggleEl, menuEl) {
  toggleEl.setAttribute("aria-haspopup", "true");
  toggleEl.setAttribute("aria-expanded", "false");
  toggleEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAssigneeMenu(menuEl);
  });
}
