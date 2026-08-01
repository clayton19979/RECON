import { $, $$, get, patch, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { currentActor, esc, fmtDate, money, relativeTime, withLoading } from "./shortcuts.js";
import { emptyRow, emptyState } from "./empty-states.js";
import { state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { openVehicleDetail } from "./vehicle-detail.js";
import { computeQuickRange } from "./reports.js";

/* ==================================================================
   ACCOUNTING (A/P)
   ================================================================== */
export async function loadAccountingView() {
  try {
    const [vendors, orders, audits] = await Promise.all([
      get("/api/vendors"), get("/api/orders"), get("/api/accounting/audits"),
    ]);
    state.vendors = vendors;
    state.orders = orders;
    state.apAudits = audits;
    // Rebuilding the selects snaps them back to their first option -- keep
    // whatever the user had picked (a held-for-review invoice must not be
    // silently re-pointed at the wrong vendor or RO).
    const keepVendor = $("#ap-vendor").value;
    const keepOrder = $("#ap-order").value;
    renderVendorSelect();
    renderVendorChips();
    renderPoSelect();
    if (keepVendor && [...$("#ap-vendor").options].some((o) => o.value === keepVendor)) $("#ap-vendor").value = keepVendor;
    if (keepOrder && [...$("#ap-order").options].some((o) => o.value === keepOrder)) $("#ap-order").value = keepOrder;
    renderAuditList(audits);
    if (!$("#ap-invoice-items").children.length) addApLine();
  } catch (err) {
    renderViewFailure("accounting", err);
    return;
  }
  await loadApTable();
}

/* Same rule the Reports toolbar follows (see refreshQuickRange there): a chip
   is a name, not the two dates it meant when it was clicked. This screen has
   no saved prefs, so the only way it goes stale is being left open -- which is
   exactly what happens here, and the shop works evenings, so "Today" sitting
   lit over yesterday's invoices is a real morning. Returns nothing; it just
   corrects state and the two date fields before the fetch reads them. */
function refreshApRange() {
  if (!state.apRange) return;
  const { start, end } = computeQuickRange(state.apRange);
  if (start === state.apFilter.start && end === state.apFilter.end) return;
  state.apFilter = { start, end };
  $("#ap-filter-start").value = start;
  $("#ap-filter-end").value = end;
}

async function loadApTable() {
  refreshApRange();
  const { start, end } = state.apFilter;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  try {
    state.apInvoices = await get(`/api/ap/invoices?${params}`);
    renderApTable(filterApInvoices(state.apInvoices));
    renderApStats();
  } catch (err) {
    renderViewFailure("accounting", err, [["#ap-table", 8]]);
  }
}

// The money screen opens with the money: what the visible range spent, and
// what needs a human decision.
function renderApStats() {
  const live = state.apInvoices.filter((a) => a.status !== "voided");
  const total = live.reduce((s, a) => s + (a.total || 0), 0);
  const held = state.apAudits.filter((a) => a.status === "review_required").length;
  const voided = state.apInvoices.length - live.length;
  $("#ap-stats").innerHTML = `
    <div class="stat">
      <div class="stat-label">Invoices</div>
      <div class="stat-value">${live.length}</div>
      <div class="stat-sub">${voided ? `plus ${voided} voided` : "in the selected range"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Posted</div>
      <div class="stat-value num">${money(total)}</div>
      <div class="stat-sub">excluding voided</div>
    </div>
    <div class="stat">
      <div class="stat-label">Held for Review</div>
      <div class="stat-value${held ? " warn" : ""}">${held}</div>
      <div class="stat-sub">${held ? "see the Control Log" : "nothing waiting on approval"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Vendors</div>
      <div class="stat-value">${state.vendors.length}</div>
      <div class="stat-sub">${state.vendors.length ? "on file" : "add one to post invoices"}</div>
    </div>`;
}

function filterApInvoices(invoices) {
  const query = (state.apSearch || "").toLowerCase();
  if (!query) return invoices;
  return invoices.filter((a) =>
    a.invoice_number.toLowerCase().includes(query) ||
    a.vendor_name.toLowerCase().includes(query) ||
    (a.po_number || "").toLowerCase().includes(query) ||
    a.vehicle_label.toLowerCase().includes(query) ||
    // Every car on the invoice, not just the one the summary label names --
    // searching the second car on a shared invoice has to find it.
    (a.coverage || []).some((c) =>
      (c.vehicle_label || "").toLowerCase().includes(query) ||
      (c.ro_number || "").toLowerCase().includes(query))
  );
}
function renderVendorSelect() {
  $("#ap-vendor").innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("") || `<option value="">Add a vendor first</option>`;
}
function renderVendorChips() {
  $("#vendor-list").innerHTML = state.vendors.map((v) => `<span class="vendor-chip clickable" data-id="${v.id}" role="button" tabindex="0" title="Click to edit">${esc(v.name)}${v.account_number ? ` · ${esc(v.account_number)}` : ""}</span>`).join("") || emptyState({ icon: "invoice", title: "No vendors yet", hint: "Add the parts suppliers you buy from so invoices can be posted against them.", compact: true });
  $$(".vendor-chip.clickable", $("#vendor-list")).forEach((chip) => {
    chip.addEventListener("click", () => openVendorForEdit(Number(chip.dataset.id)));
    chip.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openVendorForEdit(Number(chip.dataset.id));
    });
  });
}

