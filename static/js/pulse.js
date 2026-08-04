import { $, get } from "./core.js";
import { state } from "./state.js";
import { VIEW_LOADERS } from "./nav.js";
import { runViewLoader } from "./error-boundary.js";
import { loadVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   IS THIS SCREEN STILL TRUE?

   Two people work out of this app all day, on two PCs, against the one
   database on the shop machine. Every screen used to be a photograph: it
   fetched once when it was opened and then never asked again. So Antonio
   receiving the parts a car was waiting on, or ticking the brakes off as
   finished, changed nothing at all on Clayton's screen -- it went on showing
   the morning's answer into the afternoon, with nothing on it to say the
   answer had moved. A board that is quietly wrong is worse than one that
   admits it, because it gets acted on: the part gets ordered twice, or a car
   gets chased that somebody already finished.

   The server keeps one counter that moves on every write (see shop_pulse in
   app/db.py). This asks for it every few seconds and compares it to the
   number that was true when the screen was drawn.

   Two rules decide what happens when they differ, and the split is the whole
   design:

   - If nothing is in the middle of being done, the screen just quietly
     re-fetches. A list of cars is not worth a button press to correct.
   - If anything IS in the middle of being done -- a dialog open, a cursor in
     a box, rows ticked for a bulk action, a repair order on screen with an
     editable grid -- nothing moves underneath the person using it. A band
     appears saying the screen is behind, and they refresh when they are
     ready. Pulling the floor out from under someone mid-ticket is how an
     advisor stops trusting the app, and no amount of freshness is worth that.
   ================================================================== */

// Slow enough that eight workstations asking cost nothing, quick enough that
// "did that land?" is answered before anybody walks over to ask.
const POLL_MS = 12000;
// Screens that show no shop records. A change elsewhere is real, but there is
// nothing on these to correct, so saying so would just be noise.
const IGNORED_VIEWS = new Set(["backup", "updates"]);

// The counter as of what is currently drawn. Null means "whatever it says
// next is current" -- the state right after this PC loads or saves something,
// and also what keeps the very first poll from announcing a change.
let seen = null;

function activeViewName() {
  const active = $(".view.active");
  return active ? active.id.replace(/^view-/, "") : "";
}

async function readRevision() {
  const body = await get("/api/pulse");
  return Number(body && body.revision) || 0;
}

/* Is it safe to redraw this screen without asking?

   Everything here is a reason to leave well alone, and the list is meant to
   stay short and obvious rather than clever -- a wrong "yes" throws away work
   somebody was in the middle of, while a wrong "no" only costs them a click.
*/
function canRefreshUnasked() {
  const view = activeViewName();
  // The vehicle's own page is not in this map, on purpose: it carries the
  // editable parts-and-labour grid, so it is never redrawn unasked.
  if (!VIEW_LOADERS[view]) return false;
  if ($("dialog[open]")) return false;
  const el = document.activeElement;
  if (el && ((el.matches && el.matches("input, textarea, select")) || el.isContentEditable)) return false;
  // Rows ticked for a bulk action: reloading a list clears its selection, so
  // this would silently undo the picking somebody just did.
  const selections = [state.vehicleSelection, state.taskSelection, state.coresSelected, state.returnsSelected];
  return !selections.some((set) => set && set.size);
}

function refreshActiveScreen() {
  const view = activeViewName();
  if (view === "vehicle-detail") return loadVehicleDetail();
  return runViewLoader(view);
}

function showStaleBar(show) {
  const bar = $("#stale-bar");
  if (bar) bar.hidden = !show;
}

/* Whatever the counter says next is current.

   Called when a screen finishes loading and after anything this PC saves --
   because a save is always followed by the screen reloading itself, so the
   fetch that answers it carries the other PC's changes along with our own.
   Costs no request of its own: the next scheduled poll adopts the number.
*/
function markCurrent() {
  seen = null;
  showStaleBar(false);
}

async function checkPulse() {
  if (document.visibilityState === "hidden") return;
  let revision;
  try {
    revision = await readRevision();
  } catch {
    return;
  }
  if (seen === null || revision === seen) {
    seen = revision;
    return;
  }
  if (IGNORED_VIEWS.has(activeViewName())) {
    // Nothing on screen to correct -- but the change is accounted for, so
    // walking back to the board doesn't arrive carrying a stale warning.
    seen = revision;
    return;
  }
  if (canRefreshUnasked()) {
    seen = revision;
    showStaleBar(false);
    refreshActiveScreen();
    return;
  }
  // Held back until they are ready. The counter is adopted at the same time,
  // so the band says "something changed" once rather than counting how often.
  seen = revision;
  showStaleBar(true);
}

export function wirePulse() {
  const bar = $("#stale-bar");
  if (!bar) return;
  $("#stale-refresh").addEventListener("click", () => {
    markCurrent();
    refreshActiveScreen();
  });
  // Dismiss hides this change, not every future one: the counter has already
  // been adopted, so the band comes back the next time something moves. A
  // warning that will not go away is a warning people learn to look past.
  $("#stale-dismiss").addEventListener("click", () => showStaleBar(false));

  document.addEventListener("recon:wrote", markCurrent);
  document.addEventListener("recon:viewshown", markCurrent);
  document.addEventListener("visibilitychange", () => {
    // Back from the parts counter, or from a morning in another tab. The
    // stalest a screen ever gets is exactly here, so ask straight away.
    if (document.visibilityState === "visible") checkPulse();
  });

  checkPulse();
  return setInterval(checkPulse, POLL_MS);
}
