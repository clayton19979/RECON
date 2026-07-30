import { $, $$, get } from "./core.js";
import { esc, money } from "./shortcuts.js";
import { emptyRow } from "./empty-states.js";
import { BOARD_COLUMNS, showPlaceholders } from "./skeletons.js";
import { STATUS_LABEL, STATUS_PILL_CLASS, state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { barChart } from "./reports.js";

/* ==================================================================
   VEHICLES LIST
   ================================================================== */
export async function loadVehiclesView() {
  // In-view refetches (switching to/from History) don't come through
  // showView's placeholder pass -- paint skeletons here too so the old
  // segment's rows never sit under the new segment's chips.
  showPlaceholders("vehicles");
  // VIEW_PLACEHOLDERS only lists the table (same reasoning as Reports): the
  // five summary cards and the chart otherwise keep showing the *previous*
  // segment's numbers above a blank table for the duration of the request.
  // Unlike Reports' cards, these five live as fixed-id children written once
  // in index.html and mutated in place by renderStats() -- replacing the
  // container's innerHTML here would delete those ids out from under it, so
  // this blanks their text instead of swapping in skeleton markup.
  $$("#vehicles-stats .stat-value").forEach((el) => { el.textContent = "…"; });
  $$("#vehicles-stats .stat-sub").forEach((el) => { el.textContent = ""; });
  $("#vehicles-scope").textContent = "";
  $("#vehicles-chart").innerHTML = "";
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

export function loadVehicleViewPrefs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(VEHICLE_PREFS_KEY) || "null"); } catch { saved = null; }
  if (!saved || typeof saved !== "object") return;
  if (["", "recon", "we_owe", "history"].includes(saved.filter)) state.filter = saved.filter;
  if (typeof saved.status === "string") state.vehicleStatus = saved.status;
  if (saved.sort && (saved.sort.key === "" || VEHICLE_SORTS[saved.sort.key])) {
    state.vehicleSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
  }
  if (typeof saved.partsOnly === "boolean") state.vehiclePartsOnly = saved.partsOnly;
  if (typeof saved.overOnly === "boolean") state.vehicleOverOnly = saved.overOnly;
  if (typeof saved.idleBucket === "string" && (saved.idleBucket === "" || IDLE_SELECTIONS[saved.idleBucket])) {
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
/* One writer for everything the global search bar's chrome reflects -- the
   clear button and the "/" badge -- so a value set by typing, by Escape, by
   the clear button, by Reset view or by the board's empty state can't drift
   out of step with what the field actually holds. */
export function syncSearchChrome() {
  const bar = $("#global-search-bar");
  const input = $("#global-search");
  const clear = $("#global-search-clear");
  if (!bar || !input || !clear) return;
  const has = input.value.length > 0;
  bar.classList.toggle("has-text", has);
  clear.hidden = !has;
}

// Clears the search from anywhere: keeps state, the field and its chrome in
// agreement, then repaints the board.
export function clearGlobalSearch({ focus = false } = {}) {
  const input = $("#global-search");
  state.search = "";
  if (input) input.value = "";
  syncSearchChrome();
  renderVehiclesTable();
  if (focus && input) input.focus();
}

export function syncPartsFilterChip() {
  const chip = $("#vehicles-parts-filter");
  if (!chip) return;
  chip.classList.toggle("active", state.vehiclePartsOnly);
  chip.setAttribute("aria-pressed", state.vehiclePartsOnly ? "true" : "false");
}

function saveVehicleViewPrefs() {
  try {
    localStorage.setItem(VEHICLE_PREFS_KEY, JSON.stringify({
      filter: state.filter, status: state.vehicleStatus, sort: state.vehicleSort,
      partsOnly: state.vehiclePartsOnly, overOnly: state.vehicleOverOnly,
      idleBucket: state.vehicleIdleBucket,
      chartOpen: state.vehicleChartOpen,
    }));
  } catch {}
  // chartOpen is deliberately not part of "dirty": showing or hiding the chart
  // doesn't hide any rows, so offering to reset the view over it would be
  // noise. Every other pref here changes which cars you can see.
  const dirty = !!(state.filter || state.vehicleStatus || state.vehicleSort.key || state.search
    || state.vehiclePartsOnly || state.vehicleOverOnly || state.vehicleIdleBucket);
  $("#vehicles-reset-view").hidden = !dirty;
}

export function resetVehicleView() {
  state.filter = "";
  state.vehicleStatus = "";
  state.vehiclePartsOnly = false;
  state.vehicleOverOnly = false;
  state.vehicleIdleBucket = "";
  state.vehicleSort = { key: "", dir: "desc" };
  state.search = "";
  $("#global-search").value = "";
  syncSearchChrome();
  $("#vehicles-status-filter").value = "";
  $$("#view-vehicles .filters .chip[data-filter]").forEach((c) => c.classList.toggle("active", !c.dataset.filter));
  syncPartsFilterChip();
  loadVehiclesView();
}

// Statuses differ by segment (recon carries the ticket's status, we-owe can
// also be fulfilled/waived), and which ones exist depends on the data, so the
// dropdown is built from what's actually on the board rather than hardcoded --
// a status nobody has is a dead option that only ever produces an empty list.
export function renderVehicleStatusOptions() {
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
   "4 vehicles" can't be misread as the size of the lot.

   Three of the five cards are also the control for their own filter. Two of
   those three (Waiting on Parts, Over Quote) need no special handling: their
   filter keeps exactly the rows they count, so the number is the same either
   way. Stalled is the one that does, because the idle filter it shares with
   the chart can be set to something *else* -- pick the 14+ day bar and a
   naive Stalled card drops from 8 to 6 while still labelled "Stalled", which
   is a number you stop trusting. So it counts over the pool with the idle
   filter lifted, the same rule the chart's own bars follow.

   Stalled also counts through isStalled rather than off idle_days directly,
   which is what keeps finished cars out of it -- see isStalled for why that
   matters more the longer the app has been in use.

   The two cards that aren't controls (Vehicles, Cost) describe the table
   exactly, because that's the only thing they could honestly describe. */
function boardStats(rows, idlePool = rows) {
  const overs = rows.filter(isOverQuote);
  const stalled = idlePool.filter(isStalled);
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
    stalledCount: stalled.length,
    stalledWorst: stalled.reduce((worst, v) => Math.max(worst, v.idle_days || 0), 0),
  };
}

function renderStats(rows) {
  // The idle filter lifted, and only that one -- filter to We-Owe and the
  // Stalled card still counts we-owe cars, as it should.
  const s = boardStats(rows, state.vehicleIdleBucket ? visibleVehicles({ ignoreIdle: true }) : rows);
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
  // The delta against quote is the number the manager opens the board for --
  // toned, not neutral, so over/under reads at a glance.
  const costSub = $("#stat-quoted-sub");
  if (s.quoted) {
    const diff = s.cost - s.quoted;
    costSub.textContent = Math.abs(diff) < 0.005
      ? `of ${money(s.quoted)} quoted`
      : diff > 0
        ? `${money(diff)} over the ${money(s.quoted)} quoted`
        : `${money(-diff)} under the ${money(s.quoted)} quoted`;
    costSub.style.color = Math.abs(diff) < 0.005 ? "" : (diff > 0 ? "var(--crit)" : "var(--good)");
  } else {
    costSub.textContent = "received parts + labor";
    costSub.style.color = "";
  }

  setValue("#stat-over-quote", s.overCount, s.overCount ? "crit" : null);
  $("#stat-over-quote-sub").textContent = s.overCount
    ? `${money(s.overAmount)} past estimate`
    : "none past estimate";

  // Naming the worst car's idle time rather than repeating the count: "3" and
  // "3 vehicles" side by side is a wasted line, and how long the worst one has
  // been sitting is the number that decides whether you act today.
  setValue("#stat-stalled", s.stalledCount, s.stalledCount ? "crit" : null);
  $("#stat-stalled-sub").textContent = s.stalledCount
    ? `worst sitting ${s.stalledWorst} days`
    : `nothing over ${STALLED_AFTER_DAYS - 1} days`;

  syncBoardStatCards(s);
  $("#vehicles-scope").textContent = boardScopeLabel();
}

/* The three cards that are also filters. Pressed state lives in two places
   the DOM cares about (a class for the paint, aria-pressed for screen
   readers) and both are written here from state, so a card lit up by a click,
   by restored preferences or by Reset view can't get out of step -- the same
   single-writer rule syncPartsFilterChip follows for the toolbar chip.

   A zero card is disabled rather than merely inert: "0 stalled" is good news
   and clicking it could only ever produce an empty table. */
function syncBoardStatCards(s) {
  const setCard = (sel, active, count, hint) => {
    const el = $(sel);
    if (!el) return;
    el.classList.toggle("active", !!active);
    el.setAttribute("aria-pressed", active ? "true" : "false");
    el.disabled = !count && !active;
    el.title = active ? "Showing only these — click to clear" : (count ? hint : "");
  };
  setCard('[data-board-filter="parts"]', state.vehiclePartsOnly, s.partsWaiting,
          "Show only vehicles waiting on a part");
  setCard('[data-board-filter="over"]', state.vehicleOverOnly, s.overCount,
          "Show only vehicles past their estimate");
  setCard('[data-board-filter="stalled"]', state.vehicleIdleBucket === "stalled", s.stalledCount,
          `Show only vehicles untouched for ${STALLED_AFTER_DAYS}+ days`);
  syncPartsFilterChip();
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
  if (state.vehicleOverOnly) parts.push("over quote");
  const b = idleSelection(state.vehicleIdleBucket);
  if (b) parts.push(b.key === "today" ? "active today" : b.span ? `stalled ${b.short}` : `idle ${b.short}`);
  if (state.search) parts.push(`matching “${state.search}”`);
  if (!parts.length) return "Every vehicle on the board.";
  return `Showing vehicles: ${parts.join(" · ")}.`;
}

// Age severity: how long a car has actually been sitting is the natural
// companion to "what we have in it" -- color makes the outliers jump out
// without having to read every row.
export function ageClass(days) {
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

/* "Stalled" is a span across the last two buckets, not a sixth bucket.

   The chart answers "what does the lot look like"; the Stalled card answers
   "how many cars are in trouble", and those want different granularity. A
   week is where a recon car stops being slow and starts being a problem, so
   the card draws its line at the start of the "cold" bucket rather than
   carrying its own 7 -- move that boundary and the card, the chart and the
   row colours all move together, which is the same rule idleClass follows.
   app/recon.py's STALLED_AFTER_DAYS is the server-side half of this and is
   pinned to it by test_static_assets. */
export const STALLED_AFTER_DAYS = IDLE_BY_KEY.cold.min;

/* Every idle filter the board can hold, keyed the way it's persisted. The
   five buckets are what the chart's bars set; "stalled" is what the summary
   card sets and covers two of them at once. Both are matched by range rather
   than by bucket identity, so one code path filters either kind and a span
   can't disagree with the bars it spans. */
const IDLE_SELECTIONS = {
  ...IDLE_BY_KEY,
  stalled: {
    key: "stalled", label: "Stalled", short: `${STALLED_AFTER_DAYS}+ days`,
    min: STALLED_AFTER_DAYS, max: Infinity, tone: "over", span: true,
    // The one thing separating the Stalled span from the two bars it covers.
    // It's a flag on the selection rather than an extra clause at each call
    // site because the card's count, the card's filter, the row colouring and
    // the bulk task titles all run through matchesIdleSelection -- so they
    // cannot end up disagreeing about which cars are in trouble.
    unfinishedOnly: true,
  },
};

function idleSelection(key) {
  return IDLE_SELECTIONS[key] || null;
}

/* The one definition of stalled: still needs work, and untouched for a week.

   Idle and stalled are different questions and only one of them is an alarm.
   Idle is a measurement every car has, finished ones included -- "when did
   anything last happen here" is a fair question about a car that's done, so
   the chart's bars, the bucket filters and the Idle column all read it
   straight. Stalled is the judgement, and a car whose work is finished is
   never stalled however long it has sat.

   Getting that wrong doesn't stay small. A fulfilled we-owe or a completed
   recon car is never touched again, so its idle count climbs forever: the
   Stalled card counted them, which meant the red number only ever went up and
   ended up describing the shop's history rather than its morning. It also put
   "Stalled 34 days — make a task" on a promise the advisor had deliberately
   waived. app/recon.py::is_stalled is the server's half of this. */
export function isStalled(v) {
  return matchesIdleSelection(v, IDLE_SELECTIONS.stalled);
}

function matchesIdleSelection(v, sel) {
  if (sel.unfinishedOnly && v && v.status_bucket === "finished") return false;
  const n = Math.max(0, (v && v.idle_days) || 0);
  return n >= sel.min && n <= sel.max;
}

// Matches the bucket boundaries above, so a row's color and the bar it lands
// in can never disagree -- one function, two callers.
function idleClass(days) {
  const tone = idleBucket(days).tone;
  return tone === "over" ? "age-crit" : tone === "warn" ? "age-warn" : "age-ok";
}

// "0d" reads like a broken cell; the day something happened is the one case
// worth spelling out. Everything else is the same compact Nd as Age.
//
// The warning colours are the Stalled card's judgement in the row, so they
// follow the same rule: a finished car states its idle days plainly instead
// of in alarm red. A waived promise from five weeks ago is not a problem, and
// painting it like one trains you to ignore the cars that are.
function idleCellHtml(v) {
  const days = v.idle_days || 0;
  const when = v.last_activity_at ? String(v.last_activity_at).slice(0, 10) : "";
  const finished = v.status_bucket === "finished";
  const title = when
    ? `Last activity ${when} — ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`
      + (finished && days >= STALLED_AFTER_DAYS ? " — work is finished, so this isn't stalled" : "")
    : "No activity recorded";
  const tone = finished ? "age-ok" : idleClass(days);
  return `<span class="idle-cell ${tone}" title="${esc(title)}">${days === 0 ? "today" : `${days}d`}</span>`;
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
    // Fixed-width label either way, so toggling doesn't shift the toolbar.
    toggle.textContent = state.vehicleChartOpen ? "Hide activity chart" : "Show activity chart";
    toggle.style.minWidth = "148px";
    toggle.setAttribute("aria-expanded", state.vehicleChartOpen ? "true" : "false");
  }
  if (!state.vehicleChartOpen) return;

  // Counted over the board minus the idle filter itself, so the bars stay put
  // when you click one -- a chart that collapses to the single bar you just
  // selected gives you no way back and nothing to compare against.
  const pool = visibleVehicles({ ignoreIdle: true });
  // The Stalled card selects a span across the last two buckets, and those two
  // bars have to show they're involved without claiming to *be* the filter:
  // aria-pressed stays false because clicking one narrows to that single
  // bucket rather than toggling the span off, and a control that says
  // "pressed" but doesn't un-press when clicked is worse than an unmarked one.
  // A quieter class carries the "you're inside this" signal instead.
  const sel = idleSelection(state.vehicleIdleBucket);
  const items = IDLE_BUCKETS.map((b) => {
    const count = pool.filter((v) => idleBucket(v.idle_days).key === b.key).length;
    const selected = state.vehicleIdleBucket === b.key;
    const inSpan = !selected && !!sel && sel.span && b.min >= sel.min;
    return {
      label: b.label,
      value: count,
      display: String(count),
      tone: [b.tone, selected ? "selected" : ""].filter(Boolean).join(" "),
      attrs: `data-idle-bucket="${b.key}" role="button" tabindex="0" aria-pressed="${selected}"` +
             ` title="${esc(`${count} vehicle${count === 1 ? "" : "s"} with no activity ${b.short === "today" ? "logged today" : `for ${b.short}`}${count ? " — click to filter" : ""}`)}"`,
      muted: count === 0,
      inSpan,
    };
  }).filter((i) => i.value > 0 || state.vehicleIdleBucket);

  // The span markers were unexplained red rules until this legend -- and
  // the click-to-filter affordance shouldn't live only in a hover title
  // touch users never see.
  const legendBits = [`<span class="legend-item">Click a bar to filter</span>`];
  if (sel && sel.span) {
    // The marked bars hold every car that has been sitting this long; the
    // Stalled count is the subset of them that still needs work. Naming the
    // number here is what stops the marker reading as a claim that all of
    // them are stalled -- the card beside the chart says 3 and the two bars
    // may well add up to 5, and an unexplained gap between the two is exactly
    // the kind of thing that makes both numbers untrustworthy.
    const stalledInPool = pool.filter(isStalled).length;
    legendBits.unshift(`<span class="legend-item"><span class="legend-swatch marker" style="background:var(--crit);opacity:1"></span>${stalledInPool} stalled — finished cars aren't counted</span>`);
  }
  target.innerHTML = barChart({
    title: "Time since anything happened",
    note: pool.length ? `${pool.length} vehicle${pool.length === 1 ? "" : "s"} in view` : "",
    legend: legendBits.join(""),
    items,
    rowAttrs: (i) => i.attrs,
    rowClass: (i) => [i.muted ? "bar-row-muted" : "", i.inSpan ? "bar-row-in-span" : ""].filter(Boolean).join(" "),
  }) || `<div class="panel chart-panel chart-empty">No vehicles in view to chart.</div>`;
}

// Recon rows always carry the linked repair order's status (one of the 4
// ticket statuses, color-coded). We-owe rows do too while the promise is
// still open (so progressing the ticket shows up on the board immediately),
// but switch to showing fulfilled/waived once the advisor explicitly
// resolves the promise -- that's not part of the ticket-status vocabulary,
// so it just keeps the simpler finished/in-progress coloring.
export function vehicleStatusPillClass(v) {
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
  // Same reasoning again: an over-quote filter that comes back empty means
  // every car in view is inside its estimate, which is the answer you wanted.
  if (state.vehicleOverOnly) {
    return {
      icon: "check",
      title: "Nothing is over quote",
      hint: "Every vehicle in this view has come in at or under the estimate it was quoted at.",
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-over">Show all vehicles</button>`,
    };
  }
  const idleSel = idleSelection(state.vehicleIdleBucket);
  if (idleSel) {
    const cold = idleSel.min >= 3;
    return {
      icon: cold ? "check" : "search",
      title: idleSel.span
        ? "Nothing is stalled"
        : cold ? `Nothing has been sitting ${idleSel.short}` : "No vehicles in that bucket",
      hint: idleSel.span
        ? `Every vehicle in this view that still needs work has been touched within the last ${idleSel.min} days.`
        : cold
          ? `Every vehicle in this view has been worked on within the last ${idleSel.min} days.`
          : `No vehicle in this view was last touched ${idleSel.short}.`,
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

// ignoreIdle skips the idle filter only: it's what both the chart and the
// Stalled card count over, so selecting a bucket narrows the table without
// collapsing the chart that selected it or relabelling the card beside it.
// Every other caller gets the fully filtered list.
export function visibleVehicles({ ignoreIdle = false } = {}) {
  let rows = state.vehicles;
  if (state.filter && state.filter !== "history") rows = rows.filter((v) => v.segment === state.filter);
  if (state.vehicleStatus) rows = rows.filter((v) => v.status === state.vehicleStatus);
  if (state.vehiclePartsOnly) rows = rows.filter((v) => (v.parts_pending || 0) > 0);
  if (state.vehicleOverOnly) rows = rows.filter(isOverQuote);
  const idleSel = ignoreIdle ? null : idleSelection(state.vehicleIdleBucket);
  if (idleSel) rows = rows.filter((v) => matchesIdleSelection(v, idleSel));
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
        <div class="veh-name" title="${esc(v.vehicle)}">${esc(v.vehicle)}</div>
        <div class="veh-sub">${v.segment === "we_owe"
          ? `<span class="veh-customer"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>${esc(v.customer_name || "—")}</span>`
          : (v.vin
            // Nobody scans a full 17-character VIN -- the last 8 identify
            // the car; the full value stays one hover away.
            ? `<span title="${esc(v.vin)}">VIN …${esc(String(v.vin).slice(-8))}</span>`
            : `<span class="muted-dash">—</span>`)}</div>
      </td>
      <td><span class="pill ${v.segment === "recon" ? "pill-recon" : "pill-weowe"}">${v.segment === "recon" ? "Recon" : "We-Owe"}</span></td>
      <td><span class="pill ${vehicleStatusPillClass(v)}">${esc(STATUS_LABEL[v.status] || v.status)}</span></td>
      <td>${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span>${esc(v.technicians.join(", "))}</span>` : `<span class="muted-dash">—</span>`}</td>
      <td class="col-parts">${partsCellHtml(v)}</td>
      <td class="num-col age-col ${ageClass(v.age_days)}">${v.age_days ?? "—"}${v.age_days == null ? "" : "d"}</td>
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
export function renderVehiclesTable() {
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

export function applyVehicleCursor() {
  $$("#vehicles-table tr.cursor").forEach((tr) => tr.classList.remove("cursor"));
  if (!state.vehicleCursor) return;
  const tr = $(`#vehicles-table tr[data-key="${cssEscape(state.vehicleCursor)}"]`);
  if (tr) tr.classList.add("cursor");
}

// Keys are "segment:id" -- the colon needs escaping inside an attribute
// selector, and CSS.escape doesn't exist in every environment this runs in
// (notably the jsdom used by the front-end smoke test).
export function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

export function vehicleKey(v) {
  return `${v.segment}:${v.segment === "recon" ? v.recon_id : v.we_owe_id}`;
}

// Bulk archive/reopen reuses the same single-vehicle endpoints the detail
// view already calls, fired concurrently -- there's no cross-vehicle
// transaction to preserve since archiving one has zero effect on another.
function renderVehicleBulkBar() {
  const n = state.vehicleSelection.size;
  $("#vehicles-bulk-bar").hidden = !n;
  if (!n) return;
  $("#vehicles-bulk-count").textContent = `${n} selected`;
  $("#vehicles-bulk-archive").textContent = state.filter === "history" ? "Reopen Selected" : "Send Selected to History";
  // Nothing to follow up on in History -- those cars are done by definition,
  // and a task pointing at an archived vehicle is a dead end.
  const task = $("#vehicles-bulk-task");
  if (task) {
    task.hidden = state.filter === "history";
    task.textContent = n === 1 ? "Make a Task" : `Make ${n} Tasks`;
  }
}

// The title a board-level task gets. Named because both the button and its
// confirmation preview have to show the same string -- a preview that doesn't
// match what gets created is worse than no preview.
export function bulkTaskTitle(v) {
  const name = [v.stock_number, v.vehicle].filter(Boolean).join(" ");
  const days = Math.max(0, v.idle_days || 0);
  return isStalled(v)
    ? `Follow up: ${name} — no work in ${days} days`
    : `Follow up: ${name}`;
}

/* ---------- selection ---------- */
export function setVehicleSelected(key, on) {
  if (on) state.vehicleSelection.add(key);
  else state.vehicleSelection.delete(key);
}

// Shift+click selects everything between the last row you touched and this
// one, in the order they're currently displayed -- the standard file-list
// gesture, and the only sane way to archive twenty cars at once.
export function selectVehicleRange(fromKey, toKey) {
  const keys = visibleVehicles().map(vehicleKey);
  const a = keys.indexOf(fromKey), b = keys.indexOf(toKey);
  if (a === -1 || b === -1) return setVehicleSelected(toKey, true);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.vehicleSelection.add(keys[i]);
}

export function moveVehicleCursor(delta) {
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