let editingVendorId = null;
function openVendorForEdit(vendorId) {
  const vendor = state.vendors.find((v) => v.id === vendorId);
  if (!vendor) return;
  editingVendorId = vendorId;
  // namedItem("name"), not .name: a <form>'s own `name` IDL attribute shadows
  // the input named "name" (form.name is a string), and jsdom's form-controls
  // collection has the same collision on *its* named getter -- elements.name
  // hands back the collection's own property there, not the input. namedItem
  // is the one lookup with no namespace to collide with, so vendorField uses
  // it for every field rather than betting on which names are safe.
  const form = $("#vendor-form");
  form.hidden = false; // the form is folded away until an add or edit needs it
  const vendorField = (n) => form.elements.namedItem(n);
  vendorField("name").value = vendor.name;
  vendorField("aliases").value = vendor.aliases.join(", ");
  vendorField("account_number").value = vendor.account_number || "";
  $("#vendor-form-title").textContent = `Editing ${vendor.name}`;
  $("#vendor-form-submit").textContent = "Update Vendor";
  $("#vendor-form-cancel").style.display = "";
  vendorField("name").focus();
}
function cancelVendorEdit() {
  editingVendorId = null;
  $("#vendor-form").reset();
  $("#vendor-form").hidden = true;
  $("#vendor-form-title").textContent = "Vendors";
  $("#vendor-form-submit").textContent = "Save Vendor";
  $("#vendor-form-cancel").style.display = "none";
}
/* The ticket picker is now optional and posts an order id outright, instead
   of a PO string the server had to reverse-match to a repair order. Choosing
   a ticket is a statement of fact; guessing from a reference number was not.
   Picking one still fills the PO box with the stock number, because that's
   the reference the vendor was actually given. */
function renderPoSelect() {
  const open = state.orders.filter((o) => o.status !== "complete");
  const options = open.map((o) => {
    const label = o.stock_number
      ? `${o.stock_number} · ${o.number} · ${o.year} ${o.make} ${o.model}`
      : `${o.number} · ${o.customer_name} · ${o.year} ${o.make} ${o.model}`;
    return `<option value="${o.id}" data-po="${esc(o.stock_number || o.number)}">${esc(label)}</option>`;
  }).join("");
  $("#ap-order").innerHTML = `<option value="">No ticket — general expense</option>` + options;
}
/* What the void actually did, in one line.

   A bare "Invoice voided" hid the part of it that matters: a car's cost can
   drop by several hundred dollars and parts can land back in the board's
   Parts column, and the person who clicked the button should not have to go
   and check whether that happened. */
