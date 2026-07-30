import { toast } from "./notify.js";

/* ---------- clipboard ----------
   navigator.clipboard is unavailable outside a secure context, and the shop's
   other workstations reach RECON over plain http on the LAN -- so on exactly
   the machines that aren't the server, the modern API is missing. The old
   execCommand path is the fallback that keeps copy working there. */
export async function copyText(text, what = "Copied") {
  const value = String(text ?? "").trim();
  if (!value) return toast("Nothing to copy", true);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return toast(`${what} copied`);
    }
  } catch {
    // Fall through -- a rejected permission is still a reason to try the
    // fallback rather than tell the user it simply didn't work.
  }
  const scratch = document.createElement("textarea");
  scratch.value = value;
  // Off-screen rather than hidden: a display:none textarea can't be selected.
  scratch.setAttribute("aria-hidden", "true");
  scratch.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  scratch.remove();
  toast(ok ? `${what} copied` : "Could not copy — select the text and use Ctrl+C", !ok);
}
