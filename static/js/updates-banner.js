import { $, api, get } from "./core.js";
import { desktopSaver } from "./downloads.js";
import { toast } from "./notify.js";
import { withLoading } from "./shortcuts.js";

/* ---------- updates ----------
   The shop PC serves the app to every workstation, so it also serves the
   update: drop a new RECON-Setup-x.y.z.exe into its updates folder and each
   PC offers it. Nothing installs on its own -- someone is always mid-ticket,
   and an app that restarts itself under an advisor loses a repair order.

   In a plain browser tab there is no way to run an installer, so the notice
   says where to go instead of offering a button that couldn't work. */
const UPDATE_CHECK_MS = 30 * 60 * 1000;
let dismissedUpdate = null;

function fmtBytes(n) {
  const mb = (Number(n) || 0) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round((Number(n) || 0) / 1024)} KB`;
}

async function checkForUpdate() {
  const bar = $("#update-bar");
  if (!bar) return;
  let info;
  try {
    info = await get("/api/version");
  } catch {
    return; // the server being unreachable is already surfaced elsewhere
  }
  const update = info && info.update;
  if (!update || update.version === dismissedUpdate) {
    bar.hidden = true;
    return;
  }
  const canInstall = !!desktopSaver();  // same pywebview bridge downloads use
  $("#update-bar-text").textContent = canInstall
    ? `RECON ${update.version} is available (${fmtBytes(update.size_bytes)}). You're on ${info.version}.`
    : `RECON ${update.version} is available. You're on ${info.version} — open RECON on this PC to install it.`;
  $("#update-install").hidden = !canInstall;
  bar.hidden = false;
}

export function wireUpdateBar() {
  const bar = $("#update-bar");
  if (!bar) return;
  $("#update-dismiss").addEventListener("click", async () => {
    // Remembered for this run only. A new version is worth re-offering next
    // time the app opens; nagging inside one shift is what gets ignored.
    try {
      const info = await get("/api/version");
      dismissedUpdate = info?.update?.version || null;
    } catch {}
    bar.hidden = true;
  });
  $("#update-install").addEventListener("click", async (e) => {
    const api = window.pywebview && window.pywebview.api;
    const install = api && (api.install_update || api.installUpdate);
    if (typeof install !== "function") {
      return toast("Open RECON on this PC to install the update", true);
    }
    await withLoading(e.currentTarget, "Downloading…", async () => {
      let info;
      try {
        info = await get("/api/version");
      } catch (err) {
        return toast(err.message, true);
      }
      if (!info?.update) return toast("No update is available any more");
      let result;
      try {
        result = await install.call(api, "/api/update/download", info.update.filename);
      } catch (err) {
        return toast(`Could not start the update: ${err.message || err}`, true);
      }
      if (!result || !result.ok) return toast(result?.error || "Could not start the update", true);
      toast("Installer started — RECON will close to finish updating");
    });
  });
  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_MS);
}
