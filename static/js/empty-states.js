import { esc } from "./shortcuts.js";

/* ---------- empty states ----------
   One component for every "there's nothing to show" case, so the wording and
   spacing stay consistent instead of each call site inventing its own inline
   style. The distinction that matters to someone using this is "nothing has
   been added yet" (here's how to add one) versus "your filter hid it all"
   (here's how to clear it), so callers are expected to pass different copy
   for the two rather than a single generic "No results". */
export const EMPTY_ICONS = {
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

export function emptyState({ icon = "search", title, hint = "", actions = "", compact = false, tone = "" }) {
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
export function emptyRow(colspan, opts) {
  return `<tr class="empty-row"><td class="empty-cell" colspan="${colspan}">${emptyState(opts)}</td></tr>`;
}
