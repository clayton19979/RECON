import { $, $$, fmtHours, get } from "./core.js";
import { esc, money } from "./shortcuts.js";
import { emptyState } from "./empty-states.js";
import { skeletonCards, skeletonRows } from "./skeletons.js";
import { STATUS_LABEL, state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { STALLED_AFTER_DAYS, isStalled, vehicleStatusPillClass } from "./vehicles-board.js";
import { openVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   REPORTS
   ================================================================== */
// Shared quick-range date math -- used by the Reports date filter and the
// A/P invoice list filter alike, so "This Week"/"This Month"/etc. mean the
// same thing everywhere in the app.
export function computeQuickRange(kind) {
  const now = new Date();
  // Local date, not toISOString(): that converts to UTC first, so any click
  // after ~7 PM in Merrillville computed *tomorrow's* date and "Today"
  // reported on a day that hadn't started.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  lot: "Lot Status",
  "vehicle-spend": "All Vehicles (Combined)",
  "vehicle-spend-recon": "Recon Vehicles Only",
  "vehicle-spend-we_owe": "We-Owe Only",
  "vehicle-profit": "Profit by Vehicle",
  technicians: "Technician Productivity",
};

const REPORT_SEGMENT = {
  "vehicle-spend-recon": "recon",
  "vehicle-spend-we_owe": "we_owe",
};

/* Three table/chart/summary shapes across five report types.

   Profit is its own shape rather than more columns on the spend table,
   because it counts something different: the spend table has one row per
   recon record and one per we-owe promise, so a car that was recon'd, sold,
   and came back appears twice. Profit is per physical car -- one row, both
   halves of its life, no double-counting. */
const reportShape = (type) =>
  type === "technicians" ? "technicians"
  : type === "vehicle-profit" ? "vehicle-profit"
  : type === "lot" ? "lot"
  : "vehicle-spend";

// Which /api/reports/… and /api/export/report/… each shape is backed by.
const REPORT_ENDPOINT = {
  lot: "lot",
  "vehicle-spend": "vehicle-spend",
  "vehicle-profit": "vehicle-profit",
  technicians: "technicians",
};

/* The lot report answers "how do things stand right now", so a date range
   would only ever hide a car for being old -- which is the car worth asking
   about. The range chips are hidden for it rather than disabled, so nobody
   is left wondering why clicking them does nothing. */
const IGNORES_DATE_RANGE = new Set(["lot"]);

/* The three piles, and what to say about each one.

   `blurb` is the short form the screen's group bar uses; `sentence` is the
   full one the printed sheet gets. The sheet is read by the owner on his own,
   as a PDF in his inbox, with nobody beside him to explain what a heading
   means -- so every section on paper says in a plain sentence what being in
   it actually means. `empty` is what to say when a pile has nothing in it:
   a section that silently disappears reads as a section that got lost. */
const LOT_GROUPS = [
  {
    key: "ready",
    label: "Ready to sell",
    blurb: "work finished — can go back on the lot",
    sentence: "Work on these is finished. They can go back on the lot.",
    empty: "No cars are finished right now.",
  },
  {
    key: "working",
    label: "In the shop",
    blurb: "being worked on now",
    sentence: "These are in the shop now. Still Needs says what each one is waiting on.",
    empty: "Nothing is in the shop right now.",
  },
  {
    key: "waiting",
    label: "Not started",
    blurb: "nothing done yet",
    sentence: "Nothing has been done to these yet.",
    empty: "Every car has been started.",
  },
];

/* What the table below is a count OF. "8 rows" is a database word; the lot
   report is the one an owner reads on his own, and it is counting cars.
   Shared by the screen's scope line and the printed sheet so they agree. */
function reportCountText(count, shape) {
  if (shape === "lot") return `${count} car${count === 1 ? "" : "s"} on the lot`;
  return `${count} row${count === 1 ? "" : "s"}`;
}

/* How long a car has sat, in words. "41d" is a code you have to learn; the
   owner reads this sheet a few times a month and shouldn't have to. */
function sittingText(days) {
  const n = Math.max(0, Math.round(Number(days) || 0));
  if (n === 0) return "today";
  return `${n} day${n === 1 ? "" : "s"}`;
}

/* How long this tech's quietest open ticket has sat, coloured on the same
   week boundary the board's Idle column uses so the two screens agree about
   which work has been forgotten. A tech holding nothing gets a dash rather
   than "today", which would read as "touched today" on an empty hand. */
function technicianIdleCell(row) {
  if (!row.open_count) return `<td class="num-col"><span class="muted-dash">—</span></td>`;
  const stalled = row.worst_idle_days >= STALLED_AFTER_DAYS;
  const title = stalled
    ? "Nothing has happened on this technician's quietest open ticket in over a week"
    : "Days since anything happened on this technician's quietest open ticket";
  return `<td class="num-col${stalled ? " money-bad" : ""}" title="${title}">${esc(sittingText(row.worst_idle_days))}</td>`;
}

/* Which car this row is, in one cell: the vehicle, then whether it's one of
   Walt's lot cars or a promise made to a customer (and to whom). Type used to
   be a column of its own, which cost a column's width to say one word. */
function lotVehicleCell(row) {
  const kind = row.segment === "recon"
    ? "Recon"
    : `We-owe${row.customer_name ? ` — ${esc(row.customer_name)}` : ""}`;
  return `${esc(row.vehicle)}<span class="cell-sub">${kind}</span>`;
}

const REPORT_STAT_CARDS = {
  lot: (rows) => lotStatCards(rows),
  "vehicle-spend": (rows) => vehicleSpendStatCards(rows),
  "vehicle-profit": (rows) => vehicleProfitStatCards(rows),
  technicians: (rows) => technicianStatCards(rows),
};

const REPORT_PREFS_KEY = "dao-report-view";

export function loadReportPrefs() {
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
  // Only restore a sort that was chosen for the report we're reopening --
  // sortShape is what says so. An older saved entry has no sortShape, so it
  // is treated as nobody's choice and the report opens in its own order.
  if (saved.sort && saved.sortShape === reportShape(state.reportType) && REPORT_SORTS[saved.sortShape][saved.sort.key]) {
    state.reportSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
    state.reportSortShape = saved.sortShape;
  }
}

export function saveReportPrefs() {
  try {
    localStorage.setItem(REPORT_PREFS_KEY, JSON.stringify({
      type: state.reportType, range: state.reportRange,
      start: state.reportStart, end: state.reportEnd,
      sort: state.reportSort, sortShape: state.reportSortShape,
    }));
  } catch { /* private mode / quota -- the screen still works, it just forgets */ }
}

/* ---------- range ---------- */

// Applying a quick range writes the two date inputs as well as state, so the
// From/To fields always show what's actually being reported on -- the old
// version left them blank whenever the range came from anywhere but a click.
export function setReportRange(kind) {
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
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
  });
  $$("#view-reports .chip[data-report-range]").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.reportRange === state.reportRange);
  });
  $("#report-start").value = state.reportStart;
  $("#report-end").value = state.reportEnd;
  // Hand-edited dates light the inputs themselves, so the toolbar never
  // looks like nothing is selected.
  const custom = !state.reportRange && (state.reportStart || state.reportEnd);
  $$("#view-reports .report-date").forEach((el) => el.classList.toggle("custom", !!custom));
  // A report that ignores dates must not show date controls -- leaving chips
  // there that quietly do nothing is worse than not offering them.
  $("#report-range-controls").hidden = IGNORES_DATE_RANGE.has(state.reportType);
}

