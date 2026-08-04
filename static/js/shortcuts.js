import { $ } from "./core.js";
import { state } from "./state.js";

/* ---------- keyboard shortcuts overlay ----------
   The board grew a real keyboard model (cursor, selection, type-to-search)
   and the estimate grid grew its own (Tab past the last money field starts
   the next line) -- none of it discoverable beyond one hint line under one
   table. "?" is where every keyboard-driven product keeps the map, so it
   opens the map here too, from any view. */
export function wireShortcutsDialog() {
  const dlg = $("#shortcuts-dialog");
  if (!dlg) return;
  $("#shortcuts-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    e.preventDefault();
    // This listener is registered before the board's type-to-search handler
    // (see init order), and must also *stop* it -- otherwise the same "?"
    // that opens the overlay would land in the search box behind it.
    e.stopImmediatePropagation();
    if (dlg.open) dlg.close();
    else dlg.showModal();
  });
}

/* A confirm with one required text field. Used only once the vendor's credit
   paperwork (invoice, credit slip or RMA) has actually arrived -- a core or
   part physically going back is a separate, earlier step with no number to
   capture yet. Resolves to the trimmed string, or null on cancel. */
let invoicePromptResolve = null;

export function promptInvoiceNumber({ title, body = "", label = "Invoice / credit #", placeholder = "e.g. CR-10442", confirmLabel = "Save", eyebrow = "RETURN", value = "" }) {
  const dlg = $("#invoice-prompt-dialog");
  if (!dlg) return Promise.resolve(null); // bare test harness -- fail closed
  $("#invoice-prompt-eyebrow").textContent = eyebrow;
  $("#invoice-prompt-title").textContent = title;
  const bodyEl = $("#invoice-prompt-body");
  bodyEl.textContent = body;
  bodyEl.style.display = body ? "" : "none";
  $("#invoice-prompt-label-wrap").firstChild.textContent = label;
  const input = $("#invoice-prompt-input");
  input.placeholder = placeholder;
  input.value = value;
  $("#invoice-prompt-accept").textContent = confirmLabel;
  return new Promise((resolve) => {
    invoicePromptResolve = resolve;
    dlg.showModal();
    input.focus();
  });
}

function settleInvoicePrompt(result) {
  const dlg = $("#invoice-prompt-dialog");
  const resolve = invoicePromptResolve;
  invoicePromptResolve = null;
  if (dlg?.open) dlg.close();
  if (resolve) resolve(result);
}

export function wireInvoicePromptDialog() {
  const dlg = $("#invoice-prompt-dialog");
  if (!dlg) return;
  $("#invoice-prompt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("#invoice-prompt-input").value.trim();
    if (!value) return; // required -- the field's own validation copy handles it
    settleInvoicePrompt(value);
  });
  $("#invoice-prompt-cancel").addEventListener("click", () => settleInvoicePrompt(null));
  $("#invoice-prompt-cancel-2").addEventListener("click", () => settleInvoicePrompt(null));
  dlg.addEventListener("close", () => settleInvoicePrompt(null));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) settleInvoicePrompt(null); });
}

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
export function currentActor() {
  // Empty when nobody has been picked, never the word "Unspecified": that
  // string was being sent as the actor and stored as the person, so tickets
  // filled up with work done by a colleague named Unspecified. An empty
  // actor lets the server keep its own placeholder and lets actorLabel below
  // say nothing rather than say something untrue.
  return state.currentUser;
}
/* Placeholders that mean "nobody said who". "ui" is what the server defaults
   to when a request arrives without an actor -- it is the request's origin,
   not a name -- "unknown" is what record_activity substitutes for a blank one,
   and older rows carry "Unspecified" from when the front end sent that word as
   somebody's name. All three are on screen in ticket histories today,
   captioning real events with a person who does not exist. */
const ACTOR_PLACEHOLDERS = new Set(["", "ui", "api", "system", "unknown", "unspecified"]);
export function actorLabel(actor) {
  const name = String(actor ?? "").trim();
  return ACTOR_PLACEHOLDERS.has(name.toLowerCase()) ? "" : name;
}
/* " by Antonio", or nothing at all. Kept as one helper so the half-dozen
   places that caption an event with a person all fall silent together. */
export function byActor(actor, prefix = " by ") {
  const name = actorLabel(actor);
  return name ? `${prefix}${name}` : "";
}
// Disables a button and swaps its label while an async action is in
// flight, so a slow save doesn't look like nothing happened (and can't be
// double-submitted by an impatient extra click).
export async function withLoading(button, label, fn) {
  // A form submitted by the Enter key (or requestSubmit() with no argument)
  // reports submitter === null, so every `withLoading(e.submitter, …)` call
  // site would throw on the keyboard path. The work still has to run -- the
  // busy state is a nicety, the save is not.
  if (!button) return fn();
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
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
/* A plain calendar day -- "Jul 30, 2026" -- with no time of day.
 *
 * Two kinds of value end up here and only one of them is safe to hand to
 * Date. A bare YYYY-MM-DD is defined to be *UTC* midnight, so
 * `new Date("2026-07-30")` is 7pm on the 29th in Indiana: every bare date on
 * the printed repair order came out a day early, captioned with a 7:00 PM
 * nobody typed. "Promised Jul 29" on a ticket promised for the 30th is the
 * kind of wrong that gets argued about at the counter, so that form is
 * pulled apart by hand and never goes near Date at all.
 *
 * A full timestamp (what the database stamps records with) has no such
 * problem and keeps the locale formatting it always had.
 */
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (m && MONTH_NAMES[Number(m[2]) - 1]) return `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
// Awareness for the two-people-editing-the-same-car case: seeing "updated 2
// minutes ago" is often enough to make someone check with a coworker before
// saving over their still-fresh change.
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

export function todayLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
