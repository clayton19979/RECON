import { api } from "./core.js";
import { copyText } from "./clipboard.js";
import { toast } from "./notify.js";

/* ---------- downloads ----------
   RECON normally runs in its own WebView2 window, and there a plain
   `<a download>` does nothing whatsoever -- no file, no error, no clue that
   anything was even attempted. Every download in the app went through one, so
   backups, the vehicles CSV and the report CSV all looked equally broken.

   In the window they route through pywebview instead, which gets the operator
   a real folder picker: the whole point of downloading a backup is putting it
   somewhere deliberate, usually a flash drive, not burying it in Downloads.
   On a workstation using a plain browser tab there is no pywebview and the
   anchor already works on its own, so this steps aside entirely. */
export function desktopSaver() {
  const api = window.pywebview && window.pywebview.api;
  if (!api) return null;
  // pywebview exposes the Python name; a couple of builds also camelCase it.
  const fn = api.save_file || api.saveFile;
  return typeof fn === "function" ? fn.bind(api) : null;
}

async function saveViaDesktop(anchor) {
  const save = desktopSaver();
  if (!save) return;
  const url = new URL(anchor.href, window.location.href);
  const suggested = anchor.getAttribute("download") || url.pathname.split("/").pop() || "recon-download";
  let result;
  try {
    result = await save(url.pathname + url.search, suggested);
  } catch (err) {
    toast(`Could not save that file: ${err.message || err}`, true);
    return;
  }
  // Backing out of the picker is a decision, not a failure -- say nothing.
  if (!result || result.cancelled) return;
  if (!result.ok) return toast(result.error || "Could not save that file", true);
  toast(`Saved to ${result.path}`);
}

export function wireDownloadIntercept() {
  // Any element carrying data-copy is a copy button, wherever it renders.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    e.preventDefault();
    copyText(btn.dataset.copy, btn.dataset.copyLabel || "Copied");
  });

  document.addEventListener("click", (e) => {
    const anchor = e.target.closest("a[download]");
    // Same-origin only, and only when there's a picker to route to; anything
    // else falls through to the browser's own handling unchanged.
    if (!anchor || !desktopSaver()) return;
    if (new URL(anchor.href, window.location.href).origin !== window.location.origin) return;
    e.preventDefault();
    saveViaDesktop(anchor);
  });
}
