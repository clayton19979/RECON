import { $, $$, get, patch, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { currentActor, esc, fmtDate, money, promptInvoiceNumber, withLoading } from "./shortcuts.js";
import { emptyRow } from "./empty-states.js";
import { ON_ORDER_COLUMNS } from "./skeletons.js";
import { state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { ageClass } from "./vehicles-board.js";
import { openVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   CORES & RETURNS
   ================================================================== */
export async function loadCoresView() {
  // Fetched independently: one dead endpoint should degrade one panel, not
  // freeze the other two thirds of the screen on skeleton rows forever.
  const [onOrderRes, coresRes, returnsRes] = await Promise.allSettled([
    get("/api/parts/on-order"), get("/api/cores"), get("/api/returns"),
  ]);
  if (onOrderRes.status === "fulfilled") {
    state.partsOnOrder = onOrderRes.value;
    renderPartsOnOrderTable();
  } else {
    renderViewFailure("cores", onOrderRes.reason, [["#on-order-table", ON_ORDER_COLUMNS]]);
  }
  if (coresRes.status === "fulfilled") {
    state.cores = coresRes.value;
    state.coresSelected = new Set();
    renderCoresTable();
  } else {
    renderViewFailure("cores", coresRes.reason, [["#cores-table", 8]]);
  }
  if (returnsRes.status === "fulfilled") {
    state.returns = returnsRes.value;
    state.returnsSelected = new Set();
    renderReturnsTable();
  } else if (coresRes.status === "fulfilled") {
    renderViewFailure("cores", returnsRes.reason, [["#returns-table", 8]]);
  }
  renderCoresReturnsStats();
}

// How many days since a timestamp, floored -- used only for the "still
// awaiting credit" age hint, so a null/blank timestamp (not yet picked up)
// just doesn't render one.
function daysSince(value) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
}

// A part waiting this long or longer is the one worth a phone call. Same
// number the board draws its Stalled line at, and deliberately so: a car
// untouched for a week and a part uncollected for a week are the same
// complaint, and two thresholds would have the two screens disagreeing about
// which jobs are late.
const OVERDUE_AFTER_DAYS = 7;

function isOverdueOnOrder(p) {
  return p.days_waiting != null && p.days_waiting >= OVERDUE_AFTER_DAYS;
}

// One summary row above all three tables: what the shop is waiting on from
// its vendors, and what its vendors owe back. The credit figures span cores
// and returns together, since a call to chase a credit doesn't care which
// table the line started in.
function renderCoresReturnsStats() {
  const cores = state.cores.filter((c) => !c.voided);
  const returns = state.returns.filter((r) => !r.voided);
  const outstanding =
    cores.filter((c) => coreStatus(c) !== "credited").reduce((s, c) => s + c.core_total, 0) +
    returns.filter((r) => returnStatus(r) !== "credited").reduce((s, r) => s + Math.abs(r.credit_total), 0);
  const awaitingCores = cores.filter((c) => coreStatus(c) === "awaiting");
  const awaitingReturns = returns.filter((r) => returnStatus(r) === "awaiting");
  const awaitingAges = [
    ...awaitingCores.map((c) => daysSince(c.core_returned_at)),
    ...awaitingReturns.map((r) => daysSince(r.part_picked_up_at)),
  ].filter((d) => d != null);
  const oldestAwaiting = awaitingAges.length ? Math.max(...awaitingAges) : 0;
  const awaitingTone = oldestAwaiting >= 30 ? "crit" : oldestAwaiting >= 14 ? "warn" : "";
  const creditedCount =
    cores.filter((c) => coreStatus(c) === "credited").length +
    returns.filter((r) => returnStatus(r) === "credited").length;
  const vendorsOwed = new Set([
    ...cores.filter((c) => coreStatus(c) !== "credited").map((c) => c.vendor_name),
    ...returns.filter((r) => returnStatus(r) !== "credited").map((r) => r.vendor_name),
  ].filter(Boolean)).size;

  // Waits are only counted where one is known -- a line ordered before the app
  // started recording the date has no age, and averaging it in as zero would
  // quietly make the oldest wait look younger than it is.
  const onOrder = state.partsOnOrder;
  const knownWaits = onOrder.map((p) => p.days_waiting).filter((d) => d != null);
  const oldestWait = knownWaits.length ? Math.max(...knownWaits) : 0;
  const undated = onOrder.length - knownWaits.length;
  const onOrderValue = onOrder.reduce((s, p) => s + (p.value || 0), 0);
  const onOrderTone = oldestWait >= 14 ? "crit" : oldestWait >= OVERDUE_AFTER_DAYS ? "warn" : "";
  // Spelled out separately rather than folded into the oldest wait: an
  // undated line is not a line that was ordered today, and rolling the two
  // together is how "oldest 0d" ends up printed over a part from last month.
  const onOrderSub = [
    money(onOrderValue),
    knownWaits.length ? (oldestWait ? `oldest ${oldestWait}d` : "all ordered today") : "",
    undated ? `${undated} with no date` : "",
  ].filter(Boolean).join(" · ");

  $("#cores-returns-stats").innerHTML = `
    <div class="stat">
      <div class="stat-label">On Order</div>
      <div class="stat-value${onOrderTone ? ` ${onOrderTone}` : ""}">${onOrder.length}</div>
      <div class="stat-sub">${onOrder.length ? onOrderSub : "nothing on order"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Outstanding</div>
      <div class="stat-value num">${money(outstanding)}</div>
      <div class="stat-sub">across cores and returns</div>
    </div>
    <div class="stat">
      <div class="stat-label">Awaiting Credit</div>
      <div class="stat-value${awaitingTone ? ` ${awaitingTone}` : ""}">${awaitingAges.length}</div>
      <div class="stat-sub">${awaitingAges.length ? `oldest ${oldestAwaiting}d since pickup` : "nothing sent back yet"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Credited</div>
      <div class="stat-value">${creditedCount}</div>
      <div class="stat-sub">paperwork recorded</div>
    </div>
    <div class="stat">
      <div class="stat-label">Vendors Owed</div>
      <div class="stat-value">${vendorsOwed}</div>
      <div class="stat-sub">${vendorsOwed ? "still chasing credit" : "nothing outstanding"}</div>
    </div>`;
}

// Rows carry their own segment/vehicle ids from the API -- resolving through
// state.orders (only loaded by the Accounting view) made every row click a
// silent no-op unless you'd visited A/P first.
function openVehicleFromRow(row) {
  const refId = row.segment === "retail" ? row.vehicle_id : (row.recon_vehicle_id ?? row.we_owe_id);
  if (refId != null && (row.segment === "recon" || row.segment === "we_owe" || row.segment === "retail")) {
    openVehicleDetail(row.segment, refId);
  }
}

/* ---------- On Order ----------
   The one table on this page that isn't about money coming back: it's the
   list of parts a car is sitting and waiting for. */

function onOrderMatchesSearch(p, query) {
  if (!query) return true;
  return [p.description, p.part_number, p.ro_number, p.vehicle_label, p.vehicle]
    .some((f) => (f || "").toLowerCase().includes(query));
}

// Date only. The Ordered column answers "which day did we call this in", and
// a timestamp to the minute is noise beside a Waiting column in whole days.
function orderedOnHtml(value) {
  if (!value) return '<span class="muted-dash" title="This part was marked ordered before RECON started recording the date">not recorded</span>';
  return esc(fmtDate(value).replace(/,\s+\d{1,2}:\d{2}\s*(AM|PM)$/i, ""));
}

// Whole days, coloured on the same age scale the board uses for its own day
// counts. An unknown wait gets no number and no colour rather than a zero,
// which would read as "ordered today".
function waitingHtml(p) {
  if (p.days_waiting == null) return '<span class="muted-dash">—</span>';
  const label = p.days_waiting === 0 ? "today" : `${p.days_waiting}d`;
  return `<span class="${ageClass(p.days_waiting)}">${label}</span>`;
}

function visibleOnOrderRows() {
  const query = (state.onOrderSearch || "").toLowerCase();
  return state.partsOnOrder.filter((p) => {
    if (!onOrderMatchesSearch(p, query)) return false;
    return state.onOrderFilter === "overdue" ? isOverdueOnOrder(p) : true;
  });
}

function renderPartsOnOrderTable() {
  const rows = visibleOnOrderRows();
  const query = (state.onOrderSearch || "").toLowerCase();
  $("#on-order-count").textContent = `${rows.length} part${rows.length === 1 ? "" : "s"}`;
  const total = rows.reduce((s, p) => s + (p.value || 0), 0);
  const cars = new Set(rows.map((p) => p.vehicle_label)).size;
  $("#on-order-total").textContent = rows.length
    ? `${money(total)} across ${cars} vehicle${cars === 1 ? "" : "s"}`
    : "";

  $("#on-order-table").innerHTML = rows.length ? rows.map((p) => `
    <tr class="clickable" data-id="${p.id}" title="Open ${esc(p.vehicle_label)}">
      <td>${esc(p.description)}<div class="veh-sub">${esc(p.vehicle)}</div></td>
      <td>${p.part_number ? esc(p.part_number) : '<span class="muted-dash">—</span>'}</td>
      <td>${esc(p.ro_number)} · ${esc(p.vehicle_label)}</td>
      <td class="num-col">${esc(String(p.outstanding_quantity))}</td>
      <td class="num-col">${money(p.value)}</td>
      <td>${orderedOnHtml(p.ordered_at)}</td>
      <td>${waitingHtml(p)}</td>
    </tr>
  `).join("") : emptyRow(ON_ORDER_COLUMNS, query ? {
    icon: "search",
    title: "No parts on order match that search",
    hint: `Nothing matched "${state.onOrderSearch}".`,
  } : state.onOrderFilter === "overdue" ? {
    icon: "check",
    title: "Nothing has been waiting a week",
    hint: `Every part on order was called in less than ${OVERDUE_AFTER_DAYS} days ago.`,
  } : {
    icon: "check",
    title: "Nothing on order",
    hint: "Parts you mark ordered on a ticket wait here until they're received, so you can see at a glance what every car is waiting for.",
  });

  $$(".clickable", $("#on-order-table")).forEach((row) => {
    row.addEventListener("click", () => {
      const item = state.partsOnOrder.find((p) => p.id === Number(row.dataset.id));
      if (item) openVehicleFromRow(item);
    });
  });
}

export function wirePartsOnOrderView() {
  $$("#view-cores [data-on-order-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.onOrderFilter = chip.dataset.onOrderFilter;
      $$("#view-cores [data-on-order-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderPartsOnOrderTable();
    });
  });
  $("#on-order-search").addEventListener("input", (e) => {
    state.onOrderSearch = e.target.value.trim();
    renderPartsOnOrderTable();
  });
}