function voidResultMessage(result) {
  const n = (result && result.unreceived_items) || 0;
  const credits = (result && result.credits_cleared) || 0;
  if (!n && !credits) return "Invoice voided";
  const bits = [];
  if (n) {
    const value = result.unreceived_value ? ` (${money(result.unreceived_value)} off the vehicle)` : "";
    bits.push(`${n} part${n === 1 ? "" : "s"} back on order${value}`);
  }
  if (credits) bits.push(`${credits} return${credits === 1 ? "" : "s"} waiting on a credit again`);
  return `Invoice voided — ${bits.join(", ")}`;
}

function renderApTable(invoices) {
  const liveTotal = invoices.filter((a) => a.status !== "voided").reduce((s, a) => s + (a.total || 0), 0);
  $("#ap-count").textContent = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} · ${money(liveTotal)}`;
  // Every segment's rows can jump to a vehicle page now that retail has one.
  // An invoice covering more than one car doesn't get a row-level jump: there
  // is no single "this vehicle" to open, so each car in the cell carries its
  // own link instead of the row silently picking one of them.
  $("#ap-table").innerHTML = invoices.length ? invoices.map((a) => {
    const covers = a.coverage || [];
    const only = covers.length === 1 ? covers[0] : null;
    const clickable = only != null && coverageOpenable(only);
    const refId = only ? coverageRefId(only) : null;
    const voided = a.status === "voided";
    const rowTitle = covers.length > 1
      ? `Covers ${covers.length} vehicles — click one to open it`
      : (clickable ? "Open this vehicle" : "No vehicle page for this ticket");
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-segment="${esc(only.segment)}" data-ref-id="${refId}" role="button" tabindex="0" ` : ""}title="${esc(rowTitle)}">
      <td>${esc(a.invoice_number)}</td>
      <td>${esc(fmtDate(a.posted_at))}</td>
      <td>${esc(a.vendor_name)}</td><td>${esc(a.po_number)}</td>
      ${apVehicleCell(a)}<td class="num-col">${money(a.total)}</td>
      <td><span class="pill ${voided ? "pill-void" : "pill-done"}">${voided ? "Voided" : "Posted"}</span></td>
      <td class="actions-col">${voided ? "" : `<button type="button" class="btn btn-ghost btn-xs btn-danger-ghost ap-void" data-id="${a.id}" data-number="${esc(a.invoice_number)}">Void</button>`}</td>
    </tr>
  `;
  }).join("") : emptyRow(8, state.apSearch
    ? {
        icon: "search",
        title: "No invoices match that search",
        hint: `Nothing matched "${state.apSearch}". Searches cover invoice number, vendor, PO, and vehicle.`,
        actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="ap-clear-search">Clear search</button>`,
      }
    : {
        icon: "invoice",
        title: "No vendor invoices in this range",
        hint: "Post one with the form below, or widen the date range. Receiving parts on a ticket also posts an invoice here automatically.",
      });
  // Rows and the per-vehicle lines inside a shared invoice's cell open the
  // same way; a shared invoice's row is never itself clickable, so the two
  // can't both fire on one click.
  $$(".clickable", $("#ap-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openVehicleDetail(row.dataset.segment, Number(row.dataset.refId));
    });
    // role="button" without keyboard activation is a lie to a screen reader.
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      openVehicleDetail(row.dataset.segment, Number(row.dataset.refId));
    });
  });
  $$(".ap-void", $("#ap-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // don't also trigger the row's open-vehicle click
      if (!(await confirmAction({
        eyebrow: "ACCOUNTS PAYABLE",
        title: `Void invoice ${btn.dataset.number}?`,
        // Says what actually happens to the cars, because voiding is not
        // only a bookkeeping act: any parts this bill received go back to
        // Ordered and their cost comes off the vehicle. That is the whole
        // reason voiding is the right move for a mis-posted invoice -- it
        // is what lets the corrected one be posted afterwards.
        body: "It's kept for the audit trail, and a corrected invoice can be re-posted under the same number. Any parts this invoice received go back to Ordered, and their cost comes off the vehicle.",
        confirmLabel: "Void Invoice",
        danger: true,
      }))) return;
      try {
        const result = await patch(`/api/ap/invoices/${btn.dataset.id}/void`, { actor: currentActor() });
        toast(voidResultMessage(result));
        await loadApTable();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
const AP_AUDIT_PILL = { posted: "pill-done", review_required: "pill-progress", duplicate: "pill-void", voided: "pill-void" };

function renderAuditList(audits) {
  // The log is the only place a failed post is recorded -- severity has to
  // be legible at a glance, not buried in a capitalized enum string.
  $("#audit-list").innerHTML = audits.length ? audits.slice(0, 20).map((a) => `
    <div class="mini-item${a.status === "review_required" ? " is-review" : ""}${a.status === "duplicate" ? " is-duplicate" : ""}">
    <div class="mi-title"><span>${esc(a.invoice_number)}</span><span class="pill ${AP_AUDIT_PILL[a.status] || "pill-void"}">${esc(a.status.replace(/_/g, " "))}</span></div>
    ${a.issues.length ? `<div class="mi-meta issues">${a.issues.map(esc).join("; ")}</div>` : ""}
    <div class="mi-meta" title="${esc(fmtDate(a.created_at))}">${esc(relativeTime(a.created_at))}</div></div>
  `).join("") + (audits.length > 20 ? `<div class="mi-meta">Showing 20 of ${audits.length}</div>` : "")
    : emptyState({ icon: "invoice", title: "No activity yet", hint: "Posting or voiding a vendor invoice is recorded here.", compact: true });
}

// One definition of "blank" shared by the subtotal, the validator and the
// submit payload: a line with no description, no part number and no money.
// Anything else is either a real line or an error the user must fix -- it
// can never be counted on screen and then silently dropped from the POST,
// which is exactly the drift process_invoice's mismatch check would flag.
function apLineState(tr) {
  const desc = tr.querySelector(".apl-desc").value.trim();
  const part = tr.querySelector(".apl-part").value.trim();
  const qty = parseFloat(tr.querySelector(".apl-qty").value || "0");
  const cost = parseFloat(tr.querySelector(".apl-cost").value || "0");
  const hasMoney = qty > 0 && cost !== 0;
  if (!desc && !part && !hasMoney) return "blank";
  if (!desc || qty <= 0) return "invalid";
  return "valid";
}

// Subtotal is always exactly the sum of the countable lines, and Total is
// always exactly Subtotal + Tax -- both are computed outputs precisely so
// they can never drift from what gets posted.
function recalcApTotals() {
  let subtotal = 0;
  $$("#ap-invoice-items tr").forEach((tr) => {
    const qty = parseFloat(tr.querySelector(".apl-qty").value || "0");
    const cost = parseFloat(tr.querySelector(".apl-cost").value || "0");
    const line = apLineState(tr) === "blank" ? 0 : qty * cost;
    tr.querySelector(".apl-line-total").textContent = line ? money(line) : "";
    subtotal += line;
  });
  const tax = parseFloat($("#ap-tax").value || "0");
  const total = subtotal + tax;
  $("#ap-subtotal").textContent = money(subtotal);
  $("#ap-total").textContent = money(total);
  // No longer a gate -- the server-side $500 hold is gone. Purely a nudge to
  // look twice at a big number before it becomes a posted liability.
  $("#ap-over-threshold").hidden = total <= 500;
}

function addApLine() {
  const box = $("#ap-invoice-items");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="apl-kind"><option value="part">Part</option><option value="labor">Labor</option><option value="freight">Freight</option><option value="core_charge">Core charge</option><option value="shop_supplies">Shop supplies</option></select></td>
    <td><input class="apl-part" placeholder="Part #"></td>
    <td><input class="apl-desc" placeholder="Description"></td>
    <td><input class="apl-qty" type="number" min="0.01" step="0.01" value="1" style="width:70px"></td>
    <td><input class="apl-cost" type="number" min="0" step="0.01" value="0" style="width:90px"></td>
    <td class="apl-line-total"></td>
    <td><button type="button" class="rm-btn" aria-label="Remove line">×</button></td>
  `;
  tr.querySelector(".rm-btn").addEventListener("click", () => { tr.remove(); recalcApTotals(); });
  ["input", "change"].forEach((evt) => {
    tr.querySelector(".apl-qty").addEventListener(evt, recalcApTotals);
    tr.querySelector(".apl-cost").addEventListener(evt, recalcApTotals);
  });
  tr.querySelector(".apl-desc").addEventListener("input", () => {
    tr.classList.remove("apl-invalid");
    recalcApTotals();
  });
  box.appendChild(tr);
  recalcApTotals();
}

// Structured post-result feedback in place of the old grey run-on hint line.
function renderApAlert(res) {
  const box = $("#ap-invoice-note");
  if (!res) { box.hidden = true; box.innerHTML = ""; return; }
  const issues = res.issues || [];
  const duplicate = res.status === "duplicate";
  box.className = `ap-alert${duplicate ? " is-duplicate" : ""}`;
  box.innerHTML = `
    <div class="ap-alert-head">
      <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><path d="M12 9v4M12 17h.01M10.3 3.8L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z"/></svg>
      <span>${duplicate ? "Duplicate invoice number" : `Held for review — ${issues.length} issue${issues.length === 1 ? "" : "s"}`}</span>
    </div>
    ${issues.length ? `<ul>${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}`;
  box.hidden = false;
}

function clearApInvoiceForm() {
  $("#ap-invoice-form").reset();
  $("#ap-invoice-items").innerHTML = "";
  addApLine();
  renderApAlert(null);
}

export function wireAccountingView() {
  // History leads the page now, so the head carries a shortcut down to the
  // editor for the mornings that start with a stack of invoices to type.
  $("#ap-jump-post").addEventListener("click", () => {
    const section = $("#ap-post-section");
    if (section.scrollIntoView) section.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#ap-vendor").focus({ preventScroll: true });
  });
  // ＋ Add unfolds the vendor form fresh; pressing it again (or Cancel, or a
  // successful save) folds it back to just the chips.
  $("#vendor-add-btn").addEventListener("click", () => {
    const form = $("#vendor-form");
    const wasOpenForAdd = !form.hidden && editingVendorId === null;
    cancelVendorEdit();
    if (wasOpenForAdd) return;
    form.hidden = false;
    form.elements.namedItem("name").focus();
  });
  $("#ap-add-line").addEventListener("click", addApLine);
  // Picking a ticket fills in the reference the vendor was actually given
  // (the stock number), unless something has already been typed there.
  $("#ap-order").addEventListener("change", (e) => {
    const option = e.target.selectedOptions[0];
    const po = $("#ap-po");
    if (option && option.dataset.po && !po.value.trim()) po.value = option.dataset.po;
  });
  $("#ap-tax").addEventListener("input", recalcApTotals);
  $("#ap-clear-invoice").addEventListener("click", clearApInvoiceForm);
  // A stale warning must never sit under a corrected invoice.
  $("#ap-invoice-form").addEventListener("input", () => {
    if (!$("#ap-invoice-note").hidden) renderApAlert(null);
  });

  $$('#view-accounting [data-ap-range]').forEach((chip) => {
    chip.addEventListener("click", () => {
      const range = computeQuickRange(chip.dataset.apRange);
      state.apRange = chip.dataset.apRange;
      state.apFilter = range;
      $("#ap-filter-start").value = range.start;
      $("#ap-filter-end").value = range.end;
      $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      loadApTable();
    });
  });
  // Hand-edited dates belong to nobody's chip, so the named range goes with
  // the lit class -- otherwise the next load would quietly overwrite what was
  // just typed with whatever the old chip means today.
  const clearApChips = () => {
    state.apRange = "";
    $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
  };
  $("#ap-filter-start").addEventListener("change", () => {
    clearApChips();
    state.apFilter.start = $("#ap-filter-start").value;
    loadApTable();
  });
  $("#ap-filter-end").addEventListener("change", () => {
    clearApChips();
    state.apFilter.end = $("#ap-filter-end").value;
    loadApTable();
  });
  $("#ap-search").addEventListener("input", (e) => {
    state.apSearch = e.target.value.trim();
    renderApTable(filterApInvoices(state.apInvoices));
  });
  $("#ap-table").addEventListener("click", (e) => {
    if (!e.target.closest('[data-empty-action="ap-clear-search"]')) return;
    state.apSearch = "";
    $("#ap-search").value = "";
    renderApTable(filterApInvoices(state.apInvoices));
  });
  $("#vendor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    // namedItem, not the named getter -- see openVendorForEdit.
    const vendorField = (n) => form.elements.namedItem(n);
    const payload = {
      name: vendorField("name").value.trim(),
      aliases: vendorField("aliases").value.split(",").map((s) => s.trim()).filter(Boolean),
      account_number: vendorField("account_number").value.trim(),
    };
    try {
      if (editingVendorId) {
        await patch(`/api/vendors/${editingVendorId}`, payload);
        toast(`${payload.name} updated`);
      } else {
        await post("/api/vendors", payload);
        toast(`${payload.name} saved`);
      }
      cancelVendorEdit();
      await loadAccountingView();
      // The near-certain next action is posting an invoice from the vendor
      // that was just added -- select it.
      if ([...$("#ap-vendor").options].some((o) => o.value === payload.name)) $("#ap-vendor").value = payload.name;
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#vendor-form-cancel").addEventListener("click", cancelVendorEdit);

  $("#ap-invoice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = $$("#ap-invoice-items tr");
    // A line with money on it but no description used to be counted in the
    // on-screen subtotal and then silently dropped from the payload -- the
    // server then held the invoice for a mismatch the user couldn't see.
    // Now it's an error on the field itself.
    const invalid = rows.filter((tr) => apLineState(tr) === "invalid");
    if (invalid.length) {
      invalid.forEach((tr) => tr.classList.add("apl-invalid"));
      invalid[0].querySelector(".apl-desc").focus();
      return toast("Every line with a cost needs a description", true);
    }
    const items = rows.filter((tr) => apLineState(tr) === "valid").map((tr) => ({
      part_number: tr.querySelector(".apl-part").value.trim() || "N/A",
      description: tr.querySelector(".apl-desc").value.trim(),
      quantity: parseFloat(tr.querySelector(".apl-qty").value || "0"),
      unit_cost: parseFloat(tr.querySelector(".apl-cost").value || "0"),
      kind: tr.querySelector(".apl-kind").value,
    }));
    if (!items.length) return toast("Add at least one line item", true);
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
    const tax = parseFloat($("#ap-tax").value || "0");
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        const orderId = $("#ap-order").value;
        const res = await post("/api/agent/invoices/process", {
          vendor_name: $("#ap-vendor").value,
          invoice_number: $("#ap-invoice-number").value.trim(),
          po_number: $("#ap-po").value.trim(),
          order_id: orderId ? Number(orderId) : null,
          subtotal: Math.round(subtotal * 100) / 100,
          tax,
          total: Math.round((subtotal + tax) * 100) / 100,
          items,
          source: "ui",
        });
        if (res.status === "posted") {
          toast("Invoice posted — parts marked received");
          clearApInvoiceForm();
          await loadAccountingView();
        } else {
          renderApAlert(res);
          toast(`Invoice ${res.status.replace("_", " ")}`, true);
          // Refresh the log and table without loadAccountingView, which
          // would rebuild (and blank) the vendor/PO the user just picked.
          try {
            state.apAudits = await get("/api/accounting/audits");
            renderAuditList(state.apAudits);
            await loadApTable();
          } catch { /* the alert is already on screen */ }
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
