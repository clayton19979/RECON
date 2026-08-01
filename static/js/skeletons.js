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
// Promised, Quoted, Cost. Two places have to agree with the board's <thead>:
// the loading skeleton (a short one makes the table visibly jump a column
// wider the moment data lands) and the empty state's colspan (a short one
// narrows the "no vehicles" panel to part of the table). Both were separate
// literals and both were wrong the moment the Parts column went in, so they
// share one constant now. tests/test_static_assets.py holds it to the real
// <th> count.
export const BOARD_COLUMNS = 12;

// Name, Contact, Location, Vehicles, Repair Orders, Last Visit. Same
// skeleton/empty-state colspan contract as BOARD_COLUMNS above.
export const CUSTOMER_COLUMNS = 6;

// Part, Part #, RO / Vehicle, Qty, Value, Ordered, Waiting. Same contract
// again: the loading skeleton, the empty state and the error state all have
// to span the On Order table's real width.
export const ON_ORDER_COLUMNS = 7;

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
  cores:       [["#on-order-table", ON_ORDER_COLUMNS], ["#cores-table", 8], ["#returns-table", 8]],
  staff:       [["#staff-table", 5]],
  backup:      [["#backup-table", 4]],
  tasks:       [["#tasks-list", 0]],
  suggestions: [["#suggestions-list", 0]],
};

export function showPlaceholders(viewName) {
  for (const [selector, cols] of VIEW_PLACEHOLDERS[viewName] || []) {
    const el = $(selector);
    if (el) el.innerHTML = cols > 0 ? skeletonRows(cols) : skeletonCards();
  }
}
