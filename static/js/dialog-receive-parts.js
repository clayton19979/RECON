import { $, $$, get, post } from "./core.js";
import { toast } from "./notify.js";
import { currentActor, esc, money, withLoading } from "./shortcuts.js";
import { state } from "./state.js";
import { loadVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   RECEIVE PARTS DIALOG

   Receiving does two things at once: it moves the line to "received" (so it
   starts counting toward what the car cost) and it posts a vendor invoice
   into A/P. Both used to be written at the price on the ticket line, with no
   way to say otherwise -- so when the invoice came in at a different number,
   which on used and junkyard parts is the normal case, the only repair was to
   edit the estimate line afterwards. That fixes the car's cost and leaves the
   A/P invoice showing what the shop guessed the part would be, which is a bill
   that doesn't match the vendor's.

   So the price is entered here, against the invoice, and both records are
   written from the same figure. Each box starts at the price on the line, so a
   part that came in as expected is still just Vendor, Invoice #, Post.
   ================================================================== */

// A cost box's value, or null if it's blank or not a number -- the two cases
// that must block the post rather than quietly post $0 to the vendor's bill.
function lineCostValue(input) {
  const raw = (input.value || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function receiveLineRow(line) {
  return `
    <div class="receive-line" data-id="${line.id}">
      <div class="rl-main">
        <span class="rl-desc">${esc(line.desc)}</span>
        <span class="rl-note" hidden></span>
      </div>
      <span class="rl-qty">${line.remaining} ×</span>
      <input class="rl-cost" type="number" min="0" step="0.01" value="${line.quoted}"
             data-id="${line.id}" aria-label="Invoice price for ${esc(line.desc)}">
      <span class="rl-total">${money(line.remaining * line.quoted)}</span>
    </div>`;
}

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
    // `quoted` is the price written on the ticket line; it never changes while
    // the dialog is open, and it is what the entered price is checked against
    // and what decides whether this line needs an override sent at all.
    return { id: Number(cb.dataset.id), desc, remaining, quoted: cost };
  });
  state.receiveLines = lines;

  $("#receive-lines").innerHTML = `
    <div class="receive-line head">
      <span class="rl-main">Part</span>
      <span class="rl-qty">Qty</span>
      <span class="rl-cost-head">Invoice price</span>
      <span class="rl-total">Line total</span>
    </div>` + lines.map(receiveLineRow).join("");
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

/* Repaints every number the dialog shows from what's currently in the boxes:
   each line's total, the "was written up at" note on the lines that moved, and
   the invoice subtotal/total. One writer for all of them, so the note beside a
   line and the total at the bottom can't disagree about the same edit.

   The per-line note is a data-entry check, not a margin: it catches a typed
   price that doesn't match what the line said, at the moment there's still an
   invoice in hand to check it against. It is deliberately not totalled up into
   an over/under figure -- the shop doesn't quote recon work, so there is no
   estimate for a ticket to come in over. */
function updateReceiveTotalSummary() {
  const lines = state.receiveLines || [];
  const tax = parseFloat($("#receive-tax")?.value || "0");
  let subtotal = 0;
  for (const line of lines) {
    const row = $(`.receive-line[data-id="${line.id}"]`, $("#receive-lines"));
    if (!row) continue;
    const entered = lineCostValue($(".rl-cost", row));
    const note = $(".rl-note", row);
    const total = $(".rl-total", row);
    if (entered === null) {
      row.classList.add("bad");
      note.hidden = false;
      note.className = "rl-note bad";
      note.textContent = "Enter the price from the invoice";
      total.textContent = "—";
      continue;
    }
    row.classList.remove("bad");
    subtotal += line.remaining * entered;
    total.textContent = money(line.remaining * entered);
    const diff = entered - line.quoted;
    if (Math.abs(diff) < 0.005) {
      note.hidden = true;
      note.textContent = "";
    } else {
      note.hidden = false;
      note.className = `rl-note ${diff > 0 ? "over" : "under"}`;
      note.textContent = `Written up at ${money(line.quoted)} — ${money(Math.abs(diff))} ${diff > 0 ? "more" : "less"} each`;
    }
  }

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
  // Delegated: the line rows are rebuilt every time the dialog opens.
  $("#receive-lines").addEventListener("input", (e) => {
    if (e.target instanceof Element && e.target.matches(".rl-cost")) updateReceiveTotalSummary();
  });
  $("#receive-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        // Prices first: a blank or negative box must stop the post before a
        // vendor gets created for an invoice that then fails to save.
        const lines = state.receiveLines || [];
        const overrides = {};
        let changed = 0;
        for (const line of lines) {
          const input = $(`.receive-line[data-id="${line.id}"] .rl-cost`, $("#receive-lines"));
          const entered = input ? lineCostValue(input) : null;
          if (entered === null) {
            if (input) input.focus();
            return toast(`Enter the invoice price for “${line.desc}”`, true);
          }
          if (Math.abs(entered - line.quoted) >= 0.005) {
            overrides[line.id] = entered;
            changed += 1;
          }
        }

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
          item_ids: lines.map((l) => l.id),
          vendor_id: vendorId,
          invoice_number: invoiceNumber,
          tax: parseFloat($("#receive-tax").value || "0"),
          cost_overrides: overrides,
          actor: currentActor(),
        });
        $("#receive-dialog").close();
        // Says out loud when a price was corrected: that edit changes what
        // the car cost, and it should not land silently.
        toast(changed
          ? `Parts received and posted to A/P — ${changed} price${changed === 1 ? "" : "s"} updated from the invoice`
          : "Parts received and posted to A/P");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
