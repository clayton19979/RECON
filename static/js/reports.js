import { $, $$, fmtHours, get } from "./core.js";
import { esc, money } from "./shortcuts.js";
import { emptyState } from "./empty-states.js";
import { skeletonCards, skeletonRows } from "./skeletons.js";
import { STATUS_LABEL, state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { vehicleStatusPillClass } from "./vehicles-board.js";
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
  : "vehicle-spend";

// Which /api/reports/… and /api/export/report/… each shape is backed by.
const REPORT_ENDPOINT = {
  "vehicle-spend": "vehicle-spend",
  "vehicle-profit": "vehicle-profit",
  technicians: "technicians",
};

const REPORT_STAT_CARDS = {
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
  if (saved.sort && REPORT_SORTS[reportShape(state.reportType)][saved.sort.key]) {
    state.reportSort = { key: saved.sort.key, dir: saved.sort.dir === "asc" ? "asc" : "desc" };
  }
}

export function saveReportPrefs() {
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
  const path = REPORT_ENDPOINT[reportShape(state.reportType)];
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
    // Hours with $0 unit cost are still work -- don't drop the tech from
    // the chart the table shows.
    const withLabor = rows.filter((r) => r.labor_cost > 0 || r.labor_hours > 0)
      .sort((a, b) => b.labor_cost - a.labor_cost);
    const items = withLabor.slice(0, CHART_LIMIT)
      .map((r) => ({ label: r.technician, value: r.labor_cost, display: money(r.labor_cost) }));
    target.innerHTML = barChart({
      title: "Labor cost by technician",
      note: withLabor.length > CHART_LIMIT
        ? `Top ${CHART_LIMIT} of ${withLabor.length} technicians with logged labor`
        : (items.length ? `${items.length} technician${items.length === 1 ? "" : "s"} with logged labor` : ""),
      items,
    }) || chartNothingToPlot(rows.length, "labor cost");
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
      hint: "Add your technicians in Staff and their repair orders, hours and labor cost will roll up here.",
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
  if (shape === "technicians") {
    return `${reportSortHeader("technicians", "technician")}${reportSortHeader("technicians", "ros", "num-col")}${reportSortHeader("technicians", "completed", "num-col")}${reportSortHeader("technicians", "hours", "num-col")}${reportSortHeader("technicians", "cost", "num-col")}`;
  }
  if (shape === "vehicle-profit") {
    return ["stock", "vehicle", "vin"].map((k) => reportSortHeader("vehicle-profit", k)).join("")
      + ["hours", "purchase", "cost", "sale", "profit", "margin"].map((k) => reportSortHeader("vehicle-profit", k, "num-col")).join("");
  }
  return `${reportSortHeader("vehicle-spend", "stock")}${reportSortHeader("vehicle-spend", "vehicle")}${reportSortHeader("vehicle-spend", "segment")}${reportSortHeader("vehicle-spend", "status")}${reportSortHeader("vehicle-spend", "tech")}${reportSortHeader("vehicle-spend", "cost", "num-col")}${hasDeposits ? reportSortHeader("vehicle-spend", "paid", "num-col") + reportSortHeader("vehicle-spend", "net", "num-col") : ""}`;
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
    const totCost = rows.reduce((s, r) => s + r.labor_cost, 0);
    return `<div class="panel"><div class="table-wrap table-scroll"><table class="sticky-head"><thead><tr>
      ${reportHeaderRow("technicians")}
      </tr></thead>
      <tbody>${rows.map((r) => `<tr${r.ro_count ? "" : ' class="row-muted"'}><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${Math.round(r.labor_hours * 100) / 100}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total (${working} working)</td><td class="num-col">${totRos}</td><td class="num-col">${totDone}</td><td class="num-col">${totHours}</td><td class="num-col">${money(totCost)}</td></tr></tfoot>
      </table></div></div>`;
  }
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
  const shape = reportShape(type);
  // The printout keeps the screen's reading order: summary numbers first,
  // then the table -- a spend report with no total line is a worse artifact
  // than the screen it came from.
  const cards = (REPORT_STAT_CARDS[shape] || REPORT_STAT_CARDS["vehicle-spend"])(rows);
  const summary = `<div class="print-summary">${cards.map((c) => `
    <div><div class="ps-label">${esc(c.label)}</div><div class="ps-value">${esc(c.value)}</div><div class="ps-sub">${esc(c.sub)}</div></div>`).join("")}</div>`;
  // The paper must say what the screen knew: row count and sort order, so a
  // filed printout can still be told apart from one taken at another moment.
  const sortSpec = REPORT_SORTS[shape][state.reportSort.key] || REPORT_SORTS[shape].cost;
  const dirWord = sortSpec.type === "number"
    ? (state.reportSort.dir === "desc" ? "high to low" : "low to high")
    : (state.reportSort.dir === "asc" ? "A to Z" : "Z to A");
  const scope = `<div class="print-scope">
    <span class="scope-count">${rows.length} row${rows.length === 1 ? "" : "s"}</span>
    <span>· sorted by ${esc(sortSpec.label)}, ${dirWord}</span>
  </div>`;
  let body;
  if (shape === "technicians") {
    const working = rows.filter((r) => r.ro_count > 0).length;
    const totRos = rows.reduce((s, r) => s + r.ro_count, 0);
    const totDone = rows.reduce((s, r) => s + r.completed_count, 0);
    const totalHours = rows.reduce((s, r) => s + r.labor_hours, 0);
    const totalCost = rows.reduce((s, r) => s + r.labor_cost, 0);
    body = `
      <table class="print-table report">
        <thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Labor Hours</th><th class="num-col">Labor Cost</th></tr></thead>
        <tbody>${rows.map((r) => `<tr${r.ro_count ? "" : ' class="idle"'}><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${Math.round(r.labor_hours * 100) / 100}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody>
        <tfoot>
          <tr><td>Report Total (${working} of ${rows.length} working)</td><td class="num-col">${totRos}</td><td class="num-col">${totDone}</td><td class="num-col">${Math.round(totalHours * 100) / 100}</td><td class="num-col">${money(totalCost)}</td></tr>
          <tr class="tfoot-space" aria-hidden="true"><td colspan="5"></td></tr>
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
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    ${scope}
    ${summary}
    ${body}
    <div class="print-end">
      <div class="print-end-line">End of report — ${esc(REPORT_TITLES[type] || type)} · ${esc(rangeLabel)} · ${rows.length} row${rows.length === 1 ? "" : "s"}</div>
      <div class="print-sign">
        <div class="sign-cell"><div class="sign-rule"></div><div class="sign-label">Reviewed by</div></div>
        <div class="sign-cell"><div class="sign-rule"></div><div class="sign-label">Date</div></div>
      </div>
    </div>
    <footer class="print-foot">
      <span>RECON · Discount Auto Repair</span>
      <span>${esc(REPORT_TITLES[type] || type)} · ${esc(rangeLabel)} · Generated ${esc(generated)}</span>
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
  const cols = shape === "technicians" ? 5 : 8;
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
    `${REPORT_TITLES[state.report.type]} · ${reportDateRangeLabel(state.report.start, state.report.end)} · ${rows.length} row${rows.length === 1 ? "" : "s"}`;
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
  // A sort key from the other shape (Cost exists on both, "hours" doesn't)
  // would silently sort by nothing at all.
  if (!REPORT_SORTS[shape][state.reportSort.key]) state.reportSort = { key: "cost", dir: "desc" };
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