function coresMatchesSearch(c, query) {
  if (!query) return true;
  return [c.description, c.part_number, c.ro_number, c.vehicle_label, c.vendor_name]
    .some((f) => (f || "").toLowerCase().includes(query));
}

// One vocabulary for both tables on this page: Pending (still at the shop,
// cores only), Awaiting Credit (sent back to the vendor, paperwork not here
// yet), Credited (the vendor's credit/invoice number is recorded).
function coreStatus(c) {
  if (!c.core_returned) return "pending";
  return c.core_return_invoice_number ? "credited" : "awaiting";
}

// A row's "N days awaiting credit" hint, colored with the same age scale the
// board already uses for its own day counts -- consistent severity language
// across the app rather than a bespoke threshold just for this page.
function awaitingAgeHtml(days) {
  if (days == null) return "";
  return `<div class="veh-sub ${ageClass(days)}">Awaiting ${days}d</div>`;
}

function renderCoresTable() {
  const filter = state.coresFilter;
  const query = (state.coresSearch || "").toLowerCase();
  const rows = state.cores.filter((c) => {
    if (!coresMatchesSearch(c, query)) return false;
    if (filter === "all") return true;
    return coreStatus(c) === filter;
  });
  $("#cores-count").textContent = `${rows.length} core${rows.length === 1 ? "" : "s"}`;
  // Voided tickets aren't money owed back -- keep them out of the headline
  // figure. A deposit stays outstanding until the credit is recorded, not
  // merely until the core leaves the shop.
  const outstanding = state.cores.filter((c) => coreStatus(c) !== "credited" && !c.voided).reduce((s, c) => s + c.core_total, 0);
  $("#cores-total").textContent = state.cores.length
    ? (outstanding > 0 ? `${money(outstanding)} outstanding` : "all deposits recovered")
    : "";

  const CORE_PILL = { pending: "pill-progress", awaiting: "pill-credit-pending", credited: "pill-done" };
  const CORE_LABEL = { pending: "Pending", awaiting: "Awaiting Credit", credited: "Credited" };

  // Selection only ever applies to Pending rows -- Awaiting -> Credited needs
  // a distinct invoice number per item, so that transition stays one-at-a-time.
  const selectableIds = new Set(rows.filter((c) => !c.voided && coreStatus(c) === "pending").map((c) => c.id));
  state.coresSelected = new Set([...state.coresSelected].filter((id) => selectableIds.has(id)));

  $("#cores-table").innerHTML = rows.length ? rows.map((c) => {
    const clickable = c.stock_number || c.we_owe_customer_name;
    const voided = !!c.voided;
    const status = coreStatus(c);
    const selectable = !voided && status === "pending";
    const checked = state.coresSelected.has(c.id);
    const actions = voided ? "" : status === "pending"
      ? `<button type="button" class="btn btn-ghost btn-xs cores-toggle" data-order-id="${c.order_id}" data-item-id="${c.id}" data-returned="0">Mark Picked Up</button>`
      : status === "awaiting"
      ? `<button type="button" class="btn btn-primary btn-xs cores-credit" data-order-id="${c.order_id}" data-item-id="${c.id}">Credit Received</button>
         <button type="button" class="btn btn-ghost btn-xs cores-toggle" data-order-id="${c.order_id}" data-item-id="${c.id}" data-returned="1">Undo</button>`
      : "";
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" data-id="${c.id}" ${clickable ? `title="Open ${esc(c.vehicle_label)}"` : `title="Not linked to a vehicle record"`}>
      <td class="sel-col">${selectable ? `<input type="checkbox" class="cores-select" data-id="${c.id}" ${checked ? "checked" : ""} aria-label="Select ${esc(c.description)}">` : ""}</td>
      <td>${esc(c.description)}${status === "credited" ? `<div class="veh-sub num">Inv ${esc(c.core_return_invoice_number)}</div>` : status === "awaiting" ? awaitingAgeHtml(daysSince(c.core_returned_at)) : ""}</td>
      <td>${c.part_number ? esc(c.part_number) : '<span class="muted-dash">—</span>'}</td>
      <td>${esc(c.ro_number)} · ${esc(c.vehicle_label)}</td>
      <td>${esc(c.vendor_name || "—")}</td>
      <td class="num-col">${money(c.core_total)}${c.quantity > 1 ? `<div class="veh-sub num">${c.quantity} × ${money(c.core_charge)}</div>` : ""}</td>
      <td><span class="pill ${CORE_PILL[status]}">${CORE_LABEL[status]}</span></td>
      <td class="actions-col"><div class="row-actions">${actions}</div></td>
    </tr>
  `;
  }).join("") : emptyRow(8, query ? {
    icon: "search",
    title: "No cores match that search",
    hint: `Nothing matched "${state.coresSearch}".`,
    actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="cores-clear-search">Clear search</button>`,
  } : {
    // A filter chip that comes back empty is usually the answer somebody
    // wanted, but it still has to offer the way back out -- every other list
    // in the app does, and a dead end reads as a broken screen.
    actions: filter === "all" ? "" :
      `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="cores-show-all">Show all cores</button>`,
    icon: filter === "credited" ? "check" : "core",
    title: filter === "pending" ? "Nothing waiting to go back"
      : filter === "awaiting" ? "No cores awaiting credit"
      : filter === "credited" ? "No credited cores yet"
      : "No core charges tracked yet",
    hint: filter === "pending"
      ? "Cores with a deposit wait here until the vendor's driver collects the old unit."
      : filter === "awaiting"
      ? "Cores you mark picked up wait here until the vendor's credit paperwork arrives and you record its number."
      : filter === "credited"
      ? "Once you record the vendor's credit/invoice number against a returned core it moves here."
      : "Put a core charge on a part line and it shows up here until the old unit goes back to the vendor and the deposit is recovered.",
  });

  $$(".clickable", $("#cores-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".cores-toggle, .cores-credit, .cores-select")) return;
      const item = state.cores.find((c) => c.id === Number(row.dataset.id));
      if (item) openVehicleFromRow(item);
    });
  });
  // Mark Returned / Undo: no paperwork at this step -- the core goes back to
  // the vendor first, the credit arrives later.
  $$(".cores-toggle", $("#cores-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const returned = btn.dataset.returned !== "1";
      try {
        await patch(`/api/orders/${btn.dataset.orderId}/estimate/items/${btn.dataset.itemId}/core-return`,
          { returned, actor: currentActor() });
        toast(returned ? "Core marked picked up — record the credit when the vendor's paperwork arrives" : "Back on the shelf");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  // Credit Received: the vendor's paperwork is here -- its number is what
  // moves the core into Credited.
  $$(".cores-credit", $("#cores-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = state.cores.find((c) => c.id === Number(btn.dataset.itemId));
      const answer = await promptInvoiceNumber({
        eyebrow: "CORE CREDIT",
        title: "Record the vendor's credit",
        body: item ? `${item.description}${item.part_number ? ` (${item.part_number})` : ""} — ${money(item.core_total)} deposit coming back, and off this car's cost.` : "",
        label: "Credit / invoice #",
        confirmLabel: "Record Credit",
      });
      if (answer === null) return;
      try {
        await post(`/api/orders/${btn.dataset.orderId}/estimate/items/${btn.dataset.itemId}/core-credit`,
          { invoice_number: answer, actor: currentActor() });
        toast("Core credit recorded");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".cores-select", $("#cores-table")).forEach((box) => {
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      const id = Number(box.dataset.id);
      if (box.checked) state.coresSelected.add(id); else state.coresSelected.delete(id);
      // The header checkbox has to follow row-by-row checks, not just full
      // re-renders -- checking every row by hand used to leave it unchecked.
      const boxes = $$(".cores-select", $("#cores-table"));
      $("#cores-select-all").checked = boxes.length > 0 && boxes.every((b) => b.checked);
      syncCoresBulkBar();
    });
  });
  $("#cores-select-all").checked = selectableIds.size > 0 && state.coresSelected.size === selectableIds.size;
  $("#cores-select-all").disabled = selectableIds.size === 0;
  syncCoresBulkBar();
}

function syncCoresBulkBar() {
  const n = state.coresSelected.size;
  $("#cores-bulk-bar").hidden = n === 0;
  $("#cores-bulk-count").textContent = `${n} selected`;
}

export function wireCoresView() {
  $$('#view-cores [data-cores-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.coresFilter = chip.dataset.coresFilter;
      $$('#view-cores [data-cores-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderCoresTable();
    });
  });
  $("#cores-search").addEventListener("input", (e) => {
    state.coresSearch = e.target.value.trim();
    renderCoresTable();
  });
  // Delegated: the empty state is rebuilt on every render, so a listener
  // bound to its button would be lost the moment anything changed.
  $("#cores-table").addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-empty-action]");
    if (!trigger) return;
    if (trigger.dataset.emptyAction === "cores-clear-search") {
      state.coresSearch = "";
      $("#cores-search").value = "";
    } else if (trigger.dataset.emptyAction === "cores-show-all") {
      state.coresFilter = "all";
      $$('#view-cores [data-cores-filter]').forEach((c) =>
        c.classList.toggle("active", c.dataset.coresFilter === "all"));
    } else return;
    renderCoresTable();
  });
  $("#cores-select-all").addEventListener("change", (e) => {
    const ids = $$(".cores-select", $("#cores-table")).map((box) => Number(box.dataset.id));
    state.coresSelected = new Set(e.target.checked ? ids : []);
    renderCoresTable();
  });
  $("#cores-bulk-clear").addEventListener("click", () => {
    state.coresSelected = new Set();
    renderCoresTable();
  });
  $("#cores-bulk-pickup").addEventListener("click", async (e) => {
    const ids = [...state.coresSelected];
    if (!ids.length) return;
    if (!(await confirmAction({
      eyebrow: "CORES",
      title: `Mark ${ids.length} core${ids.length === 1 ? "" : "s"} picked up?`,
      body: "Moves them to Awaiting Credit. No paperwork is needed yet -- record the credit once the vendor's invoice arrives.",
      confirmLabel: "Mark Picked Up",
    }))) return;
    await withLoading(e.currentTarget, "Updating…", async () => {
      const targets = ids.map((id) => state.cores.find((c) => c.id === id)).filter(Boolean);
      const results = await Promise.allSettled(targets.map((c) =>
        patch(`/api/orders/${c.order_id}/estimate/items/${c.id}/core-return`, { returned: true, actor: currentActor() })
      ));
      const failed = results.filter((r) => r.status === "rejected").length;
      toast(failed ? `${targets.length - failed} of ${targets.length} marked picked up` : `${targets.length} core${targets.length === 1 ? "" : "s"} marked picked up`, !!failed);
      state.coresSelected = new Set();
      await loadCoresView();
    });
  });
}

