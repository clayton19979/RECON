"use strict";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail || message;
    } catch {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}
const get = (path) => api(path);
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function money(value) {
  const n = Number(value || 0);
  const formatted = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}
function currentActor() {
  return state.currentUser || "Unspecified";
}
// Disables a button and swaps its label while an async action is in
// flight, so a slow save doesn't look like nothing happened (and can't be
// double-submitted by an impatient extra click).
async function withLoading(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ---------- state ---------- */
const state = {
  vehicles: [],
  filter: "",
  search: "",
  staff: [],
  vendors: [],
  orders: [],
  currentUser: localStorage.getItem("dao-current-user") || "",
  detail: { segment: null, id: null, item: null, order: null },
};

// Who's actually using the app right now -- every save used to hardcode
// "Clay" as the actor, misattributing everything when anyone else touched
// it. Populated from the staff list, remembered in localStorage.
async function refreshCurrentUserOptions() {
  const select = $("#current-user");
  try {
    const staff = await get("/api/staff");
    select.innerHTML = `<option value="">Unspecified</option>` + staff.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
    select.value = state.currentUser;
  } catch {}
}
function initCurrentUser() {
  refreshCurrentUserOptions();
  $("#current-user").addEventListener("change", () => {
    state.currentUser = $("#current-user").value;
    localStorage.setItem("dao-current-user", state.currentUser);
  });
}

const TRANSITIONS = {
  draft: ["inspection", "cancelled"],
  inspection: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: ["in_progress", "closed"],
  closed: [],
  cancelled: ["draft"],
};
const STATUS_FLOW = ["draft", "inspection", "awaiting_approval", "approved", "in_progress", "completed", "closed"];
const STATUS_LABEL = {
  draft: "Draft", inspection: "Inspection", awaiting_approval: "Awaiting Approval", approved: "Approved",
  in_progress: "In Progress", completed: "Completed", closed: "Closed", cancelled: "Cancelled",
};

/* ---------- nav / shell ---------- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "vehicles") loadVehiclesView();
  if (name === "reports") loadReportsView();
  if (name === "accounting") loadAccountingView();
  if (name === "staff") loadStaffView();
  if (name === "integrations") loadIntegrationsView();
}

const THEMES = ["midnight", "carbon", "slate", "paper"];

function applyTheme(name) {
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("dao-theme", name);
  $$(".theme-option").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === name));
}

function initTheme() {
  const saved = localStorage.getItem("dao-theme");
  applyTheme(THEMES.includes(saved) ? saved : "midnight");

  $("#theme-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#theme-menu").classList.toggle("open");
  });
  $$(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      $("#theme-menu").classList.remove("open");
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".theme-picker")) $("#theme-menu").classList.remove("open");
  });
}

/* ==================================================================
   VEHICLES LIST
   ================================================================== */
async function loadVehiclesView() {
  try {
    state.vehicles = await get("/api/vehicles-board");
  } catch (err) {
    toast(`Could not load vehicles: ${err.message}`, true);
    return;
  }
  renderStats();
  renderVehiclesTable();
}

function renderStats() {
  const recon = state.vehicles.filter((v) => v.segment === "recon" && v.status_bucket === "in_progress");
  const weOwe = state.vehicles.filter((v) => v.segment === "we_owe" && v.status_bucket === "in_progress");
  const open = [...recon, ...weOwe];
  $("#stat-recon-open").textContent = recon.length;
  $("#stat-recon-actual").textContent = `${money(recon.reduce((s, v) => s + v.actual_cost, 0))} in it`;
  $("#stat-we-owe-open").textContent = weOwe.length;
  $("#stat-we-owe-actual").textContent = `${money(weOwe.reduce((s, v) => s + v.actual_cost, 0))} in it`;
  $("#stat-actual-total").textContent = money(open.reduce((s, v) => s + v.actual_cost, 0));
}

function renderVehiclesTable() {
  let rows = state.vehicles;
  if (state.filter) rows = rows.filter((v) => v.segment === state.filter);
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((v) =>
      (v.stock_number || "").toLowerCase().includes(q) ||
      (v.vin || "").toLowerCase().includes(q) ||
      (v.customer_name || "").toLowerCase().includes(q) ||
      v.vehicle.toLowerCase().includes(q)
    );
  }
  $("#vehicles-count").textContent = `${rows.length} vehicle${rows.length === 1 ? "" : "s"}`;
  const body = $("#vehicles-table");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:30px">No vehicles match.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((v) => `
    <tr class="clickable" data-segment="${v.segment}" data-id="${v.segment === "recon" ? v.recon_id : v.we_owe_id}">
      <td class="num">${esc(v.stock_number || "—")}</td>
      <td>
        <div style="font-weight:600">${esc(v.vehicle)}</div>
        <div style="font-size:11.5px;color:var(--ink-faint)">${v.segment === "we_owe" ? esc(v.customer_name || "") : esc(v.vin || "")}</div>
      </td>
      <td><span class="pill ${v.segment === "recon" ? "pill-recon" : "pill-weowe"}">${v.segment === "recon" ? "Recon" : "We-Owe"}</span></td>
      <td><span class="pill ${v.status_bucket === "finished" ? "pill-done" : "pill-progress"}">${esc(STATUS_LABEL[v.status] || v.status)}</span></td>
      <td>${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span>${esc(v.technicians.join(", "))}</span>` : `<span style="color:var(--ink-faint)">—</span>`}</td>
      <td class="num-col">${money(v.actual_cost)}</td>
    </tr>
  `).join("");
  $$("tr.clickable", body).forEach((tr) => {
    tr.addEventListener("click", () => openVehicleDetail(tr.dataset.segment, Number(tr.dataset.id)));
  });
}

