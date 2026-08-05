import { $, $$, get } from "./core.js";
import { esc, fmtDay, money } from "./shortcuts.js";
import { emptyRow, emptyState } from "./empty-states.js";
import { BOARD_COLUMNS, showPlaceholders, skeletonCards } from "./skeletons.js";
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
  // The columns aren't a table, so VIEW_PLACEHOLDERS can't paint them -- and
  // leaving the previous segment's cards up under the new segment's chips is
  // exactly what showPlaceholders exists to prevent.
  const columns = state.vehicleLayout === "columns" ? $("#vehicles-columns") : null;
  if (columns) {
    columns.innerHTML = boardColumns().map((col) =>
      `<section class="veh-col" data-lot-column="${col.key}"><header class="veh-col-head"><span class="veh-col-title">${esc(col.label)}</span></header>
       <div class="veh-col-body">${skeletonCards(2)}</div></section>`).join("");
  }
  try {
    state.vehicles = await get(`/api/vehicles-board?view=${state.boardView}`);
  } catch (err) {
    renderViewFailure("vehicles", err);
    return;
  }
  // Whatever we knew about the other half is now potentially a lie -- this
  // load is also how the board catches up after archiving or reopening cars,
  // which is exactly the operation that moves them between the two halves.
  // Dropped rather than refetched: nothing needs it until someone searches.
  state.searchElsewhere = null;
  state.searchElsewhereScope = "";
  state.vehicleSelection.clear();
  loadVoidCount();
  // The three live-lot filters cannot match an archived car, so carrying one
  // across into History shows an empty screen and a scope line about parts on
  // order. Dropped on the way in; the board keeps its own when you go back,
  // because this only ever runs when the two halves are swapped.
  if (historyMode()) {
    state.vehiclePartsOnly = false;
    state.vehicleLateOnly = false;
    state.vehicleIdleBucket = "";
  }
  syncPartsFilterChip();
  // renderStats is driven from inside renderVehiclesTable now -- the cards
  // describe the visible rows, so they have to be recomputed on every filter,
  // search and sort, not just on fetch. Calling it here as well would render
  // them once against a status filter that renderVehicleStatusOptions is
  // about to drop for not existing in this segment.
  renderVehicleStatusOptions();
  renderVehiclesTable();
  // A search survives leaving the screen and coming back, and coming back
  // reloads the board -- so without this the offer to look in History quietly
  // disappeared on the return trip, on a query that still had no matches here.
  if (state.search) loadSearchElsewhere();
}

/* ---------- History ----------

   History is the other half of this screen and it is not a lot -- it is a
   record of cars that are gone. Everything the live board is built to do is
   about what to act on this morning: which pile a car is in, how long nobody
   has touched it, what it is waiting on. Applied to a car that left in April
   every one of those is a false statement. A sold car was filed under "Not
   started", the Stalled clock kept counting on it forever, the Age column
   said how long ago it arrived (a number that keeps climbing after the car is
   somebody else's), and the three columns finished with "Nothing finished
   yet" printed under a lot of finished cars.

   So the same rows are read a different way here, driven off the one fact
   History has that the live board doesn't: the day the car left. This flag is
   the single place that decides which reading applies, so a screen cannot end
   up half in one mode and half in the other. */
export function historyMode() {
  return state.boardView === "history";
}

/* The pile of cars whose only ticket was taken back.

   Read the same way History is -- one flag, so no screen can end up half in
   one mode and half in another. Everything the live board says about a car
   ("not started", how long nobody has touched it, what it is waiting on) is
   a statement about work, and there is no work here: the ticket was a
   mistake and somebody undid it. */
export function voidMode() {
  return state.boardView === "void";
}

/* Switch which pile is on screen. The three are three different lists from
   the server, not three filters over one, so this reloads rather than
   re-rendering -- and it drops the cursor and the selection, which name rows
   that are about to stop existing. */
export function setBoardView(view) {
  if (state.boardView === view) return;
  state.boardView = view;
  state.vehicleCursor = null;
  state.vehicleSelection.clear();
  syncSegmentChips();
  loadVehiclesView();
}

/* Cars are dealt into when they left rather than into the lot piles.

   Three buckets, not one per month: the columns are a fixed three-wide grid,
   and a shop two years in would otherwise get twenty-four of them running off
   the side of the screen. Recent to older, left to right -- the same
   direction the live board's piles read. */
const HISTORY_COLUMNS = [
  { key: "left-this-month", label: "Left this month", blank: "Nothing has left this month." },
  { key: "left-this-year", label: "Earlier this year", blank: "Nothing else has left this year." },
  { key: "left-earlier", label: "Before this year", blank: "Nothing left before this year." },
];

/* Which History column a car belongs in, off its archive stamp.

   Compared as text on the "YYYY-MM" prefix rather than through Date, because
   the stamps are shop-local naive (app/db.py::now) and pushing them through a
   parser is how a car archived at 8pm ends up in next month.

   A car with no readable stamp lands in the oldest column rather than
   vanishing off the screen: every archived row has one in practice (the stamp
   is what marks a car archived at all), so this is the belt-and-braces case,
   and losing a car is a far worse way to find out about it than seeing one
   in the wrong pile. */
function historyColumnKey(v) {
  const stamp = String((v && v.archived_at) || "");
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (stamp.slice(0, 7) === thisMonth) return "left-this-month";
  if (stamp.slice(0, 4) === String(now.getFullYear())) return "left-this-year";
  return "left-earlier";
}

/* How long the car was actually here: arrival to the day it was filed away.

   The server does the arithmetic (app/recon.py::days_on_lot) so this and the
   Lot Report cannot disagree, and returns null when either end is missing --
   a dash, not a nought-day stay. */
function stayDays(v) {
  return v && v.days_on_lot != null ? v.days_on_lot : null;
}

// The two sort keys History swaps in, named so the comparators stay one line
// each and read as what the column is sorting by. A car with no stay sorts
// below every car that has one, in both directions, the same way a blank
// stock number does.
function historyStay(v) {
  const stay = stayDays(v);
  return stay == null ? -1 : stay;
}
function historyLeftKey(v) {
  return String((v && v.archived_at) || "");
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
  if (["", "recon", "we_owe"].includes(saved.filter)) state.filter = saved.filter;
  // Older saves put History in with the segment chips. Read it back into
  // the control that owns it now rather than dropping the advisor's view
  // on the floor the first time they open the new build.
  if (saved.filter === "history") { state.filter = ""; state.boardView = "history"; }
  if (["active", "history", "void"].includes(saved.view)) state.boardView = saved.view;
  if (typeof saved.status === "string") state.vehicleStatus = saved.status;
  if (saved.sort && (saved.sort.key === "" || VEHICLE_SORTS[saved.sort.key])) {
    state.vehicleSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
  }
  if (typeof saved.partsOnly === "boolean") state.vehiclePartsOnly = saved.partsOnly;
  if (typeof saved.lateOnly === "boolean") state.vehicleLateOnly = saved.lateOnly;
  if (typeof saved.idleBucket === "string" && (saved.idleBucket === "" || IDLE_SELECTIONS[saved.idleBucket])) {
    state.vehicleIdleBucket = saved.idleBucket;
  }
  if (typeof saved.chartOpen === "boolean") state.vehicleChartOpen = saved.chartOpen;
  if (saved.layout === "columns" || saved.layout === "list") state.vehicleLayout = saved.layout;
  syncSegmentChips();
  $("#vehicles-status-filter").value = state.vehicleStatus;
  syncPartsFilterChip();
  syncLayoutSwitch();
}