function reportParams() {
  const params = new URLSearchParams();
  // The lot report is a snapshot of now; sending it a range would be asking
  // it to hide cars for being old, which is the opposite of its job.
  if (IGNORES_DATE_RANGE.has(state.reportType)) return params;
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
  const path = REPORT_ENDPOINT[reportShape(state.reportType)];
  const query = params.toString();
  return `/api/export/report/${path}.csv${query ? `?${query}` : ""}`;
}

/* ---------- sorting ---------- */

const REPORT_SORTS = {
  lot: {
    // Grouping is the point of this report, so sorting is within a group.
    idle:    { label: "Sitting",        type: "number", value: (r) => r.idle_days || 0 },
    stock:   { label: "Stock #",        type: "text",   value: (r) => r.stock_number || "" },
    vehicle: { label: "Vehicle",        type: "text",   value: (r) => r.vehicle || "" },
    needs:   { label: "Still Needs",    type: "text",   value: (r) => r.needs || "" },
    cost:    { label: "Spent So Far",   type: "number", value: (r) => r.actual_cost },
    left:    { label: "Still To Spend", type: "number", value: (r) => r.remaining_cost || 0 },
    age:     { label: "Days On Lot",    type: "number", value: (r) => r.age_days || 0 },
  },
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
  "vehicle-profit": {
    stock:    { label: "Stock #",     type: "text",   value: (r) => r.stock_number || "" },
    vehicle:  { label: "Vehicle",     type: "text",   value: (r) => r.vehicle || "" },
    vin:      { label: "VIN",         type: "text",   value: (r) => r.vin || "" },
    hours:    { label: "Hours",       type: "number", value: (r) => r.labor_hours || 0 },
    purchase: { label: "Purchase",    type: "number", value: (r) => r.purchase_price },
    cost:     { label: "Total In",    type: "number", value: (r) => r.total_invested },
    sale:     { label: "Sold For",    type: "number", value: (r) => r.sale_price || 0 },
    profit:   { label: "Profit",      type: "number", value: (r) => r.profit || 0 },
    margin:   { label: "Margin",      type: "number", value: (r) => r.margin_pct || 0 },
  },
  technicians: {
    technician: { label: "Technician",  type: "text",   value: (r) => r.technician || "" },
    ros:        { label: "ROs",         type: "number", value: (r) => r.ro_count },
    completed:  { label: "Completed",   type: "number", value: (r) => r.completed_count },
    open:       { label: "Still Open",  type: "number", value: (r) => r.open_count },
    idle:       { label: "Sitting",     type: "number", value: (r) => (r.open_count ? r.worst_idle_days : -1) },
    hours:      { label: "Hours",       type: "number", value: (r) => r.labor_hours },
  },
};

/* Where each report starts before anyone clicks a column.

   The lot report opens on Stock #, A to Z, and the other three on their money
   column, high to low -- because they are read for different reasons. A spend
   report answers "where did it go", and the biggest number first is the
   answer. The lot report is read with a particular car in mind ("what's
   happening with the Elantra?"), and a list ordered by dollars puts that car
   somewhere unpredictable, so finding it means reading every row. In stock
   order it is always where you'd expect it. */
const DEFAULT_SORT = {
  lot: { key: "stock", dir: "asc" },
  "vehicle-spend": { key: "cost", dir: "desc" },
  "vehicle-profit": { key: "cost", dir: "desc" },
  // No money column to sort on -- labor here is never charged out -- so the
  // technician report opens on the tech carrying the most hours.
  technicians: { key: "hours", dir: "desc" },
};

function defaultSortFor(shape) {
  return { ...(DEFAULT_SORT[shape] || DEFAULT_SORT["vehicle-spend"]) };
}

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
  const shape = reportShape(state.report.type);
  return sortReportRows(state.report.rows, shape, state.reportSort);
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
   The numbers a manager reads a spend report for, above the table rather
   than buried in its footer. They describe exactly the rows below them --
   same range, same segment -- so there's nothing to reconcile. */
function renderReportStats(rows, shape) {
  const cards = (REPORT_STAT_CARDS[shape] || REPORT_STAT_CARDS["vehicle-spend"])(rows);
  $("#report-stats").innerHTML = cards.map((c) => `
      <div class="stat">
        <div class="stat-label">${esc(c.label)}</div>
        <div class="stat-value${c.tone ? ` ${c.tone}` : ""}">${esc(c.value)}</div>
        <div class="stat-sub">${esc(c.sub)}</div>
      </div>`).join("");
}

/* Walt's four questions as four numbers: what can go out, what's moving,
   what hasn't been touched, and what the lot has cost so far. The counts are
   the headline -- the money is what he does his own arithmetic on. */