function wireVehiclesView() {
  $$(".filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$(".filters .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.filter = chip.dataset.filter;
      renderVehiclesTable();
    });
  });
  $("#global-search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    if (!$("#view-vehicles").classList.contains("active")) showView("vehicles");
    renderVehiclesTable();
  });
  $("#add-recon-btn").addEventListener("click", () => openReconDialog());
  $("#add-we-owe-btn").addEventListener("click", () => openWeOweDialog());
}

/* ==================================================================
   VEHICLE DETAIL
   ================================================================== */
async function openVehicleDetail(segment, id) {
  state.detail = { segment, id, item: null, order: null };
  await loadVehicleDetail();
}
// showView only knows named views wired to the rail; vehicle-detail is entered directly.
function enterVehicleDetailView() {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-vehicle-detail"));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === "vehicles"));
}

async function loadVehicleDetail() {
  const { segment, id } = state.detail;
  let item, orders;
  try {
    item = segment === "recon" ? await get(`/api/recon/vehicles/${id}`) : await get(`/api/we-owe/${id}`);
    const allOrders = await get(`/api/orders?segment=${segment}`);
    orders = allOrders.filter((o) => segment === "recon" ? o.recon_vehicle_id === id : o.we_owe_id === id)
      .sort((a, b) => b.id - a.id);
  } catch (err) {
    toast(`Could not load vehicle: ${err.message}`, true);
    return;
  }
  state.detail.item = item;
  state.detail.ordersHistory = orders;
  const active = orders.find((o) => !["closed", "cancelled"].includes(o.status)) || null;
  enterVehicleDetailView();
  renderDetailHead();
  // Deleting a vehicle with real order history would silently orphan its
  // cost data -- only offer it while there's nothing to lose yet.
  $("#vd-delete").style.display = orders.length === 0 ? "" : "none";
  if (!active) {
    $("#vd-no-order").style.display = "";
    $("#vd-order-content").style.display = "none";
    return;
  }
  $("#vd-no-order").style.display = "none";
  $("#vd-order-content").style.display = "";
  let order;
  try {
    order = await get(`/api/orders/${active.id}`);
  } catch (err) {
    toast(`Could not load repair order: ${err.message}`, true);
    return;
  }
  state.detail.order = order;
  if (!state.staff.length) state.staff = await get("/api/staff");
  renderOrderPanel();
}

function renderDetailHead() {
  const { segment, item } = state.detail;
  if (segment === "recon") {
    $("#vd-title").textContent = `${item.stock_number} — ${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.vin, item.mileage ? `${item.mileage.toLocaleString()} mi` : "", item.trim].filter(Boolean).join(" · ");
    $("#vd-we-owe-status-card").style.display = "none";
    $("#vd-recon-info-card").style.display = "";
    $("#vd-recon-vin").value = item.vin || "";
    $("#vd-recon-mileage").value = item.mileage || 0;
    $("#vd-recon-year").value = item.year;
    $("#vd-recon-make").value = item.make;
    $("#vd-recon-model").value = item.model;
    $("#vd-recon-trim").value = item.trim || "";
    $("#vd-recon-color").value = item.color || "";
    $("#vd-recon-purchase-price").value = item.purchase_price || 0;
  } else {
    $("#vd-title").textContent = `${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.customer_name, item.description].filter(Boolean).join(" · ");
    $("#vd-recon-info-card").style.display = "none";
    $("#vd-we-owe-status-card").style.display = "";
    $("#vd-we-owe-status").value = item.status;
    $("#vd-we-owe-description").value = item.description || "";
    $("#vd-we-owe-category").value = item.category || "";
    $("#vd-we-owe-target").value = item.target_date || "";
  }
  renderCostSummary();
  renderTraceability();
}

function renderCostSummary() {
  const { item } = state.detail;
  const box = $("#vd-cost-summary");
  let lines = `<div class="cost-line"><span>What we have in it</span><span class="num">${money(item.total_cost)}</span></div>`;
  if (state.detail.segment === "recon") {
    lines += `<div class="cost-line"><span>Purchase price</span><span class="num">${money(item.purchase_price)}</span></div>`;
    lines += `<div class="cost-line total"><span>Total invested</span><span class="num">${money(item.purchase_price + item.total_cost)}</span></div>`;
  }
  box.innerHTML = lines;
}

async function renderTraceability() {
  const { segment, item, ordersHistory } = state.detail;
  let apInvoices = [];
  try { apInvoices = await get("/api/ap/invoices"); } catch {}
  const orderIds = new Set(ordersHistory.map((o) => o.id));
  const linked = apInvoices.filter((a) => orderIds.has(a.order_id));
  const box = $("#vd-traceability");
  const rows = [];
  if (segment === "recon") rows.push(["Stock #", esc(item.stock_number)]);
  rows.push(["Repair Orders", ordersHistory.length ? ordersHistory.map((o) => `${esc(o.number)} <span style="color:var(--ink-faint)">(${STATUS_LABEL[o.status] || o.status})</span>`).join("<br>") : "—"]);
  rows.push(["Vendor Invoices (PO#)", linked.length ? linked.map((a) => `${esc(a.invoice_number)} → ${esc(a.ro_number)} <span style="color:var(--ink-faint)">${esc(a.vendor_name)}, ${money(a.total)}</span>`).join("<br>") : "—"]);
  box.innerHTML = rows.map(([label, value]) => `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value" style="text-align:right">${value}</span></div>`).join("");
}

function renderOrderPanel() {
  const order = state.detail.order;
  $("#vd-ro-number").textContent = `Repair Order ${order.number}`;
  renderStatusFlow(order);
  renderEstimate(order);
  renderNotes(order);
  renderActivity(order);
  renderAssignment(order);
}

