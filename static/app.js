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
  // `value || 0` only catches falsy input (0, "", null, undefined) -- a
  // truthy but non-numeric value (e.g. a corrupted field coming back as a
  // string) sails through Number() as NaN and used to render literally
  // "$NaN" in cost summaries and the printed ticket.
  const raw = Number(value);
  const n = Number.isFinite(raw) ? raw : 0;
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
// Awareness for the two-people-editing-the-same-car case: seeing "updated 2
// minutes ago" is often enough to make someone check with a coworker before
// saving over their still-fresh change.
function relativeTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* ---------- state ---------- */
const state = {
  vehicles: [],
  filter: "",
  search: "",
  sortByAge: null, // null | "asc" | "desc"
  staff: [],
  vendors: [],
  orders: [],
  currentUser: localStorage.getItem("dao-current-user") || "",
  detail: { segment: null, id: null, item: null, order: null },
  apFilter: { start: "", end: "" },
  apSearch: "",
  staffSearch: "",
  suggestionSearch: "",
  showResolvedSuggestions: false,
  apInvoices: [],
  cores: [],
  coresFilter: "pending",
  returns: [],
  returnsFilter: "pending",
  postReturnItem: null,
  vehicleSelection: new Set(), // "segment:id" strings, cleared on filter change/reload
  tasks: [],
  taskFilter: "",
  taskSearch: "",
  newTaskAssignees: [],
  showCompletedTasks: false,
  suggestions: [],
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

const STATUS_OPTIONS = ["estimate", "pending_approval", "in_progress", "complete"];
const STATUS_LABEL = {
  estimate: "Estimate", pending_approval: "Pending Approval", in_progress: "In Progress", complete: "Complete",
  // Vehicle-board labels for statuses that aren't ticket statuses: recon's
  // "acquired" (no RO started yet) and we-owe's own open/fulfilled/waived
  // (shown only once the promise itself has been marked resolved, or before
  // any ticket exists -- otherwise the board shows the ticket's own status).
  acquired: "Acquired", open: "Open", fulfilled: "Fulfilled", waived: "Waived",
};
const STATUS_PILL_CLASS = {
  estimate: "pill-status-estimate", pending_approval: "pill-status-pending",
  in_progress: "pill-status-progress", complete: "pill-status-complete",
};
const KIND_GROUP_ORDER = ["part", "labor", "fee"];
const KIND_GROUP_LABEL = { part: "Parts", labor: "Labor", fee: "Fees" };

/* ---------- nav / shell ---------- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "vehicles") loadVehiclesView();
  if (name === "accounting") loadAccountingView();
  if (name === "cores") loadCoresView();
  if (name === "staff") loadStaffView();
  if (name === "tasks") loadTasksView();
  if (name === "suggestions") loadSuggestionsView();
  if (name === "backup") loadBackupView();
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
    state.vehicles = await get(state.filter === "history" ? "/api/vehicles-board?archived=true" : "/api/vehicles-board");
  } catch (err) {
    toast(`Could not load vehicles: ${err.message}`, true);
    return;
  }
  state.vehicleSelection.clear();
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
  $("#stat-quoted-total").textContent = money(open.reduce((s, v) => s + v.quoted_cost, 0));
}

// Age severity: how long a car has actually been sitting is the natural
// companion to "what we have in it" -- color makes the outliers jump out
// without having to read every row.
function ageClass(days) {
  if (days >= 30) return "age-crit";
  if (days >= 14) return "age-warn";
  return "age-ok";
}

// Recon rows always carry the linked repair order's status (one of the 4
// ticket statuses, color-coded). We-owe rows do too while the promise is
// still open (so progressing the ticket shows up on the board immediately),
// but switch to showing fulfilled/waived once the advisor explicitly
// resolves the promise -- that's not part of the ticket-status vocabulary,
// so it just keeps the simpler finished/in-progress coloring.
function vehicleStatusPillClass(v) {
  return v.segment === "recon" ? (STATUS_PILL_CLASS[v.status] || "pill-progress") : (v.status_bucket === "finished" ? "pill-done" : (STATUS_PILL_CLASS[v.status] || "pill-progress"));
}

function renderVehiclesTable() {
  let rows = state.vehicles;
  if (state.filter && state.filter !== "history") rows = rows.filter((v) => v.segment === state.filter);
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((v) =>
      (v.stock_number || "").toLowerCase().includes(q) ||
      (v.vin || "").toLowerCase().includes(q) ||
      (v.customer_name || "").toLowerCase().includes(q) ||
      v.vehicle.toLowerCase().includes(q)
    );
  }
  if (state.sortByAge) {
    rows = rows.slice().sort((a, b) => state.sortByAge === "desc" ? b.age_days - a.age_days : a.age_days - b.age_days);
  }
  $("#vehicles-count").textContent = `${rows.length} vehicle${rows.length === 1 ? "" : "s"}`;
  const body = $("#vehicles-table");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--ink-faint);padding:30px">No vehicles match.</td></tr>`;
    renderVehicleBulkBar();
    return;
  }
  body.innerHTML = rows.map((v) => {
    const key = vehicleKey(v);
    return `
    <tr class="clickable" data-segment="${v.segment}" data-id="${v.segment === "recon" ? v.recon_id : v.we_owe_id}" data-key="${key}">
      <td><input type="checkbox" class="veh-select" data-key="${key}" ${state.vehicleSelection.has(key) ? "checked" : ""}></td>
      <td class="num">${esc(v.stock_number || "—")}</td>
      <td>
        <div style="font-weight:600">${esc(v.vehicle)}</div>
        <div style="font-size:11.5px;color:var(--ink-faint)">${v.segment === "we_owe" ? esc(v.customer_name || "") : esc(v.vin || "")}</div>
      </td>
      <td><span class="pill ${v.segment === "recon" ? "pill-recon" : "pill-weowe"}">${v.segment === "recon" ? "Recon" : "We-Owe"}</span></td>
      <td><span class="pill ${vehicleStatusPillClass(v)}">${esc(STATUS_LABEL[v.status] || v.status)}</span></td>
      <td>${v.technicians.length ? `<span class="tech"><span class="tech-dot"></span>${esc(v.technicians.join(", "))}</span>` : `<span style="color:var(--ink-faint)">—</span>`}</td>
      <td class="num-col ${ageClass(v.age_days)}">${v.age_days}d</td>
      <td class="num-col">${money(v.actual_cost)}</td>
    </tr>
  `;
  }).join("");
  $$("tr.clickable", body).forEach((tr) => {
    tr.addEventListener("click", () => openVehicleDetail(tr.dataset.segment, Number(tr.dataset.id)));
  });
  $$(".veh-select", body).forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) state.vehicleSelection.add(cb.dataset.key);
      else state.vehicleSelection.delete(cb.dataset.key);
      renderVehicleBulkBar();
    });
  });
  $("#vehicles-select-all").checked = rows.length > 0 && rows.every((v) => state.vehicleSelection.has(vehicleKey(v)));
  renderVehicleBulkBar();
}

function vehicleKey(v) {
  return `${v.segment}:${v.segment === "recon" ? v.recon_id : v.we_owe_id}`;
}

// Bulk archive/reopen reuses the same single-vehicle endpoints the detail
// view already calls, fired concurrently -- there's no cross-vehicle
// transaction to preserve since archiving one has zero effect on another.
function renderVehicleBulkBar() {
  const n = state.vehicleSelection.size;
  $("#vehicles-bulk-bar").style.display = n ? "" : "none";
  if (!n) return;
  $("#vehicles-bulk-count").textContent = `${n} selected`;
  $("#vehicles-bulk-archive").textContent = state.filter === "history" ? "Reopen Selected" : "Send Selected to History";
}

function wireVehiclesView() {
  $$(".filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$(".filters .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const wasHistory = state.filter === "history";
      state.filter = chip.dataset.filter;
      if (wasHistory !== (state.filter === "history")) loadVehiclesView();
      else renderVehiclesTable();
    });
  });
  $("#global-search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    if (!$("#view-vehicles").classList.contains("active")) showView("vehicles");
    renderVehiclesTable();
  });
  $("#add-recon-btn").addEventListener("click", () => openReconDialog());
  $("#add-we-owe-btn").addEventListener("click", () => openWeOweDialog());

  $("#th-age").addEventListener("click", () => {
    state.sortByAge = state.sortByAge === "desc" ? "asc" : "desc";
    $("#th-age .sort-arrow").textContent = state.sortByAge === "desc" ? "▼" : "▲";
    renderVehiclesTable();
  });

  $("#vehicles-select-all").addEventListener("change", (e) => {
    $$(".veh-select", $("#vehicles-table")).forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) state.vehicleSelection.add(cb.dataset.key);
      else state.vehicleSelection.delete(cb.dataset.key);
    });
    renderVehicleBulkBar();
  });

  $("#vehicles-bulk-clear").addEventListener("click", () => {
    state.vehicleSelection.clear();
    renderVehiclesTable();
  });

  $("#vehicles-bulk-archive").addEventListener("click", async () => {
    const reopening = state.filter === "history";
    const targets = [...state.vehicleSelection].map((key) => {
      const [segment, id] = key.split(":");
      return { segment, id };
    });
    if (!confirm(`${reopening ? "Reopen" : "Send to History"} ${targets.length} vehicle${targets.length === 1 ? "" : "s"}?`)) return;
    const results = await Promise.allSettled(targets.map(({ segment, id }) =>
      post(`/api/${segment === "recon" ? "recon/vehicles" : "we-owe"}/${id}/${reopening ? "reopen" : "archive"}`, {})
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(failed ? `${targets.length - failed} succeeded, ${failed} failed` : `${targets.length} vehicle${targets.length === 1 ? "" : "s"} updated`, !!failed);
    await loadVehiclesView();
  });
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
  // A vehicle can have more than one RO over its life (recon prep now, a
  // warranty comeback later); the advisor picking an older one from Order
  // History must survive every other action on this page re-loading the
  // detail (adding a note, saving assignment, etc.) until they navigate to
  // a different vehicle, which is what resets selectedOrderId to null.
  // Excludes a just-voided order, though -- voiding the one currently on
  // screen must fall back to another open/recent order, not keep showing
  // the dead ticket with everything still editable except the void button.
  const preferred = state.detail.selectedOrderId != null ? orders.find((o) => o.id === state.detail.selectedOrderId && !o.voided) : null;
  // Prefer a still-open order, but fall back to the most recent one (orders
  // is sorted newest-first) rather than pretending there's no order at all
  // once it reaches Complete -- otherwise a finished/archived ticket could
  // never be looked back at, which defeats the point of History.
  const active = preferred || orders.find((o) => o.status !== "complete") || orders[0] || null;
  state.detail.selectedOrderId = active ? active.id : null;
  enterVehicleDetailView();
  renderDetailHead();
  renderOrderHistory(orders, active ? active.id : null);
  // Deleting a vehicle with real order history would silently orphan its
  // cost data -- only offer it while there's nothing to lose yet.
  $("#vd-delete").style.display = orders.length === 0 ? "" : "none";
  if (!active) {
    $("#vd-void-order").style.display = "none";
    $("#vd-print-ticket").style.display = "none";
    $("#vd-add-task").style.display = "none";
    $("#vd-no-order").style.display = "";
    $("#vd-order-content").style.display = "none";
    applyArchivedLockUI(!!item.archived_at);
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
  applyArchivedLockUI(!!item.archived_at);
}

// Only shown once a vehicle actually has more than one RO -- the common
// single-ticket case looks exactly as clean as it always did.
function renderOrderHistory(orders, activeId) {
  const card = $("#vd-order-history-card");
  if (orders.length <= 1) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  $("#vd-order-history").innerHTML = orders.map((o) => `
    <div class="mini-item clickable ${o.id === activeId ? "active" : ""}" data-id="${o.id}">
      <div class="mi-title">
        <span>${esc(o.number)}</span>
        <span class="pill ${STATUS_PILL_CLASS[o.status] || ""}" style="font-size:9.5px">${o.voided ? "Voided" : (STATUS_LABEL[o.status] || o.status)}</span>
      </div>
      <div class="mi-concern">${esc(o.concern)}</div>
      <div class="mi-meta">${fmtDate(o.created_at)}</div>
    </div>
  `).join("");
  $$(".mini-item.clickable", $("#vd-order-history")).forEach((row) => {
    row.addEventListener("click", () => selectOrder(Number(row.dataset.id)));
  });
}

async function selectOrder(orderId) {
  if (orderId === state.detail.selectedOrderId) return;
  state.detail.selectedOrderId = orderId;
  await loadVehicleDetail();
}

function renderDetailHead() {
  const { segment, item } = state.detail;
  const updatedEl = $("#vd-updated");
  if (item.updated_at) {
    const minutesAgo = (Date.now() - new Date(item.updated_at).getTime()) / 60000;
    updatedEl.textContent = `Updated ${relativeTime(item.updated_at)}`;
    updatedEl.classList.toggle("recent", minutesAgo < 10);
  } else {
    updatedEl.textContent = "";
  }
  // Vehicle Info (VIN/year/make/model/etc.) is shared by both segments --
  // a car is sometimes entered quickly with the VIN added later, whether
  // it's a recon vehicle or a we-owe promise.
  $("#vd-recon-vin").value = item.vin || "";
  $("#vd-recon-mileage").value = item.mileage || 0;
  $("#vd-recon-year").value = item.year;
  $("#vd-recon-make").value = item.make;
  $("#vd-recon-model").value = item.model;
  $("#vd-recon-trim").value = item.trim || "";
  $("#vd-recon-color").value = item.color || "";
  $("#vd-recon-purchase-price-row").style.display = segment === "recon" ? "" : "none";
  if (segment === "recon") {
    $("#vd-title").textContent = `${item.stock_number} — ${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.vin, item.mileage ? `${item.mileage.toLocaleString()} mi` : "", item.trim].filter(Boolean).join(" · ");
    $("#vd-we-owe-status-card").style.display = "none";
    $("#vd-deposits-card").style.display = "none";
    $("#vd-recon-purchase-price").value = item.purchase_price || 0;
  } else {
    $("#vd-title").textContent = `${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").textContent = [item.customer_name, item.description].filter(Boolean).join(" · ");
    $("#vd-we-owe-status-card").style.display = "";
    $("#vd-we-owe-status").value = item.status;
    $("#vd-we-owe-description").value = item.description || "";
    $("#vd-we-owe-category").value = item.category || "";
    $("#vd-we-owe-target").value = item.target_date || "";
    $("#vd-deposits-card").style.display = "";
    renderDepositsSummary();
  }
  renderCostSummary();
  renderVehicleInfoSummary();
}

// Vehicle-wide (every RO ever opened on this vehicle, not just the active
// one) -- quoted_cost/total_cost already come from the same cost_rollup
// the Vehicles-list stats use, just never surfaced here before.
function renderCostSummary() {
  const { item } = state.detail;
  const box = $("#vd-cost-summary");
  let lines = `<div class="cost-line"><span>Total Quote</span><span class="num">${money(item.quoted_cost)}</span></div>`;
  lines += `<div class="cost-line total"><span>Actual Cost</span><span class="num">${money(item.total_cost)}</span></div>`;
  if (state.detail.segment !== "recon" && item.customer_paid) {
    lines += `<div class="cost-line"><span>Customer paid</span><span class="num">${money(item.customer_paid)}</span></div>`;
    lines += `<div class="cost-line total"><span>Net to shop</span><span class="num">${money(item.net_cost)}</span></div>`;
  }
  box.innerHTML = lines;
}

// Compact read-only summary replacing the old always-open inline edit form --
// the full form still exists verbatim, just relocated into #vehicle-edit-dialog.
function renderVehicleInfoSummary() {
  const { segment, item } = state.detail;
  const rows = [
    ["VIN", esc(item.vin || "—")],
    ["Mileage", item.mileage ? item.mileage.toLocaleString() : "—"],
    ["Year/Make/Model", esc([item.year, item.make, item.model].filter(Boolean).join(" "))],
    ["Trim", esc(item.trim || "—")],
    ["Color", esc(item.color || "—")],
  ];
  if (segment === "recon") rows.push(["Purchase price", money(item.purchase_price || 0)]);
  $("#vd-vehicle-info-summary").innerHTML = rows.map(([label, value]) => `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value">${value}</span></div>`).join("");
}

function renderDepositsSummary() {
  const { item } = state.detail;
  $("#vd-deposits-summary").innerHTML = `
    <div class="cost-line"><span>Customer paid</span><span class="num">${money(item.customer_paid || 0)}</span></div>
    <div class="cost-line total"><span>Net to shop</span><span class="num">${money(item.net_cost ?? item.total_cost)}</span></div>
  `;
}

function renderPaymentDialogList() {
  const { item } = state.detail;
  const payments = item.payments || [];
  $("#vd-deposits-list").innerHTML = payments.length ? payments.map((p) => `
    <div class="mini-item">
      <div>${money(p.amount)} · ${esc(p.method)} ${p.note ? `— ${esc(p.note)}` : ""}
        <button type="button" class="rm-btn deposit-rm" data-id="${p.id}" title="Remove">×</button>
      </div>
      <div class="mi-meta">${esc(p.actor || "Unspecified")} · ${fmtDate(p.created_at)}</div>
    </div>
  `).join("") : `<div style="color:var(--ink-faint);font-size:12px;padding:8px 0">No deposits recorded yet.</div>`;
  $$(".deposit-rm", $("#vd-deposits-list")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this deposit?")) return;
      try {
        await api(`/api/we-owe/${item.id}/payments/${btn.dataset.id}`, { method: "DELETE" });
        toast("Deposit removed");
        await loadVehicleDetail();
        renderPaymentDialogList();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// The backend guard (assert_vehicle_editable) is the real enforcement --
// this just keeps the UI from offering an action that would 409 anyway
// once a vehicle is archived to History.
function applyArchivedLockUI(archived) {
  $("#vd-archived-banner").style.display = archived ? "" : "none";
  $("#vd-archive-vehicle").style.display = archived ? "none" : "";
  $("#vd-reopen-vehicle").style.display = archived ? "" : "none";

  // These are static controls reused across renders (unlike the estimate
  // rows, which are rebuilt fresh every time) -- reopening must explicitly
  // re-enable them, not just skip re-disabling, or they'd stay disabled
  // forever once archived once.
  const disableIds = [
    "vd-status-select", "vd-concern", "vd-concern-save",
    "vd-add-job", "vd-add-part", "vd-add-labor", "vd-order-parts",
    "vd-add-note", "vd-note-text",
    "vd-save-assignment", "vd-technician", "vd-advisor",
    "vd-save-timing", "vd-date-in", "vd-odometer", "vd-promised",
    "vd-edit-vehicle", "vd-recon-info-save", "vd-decode-vin", "vd-recon-vin", "vd-recon-mileage", "vd-recon-year",
    "vd-recon-make", "vd-recon-model", "vd-recon-trim", "vd-recon-color", "vd-recon-purchase-price",
    "vd-edit-customer", "vd-we-owe-save", "vd-we-owe-description", "vd-we-owe-category", "vd-we-owe-target", "vd-we-owe-status",
    "vd-take-payment", "vd-deposit-add", "vd-deposit-amount", "vd-deposit-method", "vd-deposit-note",
  ];
  disableIds.forEach((id) => { const el = $(`#${id}`); if (el) el.disabled = archived; });
  $$(".job-control", $("#vd-estimate-items")).forEach((el) => { el.disabled = archived; });
  if (archived) {
    $("#vd-void-order").style.display = "none";
    $("#vd-receive-parts").disabled = true;
  } else {
    updateReceiveButtonState(); // depends on how many checkboxes are checked, not a flat enable
  }
  $$(".part-row:not(.head) input, .part-row:not(.head) select, .part-row:not(.head) .rm-btn", $("#vd-estimate-items")).forEach((el) => {
    // A returned part's Cost field is deliberately locked at 0 regardless of
    // archive state (see rowHtml) -- this loop must not re-enable it.
    if (el.classList.contains("ei-cost") && el.dataset.realCost !== undefined) return;
    el.disabled = archived;
  });
  $$(".part-row:not(.head)", $("#vd-estimate-items")).forEach((row) => row.setAttribute("draggable", String(!archived)));
}

function renderOrderPanel() {
  const order = state.detail.order;
  $("#vd-ro-number").textContent = `Repair Order ${order.number}`;
  renderStatusCard(order);
  renderEstimate(order);
  renderNotes(order);
  renderActivity(order);
  renderAssignment(order);
  $("#vd-print-ticket").style.display = "";
  $("#vd-add-task").style.display = "";
  $("#vd-void-order").style.display = order.voided ? "none" : "";
}

function renderStatusCard(order) {
  const pill = $("#vd-status-pill");
  pill.className = `pill ${STATUS_PILL_CLASS[order.status] || ""}`;
  pill.textContent = order.voided ? "Voided" : (STATUS_LABEL[order.status] || order.status);
  const select = $("#vd-status-select");
  select.innerHTML = STATUS_OPTIONS.map((s) => `<option value="${s}" ${s === order.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("");
  $("#vd-concern").value = order.concern || "";
}

function renderEstimate(order) {
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  const box = $("#vd-estimate-items");
  box.classList.toggle("has-jobs", jobs.length > 0);
  // A part sent back to the vendor stops costing the shop anything -- every
  // cost total on this ticket (job subtotals, Quoted, Actual) excludes it.
  const notReturned = (i) => !(i.kind === "part" && i.part_returned);

  const jobOptionsHtml = (selectedId) => `<option value="" ${!selectedId ? "selected" : ""}>General</option>` +
    jobs.map((j) => `<option value="${j.id}" ${selectedId === j.id ? "selected" : ""}>${esc(j.title)}</option>`).join("");

  const rowHtml = (item, i) => {
    const remaining = (item.quantity ?? 0) - (item.received_quantity ?? 0);
    const receivable = item.kind === "part" && item.id && remaining > 0.001;
    return `
    <div class="part-row" draggable="true" data-index="${i}" data-id="${item.id || ""}" data-source="${item.source || "manual"}" data-received-quantity="${item.received_quantity ?? 0}">
      <span class="row-drag-handle" title="Drag to reorder">⋮⋮</span>
      ${receivable ? `<input type="checkbox" class="ei-receive-check" data-id="${item.id}">` : `<span></span>`}
      <select class="ei-kind">
        <option value="part" ${item.kind === "part" ? "selected" : ""}>Part</option>
        <option value="labor" ${item.kind === "labor" ? "selected" : ""}>Labor</option>
        <option value="fee" ${item.kind === "fee" ? "selected" : ""}>Fee</option>
      </select>
      <input class="ei-desc" value="${esc(item.description || "")}" placeholder="Description">
      <input class="ei-part" value="${esc(item.part_number || "")}" placeholder="Part #">
      <input class="ei-qty" type="number" min="0.01" step="0.01" value="${item.quantity ?? 1}">
      ${item.part_returned
        ? `<input class="ei-cost" type="number" value="0" disabled title="Returned to the vendor -- no longer counted" data-real-cost="${item.unit_cost ?? 0}">`
        : `<input class="ei-cost" type="number" min="0" step="0.01" value="${item.unit_cost ?? 0}">`}
      ${item.kind === "part"
        ? `<input class="ei-core" type="number" min="0" step="0.01" placeholder="Core" title="Core deposit owed back from the vendor" value="${item.core_charge ?? 0}">`
        : `<span></span>`}
      ${jobs.length ? `<select class="ei-job">${jobOptionsHtml(item.job_id ?? null)}</select>` : ""}
      ${item.id
        ? (item.status === "received"
            ? `<span class="status-cell">
                 <span class="status-pill ${item.part_returned ? "sp-returned" : "sp-received"}" ${item.received_invoice_number ? `title="Received via invoice ${esc(item.received_invoice_number)}"` : ""}>${item.part_returned ? "Returned" : (item.received_invoice_number ? `Received (${esc(item.received_invoice_number)})` : "Received")}</span>
                 ${item.kind === "part" ? `<button type="button" class="btn btn-ghost btn-xs part-return-btn" data-id="${item.id}" data-returned="${item.part_returned ? 1 : 0}" title="${item.part_returned ? "Undo -- this part was not actually sent back" : "Send this part back to the vendor"}">${item.part_returned ? "Undo" : "Mark Returned"}</button>` : ""}
               </span>`
            : `<select class="ei-status status-pill sp-${item.status || "quoted"}">
                 <option value="quoted" ${item.status === "quoted" ? "selected" : ""}>Quoted</option>
                 <option value="ordered" ${item.status === "ordered" ? "selected" : ""}>Ordered</option>
               </select>`)
        : `<span class="status-pill sp-quoted">Saving…</span>`}
      ${item.id ? `<button type="button" class="row-move-btn" title="Move to a different ticket" data-id="${item.id}" data-desc="${esc(item.description || "")}">⇄</button>` : `<span></span>`}
      <button type="button" class="rm-btn" title="Remove line">×</button>
    </div>
  `;
  };

  const headRow = `<div class="part-row head"><span></span><span></span><span>Kind</span><span>Description</span><span>Part #</span><span>Qty</span><span>Cost</span><span>Core</span>${jobs.length ? "<span>Job</span>" : ""}<span>Status</span><span></span><span></span></div>`;

  if (!jobs.length) {
    // Unchanged flat list -- grouping only appears once a job exists, so the
    // common/simple ticket looks exactly as clean as it always has.
    box.innerHTML = headRow + (items.length ? items.map(rowHtml).join("") : `<div class="ei-empty" style="padding:16px;color:var(--ink-faint);font-size:12.5px">No lines yet — add a part or labor entry, or ＋ Add Job to organize this ticket.</div>`);
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    box.innerHTML = headRow + buckets.map((bucket) => {
      const bucketItems = items.filter((i) => (i.job_id ?? null) === bucket.id);
      const isGeneral = bucket.id === null;
      const jobSubtotal = bucketItems.filter(notReturned).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
      // Parts and labor render as their own mini-sections within the job
      // (Tekmetric-style) rather than one interleaved list, so it's obvious
      // at a glance which lines are parts vs labor for this job -- not just
      // which job a line belongs to.
      const kindGroups = KIND_GROUP_ORDER
        .map((kind) => ({ kind, kindItems: bucketItems.filter((i) => i.kind === kind) }))
        .filter((g) => g.kindItems.length);
      return `
        <div class="job-group" data-job-id="${bucket.id ?? ""}">
          <div class="job-group-head">
            <span class="job-group-title">${esc(bucket.title)}</span>
            ${bucketItems.length ? `<span class="job-group-subtotal">${money(jobSubtotal)}</span>` : ""}
            ${isGeneral ? "" : `
              <select class="ei-job-tech job-control" data-job-id="${bucket.id}">
                <option value="">Use ticket default</option>
                ${state.staff.filter((s) => s.role === "technician").map((t) => `<option value="${t.id}" ${bucket.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
              </select>
              <button type="button" class="job-control job-icon-btn job-edit" data-job-id="${bucket.id}" title="Rename job">✎</button>
              <button type="button" class="job-control job-icon-btn job-delete" data-job-id="${bucket.id}" title="Delete job">×</button>
            `}
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="part">＋ Part</button>
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="labor">＋ Labor</button>
          </div>
          ${kindGroups.length ? kindGroups.map((g) => `
            <div class="kind-subgroup" data-kind="${g.kind}">
              <div class="kind-subgroup-label">${KIND_GROUP_LABEL[g.kind]}</div>
              ${g.kindItems.map(rowHtml).join("")}
            </div>
          `).join("") : `<div class="ei-empty" style="padding:10px 16px;color:var(--ink-faint);font-size:12px">No lines in this job yet.</div>`}
        </div>
      `;
    }).join("");
  }

  // Every field auto-saves on change -- there is no "forgot to click Save and
  // it silently vanished" window, because nothing is ever left DOM-only.
  $$(".part-row:not(.head)", box).forEach((row) => {
    row.querySelectorAll(".ei-kind, .ei-desc, .ei-part, .ei-qty, .ei-cost, .ei-core, .ei-job").forEach((field) => {
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
  $$(".row-move-btn", box).forEach((btn) => {
    btn.addEventListener("click", () => openMoveItemDialog(order.id, Number(btn.dataset.id), btn.dataset.desc));
  });
  $$(".ei-status", box).forEach((sel) => {
    const previousValue = sel.value;
    sel.addEventListener("change", async () => {
      const row = sel.closest(".part-row");
      const itemId = row.dataset.id;
      if (!itemId) return;
      try {
        await patch(`/api/orders/${order.id}/estimate/items/${itemId}/status`, { status: sel.value });
        toast("Status updated");
        await loadVehicleDetail();
      } catch (err) {
        sel.value = previousValue;
        toast(err.message, true);
      }
    });
  });
  $$(".part-return-btn", box).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const returned = btn.dataset.returned !== "1";
      const desc = btn.closest(".part-row").querySelector(".ei-desc").value.trim();
      if (returned && !confirm(`Mark "${desc}" as returned to the vendor?`)) return;
      try {
        await patch(`/api/orders/${order.id}/estimate/items/${btn.dataset.id}/part-return`, { returned, actor: currentActor() });
        toast(returned ? "Marked returned" : "Return undone");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".ei-receive-check", box).forEach((cb) => {
    cb.addEventListener("change", updateReceiveButtonState);
  });
  updateReceiveButtonState();
  wireJobControls(order);
  if (jobs.length) {
    // Scoped to each kind-subgroup (not the whole job) -- a part can only
    // reorder among other parts in the same job, since dragging it into the
    // Labor section wouldn't change its kind and would just look wrong.
    $$(".kind-subgroup", box).forEach((groupEl) => wireEstimateRowDragging(groupEl));
  } else {
    wireEstimateRowDragging(box);
  }
  // Quoted = every line at its full quantity, whether or not it's landed yet
  // (matches cost_rollup's quoted_cost); actual = only what's really in the
  // car so far -- parts count once received, labor/fees count the moment
  // they're logged. Same "at cost" basis as everywhere else (unit_cost, not
  // unit_price) -- this panel has never shown customer-facing markup.
  const quotedTotal = items.filter(notReturned).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const actualParts = items.filter((i) => i.kind === "part" && !i.part_returned).reduce((s, i) => s + i.received_quantity * i.unit_cost, 0);
  const actualOther = items.filter((i) => i.kind !== "part").reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  $("#vd-quoted-cost").textContent = money(quotedTotal);
  $("#vd-actual-cost").textContent = money(actualParts + actualOther);
}

function updateReceiveButtonState() {
  const checked = $$(".ei-receive-check:checked", $("#vd-estimate-items"));
  $("#vd-receive-parts").disabled = checked.length === 0;
}

// Native HTML5 drag-and-drop: grabbing the ⋮⋮ handle (or anywhere on the
// row) reorders it among its siblings live as you drag; persistEstimate()
// on drop saves whatever order the DOM ends up in, same as every other
// estimate edit. Called once per kind-subgroup (or once per job-group when
// there are no jobs at all) rather than once globally, so a row can only
// ever be dropped among its own group's siblings -- moving a line to a
// *different* job or kind is the Job/Kind selects' job, not drag-and-drop's.
function wireEstimateRowDragging(box) {
  let dragRow = null;
  $$(".part-row:not(.head)", box).forEach((row) => {
    row.addEventListener("dragstart", () => {
      dragRow = row;
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragRow = null;
      persistEstimate();
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragRow || dragRow === row) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) / rect.height < 0.5;
      row.parentNode.insertBefore(dragRow, before ? row : row.nextSibling);
    });
  });
}

function collectEstimateItems() {
  return $$(".part-row:not(.head)", $("#vd-estimate-items")).map((row) => {
    // A returned part's Cost field is shown as 0 on screen so it reads as
    // "no longer counted" -- but the real received cost lives in
    // data-real-cost and must round-trip through every save (persistEstimate
    // resends every row, this one included) or it'd be lost for good, taking
    // the vendor credit amount with it.
    const costInput = row.querySelector(".ei-cost");
    const cost = costInput.dataset.realCost !== undefined
      ? parseFloat(costInput.dataset.realCost)
      : parseFloat(costInput.value || "0");
    const coreInput = row.querySelector(".ei-core");
    const jobSelect = row.querySelector(".ei-job");
    return {
      id: row.dataset.id ? Number(row.dataset.id) : null,
      kind: row.querySelector(".ei-kind").value,
      description: row.querySelector(".ei-desc").value.trim(),
      part_number: row.querySelector(".ei-part").value.trim(),
      quantity: parseFloat(row.querySelector(".ei-qty").value || "1"),
      unit_cost: cost,
      unit_price: cost,
      core_charge: coreInput ? parseFloat(coreInput.value || "0") : 0,
      source: row.dataset.source || "manual",
      // A freshly-added row (addEstimateRow) has no .ei-job select yet --
      // just the data-job-id it was created with -- so fall back to that.
      job_id: jobSelect ? (jobSelect.value ? Number(jobSelect.value) : null) : (row.dataset.jobId ? Number(row.dataset.jobId) : null),
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
  const expectedVersion = order.estimate ? order.estimate.edit_version : null;
  try {
    const estimate = await post(`/api/orders/${order.id}/estimate`, { labor_rate: 0, tax_rate: 0, actor: currentActor(), items, expected_version: expectedVersion });
    if (token !== estimateSaveToken) return; // a newer edit has already been sent; drop this stale response
    order.estimate = estimate;
    renderEstimate(order);
  } catch (err) {
    if (String(err.message).includes("Someone else changed")) {
      toast(err.message, true);
      await loadVehicleDetail(); // pull the latest version instead of leaving stale data on screen
      return;
    }
    toast(err.message, true);
  }
}

function addEstimateRow(kind, defaults = {}, jobId = null) {
  const box = $("#vd-estimate-items");
  const targetContainer = box.classList.contains("has-jobs")
    ? ($(`.job-group[data-job-id="${jobId ?? ""}"]`, box) || box)
    : box;
  const empty = $(".ei-empty", targetContainer);
  if (empty) empty.remove();
  const row = document.createElement("div");
  const source = defaults.source || "manual";
  row.className = "part-row";
  row.dataset.id = "";
  row.dataset.source = source;
  row.dataset.jobId = jobId ?? "";
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
  targetContainer.appendChild(row);
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

// Wires the per-job controls rendered by renderEstimate: reassigning a job's
// technician, renaming/deleting a job, and the mini add-part/add-labor links
// scoped to that job. Re-wired every render since the job-group markup is
// rebuilt from scratch each time, same as every other estimate-row listener.
function wireJobControls(order) {
  const box = $("#vd-estimate-items");
  const jobs = order.estimate?.jobs ?? [];
  $$(".ei-job-tech", box).forEach((sel) => {
    sel.addEventListener("change", async () => {
      const job = jobs.find((j) => String(j.id) === sel.dataset.jobId);
      if (!job) return;
      try {
        await put(`/api/orders/${order.id}/jobs/${job.id}`, {
          title: job.title,
          technician_id: sel.value ? Number(sel.value) : null,
          actor: currentActor(),
        });
        toast("Job technician updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".job-edit", box).forEach((btn) => {
    btn.addEventListener("click", () => {
      const job = jobs.find((j) => String(j.id) === btn.dataset.jobId);
      if (job) openJobDialog(job);
    });
  });
  $$(".job-delete", box).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const job = jobs.find((j) => String(j.id) === btn.dataset.jobId);
      if (!confirm(`Delete "${job ? job.title : "this job"}"? Its parts/labor move back to General -- nothing is deleted.`)) return;
      try {
        await api(`/api/orders/${order.id}/jobs/${btn.dataset.jobId}`, { method: "DELETE" });
        toast("Job deleted");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".job-mini-add", box).forEach((btn) => {
    btn.addEventListener("click", () => {
      addEstimateRow(btn.dataset.kind, {}, btn.dataset.jobId ? Number(btn.dataset.jobId) : null);
    });
  });
}

function openJobDialog(job = null) {
  state.detail.editingJobId = job ? job.id : null;
  $("#job-dialog-title").textContent = job ? "Rename Job" : "Add Job";
  $("#job-title-input").value = job ? job.title : "";
  const techs = state.staff.filter((s) => s.role === "technician");
  $("#job-technician-input").innerHTML = `<option value="">Use ticket default</option>` +
    techs.map((t) => `<option value="${t.id}" ${job && job.technician_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#job-dialog").showModal();
}

function wireJobDialog() {
  $("#job-cancel").addEventListener("click", () => $("#job-dialog").close());
  $("#job-cancel-2").addEventListener("click", () => $("#job-dialog").close());
  $("#job-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#job-title-input").value.trim();
    if (!title) return;
    const technicianId = $("#job-technician-input").value ? Number($("#job-technician-input").value) : null;
    const editingId = state.detail.editingJobId;
    try {
      const body = { title, technician_id: technicianId, actor: currentActor() };
      if (editingId) {
        await put(`/api/orders/${state.detail.order.id}/jobs/${editingId}`, body);
      } else {
        await post(`/api/orders/${state.detail.order.id}/jobs`, body);
      }
      $("#job-dialog").close();
      toast(editingId ? "Job updated" : "Job added");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- move a mis-logged line to a different ticket ---------- */
async function openMoveItemDialog(orderId, itemId, desc) {
  state.detail.movingItemId = itemId;
  state.detail.movingFromOrderId = orderId;
  state.detail.movingInvoiceId = null;
  $("#move-item-desc").textContent = `Moving "${desc}" off this ticket.`;
  const select = $("#move-item-target");
  select.innerHTML = `<option value="">Loading…</option>`;
  $("#move-item-invoice-box").style.display = "none";
  $("#move-item-no-invoice-note").style.display = "";
  $("#move-item-reassign-invoice").checked = false;
  $("#move-item-dialog").showModal();
  try {
    const [orders, invoice] = await Promise.all([
      get("/api/orders"),
      get(`/api/orders/${orderId}/estimate/items/${itemId}/received-invoice`),
    ]);
    const options = orders.filter((o) => o.id !== orderId && !o.voided).map((o) => {
      const vehicleLabel = o.stock_number ? `${o.stock_number} · ${o.year} ${o.make} ${o.model}` : `${o.year} ${o.make} ${o.model} · ${o.customer_name}`;
      return `<option value="${o.id}">${esc(o.number)} — ${esc(vehicleLabel)}</option>`;
    }).join("");
    select.innerHTML = options || `<option value="">No other repair orders</option>`;

    if (invoice) {
      state.detail.movingInvoiceId = invoice.invoice_id;
      $("#move-item-invoice-label").textContent = `Also reassign vendor invoice ${invoice.invoice_number} (${invoice.vendor_name}, posted ${fmtDate(invoice.posted_at)}) to this ticket`;
      $("#move-item-invoice-box").style.display = "";
      $("#move-item-no-invoice-note").style.display = "none";
      const warning = $("#move-item-invoice-warning");
      if (invoice.other_item_count > 0) {
        warning.textContent = `⚠ This invoice also covers ${invoice.other_item_count} other part${invoice.other_item_count === 1 ? "" : "s"} still on this ticket — checking this moves ALL of them, not just this one.`;
        warning.style.display = "";
      } else {
        warning.style.display = "none";
      }
    }
  } catch (err) {
    select.innerHTML = `<option value="">Could not load repair orders</option>`;
    toast(err.message, true);
  }
}

function wireMoveItemDialog() {
  $("#move-item-cancel").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-cancel-2").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetOrderId = Number($("#move-item-target").value);
    if (!targetOrderId) return;
    const { movingItemId, movingFromOrderId } = state.detail;
    const reassignInvoice = $("#move-item-reassign-invoice").checked;
    try {
      await patch(`/api/orders/${movingFromOrderId}/estimate/items/${movingItemId}/move`, { target_order_id: targetOrderId, reassign_invoice: reassignInvoice, actor: currentActor() });
      $("#move-item-dialog").close();
      toast("Line moved to the other ticket");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
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
  $("#vd-date-in").value = (a && a.date_in) || "";
  $("#vd-odometer").value = (a && a.odometer_in) || "";
  $("#vd-promised").value = (a && a.promised_at) || "";
}

/* ---------- print a single ticket ---------- */
// Reuses the same print-only surface and letterhead/table styling the
// Reports view already prints with -- printing a report and printing a
// ticket are mutually exclusive user actions, so sharing the one
// `#print-report` container is simpler than maintaining a second.
function renderPrintTicket() {
  const { segment, item, order } = state.detail;
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const vehicleLabel = segment === "recon"
    ? `${item.stock_number} — ${item.year} ${item.make} ${item.model}`
    : `${item.year} ${item.make} ${item.model}`;
  const customerLabel = segment === "recon" ? "Recon Inventory" : (item.customer_name || "");
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  const quotedTotal = items.filter((i) => !(i.kind === "part" && i.part_returned)).reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const actualParts = items.filter((i) => i.kind === "part" && !i.part_returned).reduce((s, i) => s + i.received_quantity * i.unit_cost, 0);
  const actualOther = items.filter((i) => i.kind !== "part").reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  const a = order.assignment;
  const techName = (a && a.technician_name) || "Unassigned";
  const advisorName = (a && a.advisor_name) || "Unassigned";

  const itemRow = (i) => `
    <tr><td>${esc(i.kind)}</td><td>${esc(i.description)}</td><td>${esc(i.part_number || "")}</td>
    <td class="num-col">${i.quantity}</td><td class="num-col">${money(i.part_returned ? 0 : i.unit_cost)}</td><td>${esc(i.part_returned ? "Returned" : (STATUS_LABEL[i.status] || i.status || ""))}</td></tr>
  `;

  // Same job/General buckets as the on-screen ticket (renderEstimate) --
  // a printed ticket that's grouped differently than what the advisor was
  // just looking at on screen would be confusing to hand to a technician.
  let rows;
  if (!jobs.length) {
    rows = items.length ? items.map(itemRow).join("") : `<tr><td colspan="6">No parts or labor lines.</td></tr>`;
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    rows = buckets.map((bucket) => {
      const bucketItems = items.filter((i) => (i.job_id ?? null) === bucket.id);
      if (!bucketItems.length) return "";
      const jobTech = bucket.id === null ? "" : (bucket.technician_name || "Use ticket default");
      const jobSubtotal = bucketItems.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
      const kindGroups = KIND_GROUP_ORDER
        .map((kind) => ({ kind, kindItems: bucketItems.filter((i) => i.kind === kind) }))
        .filter((g) => g.kindItems.length);
      return `<tr class="print-job-head"><td colspan="5">${esc(bucket.title)}${jobTech ? ` — ${esc(jobTech)}` : ""}</td><td class="num-col">${money(jobSubtotal)}</td></tr>`
        + kindGroups.map((g) => `<tr class="print-kind-head"><td colspan="6">${KIND_GROUP_LABEL[g.kind]}</td></tr>` + g.kindItems.map(itemRow).join("")).join("");
    }).join("") || `<tr><td colspan="6">No parts or labor lines.</td></tr>`;
  }

  const notesHtml = (order.notes || []).length
    ? order.notes.map((n) => `<div>${esc(n.text)} <span style="color:#666">(${esc(n.visibility)})</span></div>`).join("")
    : "<div>No notes.</div>";

  $("#print-report").innerHTML = `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">RECON</div>
        <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
      </div>
      <div class="print-meta">
        <div class="print-report-title">Repair Order ${esc(order.number)}</div>
        <div>${esc(vehicleLabel)}${customerLabel ? " — " + esc(customerLabel) : ""}</div>
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    <table class="print-table">
      <thead><tr><th>Status</th><th>Technician</th><th>Advisor</th><th>Concern</th></tr></thead>
      <tbody><tr><td>${esc(STATUS_LABEL[order.status] || order.status)}</td><td>${esc(techName)}</td><td>${esc(advisorName)}</td><td>${esc(order.concern)}</td></tr></tbody>
    </table>
    <div class="print-subhead" style="margin:16px 0 6px">Parts &amp; Labor</div>
    <table class="print-table">
      <thead><tr><th>Kind</th><th>Description</th><th>Part #</th><th class="num-col">Qty</th><th class="num-col">Cost</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="subtotal"><td colspan="4">Total Quote</td><td class="num-col">${money(quotedTotal)}</td><td></td></tr>
        <tr><td colspan="4">Actual Cost</td><td class="num-col">${money(actualParts + actualOther)}</td><td></td></tr>
      </tfoot>
    </table>
    <div class="print-subhead" style="margin:16px 0 6px">Notes</div>
    <div class="print-notes">${notesHtml}</div>
  `;
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

  $("#vd-status-select").addEventListener("change", async (e) => {
    const select = e.target;
    const status = select.value;
    select.disabled = true;
    try {
      await patch(`/api/orders/${state.detail.order.id}/status`, { status, actor: currentActor() });
      toast(`Status set to ${STATUS_LABEL[status]}`);
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      select.disabled = false;
    }
  });

  $("#vd-concern-save").addEventListener("click", async (e) => {
    const concern = $("#vd-concern").value.trim();
    if (!concern) return toast("Concern can't be empty", true);
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/orders/${state.detail.order.id}/concern`, { concern, actor: currentActor() });
        toast("Concern updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-print-ticket").addEventListener("click", () => {
    renderPrintTicket();
    window.print();
  });

  // Jumps to Tasks with this order pre-selected in the link dropdown, rather
  // than making the advisor reopen the picker and hunt for the RO they were
  // just looking at.
  $("#vd-add-task").addEventListener("click", async () => {
    const order = state.detail.order;
    showView("tasks");
    await loadTasksView();
    if ($$("#task-order-input option").some((o) => o.value === String(order.id))) {
      $("#task-order-input").value = String(order.id);
    }
    $("#task-title-input").focus();
  });

  $("#vd-archive-vehicle").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    if (!confirm("Send this vehicle to History? It becomes read-only until reopened -- nothing is deleted.")) return;
    try {
      await post(segment === "recon" ? `/api/recon/vehicles/${id}/archive` : `/api/we-owe/${id}/archive`, { expected_version: item.edit_version });
      toast("Sent to History");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
    }
  });

  $("#vd-reopen-vehicle").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    try {
      await post(segment === "recon" ? `/api/recon/vehicles/${id}/reopen` : `/api/we-owe/${id}/reopen`, { expected_version: item.edit_version });
      toast("Reopened -- fully editable again");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
      if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
    }
  });

  $("#vd-void-order").addEventListener("click", async () => {
    if (!confirm("Void this ticket? Its cost will stop counting toward the vehicle's total. This can't be undone.")) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/void`, { actor: currentActor() });
      toast("Ticket voided");
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

  $("#vd-receive-parts").addEventListener("click", () => openReceiveDialog());

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

  const saveAssignment = async (e) => {
    await withLoading(e.target, "Saving…", async () => {
      try {
        await put(`/api/orders/${state.detail.order.id}/assignment`, {
          advisor_id: $("#vd-advisor").value ? Number($("#vd-advisor").value) : null,
          technician_id: $("#vd-technician").value ? Number($("#vd-technician").value) : null,
          date_in: $("#vd-date-in").value,
          odometer_in: Number($("#vd-odometer").value || 0),
          promised_at: $("#vd-promised").value,
          actor: currentActor(),
        });
        toast("Saved");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };
  $("#vd-save-assignment").addEventListener("click", saveAssignment);
  $("#vd-save-timing").addEventListener("click", saveAssignment);

  $("#vd-we-owe-save").addEventListener("click", async (e) => {
    const { id, item } = state.detail;
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/we-owe/${id}`, {
          status: $("#vd-we-owe-status").value,
          description: $("#vd-we-owe-description").value.trim(),
          category: $("#vd-we-owe-category").value.trim(),
          target_date: $("#vd-we-owe-target").value,
          expected_version: item.edit_version,
        });
        toast("We-owe item updated");
        await loadVehicleDetail();
      } catch (err) {
        if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
        toast(err.message, true);
      }
    });
  });

  $("#vd-deposit-add").addEventListener("click", async (e) => {
    const { id } = state.detail;
    const amount = Number($("#vd-deposit-amount").value || 0);
    if (!amount || amount <= 0) return toast("Enter a deposit amount first", true);
    await withLoading(e.target, "Saving…", async () => {
      try {
        await post(`/api/we-owe/${id}/payments`, {
          amount,
          method: $("#vd-deposit-method").value,
          note: $("#vd-deposit-note").value.trim(),
          actor: currentActor(),
        });
        $("#vd-deposit-amount").value = "";
        $("#vd-deposit-note").value = "";
        toast("Deposit recorded");
        await loadVehicleDetail();
        renderPaymentDialogList();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  $("#vd-take-payment").addEventListener("click", () => {
    renderPaymentDialogList();
    $("#payment-dialog").showModal();
  });
  $("#payment-cancel").addEventListener("click", () => $("#payment-dialog").close());
  $("#payment-cancel-2").addEventListener("click", () => $("#payment-dialog").close());

  $("#vd-edit-vehicle").addEventListener("click", () => $("#vehicle-edit-dialog").showModal());
  $("#vehicle-edit-cancel").addEventListener("click", () => $("#vehicle-edit-dialog").close());
  $("#vehicle-edit-cancel-2").addEventListener("click", () => $("#vehicle-edit-dialog").close());

  $("#vd-edit-customer").addEventListener("click", () => {
    const { item } = state.detail;
    $("#customer-edit-name").value = item.customer_name || "";
    $("#customer-edit-phone").value = item.customer_phone || "";
    $("#customer-edit-email").value = item.customer_email || "";
    $("#customer-edit-dialog").showModal();
  });
  $("#customer-edit-cancel").addEventListener("click", () => $("#customer-edit-dialog").close());
  $("#customer-edit-cancel-2").addEventListener("click", () => $("#customer-edit-dialog").close());
  $("#customer-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { item } = state.detail;
    try {
      await patch(`/api/customers/${item.customer_id}`, {
        name: $("#customer-edit-name").value.trim(),
        phone: $("#customer-edit-phone").value.trim(),
        email: $("#customer-edit-email").value.trim(),
      });
      $("#customer-edit-dialog").close();
      toast("Customer updated");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vehicle-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { segment, id, item } = state.detail;
    await withLoading(e.submitter, "Saving…", async () => {
      try {
        const payload = {
          vin: $("#vd-recon-vin").value.trim(),
          mileage: Number($("#vd-recon-mileage").value || 0),
          year: Number($("#vd-recon-year").value),
          make: $("#vd-recon-make").value.trim(),
          model: $("#vd-recon-model").value.trim(),
          trim: $("#vd-recon-trim").value.trim(),
          color: $("#vd-recon-color").value.trim(),
          expected_version: item.edit_version,
        };
        if (segment === "recon") {
          payload.purchase_price = Number($("#vd-recon-purchase-price").value || 0);
          await patch(`/api/recon/vehicles/${id}`, payload);
        } else {
          await patch(`/api/we-owe/${id}`, payload);
        }
        toast("Vehicle info updated");
        $("#vehicle-edit-dialog").close();
        await loadVehicleDetail();
      } catch (err) {
        if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
        toast(err.message, true);
      }
    });
  });

  $("#vd-add-job").addEventListener("click", () => openJobDialog());

  $("#vd-decode-vin").addEventListener("click", async () => {
    const vin = $("#vd-recon-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#vd-recon-year").value = data.year;
      $("#vd-recon-make").value = data.make;
      $("#vd-recon-model").value = data.model;
      $("#vd-recon-trim").value = data.trim;
      toast("VIN decoded — click Save to keep it");
    } catch (err) {
      toast(err.message, true);
    }
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
  $("#we-owe-new-year").value = new Date().getFullYear();
  try {
    const customers = await get("/api/customers");
    $("#we-owe-customer").innerHTML = `<option value="__new__">＋ New customer…</option>` + customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    // The select always defaults to its first option ("__new__") on open --
    // show the matching fields instead of hardcoding them hidden.
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
    await refreshWeOweVehicleOptions();
    $("#we-owe-dialog").showModal();
  } catch (err) {
    // Without this, a failed customer-list fetch left the button looking
    // like it silently did nothing -- no dialog, no toast, no clue why.
    toast(`Could not open the We-Owe dialog: ${err.message}`, true);
  }
}
async function refreshWeOweVehicleOptions() {
  const customerId = $("#we-owe-customer").value;
  const select = $("#we-owe-vehicle");
  try {
    if (customerId === "__new__" || !customerId) {
      select.innerHTML = `<option value="__new__">＋ New vehicle…</option>`;
    } else {
      const vehicles = await get("/api/vehicles");
      const owned = vehicles.filter((v) => v.customer_id === Number(customerId));
      select.innerHTML = `<option value="__new__">＋ New vehicle…</option>` + owned.map((v) => `<option value="${v.id}">${v.year} ${esc(v.make)} ${esc(v.model)}</option>`).join("");
    }
  } catch (err) {
    toast(`Could not load this customer's vehicles: ${err.message}`, true);
    select.innerHTML = `<option value="__new__">＋ New vehicle…</option>`;
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
  $("#we-owe-decode-vin").addEventListener("click", async () => {
    const vin = $("#we-owe-new-vin").value.trim();
    if (vin.length < 5) return toast("Enter a VIN first", true);
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#we-owe-new-year").value = data.year;
      $("#we-owe-new-make").value = data.make;
      $("#we-owe-new-model").value = data.model;
      toast("VIN decoded");
    } catch (err) {
      toast(err.message, true);
    }
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
   RECEIVE PARTS DIALOG
   ================================================================== */
async function openReceiveDialog() {
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

function wireReceiveDialog() {
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

/* ==================================================================
   REPORTS
   ================================================================== */
// Shared quick-range date math -- used by the Reports date filter and the
// A/P invoice list filter alike, so "This Week"/"This Month"/etc. mean the
// same thing everywhere in the app.
function computeQuickRange(kind) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  let start, end = iso(now);
  if (kind === "today") start = iso(now);
  else if (kind === "yesterday") { const d = new Date(now); d.setDate(d.getDate() - 1); start = iso(d); end = iso(d); }
  else if (kind === "week") { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); start = iso(d); }
  else if (kind === "month") start = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (kind === "year" || kind === "ytd") start = iso(new Date(now.getFullYear(), 0, 1));
  else { start = ""; end = ""; }
  return { start, end };
}

function quickRange(kind, chip) {
  const { start, end } = computeQuickRange(kind);
  $("#report-start").value = start;
  $("#report-end").value = end;
  $$("#view-reports .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
}

function renderReportTable(rows, type) {
  if (!rows.length) {
    return `<div class="panel" style="padding:24px;text-align:center;color:var(--ink-faint);font-size:12.5px">No ${type === "technicians" ? "technicians" : "vehicles"} match this range.</div>`;
  }
  if (type === "technicians") {
    return `<div class="panel"><table><thead><tr><th>Technician</th><th class="num-col">ROs</th><th class="num-col">Completed</th><th class="num-col">Labor Hours</th><th class="num-col">Labor Cost</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.technician)}</td><td class="num-col">${r.ro_count}</td><td class="num-col">${r.completed_count}</td><td class="num-col">${r.labor_hours}</td><td class="num-col">${money(r.labor_cost)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  const totalActual = rows.reduce((s, r) => s + r.actual_cost, 0);
  const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
  const hasDeposits = totalPaid > 0;
  return `<div class="panel"><table><thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technicians</th><th class="num-col">Cost</th>${hasDeposits ? `<th class="num-col">Customer Paid</th><th class="num-col">Net to Shop</th>` : ""}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` <span style="color:var(--ink-faint)">(${esc(r.customer_name)})</span>` : ""}</td>
    <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td><span class="pill ${vehicleStatusPillClass(r)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
    <td>${esc(r.technicians.join(", "))}</td><td class="num-col">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`).join("")}
    <tr style="font-weight:700"><td colspan="5">Total</td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr></tbody></table></div>`;
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
    const totalPaid = rows.reduce((s, r) => s + (r.customer_paid || 0), 0);
    const hasDeposits = totalPaid > 0;
    body = `
      <table class="print-table">
        <thead><tr><th>Stock #</th><th>Vehicle</th><th>Type</th><th>Status</th><th>Technician(s)</th><th class="num-col">Cost</th>${hasDeposits ? `<th class="num-col">Customer Paid</th><th class="num-col">Net to Shop</th>` : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${esc(r.stock_number || "—")}</td><td>${esc(r.vehicle)}${r.customer_name ? ` (${esc(r.customer_name)})` : ""}</td>
        <td>${r.segment === "recon" ? "Recon" : "We-Owe"}</td><td>${esc(STATUS_LABEL[r.status] || r.status)}</td>
        <td>${esc(r.technicians.join(", ")) || "—"}</td><td class="num-col">${money(r.actual_cost)}</td>${hasDeposits ? `<td class="num-col">${r.customer_paid ? money(r.customer_paid) : "—"}</td><td class="num-col">${r.customer_paid ? money(r.net_cost) : "—"}</td>` : ""}</tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="4">Total (${rows.length} vehicle${rows.length === 1 ? "" : "s"})</td><td class="num-col"></td><td class="num-col">${money(totalActual)}</td>${hasDeposits ? `<td class="num-col">${money(totalPaid)}</td><td class="num-col">${money(totalActual - totalPaid)}</td>` : ""}</tr></tfoot>
      </table>`;
  }
  return `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">RECON</div>
        <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
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

}

/* ==================================================================
   ACCOUNTING (A/P)
   ================================================================== */
async function loadAccountingView() {
  try {
    const [vendors, orders, audits] = await Promise.all([
      get("/api/vendors"), get("/api/orders"), get("/api/accounting/audits"),
    ]);
    state.vendors = vendors;
    state.orders = orders;
    renderVendorSelect();
    renderVendorChips();
    renderPoSelect();
    renderAuditList(audits);
    if (!$("#ap-invoice-items").children.length) addApLine();
  } catch (err) {
    toast(`Could not load accounting: ${err.message}`, true);
  }
  await loadApTable();
}

async function loadApTable() {
  const { start, end } = state.apFilter;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  try {
    state.apInvoices = await get(`/api/ap/invoices?${params}`);
    renderApTable(filterApInvoices(state.apInvoices));
  } catch (err) {
    toast(`Could not load A/P invoices: ${err.message}`, true);
  }
}

function filterApInvoices(invoices) {
  const query = (state.apSearch || "").toLowerCase();
  if (!query) return invoices;
  return invoices.filter((a) =>
    a.invoice_number.toLowerCase().includes(query) ||
    a.vendor_name.toLowerCase().includes(query) ||
    (a.po_number || "").toLowerCase().includes(query) ||
    a.vehicle_label.toLowerCase().includes(query)
  );
}
function renderVendorSelect() {
  $("#ap-vendor").innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join("") || `<option value="">Add a vendor first</option>`;
}
function renderVendorChips() {
  $("#vendor-list").innerHTML = state.vendors.map((v) => `<span class="vendor-chip clickable" data-id="${v.id}" title="Click to edit">${esc(v.name)}${v.account_number ? ` · ${esc(v.account_number)}` : ""}</span>`).join("") || `<span style="color:var(--ink-faint);font-size:12px;padding:8px 0">No vendors yet.</span>`;
  $$(".vendor-chip.clickable", $("#vendor-list")).forEach((chip) => {
    chip.addEventListener("click", () => openVendorForEdit(Number(chip.dataset.id)));
  });
}

let editingVendorId = null;
function openVendorForEdit(vendorId) {
  const vendor = state.vendors.find((v) => v.id === vendorId);
  if (!vendor) return;
  editingVendorId = vendorId;
  const form = $("#vendor-form");
  form.name.value = vendor.name;
  form.aliases.value = vendor.aliases.join(", ");
  form.account_number.value = vendor.account_number || "";
  $("#vendor-form-title").textContent = `Editing ${vendor.name}`;
  $("#vendor-form-submit").textContent = "Update Vendor";
  $("#vendor-form-cancel").style.display = "";
  form.name.focus();
}
function cancelVendorEdit() {
  editingVendorId = null;
  $("#vendor-form").reset();
  $("#vendor-form-title").textContent = "Vendors";
  $("#vendor-form-submit").textContent = "Save Vendor";
  $("#vendor-form-cancel").style.display = "none";
}
function renderPoSelect() {
  const open = state.orders.filter((o) => o.status !== "complete");
  // The PO# you actually give a vendor is the stock number, not the
  // internal RO-2607-0012 format -- submit that as the value so a vendor
  // invoice referencing "R-1042" matches straight back to this order.
  $("#ap-po").innerHTML = open.map((o) => {
    const poValue = o.stock_number || o.number;
    const label = o.stock_number ? `${o.stock_number} · ${o.number} · ${o.year} ${o.make} ${o.model}` : `${o.number} · ${o.customer_name} · ${o.year} ${o.make} ${o.model}`;
    return `<option value="${esc(poValue)}">${esc(label)}</option>`;
  }).join("") || `<option value="">No open repair orders</option>`;
}
function renderApTable(invoices) {
  $("#ap-count").textContent = `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`;
  // Only recon/we-owe rows can jump anywhere -- retail ROs have no
  // vehicle-detail view, so they render as a plain (non-clickable) row.
  $("#ap-table").innerHTML = invoices.length ? invoices.map((a) => {
    const refId = a.recon_vehicle_id ?? a.we_owe_id;
    const clickable = refId != null && (a.segment === "recon" || a.segment === "we_owe");
    const voided = a.status === "voided";
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-segment="${a.segment}" data-ref-id="${refId}" title="Open this vehicle"` : ""}>
      <td>${esc(a.invoice_number)}</td><td>${esc(a.vendor_name)}</td><td>${esc(a.po_number)}</td>
      <td>${esc(a.vehicle_label)}</td><td class="num-col">${money(a.total)}</td>
      <td><span class="pill ${voided ? "pill-progress" : "pill-done"}">${esc(a.status)}</span></td>
      <td>${voided ? "" : `<button type="button" class="btn btn-ghost btn-sm ap-void" data-id="${a.id}" data-number="${esc(a.invoice_number)}">Void</button>`}</td>
    </tr>
  `;
  }).join("") : `<tr><td colspan="7" style="text-align:center;color:var(--ink-faint);padding:20px">No vendor invoices posted for this range.</td></tr>`;
  $$(".clickable", $("#ap-table")).forEach((row) => {
    row.addEventListener("click", () => openVehicleDetail(row.dataset.segment, Number(row.dataset.refId)));
  });
  $$(".ap-void", $("#ap-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // don't also trigger the row's open-vehicle click
      if (!confirm(`Void invoice ${btn.dataset.number}? It's kept for the audit trail but won't block re-posting a corrected invoice under the same number. This does not un-mark any parts as received -- fix that on the ticket itself if needed.`)) return;
      try {
        await patch(`/api/ap/invoices/${btn.dataset.id}/void`, { actor: currentActor() });
        toast("Invoice voided");
        await loadApTable();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
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

  $$('#view-accounting [data-ap-range]').forEach((chip) => {
    chip.addEventListener("click", () => {
      const range = computeQuickRange(chip.dataset.apRange);
      state.apFilter = range;
      $("#ap-filter-start").value = range.start;
      $("#ap-filter-end").value = range.end;
      $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      loadApTable();
    });
  });
  const clearApChips = () => $$('#view-accounting [data-ap-range]').forEach((c) => c.classList.remove("active"));
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
  $("#vendor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value.trim(),
      aliases: form.aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
      account_number: form.account_number.value.trim(),
    };
    try {
      if (editingVendorId) {
        await patch(`/api/vendors/${editingVendorId}`, payload);
        toast("Vendor updated");
      } else {
        await post("/api/vendors", payload);
        toast("Vendor saved");
      }
      cancelVendorEdit();
      loadAccountingView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#vendor-form-cancel").addEventListener("click", cancelVendorEdit);

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
   CORES & RETURNS
   ================================================================== */
async function loadCoresView() {
  try {
    state.cores = await get("/api/cores");
  } catch (err) {
    toast(`Could not load cores: ${err.message}`, true);
    return;
  }
  renderCoresTable();
  try {
    state.returns = await get("/api/returns");
  } catch (err) {
    toast(`Could not load returned parts: ${err.message}`, true);
    return;
  }
  renderReturnsTable();
}

function renderCoresTable() {
  const filter = state.coresFilter;
  const rows = state.cores.filter((c) => {
    if (filter === "pending") return !c.core_returned;
    if (filter === "returned") return !!c.core_returned;
    return true;
  });
  $("#cores-count").textContent = `${rows.length} core${rows.length === 1 ? "" : "s"}`;
  const pendingTotal = state.cores.filter((c) => !c.core_returned).reduce((s, c) => s + c.core_charge, 0);
  $("#cores-total").textContent = pendingTotal > 0 ? `${money(pendingTotal)} pending` : "";

  $("#cores-table").innerHTML = rows.length ? rows.map((c) => {
    const clickable = c.stock_number || c.we_owe_customer_name;
    const voided = !!c.voided;
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-order-id="${c.order_id}" title="Open this vehicle"` : ""}>
      <td>${esc(c.description)}</td><td>${esc(c.part_number || "")}</td>
      <td>${esc(c.ro_number)} · ${esc(c.vehicle_label)}</td>
      <td class="num-col">${money(c.core_charge)}</td>
      <td><span class="pill ${c.core_returned ? "pill-done" : "pill-progress"}">${c.core_returned ? "Returned" : "Pending"}</span></td>
      <td><button type="button" class="btn btn-ghost btn-sm cores-toggle" data-order-id="${c.order_id}" data-item-id="${c.id}" data-returned="${c.core_returned ? 1 : 0}">${c.core_returned ? "Undo" : "Mark Returned"}</button></td>
    </tr>
  `;
  }).join("") : `<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:20px">No cores in this view.</td></tr>`;

  $$(".clickable", $("#cores-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".cores-toggle")) return;
      const order = state.orders.find((o) => o.id === Number(row.dataset.orderId));
      const refId = order ? (order.recon_vehicle_id ?? order.we_owe_id) : null;
      const segment = order ? order.segment : null;
      if (refId != null && (segment === "recon" || segment === "we_owe")) openVehicleDetail(segment, refId);
    });
  });
  $$(".cores-toggle", $("#cores-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const returned = btn.dataset.returned !== "1";
      try {
        await patch(`/api/orders/${btn.dataset.orderId}/estimate/items/${btn.dataset.itemId}/core-return`, { returned, actor: currentActor() });
        toast(returned ? "Core marked returned" : "Core return undone");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function wireCoresView() {
  $$('#view-cores [data-cores-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.coresFilter = chip.dataset.coresFilter;
      $$('#view-cores [data-cores-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderCoresTable();
    });
  });
}

function renderReturnsTable() {
  const filter = state.returnsFilter;
  const rows = state.returns.filter((r) => {
    if (filter === "pending") return !r.return_invoice_number;
    if (filter === "credited") return !!r.return_invoice_number;
    return true;
  });
  $("#returns-count").textContent = `${rows.length} return${rows.length === 1 ? "" : "s"}`;
  const pendingTotal = state.returns.filter((r) => !r.return_invoice_number).reduce((s, r) => s + Math.abs(r.credit_total), 0);
  $("#returns-total").textContent = pendingTotal > 0 ? `${money(pendingTotal)} pending` : "";

  $("#returns-table").innerHTML = rows.length ? rows.map((r) => {
    const clickable = r.stock_number || r.we_owe_customer_name;
    const voided = !!r.voided;
    const credited = !!r.return_invoice_number;
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" ${clickable ? `data-order-id="${r.order_id}" title="Open this vehicle"` : ""}>
      <td>${esc(r.description)}</td><td>${esc(r.part_number || "")}</td>
      <td>${esc(r.ro_number)} · ${esc(r.vehicle_label)}</td>
      <td>${esc(r.vendor_name || "—")}</td>
      <td class="num-col">${money(Math.abs(r.credit_total))}</td>
      <td><span class="pill ${credited ? "pill-done" : "pill-progress"}">${credited ? `Credited (${esc(r.return_invoice_number)})` : "Pending Credit"}</span></td>
      <td>${credited ? "" : `<button type="button" class="btn btn-ghost btn-sm returns-post" data-id="${r.id}">Post Credit</button>`}</td>
    </tr>
  `;
  }).join("") : `<tr><td colspan="7" style="text-align:center;color:var(--ink-faint);padding:20px">No returned parts in this view.</td></tr>`;

  $$(".clickable", $("#returns-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".returns-post")) return;
      const order = state.orders.find((o) => o.id === Number(row.dataset.orderId));
      const refId = order ? (order.recon_vehicle_id ?? order.we_owe_id) : null;
      const segment = order ? order.segment : null;
      if (refId != null && (segment === "recon" || segment === "we_owe")) openVehicleDetail(segment, refId);
    });
  });
  $$(".returns-post", $("#returns-table")).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = state.returns.find((r) => r.id === Number(btn.dataset.id));
      if (item) openPostReturnDialog(item);
    });
  });
}

function wireReturnsView() {
  $$('#view-cores [data-returns-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.returnsFilter = chip.dataset.returnsFilter;
      $$('#view-cores [data-returns-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderReturnsTable();
    });
  });
}

async function openPostReturnDialog(item) {
  state.postReturnItem = item;
  $("#post-return-desc").textContent = `${item.description}${item.part_number ? ` (${item.part_number})` : ""} — ${item.ro_number} · ${item.vehicle_label}`;
  const vendors = await get("/api/vendors").catch(() => []);
  state.vendors = vendors;
  $("#post-return-vendor").innerHTML = vendors.map((v) => `<option value="${v.id}" ${v.id === item.vendor_id ? "selected" : ""}>${esc(v.name)}</option>`).join("");
  $("#post-return-credit-number").value = "";
  $("#post-return-total-summary").innerHTML = `
    <div class="cost-line total"><span>Credit Due</span><span class="num">${money(Math.abs(item.credit_total))}</span></div>
  `;
  $("#post-return-dialog").showModal();
}

function wirePostReturnDialog() {
  $("#post-return-cancel").addEventListener("click", () => $("#post-return-dialog").close());
  $("#post-return-cancel-2").addEventListener("click", () => $("#post-return-dialog").close());
  $("#post-return-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await withLoading(e.submitter, "Posting…", async () => {
      const item = state.postReturnItem;
      if (!item) return;
      const vendorId = Number($("#post-return-vendor").value);
      const creditNumber = $("#post-return-credit-number").value.trim();
      if (!vendorId) return toast("Select the vendor", true);
      if (!creditNumber) return toast("Enter the credit/RMA number", true);
      try {
        await post(`/api/orders/${item.order_id}/estimate/items/${item.id}/post-return-credit`, {
          vendor_id: vendorId,
          credit_number: creditNumber,
          actor: currentActor(),
        });
        $("#post-return-dialog").close();
        toast("Credit posted to A/P");
        await loadCoresView();
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
  renderStaffTable();
}

function renderStaffTable() {
  const query = (state.staffSearch || "").toLowerCase();
  const rows = query ? state.staff.filter((s) => s.name.toLowerCase().includes(query)) : state.staff;
  $("#staff-count").textContent = `${rows.length} staff member${rows.length === 1 ? "" : "s"}`;
  $("#staff-table").innerHTML = rows.length ? rows.map((s) => `
    <tr data-id="${s.id}">
      <td><input class="stf-name" value="${esc(s.name)}" style="border:none;background:none;padding:2px"></td>
      <td><select class="stf-role" style="border:none;background:none;padding:2px">
        <option value="technician" ${s.role === "technician" ? "selected" : ""}>Technician</option>
        <option value="advisor" ${s.role === "advisor" ? "selected" : ""}>Advisor / Service Writer</option>
        <option value="manager" ${s.role === "manager" ? "selected" : ""}>Manager</option>
      </select></td>
      <td><span class="pill ${s.active ? "pill-done" : "pill-progress"}">${s.active ? "Active" : "Inactive"}</span></td>
      <td><button type="button" class="btn btn-ghost btn-sm stf-toggle">${s.active ? "Deactivate" : "Activate"}</button></td>
    </tr>
  `).join("") : `<tr><td colspan="4" style="text-align:center;color:var(--ink-faint);padding:20px">No staff match.</td></tr>`;

  // Name/role auto-save like everywhere else in the app -- editing then
  // navigating away (or clicking Deactivate) used to silently discard an
  // unsaved edit since this table required an explicit Save click.
  $$(".stf-name", $("#staff-table")).forEach((input) => {
    input.addEventListener("blur", async () => {
      const tr = input.closest("tr");
      const person = state.staff.find((s) => s.id === Number(tr.dataset.id));
      const name = input.value.trim();
      if (!name || name === person.name) return;
      try {
        await patch(`/api/staff/${tr.dataset.id}`, { name });
        toast("Staff updated");
        await loadStaffView();
      } catch (err) {
        toast(err.message, true);
        input.value = person.name;
      }
    });
  });
  $$(".stf-role", $("#staff-table")).forEach((select) => {
    select.addEventListener("change", async () => {
      const tr = select.closest("tr");
      try {
        await patch(`/api/staff/${tr.dataset.id}`, { role: select.value });
        toast("Staff updated");
        await loadStaffView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".stf-toggle", $("#staff-table")).forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const person = state.staff.find((s) => s.id === Number(tr.dataset.id));
    // Deactivating pulls this person out of every technician/advisor
    // dropdown app-wide -- a bigger consequence than most confirm()-guarded
    // deletes elsewhere, so it gets the same guard.
    if (person.active && !confirm(`Deactivate ${person.name}? They'll no longer be selectable as a technician/advisor anywhere.`)) return;
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
  $("#staff-search").addEventListener("input", (e) => {
    state.staffSearch = e.target.value.trim();
    renderStaffTable();
  });
}

/* ==================================================================
   MULTI-SELECT PICKER (checkbox popover) -- used for task assignees
   ================================================================== */
function assigneeSummaryLabel(names) {
  if (!names || !names.length) return "Unassigned";
  // " & " rather than ", " for the two-name case -- a staff name containing
  // its own comma (e.g. "Smith, John") paired with one other assignee would
  // otherwise render indistinguishably from three or four separate people.
  if (names.length <= 2) return names.join(" & ");
  return `${names[0]} +${names.length - 1}`;
}

// (Re)populates a picker's checkbox menu and rewires their change handlers --
// called both once for the quick-add form and once per task row on every
// render, since the row markup (and thus its menu) is rebuilt from scratch.
function renderAssigneeMenu(menuEl, toggleEl, selectedNames, onChange) {
  menuEl.innerHTML = state.staff.length
    ? state.staff.map((s) => `<label class="ms-option"><input type="checkbox" value="${esc(s.name)}" ${selectedNames.includes(s.name) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")
    : `<div class="ms-empty">No staff yet</div>`;
  toggleEl.textContent = assigneeSummaryLabel(selectedNames);
  $$("input[type=checkbox]", menuEl).forEach((cb) => {
    cb.addEventListener("change", () => {
      const names = $$("input[type=checkbox]:checked", menuEl).map((c) => c.value);
      toggleEl.textContent = assigneeSummaryLabel(names);
      onChange(names);
    });
  });
}

// Only one picker menu open at a time; clicking anywhere outside the open
// picker closes it, same as the pattern browsers use for native <select>.
let openAssigneeMenuEl = null;
function toggleAssigneeMenu(menuEl) {
  // A row can be deleted (e.g. a task removed) while its popover is open,
  // detaching the old menu node from the document -- drop the dangling
  // reference instead of touching a node nothing can see anymore.
  if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) openAssigneeMenuEl = null;
  if (openAssigneeMenuEl && openAssigneeMenuEl !== menuEl) openAssigneeMenuEl.style.display = "none";
  const opening = menuEl.style.display !== "block";
  menuEl.style.display = opening ? "block" : "none";
  openAssigneeMenuEl = opening ? menuEl : null;
}
document.addEventListener("click", (e) => {
  if (openAssigneeMenuEl && !document.contains(openAssigneeMenuEl)) {
    openAssigneeMenuEl = null;
    return;
  }
  if (openAssigneeMenuEl && !e.target.closest(".ms-picker")) {
    openAssigneeMenuEl.style.display = "none";
    openAssigneeMenuEl = null;
  }
});
// Wired once per toggle button (the quick-add one lives for the app's whole
// life; each row's is rewired on every render since the row itself is new).
function wireAssigneeToggle(toggleEl, menuEl) {
  toggleEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAssigneeMenu(menuEl);
  });
}

/* ==================================================================
   TASKS
   ================================================================== */
// Due-date coloring mirrors the Vehicles board's age-severity pattern --
// outliers (overdue, due today/tomorrow) jump out without reading every row.
function taskDueInfo(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDate}T00:00:00`);
  const diffDays = Math.round((due - today) / 86400000);
  const cls = diffDays < 0 ? "overdue" : diffDays <= 1 ? "soon" : "";
  return { cls, label: due.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}

function taskRowHtml(t) {
  const due = taskDueInfo(t.due_date);
  const refId = t.order_recon_vehicle_id ?? t.order_we_owe_id;
  const linkable = t.order_id && refId != null && (t.order_segment === "recon" || t.order_segment === "we_owe");
  return `
    <div class="task-row ${t.urgent ? "urgent" : ""} ${t.done ? "done" : ""}" data-id="${t.id}">
      <button type="button" class="task-check" title="${t.done ? "Mark not done" : "Mark done"}">
        <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
      </button>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          <div class="ms-picker" data-id="${t.id}">
            <button type="button" class="ms-toggle task-assignee-toggle">${esc(assigneeSummaryLabel(t.assigned_to))}</button>
            <div class="ms-menu task-assignee-menu"></div>
          </div>
          ${due ? `<span class="task-due ${due.cls}">Due ${due.label}</span>` : ""}
          ${t.urgent ? `<span class="task-urgent-badge">Urgent</span>` : ""}
          ${linkable ? `<button type="button" class="task-order-link" data-segment="${t.order_segment}" data-ref-id="${refId}">🚗 ${esc(t.order_label || t.order_number)}</button>` : ""}
          <span>by ${esc(t.created_by || "Unspecified")} · ${relativeTime(t.created_at)}</span>
        </div>
        ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
      </div>
      <button type="button" class="task-delete" title="Delete">×</button>
    </div>
  `;
}

function wireTaskRowActions(container) {
  $$(".task-check", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      try {
        await patch(`/api/tasks/${row.dataset.id}`, { done: !row.classList.contains("done") });
        await loadTasksView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".task-delete", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".task-row");
      if (!confirm("Delete this task?")) return;
      try {
        await api(`/api/tasks/${row.dataset.id}`, { method: "DELETE" });
        await loadTasksView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".task-order-link", container).forEach((btn) => {
    btn.addEventListener("click", () => openVehicleDetail(btn.dataset.segment, Number(btn.dataset.refId)));
  });
  // Each row's assignee picker saves immediately on change (like every other
  // auto-save control in this app) and updates local state directly rather
  // than reloading the whole list -- reloading would tear down and rebuild
  // the row, closing the popover mid-pick.
  $$(".ms-picker[data-id]", container).forEach((picker) => {
    const taskId = Number(picker.dataset.id);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const toggleEl = $(".task-assignee-toggle", picker);
    const menuEl = $(".task-assignee-menu", picker);
    wireAssigneeToggle(toggleEl, menuEl);
    renderAssigneeMenu(menuEl, toggleEl, task.assigned_to, async (names) => {
      task.assigned_to = names;
      try {
        await patch(`/api/tasks/${taskId}`, { assigned_to: names });
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function renderTasksList() {
  const actor = currentActor();
  const query = (state.taskSearch || "").toLowerCase();
  let open = state.tasks.filter((t) => !t.done);
  if (state.taskFilter === "mine") open = open.filter((t) => t.assigned_to.includes(actor));
  const matches = (t) => t.title.toLowerCase().includes(query) || t.notes.toLowerCase().includes(query) || t.assigned_to.some((a) => a.toLowerCase().includes(query));
  if (query) open = open.filter(matches);
  let done = state.tasks.filter((t) => t.done);
  if (query) done = done.filter(matches);

  $("#tasks-count").textContent = `${open.length} open`;
  $("#tasks-list").innerHTML = open.length
    ? open.map(taskRowHtml).join("")
    : `<div style="color:var(--ink-faint);font-size:12.5px;padding:26px;text-align:center">Nothing here — add a task above.</div>`;

  $("#tasks-toggle-completed").textContent = `${state.showCompletedTasks ? "Hide" : "Show"} completed (${done.length})`;
  $("#tasks-completed-list").style.display = state.showCompletedTasks ? "" : "none";
  $("#tasks-completed-list").innerHTML = done.map(taskRowHtml).join("");

  wireTaskRowActions($("#tasks-list"));
  wireTaskRowActions($("#tasks-completed-list"));
}

// Only recon/we-owe orders are offered -- retail ROs have no vehicle-detail
// view to jump to, so linking a task to one would be a dead-end chip.
function renderTaskOrderSelect(orders) {
  const linkable = orders.filter((o) => o.segment === "recon" || o.segment === "we_owe");
  $("#task-order-input").innerHTML = `<option value="">No vehicle</option>` + linkable.map((o) => {
    const label = o.stock_number ? `${o.stock_number} — ${o.year} ${o.make} ${o.model}` : `${o.customer_name} — ${o.year} ${o.make} ${o.model}`;
    return `<option value="${o.id}">${esc(label)}</option>`;
  }).join("");
}

async function loadTasksView() {
  try {
    if (!state.staff.length) state.staff = await get("/api/staff");
    renderAssigneeMenu($("#task-assignee-menu"), $("#task-assignee-toggle"), state.newTaskAssignees, (names) => {
      state.newTaskAssignees = names;
    });
    const [tasks, orders] = await Promise.all([get("/api/tasks"), get("/api/orders")]);
    state.tasks = tasks;
    renderTaskOrderSelect(orders);
    renderTasksList();
  } catch (err) {
    toast(`Could not load tasks: ${err.message}`, true);
  }
}

function wireTasksView() {
  wireAssigneeToggle($("#task-assignee-toggle"), $("#task-assignee-menu"));

  $("#task-quick-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#task-title-input").value.trim();
    if (!title) return;
    try {
      await post("/api/tasks", {
        title,
        assigned_to: state.newTaskAssignees,
        due_date: $("#task-due-input").value,
        urgent: $("#task-urgent-input").checked,
        order_id: $("#task-order-input").value ? Number($("#task-order-input").value) : null,
        actor: currentActor(),
      });
      $("#task-quick-add").reset();
      state.newTaskAssignees = [];
      toast("Task added");
      await loadTasksView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $$('#view-tasks [data-task-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      $$('#view-tasks [data-task-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.taskFilter = chip.dataset.taskFilter;
      renderTasksList();
    });
  });

  $("#task-search").addEventListener("input", (e) => {
    state.taskSearch = e.target.value.trim();
    renderTasksList();
  });

  $("#tasks-toggle-completed").addEventListener("click", () => {
    state.showCompletedTasks = !state.showCompletedTasks;
    renderTasksList();
  });
}

/* ==================================================================
   SUGGESTIONS / IDEAS
   ================================================================== */
function suggestionCardHtml(s) {
  return `
    <div class="suggestion-card ${s.resolved ? "resolved" : ""}" data-id="${s.id}">
      <div class="suggestion-text">${esc(s.text)}</div>
      <div class="suggestion-meta">
        <span>${esc(s.author || "Unspecified")} · ${fmtDate(s.created_at)}</span>
        <button type="button" class="btn btn-ghost btn-sm suggestion-toggle">${s.resolved ? "Reopen" : "Mark Done"}</button>
        <button type="button" class="rm-btn suggestion-delete" title="Delete">×</button>
      </div>
    </div>
  `;
}

function wireSuggestionCardActions(container) {
  $$(".suggestion-toggle", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      try {
        await patch(`/api/suggestions/${card.dataset.id}`, { resolved: !card.classList.contains("resolved") });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".suggestion-delete", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      if (!confirm("Delete this suggestion?")) return;
      try {
        await api(`/api/suggestions/${card.dataset.id}`, { method: "DELETE" });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// Open/resolved are separated (matching Tasks' open/completed split) instead
// of interleaved by array order, with the resolved list collapsed by default.
function renderSuggestionsList() {
  const query = (state.suggestionSearch || "").toLowerCase();
  const matches = (s) => s.text.toLowerCase().includes(query) || (s.author || "").toLowerCase().includes(query);
  let open = state.suggestions.filter((s) => !s.resolved);
  let resolved = state.suggestions.filter((s) => s.resolved);
  if (query) {
    open = open.filter(matches);
    resolved = resolved.filter(matches);
  }

  $("#suggestions-count").textContent = `${open.length} open`;
  $("#suggestions-list").innerHTML = open.length
    ? open.map(suggestionCardHtml).join("")
    : `<div style="color:var(--ink-faint);font-size:12.5px;padding:26px;text-align:center">No suggestions yet — be the first to add one.</div>`;

  $("#suggestions-toggle-resolved").textContent = `${state.showResolvedSuggestions ? "Hide" : "Show"} resolved (${resolved.length})`;
  $("#suggestions-resolved-list").style.display = state.showResolvedSuggestions ? "" : "none";
  $("#suggestions-resolved-list").innerHTML = resolved.map(suggestionCardHtml).join("");

  wireSuggestionCardActions($("#suggestions-list"));
  wireSuggestionCardActions($("#suggestions-resolved-list"));
}

async function loadSuggestionsView() {
  try {
    state.suggestions = await get("/api/suggestions");
    renderSuggestionsList();
  } catch (err) {
    toast(`Could not load suggestions: ${err.message}`, true);
  }
}

function wireSuggestionsView() {
  $("#suggestion-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#suggestion-text-input").value.trim();
    if (!text) return;
    try {
      await post("/api/suggestions", { text, author: currentActor() });
      $("#suggestion-add").reset();
      toast("Suggestion posted");
      await loadSuggestionsView();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#suggestion-search").addEventListener("input", (e) => {
    state.suggestionSearch = e.target.value.trim();
    renderSuggestionsList();
  });
  $("#suggestions-toggle-resolved").addEventListener("click", () => {
    state.showResolvedSuggestions = !state.showResolvedSuggestions;
    renderSuggestionsList();
  });
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
  wireReceiveDialog();
  wireJobDialog();
  wireMoveItemDialog();
  wireReportsView();
  wireAccountingView();
  wireCoresView();
  wireReturnsView();
  wirePostReturnDialog();
  wireStaffView();
  wireTasksView();
  wireSuggestionsView();
  wireBackupView();

  $$(".rail-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));

  showView("vehicles");
});


/* ==================================================================
   REDESIGN ADDITIONS -- details drawer, status picker, concern preview,
   backup/restore modal. Purely additive: wraps/observes the existing
   render functions above rather than changing them, so none of the real
   data flow above this line needs to change.
   ================================================================== */
const _origRenderStatusCard = renderStatusCard;
renderStatusCard = function (order) {
  _origRenderStatusCard(order);
  const pillEl = $("#vd-status-pill");
  const picker = $("#vd-status-picker");
  const assignPicker = $("#vd-assign-picker");
  const dot = $(".status-picker-dot", picker || document);
  if (pillEl && picker) {
    const text = pillEl.textContent.trim();
    picker.style.display = text ? "" : "none";
    if (assignPicker) assignPicker.style.display = text ? "" : "none";
    if (dot) dot.style.background = getComputedStyle(pillEl).backgroundColor;
  }
  const concernBox = $("#vd-concern");
  const previewWrap = $("#vd-concern-preview");
  const previewText = $("#vd-concern-preview-text");
  if (concernBox && previewWrap && previewText) {
    const val = concernBox.value.trim();
    previewWrap.style.display = val ? "" : "none";
    previewText.textContent = val;
  }
};

document.addEventListener("DOMContentLoaded", () => {
  // Details drawer: collapsible, remembers open/closed like the theme does.
  // A single handle sits on the drawer's edge at all times -- its chevron
  // flips direction to show which way it'll swing, instead of a close-only
  // "x" that disappears once collapsed.
  const drawer = $("#vd-details-drawer");
  const handle = $("#vd-details-handle");
  function setDrawerOpen(open) {
    if (!drawer || !handle) return;
    drawer.classList.toggle("closed", !open);
    handle.classList.toggle("closed", !open);
    localStorage.setItem("dao-details-open", open ? "1" : "0");
  }
  if (drawer && handle) {
    const saved = localStorage.getItem("dao-details-open");
    setDrawerOpen(saved === null ? true : saved === "1");
    handle.addEventListener("click", () => setDrawerOpen(drawer.classList.contains("closed")));
  }

  // Assign picker popover (technician/advisor) -- reveals the real
  // select+save controls without keeping them inline in their own card.
  const assignToggle = $("#vd-assign-picker-toggle");
  const assignMenu = $("#vd-assign-picker-menu");
  if (assignToggle && assignMenu) {
    assignToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      assignMenu.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".status-picker")) assignMenu.classList.remove("open");
    });
  }

});

function fmtBackupSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function loadBackupView() {
  const tbody = $("#backup-table");
  if (!tbody) return;
  let backups;
  try {
    backups = await get("/api/backup");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--crit);padding:20px">Couldn't load backups: ${esc(err.message)}</td></tr>`;
    return;
  }
  tbody.innerHTML = backups.length ? backups.map((b) => `
    <tr>
      <td>${esc(b.name)}</td>
      <td>${fmtBackupSize(b.size_bytes)}</td>
      <td>${fmtDate(b.modified_at * 1000)}</td>
      <td style="display:flex;gap:8px;justify-content:flex-end">
        <a class="btn btn-ghost btn-sm" href="/api/backup/download/${encodeURIComponent(b.name)}" download>Download</a>
        <button type="button" class="btn btn-ghost btn-sm backup-restore-btn" data-name="${esc(b.name)}">Restore</button>
        <button type="button" class="btn btn-ghost btn-sm backup-delete-btn" data-name="${esc(b.name)}" style="color:var(--crit)">Delete</button>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="4" style="text-align:center;color:var(--ink-faint);padding:20px">No backups yet -- click "Create Backup Now".</td></tr>`;
  $$(".backup-restore-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!confirm(`Restore from "${name}"? The current database is saved aside first, but this replaces it.`)) return;
      try {
        await post(`/api/backup/restore/${encodeURIComponent(name)}`);
        toast(`Restored from ${name}`);
        location.reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".backup-delete-btn", tbody).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!confirm(`Delete backup "${name}"? This can't be undone.`)) return;
      try {
        await api(`/api/backup/${encodeURIComponent(name)}`, { method: "DELETE" });
        toast("Backup deleted");
        loadBackupView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function wireBackupView() {
  $("#backup-run-btn")?.addEventListener("click", async () => {
    try {
      const created = await post("/api/backup/run");
      toast(`Backup created: ${created.name}`);
      loadBackupView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#backup-restore-submit")?.addEventListener("click", async () => {
    const file = $("#backup-restore-file").files[0];
    if (!file) return toast("Choose a file first", true);
    if (!file.name.toLowerCase().endsWith(".db")) return toast("Choose a .db backup file", true);
    if (!confirm(`Restore from "${file.name}"? The current database is saved aside first, but this replaces it.`)) return;
    try {
      const res = await fetch("/api/backup/restore-upload", {
        method: "POST",
        headers: { "x-backup-filename": file.name },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || res.statusText);
      }
      toast(`Restored from ${file.name}`);
      location.reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
}