function lotStatCards(rows) {
  const count = (key) => rows.filter((r) => r.lot_bucket === key).length;
  const spent = rows.reduce((s, r) => s + (r.actual_cost || 0), 0);
  const left = rows.reduce((s, r) => s + (r.remaining_cost || 0), 0);
  // The same isStalled the board's card counts by, imported rather than
  // restated -- this screen and the board are two views of one lot, and a
  // second copy of the rule is a second answer waiting to happen.
  const stalled = rows.filter(isStalled).length;
  const waiting = count("waiting");
  return [
    { label: "Ready To Sell", value: String(count("ready")), sub: `of ${rows.length} on the lot`, tone: count("ready") ? "good" : "" },
    { label: "In The Shop", value: String(count("working")), sub: "being worked on now" },
    {
      label: "Not Started",
      value: String(waiting),
      sub: stalled ? `${stalled} untouched ${STALLED_AFTER_DAYS}+ days` : "nothing stalled",
      tone: stalled ? "warn" : "",
    },
    { label: "Spent On The Lot", value: money(spent), sub: left ? `${money(left)} of quoted work still to do` : "nothing else quoted" },
  ];
}

function vehicleSpendStatCards(rows) {
  const recon = rows.filter((r) => r.segment === "recon").length;
  const total = rows.reduce((s, r) => s + r.actual_cost, 0);
  const quoted = rows.reduce((s, r) => s + (r.quoted_cost || 0), 0);
  return [
    { label: "Vehicles", value: String(rows.length), sub: `${recon} recon · ${rows.length - recon} we-owe` },
    { label: "Total Cost", value: money(total), sub: "received parts + labor" },
    { label: "Average Per Vehicle", value: money(rows.length ? total / rows.length : 0), sub: quoted ? `${money(quoted)} quoted overall` : "nothing quoted in this range" },
  ];
}

/* The owner's four numbers. Sold and unsold are kept apart deliberately: an
   unsold car has money in it and no profit yet, and averaging those zeros
   into the margin would make a good month look like a bad one.

   "Sold" and "profit is knowable" are two different questions now that the
   lot's purchase price isn't entered here (Walt keeps that figure -- see
   CLAUDE.md). A sold car whose purchase price nobody recorded has no honest
   profit, but it is still sold, and counting it as stock on hand would be a
   second wrong answer on top of the first. */
function vehicleProfitStatCards(rows) {
  const sold = rows.filter((r) => r.sale_price !== null && r.sale_price !== undefined);
  const withProfit = sold.filter((r) => r.profit !== null && r.profit !== undefined);
  const invested = rows.reduce((s, r) => s + (r.total_invested || 0), 0);
  const profit = withProfit.reduce((s, r) => s + r.profit, 0);
  const revenue = withProfit.reduce((s, r) => s + (r.sale_price || 0), 0);
  const weOwe = rows.reduce((s, r) => s + (r.we_owe_net_cost || 0), 0);
  const unpriced = sold.length - withProfit.length;
  return [
    { label: "Vehicles", value: String(rows.length), sub: `${sold.length} sold · ${rows.length - sold.length} still in stock` },
    { label: "Total Invested", value: money(invested), sub: "what the shop spent: recon + we-owe" },
    {
      label: "Profit On Sold",
      value: withProfit.length ? money(profit) : "—",
      sub: !withProfit.length
        ? (unpriced ? `${unpriced} sold — profit needs a purchase price` : "nothing sold in this range")
        : `${(profit / revenue * 100).toFixed(1)}% margin on ${money(revenue)}${unpriced ? ` · ${unpriced} without a purchase price` : ""}`,
      tone: withProfit.length && profit < 0 ? "crit" : "",
    },
    {
      label: "We-Owe Cost",
      value: money(weOwe),
      sub: weOwe ? "came off the above, net of customer payments" : "no we-owe work in this range",
      tone: weOwe > 0 ? "warn" : "",
    },
  ];
}

