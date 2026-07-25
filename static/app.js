"use strict";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail || message;
    } catch {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}
const get = (path) => api(path);
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });

let toastTimer = null;
function toast(message, isError = false) {
  logMessage(message, isError);
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---------- message log ----------
   A toast lives for 3.2 seconds and then is gone for good. That's fine for
   "Saved" and genuinely bad for "Could not reach the server", which tends to
   fire while the advisor is looking at the keyboard rather than the screen --
   the only evidence the save failed disappears unseen. Every toast is also
   appended here, and the topbar bell opens the last 50 with timestamps.

   The unread dot counts *errors* only. A wall of successful saves shouldn't
   be the thing nagging you to go look. */
const MESSAGE_LOG_LIMIT = 50;
const messageLog = [];
let messageLogUnread = 0;

function logMessage(message, isError) {
  messageLog.unshift({ message: String(message), isError: !!isError, at: new Date() });
  if (messageLog.length > MESSAGE_LOG_LIMIT) messageLog.length = MESSAGE_LOG_LIMIT;
  if (isError && !$("#notif-menu")?.classList.contains("open")) messageLogUnread += 1;
  renderMessageLog();
}

function renderMessageLog() {
  const list = $("#notif-list");
  const dot = $("#notif-dot");
  if (dot) {
    dot.hidden = messageLogUnread === 0;
    dot.textContent = messageLogUnread > 9 ? "9+" : String(messageLogUnread);
  }
  if (!list) return;
  if (!messageLog.length) {
    list.innerHTML = `<p class="notif-empty">Nothing yet. Saves, errors and status changes show up here.</p>`;
    return;
  }
  list.innerHTML = messageLog.map((entry) => `
    <div class="notif-item ${entry.isError ? "error" : ""}">
      <span class="notif-item-text">${esc(entry.message)}</span>
      <span class="notif-item-time">${esc(entry.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
    </div>
  `).join("");
}

function wireMessageLog() {
  const wrap = $("#notif");
  const toggle = $("#notif-toggle");
  const menu = $("#notif-menu");
  if (!wrap || !toggle || !menu) return;
  const setOpen = (open) => {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      // Opening the panel *is* reading it.
      messageLogUnread = 0;
      renderMessageLog();
    }
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  $("#notif-clear").addEventListener("click", () => {
    messageLog.length = 0;
    messageLogUnread = 0;
    renderMessageLog();
  });
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("open")) setOpen(false);
  });
  renderMessageLog();
}
/* ---------- confirm dialog ----------
   Every destructive action used to call window.confirm(), which renders as
   an OS-chrome alert: no title/detail split, no way to say how destructive
   this particular action is, no styling, and (in the app-mode window) a
   dialog that looks like it came from a different program. confirmAction()
   is a drop-in async replacement -- `if (!(await confirmAction({...}))) return;`
   -- backed by the same <dialog> element as every other modal.

   Cancel is the default focus for destructive actions, so hammering Enter
   can't blow something away. */
let confirmResolve = null;

function confirmAction({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", eyebrow = "CONFIRM", danger = false }) {
  const dlg = $("#confirm-dialog");
  // No dialog in the DOM (a bare test harness, say) -- fail closed rather
  // than silently performing the destructive action.
  if (!dlg) return Promise.resolve(false);
  $("#confirm-eyebrow").textContent = eyebrow;
  $("#confirm-title").textContent = title;
  const bodyEl = $("#confirm-body");
  bodyEl.textContent = body;
  bodyEl.style.display = body ? "" : "none";
  const accept = $("#confirm-accept");
  accept.textContent = confirmLabel;
  accept.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  $("#confirm-cancel").textContent = cancelLabel;
  dlg.classList.toggle("danger", danger);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    dlg.showModal();
    (danger ? $("#confirm-cancel") : accept).focus();
  });
}

function settleConfirm(result) {
  const dlg = $("#confirm-dialog");
  const resolve = confirmResolve;
  confirmResolve = null;
  if (dlg?.open) dlg.close();
  if (resolve) resolve(result);
}

function wireConfirmDialog() {
  const dlg = $("#confirm-dialog");
  if (!dlg) return;
  $("#confirm-accept").addEventListener("click", () => settleConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => settleConfirm(false));
  // Esc / backdrop-dismiss fire `close` without going through either button.
  dlg.addEventListener("close", () => settleConfirm(false));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) settleConfirm(false); });
}

function money(value) {
  // `value || 0` only catches falsy input (0, "", null, undefined) -- a
  // truthy but non-numeric value (e.g. a corrupted field coming back as a
  // string) sails through Number() as NaN and used to render literally
  // "$NaN" in cost summaries and the printed ticket.
  const raw = Number(value);
  const n = Number.isFinite(raw) ? raw : 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}
function currentActor() {
  return state.currentUser || "Unspecified";
}
// Disables a button and swaps its label while an async action is in
// flight, so a slow save doesn't look like nothing happened (and can't be
// double-submitted by an impatient extra click).
async function withLoading(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
// Awareness for the two-people-editing-the-same-car case: seeing "updated 2
// minutes ago" is often enough to make someone check with a coworker before
// saving over their still-fresh change.
function relativeTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* ---------- empty states ----------
   One component for every "there's nothing to show" case, so the wording and
   spacing stay consistent instead of each call site inventing its own inline
   style. The distinction that matters to someone using this is "nothing has
   been added yet" (here's how to add one) versus "your filter hid it all"
   (here's how to clear it), so callers are expected to pass different copy
   for the two rather than a single generic "No results". */
const EMPTY_ICONS = {
  search: `<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`,
  vehicle: `<path d="M3 12l2-8h14l2 8M3 12v7a1 1 0 001 1h2a1 1 0 001-1v-2h10v2a1 1 0 001 1h2a1 1 0 001-1v-7M3 12h18M7 16h.01M17 16h.01"/>`,
  invoice: `<path d="M4 19V5a2 2 0 012-2h9l5 5v11a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`,
  core: `<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/>`,
  staff: `<circle cx="12" cy="8" r="3.4"/><path d="M4.5 20c1-3.6 4-5.6 7.5-5.6s6.5 2 7.5 5.6"/>`,
  task: `<path d="M9 11l2.5 2.5L16 9"/><rect x="3" y="4" width="18" height="16" rx="2"/>`,
  idea: `<path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0012 2z"/>`,
  archive: `<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4"/>`,
  backup: `<path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"/>`,
  check: `<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>`,
};

function emptyState({ icon = "search", title, hint = "", actions = "", compact = false, tone = "" }) {
  const classes = ["empty-state", compact ? "compact" : "", tone === "error" ? "error" : ""].filter(Boolean).join(" ");
  return `<div class="${classes}">
    <div class="empty-state-icon"><svg viewBox="0 0 24 24">${EMPTY_ICONS[icon] || EMPTY_ICONS.search}</svg></div>
    <div class="empty-state-title">${esc(title)}</div>
    ${hint ? `<div class="empty-state-hint">${esc(hint)}</div>` : ""}
    ${actions ? `<div class="empty-state-actions">${actions}</div>` : ""}
  </div>`;
}

// Same thing, wrapped so it can sit inside a <tbody> without breaking the
// table's column layout.
function emptyRow(colspan, opts) {
  return `<tr class="empty-row"><td class="empty-cell" colspan="${colspan}">${emptyState(opts)}</td></tr>`;
}

/* ---------- loading skeletons ----------
   Painted synchronously before a view's fetch starts, so switching views
   never leaves the previous screen's rows on display while the new data is
   still in flight. Widths vary per cell so it reads as content rather than a
   progress bar; the sequence is deterministic (no Math.random) so a re-render
   doesn't visibly reshuffle. */
const SKELETON_WIDTHS = [62, 84, 45, 72, 91, 54, 68, 79, 58, 88];

function skeletonRows(cols, rows = 5) {
  let html = "";
  for (let r = 0; r < rows; r++) {
    html += `<tr class="skeleton-row" aria-hidden="true">`;
    for (let c = 0; c < cols; c++) {
      html += `<td><div class="skeleton-line" style="width:${SKELETON_WIDTHS[(r * cols + c) % SKELETON_WIDTHS.length]}%"></div></td>`;
    }
    html += `</tr>`;
  }
  return html;
}

function skeletonCards(count = 3) {
  return Array.from({ length: count }, (_, i) => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-line" style="width:${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%"></div>
      <div class="skeleton-line" style="width:28%;height:8px;margin-top:11px"></div>
    </div>`).join("");
}

// Select, Stock #, Vehicle, Type, Status, Technician, Parts, Age, Quoted,
// Cost. Two places have to agree with the board's <thead>: the loading
// skeleton (a short one makes the table visibly jump a column wider the
// moment data lands) and the empty state's colspan (a short one narrows the
// "no vehicles" panel to part of the table). Both were separate literals and
// both were wrong the moment the Parts column went in, so they share one
// constant now. tests/test_static_assets.py holds it to the real <th> count.
const BOARD_COLUMNS = 11;

// Which containers to fill with a placeholder when a view is opened, and how
// many columns each table has (so the skeleton lines up with its header).
const VIEW_PLACEHOLDERS = {
  vehicles:    [["#vehicles-table", BOARD_COLUMNS]],
  // Only the table is listed: the summary cards and chart above it get a
  // shape-matched skeleton of their own (showReportPlaceholders), and a
  // failed load should say so once rather than three times down the page.
  reports:     [["#report-output", 0]],
  accounting:  [["#ap-table", 7]],
  cores:       [["#cores-table", 6], ["#returns-table", 7]],
  staff:       [["#staff-table", 4]],
  backup:      [["#backup-table", 4]],
  tasks:       [["#tasks-list", 0]],
  suggestions: [["#suggestions-list", 0]],
};

function showPlaceholders(viewName) {
  for (const [selector, cols] of VIEW_PLACEHOLDERS[viewName] || []) {
    const el = $(selector);
    if (el) el.innerHTML = cols > 0 ? skeletonRows(cols) : skeletonCards();
  }
}

/* ---------- state ---------- */
const state = {
  vehicles: [],
  filter: "",
  search: "",
  // The board's whole view state -- which segment, which status, which column
  // it's sorted by -- is restored from localStorage on load (see
  // loadVehicleViewPrefs) so the advisor's working view survives a refresh,
  // an app restart, and a trip through a repair order and back.
  vehicleSort: { key: "", dir: "desc" }, // key "" == the server's own order (newest first)
  vehicleStatus: "",                      // "" == any status
  vehiclePartsOnly: false,                // "Waiting on parts" toggle
  vehicleIdleBucket: "",                  // "" == any; else an IDLE_BUCKETS key, set by clicking a chart bar
  vehicleChartOpen: true,                 // the idle-bucket chart above the table
  vehicleCursor: null,                    // key of the keyboard-focused row
  vehicleAnchor: null,                    // key of the last row clicked, for Shift+click ranges
  staff: [],
  vendors: [],
  orders: [],
  currentUser: localStorage.getItem("dao-current-user") || "",
  detail: { segment: null, id: null, item: null, order: null },
  apFilter: { start: "", end: "" },
  apSearch: "",
  staffSearch: "",
  suggestionSearch: "",
  showResolvedSuggestions: false,
  apInvoices: [],
  cores: [],
  coresFilter: "pending",
  returns: [],
  returnsFilter: "pending",
  postReturnItem: null,
  vehicleSelection: new Set(), // "segment:id" strings, cleared on filter change/reload
  // Reports: which of the four reports, over what window, sorted how. Like
  // the board, all of it is restored from localStorage before the first
  // fetch (loadReportPrefs) so the screen opens on the report you were
  // last reading rather than on a blank form.
  reportType: "vehicle-spend",
  reportRange: "month",                 // the quick-range chip, "" once dates are edited by hand
  reportStart: "",
  reportEnd: "",
  reportSort: { key: "cost", dir: "desc" },
  report: null,                         // { rows, type, start, end } -- what's on screen, for print/CSV
  tasks: [],
  taskFilter: "",
  taskSearch: "",
  newTaskAssignees: [],
  showCompletedTasks: false,
  suggestions: [],
};

// Who's actually using the app right now -- every save used to hardcode
// "Clay" as the actor, misattributing everything when anyone else touched
// it. Populated from the staff list, remembered in localStorage.
async function refreshCurrentUserOptions() {
  const select = $("#current-user");
  try {
    const staff = await get("/api/staff");
    select.innerHTML = `<option value="">Unspecified</option>` + staff.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
    select.value = state.currentUser;
  } catch {}
}
function initCurrentUser() {
  refreshCurrentUserOptions();
  $("#current-user").addEventListener("change", () => {
    state.currentUser = $("#current-user").value;
    localStorage.setItem("dao-current-user", state.currentUser);
  });
}

const STATUS_OPTIONS = ["estimate", "pending_approval", "in_progress", "complete"];
const STATUS_LABEL = {
  estimate: "Estimate", pending_approval: "Pending Approval", in_progress: "In Progress", complete: "Complete",
  // Vehicle-board labels for statuses that aren't ticket statuses: recon's
  // "acquired" (no RO started yet) and we-owe's own open/fulfilled/waived
  // (shown only once the promise itself has been marked resolved, or before
  // any ticket exists -- otherwise the board shows the ticket's own status).
  acquired: "Acquired", open: "Open", fulfilled: "Fulfilled", waived: "Waived",
};
const STATUS_PILL_CLASS = {
  estimate: "pill-status-estimate", pending_approval: "pill-status-pending",
  in_progress: "pill-status-progress", complete: "pill-status-complete",
};
const KIND_GROUP_ORDER = ["part", "labor", "fee"];
const KIND_GROUP_LABEL = { part: "Parts", labor: "Labor", fee: "Fees" };

/* ---------- nav / shell ---------- */
// One place that knows how each view loads itself, so switching views can put
// a boundary around it (below) instead of a chain of `if (name === ...)`.
const VIEW_LOADERS = {
  vehicles: () => loadVehiclesView(),
  reports: () => loadReportsView(),
  accounting: () => loadAccountingView(),
  cores: () => loadCoresView(),
  staff: () => loadStaffView(),
  tasks: () => loadTasksView(),
  suggestions: () => loadSuggestionsView(),
  backup: () => loadBackupView(),
};

/* ---------- render error boundary ----------
   A throw partway through a render used to leave the skeleton rows frozen on
   screen with no message anywhere -- the view simply never finished, and the
   only trace was a console error nobody on a shop floor is going to open. Any
   view loader that throws now lands here and the view says so, with a way to
   retry that doesn't involve reloading the whole app. */
async function runViewLoader(name) {
  const load = VIEW_LOADERS[name];
  if (!load) return;
  try {
    await load();
  } catch (err) {
    renderViewFailure(name, err);
  }
}

function renderViewFailure(name, err, targets = VIEW_PLACEHOLDERS[name]) {
  console.error(`[${name}] failed to render`, err);
  const message = String(err && err.message ? err.message : err || "Unknown error");
  const opts = {
    icon: "search",
    title: "This screen didn't load",
    hint: message,
    tone: "error",
    actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="retry-view" data-view="${name}">Try Again</button>`,
  };
  targets = targets || [];
  if (!targets.length) {
    toast(`Couldn't load this screen: ${message}`, true);
    return;
  }
  for (const [selector, cols] of targets) {
    const el = $(selector);
    if (el) el.innerHTML = cols > 0 ? emptyRow(cols, opts) : emptyState(opts);
  }
}

// Delegated so it survives the innerHTML above being replaced again on retry.
function wireViewRetry() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-empty-action="retry-view"]');
    if (!btn) return;
    showPlaceholders(btn.dataset.view);
    runViewLoader(btn.dataset.view);
  });
}

// Anything that escapes every other handler -- a typo in a render function,
// a promise nobody caught -- at least tells the user the app is in a bad
// state rather than looking merely slow.
function wireGlobalErrorReporting() {
  const report = (label, detail) => {
    console.error(label, detail);
    if ($("#toast")) toast(`${label}: ${String(detail && detail.message ? detail.message : detail)}`, true);
  };
  window.addEventListener("error", (e) => report("Something went wrong", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report("Something went wrong", e.reason));
}

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  // Paint placeholders before kicking off the fetch -- otherwise the old
  // view's rows stay on screen until it resolves.
  showPlaceholders(name);
  runViewLoader(name);
}

const THEMES = ["midnight", "carbon", "slate", "paper"];

function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("dao-theme", name);
  $$(".theme-option").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === name));
}

function initTheme() {
  const saved = localStorage.getItem("dao-theme");
  applyTheme(THEMES.includes(saved) ? saved : "midnight");

  $("#theme-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#theme-menu").classList.toggle("open");
  });
  $$(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      $("#theme-menu").classList.remove("open");
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".theme-picker")) $("#theme-menu").classList.remove("open");
  });
}

/* ==================================================================
   VEHICLES LIST
   ================================================================== */
async function loadVehiclesView() {
  try {
    state.vehicles = await get(state.filter === "history" ? "/api/vehicles-board?archived=true" : "/api/vehicles-board");
  } catch (err) {
    renderViewFailure("vehicles", err);
    return;
  }
  state.vehicleSelection.clear();
  // renderStats is driven from inside renderVehiclesTable now -- the cards
  // describe the visible rows, so they have to be recomputed on every filter,
  // search and sort, not just on fetch. Calling it here as well would render
  // them once against a status filter that renderVehicleStatusOptions is
  // about to drop for not existing in this segment.
  renderVehicleStatusOptions();
  renderVehiclesTable();
}

/* ---------- board view preferences ----------
   Segment, status, and sort are the advisor's working view, not incidental UI
   state: a tech-lead who lives on "Recon, In Progress, oldest first" had to
   rebuild that view after every refresh. All three persist; search
   deliberately does not, because a stale search box that hides most of the
   board is confusing to come back to. */
const VEHICLE_PREFS_KEY = "dao-vehicle-view";

function loadVehicleViewPrefs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(VEHICLE_PREFS_KEY) || "null"); } catch { saved = null; }
  if (!saved || typeof saved !== "object") return;
  if (["", "recon", "we_owe", "history"].includes(saved.filter)) state.filter = saved.filter;
  if (typeof saved.status === "string") state.vehicleStatus = saved.status;
  if (saved.sort && (saved.sort.key === "" || VEHICLE_SORTS[saved.sort.key])) {
    state.vehicleSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
  }
  if (typeof saved.partsOnly === "boolean") state.vehiclePartsOnly = saved.partsOnly;
  if (typeof saved.idleBucket === "string" && (saved.idleBucket === "" || IDLE_BY_KEY[saved.idleBucket])) {
    state.vehicleIdleBucket = saved.idleBucket;
  }
  if (typeof saved.chartOpen === "boolean") state.vehicleChartOpen = saved.chartOpen;
  const chips = $$("#view-vehicles .filters .chip[data-filter]");
  chips.forEach((c) => c.classList.toggle("active", (c.dataset.filter || "") === state.filter));
  $("#vehicles-status-filter").value = state.vehicleStatus;
  syncPartsFilterChip();
}

// The toggle's pressed state lives in two places the DOM cares about --
// .active for the paint, aria-pressed for screen readers -- and is set from
// state on load, on reset, and on click, so there's one writer for all three.
function syncPartsFilterChip() {
  const chip = $("#vehicles-parts-filter");
  if (!chip) return;
  chip.classList.toggle("active", state.vehiclePartsOnly);
  chip.setAttribute("aria-pressed", state.vehiclePartsOnly ? "true" : "false");
}

function saveVehicleViewPrefs() {
  try {
    localStorage.setItem(VEHICLE_PREFS_KEY, JSON.stringify({
      filter: state.filter, status: state.vehicleStatus, sort: state.vehicleSort,
      partsOnly: state.vehiclePartsOnly, idleBucket: state.vehicleIdleBucket,
      chartOpen: state.vehicleChartOpen,
    }));
  } catch {}
  // chartOpen is deliberately not part of "dirty": showing or hiding the chart
  // doesn't hide any rows, so offering to reset the view over it would be
  // noise. Every other pref here changes which cars you can see.
  const dirty = !!(state.filter || state.vehicleStatus || state.vehicleSort.key || state.search
    || state.vehiclePartsOnly || state.vehicleIdleBucket);
  $("#vehicles-reset-view").hidden = !dirty;
}

function resetVehicleView() {
  state.filter = "";
  state.vehicleStatus = "";
  state.vehiclePartsOnly = false;
  state.vehicleIdleBucket = "";
  state.vehicleSort = { key: "", dir: "desc" };
  state.search = "";
  $("#global-search").value = "";
  $("#vehicles-status-filter").value = "";
  $$("#view-vehicles .filters .chip[data-filter]").forEach((c) => c.classList.toggle("active", !c.dataset.filter));
  syncPartsFilterChip();
  loadVehiclesView();
}

// Statuses differ by segment (recon carries the ticket's status, we-owe can
// also be fulfilled/waived), and which ones exist depends on the data, so the
// dropdown is built from what's actually on the board rather than hardcoded --
// a status nobody has is a dead option that only ever produces an empty list.
function renderVehicleStatusOptions() {
  const sel = $("#vehicles-status-filter");
  const present = [...new Set(state.vehicles.map((v) => v.status))]
    .sort((a, b) => (STATUS_LABEL[a] || a).localeCompare(STATUS_LABEL[b] || b));
  if (state.vehicleStatus && !present.includes(state.vehicleStatus)) state.vehicleStatus = "";
  sel.innerHTML = `<option value="">Any</option>` +
    present.map((s) => `<option value="${esc(s)}">${esc(STATUS_LABEL[s] || s)}</option>`).join("");
  sel.value = state.vehicleStatus;
}

/* ---------- board summary cards ----------

   These summarize the rows that are actually on screen, not the whole lot.

   They used to do the opposite: the cards were hardcoded to every
   in-progress vehicle in state.vehicles while the table below them was
   filtered by segment, status and search. Filter the board to We-Owe and the
   card still said "14 in recon"; search for one car and "Cost" still showed
   the lot's total. Reports got this right (its cards describe its own rows)
   and the two screens visibly disagreed about the same numbers, which makes
   both of them untrustworthy. Same source as the table now -- one call to
   visibleVehicles(), passed in so the table and the cards can't drift by
   being computed at different moments.

   The scope line under the cards says in words which rows are included, so
   "4 vehicles" can't be misread as the size of the lot. */
function boardStats(rows) {
  const overs = rows.filter(isOverQuote);
  return {
    count: rows.length,
    recon: rows.filter((v) => v.segment === "recon").length,
    weOwe: rows.filter((v) => v.segment === "we_owe").length,
    cost: rows.reduce((s, v) => s + (v.actual_cost || 0), 0),
    quoted: rows.reduce((s, v) => s + (v.quoted_cost || 0), 0),
    partsWaiting: rows.filter((v) => (v.parts_pending || 0) > 0).length,
    partsValue: rows.reduce((s, v) => s + (v.parts_pending_value || 0), 0),
    overCount: overs.length,
    overAmount: overs.reduce((s, v) => s + (v.actual_cost - v.quoted_cost), 0),
  };
}

function renderStats(rows) {
  const s = boardStats(rows);
  const setValue = (sel, text, tone) => {
    const el = $(sel);
    el.textContent = text;
    el.classList.toggle("warn", tone === "warn");
    el.classList.toggle("crit", tone === "crit");
  };

  setValue("#stat-veh-count", s.count);
  $("#stat-veh-split").textContent = s.count
    ? `${s.recon} recon · ${s.weOwe} we-owe`
    : "no vehicles";

  setValue("#stat-parts-waiting", s.partsWaiting, s.partsWaiting ? "warn" : null);
  $("#stat-parts-waiting-sub").textContent = s.partsWaiting
    ? `${money(s.partsValue)} on order`
    : "nothing on order";

  setValue("#stat-actual-total", money(s.cost));
  $("#stat-quoted-sub").textContent = s.quoted
    ? `of ${money(s.quoted)} quoted`
    : "received parts + labor";

  setValue("#stat-over-quote", s.overCount, s.overCount ? "crit" : null);
  $("#stat-over-quote-sub").textContent = s.overCount
    ? `${money(s.overAmount)} past estimate`
    : "none past estimate";

  $("#vehicles-scope").textContent = boardScopeLabel();
}