// Same three states as cores, on the same words: Pending (flagged to go
// back but still physically here), Awaiting Credit (the vendor collected
// it), Credited (their paperwork is recorded).
function returnStatus(r) {
  if (r.return_invoice_number) return "credited";
  return r.part_picked_up_at ? "awaiting" : "pending";
}

function renderReturnsTable() {
  const filter = state.returnsFilter;
  const query = (state.returnsSearch || "").toLowerCase();
  const rows = state.returns.filter((r) => {
    if (!coresMatchesSearch(r, query)) return false;
    if (filter === "all") return true;
    return returnStatus(r) === filter;
  });
  $("#returns-count").textContent = `${rows.length} return${rows.length === 1 ? "" : "s"}`;
  // Outstanding is anything not yet credited, whether or not it's left the
  // building -- that's the money the vendor still owes back.
  const outstanding = state.returns.filter((r) => returnStatus(r) !== "credited" && !r.voided).reduce((s, r) => s + Math.abs(r.credit_total), 0);
  const onShelf = state.returns.filter((r) => returnStatus(r) === "pending" && !r.voided).length;
  $("#returns-total").textContent = state.returns.length
    ? (outstanding > 0
        ? `${money(outstanding)} outstanding${onShelf ? ` · ${onShelf} still here` : ""}`
        : "all credits posted")
    : "";

  const RETURN_PILL = { pending: "pill-progress", awaiting: "pill-credit-pending", credited: "pill-done" };
  const RETURN_LABEL = { pending: "Pending", awaiting: "Awaiting Credit", credited: "Credited" };

  const selectableIds = new Set(rows.filter((r) => !r.voided && returnStatus(r) === "pending").map((r) => r.id));
  state.returnsSelected = new Set([...state.returnsSelected].filter((id) => selectableIds.has(id)));

  $("#returns-table").innerHTML = rows.length ? rows.map((r) => {
    const clickable = r.stock_number || r.we_owe_customer_name;
    const voided = !!r.voided;
    const status = returnStatus(r);
    const selectable = !voided && status === "pending";
    const checked = state.returnsSelected.has(r.id);
    const actions = voided ? "" : status === "pending"
      ? `<button type="button" class="btn btn-ghost btn-xs returns-pickup" data-id="${r.id}" data-picked-up="0">Mark Picked Up</button>`
      : status === "awaiting"
      ? `<button type="button" class="btn btn-primary btn-xs returns-post" data-id="${r.id}">Credit Received</button>
         <button type="button" class="btn btn-ghost btn-xs returns-pickup" data-id="${r.id}" data-picked-up="1">Undo</button>`
      : "";
    return `
    <tr class="${clickable ? "clickable" : ""} ${voided ? "voided-row" : ""}" data-id="${r.id}" ${clickable ? `title="Open ${esc(r.vehicle_label)}"` : `title="Not linked to a vehicle record"`}>
      <td class="sel-col">${selectable ? `<input type="checkbox" class="returns-select" data-id="${r.id}" ${checked ? "checked" : ""} aria-label="Select ${esc(r.description)}">` : ""}</td>
      <td>${esc(r.description)}${status === "credited" ? `<div class="veh-sub num">Inv ${esc(r.return_invoice_number)}</div>` : status === "awaiting" ? awaitingAgeHtml(daysSince(r.part_picked_up_at)) : ""}</td>
      <td>${r.part_number ? esc(r.part_number) : '<span class="muted-dash">—</span>'}</td>
      <td>${esc(r.ro_number)} · ${esc(r.vehicle_label)}</td>
      <td>${esc(r.vendor_name || "—")}</td>
      <td class="num-col">${money(Math.abs(r.credit_total))}</td>
      <td><span class="pill ${RETURN_PILL[status]}">${RETURN_LABEL[status]}</span></td>
      <td class="actions-col"><div class="row-actions">${actions}</div></td>
    </tr>
  `;
  }).join("") : emptyRow(8, query ? {
    icon: "search",
    title: "No returns match that search",
    hint: `Nothing matched "${state.returnsSearch}".`,
    actions: `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="returns-clear-search">Clear search</button>`,
  } : {
    actions: filter === "all" ? "" :
      `<button type="button" class="btn btn-ghost btn-sm" data-empty-action="returns-show-all">Show all returns</button>`,
    icon: filter === "credited" ? "check" : "core",
    title: filter === "pending" ? "Nothing waiting to go back"
      : filter === "awaiting" ? "No returns awaiting credit"
      : filter === "credited" ? "No credited returns yet"
      : "No parts returned yet",
    hint: filter === "pending"
      ? "Parts you mark returned on a ticket wait here until the vendor's driver collects them."
      : filter === "awaiting"
      ? "Once a part is picked up it waits here until the vendor's credit arrives and you record it."
      : filter === "credited"
      ? "Once you record the vendor's credit against a return it moves here with its invoice number."
      : "Mark a received part as returned on its ticket and it lands here until it goes back and the credit is recorded.",
  });

  $$(".clickable", $("#returns-table")).forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".returns-post, .returns-pickup, .returns-select")) return;
      const item = state.returns.find((r) => r.id === Number(row.dataset.id));
      if (item) openVehicleFromRow(item);
    });
  });
  // Mark Picked Up / Undo -- purely physical, no paperwork involved.
  $$(".returns-pickup", $("#returns-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = state.returns.find((r) => r.id === Number(btn.dataset.id));
      if (!item) return;
      const pickedUp = btn.dataset.pickedUp !== "1";
      try {
        await patch(`/api/orders/${item.order_id}/estimate/items/${item.id}/part-pickup`,
          { picked_up: pickedUp, actor: currentActor() });
        toast(pickedUp ? "Marked picked up — record the credit when it arrives" : "Back on the shelf");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".returns-post", $("#returns-table")).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = state.returns.find((r) => r.id === Number(btn.dataset.id));
      if (item) await withLoading(btn, "Opening…", () => openPostReturnDialog(item));
    });
  });
  $$(".returns-select", $("#returns-table")).forEach((box) => {
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      const id = Number(box.dataset.id);
      if (box.checked) state.returnsSelected.add(id); else state.returnsSelected.delete(id);
      // Same rule as the cores table: the header checkbox follows row checks.
      const boxes = $$(".returns-select", $("#returns-table"));
      $("#returns-select-all").checked = boxes.length > 0 && boxes.every((b) => b.checked);
      syncReturnsBulkBar();
    });
  });
  $("#returns-select-all").checked = selectableIds.size > 0 && state.returnsSelected.size === selectableIds.size;
  $("#returns-select-all").disabled = selectableIds.size === 0;
  syncReturnsBulkBar();
}