function technicianStatCards(rows) {
  const active = rows.filter((r) => r.ro_count > 0);
  const ros = rows.reduce((s, r) => s + r.ro_count, 0);
  const done = rows.reduce((s, r) => s + r.completed_count, 0);
  const hours = rows.reduce((s, r) => s + r.labor_hours, 0);
  const open = rows.reduce((s, r) => s + r.open_count, 0);
  const worstIdle = rows.reduce((s, r) => Math.max(s, r.open_count ? r.worst_idle_days : 0), 0);
  return [
    { label: "Technicians Working", value: String(active.length), sub: `of ${rows.length} on staff` },
    { label: "Repair Orders", value: String(ros), sub: `${done} completed${ros ? ` · ${Math.round((done / ros) * 100)}%` : ""}` },
    { label: "Labor Hours", value: String(Math.round(hours * 10) / 10), sub: ros ? `${(hours / ros).toFixed(1)} avg per RO` : "no orders in this range" },
    // Replaces a labor-cost card that was structurally $0.00 -- labor on
    // recon and we-owe is never charged out. What somebody acts on is which
    // tech is still holding a ticket and how long it has sat.
    {
      label: "Still Open",
      value: String(open),
      // "worst sitting 0 days" is a sentence nobody says. Everything moving is
      // the good case and should read like one.
      sub: !open ? "nothing left with a tech"
        : worstIdle === 0 ? "all touched today"
        : `worst sitting ${sittingText(worstIdle)}`,
      tone: worstIdle >= STALLED_AFTER_DAYS ? "warn" : "",
    },
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
export function barChart({ title, note, legend = "", items, rowAttrs = null, rowClass = null }) {
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
    // Hours, not dollars. Labor here is never charged out, so charting labor
    // cost drew one flat empty bar per technician and called it a result.
    const withLabor = rows.filter((r) => r.labor_hours > 0)
      .sort((a, b) => b.labor_hours - a.labor_hours);
    const items = withLabor.slice(0, CHART_LIMIT)
      .map((r) => ({ label: r.technician, value: r.labor_hours, display: fmtHours(r.labor_hours) }));
    target.innerHTML = barChart({
      title: "Hours logged by technician",
      note: withLabor.length > CHART_LIMIT
        ? `Top ${CHART_LIMIT} of ${withLabor.length} technicians with logged labor`
        : (items.length ? `${items.length} technician${items.length === 1 ? "" : "s"} with logged labor` : ""),
      items,
    }) || chartNothingToPlot(rows.length, "hours");
    return;
  }
  if (shape === "vehicle-profit") {
    // Only sold cars can be charted by profit -- one still on the lot has no
    // bar to draw, and plotting it at zero would read as breaking even.
    const sold = rows.filter((r) => r.profit !== null && r.profit !== undefined)
      .sort((a, b) => b.profit - a.profit);
    const items = sold.slice(0, CHART_LIMIT).map((r) => ({
      label: `${r.stock_number || "—"} · ${r.vehicle}`,
      value: Math.max(r.profit, 0),
      display: money(r.profit),
    }));
    target.innerHTML = barChart({
      title: "Profit by vehicle",
      note: sold.length > CHART_LIMIT
        ? `Top ${CHART_LIMIT} of ${sold.length} sold vehicles`
        : (items.length ? `${items.length} sold vehicle${items.length === 1 ? "" : "s"}` : ""),
      items,
    }) || chartNothingToPlot(rows.length, "sold vehicles");
    return;
  }
  const priced = rows.filter((r) => r.actual_cost > 0).sort((a, b) => b.actual_cost - a.actual_cost);
  const items = priced.slice(0, CHART_LIMIT).map((r) => ({
    label: `${r.stock_number || r.customer_name || "—"} · ${r.vehicle}`,
    value: r.actual_cost,
    display: money(r.actual_cost),
    marker: r.quoted_cost || 0,
    markerLabel: r.quoted_cost ? `Quoted ${money(r.quoted_cost)}` : "",
    seg: r.segment,
    refId: r.segment === "recon" ? r.recon_id : r.we_owe_id,
  }));
  // The tallest bar is the car you want to open -- every bar is a link to
  // its vehicle, same interaction language as the board's idle chart.
  // The wrapper only exists when there's something to wrap: an empty report
  // must leave this panel gone entirely, not draw an empty shell that holds
  // the chart's slot open above the empty state.
  const chart = barChart({
    title: "What we have in it",
    note: priced.length > CHART_LIMIT ? `Top ${CHART_LIMIT} of ${priced.length} vehicles with cost` : "Click a bar to open the vehicle",
    legend: `<span class="legend-item"><span class="legend-swatch"></span>Cost</span>
             <span class="legend-item"><span class="legend-swatch marker"></span>Quoted</span>`,
    items,
    rowAttrs: (i) => (i.refId != null ? `role="button" tabindex="0" data-seg="${esc(i.seg)}" data-ref-id="${i.refId}"` : ""),
  }) || chartNothingToPlot(rows.length, "cost");
  target.innerHTML = chart ? `<div class="board-chart">${chart}</div>` : "";
}

/* ---------- table ---------- */

function reportEmptyState(shape) {
  // The technicians endpoint returns one row per tech on staff regardless of
  // activity, so an empty result can only mean the roster itself is empty --
  // "try a wider range" would send the user in a circle.
  if (shape === "technicians") {
    return `<div class="panel">${emptyState({
      icon: "staff",
      title: "No technicians on staff",
      hint: "Add your technicians in Staff and their repair orders, hours and open work will roll up here.",
      actions: `<button type="button" class="btn btn-ghost btn-sm" data-nav="staff">Go to Staff</button>`,
    })}</div>`;
  }
  const ranged = state.reportStart || state.reportEnd;
  return `<div class="panel">${emptyState({
    icon: "vehicle",
    title: "No vehicles in this range",
    hint: ranged
      ? "Nothing was worked on between those dates. Try a wider range, or one of the quick ranges above."
      : "Nothing to report yet — this covers all time, so the shop has no activity of this kind recorded at all.",
    actions: ranged ? `<button type="button" class="btn btn-ghost btn-sm" data-report-range="all">Show all time</button>` : "",
  })}</div>`;
}

// Shared by the real table and its loading skeleton, so the two can never
// draw a different column count -- the skeleton renders with hasDeposits
// forced true (the max shape) so the real table only ever narrows once data
// lands, never widens.
function reportHeaderRow(shape, hasDeposits) {
  if (shape === "lot") {
    // No Type or Status column. The section heading a row sits under already
    // IS its status, in the words Walt uses -- and a raw ticket status beside
    // it contradicted the heading as often as it agreed ("Not started" next
    // to a pill reading ESTIMATE, "In the shop" next to ACQUIRED). Type moved
    // into the Vehicle cell, where it costs a line instead of a column.
    return ["stock", "vehicle", "needs"].map((k) => reportSortHeader("lot", k)).join("")
      + ["cost", "left", "idle"].map((k) => reportSortHeader("lot", k, "num-col")).join("");
  }
  if (shape === "technicians") {
    return reportSortHeader("technicians", "technician")
      + ["ros", "completed", "open", "idle", "hours"].map((k) => reportSortHeader("technicians", k, "num-col")).join("");
  }
  if (shape === "vehicle-profit") {
    return ["stock", "vehicle", "vin"].map((k) => reportSortHeader("vehicle-profit", k)).join("")
      + ["hours", "purchase", "cost", "sale", "profit", "margin"].map((k) => reportSortHeader("vehicle-profit", k, "num-col")).join("");
  }
  return `${reportSortHeader("vehicle-spend", "stock")}${reportSortHeader("vehicle-spend", "vehicle")}${reportSortHeader("vehicle-spend", "segment")}${reportSortHeader("vehicle-spend", "status")}${reportSortHeader("vehicle-spend", "tech")}${reportSortHeader("vehicle-spend", "cost", "num-col")}${hasDeposits ? reportSortHeader("vehicle-spend", "paid", "num-col") + reportSortHeader("vehicle-spend", "net", "num-col") : ""}`;
}

/* The lot, grouped the way Walt asks about it rather than as one flat list.
   The group headings are the answer to "what's ready / what's being worked
   on"; the Needs column is the answer to "what does that one still need".
   Rows stay clickable so a question about a car ends on that car's page. */
function renderLotTable(rows) {
  const line = (r) => {
    const refId = r.segment === "recon" ? r.recon_id : r.we_owe_id;
    const clickable = refId != null;
    const stalled = isStalled(r);
    return `<tr${clickable ? ` class="clickable" data-seg="${esc(r.segment)}" data-ref-id="${refId}" tabindex="0" title="Open this vehicle"` : ""}>
      <td class="num lot-stock">${esc(r.stock_number || "—")}</td>
      <td>${lotVehicleCell(r)}</td>
      <td class="lot-needs">${esc(r.needs || "—")}</td>
      <td class="num-col">${money(r.actual_cost)}</td>
      <td class="num-col">${r.remaining_cost ? money(r.remaining_cost) : "—"}</td>
      <td class="num-col${stalled ? " money-bad" : ""}" title="${stalled ? "Nothing has happened on this car in over a week" : "Days since anything happened"}">${esc(sittingText(r.idle_days))}</td>
    </tr>`;
  };
  const sections = LOT_GROUPS.map((group) => {
    const inGroup = rows.filter((r) => r.lot_bucket === group.key);
    const spent = inGroup.reduce((s, r) => s + (r.actual_cost || 0), 0);
    const left = inGroup.reduce((s, r) => s + (r.remaining_cost || 0), 0);
    // An empty pile says so rather than disappearing. A heading that isn't
    // there is indistinguishable from a heading you scrolled past.
    const note = inGroup.length
      ? `${inGroup.length} car${inGroup.length === 1 ? "" : "s"} · ${esc(group.blurb)}`
      : esc(group.empty);
    const cash = inGroup.length
      ? `<span class="lot-group-money">${money(spent)} spent${left ? ` · ${money(left)} still to spend` : ""}</span>`
      : "";
    return `<tr class="lot-group-head${inGroup.length ? "" : " is-empty"}"><td colspan="6">
        <span class="lot-group-name">${esc(group.label)}</span>
        <span class="lot-group-note">${note}</span>
        ${cash}
      </td></tr>${inGroup.map(line).join("")}`;
  }).join("");
  const totalSpent = rows.reduce((s, r) => s + (r.actual_cost || 0), 0);
  const totalLeft = rows.reduce((s, r) => s + (r.remaining_cost || 0), 0);
  return `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head lot-table"><thead><tr>
    ${reportHeaderRow("lot")}
    </tr></thead>
    <tbody>${sections}</tbody>
    <tfoot><tr><td colspan="3">Whole lot (${rows.length} car${rows.length === 1 ? "" : "s"})</td>
      <td class="num-col">${money(totalSpent)}</td><td class="num-col">${totalLeft ? money(totalLeft) : "—"}</td><td></td></tr></tfoot>
    </table></div></div>`;
}

/* One row per physical car, whatever mix of recon records and we-owe
   promises it accumulated. The we-owe column is the one the owner is really
   looking for: work done after the sale, which comes straight off the margin
   and until now was invisible on any profit number the shop could produce. */
function renderProfitTable(rows) {
  const sum = (fn) => rows.reduce((s, r) => s + (fn(r) || 0), 0);
  const sold = rows.filter((r) => r.profit !== null && r.profit !== undefined);
  const totalProfit = sold.reduce((s, r) => s + r.profit, 0);
  const cell = (r) => {
    // An unsold car has no profit yet -- a dash, not a zero and not a loss.
    const unsold = r.profit === null || r.profit === undefined;
    const tone = unsold ? "" : r.profit < 0 ? " class=\"num-col money-bad\"" : " class=\"num-col money-good\"";
    // Deliberately not click-to-open: a row here can stand for a recon record
    // AND one or more we-owe promises, so there is no single vehicle page it
    // could honestly navigate to. The VIN (with its copy button) is the handle.
    return `<tr title="${esc([
      `${money(r.purchase_price)} purchase`,
      `${money(r.recon_cost)} recon`,
      r.we_owe_count ? `${r.we_owe_count} we-owe promise${r.we_owe_count === 1 ? "" : "s"} costing ${money(r.we_owe_net_cost)} net` : "no we-owe work",
    ].join(" · "))}">
      <td class="num">${esc(r.stock_number || "—")}</td>
      <td>${esc(r.vehicle || "—")}</td>
      <td class="num cell-vin">${r.vin ? `${esc(r.vin)} <button type="button" class="copy-btn" data-copy="${esc(r.vin)}" data-copy-label="VIN" title="Copy VIN" aria-label="Copy VIN">⧉</button>` : "—"}</td>
      <td class="num-col" title="Hours flagged by techs on this car">${r.labor_hours ? fmtHours(r.labor_hours) : "—"}</td>
      <td class="num-col">${money(r.purchase_price)}</td>
      <td class="num-col" title="${esc(`${money(r.purchase_price)} purchase + ${money(r.recon_cost)} recon + ${money(r.we_owe_net_cost)} we-owe`)}">${money(r.total_invested)}</td>
      <td class="num-col">${r.sale_price != null ? money(r.sale_price) : "—"}</td>
      <td${tone}>${unsold ? "—" : money(r.profit)}</td>
      <td class="num-col">${r.margin_pct != null ? `${r.margin_pct}%` : "—"}</td>
    </tr>`;
  };
  return `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head"><thead><tr>
    ${reportHeaderRow("vehicle-profit")}
    </tr></thead>
    <tbody>${rows.map(cell).join("")}</tbody>
    <tfoot><tr>
      <td colspan="3">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"}, ${sold.length} sold)</td>
      <td class="num-col">${fmtHours(sum((r) => r.labor_hours))}</td>
      <td class="num-col">${money(sum((r) => r.purchase_price))}</td>
      <td class="num-col">${money(sum((r) => r.total_invested))}</td>
      <td class="num-col">${money(sum((r) => r.sale_price))}</td>
      <td class="num-col">${money(totalProfit)}</td>
      <td class="num-col">—</td>
    </tr></tfoot>
    </table></div></div>`;
}

function renderReportTable(rows, shape) {
  if (!rows.length) return reportEmptyState(shape);
  if (shape === "technicians") {
    const working = rows.filter((r) => r.ro_count > 0).length;
    const totRos = rows.reduce((s, r) => s + r.ro_count, 0);
    const totDone = rows.reduce((s, r) => s + r.completed_count, 0);
    const totHours = Math.round(rows.reduce((s, r) => s + r.labor_hours, 0) * 100) / 100;
    const totOpen = rows.reduce((s, r) => s + r.open_count, 0);
    const worstIdle = rows.reduce((s, r) => Math.max(s, r.open_count ? r.worst_idle_days : 0), 0);
    return `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head"><thead><tr>
      ${reportHeaderRow("technicians")}
      </tr></thead>
      <tbody>${rows.map((r) => `<tr${r.ro_count ? "" : ' class="row-muted"'}><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.open_count || "—"}</td>${technicianIdleCell(r)}<td class="num-col">${Math.round(r.labor_hours * 100) / 100}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total (${working} working)</td><td class="num-col">${totRos}</td><td class="num-col">${totDone}</td><td class="num-col">${totOpen || "—"}</td><td class="num-col">${totOpen ? esc(sittingText(worstIdle)) : "—"}</td><td class="num-col">${totHours}</td></tr></tfoot>
      </table></div></div>`;
  }
  if (shape === "lot") return renderLotTable(rows);
  if (shape === "vehicle-profit") return renderProfitTable(rows);
  const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
  const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
  const hasDeposits = totalPaid > 0;
  // Rows navigate to the vehicle -- Reports is where you find the problem
  // car, so it shouldn't make you memorize a stock number to go act on it.
  return `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head"><thead><tr>
    ${reportHeaderRow("vehicle-spend", hasDeposits)}
    </tr></thead>
    <tbody>${rows.map((r) => {
      const refId = r.segment === "recon" ? r.recon_id : r.we_owe_id;
      const clickable = refId != null;
      return `<tr${clickable ? ` class="clickable" data-seg="${esc(r.segment)}" data-ref-id="${refId}" tabindex="0" title="Open this vehicle"` : ""}><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` <span class="cell-sub">(${esc(r.customer_name)})</span>` : ""}</td>
    <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td><span class="pill ${vehicleStatusPillClass(r)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
    <td>${esc((r.technicians || []).join(", ")) || "—"}</td><td class="num-col">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`;
    }).join("")}</tbody>
    <tfoot><tr><td colspan="5">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr></tfoot>
    </table></div></div>`;
}

/* What the report is scoped to, in words. The lot report has no range, so
   saying "All time" would be a lie of a different kind -- it is a snapshot,
   and a printed one needs to say when it was taken. */
function reportScopeLabel(type, start, end) {
  if (IGNORES_DATE_RANGE.has(type)) {
    // Spelled out -- weekday and all. This is the one date on the sheet now,
    // and it's read off a screen or a phone, not filed in a folder where a
    // terse stamp would do.
    return `As it stands ${new Date().toLocaleString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    })}`;
  }
  return reportDateRangeLabel(start, end);
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
  const rangeLabel = reportScopeLabel(type, start, end);
  const shape = reportShape(type);
  // The printout keeps the screen's reading order: summary numbers first,
  // then the table -- a spend report with no total line is a worse artifact
  // than the screen it came from.
  const cards = (REPORT_STAT_CARDS[shape] || REPORT_STAT_CARDS["vehicle-spend"])(rows);
  const summary = `<div class="print-summary">${cards.map((c) => `
    <div><div class="ps-label">${esc(c.label)}</div><div class="ps-value">${esc(c.value)}</div><div class="ps-sub">${esc(c.sub)}</div></div>`).join("")}</div>`;
  // The paper must say what the screen knew: how much is in the table and in
  // what order, so somebody reading it alone knows where to look for a car
  // and can tell one snapshot from another.
  const sortSpec = REPORT_SORTS[shape][state.reportSort.key] || REPORT_SORTS[shape].cost;
  const dirWord = sortSpec.type === "number"
    ? (state.reportSort.dir === "desc" ? "high to low" : "low to high")
    : (state.reportSort.dir === "asc" ? "A to Z" : "Z to A");
  const countWord = reportCountText(rows.length, shape);
  const scope = `<div class="print-scope">
    <span class="scope-count">${countWord}</span>
    <span>· listed by ${esc(sortSpec.label)}, ${dirWord}</span>
  </div>`;
  let body;
  if (shape === "lot") {
    // The paper Walt is handed. Same three groups, same wording as the
    // screen, with the group headings doing the work the colours do on
    // screen -- there is no colour on the printer he uses.
    const sections = LOT_GROUPS.map((group) => {
      const inGroup = rows.filter((r) => r.lot_bucket === group.key);
      const spent = inGroup.reduce((s, r) => s + (r.actual_cost || 0), 0);
      const left = inGroup.reduce((s, r) => s + (r.remaining_cost || 0), 0);
      const head = `<div class="print-subhead">${esc(group.label)} — ${inGroup.length} car${inGroup.length === 1 ? "" : "s"}</div>`;
      // A pile with nothing in it is an answer too: "no cars are finished
      // right now" is worth reading, and a section that quietly vanishes
      // leaves you wondering whether the sheet is complete.
      if (!inGroup.length) return `${head}<p class="print-group-note">${esc(group.empty)}</p>`;
      return `${head}
        <p class="print-group-note">${esc(group.sentence)}</p>
        <table class="print-table report">
          ${/* num-col, not num: only num-col right-aligns and turns on
               tabular figures in print. The money columns on this sheet have
               always used `num`, which is the identifier style (mono, left) --
               so $1,020.00 and $95.00 printed with their decimal points in
               different places, down the one column an owner actually adds up
               by eye. Stock # keeps `num`; that one really is an identifier. */ ""}
          <thead><tr><th>Stock #</th><th>Vehicle</th><th>Still needs</th><th class="num-col">Spent so far</th><th class="num-col">Still to spend</th><th class="num-col">Sitting</th></tr></thead>
          <tbody>${inGroup.map((r) => `<tr>
            <td class="num">${esc(r.stock_number || "—")}</td>
            <td>${esc(r.vehicle)}<span class="print-dim"> · ${r.segment === "recon" ? "Recon" : `We-owe${r.customer_name ? ` — ${esc(r.customer_name)}` : ""}`}</span></td>
            <td>${esc(r.needs || "—")}</td>
            <td class="num-col">${money(r.actual_cost)}</td>
            <td class="num-col">${r.remaining_cost ? money(r.remaining_cost) : "—"}</td>
            <td class="num-col">${esc(sittingText(r.idle_days))}</td>
          </tr>`).join("")}</tbody>
          <tfoot><tr>
            <td colspan="3">${esc(group.label)} — ${inGroup.length} car${inGroup.length === 1 ? "" : "s"}</td>
            <td class="num-col">${money(spent)}</td>
            <td class="num-col">${left ? money(left) : "—"}</td>
            <td></td>
          </tr></tfoot>
        </table>`;
    }).join("");
    const totalSpent = rows.reduce((s, r) => s + (r.actual_cost || 0), 0);
    const totalLeft = rows.reduce((s, r) => s + (r.remaining_cost || 0), 0);
    body = `${sections}<div class="print-totals"><div class="tl-row"><span>Spent on the whole lot</span><span class="num">${money(totalSpent)}</span></div>
      <div class="tl-row grand"><span>Still to spend</span><span class="num">${money(totalLeft)}</span></div></div>`;
  } else if (shape === "technicians") {
    const working = rows.filter((r) => r.ro_count > 0).length;
    const totRos = rows.reduce((s, r) => s + r.ro_count, 0);
    const totDone = rows.reduce((s, r) => s + r.completed_count, 0);
    const totalHours = rows.reduce((s, r) => s + r.labor_hours, 0);
    const totalOpen = rows.reduce((s, r) => s + r.open_count, 0);
    const worstIdle = rows.reduce((s, r) => Math.max(s, r.open_count ? r.worst_idle_days : 0), 0);
    body = `
      <table class="print-table report">
        <thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Still Open</th><th class="num-col">Sitting</th><th class="num-col">Hours</th></tr></thead>
        <tbody>${rows.map((r) => `<tr${r.ro_count ? "" : ' class="idle"'}><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.open_count || "—"}</td><td class="num-col">${r.open_count ? esc(sittingText(r.worst_idle_days)) : "—"}</td><td class="num-col">${Math.round(r.labor_hours * 100) / 100}</td></tr>`).join("")}</tbody>
        <tfoot>
          <tr><td>Report Total (${working} of ${rows.length} working)</td><td class="num-col">${totRos}</td><td class="num-col">${totDone}</td><td class="num-col">${totalOpen || "—"}</td><td class="num-col">${totalOpen ? esc(sittingText(worstIdle)) : "—"}</td><td class="num-col">${Math.round(totalHours * 100) / 100}</td></tr>
          <tr class="tfoot-space" aria-hidden="true"><td colspan="6"></td></tr>
        </tfoot>
      </table>`;
  } else if (shape === "vehicle-profit") {
    const sum = (fn) => rows.reduce((s, r) => s + (fn(r) || 0), 0);
    const sold = rows.filter((r) => r.profit !== null && r.profit !== undefined);
    body = `
      <table class="print-table report">
        <thead><tr><th>Stock #</th><th>Vehicle</th><th>VIN</th><th class="num-col">Hours</th><th class="num-col">Purchase</th><th class="num-col">Total In</th><th class="num-col">Sold For</th><th class="num-col">Profit</th><th class="num-col">Margin</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle || "—")}</td><td class="num">${esc(r.vin || "—")}</td>
        <td class="num-col">${r.labor_hours ? fmtHours(r.labor_hours) : "—"}</td>
        <td class="num-col">${money(r.purchase_price)}</td><td class="num-col">${money(r.total_invested)}</td>
        <td class="num-col">${r.sale_price != null ? money(r.sale_price) : "—"}</td>
        <td class="num-col">${r.profit != null ? money(r.profit) : "—"}</td>
        <td class="num-col">${r.margin_pct != null ? `${r.margin_pct}%` : "—"}</td></tr>`).join("")}</tbody>
        <tfoot>
          <tr><td colspan="3">Report Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"}, ${sold.length} sold)</td>
            <td class="num-col">${fmtHours(sum((r) => r.labor_hours))}</td>
            <td class="num-col">${money(sum((r) => r.purchase_price))}</td><td class="num-col">${money(sum((r) => r.total_invested))}</td>
            <td class="num-col">${money(sum((r) => r.sale_price))}</td><td class="num-col">${money(sold.reduce((s, r) => s + r.profit, 0))}</td><td class="num-col"></td></tr>
          <tr class="tfoot-space" aria-hidden="true"><td colspan="9"></td></tr>
        </tfoot>
      </table>`;
  } else {
    const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
    const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
    const hasDeposits = totalPaid > 0;
    body = `
      <table class="print-table report">
        <thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technician(s)</th><th class="num-col">Cost</th>${hasDeposits ? `<th class="num-col">Customer Paid</th><th class="num-col">Net to Shop</th>` : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` <span class="print-dim">(${esc(r.customer_name)})</span>` : ""}</td>
        <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td>
        <td>${esc((r.technicians || []).join(", ")) || "—"}</td><td class="num-col">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`).join("")}</tbody>
        <tfoot>
          <tr><td colspan="4">Report Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col"></td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr>
          <tr class="tfoot-space" aria-hidden="true"><td colspan="${hasDeposits ? 8 : 6}"></td></tr>
        </tfoot>
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
        ${/* A snapshot report's range label already IS the moment it was
             taken, so a second "Generated" line beneath it stamped the same
             instant twice. A dated report keeps it, because when it was run
             and what period it covers are genuinely different facts. */ ""}
        ${IGNORES_DATE_RANGE.has(type) ? "" : `<div class="print-generated">Generated ${esc(generated)}</div>`}
      </div>
    </header>
    ${scope}
    ${summary}
    ${body}
    ${/* No signature block. These go out as a PDF by email -- nobody signs
         one, and a pair of ruled blanks at the bottom of a screen-read
         document just looks like the sheet is missing something. The printed
         repair ticket keeps its sign-off; that one really is paper. */ ""}
    <div class="print-end">
      <div class="print-end-line">End of report — ${esc(REPORT_TITLES[type] || type)} · ${esc(countWord)}</div>
    </div>
    <footer class="print-foot">
      <span>RECON · Discount Auto Repair</span>
      <span>${esc(REPORT_TITLES[type] || type)} · ${esc(rangeLabel)}</span>
    </footer>
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
  // Same shell the real table renders into (table-wrap/table-scroll/
  // sticky-head, a real header) so switching reports doesn't visibly jump
  // height or flash the header in once data lands. Rendered at the max
  // column count (deposits included) so the real table only ever narrows.
  const shape = reportShape(state.reportType);
  const cols = shape === "technicians" ? 6 : 8;
  $("#report-output").innerHTML = `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head"><thead><tr>
    ${reportHeaderRow(shape, true)}
    </tr></thead><tbody>${skeletonRows(cols)}</tbody></table></div></div>`;
}