/* Which of the two layouts is on show. One writer for everything the DOM
   carries about it -- the pressed button and the [hidden] on each of the two
   containers -- so a layout set by a click, by restored preferences or by a
   reload can't leave the switch saying one thing and the screen showing the
   other. */
export function syncLayoutSwitch() {
  const columns = state.vehicleLayout === "columns";
  $$("#vehicles-layout-switch .view-switch-btn").forEach((btn) => {
    const on = btn.dataset.vehLayout === state.vehicleLayout;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const colWrap = $("#vehicles-columns");
  const listWrap = $("#vehicles-list-panel");
  if (colWrap) colWrap.hidden = !columns;
  if (listWrap) listWrap.hidden = columns;
}

export function setVehicleLayout(layout) {
  if (layout !== "columns" && layout !== "list") return;
  if (state.vehicleLayout === layout) return;
  state.vehicleLayout = layout;
  // The cursor is a row in one layout and a card in the other; the key is the
  // same either way, so it survives the switch and applyVehicleCursor just
  // finds it in the container that's now on screen.
  syncLayoutSwitch();
  renderVehiclesTable();
}

// One writer for which of the four segment chips is lit. state.filter is set
// from saved prefs, by clicking a chip, by Reset view and by the search reach
// line's jump into History and back; the chip row has to follow all five, and
// four hand-written copies of the same toggle is how it drifts.
export function syncSegmentChips() {
  $$("#view-vehicles .filters .chip[data-filter]").forEach((c) =>
    c.classList.toggle("active", (c.dataset.filter || "") === state.filter));
  // The Show dropdown is set from the same five places the chips are, and for
  // the same reason -- saved prefs and the search reach line both move it
  // without anybody touching the control.
  const select = $("#vehicles-view-filter");
  if (select) select.value = state.boardView;
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
  // Nothing in History is waiting on a part -- the ticket is closed and the
  // car is gone. The toggle is taken off the toolbar there rather than left
  // sitting as a control that can only blank the list.
  chip.hidden = historyMode();
  chip.classList.toggle("active", state.vehiclePartsOnly);
  chip.setAttribute("aria-pressed", state.vehiclePartsOnly ? "true" : "false");
}

function saveVehicleViewPrefs() {
  try {
    localStorage.setItem(VEHICLE_PREFS_KEY, JSON.stringify({
      filter: state.filter, view: state.boardView, status: state.vehicleStatus, sort: state.vehicleSort,
      partsOnly: state.vehiclePartsOnly, lateOnly: state.vehicleLateOnly,
      idleBucket: state.vehicleIdleBucket,
      chartOpen: state.vehicleChartOpen,
      layout: state.vehicleLayout,
    }));
  } catch {}
  // chartOpen and layout are deliberately not part of "dirty": showing or
  // hiding the chart, or reading the same cars as columns instead of rows,
  // doesn't hide any of them, so offering to reset the view over it would be
  // noise. Every other pref here changes which cars you can see.
  const dirty = !!(state.filter || state.boardView !== "active" || state.vehicleStatus
    || state.vehicleSort.key || state.search
    || state.vehiclePartsOnly || state.vehicleLateOnly || state.vehicleIdleBucket);
  $("#vehicles-reset-view").hidden = !dirty;
}

export function resetVehicleView() {
  state.filter = "";
  state.boardView = "active";
  state.vehicleStatus = "";
  state.vehiclePartsOnly = false;
  state.vehicleLateOnly = false;
  state.vehicleIdleBucket = "";
  state.vehicleSort = { key: "", dir: "desc" };
  state.search = "";
  $("#global-search").value = "";
  syncSearchChrome();
  $("#vehicles-status-filter").value = "";
  syncSegmentChips();
  syncPartsFilterChip();
  loadVehiclesView();
}

/* ---------- where the search actually found it ----------

   The search box is how anyone looks a car up -- typing in it from any screen
   jumps here -- but it only ever filtered the rows this view had already
   loaded. Two everyday questions came back "No vehicles match that search"
   about a car that is in the app:

   - The car is filed to History. Search a stock number from a job finished
     last month and the board said nothing matched it.
   - The board is narrowed. Segment, status, waiting-on-parts, past-promised and
     the idle bucket all persist between sessions, so a view left on "Recon"
     weeks ago silently hides every we-owe car from every search after it.

   Both told the advisor the car doesn't exist, and the hint underneath listed
   the four fields it searches, which reads as "I looked everywhere." So the
   answer is now the whole question: the table still shows what this view
   holds, and a line above it says how many matches are somewhere else and
   takes you there. Nothing is hidden without saying so. */

// One definition of what counts as a match, used for the rows on screen and
// for the ones that aren't -- two copies would eventually disagree about
// whether a car is findable, which is the bug this whole section is about.
export function matchesVehicleSearch(v, query) {
  const q = query.toLowerCase();
  return (v.stock_number || "").toLowerCase().includes(q)
    || (v.vin || "").toLowerCase().includes(q)
    || (v.customer_name || "").toLowerCase().includes(q)
    || (v.vehicle || "").toLowerCase().includes(q)
    // The number on the paper ticket in your hand. Both forms: the short one
    // that gets said out loud ("RO 41") and the long one filed on a vendor's
    // paperwork. Typing either used to match nothing at all, so the one place
    // an advisor most often starts from -- a printed RO -- was the one thing
    // the search could not find a car by.
    || (v.ro_number ? String(v.ro_number) === q.replace(/^ro[\s-]*/i, "").trim() : false)
    || (v.order_number || "").toLowerCase().includes(q);
}

/* The other half of the board, fetched once and kept until the board reloads.

   Deliberately not fetched at startup: on a lot with years of finished cars
   in it, History is the bigger of the two lists and most sessions never
   search at all. The first keystroke pays for it, in the background -- the
   table renders immediately off what's already loaded, and the reach line
   appears when this lands. */
export async function loadSearchElsewhere() {
  const scope = historyMode() ? "live" : "history";
  if (state.searchElsewhereScope === scope) return;
  state.searchElsewhereScope = scope;
  state.searchElsewhere = null;
  let rows;
  try {
    rows = await get(scope === "history" ? "/api/vehicles-board?view=history" : "/api/vehicles-board?view=active");
  } catch {
    // Say nothing rather than something wrong: with no answer the reach line
    // makes no claim about the other half at all, and clearing the scope lets
    // the next keystroke try again.
    state.searchElsewhereScope = "";
    return;
  }
  state.searchElsewhere = rows;
  if (state.search) renderVehiclesTable();
}

/* What the current search found, split by where it found it: on screen,
   hidden by this view's own filters, or in the half of the board that isn't
   loaded. `elsewhereKnown` is false until loadSearchElsewhere has answered,
   and while it's false nothing claims the other half is empty. */
export function searchReach() {
  if (!state.search) return null;
  const q = state.search;
  const shown = visibleVehicles().length;
  const inView = state.vehicles.filter((v) => matchesVehicleSearch(v, q)).length;
  const scope = historyMode() ? "live" : "history";
  const known = state.searchElsewhereScope === scope && Array.isArray(state.searchElsewhere);
  return {
    shown,
    hidden: Math.max(inView - shown, 0),
    elsewhere: known ? state.searchElsewhere.filter((v) => matchesVehicleSearch(v, q)).length : 0,
    elsewhereKnown: known,
    scope,
  };
}

/* Both buttons below drop the narrowing filters, on purpose. They exist to
   put a specific car on screen, and landing on a second empty list because
   the status filter still applies over there would be the same broken promise
   in a new place. The segment chips and the scope line above the table show
   what changed, and Reset view is right there. */
function widenToShowMatches() {
  state.vehicleStatus = "";
  state.vehiclePartsOnly = false;
  state.vehicleLateOnly = false;
  state.vehicleIdleBucket = "";
  state.vehicleCursor = null;
  syncPartsFilterChip();
}

export function showAllSearchMatches() {
  widenToShowMatches();
  // Live and archived are two different lists from the server, so this can't
  // cross that line -- History has its own button.
  state.filter = "";
  syncSegmentChips();
  renderVehicleStatusOptions();
  renderVehiclesTable();
}

export function openSearchElsewhere() {
  widenToShowMatches();
  state.boardView = historyMode() ? "active" : "history";
  syncSegmentChips();
  loadVehiclesView();
}

// The reach line and the empty state offer the same two moves, so they go
// through one handler rather than each wiring its own copy.
export function runSearchReachAction(name) {
  if (name === "widen-search") showAllSearchMatches();
  else if (name === "search-elsewhere") openSearchElsewhere();
  else if (name === "show-void") setBoardView("void");
  else return false;
  return true;
}

const matchCount = (n) => `${n} more match${n === 1 ? "" : "es"}`;
const elsewhereLabel = (scope) => (scope === "history" ? "in History" : "on the active board");
const elsewhereButton = (scope) => (scope === "history" ? "Open History" : "Back to the board");

// Only drawn when the table has rows: with none, the empty state says the
// same thing in the space the rows would have been, and two copies of one
// offer a few pixels apart is worse than either.
/* How many cars are sitting in the Void pile, asked only while the live board
   is the one on screen.

   Taking those cars off the live list is the point of the pile, but a car
   that silently stops being anywhere is exactly the failure voiding used to
   cause (see tests/test_voided_tickets.py -- a mis-click once took a car out
   of the Stalled count for good). So the live board says how many are over
   there, and offers one click to go and look. Best-effort: a failed count
   says nothing rather than something wrong. */
async function loadVoidCount() {
  if (!voidMode() && !historyMode()) {
    try {
      state.voidCount = (await get("/api/vehicles-board?view=void")).length;
    } catch {
      state.voidCount = 0;
    }
  } else {
    state.voidCount = 0;
  }
  renderVoidNudge();
}

function renderVoidNudge() {
  const line = $("#vehicles-void-nudge");
  if (!line) return;
  const n = state.voidCount || 0;
  if (!n || voidMode() || historyMode()) {
    line.hidden = true;
    line.innerHTML = "";
    return;
  }
  line.innerHTML = `<span>${n} ${n === 1 ? "car has" : "cars have"} only a voided ticket, kept out of the live work</span>
    <button type="button" class="btn btn-ghost btn-sm" data-search-reach="show-void">Show ${n === 1 ? "it" : "them"}</button>`;
  line.hidden = false;
}

function renderSearchReach(visibleCount) {
  const line = $("#vehicles-search-reach");
  if (!line) return;
  const reach = searchReach();
  if (!reach || !visibleCount || (!reach.hidden && !reach.elsewhere)) {
    line.hidden = true;
    line.innerHTML = "";
    return;
  }
  const bits = [];
  if (reach.hidden) {
    bits.push(`<span>${matchCount(reach.hidden)} hidden by the filters on this view</span>
      <button type="button" class="btn btn-ghost btn-sm" data-search-reach="widen-search">Show all matches</button>`);
  }
  if (reach.elsewhere) {
    bits.push(`<span>${matchCount(reach.elsewhere)} ${elsewhereLabel(reach.scope)}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-search-reach="search-elsewhere">${elsewhereButton(reach.scope)}</button>`);
  }
  line.innerHTML = bits.join(`<span class="search-reach-sep" aria-hidden="true">·</span>`);
  line.hidden = false;
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

   Two of the four cards are also the control for their own filter. Waiting on
   Parts needs no special handling: its filter keeps exactly the rows it
   counts, so the number is the same either way. Stalled is the one that does,
   because the idle filter it shares with the chart can be set to something
   *else* -- pick the 14+ day bar and a naive Stalled card drops from 8 to 6
   while still labelled "Stalled", which is a number you stop trusting. So it
   counts over the pool with the idle filter lifted, the same rule the chart's
   own bars follow.

   Stalled also counts through isStalled rather than off idle_days directly,
   which is what keeps finished cars out of it -- see isStalled for why that
   matters more the longer the app has been in use.

   The two cards that aren't controls (Vehicles, Cost) describe the table
   exactly, because that's the only thing they could honestly describe. */
function boardStats(rows, idlePool = rows) {
  const stalled = idlePool.filter(isStalled);
  const late = rows.filter(isPromiseLate);
  return {
    lateCount: late.length,
    lateWorst: late.reduce((worst, v) => Math.max(worst, v.promise_days_late || 0), 0),
    count: rows.length,
    recon: rows.filter((v) => v.segment === "recon").length,
    weOwe: rows.filter((v) => v.segment === "we_owe").length,
    cost: rows.reduce((s, v) => s + (v.actual_cost || 0), 0),
    partsWaiting: rows.filter((v) => (v.parts_pending || 0) > 0).length,
    partsValue: rows.reduce((s, v) => s + (v.parts_pending_value || 0), 0),
    // Written-up parts money that has never been marked received, so it is
    // missing from the Cost total. Real spending the card cannot see -- the
    // sub below says so instead of letting the total quietly read low.
    unreceived: rows.reduce((s, v) => s + (v.unreceived_cost || 0), 0),
    stalledCount: stalled.length,
    stalledWorst: stalled.reduce((worst, v) => Math.max(worst, v.idle_days || 0), 0),
    ...historyStats(rows),
  };
}

/* The three numbers History puts where the live board's alarms go.

   Waiting on Parts, Stalled and Past Promised are all "ring somebody today"
   counts, and on a list of cars that have already gone every one of them is
   permanently zero -- three dead tiles across the top of the screen. What is
   worth knowing about finished work instead is what a car costs on average,
   how long one takes, and how many have gone out this month.

   Average stay is taken only over cars that have both dates, so one old
   record with no arrival date drags the average down instead of being counted
   as a car that came and went the same day. Its count travels with it so the
   card can say what it averaged over. */
function historyStats(rows) {
  const stays = rows.map(stayDays).filter((d) => d != null);
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    avgCost: rows.length ? rows.reduce((s, v) => s + (v.actual_cost || 0), 0) / rows.length : 0,
    stayCount: stays.length,
    avgStay: stays.length ? Math.round(stays.reduce((s, d) => s + d, 0) / stays.length) : 0,
    worstStay: stays.reduce((worst, d) => Math.max(worst, d), 0),
    leftThisMonth: rows.filter((v) => String(v.archived_at || "").slice(0, 7) === thisMonth).length,
    thisMonthName: now.toLocaleDateString("en-US", { month: "long" }),
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

  // Three of the five cards ask a live-lot question, so History puts its own
  // headings on them. Written on every render rather than only on the way in,
  // so coming back to the board cannot leave "Average Per Car" sitting over
  // the number of cars waiting on a part.
  setStatLabel('[data-board-filter="parts"]', historyMode() ? "Average Per Car" : "Waiting on Parts");
  setStatLabel('[data-board-filter="stalled"]', historyMode() ? "Average Stay" : "Stalled");
  setStatLabel('[data-board-filter="late"]', historyMode() ? "Left This Month" : "Past Promised");

  if (historyMode()) {
    setValue("#stat-parts-waiting", s.count ? money(s.avgCost) : "—");
    $("#stat-parts-waiting-sub").textContent = s.count
      ? `across ${s.count} vehicle${s.count === 1 ? "" : "s"}`
      : "nothing in History yet";
  } else {
    setValue("#stat-parts-waiting", s.partsWaiting, s.partsWaiting ? "warn" : null);
    $("#stat-parts-waiting-sub").textContent = s.partsWaiting
      ? `${money(s.partsValue)} on order`
      : "nothing on order";
  }

  // What the visible cars have cost, full stop. There is deliberately nothing
  // to compare it against: recon work isn't quoted up front -- the shop buys
  // what the car needs -- so an "against estimate" figure would be inventing a
  // number nobody agreed to. Walt's question is "how much did we spend on it".
  setValue("#stat-actual-total", money(s.cost));
  // What the visible cars have cost, full stop. There is deliberately nothing
  // to compare it against: recon work isn't quoted up front -- the shop buys
  // what the car needs -- so an "against estimate" figure would be inventing a
  // number nobody agreed to. The one caveat worth a line: parts that were
  // bought and never marked received are real spending the total cannot see,
  // so when any exist the sub says that -- it is the fact that can be acted
  // on, on the card the manager trusts most.
  const costSub = $("#stat-cost-sub");
  if (s.unreceived >= 0.005) {
    costSub.textContent = `${money(s.unreceived)} of parts not marked received`;
    costSub.style.color = "var(--warn)";
  } else {
    costSub.textContent = s.count ? "received parts + labor" : "nothing spent yet";
    costSub.style.color = "";
  }

  if (historyMode()) {
    // How many cars have gone out this month -- the one number on this screen
    // that is still moving, and the closest thing History has to news.
    setValue("#stat-late-promises", s.leftThisMonth);
    $("#stat-late-promises-sub").textContent = s.leftThisMonth
      ? `filed away so far in ${s.thisMonthName}`
      : `none filed away yet in ${s.thisMonthName}`;
  } else {
    // Same shape as Stalled, and for the same reason: the count says how many
    // people to ring, the worst one says whether it can wait until tomorrow.
    setValue("#stat-late-promises", s.lateCount, s.lateCount ? "crit" : null);
    $("#stat-late-promises-sub").textContent = s.lateCount
      ? `worst ${s.lateWorst} day${s.lateWorst === 1 ? "" : "s"} over`
      : "no promise past due";
  }

  if (historyMode()) {
    // How long a car takes from arriving to being finished with -- the recon
    // question the live board can only ever half-answer, because every car it
    // is looking at is still running its clock.
    setValue("#stat-stalled", s.stayCount ? `${s.avgStay}d` : "—");
    $("#stat-stalled-sub").textContent = s.stayCount
      ? `longest was ${s.worstStay} day${s.worstStay === 1 ? "" : "s"}`
      : "no arrival dates on file";
  } else {
    // Naming the worst car's idle time rather than repeating the count: "3" and
    // "3 vehicles" side by side is a wasted line, and how long the worst one has
    // been sitting is the number that decides whether you act today.
    setValue("#stat-stalled", s.stalledCount, s.stalledCount ? "crit" : null);
    $("#stat-stalled-sub").textContent = s.stalledCount
      ? `worst sitting ${s.stalledWorst} days`
      : `nothing over ${STALLED_AFTER_DAYS - 1} days`;
  }

  syncBoardStatCards(s);
  $("#vehicles-scope").textContent = boardScopeLabel();

  // The blurb under the heading describes the live board -- "grouped by where
  // it is up to" is the wrong sentence over cars that are not up to anything
  // any more, and it is the first line anybody reads on the screen.
  const desc = $("#view-vehicles .page-desc");
  if (desc) {
    desc.textContent = historyMode()
      ? "Cars the shop is finished with, grouped by when they left. Everything stays readable, "
        + "and any of them can be put back on the board."
      : "Every recon car and we-owe promise, grouped by where it is up to. Click a car for the "
        + "full picture — cost, parts, technician, linked repair order.";
  }
}

/* The two cards that are also filters. Pressed state lives in two places
   the DOM cares about (a class for the paint, aria-pressed for screen
   readers) and both are written here from state, so a card lit up by a click,
   by restored preferences or by Reset view can't get out of step -- the same
   single-writer rule syncPartsFilterChip follows for the toolbar chip.

   A zero card is disabled rather than merely inert: "0 stalled" is good news
   and clicking it could only ever produce an empty table. */
function setStatLabel(cardSelector, text) {
  const label = $(`${cardSelector} .stat-label`);
  if (label && label.textContent !== text) label.textContent = text;
}

function syncBoardStatCards(s) {
  const setCard = (sel, active, count, hint) => {
    const el = $(sel);
    if (!el) return;
    // In History these three are read-outs, not filters -- there is nothing
    // to narrow to. Left clickable they would filter the list by a live-lot
    // rule that matches nothing, i.e. blank the screen.
    if (historyMode()) {
      el.classList.remove("active");
      el.setAttribute("aria-pressed", "false");
      el.disabled = true;
      el.title = "";
      return;
    }
    el.classList.toggle("active", !!active);
    el.setAttribute("aria-pressed", active ? "true" : "false");
    el.disabled = !count && !active;
    el.title = active ? "Showing only these — click to clear" : (count ? hint : "");
  };
  setCard('[data-board-filter="parts"]', state.vehiclePartsOnly, s.partsWaiting,
          "Show only vehicles waiting on a part");
  setCard('[data-board-filter="stalled"]', state.vehicleIdleBucket === "stalled", s.stalledCount,
          `Show only vehicles untouched for ${STALLED_AFTER_DAYS}+ days`);
  setCard('[data-board-filter="late"]', state.vehicleLateOnly, s.lateCount,
          "Show only we-owe promises past the date the customer was given");
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
  if (historyMode()) parts.push("archived to History");
  else if (voidMode()) parts.push("voided tickets");
  if (state.filter === "recon") parts.push("recon");
  else if (state.filter === "we_owe") parts.push("we-owe");
  if (state.vehicleStatus) parts.push(STATUS_LABEL[state.vehicleStatus] || state.vehicleStatus);
  if (state.vehiclePartsOnly) parts.push("waiting on parts");
  if (state.vehicleLateOnly) parts.push("past the promised date");
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

/* The Age cell, and what it is counting from.

   On a recon car the count runs from the day the car arrived on the lot,
   which is not always the day somebody typed it in -- a Friday auction run
   written up on Monday is three days old the moment it appears. Saying which
   date the number came off is what makes "34d" arguable instead of magic, and
   it's how a wrong arrival date gets spotted and corrected (Edit Vehicle on
   the car's own page). A we-owe has no arrival date: its clock starts when the
   promise was made, and that's what the cell says. */
function ageCellHtml(v) {
  // In History the same column answers a finished question instead of a
  // running one: not "how long ago did this arrive" -- which goes on climbing
  // after the car has been sold and is nobody's problem any more -- but "how
  // long was it here", start to finish. Same column, and the only reading of
  // it that stops changing once the car is gone.
  if (historyMode()) {
    const stay = stayDays(v);
    if (stay == null) return `<span class="age-cell" title="No arrival or archive date on file">—</span>`;
    const span = stay === 1 ? "1 day" : `${stay} days`;
    const title = v.acquired_at
      ? `On the lot ${v.acquired_at} until it was filed to History — ${span}`
      : `${span} from the promise being made to being filed to History`;
    return `<span class="age-cell" title="${esc(title)}">${stay}d</span>`;
  }
  if (v.age_days == null) return `<span class="age-cell" title="No date on file">—</span>`;
  const days = v.age_days;
  const span = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`;
  // "today", not "today ago" -- a promise made this morning read "Promised today ago"
  const since = days === 0 ? "today" : `${span} ago`;
  const title = v.acquired_at
    ? `On the lot since ${v.acquired_at} — ${span}`
    : v.segment === "we_owe"
      ? `Promised ${since}`
      : `Written up ${since} — no arrival date on file`;
  return `<span class="age-cell" title="${esc(title)}">${days}d</span>`;
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
//
// `spelled` is for the columns layout: in the table the column header supplies
// the meaning, so the cell can be a bare "12d", but a card has no header over
// it and "12d" sitting beside "41d old" is two unlabelled day counts that mean
// completely different things. Same tone and same tooltip either way -- one
// function, so the two layouts cannot end up disagreeing about a car.
function idleCellHtml(v, { spelled = false } = {}) {
  // "Nobody has touched this in 41 days" is a warning about a car you can
  // still do something about. On a car that has been filed away it is just
  // arithmetic on a dead record -- and the archive itself bumps the clock, so
  // a car sold in April read "Active today". History shows the one date that
  // matters about a finished car instead: the day it left.
  if (historyMode()) return leftCellHtml(v, { spelled });
  const days = v.idle_days || 0;
  const when = v.last_activity_at ? String(v.last_activity_at).slice(0, 10) : "";
  const finished = v.status_bucket === "finished";
  const title = when
    ? `Last activity ${when} — ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`
      + (finished && days >= STALLED_AFTER_DAYS ? " — work is finished, so this isn't stalled" : "")
    : "No activity recorded";
  const tone = finished ? "age-ok" : idleClass(days);
  const text = spelled
    ? (days === 0 ? "Active today" : `Idle ${days}d`)
    : (days === 0 ? "today" : `${days}d`);
  return `<span class="idle-cell ${tone}" title="${esc(title)}">${text}</span>`;
}

/* The day a car was filed to History, in the slot the Idle clock uses on the
   live board.

   Always neutral in tone: nothing about a finished car is an alarm, and this
   is the whole reason History stopped painting old cars red. The stay comes
   along on the tooltip so the two dates and the number between them can be
   read in one hover -- "on the lot April 2, filed August 4, 124 days".

   `spelled` follows the same rule as the Idle cell: a card has no column
   header over it, so it says "Left Aug 4" where the table can say the date on
   its own. */
function leftCellHtml(v, { spelled = false } = {}) {
  const stamp = String(v.archived_at || "");
  if (!stamp) {
    return `<span class="idle-cell age-ok" title="No date recorded for when this was filed to History">${spelled ? "Left — date not recorded" : "—"}</span>`;
  }
  const day = stamp.slice(0, 10);
  const stay = stayDays(v);
  const title = `Filed to History on ${day}`
    + (stay == null ? "" : ` — ${stay === 1 ? "1 day" : `${stay} days`} on the lot`);
  const short = promisedLabel(day) || day;
  return `<span class="idle-cell age-ok" title="${esc(title)}">${spelled ? `Left ${esc(short)}` : esc(short)}</span>`;
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
  const toggle = $("#vehicles-chart-toggle");
  // "Time since anything happened" is a question about cars somebody could
  // still act on. In History every bar is a car that has gone, and the archive
  // itself counts as activity -- so the chart read "everything active today"
  // the day a batch was filed away, and drifted right forever after. It and
  // its toggle come off the screen there rather than measuring a stopped
  // clock. The preference is untouched, so the chart is back on return.
  if (historyMode()) {
    target.hidden = true;
    target.innerHTML = "";
    if (toggle) toggle.hidden = true;
    return;
  }
  if (toggle) toggle.hidden = false;
  target.hidden = !state.vehicleChartOpen;
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
    const reach = searchReach();
    const clear = `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-search">Clear search</button>`;
    // The car is in the app, just not in front of you. Saying which of the two
    // reasons it is matters: one is undone by clearing a filter, the other by
    // going to History, and "no vehicles match" pointed at neither.
    if (reach.hidden || reach.elsewhere) {
      const where = [];
      if (reach.hidden) {
        where.push(`${reach.hidden} ${reach.hidden === 1 ? "match is" : "matches are"} hidden by the filters on this view`);
      }
      if (reach.elsewhere) {
        where.push(`${reach.elsewhere} ${reach.elsewhere === 1 ? "match is" : "matches are"} ${elsewhereLabel(reach.scope)}`);
      }
      return {
        icon: "search",
        title: `Nothing matching "${state.search}" is in this view`,
        hint: `${where.join(", and ")}.`,
        actions: (reach.hidden
          ? `<button type="button" class="btn btn-ghost btn-sm" data-search-reach="widen-search">Show all matches</button>`
          : "")
          + (reach.elsewhere
            ? `<button type="button" class="btn btn-ghost btn-sm" data-search-reach="search-elsewhere">${elsewhereButton(reach.scope)}</button>`
            : "")
          + clear,
      };
    }
    return {
      icon: "search",
      title: "No vehicles match that search",
      // "and not in History" only once History has actually been looked in --
      // before that it's a claim nothing has checked.
      hint: `Nothing matched "${state.search}"${reach.elsewhereKnown ? `, ${elsewhereLabel(state.filter === "history" ? "history" : "live")} or ${elsewhereLabel(reach.scope)}` : ""}.`
        + " Searches cover stock number, VIN, customer name, and the vehicle description.",
      actions: clear,
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
  // An empty "past promised" filter is the good answer, not an empty lot. It
  // also has to be said as a fact about promises rather than about vehicles
  // -- recon cars have no promise to be late on.
  if (state.vehicleLateOnly) {
    return {
      icon: "check",
      title: "No promise is past due",
      hint: "Every we-owe in this view is either still inside the date the customer was given, or already fulfilled or waived.",
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="clear-late">Show all vehicles</button>`,
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
  if (voidMode()) {
    return {
      icon: "check",
      title: "No voided tickets",
      hint: "A ticket written by mistake and then taken back leaves the car here, so it can be dealt with instead of sitting in with the live work looking like a car nobody has started.",
    };
  }
  if (historyMode()) {
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
   burying it at the bottom either way is what every list app does.

   NO_PROMISE is where a row with no live promised date sorts: far below any
   real "days late" a shop could produce, and finite because -Infinity minus
   -Infinity is NaN and would scramble the whole comparison. */
const NO_PROMISE = -1e9;

const VEHICLE_SORTS = {
  stock: { label: "Stock #", type: "text", value: (v) => v.stock_number || "" },
  vehicle: { label: "Vehicle", type: "text", value: (v) => v.vehicle || "" },
  segment: { label: "Type", type: "text", value: (v) => (v.segment === "recon" ? "Recon" : "We-Owe") },
  status: { label: "Status", type: "text", value: (v) => STATUS_LABEL[v.status] || v.status || "" },
  tech: { label: "Technician", type: "text", value: (v) => v.technicians.join(", ") },
  parts: { label: "Parts", type: "number", value: (v) => v.parts_pending || 0 },
  // These two ask a different question in History (see ageCellHtml and
  // leftCellHtml), so their header and their sort follow what the cell under
  // them actually says -- a column headed "Left" that sorted by idle days
  // would be sorting by a number nobody on the screen can see. Left sorts on
  // the stamp as text rather than parsing it: shop-local naive stamps compare
  // correctly as strings and need no timezone, descending puts the most
  // recently gone car first, and the text branch already files blanks last in
  // both directions.
  age: { label: () => (historyMode() ? "Stay" : "Age"), type: "number", value: (v) => (historyMode() ? historyStay(v) : v.age_days) },
  idle: { label: () => (historyMode() ? "Left" : "Idle"), type: () => (historyMode() ? "text" : "number"), value: (v) => (historyMode() ? historyLeftKey(v) : v.idle_days || 0) },
  // Sorted by how late the promise is, not by the date on it: descending puts
  // the promise you have already broken at the top, which is the reason to
  // click this header at all. Everything with no live promise -- every recon
  // car, a we-owe with no date, one already fulfilled or waived -- shares the
  // NO_PROMISE sentinel, so they group together at the far end and keep the
  // server's order among themselves.
  promised: { label: "Promised", type: "number", value: (v) => (v.promise_days_late == null ? NO_PROMISE : v.promise_days_late) },
  cost: { label: "Cost", type: "number", value: (v) => v.actual_cost },
};

// A column whose meaning changes between the live board and History declares
// its label and its type as functions of the mode; everything else states them
// once. Read through these two so neither the sort nor the header has to know
// which kind it is looking at.
const sortLabel = (spec) => (typeof spec.label === "function" ? spec.label() : spec.label);
const sortType = (spec) => (typeof spec.type === "function" ? spec.type() : spec.type);

function sortVehicleRows(rows, { key, dir }) {
  const spec = VEHICLE_SORTS[key];
  if (!spec) return rows;
  const sign = dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = spec.value(a), bv = spec.value(b);
    if (sortType(spec) === "number") return ((av || 0) - (bv || 0)) * sign;
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
  if (state.filter) rows = rows.filter((v) => v.segment === state.filter);
  if (state.vehicleStatus) rows = rows.filter((v) => v.status === state.vehicleStatus);
  if (state.vehiclePartsOnly) rows = rows.filter((v) => (v.parts_pending || 0) > 0);
  if (state.vehicleLateOnly) rows = rows.filter(isPromiseLate);
  const idleSel = ignoreIdle ? null : idleSelection(state.vehicleIdleBucket);
  if (idleSel) rows = rows.filter((v) => matchesIdleSelection(v, idleSel));
  if (state.search) rows = rows.filter((v) => matchesVehicleSearch(v, state.search));
  return sortVehicleRows(rows, state.vehicleSort);
}

function renderVehicleSortHeaders() {
  $$("#view-vehicles th.sortable").forEach((th) => {
    const active = th.dataset.sortKey === state.vehicleSort.key;
    th.classList.toggle("sorted", active);
    th.setAttribute("aria-sort", active ? (state.vehicleSort.dir === "asc" ? "ascending" : "descending") : "none");
    const spec = VEHICLE_SORTS[th.dataset.sortKey];
    const label = spec ? sortLabel(spec) : "column";
    const nextDir = active && state.vehicleSort.dir === "desc" ? "ascending" : "descending";
    th.title = active && state.vehicleSort.dir === "asc" && spec
      ? `Sort by ${label} — click to clear`
      : `Sort by ${label} (${nextDir})`;
    // Two of the headers are written in index.html for the live board and
    // renamed here when History changes what the column under them says. The
    // heading is the only thing telling you which question a column of bare
    // numbers is answering, so it has to follow the cells.
    if (spec) {
      const first = th.firstChild;
      if (first && first.nodeType === 3 && first.textContent.trim() !== label) first.textContent = `${label} `;
    }
    const arrow = $(".sort-arrow", th);
    if (arrow) arrow.textContent = active ? (state.vehicleSort.dir === "desc" ? "▼" : "▲") : "";
  });
}

/* The Cost column shows what the car has actually been charged, which is
   parts once they're marked received. A ticket that gets closed out with its
   parts still sitting at "quoted" therefore leaves the car reading $0.00 --
   for a car that's had four tires put on it. That happens constantly: the
   parts get picked up at the counter and thrown on the car, and receiving
   them in the app is a separate step nobody remembers on a busy morning.

   So the cell carries the shortfall underneath the number rather than making
   Walt notice that a finished car cost nothing. Only closed tickets count --
   on an open one the same unreceived line is just work not done yet, which
   the Parts column and the quote already say. */
function costMissingHtml(v) {
  const missing = v.unreceived_closed_cost || 0;
  if (!missing) return "";
  const n = v.unreceived_closed_parts || 0;
  const label = `Ticket is closed but ${n} part${n === 1 ? " was" : "s were"} never marked received — `
    + `${money(missing)} of this car's cost isn't counted. Open the ticket and receive them.`;
  return `<span class="cost-missing" title="${esc(label)}">+${money(missing)} not received</span>`;
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

/* ---------- promised dates ----------

   A we-owe is a promise a salesman made to close a car deal, and the date the
   customer was given is the one thing about it that has a deadline. It was
   asked for at intake, stored, and then shown on no screen anybody makes a
   decision on -- so the only way to find out a promise had gone past its date
   was to remember the car and open it.

   The server does the arithmetic (see recon.promise_days_late) so the board,
   the Past Promised card and the lot sheet cannot each reach a different
   answer about the same promise on the same morning. */
export function isPromiseLate(v) {
  const late = v && v.promise_days_late;
  return typeof late === "number" && late > 0;
}

/* "Jul 30" on a promise due this year, "Jul 30, 2025" on one that isn't.
   The board is the widest table in the app and already scrolls sideways on a
   1280px window; a year every row shares is 40px of that spent saying
   nothing. It comes back the moment it's carrying information -- and the
   tooltip always spells the whole date out. */
function promisedLabel(value) {
  const full = fmtDay(value);
  const suffix = `, ${new Date().getFullYear()}`;
  return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
}

/* Blank for anything with no promised date, which is every recon car -- a
   column of dashes down the recon half would draw the eye to the rows with
   nothing to say. A settled promise keeps its date but drops the countdown
   and the colour: it was met (or waived), and painting it red forever is how
   the Stalled card used to lie.

   Days are abbreviated the way Age and Idle already abbreviate theirs ("3d"),
   so the three day-counting columns read as one family. */
function promisedCellHtml(v) {
  if (!v.target_date) return "";
  const full = esc(fmtDay(v.target_date));
  const label = esc(promisedLabel(v.target_date));
  const late = v.promise_days_late;
  if (late == null) return `<span class="promise-cell promise-settled" title="Promised for ${full} — this promise is closed">${label}</span>`;
  if (late > 0) return `<span class="promise-cell promise-late" title="Promised for ${full} — ${late} day${late === 1 ? "" : "s"} past due">${label} <span class="promise-tag">${late}d late</span></span>`;
  if (late === 0) return `<span class="promise-cell promise-today" title="Promised for ${full} — due today">${label} <span class="promise-tag">today</span></span>`;
  return `<span class="promise-cell" title="Promised for ${full} — ${-late} day${late === -1 ? "" : "s"} to go">${label}</span>`;
}

/* The ticket's short number, as it reads everywhere it appears.
   A car with no live ticket has no number to show, and says so rather than
   printing "RO —" as though one existed. */
export function roTagHtml(v) {
  return v.ro_number
    ? `<span class="ro-tag" title="${esc(v.order_number || "")}">RO ${esc(String(v.ro_number))}</span>`
    : `<span class="ro-none-sm">no ticket</span>`;
}

function vehicleRowHtml(v) {
  const key = vehicleKey(v);
  return `
      <td class="col-select"><input type="checkbox" class="veh-select" data-key="${key}" aria-label="Select ${esc(v.stock_number || v.vehicle)}" ${state.vehicleSelection.has(key) ? "checked" : ""}></td>
      <td class="num col-stock"><span class="stock-no">${esc(v.stock_number || "—")}</span><div class="veh-sub">${roTagHtml(v)}</div></td>
      <td class="col-vehicle">
        <div class="veh-name" title="${esc(v.vehicle)}">${esc(v.vehicle)}</div>
        <div class="veh-sub">${v.segment === "we_owe"
          ? `<span class="veh-customer"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>${esc(v.customer_name || "—")}</span>`
          : (v.vin
            // Nobody scans a full 17-character VIN -- the last 8 identify
            // the car; the full value stays one hover away.
            ? `<span title="${esc(v.vin)}">VIN …${esc(String(v.vin).slice(-8))}</span>`
            : `<span class="muted-dash">—</span>`)}</div>
      </td>
      <td class="col-type"><span class="pill ${v.segment === "recon" ? "pill-recon" : "pill-weowe"}">${v.segment === "recon" ? "Recon" : "We-Owe"}</span></td>
      <td class="col-status"><span class="pill ${vehicleStatusPillClass(v)}">${esc(STATUS_LABEL[v.status] || v.status)}</span></td>
      <td class="col-tech">${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span><span class="tech-names">${esc(v.technicians.join(", "))}</span></span>` : `<span class="muted-dash">—</span>`}</td>
      <td class="col-parts">${partsCellHtml(v)}</td>
      <td class="num-col age-col ${historyMode() ? "age-ok" : ageClass(v.age_days)}">${ageCellHtml(v)}</td>
      <td class="num-col idle-col">${idleCellHtml(v)}</td>
      <td class="promised-col">${promisedCellHtml(v)}</td>
      <td class="num-col col-cost">${money(v.actual_cost)}${costMissingHtml(v)}</td>`;
}

// A signature of everything vehicleRowHtml() reads. Two renders with the same
// signature produce byte-identical markup, so the existing <tr> can be reused
// as-is -- see renderVehiclesTable.
function vehicleRowSignature(v) {
  return [
    v.stock_number, v.vehicle, v.vin, v.customer_name, v.segment, v.status, v.status_bucket,
    // The row prints the ticket's number, so writing the first ticket on a
    // car has to rebuild it -- otherwise the card keeps saying "no ticket"
    // until something else about the car happens to change.
    v.ro_number,
    v.technicians.join("|"), v.age_days, v.acquired_at, v.idle_days, v.last_activity_at,
    v.target_date, v.promise_days_late,
    // History reads Age and Idle as the stay and the day it left, so both the
    // values and the mode belong in the signature -- without the mode, coming
    // back from History would reuse rows still showing History's wording.
    v.archived_at, v.days_on_lot, historyMode() ? "h" : "",
    v.actual_cost, v.parts_pending, v.parts_pending_value,
    v.unreceived_closed_cost, v.unreceived_closed_parts,
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
  renderVoidNudge();
  renderSearchReach(rows.length);
  saveVehicleViewPrefs();
  // The columns are built from these same rows -- one filtered, sorted list,
  // two ways of reading it. No-ops unless the columns layout is the one on
  // screen (syncLayoutSwitch owns which container is visible).
  renderVehicleColumns(rows);

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

/* ---------- the columns layout ----------

   The same filtered, sorted rows the table shows, dealt into the piles
   Walt actually asks about: what hasn't been started, what's in the shop, and
   what can go out. Left to right is the direction a car travels, which is the
   shape everyone who has used a shop job board already reads without being
   told.

   The piles are the *server's* -- every board row arrives stamped with the
   lot_bucket the Lot Report groups by (app/recon.py::lot_bucket), so a car
   cannot be under "In the shop" here and under "Not started" on the sheet
   Walt is holding. Same reason each card's "what it still needs" line is the
   server's sentence rather than one assembled in the browser.

   Sort still applies: it orders the cards inside each column, so "Idle,
   longest first" reads as "the most forgotten car at the top of every pile". */
const LOT_WAITING = "waiting";
const LOT_WORKING = "working";
const LOT_READY = "ready";
const LOT_SETTLED = "settled";

export const LOT_COLUMNS = [
  { key: LOT_WAITING, label: "Not started", blank: "Nothing waiting to be started." },
  { key: LOT_WORKING, label: "In the shop", blank: "Nothing in the shop right now." },
  { key: LOT_READY, label: "Ready to go", blank: "Nothing finished yet." },
  // Last, and past the end of the left-to-right journey the other three
  // describe: these cars have already left it. Sold cars and settled we-owe
  // promises used to sit in "Ready to go" and quietly inflate the one number
  // Walt reads off this board -- see app/recon.py::LOT_SETTLED.
  { key: LOT_SETTLED, label: "Finished — file away", blank: "Nothing waiting to be filed." },
];

const LOT_COLUMN_KEYS = new Set(LOT_COLUMNS.map((c) => c.key));

/* Which set of piles this half of the screen deals cards into.

   The live board's three are where a car is up to. History's three are when
   it left (see HISTORY_COLUMNS) -- "Ready to go" over a column of cars that
   were sold months ago, with "Nothing finished yet" printed under the empty
   one beside it, was the plainest way this screen said something untrue. */
export function boardColumns() {
  return historyMode() ? HISTORY_COLUMNS : LOT_COLUMNS;
}

// The server stamps every row, so the fallback is unreachable -- but a car
// that quietly vanished off the board because its bucket was a string nobody
// recognised would be the worst possible way to find that out, so an unknown
// bucket lands in the middle pile rather than nowhere.
function columnKey(v) {
  if (historyMode()) return historyColumnKey(v);
  return LOT_COLUMN_KEYS.has(v.lot_bucket) ? v.lot_bucket : LOT_WORKING;
}

/* The rows in the order they appear on screen.

   In the table that's just the sorted list; in columns it's the same list
   re-grouped, and the keyboard has to walk what you can actually see -- with
   the table's order, ArrowDown from the last card of column one would jump to
   a card three columns over. */
export function displayedVehicles() {
  const rows = visibleVehicles();
  if (state.vehicleLayout !== "columns") return rows;
  return boardColumns().flatMap((col) => rows.filter((v) => columnKey(v) === col.key));
}

/* "$1,240.00 spent" plus, where there is any, what finishing the column's
   cars should still cost. The same two numbers the Lot Report prints under
   each of its groups, so the two screens can be read side by side.

   A column with no money in it either way says nothing at all rather than
   "$0.00 spent" -- three columns of zeroes across the top of the board is
   three pieces of furniture, and it makes the one real number harder to spot
   than if it were alone. */
function columnSummary(rows) {
  const spent = rows.reduce((s, v) => s + (v.actual_cost || 0), 0);
  const left = rows.reduce((s, v) => s + (v.remaining_cost || 0), 0);
  const bits = [];
  if (spent > 0.005) bits.push(`${money(spent)} spent`);
  // "$95.00 left" is what finishing these cars should still cost. Nothing is
  // going to be spent on a car that has been filed away, so History says what
  // the month cost and stops there.
  if (left > 0.005 && !historyMode()) bits.push(`${money(left)} left`);
  return bits.join(" · ");
}

function cardSubHtml(v) {
  if (v.segment === "we_owe") {
    return `<span class="veh-customer"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>${esc(v.customer_name || "—")}</span>`;
  }
  // Nobody scans a full 17-character VIN -- the last 8 identify the car.
  return v.vin
    ? `<span title="${esc(v.vin)}">VIN …${esc(String(v.vin).slice(-8))}</span>`
    : `<span class="muted-dash">No VIN on file</span>`;
}

function vehicleCardHtml(v) {
  const key = vehicleKey(v);
  // "37d old" is time since the car arrived, and it keeps climbing after the
  // car has been sold -- on an archived card it is a number about somebody
  // else's car. History says how long the stay actually was instead, and in
  // plain grey: nothing about a finished car is late.
  const stay = historyMode() ? stayDays(v) : null;
  const age = historyMode()
    ? (stay == null ? "" : `${stay}d here`)
    : (v.age_days == null ? "" : `${v.age_days}d old`);
  const ageTone = historyMode() ? "age-ok" : ageClass(v.age_days);
  const ref = v.stock_number || (v.segment === "we_owe" ? "We-Owe" : "—");
  return `
    <label class="veh-card-select" title="Select ${esc(v.stock_number || v.vehicle)}">
      <input type="checkbox" class="veh-select" data-key="${key}" aria-label="Select ${esc(v.stock_number || v.vehicle)}" ${state.vehicleSelection.has(key) ? "checked" : ""}>
    </label>
    <div class="veh-card-head">
      <span class="pill ${vehicleStatusPillClass(v)}">${esc(STATUS_LABEL[v.status] || v.status)}</span>
      <span class="veh-card-ref">${esc(ref)}${age ? ` <span class="${ageTone}">· ${esc(age)}</span>` : ""}</span>
      ${roTagHtml(v)}
    </div>
    <div class="veh-card-name" title="${esc(v.vehicle)}">${esc(v.vehicle)}</div>
    <div class="veh-card-sub">${cardSubHtml(v)}</div>
    <div class="veh-card-needs" title="${esc(v.needs || "")}">${esc(v.needs || "")}</div>
    <div class="veh-card-foot">
      <span class="veh-card-facts">
        ${idleCellHtml(v, { spelled: true })}
        ${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span>${esc(v.technicians.join(", "))}</span>` : ""}
      </span>
      <span class="veh-card-money">
        <span class="veh-card-cost">${money(v.actual_cost)}</span>
      </span>
    </div>`;
}

// Same contract as vehicleRowSignature: everything vehicleCardHtml reads, so
// an unchanged card is moved rather than rebuilt.
function vehicleCardSignature(v) {
  return [
    vehicleRowSignature(v), v.needs, v.remaining_cost, v.lot_bucket,
  ].join("");
}

/* Keyed, incremental, per column -- the same reasoning as the table's render.
   Each column is its own scroll container on a full lot, and rebuilding
   innerHTML would throw that scroll away on every keystroke of the search
   box. */
function renderVehicleColumns(rows) {
  // Only the layout on screen is painted. Both are rebuilt from the same rows
  // the moment you switch (setVehicleLayout re-renders), so they can't show
  // two different boards -- there's just no reason to build sixty cards
  // nobody can see on every keystroke of the search box.
  if (state.vehicleLayout !== "columns") return;
  const host = $("#vehicles-columns");
  if (!host) return;

  if (!rows.length) {
    // One empty state for the whole board, not three identical ones.
    host.innerHTML = `<div class="panel veh-columns-empty">${emptyState(vehiclesEmptyState())}</div>`;
    return;
  }
  const cols = boardColumns();
  // Rebuilt from scratch when the headings themselves have to change -- on the
  // first paint, over the skeletons, over the empty state, and crossing
  // between the live board and History, where all three columns are different
  // piles. Everything after that is the keyed per-card update below.
  const onScreen = [...host.children].map((el) => el.dataset.lotColumn || "").join(",");
  if (onScreen !== cols.map((c) => c.key).join(",")
      || host.querySelector(".skeleton-card") || host.querySelector(".veh-columns-empty")) {
    host.innerHTML = cols.map((col) => `
      <section class="veh-col" data-lot-column="${col.key}">
        <header class="veh-col-head">
          <span class="veh-col-title">${esc(col.label)}</span>
          <span class="veh-col-count" data-col-count></span>
          <span class="veh-col-money" data-col-money></span>
        </header>
        <div class="veh-col-body" data-col-body></div>
      </section>`).join("");
  }

  for (const col of cols) {
    const section = $(`[data-lot-column="${col.key}"]`, host);
    if (!section) continue;
    const inColumn = rows.filter((v) => columnKey(v) === col.key);
    $("[data-col-count]", section).textContent = String(inColumn.length);
    $("[data-col-money]", section).textContent = inColumn.length ? columnSummary(inColumn) : "";
    const body = $("[data-col-body]", section);

    const existing = new Map();
    for (const el of body.children) {
      if (el.dataset && el.dataset.key) existing.set(el.dataset.key, el);
    }
    let cursor = body.firstElementChild;
    for (const v of inColumn) {
      const key = vehicleKey(v);
      const sig = vehicleCardSignature(v);
      let card = existing.get(key);
      if (card) {
        existing.delete(key);
        if (card.dataset.sig !== sig) {
          card.innerHTML = vehicleCardHtml(v);
          card.dataset.sig = sig;
        }
      } else {
        card = document.createElement("article");
        card.className = "veh-card clickable";
        card.dataset.segment = v.segment;
        card.dataset.id = String(v.segment === "recon" ? v.recon_id : v.we_owe_id);
        card.dataset.key = key;
        card.dataset.sig = sig;
        card.innerHTML = vehicleCardHtml(v);
      }
      card.classList.toggle("selected", state.vehicleSelection.has(key));
      if (card === cursor) cursor = cursor.nextElementSibling;
      else body.insertBefore(card, cursor);
    }
    for (const el of existing.values()) el.remove();
    while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
    // A column that's empty because of a filter still has to say so; a blank
    // panel under a "0" reads as a screen that failed to load.
    let blank = $(".veh-col-blank", section);
    if (!inColumn.length && !blank) {
      blank = document.createElement("p");
      blank.className = "veh-col-blank";
      blank.textContent = col.blank;
      body.appendChild(blank);
    } else if (inColumn.length && blank) {
      blank.remove();
    }
  }
}

/* The row or card for a key, in whichever layout is on screen.

   The cursor, "scroll it into view" and Enter-to-open all need it, and all
   three have to look in the container the user is actually looking at. The
   element selector is explicit because a card's own select checkbox carries
   the same data-key -- an unqualified [data-key] would be a coin toss. */
export function vehicleNodeFor(key) {
  const root = state.vehicleLayout === "columns" ? $("#vehicles-columns") : $("#vehicles-table");
  if (!root || !key) return null;
  return $(`tr[data-key="${cssEscape(key)}"], article[data-key="${cssEscape(key)}"]`, root);
}

export function applyVehicleCursor() {
  $$("#view-vehicles tr.cursor, #view-vehicles article.cursor").forEach((el) => el.classList.remove("cursor"));
  const el = vehicleNodeFor(state.vehicleCursor);
  if (el) el.classList.add("cursor");
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
  // Filing a car away is a statement that its work is finished and settled.
  // Nothing in the Void pile qualifies: the only ticket on these cars was a
  // mistake somebody took back, so there is no finished work to file -- the
  // car either needs writing up properly or it should never have been here.
  // Offering the action anyway is how a loose end gets buried instead of
  // dealt with.
  const archive = $("#vehicles-bulk-archive");
  archive.hidden = voidMode();
  archive.textContent = historyMode() ? "Reopen Selected" : "Send Selected to History";
  // Nothing to follow up on in History -- those cars are done by definition,
  // and a task pointing at an archived vehicle is a dead end.
  const task = $("#vehicles-bulk-task");
  if (task) {
    task.hidden = historyMode();
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
  const keys = displayedVehicles().map(vehicleKey);
  const a = keys.indexOf(fromKey), b = keys.indexOf(toKey);
  if (a === -1 || b === -1) return setVehicleSelected(toKey, true);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.vehicleSelection.add(keys[i]);
}

export function moveVehicleCursor(delta) {
  const keys = displayedVehicles().map(vehicleKey);
  if (!keys.length) return;
  const at = state.vehicleCursor ? keys.indexOf(state.vehicleCursor) : -1;
  let next;
  if (delta === "first") next = 0;
  else if (delta === "last") next = keys.length - 1;
  else next = at === -1 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + delta));
  state.vehicleCursor = keys[next];
  applyVehicleCursor();
  const el = vehicleNodeFor(state.vehicleCursor);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}