// Reads back the filters in the order the toolbar shows them. Deliberately
// describes the filters rather than the result ("Recon, waiting on parts")
// so it still explains an empty board, where there are no rows to describe --
// and for the same reason the noun doesn't agree with the row count, which
// would give "Showing vehicle: we-owe" whenever a filter happened to leave
// exactly one car.
function boardScopeLabel() {
  const parts = [];
  if (state.filter === "history") parts.push("archived to History");
  else if (state.filter === "recon") parts.push("recon");
  else if (state.filter === "we_owe") parts.push("we-owe");
  if (state.vehicleStatus) parts.push(STATUS_LABEL[state.vehicleStatus] || state.vehicleStatus);
  if (state.vehiclePartsOnly) parts.push("waiting on parts");
  if (state.vehicleIdleBucket) {
    const b = IDLE_BY_KEY[state.vehicleIdleBucket];
    if (b) parts.push(b.key === "today" ? "active today" : `idle ${b.short}`);
  }
  if (state.search) parts.push(`matching “${state.search}”`);
  if (!parts.length) return "Every vehicle on the board.";
  return `Showing vehicles: ${parts.join(" · ")}.`;
}

// Age severity: how long a car has actually been sitting is the natural
// companion to "what we have in it" -- color makes the outliers jump out
// without having to read every row.
function ageClass(days) {
  if (days >= 30) return "age-crit";
  if (days >= 14) return "age-warn";
  return "age-ok";
}

/* ---------- idle time ----------

   Age says how long the shop has had the car. Idle says when anyone last did
   anything to it, which is the question that actually costs money: a car 40
   days old that a tech touched this morning is fine, and a car 6 days old
   that nobody has opened since day one is not. The server derives it from
   orders.last_activity_at (bumped by every mutating route) rather than from
   the vehicle row's updated_at, which only moves when the vehicle record
   itself is patched.

   The thresholds are tighter than Age's on purpose. Two weeks of no work on a
   recon car is a crisis, not a warning, so "stale" starts at 3 days (past a
   weekend) and goes critical at a week. */
const IDLE_BUCKETS = [
  { key: "today",  label: "Today",       short: "today",     min: 0,  max: 0,  tone: "" },
  { key: "recent", label: "1–2 days",    short: "1–2 days",  min: 1,  max: 2,  tone: "" },
  { key: "stale",  label: "3–6 days",    short: "3–6 days",  min: 3,  max: 6,  tone: "warn" },
  { key: "cold",   label: "7–13 days",   short: "7–13 days", min: 7,  max: 13, tone: "over" },
  { key: "frozen", label: "14+ days",    short: "14+ days",  min: 14, max: Infinity, tone: "over" },
];

const IDLE_BY_KEY = Object.fromEntries(IDLE_BUCKETS.map((b) => [b.key, b]));

function idleBucket(days) {
  const n = Math.max(0, days || 0);
  return IDLE_BUCKETS.find((b) => n >= b.min && n <= b.max) || IDLE_BUCKETS[0];
}

// Matches the bucket boundaries above, so a row's color and the bar it lands
// in can never disagree -- one function, two callers.
function idleClass(days) {
  const tone = idleBucket(days).tone;
  return tone === "over" ? "age-crit" : tone === "warn" ? "age-warn" : "age-ok";
}

// "0d" reads like a broken cell; the day something happened is the one case
// worth spelling out. Everything else is the same compact Nd as Age.
function idleCellHtml(v) {
  const days = v.idle_days || 0;
  const when = v.last_activity_at ? String(v.last_activity_at).slice(0, 10) : "";
  const title = when
    ? `Last activity ${when} — ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`
    : "No activity recorded";
  return `<span class="idle-cell ${idleClass(days)}" title="${esc(title)}">${days === 0 ? "today" : `${days}d`}</span>`;
}

/* The board's one chart. Cost-by-vehicle already exists on Reports and would
   just be a worse copy of it here; what the board can show that Reports
   can't is the shape of the whole list at a glance -- how much of it is
   moving and how much is sitting.

   Every bar is a filter. Seeing "6 cars idle 14+ days" and then having to
   hunt for which six down a 60-row table is the kind of half-feature that
   makes a dashboard decorative, so clicking a bar filters the board to it and
   clicking it again clears it. Empty buckets are dropped rather than drawn as
   zero-width bars nobody can click. */
function renderIdleChart(rows) {
  const target = $("#vehicles-chart");
  if (!target) return;
  target.hidden = !state.vehicleChartOpen;
  const toggle = $("#vehicles-chart-toggle");
  if (toggle) {
    toggle.textContent = state.vehicleChartOpen ? "Hide activity chart" : "Show activity chart";
    toggle.setAttribute("aria-expanded", state.vehicleChartOpen ? "true" : "false");
  }
  if (!state.vehicleChartOpen) return;

  // Counted over the board minus the idle filter itself, so the bars stay put
  // when you click one -- a chart that collapses to the single bar you just
  // selected gives you no way back and nothing to compare against.
  const pool = visibleVehicles({ ignoreIdle: true });
  const items = IDLE_BUCKETS.map((b) => {
    const count = pool.filter((v) => idleBucket(v.idle_days).key === b.key).length;
    const selected = state.vehicleIdleBucket === b.key;
    return {
      label: b.label,
      value: count,
      display: String(count),
      tone: [b.tone, selected ? "selected" : ""].filter(Boolean).join(" "),
      attrs: `data-idle-bucket="${b.key}" role="button" tabindex="0" aria-pressed="${selected}"` +
             ` title="${esc(`${count} vehicle${count === 1 ? "" : "s"} with no activity ${b.short === "today" ? "logged today" : `for ${b.short}`}${count ? " — click to filter" : ""}`)}"`,
      muted: count === 0,
    };
  }).filter((i) => i.value > 0 || state.vehicleIdleBucket);

  target.innerHTML = barChart({
    title: "Time since anything happened",
    note: pool.length ? `${pool.length} vehicle${pool.length === 1 ? "" : "s"} in view` : "",
    items,
    rowAttrs: (i) => i.attrs,
    rowClass: (i) => (i.muted ? "bar-row-muted" : ""),
  }) || `<div class="panel chart-panel chart-empty">No vehicles in view to chart.</div>`;
}

// Recon rows always carry the linked repair order's status (one of the 4
// ticket statuses, color-coded). We-owe rows do too while the promise is
// still open (so progressing the ticket shows up on the board immediately),
// but switch to showing fulfilled/waived once the advisor explicitly
// resolves the promise -- that's not part of the ticket-status vocabulary,
// so it just keeps the simpler finished/in-progress coloring.
function vehicleStatusPillClass(v) {
  return v.segment === "recon" ? (STATUS_PILL_CLASS[v.status] || "pill-progress") : (v.status_bucket === "finished" ? "pill-done" : (STATUS_PILL_CLASS[v.status] || "pill-progress"));
}

// "Nothing here" and "your filter hid everything" are different problems with
// different fixes, so they get different copy and different buttons rather
// than one generic "No vehicles match."
function vehiclesEmptyState() {
  if (state.search) {
    return {
      icon: "search",
      title: "No vehicles match that search",
      hint: `Nothing matched "${state.search}". Searches cover stock number, VIN, customer name, and the vehicle description.`,
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-search">Clear search</button>`,
    };
  }
  // Checked before the segment cases: with the toggle on, "no recon
  // vehicles" would be a lie about the lot when what's true is that none of
  // them are waiting on a part -- which is good news, and reads as such.
  if (state.vehiclePartsOnly) {
    return {
      icon: "check",
      title: "Nothing is waiting on parts",
      hint: "No vehicle in this view has a part that's been ordered from a vendor but hasn't arrived yet.",
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-parts">Show all vehicles</button>`,
    };
  }
  // Same reasoning as the parts toggle: the bucket is a filter the advisor
  // clicked, and an empty one is usually the answer they wanted ("nothing has
  // gone a week untouched"), not an empty lot.
  if (state.vehicleIdleBucket) {
    const b = IDLE_BY_KEY[state.vehicleIdleBucket];
    const cold = b && b.min >= 3;
    return {
      icon: cold ? "check" : "search",
      title: cold ? `Nothing has been sitting ${b.short}` : "No vehicles in that bucket",
      hint: cold
        ? "Every vehicle in this view has been worked on more recently than that."
        : `No vehicle in this view was last touched ${b ? b.short : "then"}.`,
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-idle">Show all vehicles</button>`,
    };
  }
  if (state.filter === "history") {
    return {
      icon: "archive",
      title: "Nothing in History yet",
      hint: "Vehicles you send to History are archived out of the main list. They stay fully readable, and can be reopened at any time.",
    };
  }
  if (state.filter === "recon") {
    return {
      icon: "vehicle",
      title: "No recon vehicles",
      hint: "Recon vehicles are the lot's own stock being prepped for sale.",
      actions: `<button type="button" class="btn btn-primary btn-sm" data-empty-action="add-recon">Add Recon Vehicle</button>`,
    };
  }
  if (state.filter === "we_owe") {
    return {
      icon: "vehicle",
      title: "No open we-owe promises",
      hint: "A we-owe is something promised to a customer at the time of sale that still has to be made good.",
      actions: `<button type="button" class="btn btn-primary btn-sm" data-empty-action="add-we-owe">Add We-Owe Promise</button>`,
    };
  }
  return {
    icon: "vehicle",
    title: "No vehicles yet",
    hint: "Add the first recon vehicle or we-owe promise, and its cost, parts, and technician all start tracking from here.",
    actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="add-we-owe">We-Owe Promise</button>
              <button type="button" class="btn btn-primary btn-sm" data-empty-action="add-recon">Recon Vehicle</button>`,
  };
}

/* ---------- sorting ----------
   One comparator per column, all of them stable against the server's own
   ordering (newest first) because Array.prototype.sort is stable in every
   engine this ships to -- so sorting by Type, say, leaves each type's cars in
   the order they'd have been in anyway. Text columns compare
   case-insensitively and always sort blanks last regardless of direction: a
   we-owe with no stock number is missing data, not "the first car", and
   burying it at the bottom either way is what every list app does. */
const VEHICLE_SORTS = {
  stock: { label: "Stock #", type: "text", value: (v) => v.stock_number || "" },
  vehicle: { label: "Vehicle", type: "text", value: (v) => v.vehicle || "" },
  segment: { label: "Type", type: "text", value: (v) => (v.segment === "recon" ? "Recon" : "We-Owe") },
  status: { label: "Status", type: "text", value: (v) => STATUS_LABEL[v.status] || v.status || "" },
  tech: { label: "Technician", type: "text", value: (v) => v.technicians.join(", ") },
  parts: { label: "Parts", type: "number", value: (v) => v.parts_pending || 0 },
  age: { label: "Age", type: "number", value: (v) => v.age_days },
  idle: { label: "Idle", type: "number", value: (v) => v.idle_days || 0 },
  quoted: { label: "Quoted", type: "number", value: (v) => v.quoted_cost },
  cost: { label: "Cost", type: "number", value: (v) => v.actual_cost },
};

function sortVehicleRows(rows, { key, dir }) {
  const spec = VEHICLE_SORTS[key];
  if (!spec) return rows;
  const sign = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = spec.value(a), bv = spec.value(b);
    if (spec.type === "number") return ((av || 0) - (bv || 0)) * sign;
    // blanks last, in both directions
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * sign;
  });
}

// ignoreIdle skips the idle-bucket filter only: it's what the chart counts
// over, so selecting a bucket narrows the table without collapsing the chart
// that selected it. Every other caller gets the fully filtered list.
function visibleVehicles({ ignoreIdle = false } = {}) {
  let rows = state.vehicles;
  if (state.filter && state.filter !== "history") rows = rows.filter((v) => v.segment === state.filter);
  if (state.vehicleStatus) rows = rows.filter((v) => v.status === state.vehicleStatus);
  if (state.vehiclePartsOnly) rows = rows.filter((v) => (v.parts_pending || 0) > 0);
  if (state.vehicleIdleBucket && !ignoreIdle) {
    rows = rows.filter((v) => idleBucket(v.idle_days).key === state.vehicleIdleBucket);
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((v) =>
      (v.stock_number || "").toLowerCase().includes(q) ||
      (v.vin || "").toLowerCase().includes(q) ||
      (v.customer_name || "").toLowerCase().includes(q) ||
      v.vehicle.toLowerCase().includes(q)
    );
  }
  return sortVehicleRows(rows, state.vehicleSort);
}

function renderVehicleSortHeaders() {
  $$("#view-vehicles th.sortable").forEach((th) => {
    const active = th.dataset.sortKey === state.vehicleSort.key;
    th.classList.toggle("sorted", active);
    th.setAttribute("aria-sort", active ? (state.vehicleSort.dir === "asc" ? "ascending" : "descending") : "none");
    const spec = VEHICLE_SORTS[th.dataset.sortKey];
    const nextDir = active && state.vehicleSort.dir === "desc" ? "ascending" : "descending";
    th.title = active && state.vehicleSort.dir === "asc" && spec
      ? `Sort by ${spec.label} — click to clear`
      : `Sort by ${spec ? spec.label : "column"} (${nextDir})`;
    const arrow = $(".sort-arrow", th);
    if (arrow) arrow.textContent = active ? (state.vehicleSort.dir === "desc" ? "▼" : "▲") : "";
  });
}

/* Cost against quote is the number the manager actually reads this board for,
   so a car that's run past its estimate says so in the row rather than making
   you open it and do the subtraction.

   One definition, used by the row's red Cost cell and by the Over Quote
   summary card, so the card's count is always exactly the number of red cells
   below it. 10% of slack, because a car finishing a few dollars over its
   estimate is normal and flagging it would make the color meaningless. */
function isOverQuote(v) {
  return !!(v.quoted_cost && v.actual_cost && v.actual_cost > v.quoted_cost * 1.1);
}

function costCellClass(v) {
  return isOverQuote(v) ? "over-quote" : "";
}

/* "Waiting on parts" is the single most common reason a car sits, and until
   now the only way to find out was to open the ticket and read the estimate.
   A count rather than a yes/no, because one back-ordered bumper and nine
   outstanding lines are very different situations, and the dollar value on
   the tooltip answers the follow-up question without a click.

   A blank cell, not a dash: on a full board most cars aren't waiting on
   anything, and 50 dashes down the column would draw the eye to exactly the
   rows that don't need it. */
function partsCellHtml(v) {
  const n = v.parts_pending || 0;
  if (!n) return "";
  const value = v.parts_pending_value ? ` · ${money(v.parts_pending_value)}` : "";
  const label = `${n} part${n === 1 ? "" : "s"} ordered, not yet received${value}`;
  return `<span class="parts-badge" title="${esc(label)}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h13v10H3zM16 10h3.5l1.5 3v4h-5z"/><circle cx="7" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/></svg>
      ${n}</span>`;
}

function vehicleRowHtml(v) {
  const key = vehicleKey(v);
  const over = costCellClass(v);
  return `
      <td class="col-select"><input type="checkbox" class="veh-select" data-key="${key}" aria-label="Select ${esc(v.stock_number || v.vehicle)}" ${state.vehicleSelection.has(key) ? "checked" : ""}></td>
      <td class="num">${esc(v.stock_number || "—")}</td>
      <td>
        <div class="veh-name">${esc(v.vehicle)}</div>
        <div class="veh-sub">${v.segment === "we_owe" ? esc(v.customer_name || "") : esc(v.vin || "")}</div>
      </td>
      <td><span class="pill ${v.segment === "recon" ? "pill-recon" : "pill-weowe"}">${v.segment === "recon" ? "Recon" : "We-Owe"}</span></td>
      <td><span class="pill ${vehicleStatusPillClass(v)}">${esc(STATUS_LABEL[v.status] || v.status)}</span></td>
      <td>${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span>${esc(v.technicians.join(", "))}</span>` : `<span class="muted-dash">—</span>`}</td>
      <td class="col-parts">${partsCellHtml(v)}</td>
      <td class="num-col age-col ${ageClass(v.age_days)}">${v.age_days}d</td>
      <td class="num-col idle-col">${idleCellHtml(v)}</td>
      <td class="num-col quoted-col">${v.quoted_cost ? money(v.quoted_cost) : `<span class="muted-dash">—</span>`}</td>
      <td class="num-col ${over}"${over ? ` title="Over the estimate by ${money(v.actual_cost - v.quoted_cost)}"` : ""}>${money(v.actual_cost)}</td>`;
}

// A signature of everything vehicleRowHtml() reads. Two renders with the same
// signature produce byte-identical markup, so the existing <tr> can be reused
// as-is -- see renderVehiclesTable.
function vehicleRowSignature(v) {
  return [
    v.stock_number, v.vehicle, v.vin, v.customer_name, v.segment, v.status, v.status_bucket,
    v.technicians.join("|"), v.age_days, v.idle_days, v.last_activity_at,
    v.quoted_cost, v.actual_cost, v.parts_pending, v.parts_pending_value,
    state.vehicleSelection.has(vehicleKey(v)) ? 1 : 0,
  ].join("");
}

/* Incremental, keyed render.

   The board used to rebuild tbody.innerHTML on every keystroke of the search
   box, every filter chip and every sort click, then re-bind two listeners per
   row. That threw away scroll position (annoying on a 60-car lot), threw away
   focus, and made a checkbox you'd just clicked flicker. Now each <tr> is
   keyed by segment:id and carries a signature of the data it was built from:
   rows whose data hasn't changed are moved rather than rebuilt, rows that
   changed have only their cells replaced, and only genuinely new rows are
   created. Reordering a list of existing nodes doesn't disturb the scroll
   container, so sorting a long board keeps your place in it. */
function renderVehiclesTable() {
  const rows = visibleVehicles();
  const body = $("#vehicles-table");
  const scroller = $("#vehicles-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;

  $("#vehicles-count").textContent = `${rows.length} vehicle${rows.length === 1 ? "" : "s"}`;
  renderStats(rows);
  renderIdleChart(rows);
  renderVehicleSortHeaders();
  saveVehicleViewPrefs();

  if (!rows.length) {
    body.innerHTML = emptyRow(BOARD_COLUMNS, vehiclesEmptyState());
    state.vehicleCursor = null;
    $("#vehicles-select-all").checked = false;
    $("#vehicles-select-all").indeterminate = false;
    renderVehicleBulkBar();
    return;
  }

  const existing = new Map();
  for (const tr of body.children) {
    if (tr.dataset && tr.dataset.key) existing.set(tr.dataset.key, tr);
  }

  let cursor = body.firstElementChild;
  for (const v of rows) {
    const key = vehicleKey(v);
    const sig = vehicleRowSignature(v);
    let tr = existing.get(key);
    if (tr) {
      existing.delete(key);
      if (tr.dataset.sig !== sig) {
        tr.innerHTML = vehicleRowHtml(v);
        tr.dataset.sig = sig;
      }
    } else {
      tr = document.createElement("tr");
      tr.className = "clickable";
      tr.dataset.segment = v.segment;
      tr.dataset.id = String(v.segment === "recon" ? v.recon_id : v.we_owe_id);
      tr.dataset.key = key;
      tr.dataset.sig = sig;
      tr.innerHTML = vehicleRowHtml(v);
    }
    tr.classList.toggle("selected", state.vehicleSelection.has(key));
    if (tr === cursor) cursor = cursor.nextElementSibling;
    else body.insertBefore(tr, cursor);
  }
  // whatever's left never made it into this render (filtered out, or gone)
  for (const tr of existing.values()) tr.remove();
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }

  if (state.vehicleCursor && !rows.some((v) => vehicleKey(v) === state.vehicleCursor)) state.vehicleCursor = null;
  applyVehicleCursor();

  const selectedCount = rows.filter((v) => state.vehicleSelection.has(vehicleKey(v))).length;
  const all = $("#vehicles-select-all");
  all.checked = selectedCount === rows.length;
  all.indeterminate = selectedCount > 0 && selectedCount < rows.length;
  renderVehicleBulkBar();
  if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
}

function applyVehicleCursor() {
  $$("#vehicles-table tr.cursor").forEach((tr) => tr.classList.remove("cursor"));
  if (!state.vehicleCursor) return;
  const tr = $(`#vehicles-table tr[data-key="${cssEscape(state.vehicleCursor)}"]`);
  if (tr) tr.classList.add("cursor");
}

// Keys are "segment:id" -- the colon needs escaping inside an attribute
// selector, and CSS.escape doesn't exist in every environment this runs in
// (notably the jsdom used by the front-end smoke test).
function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function vehicleKey(v) {
  return `${v.segment}:${v.segment === "recon" ? v.recon_id : v.we_owe_id}`;
}

// Bulk archive/reopen reuses the same single-vehicle endpoints the detail
// view already calls, fired concurrently -- there's no cross-vehicle
// transaction to preserve since archiving one has zero effect on another.
function renderVehicleBulkBar() {
  const n = state.vehicleSelection.size;
  $("#vehicles-bulk-bar").style.display = n ? "" : "none";
  if (!n) return;
  $("#vehicles-bulk-count").textContent = `${n} selected`;
  $("#vehicles-bulk-archive").textContent = state.filter === "history" ? "Reopen Selected" : "Send Selected to History";
}

/* ---------- selection ---------- */
function setVehicleSelected(key, on) {
  if (on) state.vehicleSelection.add(key);
  else state.vehicleSelection.delete(key);
}

// Shift+click selects everything between the last row you touched and this
// one, in the order they're currently displayed -- the standard file-list
// gesture, and the only sane way to archive twenty cars at once.
function selectVehicleRange(fromKey, toKey) {
  const keys = visibleVehicles().map(vehicleKey);
  const a = keys.indexOf(fromKey), b = keys.indexOf(toKey);
  if (a === -1 || b === -1) return setVehicleSelected(toKey, true);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.vehicleSelection.add(keys[i]);
}

function moveVehicleCursor(delta) {
  const keys = visibleVehicles().map(vehicleKey);
  if (!keys.length) return;
  const at = state.vehicleCursor ? keys.indexOf(state.vehicleCursor) : -1;
  let next;
  if (delta === "first") next = 0;
  else if (delta === "last") next = keys.length - 1;
  else next = at === -1 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + delta));
  state.vehicleCursor = keys[next];
  applyVehicleCursor();
  const tr = $(`#vehicles-table tr[data-key="${cssEscape(state.vehicleCursor)}"]`);
  if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
}

