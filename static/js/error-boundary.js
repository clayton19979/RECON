import { $, $$ } from "./core.js";
import { toast } from "./notify.js";
import { emptyRow, emptyState } from "./empty-states.js";
import { VIEW_PLACEHOLDERS, showPlaceholders } from "./skeletons.js";
import { VIEW_LOADERS } from "./nav.js";

/* ---------- render error boundary ----------
   A throw partway through a render used to leave the skeleton rows frozen on
   screen with no message anywhere -- the view simply never finished, and the
   only trace was a console error nobody on a shop floor is going to open. Any
   view loader that throws now lands here and the view says so, with a way to
   retry that doesn't involve reloading the whole app. */
async function runViewLoader(name) {
  const load = VIEW_LOADERS[name];
  if (!load) return;
  try {
    await load();
  } catch (err) {
    renderViewFailure(name, err);
  }
}

export function renderViewFailure(name, err, targets = VIEW_PLACEHOLDERS[name]) {
  console.error(`[${name}] failed to render`, err);
  const message = String(err && err.message ? err.message : err || "Unknown error");
  const opts = {
    icon: "search",
    title: "This screen didn't load",
    hint: message,
    tone: "error",
    actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="retry-view" data-view="${name}">Try Again</button>`,
  };
  targets = targets || [];
  if (!targets.length) {
    toast(`Couldn't load this screen: ${message}`, true);
    return;
  }
  for (const [selector, cols] of targets) {
    const el = $(selector);
    if (el) el.innerHTML = cols > 0 ? emptyRow(cols, opts) : emptyState(opts);
  }
}

// Delegated so it survives the innerHTML above being replaced again on retry.
export function wireViewRetry() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-empty-action="retry-view"]');
    if (!btn) return;
    showPlaceholders(btn.dataset.view);
    runViewLoader(btn.dataset.view);
  });
}

// Anything that escapes every other handler -- a typo in a render function,
// a promise nobody caught -- at least tells the user the app is in a bad
// state rather than looking merely slow.
/* Browser noise that is not a fault in this app and must not be shown as one.

   "ResizeObserver loop completed with undelivered notifications" is the whole
   list, and it is a notice rather than an error: it means a resize callback
   changed layout and the browser is going round again next frame, which is
   normal and self-correcting. It reaches window.onerror anyway, so without
   this the shop got a red "Something went wrong" toast for nothing -- and a
   warning that cries wolf is worse than no warning, because the next one is
   the one that gets ignored. The cause is fixed where it happens (see the
   concern strip's observer in vehicle-detail.js); this is the net under it. */
const BENIGN_ERRORS = [/^ResizeObserver loop/i];

export function wireGlobalErrorReporting() {
  const report = (label, detail) => {
    const message = String(detail && detail.message ? detail.message : detail);
    if (BENIGN_ERRORS.some((pattern) => pattern.test(message))) return;
    console.error(label, detail);
    if ($("#toast")) toast(`${label}: ${message}`, true);
  };
  window.addEventListener("error", (e) => report("Something went wrong", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report("Something went wrong", e.reason));
}

export function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  // Paint placeholders before kicking off the fetch -- otherwise the old
  // view's rows stay on screen until it resolves.
  showPlaceholders(name);
  runViewLoader(name);
}

const THEMES = ["harbor", "gunmetal", "petrol", "mesa", "cobalt", "verdigris"];

function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("dao-theme", name);
  $$(".theme-option").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === name));
}

export function initTheme() {
  const saved = localStorage.getItem("dao-theme");
  applyTheme(THEMES.includes(saved) ? saved : "harbor");

  $("#theme-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#theme-menu").classList.toggle("open");
  });
  $$(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      $("#theme-menu").classList.remove("open");
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".theme-picker")) $("#theme-menu").classList.remove("open");
  });
}
