import { $, $$, get, post } from "./core.js";
import { toast } from "./notify.js";
import { currentActor, esc, money, withLoading } from "./shortcuts.js";
import { state } from "./state.js";
import { loadVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   RECEIVE PARTS DIALOG
   ================================================================== */
export async function openReceiveDialog() {
  const box = $("#vd-estimate-items");
  const checked = $$(".ei-receive-check:checked", box);
  if (!checked.length) return;
  const lines = checked.map((cb) => {
    const row = cb.closest(".part-row");
    const desc = row.querySelector(".ei-desc").value.trim() || "(no description)";
    const qty = parseFloat(row.querySelector(".ei-qty").value || "0");
    const receivedQty = Number(row.dataset.receivedQuantity || 0);
    const remaining = qty - receivedQty;
    const cost = parseFloat(row.querySelector(".ei-cost").value || "0");
    return { id: Number(cb.dataset.id), desc, remaining, cost };
  });
  state.receiveLines = lines;

  $("#receive-lines").innerHTML = lines.map((l) => `
    <div class="kv-row"><span class="kv-label">${esc(l.desc)}</span><span class="kv-value">${l.remaining} × ${money(l.cost)}</span></div>
  `).join("");
  updateReceiveTotalSummary();

  const vendors = await get("/api/vendors").catch(() => []);
  state.vendors = vendors;
  $("#receive-vendor").innerHTML = `<option value="__new__">＋ New vendor…</option>` + vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("");
  $("#receive-new-vendor").style.display = vendors.length ? "none" : "";
  $("#receive-invoice-number").value = "";
  $("#receive-new-vendor-name").value = "";
  $("#receive-tax").value = "0";
  $("#receive-dialog").showModal();
}

function updateReceiveTotalSummary() {
  const lines = state.receiveLines || [];
  const tax = parseFloat($("#receive-tax")?.value || "0");
  const subtotal = lines.reduce((s, l) => s + l.remaining * l.cost, 0);
  $("#receive-total-summary").innerHTML = `
    <div class="cost-line"><span>Subtotal</span><span class="num">${money(subtotal)}</span></div>
    <div class="cost-line total"><span>Total</span><span class="num">${money(subtotal + tax)}</span></div>
  `;
}

export function wireReceiveDialog() {
  $("#receive-cancel").addEventListener("click", () => $("#receive-dialog").close());
  $("#receive-cancel-2").addEventListener("click", () => $("#receive-dialog").close());
  $("#receive-vendor").addEventListener("change", () => {
    $("#receive-new-vendor").style.display = $("#receive-vendor").value === "__new__" ? "" : "none";
  });
  $("#receive-tax").addEventListener("input", updateReceiveTotalSummary);
  $("#receive-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        let vendorId = $("#receive-vendor").value;
        if (vendorId === "__new__") {
          const name = $("#receive-new-vendor-name").value.trim();
          if (!name) return toast("Enter the vendor's name", true);
          const vendor = await post("/api/vendors", { name });
          vendorId = vendor.id;
        } else {
          vendorId = Number(vendorId);
        }
        const invoiceNumber = $("#receive-invoice-number").value.trim();
        if (!invoiceNumber) return toast("Enter an invoice number", true);
        await post(`/api/orders/${state.detail.order.id}/estimate/receive-parts`, {
          item_ids: (state.receiveLines || []).map((l) => l.id),
          vendor_id: vendorId,
          invoice_number: invoiceNumber,
          tax: parseFloat($("#receive-tax").value || "0"),
          actor: currentActor(),
        });
        $("#receive-dialog").close();
        toast("Parts received and posted to A/P");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
