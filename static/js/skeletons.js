import { $ } from "./core.js";

/* ---------- loading skeletons ----------
   Painted synchronously before a view's fetch starts, so switching views
   never leaves the previous screen's rows on display while the new data is
   still in flight. Widths vary per cell so it reads as content rather than a
   progress bar; the sequence is deterministic (no Math.random) so a re-render
   doesn't visibly reshuffle. */
const SKELETON_WIDTHS = [62, 84, 45, 72, 91, 54, 68, 79, 58, 88];

export function skeletonRows(cols, rows = 5) {
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

export function skeletonCards(count = 3) {
  return Array.from({ length: count }, (_, i) => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-line" style="width:${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%"></div>
      <div class="skeleton-line" style="width:28%;height:8px;margin-top:11px"></div>
    </div>`).join("");
}

// Select, Stock #, Vehicle, Type, Status, Technician, Parts, Age, Idle,
// Promised, Cost. Two places have to agree with the board's <thead>: the
// loading skeleton (a short one makes the table visibly jump a column wider
// the moment data lands) and the empty state's colspan (a short one narrows
// the "no vehicles" panel to part of the table). Both were separate literals
// and both were wrong the moment the Parts column went in, so they share one
// constant now. tests/test_static_assets.py holds it to the real <th> count.
export const BOARD_COLUMNS = 11;

// Name, Contact, Location, Vehicles, Repair Orders, We-Owe, Last Visit. Same
// skeleton/empty-state colspan contract as BOARD_COLUMNS above.
export const CUSTOMER_COLUMNS = 7;

// Part, Part #, RO / Vehicle, Qty, Value, Ordered, Waiting. Same contract
// again: the loading skeleton, the empty state and the error state all have
// to span the On Order table's real width.
export const ON_ORDER_COLUMNS = 7;

// Part, Part #, RO / Vehicle, Qty, Not In Cost, Ticket Idle. One column
// shorter than On Order: a line that was never received has no Ordered date
// worth printing, and a blank column reads as missing data rather than as a
// question that doesn't apply.
export const MISSING_RECEIPT_COLUMNS = 6;

// Which containers to fill with a placeholder when a view is opened, and how
// many columns each table has (so the skeleton lines up with its header).
export const VIEW_PLACEHOLDERS = {
  vehicles:    [["#vehicles-table", BOARD_COLUMNS]],
  customers:   [["#customers-table", CUSTOMER_COLUMNS]],
  // Only the table is listed: the summary cards and chart above it get a
  // shape-matched skeleton of their own (showReportPlaceholders), and a
  // failed load should say so once rather than three times down the page.
  reports:     [["#report-output", 0]],
  accounting:  [["#ap-table", 8]],
  cores:       [["#on-order-table", ON_ORDER_COLUMNS], ["#missing-table", MISSING_RECEIPT_COLUMNS], ["#cores-table", 8], ["#returns-table", 8]],
  staff:       [["#staff-table", 5]],
  backup:      [["#backup-table", 4]],
  tasks:       [["#tasks-list", 0]],
  suggestions: [["#suggestions-list", 0]],
  updates:     [["#updates-available", 0]],
};

/* The summary strip above a view's table, and how many cards it holds.
   Without this the cards popped in from a blank strip while the table below
   them shimmered -- the one part of the screen that looked broken rather than
   loading. Card counts have to match what the view actually renders, or the
   strip visibly changes width as the real numbers land.

   Two views are deliberately absent. Reports paints a shape-matched set of
   its own (showReportPlaceholders), because its cards change per report. The
   vehicles board's five cards are fixed-id children written once in
   index.html and mutated in place, so replacing the container's innerHTML
   would delete those ids out from under renderStats -- it blanks their text
   instead (see loadVehiclesView). */
export const VIEW_STAT_STRIPS = {
  accounting: ["#ap-stats", 4],
  cores:      ["#cores-returns-stats", 5],
  staff:      ["#staff-stats", 4],
  backup:     ["#backup-stats", 5],
};

export function showPlaceholders(viewName) {
  const strip = VIEW_STAT_STRIPS[viewName];
  if (strip) {
    const stats = $(strip[0]);
    if (stats) stats.innerHTML = skeletonCards(strip[1]);
  }
  for (const [selector, cols] of VIEW_PLACEHOLDERS[viewName] || []) {
    const el = $(selector);
    if (el) el.innerHTML = cols > 0 ? skeletonRows(cols) : skeletonCards();
  }
}