function syncReturnsBulkBar() {
  const n = state.returnsSelected.size;
  $("#returns-bulk-bar").hidden = n === 0;
  $("#returns-bulk-count").textContent = `${n} selected`;
}

export function wireReturnsView() {
  $$('#view-cores [data-returns-filter]').forEach((chip) => {
    chip.addEventListener("click", () => {
      state.returnsFilter = chip.dataset.returnsFilter;
      $$('#view-cores [data-returns-filter]').forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderReturnsTable();
    });
  });
  $("#returns-search").addEventListener("input", (e) => {
    state.returnsSearch = e.target.value.trim();
    renderReturnsTable();
  });
  $("#returns-table").addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-empty-action]");
    if (!trigger) return;
    if (trigger.dataset.emptyAction === "returns-clear-search") {
      state.returnsSearch = "";
      $("#returns-search").value = "";
    } else if (trigger.dataset.emptyAction === "returns-show-all") {
      state.returnsFilter = "all";
      $$('#view-cores [data-returns-filter]').forEach((c) =>
        c.classList.toggle("active", c.dataset.returnsFilter === "all"));
    } else return;
    renderReturnsTable();
  });
  $("#returns-select-all").addEventListener("change", (e) => {
    const ids = $$(".returns-select", $("#returns-table")).map((box) => Number(box.dataset.id));
    state.returnsSelected = new Set(e.target.checked ? ids : []);
    renderReturnsTable();
  });
  $("#returns-bulk-clear").addEventListener("click", () => {
    state.returnsSelected = new Set();
    renderReturnsTable();
  });
  $("#returns-bulk-pickup").addEventListener("click", async (e) => {
    const ids = [...state.returnsSelected];
    if (!ids.length) return;
    if (!(await confirmAction({
      eyebrow: "RETURNS",
      title: `Mark ${ids.length} part${ids.length === 1 ? "" : "s"} picked up?`,
      body: "Moves them to Awaiting Credit. No paperwork is needed yet -- record the credit once the vendor's invoice arrives.",
      confirmLabel: "Mark Picked Up",
    }))) return;
    await withLoading(e.currentTarget, "Updating…", async () => {
      const targets = ids.map((id) => state.returns.find((r) => r.id === id)).filter(Boolean);
      const results = await Promise.allSettled(targets.map((r) =>
        patch(`/api/orders/${r.order_id}/estimate/items/${r.id}/part-pickup`, { picked_up: true, actor: currentActor() })
      ));
      const failed = results.filter((r) => r.status === "rejected").length;
      toast(failed ? `${targets.length - failed} of ${targets.length} marked picked up` : `${targets.length} part${targets.length === 1 ? "" : "s"} marked picked up`, !!failed);
      state.returnsSelected = new Set();
      await loadCoresView();
    });
  });
}

