import { $, get, patch } from "./core.js";
import { toast } from "./notify.js";
import { currentActor, esc, withLoading } from "./shortcuts.js";
import { state } from "./state.js";
import { showView } from "./error-boundary.js";

/* ==================================================================
   MOVE TICKET BETWEEN RECON AND WE-OWE
   ==================================================================
   A car gets written up as recon and turns out to be a we-owe the lot already
   sold, or the reverse. The only previous fix was deleting the ticket and
   starting again, which threw away the estimate, the parts and any vendor
   invoice posted against it -- so the wrong ticket got kept and its cost sat
   on the wrong vehicle. */
export async function openMoveSegmentDialog() {
  const order = state.detail.order;
  const movingTo = order.segment === "recon" ? "we_owe" : "recon";
  const select = $("#move-segment-target");
  select.innerHTML = `<option value="">Loading…</option>`;
  $("#move-segment-desc").textContent = order.segment === "recon"
    ? `${order.number} is on a recon vehicle. Pick the we-owe it really belongs to.`
    : `${order.number} is on a we-owe. Pick the recon vehicle it really belongs to.`;
  $("#move-segment-dialog").showModal();

  try {
    // The live board only -- a ticket must not be moved onto a vehicle that's
    // already been sent to History, which the server rejects anyway.
    const rows = await get(`/api/vehicles-board?segment=${movingTo}`);
    if (!rows.length) {
      select.innerHTML = `<option value="">No ${movingTo === "recon" ? "recon vehicles" : "we-owe items"} to move to</option>`;
      return;
    }
    select.innerHTML = rows.map((r) => {
      const id = movingTo === "recon" ? r.recon_id : r.we_owe_id;
      const label = movingTo === "recon"
        ? `${r.stock_number || "—"} · ${r.vehicle}`
        : `${r.customer_name || "—"} · ${r.vehicle}${r.description ? ` · ${r.description}` : ""}`;
      return `<option value="${id}">${esc(label)}</option>`;
    }).join("");
  } catch (err) {
    select.innerHTML = `<option value="">Could not load vehicles</option>`;
    toast(err.message, true);
  }
}

export function wireMoveSegmentDialog() {
  const dialog = $("#move-segment-dialog");
  const close = () => dialog.close();
  $("#move-segment-cancel").addEventListener("click", close);
  $("#move-segment-cancel-2").addEventListener("click", close);
  $("#move-segment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetId = $("#move-segment-target").value;
    if (!targetId) return toast("Pick a vehicle to move this ticket to", true);
    const order = state.detail.order;
    const movingTo = order.segment === "recon" ? "we_owe" : "recon";
    await withLoading(e.submitter, "Moving…", async () => {
      try {
        await patch(`/api/orders/${order.id}/segment`, {
          segment: movingTo,
          [movingTo === "recon" ? "recon_vehicle_id" : "we_owe_id"]: Number(targetId),
          actor: currentActor(),
        });
        dialog.close();
        toast("Ticket moved");
        // The ticket now belongs to a different vehicle, so the page we're
        // standing on no longer owns it -- go back to the board rather than
        // showing a detail view for a ticket that has left.
        showView("vehicles");
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