function wireVehiclesView() {
  // Scoped to this view's own chips. ".filters .chip" matched every chip in
  // the app -- the A/P date ranges, the cores and returns filters, the task
  // filters -- so clicking any one of those also ran this handler, wiping the
  // active state off every chip on every screen and setting state.filter to
  // undefined. Every other view already scopes its chip wiring this way.
  //
  // [data-filter] narrows it further, to the four mutually-exclusive segment
  // chips. The "Waiting on parts" toggle beside them is also a .chip but it's
  // an independent on/off, so it must not be swept into the radio-group
  // behaviour below (nor lit up by the prefs loader, which decides active
  // state by comparing dataset.filter to state.filter -- undefined || ""
  // would have matched the All case and lit the toggle on every load).
  const vehicleChips = $$("#view-vehicles .filters .chip[data-filter]");
  vehicleChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      vehicleChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const wasHistory = state.filter === "history";
      state.filter = chip.dataset.filter;
      state.vehicleCursor = null;
      if (wasHistory !== (state.filter === "history")) loadVehiclesView();
      else { renderVehicleStatusOptions(); renderVehiclesTable(); }
    });
  });
  $("#vehicles-status-filter").addEventListener("change", (e) => {
    state.vehicleStatus = e.target.value;
    state.vehicleCursor = null;
    renderVehiclesTable();
  });
  // An independent toggle, not one of the segment chips: "Recon" and
  // "Waiting on parts" are a question worth asking together.
  $("#vehicles-parts-filter").addEventListener("click", () => {
    state.vehiclePartsOnly = !state.vehiclePartsOnly;
    state.vehicleCursor = null;
    syncPartsFilterChip();
    renderVehiclesTable();
  });
  $("#vehicles-reset-view").addEventListener("click", () => resetVehicleView());

  // The chart's bars are filters. Delegated from the container because the
  // whole chart is re-rendered on every filter change, so per-bar listeners
  // would be re-bound (or lost) constantly. Clicking the selected bucket
  // clears it, which is the only affordance a one-of-five filter needs.
  const chart = $("#vehicles-chart");
  if (chart) {
    const pickBucket = (bar) => {
      const key = bar.dataset.idleBucket;
      state.vehicleIdleBucket = state.vehicleIdleBucket === key ? "" : key;
      // The cursor is deliberately left alone: renderVehiclesTable already
      // drops it when the filter hides the row it was on, so a cursor that
      // survives into the new view should keep its place rather than sending
      // you back to the top of the list.
      renderVehiclesTable();
    };
    chart.addEventListener("click", (e) => {
      const bar = e.target.closest("[data-idle-bucket]");
      if (bar) pickBucket(bar);
    });
    // role="button" without keyboard activation is a lie to a screen reader,
    // and the rest of this board is fully keyboard-drivable.
    chart.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const bar = e.target.closest("[data-idle-bucket]");
      if (!bar) return;
      e.preventDefault();
      // The board's document-level keydown handler owns Enter (open the cursor
      // row) and Space (select it). Both would also fire on the way up from a
      // bar, so activating a filter would open a car at the same time.
      e.stopPropagation();
      pickBucket(bar);
    });
  }
  const chartToggle = $("#vehicles-chart-toggle");
  if (chartToggle) {
    chartToggle.addEventListener("click", () => {
      state.vehicleChartOpen = !state.vehicleChartOpen;
      // Hiding the chart must not silently leave a filter on that only the
      // chart could show or clear -- that's how a board ends up "missing" cars
      // with no visible reason why.
      if (!state.vehicleChartOpen) state.vehicleIdleBucket = "";
      renderVehiclesTable();
    });
  }
  $("#global-search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    if (!$("#view-vehicles").classList.contains("active")) showView("vehicles");
    renderVehiclesTable();
  });
  $("#add-recon-btn").addEventListener("click", () => openReconDialog());
  $("#add-we-owe-btn").addEventListener("click", () => openWeOweDialog());

  // One delegated click handler for the whole table body: the empty state's
  // buttons, the per-row checkboxes and opening a vehicle. Rows are recycled
  // across renders now, so per-row binding would either double up or be lost
  // depending on which side of the reuse a row landed on.
  $("#vehicles-table").addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-empty-action]");
    if (trigger) {
      if (trigger.dataset.emptyAction === "add-recon") openReconDialog();
      if (trigger.dataset.emptyAction === "add-we-owe") openWeOweDialog();
      if (trigger.dataset.emptyAction === "clear-search") {
        state.search = "";
        $("#global-search").value = "";
        renderVehiclesTable();
      }
      if (trigger.dataset.emptyAction === "clear-parts") {
        state.vehiclePartsOnly = false;
        syncPartsFilterChip();
        renderVehiclesTable();
      }
      if (trigger.dataset.emptyAction === "clear-idle") {
        state.vehicleIdleBucket = "";
        renderVehiclesTable();
      }
      return;
    }
    const row = e.target.closest("tr.clickable");
    if (!row) return;
    const key = row.dataset.key;
    const box = e.target.closest(".veh-select");
    if (box) {
      // the checkbox owns the click; opening the vehicle would be a surprise
      if (e.shiftKey && state.vehicleAnchor && state.vehicleAnchor !== key) selectVehicleRange(state.vehicleAnchor, key);
      else setVehicleSelected(key, box.checked);
      state.vehicleAnchor = key;
      state.vehicleCursor = key;
      renderVehiclesTable();
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // modifier-click anywhere on the row is a selection gesture, not navigation
      if (e.shiftKey && state.vehicleAnchor) selectVehicleRange(state.vehicleAnchor, key);
      else setVehicleSelected(key, !state.vehicleSelection.has(key));
      state.vehicleAnchor = key;
      state.vehicleCursor = key;
      renderVehiclesTable();
      return;
    }
    state.vehicleCursor = key;
    openVehicleDetail(row.dataset.segment, Number(row.dataset.id));
  });

  // Keyboard: the board is a work list, and a work list you can only drive
  // with a mouse is slow to triage. Arrows move a cursor row, Enter opens it,
  // Space selects it, "/" jumps to search.
  document.addEventListener("keydown", (e) => {
    if (!$("#view-vehicles").classList.contains("active")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#global-search").focus();
      $("#global-search").select();
      return;
    }
    if (typing) {
      if (e.key === "Escape" && e.target.id === "global-search") {
        state.search = "";
        e.target.value = "";
        renderVehiclesTable();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveVehicleCursor(1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); moveVehicleCursor(-1); }
    else if (e.key === "Home") { e.preventDefault(); moveVehicleCursor("first"); }
    else if (e.key === "End") { e.preventDefault(); moveVehicleCursor("last"); }
    else if (e.key === "Enter" && state.vehicleCursor) {
      const tr = $(`#vehicles-table tr[data-key="${cssEscape(state.vehicleCursor)}"]`);
      if (tr) openVehicleDetail(tr.dataset.segment, Number(tr.dataset.id));
    } else if (e.key === " " && state.vehicleCursor) {
      e.preventDefault();
      setVehicleSelected(state.vehicleCursor, !state.vehicleSelection.has(state.vehicleCursor));
      state.vehicleAnchor = state.vehicleCursor;
      renderVehiclesTable();
    } else if (e.key === "Escape" && state.vehicleSelection.size) {
      state.vehicleSelection.clear();
      renderVehiclesTable();
    }
  });

  $$("#view-vehicles th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (state.vehicleSort.key !== key) state.vehicleSort = { key, dir: "desc" };
      else if (state.vehicleSort.dir === "desc") state.vehicleSort = { key, dir: "asc" };
      else state.vehicleSort = { key: "", dir: "desc" }; // third click clears back to newest-first
      renderVehiclesTable();
    });
  });

  $("#vehicles-select-all").addEventListener("change", (e) => {
    // Select-all means every row the current filter shows, not every row the
    // DOM happens to have painted.
    visibleVehicles().forEach((v) => setVehicleSelected(vehicleKey(v), e.target.checked));
    renderVehiclesTable();
  });

  $("#vehicles-bulk-clear").addEventListener("click", () => {
    state.vehicleSelection.clear();
    renderVehiclesTable();
  });

  $("#vehicles-bulk-archive").addEventListener("click", async () => {
    const reopening = state.filter === "history";
    const targets = [...state.vehicleSelection].map((key) => {
      const [segment, id] = key.split(":");
      return { segment, id };
    });
    const plural = `${targets.length} vehicle${targets.length === 1 ? "" : "s"}`;
    if (!(await confirmAction({
      eyebrow: reopening ? "REOPEN" : "ARCHIVE",
      title: reopening ? `Reopen ${plural}?` : `Send ${plural} to History?`,
      body: reopening
        ? "They come back onto the active board and become editable again."
        : "Archived vehicles are read-only until reopened. Nothing is deleted.",
      confirmLabel: reopening ? "Reopen" : "Send to History",
    }))) return;
    const results = await Promise.allSettled(targets.map(({ segment, id }) =>
      post(`/api/${segment === "recon" ? "recon/vehicles" : "we-owe"}/${id}/${reopening ? "reopen" : "archive"}`, {})
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(failed ? `${targets.length - failed} succeeded, ${failed} failed` : `${targets.length} vehicle${targets.length === 1 ? "" : "s"} updated`, !!failed);
    await loadVehiclesView();
  });
}

/* ==================================================================
   VEHICLE DETAIL
   ================================================================== */
async function openVehicleDetail(segment, id) {
  state.detail = { segment, id, item: null, order: null };
  await loadVehicleDetail();
}
// showView only knows named views wired to the rail; vehicle-detail is entered directly.
function enterVehicleDetailView() {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-vehicle-detail"));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === "vehicles"));
}

async function loadVehicleDetail() {
  const { segment, id } = state.detail;
  let item, orders;
  try {
    item = segment === "recon" ? await get(`/api/recon/vehicles/${id}`) : await get(`/api/we-owe/${id}`);
    const allOrders = await get(`/api/orders?segment=${segment}`);
    orders = allOrders.filter((o) => segment === "recon" ? o.recon_vehicle_id === id : o.we_owe_id === id)
      .sort((a, b) => b.id - a.id);
  } catch (err) {
    toast(`Could not load vehicle: ${err.message}`, true);
    return;
  }
  state.detail.item = item;
  state.detail.ordersHistory = orders;
  // A vehicle can have more than one RO over its life (recon prep now, a
  // warranty comeback later); the advisor picking an older one from Order
  // History must survive every other action on this page re-loading the
  // detail (adding a note, saving assignment, etc.) until they navigate to
  // a different vehicle, which is what resets selectedOrderId to null.
  // Excludes a just-voided order, though -- voiding the one currently on
  // screen must fall back to another open/recent order, not keep showing
  // the dead ticket with everything still editable except the void button.
  const preferred = state.detail.selectedOrderId != null ? orders.find((o) => o.id === state.detail.selectedOrderId && !o.voided) : null;
  // Prefer a still-open order, but fall back to the most recent one (orders
  // is sorted newest-first) rather than pretending there's no order at all
  // once it reaches Complete -- otherwise a finished/archived ticket could
  // never be looked back at, which defeats the point of History.
  const active = preferred || orders.find((o) => o.status !== "complete") || orders[0] || null;
  state.detail.selectedOrderId = active ? active.id : null;
  enterVehicleDetailView();
  renderDetailHead();
  renderOrderHistory(orders, active ? active.id : null);
  // Deleting a vehicle with real order history would silently orphan its
  // cost data -- only offer it while there's nothing to lose yet.
  $("#vd-delete").style.display = orders.length === 0 ? "" : "none";
  if (!active) {
    $("#vd-void-order").style.display = "none";
    $("#vd-print-ticket").style.display = "none";
    $("#vd-add-task").style.display = "none";
    $("#vd-no-order").style.display = "";
    $("#vd-order-content").style.display = "none";
    applyArchivedLockUI(!!item.archived_at);
    return;
  }
  $("#vd-no-order").style.display = "none";
  $("#vd-order-content").style.display = "";
  let order;
  try {
    order = await get(`/api/orders/${active.id}`);
  } catch (err) {
    toast(`Could not load repair order: ${err.message}`, true);
    return;
  }
  state.detail.order = order;
  if (!state.staff.length) state.staff = await get("/api/staff");
  renderOrderPanel();
  applyArchivedLockUI(!!item.archived_at);
}

// Only shown once a vehicle actually has more than one RO -- the common
// single-ticket case looks exactly as clean as it always did.
function renderOrderHistory(orders, activeId) {
  const card = $("#vd-order-history-card");
  if (orders.length <= 1) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  $("#vd-order-history").innerHTML = orders.map((o) => `
    <div class="mini-item clickable ${o.id === activeId ? "active" : ""}" data-id="${o.id}">
      <div class="mi-title">
        <span>${esc(o.number)}</span>
        <span class="pill ${STATUS_PILL_CLASS[o.status] || ""}" style="font-size:9.5px">${o.voided ? "Voided" : (STATUS_LABEL[o.status] || o.status)}</span>
      </div>
      <div class="mi-concern">${esc(o.concern)}</div>
      <div class="mi-meta">${fmtDate(o.created_at)}</div>
    </div>
  `).join("");
  $$(".mini-item.clickable", $("#vd-order-history")).forEach((row) => {
    row.addEventListener("click", () => selectOrder(Number(row.dataset.id)));
  });
}

async function selectOrder(orderId) {
  if (orderId === state.detail.selectedOrderId) return;
  state.detail.selectedOrderId = orderId;
  await loadVehicleDetail();
}

function renderDetailHead() {
  const { segment, item } = state.detail;
  const updatedEl = $("#vd-updated");
  if (item.updated_at) {
    const minutesAgo = (Date.now() - new Date(item.updated_at).getTime()) / 60000;
    updatedEl.textContent = `Updated ${relativeTime(item.updated_at)}`;
    updatedEl.classList.toggle("recent", minutesAgo < 10);
  } else {
    updatedEl.textContent = "";
  }
  // Vehicle Info (VIN/year/make/model/etc.) is shared by both segments --
  // a car is sometimes entered quickly with the VIN added later, whether
  // it's a recon vehicle or a we-owe promise.
  $("#vd-recon-vin").value = item.vin || "";
  $("#vd-recon-mileage").value = item.mileage || 0;
  $("#vd-recon-year").value = item.year;
  $("#vd-recon-make").value = item.make;
  $("#vd-recon-model").value = item.model;
  $("#vd-recon-trim").value = item.trim || "";
  $("#vd-recon-color").value = item.color || "";
  $("#vd-recon-purchase-price-row").style.display = segment === "recon" ? "" : "none";
  if (segment === "recon") {
    $("#vd-title").textContent = `${item.stock_number} — ${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.vin, item.mileage ? `${item.mileage.toLocaleString()} mi` : "", item.trim].filter(Boolean).join(" · ");
    $("#vd-we-owe-status-card").style.display = "none";
    $("#vd-deposits-card").style.display = "none";
    $("#vd-recon-purchase-price").value = item.purchase_price || 0;
  } else {
    $("#vd-title").textContent = `${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.customer_name, item.description].filter(Boolean).join(" · ");
    $("#vd-we-owe-status-card").style.display = "";
    $("#vd-we-owe-status").value = item.status;
    $("#vd-we-owe-description").value = item.description || "";
    $("#vd-we-owe-category").value = item.category || "";
    $("#vd-we-owe-target").value = item.target_date || "";
    $("#vd-deposits-card").style.display = "";
    renderDepositsSummary();
  }
  renderCostSummary();
  renderVehicleInfoSummary();
}

// Vehicle-wide (every RO ever opened on this vehicle, not just the active
// one) -- quoted_cost/total_cost already come from the same cost_rollup
// the Vehicles-list stats use, just never surfaced here before.
function renderCostSummary() {
  const { item } = state.detail;
  const box = $("#vd-cost-summary");
  let lines = `<div class="cost-line"><span>Total Quote</span><span class="num">${money(item.quoted_cost)}</span></div>`;
  lines += `<div class="cost-line total"><span>Actual Cost</span><span class="num">${money(item.total_cost)}</span></div>`;
  if (state.detail.segment !== "recon" && item.customer_paid) {
    lines += `<div class="cost-line"><span>Customer paid</span><span class="num">${money(item.customer_paid)}</span></div>`;
    lines += `<div class="cost-line total"><span>Net to shop</span><span class="num">${money(item.net_cost)}</span></div>`;
  }
  box.innerHTML = lines;
}

// Compact read-only summary replacing the old always-open inline edit form --
// the full form still exists verbatim, just relocated into #vehicle-edit-dialog.
function renderVehicleInfoSummary() {
  const { segment, item } = state.detail;
  const rows = [
    ["VIN", esc(item.vin || "—")],
    ["Mileage", item.mileage ? item.mileage.toLocaleString() : "—"],
    ["Year/Make/Model", esc([item.year, item.make, item.model].filter(Boolean).join(" "))],
    ["Trim", esc(item.trim || "—")],
    ["Color", esc(item.color || "—")],
  ];
  if (segment === "recon") rows.push(["Purchase price", money(item.purchase_price || 0)]);
  $("#vd-vehicle-info-summary").innerHTML = rows.map(([label, value]) => `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value">${value}</span></div>`).join("");
}

function renderDepositsSummary() {
  const { item } = state.detail;
  $("#vd-deposits-summary").innerHTML = `
    <div class="cost-line"><span>Customer paid</span><span class="num">${money(item.customer_paid || 0)}</span></div>
    <div class="cost-line total"><span>Net to shop</span><span class="num">${money(item.net_cost ?? item.total_cost)}</span></div>
  `;
}

function renderPaymentDialogList() {
  const { item } = state.detail;
  const payments = item.payments || [];
  $("#vd-deposits-list").innerHTML = payments.length ? payments.map((p) => `
    <div class="mini-item">
      <div>${money(p.amount)} · ${esc(p.method)} ${p.note ? `— ${esc(p.note)}` : ""}
        <button type="button" class="rm-btn deposit-rm" data-id="${p.id}" title="Remove">×</button>
      </div>
      <div class="mi-meta">${esc(p.actor || "Unspecified")} · ${fmtDate(p.created_at)}</div>
    </div>
  `).join("") : emptyState({ icon: "invoice", title: "No deposits recorded", hint: "Money taken from the customer up front is recorded here and counted against what they owe.", compact: true });
  $$(".deposit-rm", $("#vd-deposits-list")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await confirmAction({
        eyebrow: "DEPOSIT",
        title: "Remove this deposit?",
        body: "The amount stops counting against what the customer owes.",
        confirmLabel: "Remove",
        danger: true,
      }))) return;
      try {
        await api(`/api/we-owe/${item.id}/payments/${btn.dataset.id}`, { method: "DELETE" });
        toast("Deposit removed");
        await loadVehicleDetail();
        renderPaymentDialogList();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// The backend guard (assert_vehicle_editable) is the real enforcement --
// this just keeps the UI from offering an action that would 409 anyway
// once a vehicle is archived to History.
function applyArchivedLockUI(archived) {
  $("#vd-archived-banner").style.display = archived ? "" : "none";
  $("#vd-archive-vehicle").style.display = archived ? "none" : "";
  $("#vd-reopen-vehicle").style.display = archived ? "" : "none";

  // These are static controls reused across renders (unlike the estimate
  // rows, which are rebuilt fresh every time) -- reopening must explicitly
  // re-enable them, not just skip re-disabling, or they'd stay disabled
  // forever once archived once.
  const disableIds = [
    "vd-status-select", "vd-concern", "vd-concern-save",
    "vd-add-job", "vd-add-part", "vd-add-labor", "vd-order-parts",
    "vd-add-note", "vd-note-text",
    "vd-save-assignment", "vd-technician", "vd-advisor",
    "vd-save-timing", "vd-date-in", "vd-odometer", "vd-promised",
    "vd-edit-vehicle", "vd-recon-info-save", "vd-decode-vin", "vd-recon-vin", "vd-recon-mileage", "vd-recon-year",
    "vd-recon-make", "vd-recon-model", "vd-recon-trim", "vd-recon-color", "vd-recon-purchase-price",
    "vd-edit-customer", "vd-we-owe-save", "vd-we-owe-description", "vd-we-owe-category", "vd-we-owe-target", "vd-we-owe-status",
    "vd-take-payment", "vd-deposit-add", "vd-deposit-amount", "vd-deposit-method", "vd-deposit-note",
  ];
  disableIds.forEach((id) => { const el = $(`#${id}`); if (el) el.disabled = archived; });
  $$(".job-control", $("#vd-estimate-items")).forEach((el) => { el.disabled = archived; });
  if (archived) {
    $("#vd-void-order").style.display = "none";
    $("#vd-receive-parts").disabled = true;
  } else {
    updateReceiveButtonState(); // depends on how many checkboxes are checked, not a flat enable
  }
  $$(".part-row:not(.head) input, .part-row:not(.head) select, .part-row:not(.head) .rm-btn", $("#vd-estimate-items")).forEach((el) => {
    // A returned part's Cost field is deliberately locked at 0 regardless of
    // archive state (see rowHtml) -- this loop must not re-enable it.
    if (el.classList.contains("ei-cost") && el.dataset.realCost !== undefined) return;
    el.disabled = archived;
  });
  $$(".part-row:not(.head)", $("#vd-estimate-items")).forEach((row) => row.setAttribute("draggable", String(!archived)));
}

function renderOrderPanel() {
  const order = state.detail.order;
  $("#vd-ro-number").textContent = `Repair Order ${order.number}`;
  renderStatusCard(order);
  renderEstimate(order);
  renderNotes(order);
  renderActivity(order);
  renderAssignment(order);
  $("#vd-print-ticket").style.display = "";
  $("#vd-add-task").style.display = "";
  $("#vd-void-order").style.display = order.voided ? "none" : "";
}

function renderStatusCard(order) {
  const pill = $("#vd-status-pill");
  pill.className = `pill ${STATUS_PILL_CLASS[order.status] || ""}`;
  pill.textContent = order.voided ? "Voided" : (STATUS_LABEL[order.status] || order.status);
  const select = $("#vd-status-select");
  select.innerHTML = STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === order.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
  $("#vd-concern").value = order.concern || "";
}

function renderEstimate(order) {
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  const box = $("#vd-estimate-items");
  box.classList.toggle("has-jobs", jobs.length > 0);
  // A part sent back to the vendor stops costing the shop anything -- every
  // cost total on this ticket (job subtotals, Quoted, Actual) excludes it.
  const notReturned = (i) => !(i.kind === "part" && i.part_returned);

  const jobOptionsHtml = (selectedId) => `<option value="" ${!selectedId ? "selected" : ""}>General</option>` +
    jobs.map((j) => `<option value="${j.id}" ${selectedId === j.id ? "selected" : ""}>${esc(j.title)}</option>`).join("");

  // Every field sits in its own .pr-cell wrapper carrying a data-label. Wide
  // enough and the wrappers are just grid tracks under a column header; once
  // the Parts & Labor container gets narrow (a small window, or the details
  // drawer open beside it) the same markup reflows into a stacked card and
  // the data-label becomes the field's visible caption. Before this, the row
  // was a hardcoded 11-column grid whose header was display:none -- so Qty,
  // Cost and Core were unlabelled boxes that squeezed to a few pixels wide.
  const cell = (cls, label, inner) =>
    `<div class="pr-cell pr-${cls}${inner ? "" : " pr-spacer"}"${label ? ` data-label="${label}"` : ""}>${inner}</div>`;

  const rowHtml = (item, i) => {
    const remaining = (item.quantity ?? 0) - (item.received_quantity ?? 0);
    const receivable = item.kind === "part" && item.id && remaining > 0.001;
    return `
    <div class="part-row" draggable="true" data-index="${i}" data-id="${item.id || ""}" data-source="${item.source || "manual"}" data-received-quantity="${item.received_quantity ?? 0}">
      ${cell("handle", "", `<span class="row-drag-handle" title="Drag to reorder">⋮⋮</span>`)}
      ${cell("check", "", receivable ? `<input type="checkbox" class="ei-receive-check" data-id="${item.id}" title="Select to receive against a vendor invoice">` : "")}
      ${cell("kind", "Kind", `<select class="ei-kind">
        <option value="part" ${item.kind === "part" ? "selected" : ""}>Part</option>
        <option value="labor" ${item.kind === "labor" ? "selected" : ""}>Labor</option>
        <option value="fee" ${item.kind === "fee" ? "selected" : ""}>Fee</option>
      </select>`)}
      ${cell("desc", "Description", `<input class="ei-desc" value="${esc(item.description || "")}" placeholder="Description">`)}
      ${cell("part", "Part #", `<input class="ei-part" value="${esc(item.part_number || "")}" placeholder="Part #">`)}
      ${cell("qty", "Qty", `<input class="ei-qty" type="number" min="0.01" step="0.01" value="${item.quantity ?? 1}">`)}
      ${cell("cost", "Cost", item.part_returned
        ? `<input class="ei-cost" type="number" value="0" disabled title="Returned to the vendor -- no longer counted" data-real-cost="${item.unit_cost ?? 0}">`
        : `<input class="ei-cost" type="number" min="0" step="0.01" value="${item.unit_cost ?? 0}">`)}
      ${cell("core", "Core", item.kind === "part"
        ? `<input class="ei-core" type="number" min="0" step="0.01" placeholder="0.00" title="Core deposit owed back from the vendor" value="${item.core_charge ?? 0}">`
        : "")}
      ${jobs.length ? cell("job", "Job", `<select class="ei-job">${jobOptionsHtml(item.job_id ?? null)}</select>`) : ""}
      ${cell("status", "Status", item.id
        ? (item.status === "received"
            ? `<span class="status-cell">
                 <span class="status-pill ${item.part_returned ? "sp-returned" : "sp-received"}" ${item.received_invoice_number ? `title="Received via invoice ${esc(item.received_invoice_number)}"` : ""}>${item.part_returned ? "Returned" : (item.received_invoice_number ? `Received (${esc(item.received_invoice_number)})` : "Received")}</span>
                 ${item.kind === "part" ? `<button type="button" class="btn btn-ghost btn-xs part-return-btn" data-id="${item.id}" data-returned="${item.part_returned ? 1 : 0}" title="${item.part_returned ? "Undo -- this part was not actually sent back" : "Send this part back to the vendor"}">${item.part_returned ? "Undo" : "Mark Returned"}</button>` : ""}
               </span>`
            : `<select class="ei-status status-pill sp-${item.status || "quoted"}" data-prev="${item.status || "quoted"}">
                 <option value="quoted" ${item.status === "quoted" ? "selected" : ""}>Quoted</option>
                 <option value="ordered" ${item.status === "ordered" ? "selected" : ""}>Ordered</option>
               </select>`)
        : `<span class="status-pill sp-quoted">Saving…</span>`)}
      ${cell("move", "", item.id ? `<button type="button" class="row-move-btn" title="Move to a different ticket" data-id="${item.id}" data-desc="${esc(item.description || "")}">⇄</button>` : "")}
      ${cell("remove", "", `<button type="button" class="rm-btn" title="Remove line">×</button>`)}
    </div>
  `;
  };

  // The header row doubles as each section's caption: inside a job's Parts
  // block the first column reads "Parts" instead of "Kind", so one thin row
  // does the work that a separate section label plus a hidden header row
  // used to do.
  const headRow = (leadLabel = "Kind", extraClass = "") => `<div class="part-row head ${extraClass}">
    <span class="pr-cell pr-handle"></span>
    <span class="pr-cell pr-check"></span>
    <span class="pr-cell pr-kind">${esc(leadLabel)}</span>
    <span class="pr-cell pr-desc">Description</span>
    <span class="pr-cell pr-part">Part #</span>
    <span class="pr-cell pr-qty">Qty</span>
    <span class="pr-cell pr-cost">Cost</span>
    <span class="pr-cell pr-core">Core</span>
    ${jobs.length ? `<span class="pr-cell pr-job">Job</span>` : ""}
    <span class="pr-cell pr-status">Status</span>
    <span class="pr-cell pr-move"></span>
    <span class="pr-cell pr-remove"></span>
  </div>`;

  if (!jobs.length) {
    // Unchanged flat list -- grouping only appears once a job exists, so the
    // common/simple ticket looks exactly as clean as it always has.
    // The .ei-empty wrapper is load-bearing -- adding a line looks for it by
    // that class and removes it rather than re-rendering the whole list.
    box.innerHTML = (items.length ? headRow("Kind", "head-flat") : "") + (items.length ? items.map(rowHtml).join("") : `<div class="ei-empty">${emptyState({
      icon: "invoice",
      title: "No parts or labor yet",
      hint: "Add a part or labor line, or start with ＋ Add Job to group this ticket's work by repair.",
    })}</div>`);
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    box.innerHTML = buckets.map((bucket) => {
      const bucketItems = items.filter((i) => (i.job_id ?? null) === bucket.id);
      const isGeneral = bucket.id === null;
      const jobSubtotal = bucketItems.filter(notReturned).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
      // Parts and labor render as their own mini-sections within the job
      // (Tekmetric-style) rather than one interleaved list, so it's obvious
      // at a glance which lines are parts vs labor for this job -- not just
      // which job a line belongs to.
      const kindGroups = KIND_GROUP_ORDER
        .map((kind) => ({ kind, kindItems: bucketItems.filter((i) => i.kind === kind) }))
        .filter((g) => g.kindItems.length);
      return `
        <div class="job-group" data-job-id="${bucket.id ?? ""}">
          <div class="job-group-head">
            <span class="job-group-title">${esc(bucket.title)}</span>
            ${bucketItems.length ? `<span class="job-group-subtotal">${money(jobSubtotal)}</span>` : ""}
            ${isGeneral ? "" : `
              <select class="ei-job-tech job-control" data-job-id="${bucket.id}">
                <option value="">Use ticket default</option>
                ${state.staff.filter((s) => s.role === "technician").map((t) => `<option value="${t.id}" ${bucket.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
              </select>
              <button type="button" class="job-control job-icon-btn job-edit" data-job-id="${bucket.id}" title="Rename job">✎</button>
              <button type="button" class="job-control job-icon-btn job-delete" data-job-id="${bucket.id}" title="Delete job">×</button>
            `}
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="part">＋ Part</button>
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="labor">＋ Labor</button>
          </div>
          ${kindGroups.length ? kindGroups.map((g) => `
            <div class="kind-subgroup" data-kind="${g.kind}">
              ${headRow(KIND_GROUP_LABEL[g.kind])}
              ${g.kindItems.map(rowHtml).join("")}
            </div>
          `).join("") : `<div class="ei-empty">${emptyState({ icon: "invoice", title: "No lines in this job yet", compact: true })}</div>`}
        </div>
      `;
    }).join("");
  }

  // No listeners are bound here. #vd-estimate-items carries one delegated set
  // of handlers, wired once at startup by wireEstimateGrid(), so a re-render
  // costs exactly one innerHTML swap -- it used to cost twelve
  // addEventListener calls per row plus three more per job, every time any
  // single field changed.
  updateReceiveButtonState();
  renderEstimateTotals(order);
  lastEstimateShape = estimateShape(order);
}

function updateReceiveButtonState() {
  const checked = $$(".ei-receive-check:checked", $("#vd-estimate-items"));
  $("#vd-receive-parts").disabled = checked.length === 0;
}

// Quoted = every line at its full quantity, whether or not it's landed yet
// (matches cost_rollup's quoted_cost); actual = only what's really in the
// car so far -- parts count once received, labor/fees count the moment
// they're logged. Same "at cost" basis as everywhere else (unit_cost, not
// unit_price) -- this panel has never shown customer-facing markup.
// Split out of renderEstimate because an in-place sync has to recompute
// these without touching the rows.
function renderEstimateTotals(order) {
  const items = order.estimate ? order.estimate.items : [];
  const notReturned = (i) => !(i.kind === "part" && i.part_returned);
  const quotedTotal = items.filter(notReturned).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const actualParts = items.filter((i) => i.kind === "part" && !i.part_returned).reduce((s, i) => s + i.received_quantity * i.unit_cost, 0);
  const actualOther = items.filter((i) => i.kind !== "part").reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  $("#vd-quoted-cost").textContent = money(quotedTotal);
  $("#vd-actual-cost").textContent = money(actualParts + actualOther);
}

/* ---------- estimate grid: applying a save without redrawing ----------

   Every field on the grid autosaves on change, and the save round-trips the
   whole estimate. Re-rendering the grid from that response is correct but
   brutal: it blew away the DOM the advisor was standing in, so tabbing
   Description -> Qty put the caret in Qty, fired the save for Description,
   and then the response landed a few hundred ms later and yanked focus back
   out of Qty mid-keystroke. Half-typed numbers went missing that way.

   So: renderEstimate() records a *shape* signature -- everything that decides
   which elements exist and in what order. When a save comes back with the
   same shape (the overwhelmingly common case: you edited a value, not the
   structure), syncEstimateInPlace() writes the server's values into the
   existing controls, skipping whichever one has focus, and nothing is
   destroyed. Only a real structural change (a line added or deleted, a status
   flipped, a job renamed, rows reordered) falls back to a full render -- and
   even then focus is captured and restored around it.

   Deliberately *not* in the signature: description, part number, quantity,
   cost, core. Those live inside inputs the user is editing; they're the
   values a re-render exists to avoid clobbering. */
let lastEstimateShape = null;

function estimateShape(order) {
  const jobs = order.estimate?.jobs ?? [];
  const items = order.estimate?.items ?? [];
  return JSON.stringify([
    jobs.map((j) => [j.id, j.title, j.technician_id ?? null]),
    items.map((i) => [
      i.id ?? null,
      i.kind,
      i.job_id ?? null,
      i.status ?? "quoted",
      i.part_returned ? 1 : 0,
      i.received_invoice_number ?? "",
      // decides whether the receive checkbox cell has a checkbox in it
      i.kind === "part" && i.id && ((i.quantity ?? 0) - (i.received_quantity ?? 0)) > 0.001 ? 1 : 0,
    ]),
  ]);
}

// The single entry point for "the server just gave us a new estimate" --
// cheap path when it can, full render when it must, focus intact either way.
function applyEstimateResponse(order) {
  if (syncEstimateInPlace(order)) return;
  const snap = captureEstimateFocus();
  renderEstimate(order);
  restoreEstimateFocus(snap);
}

function syncEstimateInPlace(order) {
  const box = $("#vd-estimate-items");
  if (!box || lastEstimateShape === null) return false;
  if (estimateShape(order) !== lastEstimateShape) return false;

  const items = order.estimate?.items ?? [];
  const active = document.activeElement;
  for (const item of items) {
    const row = $(`.part-row[data-id="${item.id}"]`, box);
    if (!row) return false; // DOM drifted from what we think we rendered -- redraw
    row.dataset.receivedQuantity = item.received_quantity ?? 0;
    // Never write into the control the user is standing in; that's the whole
    // point of this path.
    const set = (sel, value) => {
      const el = $(sel, row);
      if (!el || el === active) return;
      const next = String(value);
      if (el.value !== next) el.value = next;
    };
    set(".ei-kind", item.kind);
    set(".ei-desc", item.description || "");
    set(".ei-part", item.part_number || "");
    set(".ei-qty", item.quantity ?? 1);
    const costEl = $(".ei-cost", row);
    if (costEl && costEl.dataset.realCost !== undefined) {
      // Returned part: the visible 0 is deliberate, the real number is the attribute.
      costEl.dataset.realCost = String(item.unit_cost ?? 0);
    } else {
      set(".ei-cost", item.unit_cost ?? 0);
    }
    set(".ei-core", item.core_charge ?? 0);
    const jobSel = $(".ei-job", row);
    if (jobSel && jobSel !== active) jobSel.value = item.job_id ?? "";
    const statusSel = $(".ei-status", row);
    if (statusSel) {
      const status = item.status || "quoted";
      if (statusSel !== active) statusSel.value = status;
      statusSel.dataset.prev = status;
      statusSel.className = `ei-status status-pill sp-${status}`;
    }
  }

  // Subtotals key off quantity x cost, which the shape signature ignores on
  // purpose -- so they have to be recomputed here explicitly.
  const notReturned = (i) => !(i.kind === "part" && i.part_returned);
  $$(".job-group", box).forEach((groupEl) => {
    const sub = $(".job-group-subtotal", groupEl);
    if (!sub) return;
    const jobId = groupEl.dataset.jobId === "" ? null : Number(groupEl.dataset.jobId);
    sub.textContent = money(
      items.filter((i) => (i.job_id ?? null) === jobId).filter(notReturned).reduce((s, i) => s + i.quantity * i.unit_cost, 0),
    );
  });
  renderEstimateTotals(order);
  updateReceiveButtonState();
  return true;
}

// Identify the focused control well enough to find it again after the grid is
// rebuilt: by row id when the row survives the round-trip, by position when it
// doesn't (a brand-new row has no id until the server assigns one).
function captureEstimateFocus() {
  const box = $("#vd-estimate-items");
  const el = document.activeElement;
  if (!box || !el || !box.contains(el)) return null;
  const row = el.closest(".part-row");
  const field = [...el.classList].find((c) => c.startsWith("ei-"));
  if (!row || !field) return null;
  const snap = { id: row.dataset.id || "", index: $$(".part-row:not(.head)", box).indexOf(row), field };
  // Number inputs report null here; only text fields carry a caret worth keeping.
  if (typeof el.selectionStart === "number") {
    snap.start = el.selectionStart;
    snap.end = el.selectionEnd;
  }
  return snap;
}

function restoreEstimateFocus(snap) {
  if (!snap) return;
  const box = $("#vd-estimate-items");
  if (!box) return;
  const row = (snap.id && $(`.part-row[data-id="${snap.id}"]`, box)) || $$(".part-row:not(.head)", box)[snap.index];
  const el = row && $(`.${snap.field}`, row);
  if (!el || el.disabled) return;
  el.focus();
  if (typeof snap.start === "number" && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(snap.start, snap.end);
    } catch {
      /* input types that don't support a selection range -- focus is enough */
    }
  }
}

/* ---------- estimate grid: one delegated listener set ----------
   Wired once at startup against #vd-estimate-items, which never gets
   replaced -- only its contents do. Everything the grid renders (rows, job
   headers, the transient row addEstimateRow paints before its save lands) is
   live the instant it exists, and re-rendering binds nothing. */
function wireEstimateGrid() {
  const box = $("#vd-estimate-items");
  if (!box) return;

  box.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    // Every field autosaves on change -- there is no "forgot to click Save and
    // it silently vanished" window, because nothing is ever left DOM-only.
    if (t.matches(".ei-kind, .ei-desc, .ei-part, .ei-qty, .ei-cost, .ei-core, .ei-job")) return void persistEstimate();
    if (t.matches(".ei-receive-check")) return void updateReceiveButtonState();
    if (t.matches(".ei-status")) return void onEstimateStatusChange(t);
    if (t.matches(".ei-job-tech")) return void onJobTechnicianChange(t);
  });

  box.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("button") : null;
    if (!btn || !box.contains(btn)) return;
    if (btn.classList.contains("rm-btn")) return void onEstimateRowRemove(btn);
    if (btn.classList.contains("row-move-btn")) return void onEstimateRowMove(btn);
    if (btn.classList.contains("part-return-btn")) return void onEstimatePartReturn(btn);
    if (btn.classList.contains("job-edit")) return void onJobEdit(btn);
    if (btn.classList.contains("job-delete")) return void onJobDelete(btn);
    if (btn.classList.contains("job-mini-add")) {
      addEstimateRow(btn.dataset.kind, {}, btn.dataset.jobId ? Number(btn.dataset.jobId) : null);
    }
  });

  wireEstimateRowDragging(box);
}

function currentEstimateJob(jobId) {
  return (state.detail.order?.estimate?.jobs ?? []).find((j) => String(j.id) === String(jobId)) || null;
}

async function onEstimateRowRemove(btn) {
  const row = btn.closest(".part-row");
  if (!row) return;
  const desc = row.querySelector(".ei-desc").value.trim();
  if (desc && !(await confirmAction({
    eyebrow: "REMOVE LINE",
    title: `Remove "${desc}"?`,
    body: "It comes off this repair order and stops counting toward its cost.",
    confirmLabel: "Remove Line",
    danger: true,
  }))) return;
  row.remove();
  persistEstimate();
}

function onEstimateRowMove(btn) {
  const order = state.detail.order;
  if (!order) return;
  openMoveItemDialog(order.id, Number(btn.dataset.id), btn.dataset.desc);
}

async function onEstimateStatusChange(sel) {
  const order = state.detail.order;
  const itemId = sel.closest(".part-row")?.dataset.id;
  if (!order || !itemId) return;
  try {
    await patch(`/api/orders/${order.id}/estimate/items/${itemId}/status`, { status: sel.value });
    sel.dataset.prev = sel.value;
    toast("Status updated");
    await loadVehicleDetail();
  } catch (err) {
    sel.value = sel.dataset.prev || "quoted";
    toast(err.message, true);
  }
}

async function onEstimatePartReturn(btn) {
  const order = state.detail.order;
  if (!order) return;
  const returned = btn.dataset.returned !== "1";
  const desc = btn.closest(".part-row").querySelector(".ei-desc").value.trim();
  if (returned && !(await confirmAction({
    eyebrow: "VENDOR RETURN",
    title: `Mark "${desc}" as returned?`,
    body: "Its cost stops counting toward this ticket and it moves onto the returns board.",
    confirmLabel: "Mark Returned",
  }))) return;
  try {
    await patch(`/api/orders/${order.id}/estimate/items/${btn.dataset.id}/part-return`, { returned, actor: currentActor() });
    toast(returned ? "Marked returned" : "Return undone");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onJobTechnicianChange(sel) {
  const order = state.detail.order;
  const job = currentEstimateJob(sel.dataset.jobId);
  if (!order || !job) return;
  try {
    await put(`/api/orders/${order.id}/jobs/${job.id}`, {
      title: job.title,
      technician_id: sel.value ? Number(sel.value) : null,
      actor: currentActor(),
    });
    toast("Job technician updated");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

function onJobEdit(btn) {
  const job = currentEstimateJob(btn.dataset.jobId);
  if (job) openJobDialog(job);
}

async function onJobDelete(btn) {
  const order = state.detail.order;
  if (!order) return;
  const job = currentEstimateJob(btn.dataset.jobId);
  if (!(await confirmAction({
    eyebrow: "DELETE JOB",
    title: `Delete "${job ? job.title : "this job"}"?`,
    body: "Its parts and labor move back to General. No lines are deleted.",
    confirmLabel: "Delete Job",
    danger: true,
  }))) return;
  try {
    await api(`/api/orders/${order.id}/jobs/${btn.dataset.jobId}`, { method: "DELETE" });
    toast("Job deleted");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

// Native HTML5 drag-and-drop: grabbing the row (the visible affordance is the
// ⋮⋮ handle) reorders it among its siblings live as you drag; persistEstimate()
// on drop saves whatever order the DOM ends up in, same as every other estimate
// edit. Delegated from the grid container rather than bound per row, with the
// same-parent check doing what per-group wiring used to do: a row can only be
// dropped among its own group's siblings, because dragging a part into the
// Labor section wouldn't change its kind and would just look wrong. Moving a
// line to a different job or kind is the Job/Kind selects' job.
function wireEstimateRowDragging(box) {
  let dragRow = null;
  box.addEventListener("dragstart", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".part-row:not(.head)") : null;
    if (!row || row.getAttribute("draggable") === "false") return;
    dragRow = row;
    row.classList.add("dragging");
  });
  box.addEventListener("dragend", () => {
    if (!dragRow) return;
    dragRow.classList.remove("dragging");
    dragRow = null;
    persistEstimate();
  });
  box.addEventListener("dragover", (e) => {
    if (!dragRow) return;
    e.preventDefault();
    const row = e.target instanceof Element ? e.target.closest(".part-row:not(.head)") : null;
    if (!row || row === dragRow || row.parentNode !== dragRow.parentNode) return;
    const rect = row.getBoundingClientRect();
    const before = rect.height > 0 && (e.clientY - rect.top) / rect.height < 0.5;
    row.parentNode.insertBefore(dragRow, before ? row : row.nextSibling);
  });
}

function collectEstimateItems() {
  return $$(".part-row:not(.head)", $("#vd-estimate-items")).map((row) => {
    // A returned part's Cost field is shown as 0 on screen so it reads as
    // "no longer counted" -- but the real received cost lives in
    // data-real-cost and must round-trip through every save (persistEstimate
    // resends every row, this one included) or it'd be lost for good, taking
    // the vendor credit amount with it.
    const costInput = row.querySelector(".ei-cost");
    const cost = costInput.dataset.realCost !== undefined
      ? parseFloat(costInput.dataset.realCost)
      : parseFloat(costInput.value || "0");
    const coreInput = row.querySelector(".ei-core");
    const jobSelect = row.querySelector(".ei-job");
    return {
      id: row.dataset.id ? Number(row.dataset.id) : null,
      kind: row.querySelector(".ei-kind").value,
      description: row.querySelector(".ei-desc").value.trim(),
      part_number: row.querySelector(".ei-part").value.trim(),
      quantity: parseFloat(row.querySelector(".ei-qty").value || "1"),
      unit_cost: cost,
      unit_price: cost,
      core_charge: coreInput ? parseFloat(coreInput.value || "0") : 0,
      source: row.dataset.source || "manual",
      // A freshly-added row (addEstimateRow) has no .ei-job select yet --
      // just the data-job-id it was created with -- so fall back to that.
      job_id: jobSelect ? (jobSelect.value ? Number(jobSelect.value) : null) : (row.dataset.jobId ? Number(row.dataset.jobId) : null),
    };
  }).filter((i) => i.description);
}

// Saves the estimate exactly as it currently sits in the DOM, then re-renders
// from the server's response so ids/status controls attach to new rows.
// Called after every add/edit/remove -- an estimate line is never sitting
// unsaved in the browser waiting to be wiped out by an unrelated action
// elsewhere on the page (that was the bug: adding a part, then clicking any
// other Save/Advance/Order-Parts button, reloaded the page and discarded it).
//
// Fast successive edits (tabbing through several fields) fire several of
// these calls in flight at once; an earlier, slower response landing after
// a newer one would overwrite fresher data with stale data. estimateSaveToken
// tags each call so only the most recently *started* one is allowed to render.
let estimateSaveToken = 0;
async function persistEstimate() {
  const order = state.detail.order;
  if (!order) return;
  const items = collectEstimateItems();
  const token = ++estimateSaveToken;
  const expectedVersion = order.estimate ? order.estimate.edit_version : null;
  setEstimateSaveState("saving");
  try {
    const estimate = await post(`/api/orders/${order.id}/estimate`, { labor_rate: 0, tax_rate: 0, actor: currentActor(), items, expected_version: expectedVersion });
    if (token !== estimateSaveToken) return; // a newer edit has already been sent; drop this stale response
    order.estimate = estimate;
    applyEstimateResponse(order);
    setEstimateSaveState("saved");
  } catch (err) {
    if (token === estimateSaveToken) setEstimateSaveState("failed");
    if (String(err.message).includes("Someone else changed")) {
      toast(err.message, true);
      await loadVehicleDetail(); // pull the latest version instead of leaving stale data on screen
      return;
    }
    toast(err.message, true);
  }
}

/* Autosave is invisible by design -- which also means there was no way to tell
   whether the number you just typed actually reached the database, or whether
   the app was simply ignoring you. This is the one bit of feedback: it says
   Saving while a request is in flight, settles to "All changes saved" and
   fades out, and stays put (in red) if the save failed. */
let estimateSaveStateTimer = null;
function setEstimateSaveState(kind) {
  const el = $("#vd-estimate-save-state");
  if (!el) return;
  clearTimeout(estimateSaveStateTimer);
  el.textContent = { saving: "Saving…", saved: "All changes saved", failed: "Not saved" }[kind] || "";
  el.className = `save-state show ${kind}`;
  if (kind === "saved") {
    estimateSaveStateTimer = setTimeout(() => { el.className = "save-state saved"; }, 2200);
  }
}

function addEstimateRow(kind, defaults = {}, jobId = null) {
  const box = $("#vd-estimate-items");
  const targetContainer = box.classList.contains("has-jobs")
    ? ($(`.job-group[data-job-id="${jobId ?? ""}"]`, box) || box)
    : box;
  const empty = $(".ei-empty", targetContainer);
  if (empty) empty.remove();
  const row = document.createElement("div");
  const source = defaults.source || "manual";
  row.className = "part-row";
  row.dataset.id = "";
  row.dataset.source = source;
  row.dataset.jobId = jobId ?? "";
  const label = kind === "labor" ? "Labor" : kind === "fee" ? "Fee" : "Part";
  // Same .pr-cell scaffolding renderEstimate() emits, including the empty
  // spacers -- otherwise this row sits misaligned against the ones around it
  // for the half-second before the save round-trips and re-renders.
  row.innerHTML = `
    <div class="pr-cell pr-handle pr-spacer"></div>
    <div class="pr-cell pr-check pr-spacer"></div>
    <div class="pr-cell pr-kind" data-label="Kind"><select class="ei-kind">
      <option value="part" ${kind === "part" ? "selected" : ""}>Part</option>
      <option value="labor" ${kind === "labor" ? "selected" : ""}>Labor</option>
      <option value="fee" ${kind === "fee" ? "selected" : ""}>Fee</option>
    </select></div>
    <div class="pr-cell pr-desc" data-label="Description"><input class="ei-desc" placeholder="Description" value="${esc(defaults.description || `New ${label.toLowerCase()}`)}"></div>
    <div class="pr-cell pr-part" data-label="Part #"><input class="ei-part" placeholder="Part #" value="${esc(defaults.part_number || "")}"></div>
    <div class="pr-cell pr-qty" data-label="Qty"><input class="ei-qty" type="number" min="0.01" step="0.01" value="${defaults.quantity ?? 1}"></div>
    <div class="pr-cell pr-cost" data-label="Cost"><input class="ei-cost" type="number" min="0" step="0.01" value="${defaults.unit_cost ?? 0}"></div>
    <div class="pr-cell pr-core pr-spacer"></div>
    ${box.classList.contains("has-jobs") ? `<div class="pr-cell pr-job pr-spacer"></div>` : ""}
    <div class="pr-cell pr-status" data-label="Status"><span class="status-pill sp-quoted">Saving…</span></div>
    <div class="pr-cell pr-move pr-spacer"></div>
    <div class="pr-cell pr-remove"><button type="button" class="rm-btn" title="Remove line">×</button></div>
  `;
  // No listener wiring: the delegated handler on #vd-estimate-items already
  // covers this row's × button the moment it lands in the DOM.
  targetContainer.appendChild(row);
  // Persist immediately -- this is a real line on the RO from the moment it
  // appears, matching a one-click "add at cost" flow rather than a draft
  // that silently disappears if the advisor clicks anything else first.
  // New items are always returned last (inserted with the highest id), so
  // the last row after the re-render is the one just added.
  persistEstimate().then(() => {
    const rows = $$(".part-row:not(.head) .ei-desc", box);
    rows[rows.length - 1]?.focus();
    rows[rows.length - 1]?.select();
  });
}

function openJobDialog(job = null) {
  state.detail.editingJobId = job ? job.id : null;
  $("#job-dialog-title").textContent = job ? "Rename Job" : "Add Job";
  $("#job-title-input").value = job ? job.title : "";
  const techs = state.staff.filter((s) => s.role === "technician");
  $("#job-technician-input").innerHTML = `<option value="">Use ticket default</option>` +
    techs.map((t) => `<option value="${t.id}" ${job && job.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#job-dialog").showModal();
}

function wireJobDialog() {
  $("#job-cancel").addEventListener("click", () => $("#job-dialog").close());
  $("#job-cancel-2").addEventListener("click", () => $("#job-dialog").close());
  $("#job-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#job-title-input").value.trim();
    if (!title) return;
    const technicianId = $("#job-technician-input").value ? Number($("#job-technician-input").value) : null;
    const editingId = state.detail.editingJobId;
    try {
      const body = { title, technician_id: technicianId, actor: currentActor() };
      if (editingId) {
        await put(`/api/orders/${state.detail.order.id}/jobs/${editingId}`, body);
      } else {
        await post(`/api/orders/${state.detail.order.id}/jobs`, body);
      }
      $("#job-dialog").close();
      toast(editingId ? "Job updated" : "Job added");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- move a mis-logged line to a different ticket ---------- */
async function openMoveItemDialog(orderId, itemId, desc) {
  state.detail.movingItemId = itemId;
  state.detail.movingFromOrderId = orderId;
  state.detail.movingInvoiceId = null;
  $("#move-item-desc").textContent = `Moving "${desc}" off this ticket.`;
  const select = $("#move-item-target");
  select.innerHTML = `<option value="">Loading…</option>`;
  $("#move-item-invoice-box").style.display = "none";
  $("#move-item-no-invoice-note").style.display = "";
  $("#move-item-reassign-invoice").checked = false;
  $("#move-item-dialog").showModal();
  try {
    const [orders, invoice] = await Promise.all([
      get("/api/orders"),
      get(`/api/orders/${orderId}/estimate/items/${itemId}/received-invoice`),
    ]);
    const options = orders.filter((o) => o.id !== orderId && !o.voided).map((o) => {
      const vehicleLabel = o.stock_number ? `${o.stock_number} · ${o.year} ${o.make} ${o.model}` : `${o.year} ${o.make} ${o.model} · ${o.customer_name}`;
      return `<option value="${o.id}">${esc(o.number)} — ${esc(vehicleLabel)}</option>`;
    }).join("");
    select.innerHTML = options || `<option value="">No other repair orders</option>`;

    if (invoice) {
      state.detail.movingInvoiceId = invoice.invoice_id;
      $("#move-item-invoice-label").textContent = `Also reassign vendor invoice ${invoice.invoice_number} (${invoice.vendor_name}, posted ${fmtDate(invoice.posted_at)}) to this ticket`;
      $("#move-item-invoice-box").style.display = "";
      $("#move-item-no-invoice-note").style.display = "none";
      const warning = $("#move-item-invoice-warning");
      if (invoice.other_item_count > 0) {
        warning.textContent = `⚠ This invoice also covers ${invoice.other_item_count} other part${invoice.other_item_count === 1 ? "" : "s"} still on this ticket — checking this moves ALL of them, not just this one.`;
        warning.style.display = "";
      } else {
        warning.style.display = "none";
      }
    }
  } catch (err) {
    select.innerHTML = `<option value="">Could not load repair orders</option>`;
    toast(err.message, true);
  }
}

function wireMoveItemDialog() {
  $("#move-item-cancel").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-cancel-2").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetOrderId = Number($("#move-item-target").value);
    if (!targetOrderId) return;
    const { movingItemId, movingFromOrderId } = state.detail;
    const reassignInvoice = $("#move-item-reassign-invoice").checked;
    try {
      await patch(`/api/orders/${movingFromOrderId}/estimate/items/${movingItemId}/move`, { target_order_id: targetOrderId, reassign_invoice: reassignInvoice, actor: currentActor() });
      $("#move-item-dialog").close();
      toast("Line moved to the other ticket");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- notes / activity ---------- */
function renderNotes(order) {
  const box = $("#vd-note-list");
  box.innerHTML = order.notes.length ? order.notes.map((n) => `
    <div class="mini-item"><div>${esc(n.text)} <span class="pill" style="background:var(--line-soft);color:var(--ink-faint);text-transform:none;font-weight:600">${n.visibility}</span></div><div class="mi-meta">${esc(n.actor)} · ${fmtDate(n.created_at)}</div></div>
  `).join("") : emptyState({ icon: "idea", title: "No notes yet", hint: "Anything worth remembering about this vehicle -- what the customer said, what you found.", compact: true });
}
function renderActivity(order) {
  const box = $("#vd-activity-list");
  box.innerHTML = order.activity.length ? order.activity.slice().reverse().map((a) => `
    <div class="mini-item"><div>${esc(a.action.replace(/_/g, " "))}</div><div class="mi-meta">${esc(a.actor)} · ${fmtDate(a.created_at)}</div></div>
  `).join("") : emptyState({ icon: "check", title: "No activity yet", hint: "Status changes, assignments, and receipts on this ticket get logged here.", compact: true });
}

/* ---------- assignment ---------- */
function renderAssignment(order) {
  const techs = state.staff.filter((s) => s.role === "technician");
  const advisors = state.staff.filter((s) => s.role === "advisor" || s.role === "manager");
  const a = order.assignment;
  $("#vd-technician").innerHTML = `<option value="">Unassigned</option>` + techs.map((t) => `<option value="${t.id}" ${a && a.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#vd-advisor").innerHTML = `<option value="">Unassigned</option>` + advisors.map((t) => `<option value="${t.id}" ${a && a.advisor_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#vd-date-in").value = (a && a.date_in) || "";
  $("#vd-odometer").value = (a && a.odometer_in) || "";
  $("#vd-promised").value = (a && a.promised_at) || "";
}

/* ---------- print a single ticket ---------- */
// Reuses the same print-only surface and letterhead/table styling the
// Reports view already prints with -- printing a report and printing a
// ticket are mutually exclusive user actions, so sharing the one
// `#print-report` container is simpler than maintaining a second.
function renderPrintTicket() {
  const { segment, item, order } = state.detail;
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const vehicleLabel = segment === "recon"
    ? `${item.stock_number} — ${item.year} ${item.make} ${item.model}`
    : `${item.year} ${item.make} ${item.model}`;
  const customerLabel = segment === "recon" ? "Recon Inventory" : (item.customer_name || "");
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  const quotedTotal = items.filter((i) => !(i.kind === "part" && i.part_returned)).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const actualParts = items.filter((i) => i.kind === "part" && !i.part_returned).reduce((s, i) => s + i.received_quantity * i.unit_cost, 0);
  const actualOther = items.filter((i) => i.kind !== "part").reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const a = order.assignment;
  const techName = (a && a.technician_name) || "Unassigned";
  const advisorName = (a && a.advisor_name) || "Unassigned";

  const itemRow = (i) => `
    <tr><td>${esc(i.kind)}</td><td>${esc(i.description)}</td><td>${esc(i.part_number || "")}</td>
    <td class="num-col">${i.quantity}</td><td class="num-col">${money(i.part_returned ? 0 : i.unit_cost)}</td><td>${esc(i.part_returned ? "Returned" : (STATUS_LABEL[i.status] || i.status || ""))}</td></tr>
  `;

  // Same job/General buckets as the on-screen ticket (renderEstimate) --
  // a printed ticket that's grouped differently than what the advisor was
  // just looking at on screen would be confusing to hand to a technician.
  let rows;
  if (!jobs.length) {
    rows = items.length ? items.map(itemRow).join("") : `<tr><td colspan="6">No parts or labor lines.</td></tr>`;
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    rows = buckets.map((bucket) => {
      const bucketItems = items.filter((i) => (i.job_id ?? null) === bucket.id);
      if (!bucketItems.length) return "";
      const jobTech = bucket.id === null ? "" : (bucket.technician_name || "Use ticket default");
      const jobSubtotal = bucketItems.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
      const kindGroups = KIND_GROUP_ORDER
        .map((kind) => ({ kind, kindItems: bucketItems.filter((i) => i.kind === kind) }))
        .filter((g) => g.kindItems.length);
      return `<tr class="print-job-head"><td colspan="5">${esc(bucket.title)}${jobTech ? ` — ${esc(jobTech)}` : ""}</td><td class="num-col">${money(jobSubtotal)}</td></tr>`
        + kindGroups.map((g) => `<tr class="print-kind-head"><td colspan="6">${KIND_GROUP_LABEL[g.kind]}</td></tr>` + g.kindItems.map(itemRow).join("")).join("");
    }).join("") || `<tr><td colspan="6">No parts or labor lines.</td></tr>`;
  }

  const notesHtml = (order.notes || []).length
    ? order.notes.map((n) => `<div>${esc(n.text)} <span style="color:#666">(${esc(n.visibility)})</span></div>`).join("")
    : "<div>No notes.</div>";

  $("#print-report").innerHTML = `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">RECON</div>
        <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
      </div>
      <div class="print-meta">
        <div class="print-report-title">Repair Order ${esc(order.number)}</div>
        <div>${esc(vehicleLabel)}${customerLabel ? " — " + esc(customerLabel) : ""}</div>
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    <table class="print-table">
      <thead><tr><th>Status</th><th>Technician</th><th>Advisor</th><th>Concern</th></tr></thead>
      <tbody><tr><td>${esc(STATUS_LABEL[order.status] || order.status)}</td><td>${esc(techName)}</td><td>${esc(advisorName)}</td><td>${esc(order.concern)}</td></tr></tbody>
    </table>
    <div class="print-subhead" style="margin:16px 0 6px">Parts &amp; Labor</div>
    <table class="print-table">
      <thead><tr><th>Kind</th><th>Description</th><th>Part #</th><th class="num-col">Qty</th><th class="num-col">Cost</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="subtotal"><td colspan="4">Total Quote</td><td class="num-col">${money(quotedTotal)}</td><td></td></tr>
        <tr><td colspan="4">Actual Cost</td><td class="num-col">${money(actualParts + actualOther)}</td><td></td></tr>
      </tfoot>
    </table>
    <div class="print-subhead" style="margin:16px 0 6px">Notes</div>
    <div class="print-notes">${notesHtml}</div>
  `;
}

/* ---------- vehicle-detail event wiring (wired once) ---------- */
function wireVehicleDetail() {
  $("#back-to-vehicles").addEventListener("click", () => showView("vehicles"));

  $("#vd-start-ro").addEventListener("click", async () => {
    const concern = $("#vd-new-ro-concern").value.trim();
    if (!concern) return toast("Describe what's being done first", true);
    const { segment, id } = state.detail;
    const payload = { concern, segment, customer_id: null, vehicle_id: null };
    if (segment === "recon") payload.recon_vehicle_id = id;
    else payload.we_owe_id = id;
    try {
      await post("/api/orders", payload);
      $("#vd-new-ro-concern").value = "";
      toast("Repair order started");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-status-select").addEventListener("change", async (e) => {
    const select = e.target;
    const status = select.value;
    select.disabled = true;
    try {
      await patch(`/api/orders/${state.detail.order.id}/status`, { status, actor: currentActor() });
      toast(`Status set to ${STATUS_LABEL[status]}`);
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      select.disabled = false;
    }
  });

  $("#vd-concern-save").addEventListener("click", async (e) => {
    const concern = $("#vd-concern").value.trim();
    if (!concern) return toast("Concern can't be empty", true);
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/orders/${state.detail.order.id}/concern`, { concern, actor: currentActor() });
        toast("Concern updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-print-ticket").addEventListener("click", () => {
    renderPrintTicket();
    window.print();
  });

  // Jumps to Tasks with this order pre-selected in the link dropdown, rather
  // than making the advisor reopen the picker and hunt for the RO they were
  // just looking at.
  $("#vd-add-task").addEventListener("click", async () => {
    const order = state.detail.order;
    showView("tasks");
    await loadTasksView();
    if ($$("#task-order-input option").some((o) => o.value === String(order.id))) {
      $("#task-order-input").value = String(order.id);
    }
    $("#task-title-input").focus();
  });

  $("#vd-archive-vehicle").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    if (!(await confirmAction({
      eyebrow: "ARCHIVE",
      title: "Send this vehicle to History?",
      body: "It becomes read-only until reopened. Nothing is deleted.",
      confirmLabel: "Send to History",
    }))) return;
    try {
      await post(segment === "recon" ? `/api/recon/vehicles/${id}/archive` : `/api/we-owe/${id}/archive`, { expected_version: item.edit_version });
      toast("Sent to History");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
    }
  });

  $("#vd-reopen-vehicle").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    try {
      await post(segment === "recon" ? `/api/recon/vehicles/${id}/reopen` : `/api/we-owe/${id}/reopen`, { expected_version: item.edit_version });
      toast("Reopened -- fully editable again");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
    }
  });

  $("#vd-void-order").addEventListener("click", async () => {
    if (!(await confirmAction({
      eyebrow: "VOID TICKET",
      title: "Void this repair order?",
      body: "Its cost stops counting toward the vehicle's total. This can't be undone.",
      confirmLabel: "Void Ticket",
      danger: true,
    }))) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/void`, { actor: currentActor() });
      toast("Ticket voided");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-add-part").addEventListener("click", () => addEstimateRow("part"));
  $("#vd-add-labor").addEventListener("click", () => addEstimateRow("labor"));

  $("#vd-order-parts").addEventListener("click", async () => {
    try {
      const res = await patch(`/api/orders/${state.detail.order.id}/estimate/order-parts`);
      toast(res.updated ? `${res.updated} part line(s) marked ordered` : "No quoted parts to order");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-receive-parts").addEventListener("click", () => openReceiveDialog());

  const addNote = async () => {
    const text = $("#vd-note-text").value.trim();
    if (!text) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/notes`, { text, visibility: $("#vd-note-visibility").value, actor: currentActor() });
      $("#vd-note-text").value = "";
      toast("Note added");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#vd-add-note").addEventListener("click", addNote);
  $("#vd-note-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNote(); }
  });

  const saveAssignment = async (e) => {
    await withLoading(e.target, "Saving…", async () => {
      try {
        await put(`/api/orders/${state.detail.order.id}/assignment`, {
          advisor_id: $("#vd-advisor").value ? Number($("#vd-advisor").value) : null,
          technician_id: $("#vd-technician").value ? Number($("#vd-technician").value) : null,
          date_in: $("#vd-date-in").value,
          odometer_in: Number($("#vd-odometer").value || 0),
          promised_at: $("#vd-promised").value,
          actor: currentActor(),
        });
        toast("Saved");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };
  $("#vd-save-assignment").addEventListener("click", saveAssignment);
  $("#vd-save-timing").addEventListener("click", saveAssignment);

  $("#vd-we-owe-save").addEventListener("click", async (e) => {
    const { id, item } = state.detail;
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/we-owe/${id}`, {
          status: $("#vd-we-owe-status").value,
          description: $("#vd-we-owe-description").value.trim(),
          category: $("#vd-we-owe-category").value.trim(),
          target_date: $("#vd-we-owe-target").value,
          expected_version: item.edit_version,
        });
        toast("We-owe item updated");
        await loadVehicleDetail();
      } catch (err) {
        if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
        toast(err.message, true);
      }
    });
  });

  $("#vd-deposit-add").addEventListener("click", async (e) => {
    const { id } = state.detail;
    const amount = Number($("#vd-deposit-amount").value || 0);
    if (!amount || amount <= 0) return toast("Enter a deposit amount first", true);
    await withLoading(e.target, "Saving…", async () => {
      try {
        await post(`/api/we-owe/${id}/payments`, {
          amount,
          method: $("#vd-deposit-method").value,
          note: $("#vd-deposit-note").value.trim(),
          actor: currentActor(),
        });
        $("#vd-deposit-amount").value = "";
        $("#vd-deposit-note").value = "";
        toast("Deposit recorded");
        await loadVehicleDetail();
        renderPaymentDialogList();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-take-payment").addEventListener("click", () => {
    renderPaymentDialogList();
    $("#payment-dialog").showModal();
  });
  $("#payment-cancel").addEventListener("click", () => $("#payment-dialog").close());
  $("#payment-cancel-2").addEventListener("click", () => $("#payment-dialog").close());

  $("#vd-edit-vehicle").addEventListener("click", () => $("#vehicle-edit-dialog").showModal());
  $("#vehicle-edit-cancel").addEventListener("click", () => $("#vehicle-edit-dialog").close());
  $("#vehicle-edit-cancel-2").addEventListener("click", () => $("#vehicle-edit-dialog").close());

  $("#vd-edit-customer").addEventListener("click", () => {
    const { item } = state.detail;
    $("#customer-edit-name").value = item.customer_name || "";
    $("#customer-edit-phone").value = item.customer_phone || "";
    $("#customer-edit-email").value = item.customer_email || "";
    $("#customer-edit-dialog").showModal();
  });
  $("#customer-edit-cancel").addEventListener("click", () => $("#customer-edit-dialog").close());
  $("#customer-edit-cancel-2").addEventListener("click", () => $("#customer-edit-dialog").close());
  $("#customer-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { item } = state.detail;
    try {
      await patch(`/api/customers/${item.customer_id}`, {
        name: $("#customer-edit-name").value.trim(),
        phone: $("#customer-edit-phone").value.trim(),
        email: $("#customer-edit-email").value.trim(),
      });
      $("#customer-edit-dialog").close();
      toast("Customer updated");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vehicle-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { segment, id, item } = state.detail;
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        const payload = {
          vin: $("#vd-recon-vin").value.trim(),
          mileage: Number($("#vd-recon-mileage").value || 0),
          year: Number($("#vd-recon-year").value),
          make: $("#vd-recon-make").value.trim(),
          model: $("#vd-recon-model").value.trim(),
          trim: $("#vd-recon-trim").value.trim(),
          color: $("#vd-recon-color").value.trim(),
          expected_version: item.edit_version,
        };
        if (segment === "recon") {
          payload.purchase_price = Number($("#vd-recon-purchase-price").value || 0);
          await patch(`/api/recon/vehicles/${id}`, payload);
        } else {
          await patch(`/api/we-owe/${id}`, payload);
        }
        toast("Vehicle info updated");
        $("#vehicle-edit-dialog").close();
        await loadVehicleDetail();
      } catch (err) {
        if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
        toast(err.message, true);
      }
    });
  });

  $("#vd-add-job").addEventListener("click", () => openJobDialog());

  $("#vd-decode-vin").addEventListener("click", async () => {
    const vin = $("#vd-recon-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#vd-recon-year").value = data.year;
      $("#vd-recon-make").value = data.make;
      $("#vd-recon-model").value = data.model;
      $("#vd-recon-trim").value = data.trim;
      toast("VIN decoded — click Save to keep it");
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-delete").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    const label = segment === "recon" ? item.stock_number : `${item.year} ${item.make} ${item.model}`;
    if (!(await confirmAction({
      eyebrow: "DELETE",
      title: `Delete ${label}?`,
      body: "The vehicle, its repair order, and everything on it are removed permanently. This can't be undone -- send it to History instead if you only want it off the board.",
      confirmLabel: "Delete Permanently",
      danger: true,
    }))) return;
    try {
      await api(segment === "recon" ? `/api/recon/vehicles/${id}` : `/api/we-owe/${id}`, { method: "DELETE" });
      toast("Deleted");
      showView("vehicles");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ==================================================================
   NEW RECON VEHICLE DIALOG
   ================================================================== */
function openReconDialog() {
  $("#recon-form").reset();
  $("#recon-year").value = new Date().getFullYear();
  $("#recon-date").value = new Date().toISOString().slice(0, 10);
  $("#recon-dialog").showModal();
}
function wireReconDialog() {
  $("#recon-cancel").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-cancel-2").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-decode-vin").addEventListener("click", async () => {
    const vin = $("#recon-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      toast("VIN decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#recon-decode-plate").addEventListener("click", async () => {
    const plate = $("#recon-plate").value.trim();
    const state_ = $("#recon-plate-state").value.trim();
    if (!plate || !state_) return toast("Enter plate and state first", true);
    try {
      const data = await post("/api/vehicles/decode-plate", { plate, state: state_ });
      $("#recon-vin").value = data.vin;
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      $("#recon-color").value = data.color;
      toast("Plate decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#recon-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        await post("/api/recon/vehicles", {
          stock_number: $("#recon-stock").value.trim(),
          vin: $("#recon-vin").value.trim(),
          year: Number($("#recon-year").value),
          make: $("#recon-make").value.trim(),
          model: $("#recon-model").value.trim(),
          trim: $("#recon-trim").value.trim(),
          engine: $("#recon-engine").value.trim(),
          color: $("#recon-color").value.trim(),
          mileage: Number($("#recon-mileage").value || 0),
          purchase_price: Number($("#recon-price").value || 0),
          acquisition_source: $("#recon-source").value.trim(),
          acquisition_date: $("#recon-date").value,
          notes: $("#recon-notes").value.trim(),
        });
        $("#recon-dialog").close();
        toast("Recon vehicle added");
        loadVehiclesView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   NEW WE-OWE DIALOG
   ================================================================== */
async function openWeOweDialog() {
  $("#we-owe-form").reset();
  $("#we-owe-new-year").value = new Date().getFullYear();
  try {
    const customers = await get("/api/customers");
    $("#we-owe-customer").innerHTML = `<option value="__new__">＋ New customer…</option>` + customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    // The select always defaults to its first option ("__new__") on open --
    // show the matching fields instead of hardcoding them hidden.
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
    await refreshWeOweVehicleOptions();
    $("#we-owe-dialog").showModal();
  } catch (err) {
    // Without this, a failed customer-list fetch left the button looking
    // like it silently did nothing -- no dialog, no toast, no clue why.
    toast(`Could not open the We-Owe dialog: ${err.message}`, true);
  }
}
async function refreshWeOweVehicleOptions() {
  const customerId = $("#we-owe-customer").value;
  const select = $("#we-owe-vehicle");
  try {
    if (customerId === "__new__" || !customerId) {
      select.innerHTML = `<option value="__new__">＋ New vehicle…</option>`;
    } else {
      const vehicles = await get("/api/vehicles");
      const owned = vehicles.filter((v) => v.customer_id === Number(customerId));
      select.innerHTML = `<option value="__new__">＋ New vehicle…</option>` + owned.map((v) => `<option value="${v.id}">${v.year} ${esc(v.make)} ${esc(v.model)}</option>`).join("");
    }
  } catch (err) {
    toast(`Could not load this customer's vehicles: ${err.message}`, true);
    select.innerHTML = `<option value="__new__">＋ New vehicle…</option>`;
  }
  // Rebuilding the options resets the select's value to "__new__" (its
  // first option) without firing a change event -- without this, the
  // fields to actually type the new vehicle stay hidden.
  $("#we-owe-new-vehicle").style.display = select.value === "__new__" ? "" : "none";
}
function wireWeOweDialog() {
  $("#we-owe-cancel").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-cancel-2").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-customer").addEventListener("change", async () => {
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
    await refreshWeOweVehicleOptions();
  });
  $("#we-owe-vehicle").addEventListener("change", () => {
    $("#we-owe-new-vehicle").style.display = $("#we-owe-vehicle").value === "__new__" ? "" : "none";
  });
  $("#we-owe-decode-vin").addEventListener("click", async () => {
    const vin = $("#we-owe-new-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#we-owe-new-year").value = data.year;
      $("#we-owe-new-make").value = data.make;
      $("#we-owe-new-model").value = data.model;
      toast("VIN decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#we-owe-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        let customerId = $("#we-owe-customer").value;
        if (customerId === "__new__") {
          const name = $("#we-owe-new-customer-name").value.trim();
          if (!name) return toast("Enter the customer's name", true);
          const customer = await post("/api/customers", { name, phone: $("#we-owe-new-customer-phone").value.trim(), email: "" });
          customerId = customer.id;
        } else {
          customerId = Number(customerId);
        }
        let vehicleId = $("#we-owe-vehicle").value;
        if (vehicleId === "__new__") {
          const make = $("#we-owe-new-make").value.trim();
          const model = $("#we-owe-new-model").value.trim();
          if (!make || !model) return toast("Enter the vehicle's make and model", true);
          const vehicle = await post("/api/vehicles", {
            customer_id: customerId,
            year: Number($("#we-owe-new-year").value),
            make, model,
            vin: $("#we-owe-new-vin").value.trim(),
          });
          vehicleId = vehicle.id;
        } else {
          vehicleId = Number(vehicleId);
        }
        await post("/api/we-owe", {
          customer_id: customerId,
          vehicle_id: vehicleId,
          description: $("#we-owe-description").value.trim(),
          category: $("#we-owe-category").value.trim() || "other",
          target_date: $("#we-owe-target").value,
          sale_reference: $("#we-owe-sale-ref").value.trim(),
          lot_stock_number: $("#we-owe-lot-stock").value.trim(),
        });
        $("#we-owe-dialog").close();
        toast("We-owe item added");
        loadVehiclesView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   RECEIVE PARTS DIALOG
   ================================================================== */
async function openReceiveDialog() {
  const box = $("#vd-estimate-items");
  const checked = $$(".ei-receive-check:checked", box);
  if (!checked.length) return;
  const lines = checked.map((cb) => {
    const row = cb.closest(".part-row");
    const desc = row.querySelector(".ei-desc").value.trim() || "(no description)";
    const qty = parseFloat(row.querySelector(".ei-qty").value || "0");
    const receivedQty = Number(row.dataset.receivedQuantity || 0);
    const remaining = qty - receivedQty;
    const cost = parseFloat(row.querySelector(".ei-cost").value || "0");
    return { id: Number(cb.dataset.id), desc, remaining, cost };
  });
  state.receiveLines = lines;

  $("#receive-lines").innerHTML = lines.map((l) => `
    <div class="kv-row"><span class="kv-label">${esc(l.desc)}</span><span class="kv-value">${l.remaining} × ${money(l.cost)}</span></div>
  `).join("");
  updateReceiveTotalSummary();

  const vendors = await get("/api/vendors").catch(() => []);
  state.vendors = vendors;
  $("#receive-vendor").innerHTML = `<option value="__new__">＋ New vendor…</option>` + vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("");
  $("#receive-new-vendor").style.display = vendors.length ? "none" : "";
  $("#receive-invoice-number").value = "";
  $("#receive-new-vendor-name").value = "";
  $("#receive-tax").value = "0";
  $("#receive-dialog").showModal();
}

function updateReceiveTotalSummary() {
  const lines = state.receiveLines || [];
  const tax = parseFloat($("#receive-tax")?.value || "0");
  const subtotal = lines.reduce((s, l) => s + l.remaining * l.cost, 0);
  $("#receive-total-summary").innerHTML = `
    <div class="cost-line"><span>Subtotal</span><span class="num">${money(subtotal)}</span></div>
    <div class="cost-line total"><span>Total</span><span class="num">${money(subtotal + tax)}</span></div>
  `;
}

function wireReceiveDialog() {
  $("#receive-cancel").addEventListener("click", () => $("#receive-dialog").close());
  $("#receive-cancel-2").addEventListener("click", () => $("#receive-dialog").close());
  $("#receive-vendor").addEventListener("change", () => {
    $("#receive-new-vendor").style.display = $("#receive-vendor").value === "__new__" ? "" : "none";
  });
  $("#receive-tax").addEventListener("input", updateReceiveTotalSummary);
  $("#receive-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        let vendorId = $("#receive-vendor").value;
        if (vendorId === "__new__") {
          const name = $("#receive-new-vendor-name").value.trim();
          if (!name) return toast("Enter the vendor's name", true);
          const vendor = await post("/api/vendors", { name });
          vendorId = vendor.id;
        } else {
          vendorId = Number(vendorId);
        }
        const invoiceNumber = $("#receive-invoice-number").value.trim();
        if (!invoiceNumber) return toast("Enter an invoice number", true);
        await post(`/api/orders/${state.detail.order.id}/estimate/receive-parts`, {
          item_ids: (state.receiveLines || []).map((l) => l.id),
          vendor_id: vendorId,
          invoice_number: invoiceNumber,
          tax: parseFloat($("#receive-tax").value || "0"),
          actor: currentActor(),
        });
        $("#receive-dialog").close();
        toast("Parts received and posted to A/P");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   REPORTS
   ================================================================== */
// Shared quick-range date math -- used by the Reports date filter and the
// A/P invoice list filter alike, so "This Week"/"This Month"/etc. mean the
// same thing everywhere in the app.
function computeQuickRange(kind) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  let start, end = iso(now);
  if (kind === "today") start = iso(now);
  else if (kind === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); start = iso(d); end = iso(d); }
  else if (kind === "week") { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); start = iso(d); }
  else if (kind === "month") start = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (kind === "year" || kind === "ytd") start = iso(new Date(now.getFullYear(), 0, 1));
  else { start = ""; end = ""; }
  return { start, end };
}

/* ---------- what the four reports are ----------
   Everything that differs between them -- the title, which segment of the
   board they cover, which endpoint backs them -- is declared once here.
   Two shapes underneath: a per-vehicle spend table and a per-technician
   productivity table. */
const REPORT_TITLES = {
  "vehicle-spend": "All Vehicles (Combined)",
  "vehicle-spend-recon": "Recon Vehicles Only",
  "vehicle-spend-we_owe": "We-Owe Only",
  technicians: "Technician Productivity",
};

const REPORT_SEGMENT = {
  "vehicle-spend-recon": "recon",
  "vehicle-spend-we_owe": "we_owe",
};

// The two table/chart/summary shapes. Four report types, two renderings.
const reportShape = (type) => (type === "technicians" ? "technicians" : "vehicle-spend");

const REPORT_PREFS_KEY = "dao-report-view";

function loadReportPrefs() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(REPORT_PREFS_KEY) || "{}");
  } catch {
    return; // a corrupt entry shouldn't stop the screen from opening
  }
  if (!saved || typeof saved !== "object") return;
  if (REPORT_TITLES[saved.type]) state.reportType = saved.type;
  if (typeof saved.range === "string") state.reportRange = saved.range;
  if (typeof saved.start === "string") state.reportStart = saved.start;
  if (typeof saved.end === "string") state.reportEnd = saved.end;
  if (saved.sort && REPORT_SORTS[reportShape(state.reportType)][saved.sort.key]) {
    state.reportSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
  }
}

function saveReportPrefs() {
  try {
    localStorage.setItem(REPORT_PREFS_KEY, JSON.stringify({
      type: state.reportType, range: state.reportRange,
      start: state.reportStart, end: state.reportEnd, sort: state.reportSort,
    }));
  } catch { /* private mode / quota -- the screen still works, it just forgets */ }
}

/* ---------- range ---------- */

// Applying a quick range writes the two date inputs as well as state, so the
// From/To fields always show what's actually being reported on -- the old
// version left them blank whenever the range came from anywhere but a click.
function setReportRange(kind) {
  const { start, end } = computeQuickRange(kind);
  state.reportRange = kind;
  state.reportStart = start;
  state.reportEnd = end;
}

// Hand-edited dates stop matching any chip, so no chip stays lit claiming a
// range that isn't in effect.
function readReportDateInputs() {
  state.reportStart = $("#report-start").value || "";
  state.reportEnd = $("#report-end").value || "";
  const match = ["today", "week", "month", "year", "all"].find((kind) => {
    const r = computeQuickRange(kind);
    return r.start === state.reportStart && r.end === state.reportEnd;
  });
  state.reportRange = match || "";
}

function syncReportControls() {
  $$("#report-type-seg .seg-btn").forEach((btn) => {
    const on = btn.dataset.reportType === state.reportType;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  $$("#view-reports .chip[data-report-range]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.reportRange === state.reportRange);
  });
  $("#report-start").value = state.reportStart;
  $("#report-end").value = state.reportEnd;
}

function reportParams() {
  const params = new URLSearchParams();
  if (state.reportStart) params.set("start", state.reportStart);
  if (state.reportEnd) params.set("end", state.reportEnd);
  const segment = REPORT_SEGMENT[state.reportType];
  if (segment) params.set("segment", segment);
  return params;
}

// The CSV comes from the server rather than being stitched together in the
// browser, so it carries the same numbers the report does even for a range
// nobody has clicked Generate on, and so it stays correct if the rollup
// changes on the back end.
function reportCsvHref() {
  const params = reportParams();
  const path = reportShape(state.reportType) === "technicians" ? "technicians" : "vehicle-spend";
  const query = params.toString();
  return `/api/export/report/${path}.csv${query ? `?${query}` : ""}`;
}

/* ---------- sorting ---------- */

const REPORT_SORTS = {
  "vehicle-spend": {
    // What the cell shows, not what the row knows: a we-owe row displays a
    // dash here (its customer is in the Vehicle column), so sorting it by
    // the hidden customer name would scatter the dashes through the list
    // instead of collecting them at the end. Same rule the board uses.
    stock:   { label: "Stock #",       type: "text",   value: (r) => r.stock_number || "" },
    vehicle: { label: "Vehicle",       type: "text",   value: (r) => r.vehicle || "" },
    segment: { label: "Type",          type: "text",   value: (r) => (r.segment === "recon" ? "Recon" : "We-Owe") },
    status:  { label: "Status",        type: "text",   value: (r) => STATUS_LABEL[r.status] || r.status || "" },
    tech:    { label: "Technicians",   type: "text",   value: (r) => (r.technicians || []).join(", ") },
    cost:    { label: "Cost",          type: "number", value: (r) => r.actual_cost },
    paid:    { label: "Customer Paid", type: "number", value: (r) => r.customer_paid || 0 },
    net:     { label: "Net to Shop",   type: "number", value: (r) => (r.customer_paid ? r.net_cost : r.actual_cost) },
  },
  technicians: {
    technician: { label: "Technician",  type: "text",   value: (r) => r.technician || "" },
    ros:        { label: "ROs",         type: "number", value: (r) => r.ro_count },
    completed:  { label: "Completed",   type: "number", value: (r) => r.completed_count },
    hours:      { label: "Labor Hours", type: "number", value: (r) => r.labor_hours },
    cost:       { label: "Labor Cost",  type: "number", value: (r) => r.labor_cost },
  },
};

function sortReportRows(rows, shape, { key, dir }) {
  const spec = REPORT_SORTS[shape][key];
  if (!spec) return rows;
  const sign = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = spec.value(a), bv = spec.value(b);
    if (spec.type === "number") return ((av || 0) - (bv || 0)) * sign;
    if (!av && !bv) return 0;
    if (!av) return 1;   // blanks last in both directions, same as the board
    if (!bv) return -1;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * sign;
  });
}

// The rows as the screen is currently showing them -- what print and any
// row-order-sensitive rendering should use, so the paper copy matches what
// was on screen when Print was pressed.
function visibleReportRows() {
  if (!state.report) return [];
  return sortReportRows(state.report.rows, reportShape(state.report.type), state.reportSort);
}

function reportSortHeader(shape, key, extraClass = "") {
  const spec = REPORT_SORTS[shape][key];
  const active = state.reportSort.key === key;
  const arrow = active ? (state.reportSort.dir === "desc" ? "▼" : "▲") : "";
  const cls = ["sortable", extraClass, active ? "sorted" : ""].filter(Boolean).join(" ");
  return `<th class="${cls}" data-report-sort="${key}" aria-sort="${active ? (state.reportSort.dir === "asc" ? "ascending" : "descending") : "none"}"
    title="Sort by ${esc(spec.label)} (${active && state.reportSort.dir === "desc" ? "ascending" : "descending"})">${esc(spec.label)} <span class="sort-arrow">${arrow}</span></th>`;
}

/* ---------- summary cards ----------
   The four numbers a manager reads a spend report for, above the table
   rather than buried in its footer. They describe exactly the rows below
   them -- same range, same segment -- so there's nothing to reconcile. */
function renderReportStats(rows, shape) {
  const cards = shape === "technicians" ? technicianStatCards(rows) : vehicleSpendStatCards(rows);
  $("#report-stats").innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="stat-label">${esc(c.label)}</div>
      <div class="stat-value${c.tone ? ` ${c.tone}` : ""}">${esc(c.value)}</div>
      <div class="stat-sub">${esc(c.sub)}</div>
    </div>`).join("");
}

// A car counts as over quote on the same >10% rule the board colors Cost
// with, so the two screens can't disagree about which cars are running hot.
// This was a second copy of that rule, differing from the board's in whether
// it tested actual_cost -- the two happened to agree, but only by accident,
// and the comment above was claiming a guarantee nothing enforced. Report
// rows carry the same quoted_cost/actual_cost fields board rows do, so they
// go through the same predicate now.
const overQuote = isOverQuote;

function vehicleSpendStatCards(rows) {
  const recon = rows.filter((r) => r.segment === "recon").length;
  const total = rows.reduce((s, r) => s + r.actual_cost, 0);
  const quoted = rows.reduce((s, r) => s + (r.quoted_cost || 0), 0);
  const over = rows.filter(overQuote);
  const overBy = over.reduce((s, r) => s + (r.actual_cost - r.quoted_cost), 0);
  return [
    { label: "Vehicles", value: String(rows.length), sub: `${recon} recon · ${rows.length - recon} we-owe` },
    { label: "Total Cost", value: money(total), sub: "received parts + labor" },
    { label: "Average Per Vehicle", value: money(rows.length ? total / rows.length : 0), sub: quoted ? `${money(quoted)} quoted overall` : "nothing quoted in this range" },
    {
      label: "Over Quote", value: String(over.length), tone: over.length ? "warn" : "",
      sub: over.length ? `${money(overBy)} past estimate` : "every quoted car came in on budget",
    },
  ];
}

function technicianStatCards(rows) {
  const active = rows.filter((r) => r.ro_count > 0);
  const ros = rows.reduce((s, r) => s + r.ro_count, 0);
  const done = rows.reduce((s, r) => s + r.completed_count, 0);
  const hours = rows.reduce((s, r) => s + r.labor_hours, 0);
  const cost = rows.reduce((s, r) => s + r.labor_cost, 0);
  return [
    { label: "Technicians Working", value: String(active.length), sub: `of ${rows.length} on staff` },
    { label: "Repair Orders", value: String(ros), sub: `${done} completed${ros ? ` · ${Math.round((done / ros) * 100)}%` : ""}` },
    { label: "Labor Hours", value: String(Math.round(hours * 10) / 10), sub: ros ? `${(hours / ros).toFixed(1)} avg per RO` : "no orders in this range" },
    { label: "Labor Cost", value: money(cost), sub: hours ? `${money(cost / hours)} per hour` : "no hours logged" },
  ];
}

/* ---------- chart ----------
   Horizontal bars built from plain elements rather than a charting library:
   nothing to load, it inherits the theme's colors for free, and it reflows
   with the panel instead of needing a resize observer. */
// Nothing to plot is not the same as nothing to report: early in a month
// every car on the list can legitimately be sitting at $0 (parts ordered,
// nothing received). Dropping the panel silently reads like the chart broke,
// so it says which of the two it is.
function chartNothingToPlot(hasRows, what) {
  if (!hasRows) return "";
  return `<div class="panel chart-panel chart-empty">${esc(`No ${what} to chart in this range yet.`)}</div>`;
}

// rowAttrs/rowClass let a caller make the bars interactive (the board's idle
// chart turns each one into a filter button) without every other chart having
// to know about it -- both default to nothing, so Reports is unchanged.
function barChart({ title, note, legend = "", items, rowAttrs = null, rowClass = null }) {
  if (!items.length) return "";
  const max = Math.max(...items.map((i) => Math.max(i.value || 0, i.marker || 0)));
  const pct = (n) => (max > 0 ? Math.min((n / max) * 100, 100) : 0);
  const bars = items.map((i) => `
    <li class="bar-row ${rowClass ? rowClass(i) : ""}" ${rowAttrs ? rowAttrs(i) : ""}>
      <span class="bar-label" title="${esc(i.label)}">${esc(i.label)}</span>
      <span class="bar-track">
        <span class="bar-fill${i.tone ? ` ${i.tone}` : ""}" style="width:${pct(i.value).toFixed(2)}%"></span>
        ${i.marker > 0 ? `<span class="bar-marker" style="left:${pct(i.marker).toFixed(2)}%" title="${esc(i.markerLabel || "")}"></span>` : ""}
      </span>
      <span class="bar-value">${esc(i.display)}</span>
    </li>`).join("");
  return `<div class="panel chart-panel">
    <div class="chart-head">
      <h3 class="chart-title">${esc(title)}</h3>
      ${note ? `<span class="chart-note">${esc(note)}</span>` : ""}
    </div>
    <ul class="bar-chart">${bars}</ul>
    ${legend ? `<div class="chart-legend">${legend}</div>` : ""}
  </div>`;
}

const CHART_LIMIT = 12;

function renderReportChart(rows, shape) {
  const target = $("#report-chart");
  if (shape === "technicians") {
    const items = rows.filter((r) => r.labor_cost > 0)
      .sort((a, b) => b.labor_cost - a.labor_cost)
      .slice(0, CHART_LIMIT)
      .map((r) => ({ label: r.technician, value: r.labor_cost, display: money(r.labor_cost) }));
    target.innerHTML = barChart({
      title: "Labor cost by technician",
      note: items.length ? `${items.length} technician${items.length === 1 ? "" : "s"} with logged labor` : "",
      items,
    }) || chartNothingToPlot(rows.length, "labor cost");
    return;
  }
  const priced = rows.filter((r) => r.actual_cost > 0).sort((a, b) => b.actual_cost - a.actual_cost);
  const items = priced.slice(0, CHART_LIMIT).map((r) => ({
    label: `${r.stock_number || r.customer_name || "—"} · ${r.vehicle}`,
    value: r.actual_cost,
    display: money(r.actual_cost),
    marker: r.quoted_cost || 0,
    markerLabel: r.quoted_cost ? `Quoted ${money(r.quoted_cost)}` : "",
    tone: overQuote(r) ? "over" : "",
  }));
  target.innerHTML = barChart({
    title: "What we have in it",
    note: priced.length > CHART_LIMIT ? `Top ${CHART_LIMIT} of ${priced.length} vehicles with cost` : "",
    legend: `<span class="legend-item"><span class="legend-swatch"></span>Cost</span>
             <span class="legend-item"><span class="legend-swatch over"></span>Over quote</span>
             <span class="legend-item"><span class="legend-swatch marker"></span>Quoted</span>`,
    items,
  }) || chartNothingToPlot(rows.length, "cost");
}

/* ---------- table ---------- */

function reportEmptyState(shape) {
  const ranged = state.reportStart || state.reportEnd;
  return `<div class="panel">${emptyState({
    icon: shape === "technicians" ? "staff" : "vehicle",
    title: shape === "technicians" ? "No technician activity in this range" : "No vehicles in this range",
    hint: ranged
      ? "Nothing was worked on between those dates. Try a wider range, or one of the quick ranges above."
      : "Nothing to report yet — this covers all time, so the shop has no activity of this kind recorded at all.",
    actions: ranged ? `<button type="button" class="btn btn-ghost btn-sm" data-report-range="all">Show all time</button>` : "",
  })}</div>`;
}

function renderReportTable(rows, shape) {
  if (!rows.length) return reportEmptyState(shape);
  if (shape === "technicians") {
    return `<div class="panel"><div class="table-wrap"><table><thead><tr>
      ${reportSortHeader("technicians", "technician")}
      ${reportSortHeader("technicians", "ros", "num-col")}
      ${reportSortHeader("technicians", "completed", "num-col")}
      ${reportSortHeader("technicians", "hours", "num-col")}
      ${reportSortHeader("technicians", "cost", "num-col")}
      </tr></thead>
      <tbody>${rows.map((r) => `<tr${r.ro_count ? "" : ' class="row-muted"'}><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.labor_hours}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
  const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
  const hasDeposits = totalPaid > 0;
  return `<div class="panel"><div class="table-wrap"><table><thead><tr>
    ${reportSortHeader("vehicle-spend", "stock")}
    ${reportSortHeader("vehicle-spend", "vehicle")}
    ${reportSortHeader("vehicle-spend", "segment")}
    ${reportSortHeader("vehicle-spend", "status")}
    ${reportSortHeader("vehicle-spend", "tech")}
    ${reportSortHeader("vehicle-spend", "cost", "num-col")}
    ${hasDeposits ? reportSortHeader("vehicle-spend", "paid", "num-col") + reportSortHeader("vehicle-spend", "net", "num-col") : ""}
    </tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` <span style="color:var(--ink-faint)">(${esc(r.customer_name)})</span>` : ""}</td>
    <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td><span class="pill ${vehicleStatusPillClass(r)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
    <td>${esc((r.technicians || []).join(", ")) || "—"}</td><td class="num-col${overQuote(r) ? " over-quote" : ""}">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="5">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr></tfoot>
    </table></div></div>`;
}

function reportDateRangeLabel(start, end) {
  if (!start && !end) return "All time";
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return `From ${fmt(start)}`;
  return `Through ${fmt(end)}`;
}

// Builds the print-only letterhead + table as its own self-contained markup,
// independent of whatever the on-screen app chrome looks like, so printing
// never depends on hiding every other panel correctly.
function renderPrintReport(rows, type, start, end) {
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const rangeLabel = reportDateRangeLabel(start, end);
  let body;
  if (reportShape(type) === "technicians") {
    const totalHours = rows.reduce((s, r) => s + r.labor_hours, 0);
    const totalCost = rows.reduce((s, r) => s + r.labor_cost, 0);
    body = `
      <table class="print-table">
        <thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Labor Hours</th><th class="num-col">Labor Cost</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.labor_hours}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td class="num-col"></td><td class="num-col"></td><td class="num-col">${Math.round(totalHours * 100) / 100}</td><td class="num-col">${money(totalCost)}</td></tr></tfoot>
      </table>`;
  } else {
    const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
    const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
    const hasDeposits = totalPaid > 0;
    body = `
      <table class="print-table">
        <thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technician(s)</th><th class="num-col">Cost</th>${hasDeposits ? `<th class="num-col">Customer Paid</th><th class="num-col">Net to Shop</th>` : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` (${esc(r.customer_name)})` : ""}</td>
        <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td>
        <td>${esc((r.technicians || []).join(", ")) || "—"}</td><td class="num-col">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="4">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col"></td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr></tfoot>
      </table>`;
  }
  return `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">RECON</div>
        <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
      </div>
      <div class="print-meta">
        <div class="print-report-title">${esc(REPORT_TITLES[type] || type)}</div>
        <div>${esc(rangeLabel)}</div>
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    ${body}
  `;
}

/* ---------- load / render ---------- */

// Switching report or range refetches, and the old report's numbers sitting
// there while the new ones are in flight is worse than nothing -- they look
// like an answer to the question you just asked. Skeletons shaped like the
// four cards, the chart and the table replace them for the duration.
function showReportPlaceholders() {
  $("#report-stats").innerHTML = skeletonCards(4);
  $("#report-chart").innerHTML = `<div class="panel chart-panel"><ul class="bar-chart">${
    [72, 58, 44, 33, 21].map((w) => `<li class="bar-row" aria-hidden="true">
      <span class="bar-label"><span class="skeleton-line" style="width:70%"></span></span>
      <span class="bar-track"><span class="skeleton-line" style="width:${w}%;height:12px"></span></span>
      <span class="bar-value"><span class="skeleton-line" style="width:80%"></span></span>
    </li>`).join("")}</ul></div>`;
  const cols = reportShape(state.reportType) === "technicians" ? 5 : 6;
  $("#report-output").innerHTML = `<div class="panel"><table><tbody>${skeletonRows(cols)}</tbody></table></div>`;
}

// The view loader, so opening Reports shows the last report you were reading
// instead of an empty form waiting for a Generate click.
async function loadReportsView() {
  syncReportControls();
  await refreshReport();
}

// Re-renders from state.report without refetching -- what a sort click needs.
function renderReport() {
  if (!state.report) return;
  const shape = reportShape(state.report.type);
  const rows = visibleReportRows();
  renderReportStats(rows, shape);
  renderReportChart(rows, shape);
  $("#report-output").innerHTML = renderReportTable(rows, shape);
  $("#print-report").innerHTML = renderPrintReport(rows, state.report.type, state.report.start, state.report.end);
}

async function generateReport() {
  const type = state.reportType;
  const shape = reportShape(type);
  // A sort key from the other shape (Cost exists on both, "hours" doesn't)
  // would silently sort by nothing at all.
  if (!REPORT_SORTS[shape][state.reportSort.key]) state.reportSort = { key: "cost", dir: "desc" };
  const start = state.reportStart || undefined;
  const end = state.reportEnd || undefined;
  $("#report-csv").href = reportCsvHref();
  showReportPlaceholders();
  const path = shape === "technicians" ? "technicians" : "vehicle-spend";
  const rows = await get(`/api/reports/${path}?${reportParams()}`);
  state.report = { rows, type, start, end };
  renderReport();
  saveReportPrefs();
}

// Refetch and repaint, reporting a failure into the view rather than a toast
// that leaves skeletons frozen on screen. The summary cards and the chart
// have to be emptied by hand: they aren't VIEW_PLACEHOLDERS targets, so the
// error boundary doesn't reach them, and leaving their skeletons shimmering
// above the error message reads as "still loading" forever.
async function refreshReport() {
  try {
    await generateReport();
  } catch (err) {
    $("#report-stats").innerHTML = "";
    $("#report-chart").innerHTML = "";
    renderViewFailure("reports", err);
  }
}

function wireReportsView() {
  $("#report-type-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-report-type]");
    if (!btn || btn.dataset.reportType === state.reportType) return;
    state.reportType = btn.dataset.reportType;
    syncReportControls();
    refreshReport();
  });

  // Delegated on the view, so the "Show all time" button inside an empty
  // state works the same as the chips in the toolbar.
  $("#view-reports").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-report-range]");
    if (!chip) return;
    setReportRange(chip.dataset.reportRange);
    syncReportControls();
    refreshReport();
  });

  for (const id of ["#report-start", "#report-end"]) {
    $(id).addEventListener("change", () => {
      readReportDateInputs();
      syncReportControls();
      refreshReport();
    });
  }

  $("#report-output").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-report-sort]");
    if (!th || !state.report) return;
    const key = th.dataset.reportSort;
    state.reportSort = state.reportSort.key === key
      ? { key, dir: state.reportSort.dir === "desc" ? "asc" : "desc" }
      : { key, dir: REPORT_SORTS[reportShape(state.report.type)][key].type === "number" ? "desc" : "asc" };
    renderReport();
    saveReportPrefs();
  });

  $("#report-print").addEventListener("click", async () => {
    if (!state.report) await refreshReport();
    if (!state.report) return;
    window.print();
  });
}

/* ==================================================================
   ACCOUNTING (A/P)
   ================================================================== */
async function loadAccountingView() {
  try {
    const [vendors, orders, audits] = await Promise.all([
      get("/api/vendors"), get("/api/orders"), get("/api/accounting/audits"),
    ]);
    state.vendors = vendors;
    state.orders = orders;
    renderVendorSelect();
    renderVendorChips();
    renderPoSelect();
    renderAuditList(audits);
    if (!$("#ap-invoice-items").children.length) addApLine();
  } catch (err) {
    renderViewFailure("accounting", err);
    return;
  }
  await loadApTable();
}

async function loadApTable() {
  const { start, end } = state.apFilter;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  try {
    state.apInvoices = await get(`/api/ap/invoices?${params}`);
    renderApTable(filterApInvoices(state.apInvoices));
  } catch (err) {
    toast(`Could not load A/P invoices: ${err.message}`, true);
  }
}

function filterApInvoices(invoices) {
  const query = (state.apSearch || "").toLowerCase();
  if (!query) return invoices;
  return invoices.filter((a) =>
    a.invoice_number.toLowerCase().includes(query) ||
    a.vendor_name.toLowerCase().includes(query) ||
    (a.po_number || "").toLowerCase().includes(query) ||
    a.vehicle_label.toLowerCase().includes(query)
  );
}
function renderVendorSelect() {
  $("#ap-vendor").innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("") || `<option value="">Add a vendor first</option>`;
}
function renderVendorChips() {
  $("#vendor-list").innerHTML = state.vendors.map((v) => `<span class="vendor-chip clickable" data-id="${v.id}" title="Click to edit">${esc(v.name)}${v.account_number ? ` · ${esc(v.account_number)}` : ""}</span>`).join("") || emptyState({ icon: "invoice", title: "No vendors yet", hint: "Add the parts suppliers you buy from so invoices can be posted against them.", compact: true });
  $$(".vendor-chip.clickable", $("#vendor-list")).forEach((chip) => {
    chip.addEventListener("click", () => openVendorForEdit(Number(chip.dataset.id)));
  });
}

let editingVendorId = null;
function openVendorForEdit(vendorId) {
  const vendor = state.vendors.find((v) => v.id === vendorId);
  if (!vendor) return;
  editingVendorId = vendorId;
  const form = $("#vendor-form");
  form.name.value = vendor.name;
  form.aliases.value = vendor.aliases.join(", ");
  form.account_number.value = vendor.account_number || "";
  $("#vendor-form-title").textContent = `Editing ${vendor.name}`;
  $("#vendor-form-submit").textContent = "Update Vendor";
  $("#vendor-form-cancel").style.display = "";
  form.name.focus();
}
function cancelVendorEdit() {
  editingVendorId = null;
  $("#vendor-form").reset();
  $("#vendor-form-title").textContent = "Vendors";
  $("#vendor-form-submit").textContent = "Save Vendor";
  $("#vendor-form-cancel").style.display = "none";
}
function renderPoSelect() {
  const open = state.orders.filter((o) => o.status !== "complete");
  // The PO# you actually give a vendor is the stock number, not the
  // internal RO-2607-0012 format -- submit that as the value so a vendor
  // invoice referencing "R-1042" matches straight back to this order.
  $("#ap-po").innerHTML = open.map((o) => {
    const poValue = o.stock_number || o.number;
    const label = o.stock_number ? `${o.stock_number} · ${o.number} · ${o.year} ${o.make} ${o.model}` : `${o.number} · ${o.customer_name} · ${o.year} ${o.make} ${o.model}`;
    return `<option value="${esc(poValue)}">${esc(label)}</option>`;
  }).join("") || `<option value="">No open repair orders</option>`;
}
function renderApTable(invoices) {
  $("#ap-count").textContent = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`;
  // Only recon/we-owe rows can jump anywhere -- retail ROs have no
  // vehicle-detail view, so they render as a plain (non-clickable) row.
  $("#ap-table").innerHTML = invoices.length ? invoices.map((a) => {
    const refId = a.recon_vehicle_id ?? a.we_owe_id;
    const clickable = refId != null && (a.segment === "recon" || a.segment === "we_owe");
    const voided = a.status === "voided";
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-segment="${a.segment}" data-ref-id="${refId}" title="Open this vehicle"` : ""}>
      <td>${esc(a.invoice_number)}</td><td>${esc(a.vendor_name)}</td><td>${esc(a.po_number)}</td>
      <td>${esc(a.vehicle_label)}</td><td class="num-col">${money(a.total)}</td>
      <td><span class="pill ${voided ? "pill-progress" : "pill-done"}">${esc(a.status)}</span></td>
      <td>${voided ? "" : `<button type="button" class="btn btn-ghost btn-sm ap-void" data-id="${a.id}" data-number="${esc(a.invoice_number)}">Void</button>`}</td>
    </tr>
  `;
  }).join("") : emptyRow(7, state.apSearch
    ? {
        icon: "search",
        title: "No invoices match that search",
        hint: `Nothing matched "${state.apSearch}". Searches cover invoice number, vendor, PO, and vehicle.`,
      }
    : {
        icon: "invoice",
        title: "No vendor invoices in this range",
        hint: "Post one with the form above, or widen the date range. Receiving parts on a ticket also posts an invoice here automatically.",
      });
  $$(".clickable", $("#ap-table")).forEach((row) => {
    row.addEventListener("click", () => openVehicleDetail(row.dataset.segment, Number(row.dataset.refId)));
  });
  $$(".ap-void", $("#ap-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // don't also trigger the row's open-vehicle click
      if (!(await confirmAction({
        eyebrow: "ACCOUNTS PAYABLE",
        title: `Void invoice ${btn.dataset.number}?`,
        body: "It's kept for the audit trail, and a corrected invoice can be re-posted under the same number. Parts already marked received stay received -- fix those on the ticket itself.",
        confirmLabel: "Void Invoice",
        danger: true,
      }))) return;
      try {
        await patch(`/api/ap/invoices/${btn.dataset.id}/void`, { actor: currentActor() });
        toast("Invoice voided");
        await loadApTable();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
function renderAuditList(audits) {
  $("#audit-list").innerHTML = audits.length ? audits.slice(0, 20).map((a) => `
    <div class="mini-item"><div>${esc(a.invoice_number)} — <span style="text-transform:capitalize">${esc(a.status)}</span></div>
    ${a.issues.length ? `<div class="mi-meta" style="color:var(--warn)">${a.issues.map(esc).join("; ")}</div>` : ""}
    <div class="mi-meta">${fmtDate(a.created_at)}</div></div>
  `).join("") : emptyState({ icon: "invoice", title: "No activity yet", hint: "Posting or voiding a vendor invoice is recorded here.", compact: true });
}

// Subtotal is always exactly the sum of the line items, and Total is always
// exactly Subtotal + Tax -- both fields are read-only precisely so this can
// never drift out of sync and trip process_invoice's mismatch check, which
// previously required hand-adding every line in your head.
function recalcApTotals() {
  const subtotal = $$("#ap-invoice-items tr").reduce((sum, tr) => {
    const qty = parseFloat(tr.querySelector(".apl-qty").value || "0");
    const cost = parseFloat(tr.querySelector(".apl-cost").value || "0");
    return sum + qty * cost;
  }, 0);
  const tax = parseFloat($("#ap-tax").value || "0");
  $("#ap-subtotal").value = subtotal.toFixed(2);
  $("#ap-total").value = (subtotal + tax).toFixed(2);
}

function addApLine() {
  const box = $("#ap-invoice-items");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="apl-kind"><option value="part">Part</option><option value="labor">Labor</option><option value="freight">Freight</option><option value="core_charge">Core charge</option><option value="shop_supplies">Shop supplies</option><option value="credit">Credit</option></select></td>
    <td><input class="apl-part" placeholder="Part #"></td>
    <td><input class="apl-desc" placeholder="Description"></td>
    <td><input class="apl-qty" type="number" min="0.01" step="0.01" value="1" style="width:70px"></td>
    <td><input class="apl-cost" type="number" min="0" step="0.01" value="0" style="width:90px"></td>
    <td><button type="button" class="rm-btn">×</button></td>
  `;
  tr.querySelector(".rm-btn").addEventListener("click", () => { tr.remove(); recalcApTotals(); });
  tr.querySelector(".apl-qty").addEventListener("input", recalcApTotals);
  tr.querySelector(".apl-cost").addEventListener("input", recalcApTotals);
  box.appendChild(tr);
  recalcApTotals();
}

function wireAccountingView() {
  $("#ap-add-line").addEventListener("click", addApLine);
  $("#ap-tax").addEventListener("input", recalcApTotals);

  $$('#view-accounting [data-ap-range]').forEach((chip) => {
    chip.addEventListener("click", () => {
      const range = computeQuickRange(chip.dataset.apRange);
      state.apFilter = range;
      $("#ap-filter-start").value = range.start;
      $("#ap-filter-end").value = range.end;
      $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      loadApTable();
    });
  });
  const clearApChips = () => $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
  $("#ap-filter-start").addEventListener("change", () => {
    clearApChips();
    state.apFilter.start = $("#ap-filter-start").value;
    loadApTable();
  });
  $("#ap-filter-end").addEventListener("change", () => {
    clearApChips();
    state.apFilter.end = $("#ap-filter-end").value;
    loadApTable();
  });
  $("#ap-search").addEventListener("input", (e) => {
    state.apSearch = e.target.value.trim();
    renderApTable(filterApInvoices(state.apInvoices));
  });
  $("#vendor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim(),
      aliases: form.aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
      account_number: form.account_number.value.trim(),
    };
    try {
      if (editingVendorId) {
        await patch(`/api/vendors/${editingVendorId}`, payload);
        toast("Vendor updated");
      } else {
        await post("/api/vendors", payload);
        toast("Vendor saved");
      }
      cancelVendorEdit();
      loadAccountingView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#vendor-form-cancel").addEventListener("click", cancelVendorEdit);

  $("#ap-invoice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = $$("#ap-invoice-items tr").map((tr) => ({
      part_number: tr.querySelector(".apl-part").value.trim() || "N/A",
      description: tr.querySelector(".apl-desc").value.trim(),
      quantity: parseFloat(tr.querySelector(".apl-qty").value || "0"),
      unit_cost: parseFloat(tr.querySelector(".apl-cost").value || "0"),
      kind: tr.querySelector(".apl-kind").value,
    })).filter((i) => i.description && i.quantity > 0);
    if (!items.length) return toast("Add at least one line item", true);
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        const res = await post("/api/agent/invoices/process", {
          vendor_name: $("#ap-vendor").value,
          invoice_number: $("#ap-invoice-number").value.trim(),
          po_number: $("#ap-po").value,
          subtotal: parseFloat($("#ap-subtotal").value || "0"),
          tax: parseFloat($("#ap-tax").value || "0"),
          total: parseFloat($("#ap-total").value || "0"),
          items,
          source: "ui",
        });
        if (res.status === "posted") {
          toast("Invoice posted — parts marked received");
          $("#ap-invoice-form").reset();
          $("#ap-invoice-items").innerHTML = "";
          addApLine();
          $("#ap-invoice-note").textContent = "";
        } else {
          $("#ap-invoice-note").textContent = (res.issues || []).join(" · ");
          toast(`Invoice ${res.status.replace("_", " ")}`, true);
        }
        loadAccountingView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   CORES & RETURNS
   ================================================================== */
async function loadCoresView() {
  try {
    state.cores = await get("/api/cores");
  } catch (err) {
    renderViewFailure("cores", err, [["#cores-table", 6]]);
    return;
  }
  renderCoresTable();
  try {
    state.returns = await get("/api/returns");
  } catch (err) {
    renderViewFailure("cores", err, [["#returns-table", 7]]);
    return;
  }
  renderReturnsTable();
}

function renderCoresTable() {
  const filter = state.coresFilter;
  const rows = state.cores.filter((c) => {
    if (filter === "pending") return !c.core_returned;
    if (filter === "returned") return !!c.core_returned;
    return true;
  });
  $("#cores-count").textContent = `${rows.length} core${rows.length === 1 ? "" : "s"}`;
  const pendingTotal = state.cores.filter((c) => !c.core_returned).reduce((s, c) => s + c.core_charge, 0);
  $("#cores-total").textContent = pendingTotal > 0 ? `${money(pendingTotal)} pending` : "";

  $("#cores-table").innerHTML = rows.length ? rows.map((c) => {
    const clickable = c.stock_number || c.we_owe_customer_name;
    const voided = !!c.voided;
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-order-id="${c.order_id}" title="Open this vehicle"` : ""}>
      <td>${esc(c.description)}</td><td>${esc(c.part_number || "")}</td>
      <td>${esc(c.ro_number)} · ${esc(c.vehicle_label)}</td>
      <td class="num-col">${money(c.core_charge)}</td>
      <td><span class="pill ${c.core_returned ? "pill-done" : "pill-progress"}">${c.core_returned ? "Returned" : "Pending"}</span></td>
      <td><button type="button" class="btn btn-ghost btn-sm cores-toggle" data-order-id="${c.order_id}" data-item-id="${c.id}" data-returned="${c.core_returned ? 1 : 0}">${c.core_returned ? "Undo" : "Mark Returned"}</button></td>
    </tr>
  `;
  }).join("") : emptyRow(6, {
    icon: filter === "returned" ? "check" : "core",
    title: filter === "pending" ? "No cores waiting to go back"
      : filter === "returned" ? "No cores returned yet"
      : "No core charges tracked yet",
    hint: filter === "returned"
      ? "Cores you mark returned move here, so you can confirm what's already gone back to the vendor."
      : "Put a core charge on a part line and it shows up here until the old unit goes back to the vendor and the deposit is recovered.",
  });

  $$(".clickable", $("#cores-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".cores-toggle")) return;
      const order = state.orders.find((o) => o.id === Number(row.dataset.orderId));
      const refId = order ? (order.recon_vehicle_id ?? order.we_owe_id) : null;
      const segment = order ? order.segment : null;
      if (refId != null && (segment === "recon" || segment === "we_owe")) openVehicleDetail(segment, refId);
    });
  });
  $$(".cores-toggle", $("#cores-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const returned = btn.dataset.returned !== "1";
      try {
        await patch(`/api/orders/${btn.dataset.orderId}/estimate/items/${btn.dataset.itemId}/core-return`, { returned, actor: currentActor() });
        toast(returned ? "Core marked returned" : "Core return undone");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function wireCoresView() {
  $$('#view-cores [data-cores-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.coresFilter = chip.dataset.coresFilter;
      $$('#view-cores [data-cores-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderCoresTable();
    });
  });
}

function renderReturnsTable() {
  const filter = state.returnsFilter;
  const rows = state.returns.filter((r) => {
    if (filter === "pending") return !r.return_invoice_number;
    if (filter === "credited") return !!r.return_invoice_number;
    return true;
  });
  $("#returns-count").textContent = `${rows.length} return${rows.length === 1 ? "" : "s"}`;
  const pendingTotal = state.returns.filter((r) => !r.return_invoice_number).reduce((s, r) => s + Math.abs(r.credit_total), 0);
  $("#returns-total").textContent = pendingTotal > 0 ? `${money(pendingTotal)} pending` : "";

  $("#returns-table").innerHTML = rows.length ? rows.map((r) => {
    const clickable = r.stock_number || r.we_owe_customer_name;
    const voided = !!r.voided;
    const credited = !!r.return_invoice_number;
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-order-id="${r.order_id}" title="Open this vehicle"` : ""}>
      <td>${esc(r.description)}</td><td>${esc(r.part_number || "")}</td>
      <td>${esc(r.ro_number)} · ${esc(r.vehicle_label)}</td>
      <td>${esc(r.vendor_name || "—")}</td>
      <td class="num-col">${money(Math.abs(r.credit_total))}</td>
      <td><span class="pill ${credited ? "pill-done" : "pill-progress"}">${credited ? `Credited (${esc(r.return_invoice_number)})` : "Pending Credit"}</span></td>
      <td>${credited ? "" : `<button type="button" class="btn btn-ghost btn-sm returns-post" data-id="${r.id}">Post Credit</button>`}</td>
    </tr>
  `;
  }).join("") : emptyRow(7, {
    icon: filter === "credited" ? "check" : "core",
    title: filter === "pending" ? "No returns waiting on credit"
      : filter === "credited" ? "No credited returns yet"
      : "No parts returned yet",
    hint: filter === "credited"
      ? "Once you post a vendor credit against a return it moves here with its RMA number."
      : "Mark a received part as returned on its ticket and it lands here until the vendor's credit is posted against it.",
  });

  $$(".clickable", $("#returns-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".returns-post")) return;
      const order = state.orders.find((o) => o.id === Number(row.dataset.orderId));
      const refId = order ? (order.recon_vehicle_id ?? order.we_owe_id) : null;
      const segment = order ? order.segment : null;
      if (refId != null && (segment === "recon" || segment === "we_owe")) openVehicleDetail(segment, refId);
    });
  });
  $$(".returns-post", $("#returns-table")).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = state.returns.find((r) => r.id === Number(btn.dataset.id));
      if (item) openPostReturnDialog(item);
    });
  });
}

function wireReturnsView() {
  $$('#view-cores [data-returns-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.returnsFilter = chip.dataset.returnsFilter;
      $$('#view-cores [data-returns-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderReturnsTable();
    });
  });
}

async function openPostReturnDialog(item) {
  state.postReturnItem = item;
  $("#post-return-desc").textContent = `${item.description}${item.part_number ? ` (${item.part_number})` : ""} — ${item.ro_number} · ${item.vehicle_label}`;
  const vendors = await get("/api/vendors").catch(() => []);
  state.vendors = vendors;
  $("#post-return-vendor").innerHTML = vendors.map((v) => `<option value="${v.id}" ${v.id === item.vendor_id ? "selected" : ""}>${esc(v.name)}</option>`).join("");
  $("#post-return-credit-number").value = "";
  $("#post-return-total-summary").innerHTML = `
    <div class="cost-line total"><span>Credit Due</span><span class="num">${money(Math.abs(item.credit_total))}</span></div>
  `;
  $("#post-return-dialog").showModal();
}

function wirePostReturnDialog() {
  $("#post-return-cancel").addEventListener("click", () => $("#post-return-dialog").close());
  $("#post-return-cancel-2").addEventListener("click", () => $("#post-return-dialog").close());
  $("#post-return-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Posting…", async () => {
      const item = state.postReturnItem;
      if (!item) return;
      const vendorId = Number($("#post-return-vendor").value);
      const creditNumber = $("#post-return-credit-number").value.trim();
      if (!vendorId) return toast("Select the vendor", true);
      if (!creditNumber) return toast("Enter the credit/RMA number", true);
      try {
        await post(`/api/orders/${item.order_id}/estimate/items/${item.id}/post-return-credit`, {
          vendor_id: vendorId,
          credit_number: creditNumber,
          actor: currentActor(),
        });
        $("#post-return-dialog").close();
        toast("Credit posted to A/P");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   STAFF
   ================================================================== */
async function loadStaffView() {
  try {
    state.staff = await get("/api/staff?include_inactive=true");
  } catch (err) {
    return renderViewFailure("staff", err);
  }
  refreshCurrentUserOptions();
  renderStaffTable();
}

function renderStaffTable() {
  const query = (state.staffSearch || "").toLowerCase();
  const rows = query ? state.staff.filter((s) => s.name.toLowerCase().includes(query)) : state.staff;
  $("#staff-count").textContent = `${rows.length} staff member${rows.length === 1 ? "" : "s"}`;
  $("#staff-table").innerHTML = rows.length ? rows.map((s) => `
    <tr data-id="${s.id}">
      <td><input class="stf-name" value="${esc(s.name)}" style="border:none;background:none;padding:2px"></td>
      <td><select class="stf-role" style="border:none;background:none;padding:2px">
        <option value="technician" ${s.role === "technician" ? "selected" : ""}>Technician</option>
        <option value="advisor" ${s.role === "advisor" ? "selected" : ""}>Advisor / Service Writer</option>
        <option value="manager" ${s.role === "manager" ? "selected" : ""}>Manager</option>
      </select></td>
      <td><span class="pill ${s.active ? "pill-done" : "pill-progress"}">${s.active ? "Active" : "Inactive"}</span></td>
      <td><button type="button" class="btn btn-ghost btn-sm stf-toggle">${s.active ? "Deactivate" : "Activate"}</button></td>
    </tr>
  `).join("") : emptyRow(4, query
    ? { icon: "search", title: "No staff match that search", hint: `Nothing matched "${state.staffSearch}".` }
    : { icon: "staff", title: "No staff added yet", hint: "Add your technicians and advisors above so work can be assigned and productivity reported." });

  // Name/role auto-save like everywhere else in the app -- editing then
  // navigating away (or clicking Deactivate) used to silently discard an
  // unsaved edit since this table required an explicit Save click.
  $$(".stf-name", $("#staff-table")).forEach((input) => {
    input.addEventListener("blur", async () => {
      const tr = input.closest("tr");
      const person = state.staff.find((s) => s.id === Number(tr.dataset.id));
      const name = input.value.trim();
      if (!name || name === person.name) return;
      try {
        await patch(`/api/staff/${tr.dataset.id}`, { name });
        toast("Staff updated");
        await loadStaffView();
      } catch (err) {
        toast(err.message, true);
        input.value = person.name;
      }
    });
  });
  $$(".stf-role", $("#staff-table")).forEach((select) => {
    select.addEventListener("change", async () => {
      const tr = select.closest("tr");
      try {
        await patch(`/api/staff/${tr.dataset.id}`, { role: select.value });
        toast("Staff updated");
        await loadStaffView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".stf-toggle", $("#staff-table")).forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const person = state.staff.find((s) => s.id === Number(tr.dataset.id));
    // Deactivating pulls this person out of every technician/advisor
    // dropdown app-wide -- a bigger consequence than most of the guarded
    // deletes elsewhere, so it asks first too.
    if (person.active && !(await confirmAction({
      eyebrow: "STAFF",
      title: `Deactivate ${person.name}?`,
      body: "They stop appearing in every technician and advisor dropdown. Work already assigned to them keeps their name.",
      confirmLabel: "Deactivate",
    }))) return;
    try {
      await patch(`/api/staff/${tr.dataset.id}`, { active: !person.active });
      toast(person.active ? "Deactivated" : "Activated");
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  }));
}

function wireStaffView() {
  $("#staff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await post("/api/staff", { name: form.name.value.trim(), role: form.role.value });
      form.reset();
      toast("Staff member added");
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#staff-search").addEventListener("input", (e) => {
    state.staffSearch = e.target.value.trim();
    renderStaffTable();
  });
}

/* ==================================================================
   MULTI-SELECT PICKER (checkbox popover) -- used for task assignees
   ================================================================== */
function assigneeSummaryLabel(names) {
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
function renderAssigneeMenu(menuEl, toggleEl, selectedNames, onChange) {
  menuEl.innerHTML = state.staff.length
    ? state.staff.map((s) => `<label class="ms-option"><input type="checkbox" value="${esc(s.name)}" ${selectedNames.includes(s.name) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")
    : `<div class="ms-empty">No staff yet</div>`;
  toggleEl.textContent = assigneeSummaryLabel(selectedNames);
  $$("input[type=checkbox]", menuEl).forEach((cb) => {
    cb.addEventListener("change", () => {
      const names = $$("input[type=checkbox]:checked", menuEl).map((c) => c.value);
      toggleEl.textContent = assigneeSummaryLabel(names);
      onChange(names);
    });
  });
}

// Only one picker menu open at a time; clicking anywhere outside the open
// picker closes it, same as the pattern browsers use for native <select>.
let openAssigneeMenuEl = null;
function toggleAssigneeMenu(menuEl) {
  // A row can be deleted (e.g. a task removed) while its popover is open,
  // detaching the old menu node from the document -- drop the dangling
  // reference instead of touching a node nothing can see anymore.
  if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) openAssigneeMenuEl = null;
  if (openAssigneeMenuEl && openAssigneeMenuEl !== menuEl) openAssigneeMenuEl.style.display = "none";
  const opening = menuEl.style.display !== "block";
  menuEl.style.display = opening ? "block" : "none";
  openAssigneeMenuEl = opening ? menuEl : null;
}
document.addEventListener("click", (e) => {
  if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) {
    openAssigneeMenuEl = null;
    return;
  }
  if (openAssigneeMenuEl && !e.target.closest(".ms-picker")) {
    openAssigneeMenuEl.style.display = "none";
    openAssigneeMenuEl = null;
  }
});
// Wired once per toggle button (the quick-add one lives for the app's whole
// life; each row's is rewired on every render since the row itself is new).
function wireAssigneeToggle(toggleEl, menuEl) {
  toggleEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAssigneeMenu(menuEl);
  });
}

/* ==================================================================
   TASKS
   ================================================================== */
// Due-date coloring mirrors the Vehicles board's age-severity pattern --
// outliers (overdue, due today/tomorrow) jump out without reading every row.
function taskDueInfo(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDate}T00:00:00`);
  const diffDays = Math.round((due - today) / 86400000);
  const cls = diffDays < 0 ? "overdue" : diffDays <= 1 ? "soon" : "";
  return { cls, label: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}

function taskRowHtml(t) {
  const due = taskDueInfo(t.due_date);
  const refId = t.order_recon_vehicle_id ?? t.order_we_owe_id;
  const linkable = t.order_id && refId != null && (t.order_segment === "recon" || t.order_segment === "we_owe");
  return `
    <div class="task-row ${t.urgent ? "urgent" : ""} ${t.done ? "done" : ""}" data-id="${t.id}">
      <button type="button" class="task-check" title="${t.done ? "Mark not done" : "Mark done"}">
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
      </button>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          <div class="ms-picker" data-id="${t.id}">
            <button type="button" class="ms-toggle task-assignee-toggle">${esc(assigneeSummaryLabel(t.assigned_to))}</button>
            <div class="ms-menu task-assignee-menu"></div>
          </div>
          ${due ? `<span class="task-due ${due.cls}">Due ${due.label}</span>` : ""}
          ${t.urgent ? `<span class="task-urgent-badge">Urgent</span>` : ""}
          ${linkable ? `<button type="button" class="task-order-link" data-segment="${t.order_segment}" data-ref-id="${refId}">🚗 ${esc(t.order_label || t.order_number)}</button>` : ""}
          <span>by ${esc(t.created_by || "Unspecified")} · ${relativeTime(t.created_at)}</span>
        </div>
        ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
      </div>
      <button type="button" class="task-delete" title="Delete">×</button>
    </div>
  `;
}

function wireTaskRowActions(container) {
  $$(".task-check", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      try {
        await patch(`/api/tasks/${row.dataset.id}`, { done: !row.classList.contains("done") });
        await loadTasksView();
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
        await loadTasksView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".task-order-link", container).forEach((btn) => {
    btn.addEventListener("click", () => openVehicleDetail(btn.dataset.segment, Number(btn.dataset.refId)));
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

function renderTasksList() {
  const actor = currentActor();
  const query = (state.taskSearch || "").toLowerCase();
  let open = state.tasks.filter((t) => !t.done);
  if (state.taskFilter === "mine") open = open.filter((t) => t.assigned_to.includes(actor));
  const matches = (t) => t.title.toLowerCase().includes(query) || t.notes.toLowerCase().includes(query) || t.assigned_to.some((a) => a.toLowerCase().includes(query));
  if (query) open = open.filter(matches);
  let done = state.tasks.filter((t) => t.done);
  if (query) done = done.filter(matches);

  $("#tasks-count").textContent = `${open.length} open`;
  $("#tasks-list").innerHTML = open.length
    ? open.map(taskRowHtml).join("")
    : emptyState(query
        ? { icon: "search", title: "No tasks match that search", hint: `Nothing open matched "${state.taskSearch}". Completed tasks are searched too -- check the list below.` }
        : state.taskFilter === "mine"
        ? { icon: "check", title: "Nothing assigned to you", hint: `No open tasks are assigned to ${currentActor()}. Switch to All to see everyone else's.` }
        : { icon: "task", title: "No open tasks", hint: "Add one above and it syncs to everyone the moment they open RECON." });

  $("#tasks-toggle-completed").textContent = `${state.showCompletedTasks ? "Hide" : "Show"} completed (${done.length})`;
  $("#tasks-completed-list").style.display = state.showCompletedTasks ? "" : "none";
  $("#tasks-completed-list").innerHTML = done.map(taskRowHtml).join("");

  wireTaskRowActions($("#tasks-list"));
  wireTaskRowActions($("#tasks-completed-list"));
}

// Only recon/we-owe orders are offered -- retail ROs have no vehicle-detail
// view to jump to, so linking a task to one would be a dead-end chip.
function renderTaskOrderSelect(orders) {
  const linkable = orders.filter((o) => o.segment === "recon" || o.segment === "we_owe");
  $("#task-order-input").innerHTML = `<option value="">No vehicle</option>` + linkable.map((o) => {
    const label = o.stock_number ? `${o.stock_number} — ${o.year} ${o.make} ${o.model}` : `${o.customer_name} — ${o.year} ${o.make} ${o.model}`;
    return `<option value="${o.id}">${esc(label)}</option>`;
  }).join("");
}

async function loadTasksView() {
  try {
    if (!state.staff.length) state.staff = await get("/api/staff");
    renderAssigneeMenu($("#task-assignee-menu"), $("#task-assignee-toggle"), state.newTaskAssignees, (names) => {
      state.newTaskAssignees = names;
    });
    const [tasks, orders] = await Promise.all([get("/api/tasks"), get("/api/orders")]);
    state.tasks = tasks;
    renderTaskOrderSelect(orders);
    renderTasksList();
  } catch (err) {
    renderViewFailure("tasks", err);
  }
}

function wireTasksView() {
  wireAssigneeToggle($("#task-assignee-toggle"), $("#task-assignee-menu"));

  $("#task-quick-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#task-title-input").value.trim();
    if (!title) return;
    try {
      await post("/api/tasks", {
        title,
        assigned_to: state.newTaskAssignees,
        due_date: $("#task-due-input").value,
        urgent: $("#task-urgent-input").checked,
        order_id: $("#task-order-input").value ? Number($("#task-order-input").value) : null,
        actor: currentActor(),
      });
      $("#task-quick-add").reset();
      state.newTaskAssignees = [];
      toast("Task added");
      await loadTasksView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $$('#view-tasks [data-task-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      $$('#view-tasks [data-task-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.taskFilter = chip.dataset.taskFilter;
      renderTasksList();
    });
  });

  $("#task-search").addEventListener("input", (e) => {
    state.taskSearch = e.target.value.trim();
    renderTasksList();
  });

  $("#tasks-toggle-completed").addEventListener("click", () => {
    state.showCompletedTasks = !state.showCompletedTasks;
    renderTasksList();
  });
}

/* ==================================================================
   SUGGESTIONS / IDEAS
   ================================================================== */
function suggestionCardHtml(s) {
  return `
    <div class="suggestion-card ${s.resolved ? "resolved" : ""}" data-id="${s.id}">
      <div class="suggestion-text">${esc(s.text)}</div>
      <div class="suggestion-meta">
        <span>${esc(s.author || "Unspecified")} · ${fmtDate(s.created_at)}</span>
        <button type="button" class="btn btn-ghost btn-sm suggestion-toggle">${s.resolved ? "Reopen" : "Mark Done"}</button>
        <button type="button" class="rm-btn suggestion-delete" title="Delete">×</button>
      </div>
    </div>
  `;
}

function wireSuggestionCardActions(container) {
  $$(".suggestion-toggle", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      try {
        await patch(`/api/suggestions/${card.dataset.id}`, { resolved: !card.classList.contains("resolved") });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".suggestion-delete", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      if (!(await confirmAction({
        eyebrow: "SUGGESTION",
        title: "Delete this suggestion?",
        body: "This can't be undone. Resolve it instead if you want to keep the record.",
        confirmLabel: "Delete",
        danger: true,
      }))) return;
      try {
        await api(`/api/suggestions/${card.dataset.id}`, { method: "DELETE" });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// Open/resolved are separated (matching Tasks' open/completed split) instead
// of interleaved by array order, with the resolved list collapsed by default.
function renderSuggestionsList() {
  const query = (state.suggestionSearch || "").toLowerCase();
  const matches = (s) => s.text.toLowerCase().includes(query) || (s.author || "").toLowerCase().includes(query);
  let open = state.suggestions.filter((s) => !s.resolved);
  let resolved = state.suggestions.filter((s) => s.resolved);
  if (query) {
    open = open.filter(matches);
    resolved = resolved.filter(matches);
  }

  $("#suggestions-count").textContent = `${open.length} open`;
  $("#suggestions-list").innerHTML = open.length
    ? open.map(suggestionCardHtml).join("")
    : emptyState(query
        ? { icon: "search", title: "No suggestions match that search", hint: `Nothing open matched "${state.suggestionSearch}".` }
        : { icon: "idea", title: "No open suggestions", hint: "Write down anything the system should add or fix while it's fresh -- mark it done once it's handled." });

  $("#suggestions-toggle-resolved").textContent = `${state.showResolvedSuggestions ? "Hide" : "Show"} resolved (${resolved.length})`;
  $("#suggestions-resolved-list").style.display = state.showResolvedSuggestions ? "" : "none";
  $("#suggestions-resolved-list").innerHTML = resolved.map(suggestionCardHtml).join("");

  wireSuggestionCardActions($("#suggestions-list"));
  wireSuggestionCardActions($("#suggestions-resolved-list"));
}

async function loadSuggestionsView() {
  try {
    state.suggestions = await get("/api/suggestions");
    renderSuggestionsList();
  } catch (err) {
    renderViewFailure("suggestions", err);
  }
}

function wireSuggestionsView() {
  $("#suggestion-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#suggestion-text-input").value.trim();
    if (!text) return;
    try {
      await post("/api/suggestions", { text, author: currentActor() });
      $("#suggestion-add").reset();
      toast("Suggestion posted");
      await loadSuggestionsView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#suggestion-search").addEventListener("input", (e) => {
    state.suggestionSearch = e.target.value.trim();
    renderSuggestionsList();
  });
  $("#suggestions-toggle-resolved").addEventListener("click", () => {
    state.showResolvedSuggestions = !state.showResolvedSuggestions;
    renderSuggestionsList();
  });
}

/* ==================================================================
   INIT
   ================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  wireGlobalErrorReporting();
  wireMessageLog();
  initTheme();
  initCurrentUser();
  wireConfirmDialog();
  wireViewRetry();
  wireVehiclesView();
  wireVehicleDetail();
  wireEstimateGrid();
  wireReconDialog();
  wireWeOweDialog();
  wireReceiveDialog();
  wireJobDialog();
  wireMoveItemDialog();
  wireReportsView();
  wireAccountingView();
  wireCoresView();
  wireReturnsView();
  wirePostReturnDialog();
  wireStaffView();
  wireTasksView();
  wireSuggestionsView();
  wireBackupView();

  $$(".rail-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));

  // Before the first load, so the board fetches the right side of the
  // archived/live split rather than loading the live board and then
  // discovering the saved filter was History.
  loadVehicleViewPrefs();
  // Same reasoning for Reports: the saved range has to be in state before
  // loadReportsView() builds its query string, or the first render is of
  // the default month and the saved one only appears on the second.
  loadReportPrefs();
  if (!state.reportStart && !state.reportEnd && state.reportRange) setReportRange(state.reportRange);
  showView("vehicles");
});


/* ==================================================================
   REDESIGN ADDITIONS -- details drawer, status picker, concern preview,
   backup/restore modal. Purely additive: wraps/observes the existing
   render functions above rather than changing them, so none of the real
   data flow above this line needs to change.
   ================================================================== */
const _origRenderStatusCard = renderStatusCard;
renderStatusCard = function (order) {
  _origRenderStatusCard(order);
  const pillEl = $("#vd-status-pill");
  const picker = $("#vd-status-picker");
  const assignPicker = $("#vd-assign-picker");
  const dot = $(".status-picker-dot", picker || document);
  if (pillEl && picker) {
    const text = pillEl.textContent.trim();
    picker.style.display = text ? "" : "none";
    if (assignPicker) assignPicker.style.display = text ? "" : "none";
    if (dot) dot.style.background = getComputedStyle(pillEl).backgroundColor;
  }
  const concernBox = $("#vd-concern");
  const previewWrap = $("#vd-concern-preview");
  const previewText = $("#vd-concern-preview-text");
  if (concernBox && previewWrap && previewText) {
    const val = concernBox.value.trim();
    previewWrap.style.display = val ? "" : "none";
    previewText.textContent = val;
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Details drawer: collapsible, remembers open/closed like the theme does.
  // A single handle sits on the drawer's edge at all times -- its chevron
  // flips direction to show which way it'll swing, instead of a close-only
  // "x" that disappears once collapsed.
  //
  // The preference is remembered *per width bucket*, not globally. Below
  // 1240px the drawer takes enough room out of the detail shell that the
  // Parts & Labor grid drops into its stacked card layout -- so a window
  // that was once maximised (drawer open, plenty of room) shouldn't drag
  // that choice down with it when it's resized to sit beside another app.
  // Wide defaults to open, narrow defaults to closed, and each remembers
  // what you last did *at that size*; crossing the threshold re-applies the
  // bucket you just entered rather than leaving the other one's choice on.
  const drawer = $("#vd-details-drawer");
  const handle = $("#vd-details-handle");
  // matchMedia is missing in a couple of embedded WebViews (and in the test
  // harness); falling back to "never narrow" keeps the old single-preference
  // behaviour rather than throwing halfway through wiring the page.
  const DRAWER_NARROW = typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 1240px)")
    : { matches: false };
  const drawerKey = () => (DRAWER_NARROW.matches ? "dao-details-open-narrow" : "dao-details-open");
  function setDrawerOpen(open, remember = true) {
    if (!drawer || !handle) return;
    drawer.classList.toggle("closed", !open);
    handle.classList.toggle("closed", !open);
    if (remember) localStorage.setItem(drawerKey(), open ? "1" : "0");
  }
  function applyDrawerPreference() {
    const saved = localStorage.getItem(drawerKey());
    setDrawerOpen(saved === null ? !DRAWER_NARROW.matches : saved === "1", false);
  }
  if (drawer && handle) {
    applyDrawerPreference();
    handle.addEventListener("click", () => setDrawerOpen(drawer.classList.contains("closed")));
    // addListener is the pre-2019 spelling; the app-mode window is whatever
    // WebView the machine has, so keep the fallback.
    if (DRAWER_NARROW.addEventListener) DRAWER_NARROW.addEventListener("change", applyDrawerPreference);
    else if (DRAWER_NARROW.addListener) DRAWER_NARROW.addListener(applyDrawerPreference);
  }

  // Assign picker popover (technician/advisor) -- reveals the real
  // select+save controls without keeping them inline in their own card.
  const assignToggle = $("#vd-assign-picker-toggle");
  const assignMenu = $("#vd-assign-picker-menu");
  if (assignToggle && assignMenu) {
    assignToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      assignMenu.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".status-picker")) assignMenu.classList.remove("open");
    });
  }

});

function fmtBackupSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function loadBackupView() {
  const tbody = $("#backup-table");
  if (!tbody) return;
  let backups;
  try {
    backups = await get("/api/backup");
  } catch (err) {
    renderViewFailure("backup", err);
    return;
  }
  tbody.innerHTML = backups.length ? backups.map((b) => `
    <tr>
      <td>${esc(b.name)}</td>
      <td>${fmtBackupSize(b.size_bytes)}</td>
      <td>${fmtDate(b.modified_at * 1000)}</td>
      <td style="display:flex;gap:8px;justify-content:flex-end">
        <a class="btn btn-ghost btn-sm" href="/api/backup/download/${encodeURIComponent(b.name)}" download>Download</a>
        <button type="button" class="btn btn-ghost btn-sm backup-restore-btn" data-name="${esc(b.name)}">Restore</button>
        <button type="button" class="btn btn-ghost btn-sm backup-delete-btn" data-name="${esc(b.name)}" style="color:var(--crit)">Delete</button>
      </td>
    </tr>
  `).join("") : emptyRow(4, {
    icon: "backup",
    title: "No backups yet",
    hint: "One is taken automatically every 24 hours and the last 14 are kept. You can also take one right now.",
    actions: `<button type="button" class="btn btn-primary btn-sm" data-empty-action="run-backup">Create Backup Now</button>`,
  });
  $$(".backup-restore-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!(await confirmAction({
        eyebrow: "RESTORE",
        title: `Restore from "${name}"?`,
        body: "This replaces the live database with the contents of that backup. The current database is saved aside first, so the swap can be undone by restoring it back.",
        confirmLabel: "Restore",
        danger: true,
      }))) return;
      try {
        await post(`/api/backup/restore/${encodeURIComponent(name)}`);
        toast(`Restored from ${name}`);
        location.reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".backup-delete-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!(await confirmAction({
        eyebrow: "BACKUP",
        title: `Delete backup "${name}"?`,
        body: "The backup file is removed from disk. This can't be undone.",
        confirmLabel: "Delete Backup",
        danger: true,
      }))) return;
      try {
        await api(`/api/backup/${encodeURIComponent(name)}`, { method: "DELETE" });
        toast("Backup deleted");
        loadBackupView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function wireBackupView() {
  const runBackup = async () => {
    try {
      const created = await post("/api/backup/run");
      toast(`Backup created: ${created.name}`);
      loadBackupView();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#backup-run-btn")?.addEventListener("click", runBackup);
  // Same action offered from the empty state, which is re-rendered on every
  // load and so has to be delegated.
  $("#backup-table")?.addEventListener("click", (e) => {
    if (e.target.closest('[data-empty-action="run-backup"]')) runBackup();
  });

  $("#backup-restore-submit")?.addEventListener("click", async () => {
    const file = $("#backup-restore-file").files[0];
    if (!file) return toast("Choose a file first", true);
    if (!file.name.toLowerCase().endsWith(".db")) return toast("Choose a .db backup file", true);
    if (!(await confirmAction({
      eyebrow: "RESTORE",
      title: `Restore from "${file.name}"?`,
      body: "This replaces the live database with the contents of that file. The current database is saved aside first, so the swap can be undone by restoring it back.",
      confirmLabel: "Restore",
      danger: true,
    }))) return;
    try {
      const res = await fetch("/api/backup/restore-upload", {
        method: "POST",
        headers: { "x-backup-filename": file.name },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || res.statusText);
      }
      toast(`Restored from ${file.name}`);
      location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
}