function renderStatusFlow(order) {
  const status = order.status;
  const flow = $("#vd-status-flow");
  if (status === "cancelled") {
    flow.innerHTML = `<div class="status-step" style="background:var(--crit-tint);color:var(--crit)">Cancelled</div>`;
  } else {
    const idx = STATUS_FLOW.indexOf(status);
    flow.innerHTML = STATUS_FLOW.map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? "current" : "";
      const connector = i > 0 ? `<div class="status-connector ${i <= idx ? "done" : ""}"></div>` : "";
      return `${connector}<div class="status-step ${cls}">${STATUS_LABEL[s]}</div>`;
    }).join("");
  }
  const select = $("#vd-status-select");
  const options = TRANSITIONS[status] || [];
  select.innerHTML = options.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("");
  $("#vd-advance-status").disabled = options.length === 0;
  select.disabled = options.length === 0;
}

function renderEstimate(order) {
  const items = order.estimate ? order.estimate.items : [];
  const box = $("#vd-estimate-items");
  const rowHtml = (item, i) => `
    <div class="part-row" data-index="${i}" data-id="${item.id || ""}">
      <select class="ei-kind">
        <option value="part" ${item.kind === "part" ? "selected" : ""}>Part</option>
        <option value="labor" ${item.kind === "labor" ? "selected" : ""}>Labor</option>
        <option value="fee" ${item.kind === "fee" ? "selected" : ""}>Fee</option>
      </select>
      <input class="ei-desc" value="${esc(item.description || "")}" placeholder="Description">
      <input class="ei-part" value="${esc(item.part_number || "")}" placeholder="Part #">
      <input class="ei-qty" type="number" min="0.01" step="0.01" value="${item.quantity ?? 1}">
      <input class="ei-cost" type="number" min="0" step="0.01" value="${item.unit_cost ?? 0}">
      ${item.id
        ? `<select class="ei-status status-pill sp-${item.status || "quoted"}" ${item.received_invoice_number ? `title="Received via invoice ${esc(item.received_invoice_number)}"` : ""}>
             <option value="quoted" ${item.status === "quoted" ? "selected" : ""}>Quoted</option>
             <option value="ordered" ${item.status === "ordered" ? "selected" : ""}>Ordered</option>
             <option value="received" ${item.status === "received" ? "selected" : ""}>${item.status === "received" && item.received_invoice_number ? `Received (${esc(item.received_invoice_number)})` : "Received"}</option>
           </select>`
        : `<span class="status-pill sp-quoted">Saving…</span>`}
      <button type="button" class="rm-btn" title="Remove line">×</button>
    </div>
  `;
  box.innerHTML =
    `<div class="part-row head"><span>Kind</span><span>Description</span><span>Part #</span><span>Qty</span><span>Cost</span><span>Status</span><span></span></div>` +
    (items.length ? items.map(rowHtml).join("") : `<div class="ei-empty" style="padding:16px;color:var(--ink-faint);font-size:12.5px">No lines yet — add a part or labor entry.</div>`);

  // Every field auto-saves on change -- there is no "forgot to click Save and
  // it silently vanished" window, because nothing is ever left DOM-only.
  $$(".part-row:not(.head)", box).forEach((row) => {
    row.querySelectorAll(".ei-kind, .ei-desc, .ei-part, .ei-qty, .ei-cost").forEach((field) => {
      field.addEventListener("change", () => persistEstimate());
    });
  });
  $$(".rm-btn", box).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest(".part-row");
      const desc = row.querySelector(".ei-desc").value.trim();
      if (desc && !confirm(`Remove "${desc}" from this repair order?`)) return;
      row.remove();
      persistEstimate();
    });
  });
  $$(".ei-status", box).forEach((sel) => {
    const previousValue = sel.value;
    sel.addEventListener("change", async () => {
      const row = sel.closest(".part-row");
      const itemId = row.dataset.id;
      if (!itemId) return;
      let invoiceNumber = "";
      if (sel.value === "received") {
        invoiceNumber = (prompt("Invoice number for this part (for tracking):") || "").trim();
        if (!invoiceNumber) {
          sel.value = previousValue;
          toast("Marking a part received requires an invoice number", true);
          return;
        }
      }
      try {
        await patch(`/api/orders/${order.id}/estimate/items/${itemId}/status`, { status: sel.value, invoice_number: invoiceNumber });
        toast("Status updated");
        // Received/un-received status changes what's actually been spent --
        // reload so the cost numbers (Parts & Labor tally, sidebar Cost
        // Summary, vehicle list) reflect it, not just the status pill.
        await loadVehicleDetail();
      } catch (err) {
        sel.value = previousValue;
        toast(err.message, true);
      }
    });
  });
  const actualParts = items.filter((i) => i.kind === "part").reduce((s, i) => s + i.received_quantity * i.unit_cost, 0);
  const actualOther = items.filter((i) => i.kind !== "part").reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  $("#vd-actual-cost").textContent = money(actualParts + actualOther);
}

function collectEstimateItems() {
  return $$(".part-row:not(.head)", $("#vd-estimate-items")).map((row) => {
    const cost = parseFloat(row.querySelector(".ei-cost").value || "0");
    return {
      id: row.dataset.id ? Number(row.dataset.id) : null,
      kind: row.querySelector(".ei-kind").value,
      description: row.querySelector(".ei-desc").value.trim(),
      part_number: row.querySelector(".ei-part").value.trim(),
      quantity: parseFloat(row.querySelector(".ei-qty").value || "1"),
      unit_cost: cost,
      unit_price: cost,
    };
  }).filter((i) => i.description);
}

// Saves the estimate exactly as it currently sits in the DOM, then re-renders
// from the server's response so ids/status controls attach to new rows.
// Called after every add/edit/remove -- an estimate line is never sitting
// unsaved in the browser waiting to be wiped out by an unrelated action
// elsewhere on the page (that was the bug: adding a part, then clicking any
// other Save/Advance/Order-Parts button, reloaded the page and discarded it).
//
// Fast successive edits (tabbing through several fields) fire several of
// these calls in flight at once; an earlier, slower response landing after
// a newer one would overwrite fresher data with stale data. estimateSaveToken
// tags each call so only the most recently *started* one is allowed to render.
let estimateSaveToken = 0;
async function persistEstimate() {
  const order = state.detail.order;
  if (!order) return;
  const items = collectEstimateItems();
  const token = ++estimateSaveToken;
  try {
    const estimate = await post(`/api/orders/${order.id}/estimate`, { labor_rate: 0, tax_rate: 0, actor: currentActor(), items });
    if (token !== estimateSaveToken) return; // a newer edit has already been sent; drop this stale response
    order.estimate = estimate;
    renderEstimate(order);
  } catch (err) {
    toast(err.message, true);
  }
}

