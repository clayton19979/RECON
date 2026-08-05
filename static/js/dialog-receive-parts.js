import { $, $$, get, post } from "./core.js";
import { toast } from "./notify.js";
import { esc, money, withLoading } from "./shortcuts.js";
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
        ${/* Its own class, not a second .rl-note: the price-changed note is
             found by class and a second match would swallow it. */""}
        ${line.core > 0 ? `<span class="rl-note rl-core-note">plus ${money(line.core)} core deposit each</span>` : ""}
      </div>
      <span class="rl-qty">${line.remaining} ×</span>
      <input class="rl-cost" type="number" min="0" step="0.01" value="${line.quoted}"
             data-id="${line.id}" aria-label="Invoice price for ${esc(line.desc)}">
      <span class="rl-total">${money(line.remaining * line.quoted)}</span>
    </div>`;
}

/* ---------- which vendor the dialog opens on ----------

   The dropdown's first option is "＋ New vendor…", and a <select> opens on its
   first option. So on a shop with vendors on file -- which is every shop after
   its first week -- this dialog opened claiming you were adding a new vendor,
   with the name box hidden (it was tied to whether any vendors existed rather
   than to what was selected). Pressing Post & Receive answered "Enter the
   vendor's name" and there was no box on screen to type one into. The only way
   through was to notice the dropdown and pick the supplier by hand, every
   time, on the app's most-used money action.

   The box now follows the selection, and the selection is a real guess rather
   than an accident of option order. In priority:

     1. The vendor on the purchase order these lines were ordered against. If
        somebody wrote down who the PO went to, that is not a guess at all.
     2. The vendor the last part on this same ticket was received from. Parts
        for one car usually come off one supplier's truck, and receiving the
        rest of an order is the common case.
     3. The vendor the shop bought from most recently, shop-wide.

   Only 1 and 2 are stated on screen; 3 is a convenience and says nothing,
   because "we happened to buy from them last" is not a claim about these
   parts. Nothing here is ever posted unread -- the name is in the dropdown
   the whole time, and a wrong guess costs one click to change. */
export function preferredVendor(lines, vendors, order) {
  const known = new Set(vendors.map((v) => v.id));
  const items = order?.estimate?.items || [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = new Set(lines.map((l) => l.id));

  // 1. The PO these lines went out on. Only when the lines agree on a single
  // PO -- receiving two batches from two suppliers at once has no one answer,
  // and picking either of them would be stating something untrue.
  const poIds = new Set([...ids].map((id) => byId.get(id)?.purchase_order_id).filter(Boolean));
  if (poIds.size === 1) {
    const po = (order?.purchase_orders || []).find((p) => p.id === [...poIds][0]);
    if (po?.vendor_id && known.has(po.vendor_id)) {
      return { id: po.vendor_id, why: `On purchase order ${po.number}` };
    }
  }

  // 2. The last part received on this ticket. Newest first by the line's own
  // order, which is the sequence they were received in.
  const received = items.filter((i) => i.received_vendor_id && known.has(i.received_vendor_id));
  if (received.length) {
    const last = received[received.length - 1];
    return { id: last.received_vendor_id, why: "Last received from on this ticket" };
  }

  // 3. Whoever the shop bought from most recently. Silent: see above.
  const used = vendors.filter((v) => v.last_invoice_at);
  if (used.length) {
    const latest = used.reduce((a, b) => (b.last_invoice_at > a.last_invoice_at ? b : a));
    return { id: latest.id, why: "" };
  }
  return null;
}

// One writer for the vendor row: which option is selected, whether the
// new-vendor name box is on screen, and the note saying why. Called on open
// and on every change of the dropdown, so the three can never disagree --
// that disagreement is the bug this section exists for.
export function syncReceiveVendorRow(why = "") {
  const select = $("#receive-vendor");
  const isNew = select.value === "__new__";
  $("#receive-new-vendor").style.display = isNew ? "" : "none";
  const note = $("#receive-vendor-why");
  if (!note) return;
  note.textContent = isNew ? "" : why;
  note.hidden = isNew || !why;
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
    // The deposit is charged on the same vendor invoice as the part, so it
    // belongs in the total this dialog promises before you post it -- the
    // number here has to be the number on the paper in your hand.
    const core = row.querySelector(".ei-core-on")?.checked
      ? parseFloat(row.querySelector(".ei-core")?.value || "0") || 0
      : 0;
    // `quoted` is the price written on the ticket line; it never changes while
    // the dialog is open, and it is what the entered price is checked against
    // and what decides whether this line needs an override sent at all.
    return { id: Number(cb.dataset.id), desc, remaining, quoted: cost, core };
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
  const preferred = preferredVendor(lines, vendors, state.detail?.order);
  if (preferred) $("#receive-vendor").value = String(preferred.id);
  syncReceiveVendorRow(preferred?.why || "");
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
  let coreTotal = 0;
  for (const line of lines) {
    coreTotal += line.remaining * (line.core || 0);
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

  // Deposits are posted as their own lines on the vendor invoice, so they are
  // shown as their own line here: the Total is what the bill will say.
  const coreLine = coreTotal
    ? `<div class="cost-line"><span>Parts</span><span class="num">${money(subtotal)}</span></div>
       <div class="cost-line"><span>Core deposits</span><span class="num">${money(coreTotal)}</span></div>`
    : "";
  $("#receive-total-summary").innerHTML = coreLine + `
    <div class="cost-line"><span>Subtotal</span><span class="num">${money(subtotal + coreTotal)}</span></div>
    <div class="cost-line total"><span>Total</span><span class="num">${money(subtotal + coreTotal + tax)}</span></div>
  `;
}

export function wireReceiveDialog() {
  $("#receive-cancel").addEventListener("click", () => $("#receive-dialog").close());
  $("#receive-cancel-2").addEventListener("click", () => $("#receive-dialog").close());
  // Walking away from the dialog cancels whatever it was opened in aid of.
  // Without this, backing out of a close-out and receiving some other part an
  // hour later would close the first ticket out of nowhere.
  $("#receive-dialog").addEventListener("close", () => { state.afterReceive = null; });
  // Picking a vendor by hand drops the note: it explained the app's guess, and
  // once you have overruled it there is nothing left for it to explain.
  $("#receive-vendor").addEventListener("change", () => syncReceiveVendorRow(""));
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
        });
        // Read before the dialog closes: abandoning it clears this (see the
        // close handler below), and closing it is how a successful post ends.
        const next = state.afterReceive;
        state.afterReceive = null;
        $("#receive-dialog").close();
        // Says out loud when a price was corrected: that edit changes what
        // the car cost, and it should not land silently.
        toast(changed
          ? `Parts received and posted to A/P — ${changed} price${changed === 1 ? "" : "s"} updated from the invoice`
          : "Parts received and posted to A/P");
        // The step whoever opened this dialog was in the middle of -- closing
        // a ticket out is the one case today. It reloads the screen itself,
        // so it stands in for the reload rather than running alongside it.
        if (next) return void (await next());
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