async function openPostReturnDialog(item) {
  state.postReturnItem = item;
  $("#post-return-desc").textContent = `${item.description}${item.part_number ? ` (${item.part_number})` : ""} — ${item.ro_number} · ${item.vehicle_label}`;
  const vendors = await get("/api/vendors").catch(() => []);
  state.vendors = vendors;
  // When the part was never received against an invoice the vendor can't be
  // resolved -- defaulting to the first vendor alphabetically posts a real
  // credit against an innocent vendor one silent click later. Force a choice.
  const resolved = vendors.some((v) => v.id === item.vendor_id);
  $("#post-return-vendor").innerHTML =
    (resolved ? "" : `<option value="" selected disabled>Select the vendor…</option>`) +
    vendors.map((v) => `<option value="${v.id}" ${v.id === item.vendor_id ? "selected" : ""}>${esc(v.name)}</option>`).join("");
  $("#post-return-vendor-warning").hidden = resolved;
  $("#post-return-credit-number").value = "";
  const qty = item.received_quantity || item.quantity;
  $("#post-return-total-summary").innerHTML = `
    ${qty && item.unit_cost != null ? `<div class="cost-line"><span>Qty ${esc(String(qty))} × ${money(item.unit_cost)}</span><span></span></div>` : ""}
    <div class="cost-line total"><span>Credit Due</span><span class="num">${money(Math.abs(item.credit_total))}</span></div>
  `;
  $("#post-return-dialog").showModal();
  $("#post-return-credit-number").focus();
}