function addEstimateRow(kind, defaults = {}) {
  const box = $("#vd-estimate-items");
  const empty = $(".ei-empty", box);
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "part-row";
  row.dataset.id = "";
  const label = kind === "labor" ? "Labor" : kind === "fee" ? "Fee" : "Part";
  row.innerHTML = `
    <select class="ei-kind">
      <option value="part" ${kind === "part" ? "selected" : ""}>Part</option>
      <option value="labor" ${kind === "labor" ? "selected" : ""}>Labor</option>
      <option value="fee" ${kind === "fee" ? "selected" : ""}>Fee</option>
    </select>
    <input class="ei-desc" placeholder="Description" value="${esc(defaults.description || `New ${label.toLowerCase()}`)}">
    <input class="ei-part" placeholder="Part #" value="${esc(defaults.part_number || "")}">
    <input class="ei-qty" type="number" min="0.01" step="0.01" value="${defaults.quantity ?? 1}">
    <input class="ei-cost" type="number" min="0" step="0.01" value="${defaults.unit_cost ?? 0}">
    <span class="status-pill sp-quoted">Saving…</span>
    <button type="button" class="rm-btn" title="Remove line">×</button>
  `;
  row.querySelector(".rm-btn").addEventListener("click", () => {
    row.remove();
    persistEstimate();
  });
  box.appendChild(row);
  // Persist immediately -- this is a real line on the RO from the moment it
  // appears, matching a one-click "add at cost" flow rather than a draft
  // that silently disappears if the advisor clicks anything else first.
  // New items are always returned last (inserted with the highest id), so
  // the last row after the re-render is the one just added.
  persistEstimate().then(() => {
    const rows = $$(".part-row:not(.head) .ei-desc", box);
    rows[rows.length - 1]?.focus();
    rows[rows.length - 1]?.select();
  });
}

/* ---------- notes / activity ---------- */
function renderNotes(order) {
  const box = $("#vd-note-list");
  box.innerHTML = order.notes.length ? order.notes.map((n) => `
    <div class="mini-item"><div>${esc(n.text)} <span class="pill" style="background:var(--line-soft);color:var(--ink-faint);text-transform:none;font-weight:600">${n.visibility}</span></div><div class="mi-meta">${esc(n.actor)} · ${fmtDate(n.created_at)}</div></div>
  `).join("") : `<div style="color:var(--ink-faint);font-size:12px">No notes yet.</div>`;
}
function renderActivity(order) {
  const box = $("#vd-activity-list");
  box.innerHTML = order.activity.length ? order.activity.slice().reverse().map((a) => `
    <div class="mini-item"><div>${esc(a.action.replace(/_/g, " "))}</div><div class="mi-meta">${esc(a.actor)} · ${fmtDate(a.created_at)}</div></div>
  `).join("") : `<div style="color:var(--ink-faint);font-size:12px">No activity yet.</div>`;
}