// The view loader, so opening Reports shows the last report you were reading
// instead of an empty form waiting for a Generate click.
export async function loadReportsView() {
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
  // The scope line states in words what the cards are counting -- report,
  // range, row count -- so the numbers can't be misread.
  $("#report-scope").textContent =
    `${REPORT_TITLES[state.report.type]} · ${reportScopeLabel(state.report.type, state.report.start, state.report.end)} · ${reportCountText(rows.length, shape)}`;
  $("#report-print").disabled = !rows.length;
  // <a> has no native disabled attribute -- aria-disabled + the CSS rule
  // that kills pointer-events is what actually stops the click, matching
  // the Print button sitting right next to it for the same empty state.
  if (rows.length) $("#report-csv").removeAttribute("aria-disabled");
  else $("#report-csv").setAttribute("aria-disabled", "true");
  state.printSurfaceOwner = "report";
  $("#print-report").innerHTML = renderPrintReport(rows, state.report.type, state.report.start, state.report.end);
}

// Rapid chip/segment clicks race their fetches; only the newest request may
// paint, or "Today" can end up captioning last year's rows.
let reportSeq = 0;

async function generateReport() {
  const seq = ++reportSeq;
  const type = state.reportType;
  const shape = reportShape(type);
  /* Each shape gets its own reading order until somebody chooses otherwise.

     Two things used to go wrong here, and both left the lot report ordered by
     dollars -- the one order that makes a particular car hard to find:
     a sort key from another shape ("hours" on the lot report) sorted by
     nothing at all, and a key that happens to exist on both (Cost, Stock #)
     came along for the ride from whatever was last on screen. Neither was
     ever a choice anyone made about THIS report.

     reportSortShape records which shape the current sort was chosen for, so a
     click on a column header survives (same shape) while an inherited or
     invalid one is replaced. */
  if (!REPORT_SORTS[shape][state.reportSort.key] || state.reportSortShape !== shape) {
    state.reportSort = defaultSortFor(shape);
  }
  state.reportSortShape = shape;
  const start = state.reportStart || undefined;
  const end = state.reportEnd || undefined;
  $("#report-csv").href = reportCsvHref();
  showReportPlaceholders();
  const path = REPORT_ENDPOINT[shape];
  const rows = await get(`/api/reports/${path}?${reportParams()}`);
  if (seq !== reportSeq) return; // superseded by a newer request
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
  const seq = reportSeq + 1; // what generateReport will claim
  try {
    await generateReport();
  } catch (err) {
    if (seq !== reportSeq) return; // a newer request owns the screen now
    // Stale data must not survive a failed refresh: the print path reads
    // state.report, and printing last report's numbers under a fresh-looking
    // range label is worse than printing nothing.
    state.report = null;
    state.printSurfaceOwner = "report";
    $("#print-report").innerHTML = "";
    $("#report-stats").innerHTML = "";
    $("#report-chart").innerHTML = "";
    $("#report-scope").textContent = "";
    $("#report-print").disabled = true;
    renderViewFailure("reports", err);
  }
}

