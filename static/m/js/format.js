/* Formatting, shared with the desk by being identical to it.
 *
 * The four functions below are byte-for-byte copies of their twins in
 * static/js/shortcuts.js, and tests/test_mobile.py compares the two texts and
 * fails if they drift. They are copied rather than imported because
 * shortcuts.js pulls in state.js and the dialog machinery -- the whole desktop
 * app -- and the phone should not load that to print a dollar sign.
 *
 * Everything below the copied block is phone-side presentation built on top
 * of numbers the *server* has already decided (lot_bucket, needs, age_days,
 * idle_days). The phone never re-derives which pile a car is in or what it
 * still needs; if it did, the two screens could disagree, and the whole point
 * of this app is that they don't.
 */

/* ---------- copied verbatim from static/js/shortcuts.js ---------- */

export function money(value) {
  // `value || 0` only catches falsy input (0, "", null, undefined) -- a
  // truthy but non-numeric value (e.g. a corrupted field coming back as a
  // string) sails through Number() as NaN and used to render literally
  // "$NaN" in cost summaries and the printed ticket.
  const raw = Number(value);
  const n = Number.isFinite(raw) ? raw : 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (m && MONTH_NAMES[Number(m[2]) - 1]) return `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function relativeTime(value) {
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

/* ---------- the board's shared vocabulary ---------- */

/* The four piles, in the order a car travels through them, with the same
   labels and the same blank lines the desktop board uses
   (static/js/vehicles-board.js::LOT_COLUMNS). "Finished — file away" is last
   and past the end of that journey on purpose: those cars have already left
   the lot, and counting them as "ready" inflates the one number Walt reads. */
export const LOT_PILES = [
  { key: "waiting", label: "Not started", blank: "Nothing waiting to be started." },
  { key: "working", label: "In the shop", blank: "Nothing in the shop right now." },
  { key: "ready", label: "Ready to go", blank: "Nothing finished yet." },
  { key: "settled", label: "Finished — file away", blank: "Nothing waiting to be filed." },
];

const PILE_KEYS = new Set(LOT_PILES.map((p) => p.key));

/* The server stamps every row, so the fallback is unreachable -- but a car
   that quietly vanished off the phone because its bucket was a string nobody
   recognised is the worst possible way to find that out. Unknown lands in the
   middle pile rather than nowhere. Same rule as the desktop's columnKey(). */
export function pileKey(v) {
  return PILE_KEYS.has(v.lot_bucket) ? v.lot_bucket : "working";
}

const STATUS_LABEL = {
  estimate: "Estimate", pending_approval: "Pending", in_progress: "In Progress", complete: "Complete",
  acquired: "Acquired", sold: "Sold", open: "Open", fulfilled: "Fulfilled", waived: "Waived",
};
const STATUS_PILL = {
  estimate: "m-pill-estimate", pending_approval: "m-pill-pending",
  in_progress: "m-pill-progress", complete: "m-pill-complete", sold: "m-pill-done",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || String(status || "").replace(/_/g, " ") || "—";
}

export function statusPillClass(v) {
  if (v.segment === "recon") return STATUS_PILL[v.status] || "m-pill-progress";
  return v.status_bucket === "finished" ? "m-pill-done" : "m-pill-progress";
}

/* Age severity -- how long the shop has had the car. Thresholds match
   vehicles-board.js::ageClass, which is why an outlier looks the same colour
   on the phone as it does on the board. */
export function ageClass(days) {
  if (days >= 30) return "m-age-crit";
  if (days >= 14) return "m-age-warn";
  return "m-age-ok";
}

/* Idle severity -- days since anyone did anything, which is the question that
   actually costs money. Tighter than age on purpose: two weeks of nothing on
   a recon car is a crisis, not a warning, so stale starts at 3 days (past a
   weekend) and goes critical at a week. Mirrors IDLE_BUCKETS. */
export function idleClass(days, finished) {
  // A finished car is never painted warn or crit. Nobody is neglecting a car
  // that is done; colouring it red just teaches people to ignore red.
  if (finished) return "m-age-ok";
  const n = Math.max(0, days || 0);
  if (n >= 7) return "m-age-crit";
  if (n >= 3) return "m-age-warn";
  return "m-age-ok";
}

export function idleText(days) {
  const n = Math.max(0, days || 0);
  return n === 0 ? "Active today" : `Idle ${n}d`;
}

/* The VIN, as it's actually used standing at a car: the last eight, which is
   what's on the dash plate and what anybody reads aloud. The full number goes
   in the title attribute rather than on the line. */
export function vinTail(vin) {
  const s = String(vin || "").trim();
  return s.length > 8 ? s.slice(-8) : s;
}