/* ---------- assignment ---------- */
function renderAssignment(order) {
  const techs = state.staff.filter((s) => s.role === "technician");
  const advisors = state.staff.filter((s) => s.role === "advisor" || s.role === "manager");
  const a = order.assignment;
  $("#vd-technician").innerHTML = `<option value="">Unassigned</option>` + techs.map((t) => `<option value="${t.id}" ${a && a.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#vd-advisor").innerHTML = `<option value="">Unassigned</option>` + advisors.map((t) => `<option value="${t.id}" ${a && a.advisor_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#vd-odometer").value = (a && a.odometer_in) || "";
  $("#vd-promised").value = (a && a.promised_at) || "";
}

/* ---------- vehicle-detail event wiring (wired once) ---------- */
function wireVehicleDetail() {
  $("#back-to-vehicles").addEventListener("click", () => showView("vehicles"));

  $("#vd-start-ro").addEventListener("click", async () => {
    const concern = $("#vd-new-ro-concern").value.trim();
    if (!concern) return toast("Describe what's being done first", true);
    const { segment, id } = state.detail;
    const payload = { concern, segment, customer_id: null, vehicle_id: null };
    if (segment === "recon") payload.recon_vehicle_id = id;
    else payload.we_owe_id = id;
    try {
      await post("/api/orders", payload);
      $("#vd-new-ro-concern").value = "";
      toast("Repair order started");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-advance-status").addEventListener("click", async () => {
    const status = $("#vd-status-select").value;
    if (!status) return;
    try {
      await patch(`/api/orders/${state.detail.order.id}/status`, { status, actor: currentActor() });
      toast(`Status set to ${STATUS_LABEL[status]}`);
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-add-part").addEventListener("click", () => addEstimateRow("part"));
  $("#vd-add-labor").addEventListener("click", () => addEstimateRow("labor"));

  $("#vd-order-parts").addEventListener("click", async () => {
    try {
      const res = await patch(`/api/orders/${state.detail.order.id}/estimate/order-parts`);
      toast(res.updated ? `${res.updated} part line(s) marked ordered` : "No quoted parts to order");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const addNote = async () => {
    const text = $("#vd-note-text").value.trim();
    if (!text) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/notes`, { text, visibility: $("#vd-note-visibility").value, actor: currentActor() });
      $("#vd-note-text").value = "";
      toast("Note added");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#vd-add-note").addEventListener("click", addNote);
  $("#vd-note-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNote(); }
  });

  $("#vd-save-assignment").addEventListener("click", async (e) => {
    await withLoading(e.target, "Saving…", async () => {
      try {
        await put(`/api/orders/${state.detail.order.id}/assignment`, {
          advisor_id: $("#vd-advisor").value ? Number($("#vd-advisor").value) : null,
          technician_id: $("#vd-technician").value ? Number($("#vd-technician").value) : null,
          odometer_in: Number($("#vd-odometer").value || 0),
          promised_at: $("#vd-promised").value,
          actor: currentActor(),
        });
        toast("Assignment saved");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-we-owe-save").addEventListener("click", async (e) => {
    const { id } = state.detail;
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/we-owe/${id}`, {
          status: $("#vd-we-owe-status").value,
          description: $("#vd-we-owe-description").value.trim(),
          category: $("#vd-we-owe-category").value.trim(),
          target_date: $("#vd-we-owe-target").value,
        });
        toast("We-owe item updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-recon-info-save").addEventListener("click", async (e) => {
    const { id } = state.detail;
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/recon/vehicles/${id}`, {
          vin: $("#vd-recon-vin").value.trim(),
          mileage: Number($("#vd-recon-mileage").value || 0),
          year: Number($("#vd-recon-year").value),
          make: $("#vd-recon-make").value.trim(),
          model: $("#vd-recon-model").value.trim(),
          trim: $("#vd-recon-trim").value.trim(),
          color: $("#vd-recon-color").value.trim(),
          purchase_price: Number($("#vd-recon-purchase-price").value || 0),
        });
        toast("Vehicle info updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-delete").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    const label = segment === "recon" ? item.stock_number : `${item.year} ${item.make} ${item.model}`;
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;
    try {
      await api(segment === "recon" ? `/api/recon/vehicles/${id}` : `/api/we-owe/${id}`, { method: "DELETE" });
      toast("Deleted");
      showView("vehicles");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ==================================================================
   NEW RECON VEHICLE DIALOG
   ================================================================== */
function openReconDialog() {
  $("#recon-form").reset();
  $("#recon-year").value = new Date().getFullYear();
  $("#recon-date").value = new Date().toISOString().slice(0, 10);
  $("#recon-dialog").showModal();
}
function wireReconDialog() {
  $("#recon-cancel").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-cancel-2").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-decode-vin").addEventListener("click", async () => {
    const vin = $("#recon-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      toast("VIN decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#recon-decode-plate").addEventListener("click", async () => {
    const plate = $("#recon-plate").value.trim();
    const state_ = $("#recon-plate-state").value.trim();
    if (!plate || !state_) return toast("Enter plate and state first", true);
    try {
      const data = await post("/api/vehicles/decode-plate", { plate, state: state_ });
      $("#recon-vin").value = data.vin;
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      $("#recon-color").value = data.color;
      toast("Plate decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#recon-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        await post("/api/recon/vehicles", {
          stock_number: $("#recon-stock").value.trim(),
          vin: $("#recon-vin").value.trim(),
          year: Number($("#recon-year").value),
          make: $("#recon-make").value.trim(),
          model: $("#recon-model").value.trim(),
          trim: $("#recon-trim").value.trim(),
          engine: $("#recon-engine").value.trim(),
          color: $("#recon-color").value.trim(),
          mileage: Number($("#recon-mileage").value || 0),
          purchase_price: Number($("#recon-price").value || 0),
          acquisition_source: $("#recon-source").value.trim(),
          acquisition_date: $("#recon-date").value,
          notes: $("#recon-notes").value.trim(),
        });
        $("#recon-dialog").close();
        toast("Recon vehicle added");
        loadVehiclesView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   NEW WE-OWE DIALOG
   ================================================================== */
async function openWeOweDialog() {
  $("#we-owe-form").reset();
  $("#we-owe-new-customer").style.display = "none";
  $("#we-owe-new-vehicle").style.display = "none";
  $("#we-owe-new-year").value = new Date().getFullYear();
  const customers = await get("/api/customers");
  $("#we-owe-customer").innerHTML = `<option value="__new__">＋ New customer…</option>` + customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  await refreshWeOweVehicleOptions();
  $("#we-owe-dialog").showModal();
}
async function refreshWeOweVehicleOptions() {
  const customerId = $("#we-owe-customer").value;
  const select = $("#we-owe-vehicle");
  if (customerId === "__new__" || !customerId) {
    select.innerHTML = `<option value="__new__">＋ New vehicle…</option>`;
  } else {
    const vehicles = await get("/api/vehicles");
    const owned = vehicles.filter((v) => v.customer_id === Number(customerId));
    select.innerHTML = `<option value="__new__">＋ New vehicle…</option>` + owned.map((v) => `<option value="${v.id}">${v.year} ${esc(v.make)} ${esc(v.model)}</option>`).join("");
  }
  // Rebuilding the options resets the select's value to "__new__" (its
  // first option) without firing a change event -- without this, the
  // fields to actually type the new vehicle stay hidden.
  $("#we-owe-new-vehicle").style.display = select.value === "__new__" ? "" : "none";
}
function wireWeOweDialog() {
  $("#we-owe-cancel").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-cancel-2").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-customer").addEventListener("change", async () => {
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
    await refreshWeOweVehicleOptions();
  });
  $("#we-owe-vehicle").addEventListener("change", () => {
    $("#we-owe-new-vehicle").style.display = $("#we-owe-vehicle").value === "__new__" ? "" : "none";
  });
  $("#we-owe-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        let customerId = $("#we-owe-customer").value;
        if (customerId === "__new__") {
          const name = $("#we-owe-new-customer-name").value.trim();
          if (!name) return toast("Enter the customer's name", true);
          const customer = await post("/api/customers", { name, phone: $("#we-owe-new-customer-phone").value.trim(), email: "" });
          customerId = customer.id;
        } else {
          customerId = Number(customerId);
        }
        let vehicleId = $("#we-owe-vehicle").value;
        if (vehicleId === "__new__") {
          const make = $("#we-owe-new-make").value.trim();
          const model = $("#we-owe-new-model").value.trim();
          if (!make || !model) return toast("Enter the vehicle's make and model", true);
          const vehicle = await post("/api/vehicles", {
            customer_id: customerId,
            year: Number($("#we-owe-new-year").value),
            make, model,
            vin: $("#we-owe-new-vin").value.trim(),
          });
          vehicleId = vehicle.id;
        } else {
          vehicleId = Number(vehicleId);
        }
        await post("/api/we-owe", {
          customer_id: customerId,
          vehicle_id: vehicleId,
          description: $("#we-owe-description").value.trim(),
          category: $("#we-owe-category").value.trim() || "other",
          target_date: $("#we-owe-target").value,
          sale_reference: $("#we-owe-sale-ref").value.trim(),
          lot_stock_number: $("#we-owe-lot-stock").value.trim(),
        });
        $("#we-owe-dialog").close();
        toast("We-owe item added");
        loadVehiclesView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   REPORTS
   ================================================================== */
function quickRange(kind, chip) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  let start, end = iso(now);
  if (kind === "today") start = iso(now);
  else if (kind === "week") { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); start = iso(d); }
  else if (kind === "month") start = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (kind === "year") start = iso(new Date(now.getFullYear(), 0, 1));
  else { start = ""; end = ""; }
  $("#report-start").value = start;
  $("#report-end").value = end;
  $$("#view-reports .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
}

async function loadReportsView() {
  try {
    const settings = await get("/api/settings/email");
    $("#email-status").textContent = settings.configured
      ? `Connected as ${settings.gmail_address}`
      : "Not connected yet — add your Gmail app password below.";
    $("#email-gmail-address").value = settings.gmail_address || "";
    $("#email-recipient").value = settings.report_recipient || "";
  } catch (err) {
    $("#email-status").textContent = "Could not check connection.";
  }
  loadSentReports();
}

async function loadSentReports() {
  try {
    const rows = await get("/api/reports/sent");
    $("#sent-reports-table").innerHTML = rows.length ? rows.map((r) => `
      <tr><td>${fmtDate(r.sent_at)}</td><td>${esc(r.report_type)}</td>
      <td><span class="pill ${r.status === "sent" ? "pill-done" : "pill-progress"}">${esc(r.status)}</span></td></tr>
    `).join("") : `<tr><td colspan="3" style="text-align:center;color:var(--ink-faint);padding:16px">Nothing sent yet.</td></tr>`;
  } catch {}
}

function renderReportTable(rows, type) {
  if (type === "technicians") {
    return `<div class="panel"><table><thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Labor Hours</th><th class="num-col">Labor Cost</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.labor_hours}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
  return `<div class="panel"><table><thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technicians</th><th class="num-col">What's In It</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` <span style="color:var(--ink-faint)">(${esc(r.customer_name)})</span>` : ""}</td>
    <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td><span class="pill ${r.status_bucket === "finished" ? "pill-done" : "pill-progress"}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
    <td>${esc(r.technicians.join(", "))}</td><td class="num-col">${money(r.actual_cost)}</td></tr>`).join("")}
    <tr style="font-weight:700"><td colspan="5">Total</td><td class="num-col">${money(totalActual)}</td></tr></tbody></table></div>`;
}

const REPORT_TITLES = {
  "vehicle-spend": "All Vehicles (Combined)",
  "vehicle-spend-recon": "Recon Vehicles Only",
  "vehicle-spend-we_owe": "We-Owe Only",
  technicians: "Technician Productivity",
};

function reportDateRangeLabel(start, end) {
  if (!start && !end) return "All time";
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return `From ${fmt(start)}`;
  return `Through ${fmt(end)}`;
}

// Builds the print-only letterhead + table as its own self-contained markup,
// independent of whatever the on-screen app chrome looks like, so printing
// never depends on hiding every other panel correctly.
function renderPrintReport(rows, type, start, end) {
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const rangeLabel = reportDateRangeLabel(start, end);
  let body;
  if (type === "technicians") {
    const totalHours = rows.reduce((s, r) => s + r.labor_hours, 0);
    const totalCost = rows.reduce((s, r) => s + r.labor_cost, 0);
    body = `
      <table class="print-table">
        <thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Labor Hours</th><th class="num-col">Labor Cost</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.labor_hours}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td class="num-col"></td><td class="num-col"></td><td class="num-col">${totalHours}</td><td class="num-col">${money(totalCost)}</td></tr></tfoot>
      </table>`;
  } else {
    const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
    body = `
      <table class="print-table">
        <thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technician(s)</th><th class="num-col">What's In It</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` (${esc(r.customer_name)})` : ""}</td>
        <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td>
        <td>${esc(r.technicians.join(", ")) || "—"}</td><td class="num-col">${money(r.actual_cost)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="4">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col"></td><td class="num-col">${money(totalActual)}</td></tr></tfoot>
      </table>`;
  }
  return `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">Discount Auto Ops</div>
        <div class="print-shop-sub">Merrillville, IN</div>
      </div>
      <div class="print-meta">
        <div class="print-report-title">${esc(REPORT_TITLES[type] || type)}</div>
        <div>${esc(rangeLabel)}</div>
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    ${body}
  `;
}

async function generateReport() {
  const type = $("#report-type").value;
  const start = $("#report-start").value || undefined;
  const end = $("#report-end").value || undefined;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  try {
    let rows;
    if (type === "technicians") {
      rows = await get(`/api/reports/technicians?${params}`);
    } else {
      if (type === "vehicle-spend-recon") params.set("segment", "recon");
      if (type === "vehicle-spend-we_owe") params.set("segment", "we_owe");
      rows = await get(`/api/reports/vehicle-spend?${params}`);
    }
    $("#report-output").innerHTML = renderReportTable(rows, type === "technicians" ? "technicians" : "vehicle-spend");
    state.report = { rows, type, start, end };
    $("#print-report").innerHTML = renderPrintReport(rows, type, start, end);
  } catch (err) {
    toast(err.message, true);
  }
}

function wireReportsView() {
  $("#report-quick-today").addEventListener("click", (e) => quickRange("today", e.target));
  $("#report-quick-week").addEventListener("click", (e) => quickRange("week", e.target));
  $("#report-quick-month").addEventListener("click", (e) => quickRange("month", e.target));
  $("#report-quick-year").addEventListener("click", (e) => quickRange("year", e.target));
  $("#report-quick-all").addEventListener("click", (e) => quickRange("all", e.target));
  $("#report-generate").addEventListener("click", generateReport);
  $("#report-print").addEventListener("click", async () => {
    if (!state.report) await generateReport();
    if (!state.report) return;
    window.print();
  });

  $("#email-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await put("/api/settings/email", {
        gmail_address: $("#email-gmail-address").value.trim(),
        gmail_app_password: $("#email-gmail-password").value.trim(),
        report_recipient: $("#email-recipient").value.trim(),
      });
      $("#email-gmail-password").value = "";
      toast("Gmail connection saved");
      loadReportsView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const sendReport = async (report_type) => {
    try {
      const res = await post("/api/reports/send", { report_type });
      toast(`Report sent to ${res.recipient}`);
      loadSentReports();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#send-recon-report").addEventListener("click", () => sendReport("recon"));
  $("#send-we-owe-report").addEventListener("click", () => sendReport("we_owe"));
  $("#send-combined-report").addEventListener("click", () => sendReport("combined"));

  $("#check-replies").addEventListener("click", async () => {
    $("#replies-list").innerHTML = `<div style="color:var(--ink-faint);font-size:12px">Checking…</div>`;
    try {
      const replies = await get("/api/reports/replies");
      $("#replies-list").innerHTML = replies.length ? replies.map((r) => `
        <div class="mini-item"><div style="font-weight:600">${esc(r.subject)}</div><div class="mi-meta">${esc(r.from)} · ${esc(r.date)}</div><div style="margin-top:4px">${esc(r.snippet)}</div></div>
      `).join("") : `<div style="color:var(--ink-faint);font-size:12px">No replies found.</div>`;
    } catch (err) {
      $("#replies-list").innerHTML = `<div style="color:var(--crit);font-size:12px">${esc(err.message)}</div>`;
    }
  });
}

/* ==================================================================
   ACCOUNTING (A/P)
   ================================================================== */
async function loadAccountingView() {
  try {
    const [vendors, orders, invoices, audits] = await Promise.all([
      get("/api/vendors"), get("/api/orders"), get("/api/ap/invoices"), get("/api/accounting/audits"),
    ]);
    state.vendors = vendors;
    state.orders = orders;
    renderVendorSelect();
    renderVendorChips();
    renderPoSelect();
    renderApTable(invoices);
    renderAuditList(audits);
    if (!$("#ap-invoice-items").children.length) addApLine();
  } catch (err) {
    toast(`Could not load accounting: ${err.message}`, true);
  }
}
function renderVendorSelect() {
  $("#ap-vendor").innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("") || `<option value="">Add a vendor first</option>`;
}
function renderVendorChips() {
  $("#vendor-list").innerHTML = state.vendors.map((v) => `<span class="vendor-chip">${esc(v.name)}${v.account_number ? ` · ${esc(v.account_number)}` : ""}</span>`).join("") || `<span style="color:var(--ink-faint);font-size:12px;padding:8px 0">No vendors yet.</span>`;
}
function renderPoSelect() {
  const open = state.orders.filter((o) => !["closed", "cancelled"].includes(o.status));
  $("#ap-po").innerHTML = open.map((o) => {
    const label = o.stock_number ? `${o.number} · ${o.stock_number} · ${o.year} ${o.make} ${o.model}` : `${o.number} · ${o.customer_name} · ${o.year} ${o.make} ${o.model}`;
    return `<option value="${esc(o.number)}">${esc(label)}</option>`;
  }).join("") || `<option value="">No open repair orders</option>`;
}
function renderApTable(invoices) {
  $("#ap-table").innerHTML = invoices.length ? invoices.map((a) => `
    <tr><td>${esc(a.invoice_number)}</td><td>${esc(a.vendor_name)}</td><td>${esc(a.po_number)}</td>
    <td>${esc(a.vehicle_label)}</td><td class="num-col">${money(a.total)}</td>
    <td><span class="pill pill-done">${esc(a.status)}</span></td></tr>
  `).join("") : `<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:20px">No vendor invoices posted yet.</td></tr>`;
}
function renderAuditList(audits) {
  $("#audit-list").innerHTML = audits.length ? audits.slice(0, 20).map((a) => `
    <div class="mini-item"><div>${esc(a.invoice_number)} — <span style="text-transform:capitalize">${esc(a.status)}</span></div>
    ${a.issues.length ? `<div class="mi-meta" style="color:var(--warn)">${a.issues.map(esc).join("; ")}</div>` : ""}
    <div class="mi-meta">${fmtDate(a.created_at)}</div></div>
  `).join("") : `<div style="color:var(--ink-faint);font-size:12px">No activity yet.</div>`;
}

// Subtotal is always exactly the sum of the line items, and Total is always
// exactly Subtotal + Tax -- both fields are read-only precisely so this can
// never drift out of sync and trip process_invoice's mismatch check, which
// previously required hand-adding every line in your head.
function recalcApTotals() {
  const subtotal = $$("#ap-invoice-items tr").reduce((sum, tr) => {
    const qty = parseFloat(tr.querySelector(".apl-qty").value || "0");
    const cost = parseFloat(tr.querySelector(".apl-cost").value || "0");
    return sum + qty * cost;
  }, 0);
  const tax = parseFloat($("#ap-tax").value || "0");
  $("#ap-subtotal").value = subtotal.toFixed(2);
  $("#ap-total").value = (subtotal + tax).toFixed(2);
}

function addApLine() {
  const box = $("#ap-invoice-items");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="apl-kind"><option value="part">Part</option><option value="labor">Labor</option><option value="freight">Freight</option><option value="core_charge">Core charge</option><option value="shop_supplies">Shop supplies</option><option value="credit">Credit</option></select></td>
    <td><input class="apl-part" placeholder="Part #"></td>
    <td><input class="apl-desc" placeholder="Description"></td>
    <td><input class="apl-qty" type="number" min="0.01" step="0.01" value="1" style="width:70px"></td>
    <td><input class="apl-cost" type="number" min="0" step="0.01" value="0" style="width:90px"></td>
    <td><button type="button" class="rm-btn">×</button></td>
  `;
  tr.querySelector(".rm-btn").addEventListener("click", () => { tr.remove(); recalcApTotals(); });
  tr.querySelector(".apl-qty").addEventListener("input", recalcApTotals);
  tr.querySelector(".apl-cost").addEventListener("input", recalcApTotals);
  box.appendChild(tr);
  recalcApTotals();
}

function wireAccountingView() {
  $("#ap-add-line").addEventListener("click", addApLine);
  $("#ap-tax").addEventListener("input", recalcApTotals);
  $("#vendor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await post("/api/vendors", {
        name: form.name.value.trim(),
        aliases: form.aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
      });
      form.reset();
      toast("Vendor saved");
      loadAccountingView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#ap-invoice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = $$("#ap-invoice-items tr").map((tr) => ({
      part_number: tr.querySelector(".apl-part").value.trim() || "N/A",
      description: tr.querySelector(".apl-desc").value.trim(),
      quantity: parseFloat(tr.querySelector(".apl-qty").value || "0"),
      unit_cost: parseFloat(tr.querySelector(".apl-cost").value || "0"),
      kind: tr.querySelector(".apl-kind").value,
    })).filter((i) => i.description && i.quantity > 0);
    if (!items.length) return toast("Add at least one line item", true);
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        const res = await post("/api/agent/invoices/process", {
          vendor_name: $("#ap-vendor").value,
          invoice_number: $("#ap-invoice-number").value.trim(),
          po_number: $("#ap-po").value,
          subtotal: parseFloat($("#ap-subtotal").value || "0"),
          tax: parseFloat($("#ap-tax").value || "0"),
          total: parseFloat($("#ap-total").value || "0"),
          items,
          source: "ui",
        });
        if (res.status === "posted") {
          toast("Invoice posted — parts marked received");
          $("#ap-invoice-form").reset();
          $("#ap-invoice-items").innerHTML = "";
          addApLine();
          $("#ap-invoice-note").textContent = "";
        } else {
          $("#ap-invoice-note").textContent = (res.issues || []).join(" · ");
          toast(`Invoice ${res.status.replace("_", " ")}`, true);
        }
        loadAccountingView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ==================================================================
   STAFF
   ================================================================== */
async function loadStaffView() {
  try {
    state.staff = await get("/api/staff?include_inactive=true");
  } catch (err) {
    return toast(`Could not load staff: ${err.message}`, true);
  }
  refreshCurrentUserOptions();
  const roleLabel = { technician: "Technician", advisor: "Advisor / Service Writer", manager: "Manager" };
  $("#staff-table").innerHTML = state.staff.length ? state.staff.map((s) => `
    <tr data-id="${s.id}">
      <td><input class="stf-name" value="${esc(s.name)}" style="border:none;background:none;padding:2px"></td>
      <td><select class="stf-role" style="border:none;background:none;padding:2px">
        <option value="technician" ${s.role === "technician" ? "selected" : ""}>Technician</option>
        <option value="advisor" ${s.role === "advisor" ? "selected" : ""}>Advisor / Service Writer</option>
        <option value="manager" ${s.role === "manager" ? "selected" : ""}>Manager</option>
      </select></td>
      <td><span class="pill ${s.active ? "pill-done" : "pill-progress"}">${s.active ? "Active" : "Inactive"}</span></td>
      <td style="display:flex;gap:6px">
        <button type="button" class="btn btn-ghost btn-sm stf-save">Save</button>
        <button type="button" class="btn btn-ghost btn-sm stf-toggle">${s.active ? "Deactivate" : "Activate"}</button>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="4" style="text-align:center;color:var(--ink-faint);padding:20px">No staff yet.</td></tr>`;

  $$(".stf-save", $("#staff-table")).forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    try {
      await patch(`/api/staff/${tr.dataset.id}`, { name: tr.querySelector(".stf-name").value.trim(), role: tr.querySelector(".stf-role").value });
      toast("Staff updated");
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  }));
  $$(".stf-toggle", $("#staff-table")).forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const person = state.staff.find((s) => s.id === Number(tr.dataset.id));
    try {
      await patch(`/api/staff/${tr.dataset.id}`, { active: !person.active });
      toast(person.active ? "Deactivated" : "Activated");
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  }));
}
function wireStaffView() {
  $("#staff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await post("/api/staff", { name: form.name.value.trim(), role: form.role.value });
      form.reset();
      toast("Staff member added");
      loadStaffView();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ==================================================================
   INTEGRATIONS
   ================================================================== */
async function loadIntegrationsView() {
  try {
    const data = await get("/api/integrations/partstech");
    $("#partstech-login").href = data.login_url;
  } catch (err) {
    toast(`Could not load PartsTech connection info: ${err.message}`, true);
  }
}

/* ==================================================================
   INIT
   ================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initCurrentUser();
  wireVehiclesView();
  wireVehicleDetail();
  wireReconDialog();
  wireWeOweDialog();
  wireReportsView();
  wireAccountingView();
  wireStaffView();

  $$(".rail-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));

  showView("vehicles");
});