export function wireReportsView() {
  $("#report-type-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-report-type]");
    if (!btn || btn.dataset.reportType === state.reportType) return;
    state.reportType = btn.dataset.reportType;
    // Sort belongs to the shape, not to the session -- generateReport sorts
    // that out (see reportSortShape). Switching between the three spend
    // reports is one shape and keeps whatever column was clicked.
    syncReportControls();
    refreshReport();
  });

  // Delegated on the view, so the "Show all time" button inside an empty
  // state works the same as the chips in the toolbar.
  $("#view-reports").addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const railItem = $(`.rail-item[data-view="${nav.dataset.nav}"]`);
      if (railItem) railItem.click();
      return;
    }
    const chip = e.target.closest("[data-report-range]");
    if (!chip) return;
    setReportRange(chip.dataset.reportRange);
    syncReportControls();
    refreshReport();
  });

  // Arrow keys move between the four report radios, matching the announced
  // radiogroup semantics.
  $("#report-type-seg").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const btns = $$("#report-type-seg .seg-btn");
    const idx = btns.findIndex((b) => b.dataset.reportType === state.reportType);
    const next = btns[(idx + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
    e.preventDefault();
    next.focus();
    next.click();
  });

  // Bars and rows navigate to their vehicle.
  const openFromDataset = (el) => {
    if (!el || el.dataset.refId == null) return false;
    openVehicleDetail(el.dataset.seg, Number(el.dataset.refId));
    return true;
  };
  $("#report-chart").addEventListener("click", (e) => openFromDataset(e.target.closest("[data-ref-id]")));
  $("#report-chart").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (openFromDataset(e.target.closest("[data-ref-id]"))) e.preventDefault();
  });
  $("#report-output").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("th")) return;
    if (openFromDataset(e.target.closest("tr[data-ref-id]"))) e.preventDefault();
  });

  // Rebuild the print markup at print time (Ctrl+P included), so the paper
  // always matches the current rows, sort, and clock. Only while the report
  // actually owns the print surface: this event fires for every print on the
  // page, and rebuilding unconditionally is what used to replace a ticket
  // with the summary report mid-print (see renderPrintTicket).
  window.addEventListener("beforeprint", () => {
    if (state.report && state.printSurfaceOwner === "report") {
      $("#print-report").innerHTML = renderPrintReport(visibleReportRows(), state.report.type, state.report.start, state.report.end);
    }
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
    if (!th || !state.report) {
      if (!th) openFromDataset(e.target.closest("tr[data-ref-id]"));
      return;
    }
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
