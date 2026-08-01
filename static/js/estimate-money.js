/* What a ticket's parts-and-labour lines add up to.
 *
 * One definition, because a ticket's money is shown in four places that all
 * used to do the arithmetic themselves: the "This Ticket" card, the live
 * totals that follow each keystroke in the grid, each job group's subtotal,
 * and the printed ticket. Four copies is four chances to disagree, and they
 * did -- a vendor credit added to the ticket card while subtracting from the
 * board and the Lot Report right beside it.
 *
 * The rules mirror app/recon.py::cost_rollup exactly, which is what the
 * board, the vehicle's own total, the reports and the CSV are all built on.
 * If these two ever have to change, they change together:
 *
 *   Quoted -- what this ticket says the car will cost. Every line at its full
 *   quantity whether or not it has landed yet. A credit line (a returned part
 *   or a refunded core, written up the way the vendor prints it: positive
 *   quantity, positive cost) SUBTRACTS, and a part that has been sent back to
 *   the vendor drops out entirely -- it is not money the shop is going to
 *   spend, and the grid already renders its cost as 0.
 *
 *   Actual -- what has really landed. Parts count only once received, labour
 *   and fees count the moment they are logged, and a credit counts for
 *   nothing: the returned part it pairs with has already dropped out above,
 *   so subtracting the credit as well would count the same money back twice.
 *
 * Everything here is at cost. Recon and we-owe work carries no markup and no
 * charged-out labour, so unit_cost is the only price this app has.
 */

import { money } from "./shortcuts.js";

/** True for a part line that has gone back to the vendor. */
export function isReturnedPart(item) {
  return item.kind === "part" && !!item.part_returned;
}

/** The price a line was written down at. Receiving overwrites unit_cost with
 * the vendor invoice's number; quoted_unit_cost is the one that survives the
 * bill. Lines from before that column existed carry null and fall back. */
export function writtenUnitCost(item) {
  return item.quoted_unit_cost ?? item.unit_cost ?? 0;
}

/** What one line contributes to the ticket's quote. Negative for a credit. */
export function quotedLineTotal(item) {
  if (isReturnedPart(item)) return 0;
  const total = (Number(item.quantity) || 0) * (Number(writtenUnitCost(item)) || 0);
  return item.kind === "credit" ? -total : total;
}

/** What one line contributes to what the car has actually cost so far. */
export function actualLineTotal(item) {
  if (item.kind === "part") {
    return isReturnedPart(item) ? 0 : (Number(item.received_quantity) || 0) * (Number(item.unit_cost) || 0);
  }
  // Labour and fees are real the moment they are written down. Anything else
  // -- a credit today, a kind that doesn't exist yet tomorrow -- stays out
  // rather than being guessed at, the same way the server's sum names only
  // the kinds it is sure about.
  if (item.kind === "labor" || item.kind === "fee") {
    return (Number(item.quantity) || 0) * (Number(item.unit_cost) || 0);
  }
  return 0;
}

export function quotedTotal(items) {
  return (items || []).reduce((sum, item) => sum + quotedLineTotal(item), 0);
}

export function actualTotal(items) {
  return (items || []).reduce((sum, item) => sum + actualLineTotal(item), 0);
}

/* The single most decision-relevant number on a recon ticket -- are we over
   the quote -- shouldn't have to be computed mentally from two adjacent
   figures. Half a cent of slack in both directions so a rounding tail never
   reads as "$0.00 over quote".

   Returns what the badge should say and how it should look, rather than
   touching the DOM, so the saved view and the live-typing view can share it. */
export function costDeltaBadge(quoted, actual) {
  if (!quoted) return { hidden: true, className: "cost-delta", text: "" };
  const diff = actual - quoted;
  if (Math.abs(diff) <= 0.005) return { hidden: false, className: "cost-delta zero", text: "On quote" };
  if (diff > 0) return { hidden: false, className: "cost-delta over", text: `${money(diff)} over quote` };
  return { hidden: false, className: "cost-delta", text: `${money(-diff)} under quote` };
}