export function wirePostReturnDialog() {
  const dialog = $("#post-return-dialog");
  ["#post-return-cancel", "#post-return-cancel-2"].forEach((id) => {
    $(id).addEventListener("click", () => dialog.close());
  });
  // A stale item must not linger for the next open.
  dialog.addEventListener("close", () => { state.postReturnItem = null; });
  $("#post-return-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = state.postReturnItem;
    if (!item) return;
    const vendorId = Number($("#post-return-vendor").value);
    const creditNumber = $("#post-return-credit-number").value.trim();
    if (!vendorId) return toast("Select the vendor", true);
    if (!creditNumber) return toast("Enter the credit/RMA number", true);
    const vendorName = state.vendors.find((v) => v.id === vendorId)?.name || "the vendor";
    // Posting writes a real credit invoice into A/P and can only be undone
    // by voiding that invoice -- worth one explicit question.
    if (!(await confirmAction({
      eyebrow: "RETURN",
      title: `Post this credit to A/P?`,
      body: `Creates a ${money(Math.abs(item.credit_total))} credit invoice against ${vendorName}. It can only be reversed by voiding that invoice.`,
      confirmLabel: "Post Credit",
    }))) return;
    await withLoading(e.submitter, "Posting…", async () => {
      try {
        await post(`/api/orders/${item.order_id}/estimate/items/${item.id}/post-return-credit`, {
          vendor_id: vendorId,
          credit_number: creditNumber,
          actor: currentActor(),
        });
        dialog.close();
        toast("Credit posted to A/P");
        await loadCoresView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}
