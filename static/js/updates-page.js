import { $, get, post } from "./core.js";
import { toast } from "./notify.js";
import { esc, withLoading } from "./shortcuts.js";
import { emptyState } from "./empty-states.js";
import { renderViewFailure } from "./error-boundary.js";
import { canInstallHere, fmtBytes, installDownloadedUpdate } from "./updates-banner.js";

/* ==================================================================
   UPDATES

   The tray icon still does all of this, and still has to: it is the only
   thing running when the app itself is what needs replacing. But answering
   "what am I running" and "is there anything newer" should not require
   right-clicking an icon in the corner of the taskbar, so both live on a
   screen now.

   Nothing here installs anything by itself. The check downloads at most --
   the same rule the tray and the daily loop follow, because somebody is
   always mid-ticket and an app that restarts itself under an advisor loses
   a repair order.
   ================================================================== */

// What the API's status strings mean in shop English. `already` is the one
// worth spelling out: it means the build is downloaded and waiting, which
// reads as failure if it just says "nothing to do".
const CHECK_MESSAGES = {
  downloaded: (r) => `RECON ${r.version} downloaded. It's ready to install below.`,
  already: (r) => `RECON ${r.version} was already downloaded and is waiting to be installed.`,
  current: () => "No newer version has been published — you're up to date.",
};

function renderAvailable(info) {
  const box = $("#updates-available");
  const install = $("#updates-install");
  if (!box || !install) return;

  const update = info && info.update;
  if (!update) {
    install.hidden = true;
    box.innerHTML = emptyState({
      icon: "invoice",
      title: "Nothing waiting",
      hint: "You're on the newest version this computer knows about. Use Check for Updates to ask again.",
      compact: true,
    });
    return;
  }

  // A browser tab has no way to run an installer, so it gets told where to go
  // instead of a button that could only fail.
  const canInstall = canInstallHere();
  install.hidden = !canInstall;
  box.innerHTML = `
    <div class="update-offer">
      <div class="update-offer-version">RECON ${esc(update.version)}</div>
      <div class="update-offer-meta">${esc(fmtBytes(update.size_bytes))} · you're on ${esc(info.version)}</div>
      ${canInstall
        ? `<p class="update-offer-note">Installing closes RECON for a moment and reopens it. Your records, backups and settings are untouched.</p>`
        : `<p class="update-offer-note">You're looking at RECON in a web browser, which can't run an installer. Open the RECON app on this computer to install it.</p>`}
    </div>
  `;
}

function renderFacts(info) {
  const isMaster = info.role === "master";
  $("#updates-current").textContent = info.version || "—";
  $("#updates-offered").textContent = info.update ? info.update.version : "None";
  $("#updates-offered-sub").textContent = info.update ? "ready to install" : "nothing waiting";
  $("#updates-role").textContent = isMaster ? "Main PC" : "Workstation";
  $("#updates-role-sub").textContent = isMaster
    ? "hands updates to the other computers"
    : "gets updates from the main PC";
  $("#updates-note").textContent = isMaster
    ? `New builds land in ${info.updates_dir}`
    : "Checking asks the main shop PC, which is where updates arrive.";
}

/* The address to type into a phone, and whether it will work yet.
 *
 * Deliberately not derived from window.location: on the shop PC that reads
 * 127.0.0.1, which is correct for this browser and useless to a phone. The
 * server reports which interface it would actually reach the network on.
 *
 * Sharing off means the server is bound to loopback, so the address is right
 * and still unreachable. Saying that is the whole value of the line -- a URL
 * that silently fails sends somebody hunting through their phone's Wi-Fi
 * settings for a problem that is on this PC.
 */
async function renderPhoneLink() {
  const url = $("#updates-phone-url");
  const note = $("#updates-phone-note");
  if (!url || !note) return;
  let link;
  try {
    link = await get("/api/mobile/link");
  } catch {
    // A dead sub-request shouldn't take the version numbers down with it.
    url.textContent = "—";
    note.textContent = "Couldn't work out this computer's address on the network.";
    return;
  }
  url.textContent = link.url || "—";
  note.textContent = !link.url
    ? "This computer doesn't appear to be on a network right now."
    : link.sharing
      ? "Sharing is on, so phones on the shop's Wi-Fi can reach this."
      : "Sharing is off, so nothing else can reach this PC yet — turn on network mode from the RECON tray icon first.";
}

export async function loadUpdatesView() {
  let info;
  try {
    info = await get("/api/version");
  } catch (err) {
    return renderViewFailure("updates", err);
  }
  renderFacts(info);
  renderAvailable(info);
  renderPhoneLink();
}

export function wireUpdatesView() {
  const check = $("#updates-check");
  if (!check) return;

  check.addEventListener("click", async (e) => {
    await withLoading(e.currentTarget, "Checking…", async () => {
      let result;
      try {
        result = await post("/api/update/check-online");
      } catch (err) {
        return toast(err.message, true);
      }
      const status = result?.status;
      if (status === "off") {
        // The one failure somebody can actually fix, so it says where.
        toast(`Online updates aren't set up on this PC — ${result.config_path} is missing`, true);
      } else if (status === "error") {
        toast(`Couldn't check for updates: ${result.detail}`, true);
      } else {
        toast((CHECK_MESSAGES[status] || CHECK_MESSAGES.current)(result));
      }
      // Whatever the answer, the numbers on screen are now stale.
      await loadUpdatesView();
    });
  });

  $("#updates-install")?.addEventListener("click", (e) => installDownloadedUpdate(e.currentTarget));

  // The rail's version label is a shortcut to this screen. Clicking the rail
  // button rather than importing showView keeps this module out of the nav
  // module's business, the same way the Staff screen reaches Tasks.
  $("#rail-version")?.addEventListener("click", () => {
    $('.rail-item[data-view="updates"]')?.click();
  });
}
