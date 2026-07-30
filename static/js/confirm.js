import { $ } from "./core.js";

/* ---------- confirm dialog ----------
   Every destructive action used to call window.confirm(), which renders as
   an OS-chrome alert: no title/detail split, no way to say how destructive
   this particular action is, no styling, and (in the app-mode window) a
   dialog that looks like it came from a different program. confirmAction()
   is a drop-in async replacement -- `if (!(await confirmAction({...}))) return;`
   -- backed by the same <dialog> element as every other modal.

   Cancel is the default focus for destructive actions, so hammering Enter
   can't blow something away. */
let confirmResolve = null;

export function confirmAction({ title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", eyebrow = "CONFIRM", danger = false }) {
  const dlg = $("#confirm-dialog");
  // No dialog in the DOM (a bare test harness, say) -- fail closed rather
  // than silently performing the destructive action.
  if (!dlg) return Promise.resolve(false);
  $("#confirm-eyebrow").textContent = eyebrow;
  $("#confirm-title").textContent = title;
  const bodyEl = $("#confirm-body");
  bodyEl.textContent = body;
  bodyEl.style.display = body ? "" : "none";
  const accept = $("#confirm-accept");
  accept.textContent = confirmLabel;
  accept.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  $("#confirm-cancel").textContent = cancelLabel;
  dlg.classList.toggle("danger", danger);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    dlg.showModal();
    (danger ? $("#confirm-cancel") : accept).focus();
  });
}

function settleConfirm(result) {
  const dlg = $("#confirm-dialog");
  const resolve = confirmResolve;
  confirmResolve = null;
  if (dlg?.open) dlg.close();
  if (resolve) resolve(result);
}

export function wireConfirmDialog() {
  const dlg = $("#confirm-dialog");
  if (!dlg) return;
  $("#confirm-accept").addEventListener("click", () => settleConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => settleConfirm(false));
  // Esc / backdrop-dismiss fire `close` without going through either button.
  dlg.addEventListener("close", () => settleConfirm(false));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) settleConfirm(false); });
}
