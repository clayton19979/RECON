import { $, $$, api, fmtHours, get, patch, post, put, withActorParam } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { actorLabel, byActor, currentActor, esc, fmtDate, fmtDay, money, relativeTime, todayLocal, vehicleColorTagHtml, wirePlateFields, withLoading } from "./shortcuts.js";
import { emptyState } from "./empty-states.js";
import { actualTotal, isReturnedPart, lineTotal, ticketTotal, unreceivedPartLines, unreceivedPartTotal } from "./estimate-money.js";
import { AUTH_METHOD_LABEL, ITEM_STATUS_LABEL, KIND_GROUP_LABEL, KIND_GROUP_ORDER, PAY_METHOD_LABEL, STATUS_LABEL, STATUS_OPTIONS, STATUS_PILL_CLASS, fieldLabels, state } from "./state.js";
import { showView } from "./error-boundary.js";
import { applyVehicleCursor, displayedVehicles, isStalled, vehicleKey } from "./vehicles-board.js";
import { openMoveSegmentDialog } from "./move-ticket.js";
import { openReceiveDialog } from "./dialog-receive-parts.js";
import { openAddVehicleDialog, openCustomerEditor } from "./customers.js";
import { loadTasksView, taskLinkFields } from "./task-bulk.js";
import { taskDueInfo } from "./tasks.js";
import { assigneeSummaryLabel } from "./multi-picker.js";
import { copyText } from "./clipboard.js";
import { renderInspection } from "./inspection.js";

/* ==================================================================
   VEHICLE DETAIL
   ================================================================== */
export async function openVehicleDetail(segment, id) {
  state.detail = { segment, id, item: null, order: null, tasks: [] };
  await loadVehicleDetail();
}
// showView only knows named views wired to the rail; vehicle-detail is entered directly.
// A retail vehicle's home screen is Customers, not the recon/we-owe board --
// the rail highlight and the back link both say where Back actually goes.
function detailHomeView() {
  return state.detail.segment === "retail" ? "customers" : "vehicles";
}
function enterVehicleDetailView() {
  const home = detailHomeView();
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-vehicle-detail"));
  $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.view === home));
  $("#back-to-vehicles-label").textContent = home === "customers" ? "Back to Customers" : "Back to Vehicles";
  // The same announcement showView makes, because this page is entered around
  // it -- otherwise the freshness check would go on measuring against whatever
  // the board was showing before the car was opened. See static/js/pulse.js.
  document.dispatchEvent(new CustomEvent("recon:viewshown", { detail: "vehicle-detail" }));
}

export async function loadVehicleDetail() {
  // Everything below is written against this one object. openVehicleDetail
  // replaces state.detail wholesale, so a load that awoke from its fetches to
  // find a different object there belongs to a car the user has already
  // flipped past -- rendering it would paint the old car's numbers on the new
  // car's page. Refreshes of the same page reuse the object and pass.
  const detail = state.detail;
  const { segment, id } = detail;
  let item, orders;
  try {
    // Three segments, three entities: recon/we-owe pages are keyed by their
    // container row's id; a retail page is keyed by the vehicle row itself.
    item = segment === "recon" ? await get(`/api/recon/vehicles/${id}`)
      : segment === "retail" ? await get(`/api/retail/vehicles/${id}`)
      : await get(`/api/we-owe/${id}`);
    const allOrders = await get(`/api/orders?segment=${segment}`);
    orders = allOrders.filter((o) => segment === "recon" ? o.recon_vehicle_id === id
      : segment === "retail" ? o.vehicle_id === id
      : o.we_owe_id === id)
      .sort((a, b) => b.id - a.id);
  } catch (err) {
    if (state.detail !== detail) return;
    toast(`Could not load vehicle: ${err.message}`, true);
    return;
  }
  if (state.detail !== detail) return;
  state.detail.item = item;
  state.detail.ordersHistory = orders;
  /* The whole task queue, filtered to this car in the browser. It is a short
     list -- the shop's open follow-ups, not its history -- and fetching it
     whole means the card and the Tasks screen can never disagree about what
     an open follow-up is. A failure here must not take the page down with it:
     the follow-ups are worth showing, they are not worth losing the ticket
     over, so the card simply stays empty. */
  try {
    detail.tasks = await get("/api/tasks");
  } catch {
    detail.tasks = [];
  }
  if (state.detail !== detail) return;
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
  renderVehicleTasks();
  // Deleting a vehicle with real order history would silently orphan its
  // cost data -- only offer it while there's nothing to lose yet. Retail
  // vehicles are never deletable from here at all: they're the customer's
  // property record, managed from the Customers screen.
  $("#vd-delete").style.display = orders.length === 0 && segment !== "retail" ? "" : "none";
  $("#vd-no-order").style.display = active ? "none" : "";
  $("#vd-order-content").style.display = active ? "" : "none";
  // Null is the state of a car nobody has written up yet, and it is set here
  // on every load rather than only when the page is entered fresh: this
  // function is also what runs after a save, and voiding the last ticket on a
  // car turns a page that had one into a page that hasn't.
  state.detail.order = null;
  if (active) {
    let order;
    try {
      order = await get(`/api/orders/${active.id}`);
    } catch (err) {
      if (state.detail !== detail) return;
      toast(`Could not load repair order: ${err.message}`, true);
      return;
    }
    if (!state.staff.length) state.staff = await get("/api/staff");
    if (state.detail !== detail) return;
    detail.order = order;
  }
  renderOrderPanel();
  applyArchivedLockUI(!!item.archived_at);
}

/* ---------- who can be picked for a ticket or a repair ----------

   state.staff is active-only on purpose: somebody who has left the shop must
   not be offered new work. But a dropdown can only show what is in it, so on
   a car whose technician has since been deactivated every one of these
   pickers quietly fell back to its first option and read "Unassigned" -- two
   lines under a header still saying "Ray / Dana", about a ticket the database
   still had Ray on. The screen contradicted itself, and the next save of that
   popover would have posted the "Unassigned" it was showing and made itself
   right by wiping him.

   So whoever is actually in the slot is always in the list, marked so nobody
   mistakes them for someone still on the floor. It is the same rule the
   server keeps (see assert_assignable): you cannot hand new work to somebody
   who has gone, and what they already hold stays theirs until a person moves
   it. */
function staffOptions({ roles, selectedId, selectedName, blankLabel }) {
  const people = state.staff.filter((s) => roles.includes(s.role)).map((s) => ({ id: s.id, name: s.name }));
  if (selectedId && !people.some((p) => p.id === selectedId)) {
    // The name comes off the ticket itself, which carries it for exactly this
    // reason. Falling back to the id would put a bare number on screen.
    people.unshift({ id: selectedId, name: `${selectedName || "No longer on staff"} (inactive)` });
  }
  return `<option value="">${esc(blankLabel)}</option>` + people.map((p) =>
    `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
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
        <span><span class="ro-tag">RO ${esc(String(o.ro_number || "—"))}</span></span>
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

/* The card that puts the shop's shared to-do list on the car it's about.

   Open follow-ups only. A ticked-off one is history, and this card's whole
   claim is "here is what is still owed on this car" -- padding it with last
   month's finished notes is how a panel stops being read. The list arrives
   already ordered by the API (urgent first, then soonest due), so it is
   rendered in the order it came in rather than sorted a second time here and
   risking a different answer from the Tasks screen's. */
function renderVehicleTasks() {
  const open = tasksForThisVehicle().filter((t) => !t.done);
  const card = $("#vd-tasks-card");
  if (!open.length) {
    card.style.display = "none";
    $("#vd-tasks-list").innerHTML = "";
    return;
  }
  card.style.display = "";
  const overdue = open.filter((t) => (taskDueInfo(t.due_date)?.days ?? 0) < 0).length;
  $("#vd-tasks-title").textContent = open.length === 1 ? "1 follow-up" : `${open.length} follow-ups`;
  const head = $("#vd-tasks-card .section-eyebrow");
  head.textContent = overdue ? `${overdue} PAST DUE` : "FOLLOW-UPS";
  head.classList.toggle("eyebrow-warn", !!overdue);
  $("#vd-tasks-list").innerHTML = open.map((t) => {
    const due = taskDueInfo(t.due_date);
    const who = (t.assigned_to || []).length ? esc(assigneeSummaryLabel(t.assigned_to)) : "nobody yet";
    const meta = [
      who,
      due ? `<span class="vd-task-due ${due.cls}">Due ${esc(due.label)}</span>` : "",
      `by ${esc(t.created_by || "Unspecified")} · ${relativeTime(t.created_at)}`,
    ].filter(Boolean).join(" · ");
    return `
      <div class="mini-item vd-task" data-id="${t.id}">
        <div class="mi-title">
          <span>${t.urgent ? '<span class="vd-task-urgent">Urgent</span>' : ""}${esc(t.title)}</span>
          <button type="button" class="btn btn-ghost btn-xs vd-task-done" title="Mark done" aria-label="Mark ${esc(t.title)} done">Done</button>
        </div>
        <div class="mi-meta">${meta}</div>
        ${t.notes ? `<div class="mi-concern">${esc(t.notes)}</div>` : ""}
      </div>`;
  }).join("");
  $$(".vd-task-done", $("#vd-tasks-list")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".vd-task").dataset.id;
      try {
        await patch(`/api/tasks/${id}`, { done: true });
        toast("Follow-up marked done");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function selectOrder(orderId) {
  if (orderId === state.detail.selectedOrderId) return;
  state.detail.selectedOrderId = orderId;
  await loadVehicleDetail();
}

/* "Last worked on" -- the other end of the board's Idle column.

   The board tells you a car has been sitting nine days; until now, opening it
   dropped you onto a page whose only timestamp said "Updated 3 minutes ago"
   (the vehicle record, moved by a VIN correction), with the real answer buried
   at the bottom of the activity log in the sidebar. Same number the board
   sorted on, same isStalled rule the card counts by, stated where you land --
   which includes the card's rule that a finished car is never stalled.

   The server sends `last_activity` as {at, idle_days, action, actor} and
   leaves action/actor empty when it can't honestly attribute the timestamp --
   see last_activity_detail in app/recon.py. That case is common, not an edge:
   the estimate grid autosaves without logging an event, so a car worked on
   for an hour this morning may have no event to name. Rendering it as
   "— by unknown" would be worse than saying nothing, so attribution is a
   suffix on a line that stands on its own without it. */
function renderLastWorked() {
  const el = $("#vd-last-worked");
  if (!el) return;
  const la = state.detail.item && state.detail.item.last_activity;
  if (!la || !la.at) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  const days = Math.max(0, la.idle_days || 0);
  // The tone and the nudge are a judgement about a car that still needs work,
  // so a finished one gets neither: opening a we-owe waived last month used
  // to greet you with a red line offering to make a follow-up task about a
  // promise that was closed on purpose. status_bucket comes off the same
  // detail payload the board's rows carry it on.
  const stalled = isStalled({ idle_days: days, status_bucket: state.detail.item.status_bucket });
  const when = days === 0 ? "today" : relativeTime(la.at);
  // byActor, not `la.actor ? ...`: an actor of "ui" is truthy and is the
  // server's placeholder for a request that never said who, so the truthiness
  // check printed "— Assignment changed by ui" on a line whose own comment
  // above says naming nobody beats naming a nobody.
  const who = la.action ? `${activityLabel(la.action)}${byActor(la.actor)}` : "";
  el.className = `detail-worked${stalled ? " stalled" : ""}`;
  el.title = `Last activity ${String(la.at).slice(0, 10)}`;
  // The nudge only appears on a car that's actually stalled, and points at the
  // + Task button already in the header rather than adding a second way to do
  // the same thing three inches away from the first.
  el.innerHTML = `<span class="detail-worked-label">Last worked on</span> ${esc(when)}` +
    (who ? ` <span class="detail-worked-what">— ${esc(who)}</span>` : "") +
    (stalled ? ` <button type="button" class="detail-worked-nudge" id="vd-worked-nudge">Stalled ${days} days — make a task</button>` : "");
  const nudge = $("#vd-worked-nudge");
  if (nudge) {
    nudge.addEventListener("click", () => addTaskForThisVehicle({
      prefill: `Follow up: ${$("#vd-title").textContent} — no work in ${days} days`,
    }));
  }
}

/* "Promised to customer" -- the other end of the board's Past Promised tile.

   Same closing-the-loop rule as renderLastWorked above: the board flags a
   we-owe as days past the date the customer was given, but the date itself
   only existed on this page as a form field inside the collapsible drawer --
   land on the ticket and the most urgent fact about it was invisible. Stated
   on the identity band instead, in the same three tones the shop already
   reads everywhere else: red once the date is missed, amber when it's today
   or tomorrow, quiet the rest of the time.

   Only ever said about a promise that is still owed -- a fulfilled or waived
   we-owe keeps its date in the drawer, but greeting someone with "3 days
   past" about a promise that was settled on purpose is the same false alarm
   the stalled nudge above deliberately avoids. Recon and retail cars have no
   customer promise, so they never show the line at all. */
function calendarDaysUntil(dateStr) {
  // A bare calendar date, split by hand for the same reason fmtDay splits
  // one: new Date("2026-08-01") is UTC midnight, which in Indiana is still
  // the evening before.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Local midnights on both sides; rounding absorbs the odd DST hour.
  return Math.round((target - today) / 86400000);
}

function renderPromiseLine() {
  const el = $("#vd-promise-line");
  if (!el) return;
  const { segment, item } = state.detail;
  const days = segment === "we_owe" && item.status === "open"
    ? calendarDaysUntil(item.target_date)
    : null;
  if (days === null) {
    el.hidden = true;
    el.textContent = "";
    el.className = "detail-promise";
    return;
  }
  el.hidden = false;
  const overdue = days < 0;
  const late = Math.abs(days);
  el.className = `detail-promise${overdue ? " overdue" : days <= 1 ? " soon" : ""}`;
  const when = overdue ? ""
    : days === 0 ? " — due today"
    : days === 1 ? " — due tomorrow"
    : ` — in ${days} days`;
  // Past due, the count moves onto the button: the same shape as the stalled
  // nudge one line up, and the click writes the call down instead of leaving
  // it to memory.
  el.innerHTML = `<span class="detail-promise-label">Promised to customer</span> ${esc(fmtDay(item.target_date))}` +
    (when ? `<span class="detail-promise-when">${esc(when)}</span>` : "") +
    (overdue ? ` <button type="button" class="detail-worked-nudge" id="vd-promise-nudge">${late} day${late === 1 ? "" : "s"} past — make a task</button>` : "");
  const nudge = $("#vd-promise-nudge");
  if (nudge) {
    nudge.addEventListener("click", () => addTaskForThisVehicle({
      prefill: `Call ${item.customer_name || "the customer"}: ${item.description || "we-owe work"} was promised by ${fmtDay(item.target_date)}`,
    }));
  }
}

/* Which entry in the Tasks screen's vehicle picker means the car on screen.

   The picker offers cars with a live ticket as "order:<id>" and cars with none
   as "recon:<id>" / "we_owe:<id>", so this asks for the ticket first and falls
   back to the car itself -- which is what makes + Task work at all on a car
   nobody has written up yet. */
function detailPickerValue() {
  const { segment, id, order } = state.detail;
  if (order) return `order:${order.id}`;
  return segment === "recon" || segment === "we_owe" ? `${segment}:${id}` : "";
}

/* The follow-ups left on this car, out of the whole queue.

   Matched on the task's own car columns rather than on its ticket, so a note
   left on a car with no repair order still lands on that car's page. Retail
   pages have no lot record, so they match through the ticket's vehicle. */
function tasksForThisVehicle() {
  const { segment, id } = state.detail;
  const all = state.detail.tasks || [];
  if (segment === "recon") return all.filter((t) => t.recon_vehicle_id === id);
  if (segment === "we_owe") return all.filter((t) => t.we_owe_id === id);
  return all.filter((t) => t.order_vehicle_id === id);
}

/* Jumps to Tasks with this vehicle pre-selected in the link
   dropdown, rather than making the advisor reopen the picker and hunt for the
   RO they were just looking at.

   Was inline on the + Task button; pulled out because the stalled nudge on
   the line above wants the same thing, and "notice a car has been sitting for
   nine days" -> "write down what to do about it" is the whole point of
   surfacing idle time at all. `prefill` lets a caller seed the title, which
   the nudge uses -- the advisor can still type over it, but an empty box is
   one more thing to compose at the exact moment they were about to move on.

   Deliberately does not create the task: nobody wants a queue full of
   auto-generated "follow up" rows, and the assignee and due date are the
   parts that make a task worth having. */
async function addTaskForThisVehicle({ prefill = "" } = {}) {
  const wanted = detailPickerValue();
  showView("tasks");
  await loadTasksView();
  if (wanted && $$("#task-order-input option").some((o) => o.value === wanted)) {
    $("#task-order-input").value = wanted;
  }
  const title = $("#task-title-input");
  if (prefill && !title.value) title.value = prefill;
  title.focus();
  // Caret at the end rather than selecting the prefill, so typing extends the
  // suggestion instead of silently wiping it.
  if (title.value) title.setSelectionRange(title.value.length, title.value.length);
}

/* VIN, mileage and trim/description as individual spec tags under the title,
   instead of one dot-joined grey line. Markup only -- the values are exactly
   what the joined line carried. */
function specTagsHtml(parts) {
  return parts.filter(Boolean).map((p) => `<span class="spec">${esc(p)}</span>`).join("");
}

// The colour as its own spec tag, wearing the same paint chip the board's
// cards do -- built separately because specTagsHtml escapes its parts as
// plain text and the chip is markup.
function colorSpecHtml(item) {
  const tag = vehicleColorTagHtml(item.color);
  return tag ? `<span class="spec">${tag}</span>` : "";
}

// "ABC1234 (IN)", or nothing at all when no plate is on file. Sits in the
// header beside the VIN because it is the identifier someone walking back in
// from the lot actually has in their head.
function plateTag(item) {
  return item.plate ? `${item.plate}${item.plate_state ? ` (${item.plate_state})` : ""}` : "";
}

function renderDetailHead() {
  const { segment, item } = state.detail;
  // The band's left edge names the side, same colour rule as the board's
  // cards, so it has to follow the vehicle being shown -- the element is
  // reused across every vehicle opened this session.
  const head = document.querySelector(".detail-head");
  head.classList.remove("dh-recon", "dh-weowe", "dh-retail");
  head.classList.add(segment === "recon" ? "dh-recon" : segment === "we_owe" ? "dh-weowe" : "dh-retail");
  const updatedEl = $("#vd-updated");
  if (item.updated_at) {
    const minutesAgo = (Date.now() - new Date(item.updated_at).getTime()) / 60000;
    updatedEl.textContent = `Updated ${relativeTime(item.updated_at)}`;
    updatedEl.classList.toggle("recent", minutesAgo < 10);
  } else {
    updatedEl.textContent = "";
  }
  // Deliberately relabelled from "Updated" to name what it actually tracks.
  // Side by side with the line above it, an unqualified "Updated 3 minutes
  // ago" under "Last worked on 9 days ago" reads as a contradiction; it isn't,
  // it's the vehicle *record* -- someone correcting a VIN, which is exactly
  // the edit the idle clock is built to ignore.
  if (updatedEl.textContent) updatedEl.textContent = `Record updated ${relativeTime(item.updated_at)}`;
  renderLastWorked();
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
  $("#vd-recon-plate").value = item.plate || "";
  $("#vd-recon-plate-state").value = item.plate_state || "";
  // Arrival date is a recon-only fact: a we-owe car was bought and sold long
  // before this shop wrote it down, so there is no lot arrival to record.
  $("#vd-acquired-row").hidden = segment !== "recon";
  $("#vd-recon-acquired").value = segment === "recon" ? item.acquisition_date || "" : "";
  // Same rule as the arrival date: only a car the lot owns has a stock number.
  $("#vd-stock-row").hidden = segment !== "recon";
  $("#vd-recon-stock").value = segment === "recon" ? item.stock_number || "" : "";
  if (segment === "recon") {
    $("#vd-title").textContent = `${item.stock_number} — ${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").innerHTML = colorSpecHtml(item)
      + specTagsHtml([plateTag(item), item.vin, item.mileage ? `${item.mileage.toLocaleString()} mi` : "", item.trim]);
    $("#vd-customer-line").hidden = true;
    $("#vd-customer-info-card").style.display = "none";
    $("#vd-other-vehicles-card").style.display = "none";
    $("#vd-we-owe-status-card").style.display = "none";
    $("#vd-deposits-card").style.display = "none";
  } else {
    // we_owe and retail share the customer-owned-car layout; only we_owe has
    // the promise machinery (status/category/target, dealer-paid deposits).
    $("#vd-title").textContent = `${item.year} ${item.make} ${item.model}`;
    $("#vd-sub").innerHTML = colorSpecHtml(item)
      + specTagsHtml([plateTag(item), item.vin, item.mileage ? `${item.mileage.toLocaleString()} mi` : "", item.description]);
    // Customer name gets its own prominent line in the header rather than
    // being buried mid-subtitle -- whose car it is is the first thing the
    // advisor needs.
    const customerLine = $("#vd-customer-line");
    customerLine.textContent = item.customer_name ? `Customer: ${item.customer_name}` : "";
    customerLine.hidden = !item.customer_name;
    $("#vd-customer-info-card").style.display = "";
    renderCustomerInfoSummary();
    // Other Vehicles is retail-only: a we-owe page is about the promise on
    // *this* car, and its detail payload doesn't carry sibling vehicles.
    $("#vd-other-vehicles-card").style.display = segment === "retail" ? "" : "none";
    if (segment === "retail") renderOtherVehicles();
    if (segment === "we_owe") {
      $("#vd-we-owe-status-card").style.display = "";
      $("#vd-we-owe-status").value = item.status;
      $("#vd-we-owe-description").value = item.description || "";
      $("#vd-we-owe-category").value = item.category || "";
      $("#vd-we-owe-target").value = item.target_date || "";
      $("#vd-deposits-card").style.display = "";
      renderDepositsSummary();
    } else {
      $("#vd-we-owe-status-card").style.display = "none";
      $("#vd-deposits-card").style.display = "none";
    }
  }
  renderPromiseLine();
  renderCostSummary();
  renderVehicleInfoSummary();
}

// Vehicle-wide (every RO ever opened on this vehicle, not just the active
// one) -- quoted_cost/total_cost already come from the same cost_rollup
// the Vehicles-list stats use, just never surfaced here before. The server's
// field is still named quoted_cost; it means "everything written up", and
// nothing here compares it against what was spent -- see estimate-money.js.
function renderCostSummary() {
  const { item } = state.detail;
  const box = $("#vd-cost-summary");
  let lines = `<div class="cost-line"><span>Written Up</span><span class="num">${money(item.quoted_cost)}</span></div>`;
  lines += `<div class="cost-line total"><span>Actual Cost</span><span class="num">${money(item.total_cost)}</span></div>`;
  // Hours stand on their own line rather than hiding inside cost. On recon and
  // we-owe the labor rate is 0, so every hour a tech flags contributes nothing
  // to the money column -- this is the only place the work itself shows up.
  if (item.labor_hours) {
    lines += `<div class="cost-line"><span>Labor logged</span><span class="num">${fmtHours(item.labor_hours)}</span></div>`;
  }
  if (state.detail.segment !== "recon" && item.customer_paid) {
    lines += `<div class="cost-line"><span>Customer paid</span><span class="num">${money(item.customer_paid)}</span></div>`;
    lines += `<div class="cost-line total"><span>Net to shop</span><span class="num">${money(item.net_cost)}</span></div>`;
  }
  box.innerHTML = lines;
  // The identity band's money readout -- same numbers as the lines above, so
  // the band can never disagree with the drawer's cost card. The written-up
  // subline only appears while it differs from actual, i.e. while something
  // on the ticket hasn't landed yet.
  $("#vd-head-cost-value").textContent = money(item.total_cost);
  const headSub = $("#vd-head-cost-sub");
  const differs = Math.abs((item.quoted_cost || 0) - (item.total_cost || 0)) >= 0.005;
  headSub.textContent = differs ? `${money(item.quoted_cost)} written up` : "";
  headSub.hidden = !differs;
  $("#vd-head-cost").hidden = false;
}

// Compact read-only summary replacing the old always-open inline edit form --
// the full form still exists verbatim, just relocated into #vehicle-edit-dialog.
function renderVehicleInfoSummary() {
  const { segment, item } = state.detail;
  const lifetime = item.lifetime;
  const rows = [
    // A VIN gets retyped into parts catalogues and vendor sites all day long,
    // and it's 17 characters where one wrong digit is silent.
    ["VIN", item.vin
      ? `${esc(item.vin)} <button type="button" class="copy-btn" data-copy="${esc(item.vin)}" data-copy-label="VIN" title="Copy VIN" aria-label="Copy VIN">⧉</button>`
      : "—"],
    // A mileage of 0 with a broken odometer is a recorded fact, not a blank.
    ["Mileage", item.odometer_broken
      ? `<span title="Recorded as unreadable at intake">Odometer broken</span>`
      : item.mileage ? item.mileage.toLocaleString() : "—"],
    // Same reason as the VIN above, minus the copy button: nobody retypes a
    // plate into a catalogue, they read it off a car and type it into search.
    ["Plate", esc(plateTag(item) || "—")],
    ["Year/Make/Model", esc([item.year, item.make, item.model].filter(Boolean).join(" "))],
    ["Trim", esc(item.trim || "—")],
    // Decoding a VIN fills this in and the printed ticket has always shown it,
    // but nothing on screen did -- so the answer to "what engine is in it",
    // which is what gets asked before every parts call, was sitting in the
    // record with no way to read it short of opening the edit dialog.
    ["Engine", esc(item.engine || "—")],
    ["Color", esc(item.color || "—")],
  ];
  // The day the car landed, on the card rather than buried in the edit
  // dialog: it is what the board's Age column counts from, so a wrong one is
  // only ever noticed if somebody can see it. Recon only -- a we-owe car has
  // no arrival on this lot to record.
  if (segment === "recon") {
    rows.push(["Arrived on the lot", item.acquisition_date
      ? esc(item.acquisition_date)
      : `<span title="Age counts from the day this car was written up instead">Not recorded</span>`]);
  }
  // What the lot paid isn't entered here any more -- Walt keeps that figure
  // and this app answers "what did we spend fixing it". Cars carried over from
  // when it *was* entered still show theirs rather than silently losing it.
  if (lifetime?.purchase_price) rows.push(["Purchase price", money(lifetime.purchase_price)]);
  $("#vd-vehicle-info-summary").innerHTML = rows.map(([label, value]) => `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value">${value}</span></div>`).join("");
}

// Customer Info card -- we-owe only (recon vehicles are shop-owned inventory
// with no real customer). Mirrors the Vehicle Info card: a compact read-only
// summary with an Edit button that opens the customer dialog.
function renderCustomerInfoSummary() {
  const { item } = state.detail;
  const cityLine = [item.customer_city, [item.customer_state, item.customer_postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const address = [item.customer_address_line1, item.customer_address_line2, cityLine].filter(Boolean).join(", ");
  const rows = [
    ["Name", esc(item.customer_name || "—")],
    ["Phone", item.customer_phone ? `<a href="tel:${esc(phoneDigits(item.customer_phone) || item.customer_phone)}">${esc(fmtPhone(item.customer_phone))}</a>` : "—"],
    ["Email", item.customer_email ? esc(item.customer_email) : "—"],
    ["Address", esc(address || "—")],
  ];
  $("#vd-customer-info-summary").innerHTML = rows.map(([label, value]) => `<div class="kv-row"><span class="kv-label">${label}</span><span class="kv-value">${value}</span></div>`).join("");
}

// Customer's Other Vehicles card (retail only). Each row jumps straight to
// that car's retail page; the pill answers the hop-or-not question ("2 ROs ·
// 1 open") before the click. The empty state still shows, because the card's
// other job is the + Add Vehicle button.
function renderOtherVehicles() {
  const { item } = state.detail;
  const box = $("#vd-other-vehicles");
  const others = item.other_vehicles || [];
  if (!others.length) {
    box.innerHTML = '<div class="cust-sub" style="padding:12px 16px">No other vehicles on file.</div>';
    return;
  }
  box.innerHTML = others.map((v) => {
    const ros = v.order_count
      ? `${v.order_count} RO${v.order_count === 1 ? "" : "s"}${v.open_orders ? ` · ${v.open_orders} open` : ""}`
      : "no ROs yet";
    const meta = [v.plate ? `${v.plate}${v.plate_state ? ` (${v.plate_state})` : ""}` : "", v.vin]
      .map((s) => String(s || "").trim()).filter(Boolean).join(" · ");
    return `
      <div class="mini-item clickable" data-id="${v.id}" title="Open this vehicle's page">
        <div class="mi-title">
          <span>${esc([v.year, v.make, v.model].filter(Boolean).join(" "))}</span>
          <span class="pill ${v.open_orders ? "" : "pill-inactive"}" style="font-size:9.5px">${esc(ros)}</span>
        </div>
        ${meta ? `<div class="mi-meta">${esc(meta)}</div>` : ""}
      </div>`;
  }).join("");
  $$(".mini-item.clickable", box).forEach((row) => {
    row.addEventListener("click", () => openVehicleDetail("retail", Number(row.dataset.id)));
  });
}

/* ---------- address field validation (customer editor) ---------- */
// The 50 states plus DC and the USPS-served territories/military codes.
// State and ZIP are optional on a customer record, but a filled-in value has
// to be real -- "Michigan" or "482O3" saved silently before this existed.
export const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP","AA","AE","AP",
]);

export function focusInvalidField(el) {
  el.focus();
  if (typeof el.select === "function") el.select();
}

/* ---------- phone numbers (shared) ---------- */
// Phones are typed in two places (the customer editor and the we-owe
// new-customer form) and shown in several more (customer info card, printed
// ticket, tel: links). One set of helpers so they all agree: inputs mask to
// (313) 555-0142 as you type, saved values must be a real 10-digit number or
// empty, display always shows the formatted form, and tel: links get bare
// digits so the phone app doesn't choke on punctuation.

export function phoneDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1); // +1 country code
  return d;
}

// Display formatting: pretty-print a stored value if it's a 10-digit US
// number, otherwise show whatever was stored (old records predate the mask).
export function fmtPhone(raw) {
  const d = phoneDigits(raw);
  if (d.length !== 10) return String(raw || "").trim();
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// Progressive mask for typing: digits land formatted, everything else never
// lands, capped at 10 digits. Same normalize-as-you-type treatment the
// State/ZIP fields get.
function phoneMask(raw) {
  const d = phoneDigits(raw).slice(0, 10);
  if (!d) return "";
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function wirePhoneInput(el) {
  el.addEventListener("input", () => { el.value = phoneMask(el.value); });
}

// Submit-time check for a masked field: empty is fine (phone is optional),
// anything else has to be all 10 digits. Toasts, focuses, returns false on a
// partial number so callers can bail before saving. A value identical to
// what the dialog loaded (el.dataset.loadedValue) also passes: records from
// before the mask can hold a 7-digit local number, and an advisor opening
// the editor to fix the *address* shouldn't be held hostage by it.
export function phoneFieldOk(el) {
  const value = el.value.trim();
  if (!value || el.value === (el.dataset.loadedValue || "")) return true;
  if (phoneDigits(value).length !== 10) {
    toast("Phone needs all 10 digits, like (313) 555-0142", true);
    focusInvalidField(el);
    return false;
  }
  return true;
}

// Email gets the same deal as phone: loose on purpose (name@domain.tld shape,
// no spaces -- real validation is the mail bouncing; this only catches a
// street address pasted into the wrong box), and keep-legacy via
// dataset.loadedValue so a pre-validation record doesn't fail saving on an
// unrelated edit until someone actually touches the email field.
export function emailFieldOk(el) {
  const value = el.value.trim();
  if (!value || el.value === (el.dataset.loadedValue || "")) return true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    toast("That email doesn't look right — needs a name@domain.com shape", true);
    focusInvalidField(el);
    return false;
  }
  return true;
}

/* ---------- address autocomplete (customer editor) ---------- */
// As-you-type suggestions from /api/address-suggest (a server-side proxy to a
// keyless geocoder). Picking a suggestion fills Street/City/State/ZIP. Every
// failure path -- offline, empty result, request outraced by more typing --
// just hides the dropdown, leaving the fields as plain manual entry.
let addressSuggestTimer = null;
let addressAutocompleteReady = false;

export function hideAddressSuggestions() {
  const box = $("#customer-edit-address-suggestions");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

export function setupAddressAutocomplete() {
  if (addressAutocompleteReady) return;
  addressAutocompleteReady = true;
  const input = $("#customer-edit-address1");
  const box = $("#customer-edit-address-suggestions");
  if (!input || !box) return;
  let results = [];

  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length < 3) return hideAddressSuggestions();
    let found;
    try {
      found = await get(`/api/address-suggest?q=${encodeURIComponent(q)}`);
    } catch {
      return hideAddressSuggestions();
    }
    // The user may have cleared the field or tabbed away while the request
    // was in flight -- don't pop a stale dropdown back open.
    if (!Array.isArray(found) || !found.length || document.activeElement !== input) {
      return hideAddressSuggestions();
    }
    results = found;
    box.innerHTML = results.map((r, i) => `<button type="button" class="addr-suggestion" data-i="${i}">${esc(r.label)}</button>`).join("");
    box.hidden = false;
  };

  input.addEventListener("input", () => {
    clearTimeout(addressSuggestTimer);
    addressSuggestTimer = setTimeout(runSearch, 250);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") hideAddressSuggestions(); });
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".addr-suggestion");
    if (!btn) return;
    const r = results[Number(btn.dataset.i)];
    if (!r) return;
    input.value = r.line1 || input.value;
    if (r.city) $("#customer-edit-city").value = r.city;
    if (r.state) $("#customer-edit-state").value = r.state;
    if (r.postal_code) $("#customer-edit-postal").value = r.postal_code;
    hideAddressSuggestions();
    $("#customer-edit-address2").focus();
  });
  // A click anywhere outside the street field + list dismisses it.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".addr-autocomplete")) hideAddressSuggestions();
  });
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
      <div class="mi-meta">${esc(actorLabel(p.actor) ? `${actorLabel(p.actor)} · ` : "")}${fmtDate(p.created_at)}</div>
    </div>
  `).join("") : emptyState({ icon: "invoice", title: "No deposits recorded", hint: "Money taken from the customer up front is recorded here and counted against what they owe.", compact: true });
  $$(".deposit-rm", $("#vd-deposits-list")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await confirmAction({
        eyebrow: "DEPOSIT",
        title: "Remove this deposit?",
        body: "The amount stops counting against what the customer owes.",
        confirmLabel: "Remove",
        danger: true,
      }))) return;
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
  // Retail vehicles don't archive: the customer drives the car home and the
  // RO's own Complete status is the end of the story. No History membership
  // means neither button; everything below still runs (archived is always
  // false for retail) so shared controls get re-enabled uniformly.
  const retail = state.detail.segment === "retail";
  $("#vd-archived-banner").style.display = archived ? "" : "none";
  $("#vd-archive-vehicle").style.display = archived || retail ? "none" : "";
  $("#vd-reopen-vehicle").style.display = archived && !retail ? "" : "none";

  // These are static controls reused across renders (unlike the estimate
  // rows, which are rebuilt fresh every time) -- reopening must explicitly
  // re-enable them, not just skip re-disabling, or they'd stay disabled
  // forever once archived once.
  //
  // Split by what each control actually writes to, because there are two
  // reasons a control here can't be used and they don't cover the same set.
  // Archiving a car locks everything on the page. Having no repair order
  // locks only the things that would be written *onto* a repair order --
  // the car's own record (VIN, mileage, the we-owe promise, deposits) is
  // still perfectly editable on a car nobody has written up yet, and is
  // often the only thing there is to edit.
  const ticketIds = [
    "vd-concern", "vd-concern-save",
    "vd-add-job", "vd-add-part", "vd-add-labor", "vd-order-parts",
    "vd-add-note", "vd-note-text", "vd-note-visibility",
    "vd-save-assignment", "vd-technician", "vd-advisor",
    "vd-save-timing", "vd-date-in", "vd-odometer", "vd-promised",
  ];
  const vehicleIds = [
    "vd-edit-vehicle", "vd-recon-info-save", "vd-decode-vin", "vd-recon-vin", "vd-recon-mileage", "vd-recon-year",
    "vd-recon-make", "vd-recon-model", "vd-recon-trim", "vd-recon-color",
    "vd-recon-plate", "vd-recon-plate-state", "vd-recon-acquired",
    "vd-edit-customer", "vd-we-owe-save", "vd-we-owe-description", "vd-we-owe-category", "vd-we-owe-target", "vd-we-owe-status",
    "vd-take-payment", "vd-deposit-add", "vd-deposit-amount", "vd-deposit-method", "vd-deposit-note",
  ];
  // A control with no ticket behind it used to stay live and answer a click
  // with "Cannot read properties of null (reading 'id')" -- a programmer's
  // sentence on a screen an advisor uses. Disabled is the honest state.
  const noTicket = !state.detail.order;
  ticketIds.forEach((id) => { const el = $(`#${id}`); if (el) el.disabled = archived || noTicket; });
  vehicleIds.forEach((id) => { const el = $(`#${id}`); if (el) el.disabled = archived; });
  $$(".job-control", $("#vd-estimate-items")).forEach((el) => { el.disabled = archived; });
  // The check-over's controls are rebuilt each render like the job controls
  // above, so the archived lock is applied here the same way. An archived
  // car keeps showing what its walk-around found -- it just stops taking
  // answers.
  $$(".insp-control", $("#vd-checkover-card")).forEach((el) => { el.disabled = archived; });
  // Rebuilt on every render like the estimate rows, but the strip renders
  // before this runs, so the boxes still need switching off here -- an
  // archived car's ticket is frozen, and a supplier box that takes typing and
  // then answers with an error is worse than one that plainly won't.
  $$(".po-chip-vendor", $("#vd-po-strip")).forEach((el) => { el.disabled = archived; });
  // Same story for the stage steps: rebuilt each render, disabled here. An
  // archived car keeps showing where its ticket ended up -- the steps just
  // stop being pressable.
  $$(".stage-step", $("#vd-stage-strip")).forEach((el) => { el.disabled = archived || noTicket; });
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

/* The ticket's PO numbers, above the parts they cover.
   Three jobs. It shows the batches already out with a vendor (so a delivery
   can be matched to one at a glance); it says what the *next* number will be,
   because the moment an advisor needs a PO number is before the call, not
   after it; and it carries the box that records who the call went to. That
   last one is a plain input rather than a dialog on purpose -- it is typed
   with a vendor still on the phone, and anything heavier than a box that
   saves itself is how the supplier ends up never written down. */
function renderPoStrip(order) {
  const box = $("#vd-po-strip");
  if (!order) {
    box.innerHTML = "";
    return;
  }
  const pos = order.purchase_orders || [];
  const nextNumber = `R${order.ro_number}-${(pos.length ? pos[pos.length - 1].sequence : 0) + 1}`;
  if (!pos.length) {
    box.innerHTML = `<span class="po-strip-empty">No parts ordered yet. Next PO will be <strong>${esc(nextNumber)}</strong>.</span>`;
    return;
  }
  box.innerHTML = `<span class="po-strip-label">Purchase orders</span>` + pos.map((po) => {
    // Three states worth telling apart at a glance: a number taken but not
    // ordered against yet, parts still out at a vendor, and a batch fully
    // turned up.
    const done = po.line_count > 0 && po.received_count >= po.line_count;
    const spare = !po.line_count && !po.closed_at;
    const cls = spare ? "po-chip-unused" : done ? "po-chip-done" : "po-chip-open";
    const detail = !po.line_count
      ? "not used yet"
      : done
        ? `${po.line_count} part${po.line_count === 1 ? "" : "s"} · all in`
        : `${po.received_count} of ${po.line_count} in`;
    // Only a batch still waiting on parts nags for a supplier. On one that has
    // fully turned up the question has stopped mattering, and an empty box
    // shouting on every old PO would train people to ignore all of them.
    const wanted = !po.vendor_name && !done && po.line_count > 0;
    // The × only on a number nothing has been ordered against. Once a batch is
    // closed it is a vendor's paperwork, whatever happened to its lines since.
    return `<span class="po-chip ${cls}" data-po="${esc(po.number)}" data-po-id="${po.id}">
      <button type="button" class="po-chip-main" title="Click to highlight this batch's parts below">
        <span class="po-chip-number">${esc(po.number)}</span>
        <span class="po-chip-detail">${esc(detail)}</span>
      </button>
      <input class="po-chip-vendor${wanted ? " po-chip-vendor-wanted" : ""}" list="po-vendor-options"
             value="${esc(po.vendor_name || "")}" placeholder="who from?" autocomplete="off"
             data-po-id="${po.id}" data-was="${esc(po.vendor_name || "")}"
             aria-label="Supplier for purchase order ${esc(po.number)}"
             title="Who ${esc(po.number)} was ordered from — type a name and press Enter">
      ${spare ? `<span class="po-chip-drop" data-drop-po="${po.id}" title="Remove this unused PO number">×</span>` : ""}
    </span>`;
  }).join("") + `<span class="po-strip-next">Next: <strong>${esc(nextNumber)}</strong></span>`;
}

/* Everything on this page that belongs to the *ticket* rather than to the car,
   written from one place -- including the case where there is no ticket.

   A car with nothing written up yet is not an edge case. It is the whole "Not
   started" pile on the board: the cars that have sat longest, and the ones
   Walt asks about most. That case used to be handled by bailing out before
   this function ran, which hid the parts grid and left every *other*
   ticket-scoped panel still showing whatever the last car opened had put
   there -- its notes, its activity log, its date-in and its odometer. Open
   the Elantra, go back, open the Sorento, and the Sorento's page reported
   84,500 miles, a windshield note somebody typed about the Elantra, and a
   morning's worth of parts receipts against a car nobody had touched in
   twelve days. Every one of those is a number the app cannot stand behind.

   So a missing ticket is a state this renders, not a state it returns before
   reaching. Each panel below is handed the order and empties itself when
   there isn't one, which is also why a panel added later gets the same
   treatment for free instead of joining a list of resets somewhere else. */
/* The supplier boxes autocomplete against vendors the shop already uses, so
   the second order from the same yard is picked rather than retyped (and so
   it lands on the same vendor record the bill will). Fetched the first time
   somebody actually reaches for one -- opening a ticket is the commonest
   thing in the app and does not need to pay for a list most visits never
   touch. */
async function fillVendorOptions() {
  const list = $("#po-vendor-options");
  if (!list) return;
  if (!state.vendors.length) state.vendors = await get("/api/vendors").catch(() => []);
  list.innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}"></option>`).join("");
}

function renderOrderPanel() {
  const order = state.detail.order;
  // The short number is what gets said out loud and written on a vendor's
  // paperwork; the long one stays reachable on hover for anything filed under
  // it before this existed.
  // Set as its own line rather than folded into the eyebrow's caption
  // styling: this is the ticket's name, the thing written on the paper copy
  // and said down the phone, and at caption size in the faint grey a caption
  // gets it was the hardest number on the page to find.
  $("#vd-ro-number").innerHTML = order
    ? `<span class="ro-tag">RO ${esc(String(order.ro_number || "—"))}</span><span class="ro-long">${esc(order.number || "")}</span>`
    : `<span class="ro-none">No repair order</span>`;
  $("#vd-ro-number").title = order ? order.number : "";
  renderStatusCard(order);
  renderPoStrip(order);
  renderInspection(order);
  renderEstimate(order);
  renderNotes(order);
  renderActivity(order);
  renderAssignment(order);
  $("#vd-print-ticket").style.display = order ? "" : "none";
  // The lot card exists for cars that live on the lot -- recon and we-owe --
  // whether or not anyone has written a ticket yet. A retail customer's car
  // isn't parked out there waiting to be found, and a car filed to History
  // has left the lot; neither gets a windshield sheet.
  $("#vd-print-card").style.display =
    (state.detail.segment === "recon" || state.detail.segment === "we_owe") && !state.detail.item.archived_at
      ? "" : "none";
  // + Task survives a car with no ticket: a follow-up can name the car
  // itself, and a car nobody has written up is the most common thing to
  // want to leave a note about. Retail is the exception -- a customer's
  // own car has no lot record, so there is nothing to hang the note on.
  $("#vd-add-task").style.display = state.detail.segment === "retail" && !order ? "none" : "";
  $("#vd-void-order").style.display = order && !order.voided ? "" : "none";
  // Retail tickets have no lot record behind them, so there's nothing on the
  // other side for the cost to move onto -- only recon and we-owe can swap.
  const movable = order && !order.voided && (order.segment === "recon" || order.segment === "we_owe");
  $("#vd-move-segment").style.display = movable ? "" : "none";
}

function renderStatusCardBase(order) {
  const pill = $("#vd-status-pill");
  const strip = $("#vd-stage-strip");
  // No ticket, nothing to say about its status. The pill is emptied rather
  // than left reading the last car's -- drawer.js keys the assign control's
  // visibility off this text, so blanking it is what puts that control
  // away, and the save-state caption goes with it for the same reason.
  if (!order) {
    pill.className = "pill";
    pill.textContent = "";
    pill.hidden = true;
    if (strip) { strip.innerHTML = ""; strip.hidden = true; }
    $("#vd-concern").value = "";
    const saveState = $("#vd-estimate-save-state");
    if (saveState) { saveState.className = "save-state"; saveState.textContent = ""; }
    return;
  }
  pill.className = `pill ${order.voided ? "" : (STATUS_PILL_CLASS[order.status] || "")}`;
  pill.textContent = order.voided ? "Voided" : (STATUS_LABEL[order.status] || order.status);
  pill.hidden = false;
  renderStageStrip(order);
  $("#vd-concern").value = order.concern || "";
  sizeConcernBox();
}

/* The four stages of a ticket, drawn as the journey rather than offered as a
   dropdown. Every stage is a button: the ones already walked show a check,
   the current one is lit in the same colour the board pill uses, and pressing
   any other one moves the ticket there -- forward when the car moves along,
   backward when it was pressed too soon. A voided ticket has left the journey
   entirely, so the strip goes away and the header's grey tag says so. */
function renderStageStrip(order) {
  const strip = $("#vd-stage-strip");
  if (!strip) return;
  if (order.voided) { strip.innerHTML = ""; strip.hidden = true; return; }
  const cur = STATUS_OPTIONS.indexOf(order.status);
  const check = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>`;
  strip.innerHTML = STATUS_OPTIONS.map((s, i) => {
    const stage = i < cur ? "done" : i === cur ? "current" : "todo";
    const title = i === cur ? `The ticket is at ${STATUS_LABEL[s]}`
      : i < cur ? `Move the ticket back to ${STATUS_LABEL[s]}`
      : `Move the ticket to ${STATUS_LABEL[s]}`;
    const sep = i ? `<span class="stage-sep${i <= cur ? " walked" : ""}" aria-hidden="true"></span>` : "";
    return `${sep}<button type="button" class="stage-step ${stage}" data-status="${s}" role="radio"
      aria-checked="${i === cur}" title="${title}">
      <span class="stage-dot">${i < cur ? check : `<span class="stage-num">${i + 1}</span>`}</span>
      <span class="stage-name">${STATUS_LABEL[s]}</span>
    </button>`;
  }).join("");
  strip.hidden = false;
}

/* The concern strip is one line tall and grows to fit what's actually in it.
   Most concerns are a single sentence, and giving that sentence a five-line
   box was what pushed the repair list off the bottom of the screen -- but a
   long write-up still has to be readable without scrolling inside a box the
   size of a stamp. Capped so a pasted paragraph can't take the page over.
   scrollHeight is 0 in the jsdom harness (no layout), which leaves the
   CSS height alone rather than collapsing the field to nothing. */
function sizeConcernBox() {
  const box = $("#vd-concern");
  if (!box) return;
  box.style.height = "auto";
  if (!box.scrollHeight) return;
  box.style.height = `${Math.min(box.scrollHeight + 2, 180)}px`;
}

/* "Where did this part come from?" -- the question the parts grid could not
   answer. A supplier name is what an advisor actually needs (who do I call
   about the wrong caliper); the invoice number is the paperwork behind it and
   goes second. Older lines received before the supplier was recorded still
   have their invoice number, so they show that rather than nothing. */
/* The PO number a part went out on, on the part's own row.
   The batch strip above the grid answers "what's outstanding"; this answers
   the question asked at the receiving bench with a box in one hand and a
   vendor's packing slip in the other -- which of these lines is this delivery?
   Without it that question could only be answered by reading part numbers. */
function poBadgeHtml(item) {
  if (!item.po_number) return "";
  return `<span class="po-badge" title="Ordered on purchase order ${esc(item.po_number)}">${esc(item.po_number)}</span>`;
}

function receivedSourceHtml(item) {
  const vendor = item.received_vendor_name;
  const invoice = item.received_invoice_number;
  if (!vendor && !invoice) return "";
  return `<span class="received-from">${vendor ? `<span class="rf-vendor">${esc(vendor)}</span>` : ""}${
    invoice ? `<span class="rf-invoice">${esc(invoice)}</span>` : ""
  }</span>`;
}

/* What the line was written down at, before any vendor invoice touched it.
   unit_cost is overwritten with the price the invoice actually said when a
   part is received, so it is the wrong figure to quote against -- comparing
   it to itself is why the ticket could only ever say "On quote". Lines from
   before the quote was kept separately have no quoted_unit_cost and fall
   back to unit_cost, which is the answer they have always given. */
function quotedUnitCost(item) {
  return item.quoted_unit_cost ?? item.unit_cost ?? 0;
}

// Only worth saying when the bill and the estimate actually disagree; on an
// ordinary line this would just be the same number printed twice.
function quoteDiffersFromCost(item) {
  return item.quoted_unit_cost != null && Math.abs(item.quoted_unit_cost - (item.unit_cost ?? 0)) >= 0.005;
}

// A returned line reads $0 and is out of every total, so there is nothing for
// a quote to disagree with.
function showQuoteNote(item) {
  return quoteDiffersFromCost(item) && !item.part_returned;
}

function receivedFromTitle(item) {
  const vendor = item.received_vendor_name;
  const invoice = item.received_invoice_number;
  if (vendor && invoice) return `Received from ${vendor} on invoice ${invoice}`;
  if (vendor) return `Received from ${vendor}`;
  if (invoice) return `Received on invoice ${invoice}`;
  return "Received";
}

/* Group a ticket's lines by kind for display -- Parts, Labor, Fees, and then
   anything else actually present.

   Exhaustive rather than a fixed list of three, because vendor-invoice ingest
   writes kind="credit" lines that nobody picks by hand. A grid that only knew
   the three simply left them out: on a ticket grouped into jobs, a $60 vendor
   credit was subtracted from the total with no line on screen to explain
   where it had come from. The printed ticket already worked this way; the
   screen it was printed from did not. */
function kindGroupsOf(items) {
  const extra = [...new Set(items.map((i) => i.kind).filter((k) => !KIND_GROUP_ORDER.includes(k)))];
  return [...KIND_GROUP_ORDER, ...extra]
    .map((kind) => ({ kind, kindItems: items.filter((i) => i.kind === kind) }))
    .filter((group) => group.kindItems.length);
}

/* Three readings of one number, so a column of line totals can be scanned
   rather than read: real money in full ink, a line that costs nothing dimmed
   out of the way, and a vendor credit in the same green the rest of the app
   uses for money coming back. */
function lineTotalClass(total) {
  return `ei-line-total${total < 0 ? " credit" : total ? "" : " zero"}`;
}

/* Rewrite every row's line total from what is currently in its boxes. Shares
   rowAsEstimateItem with the ticket and job-subtotal figures, so the column
   and the numbers it adds up to always move together -- including mid-keystroke,
   before anything has been saved. */
function writeLineTotals(box) {
  for (const row of $$(".part-row:not(.head)", box)) {
    const el = $(".ei-line-total", row);
    if (!el) continue;
    const total = lineTotal(rowAsEstimateItem(row));
    el.textContent = money(total);
    el.className = lineTotalClass(total);
  }
}

function renderEstimate(order) {
  const box = $("#vd-estimate-items");
  // The grid lives inside the panel that gets hidden with no ticket, so a
  // stale one is invisible rather than wrong -- but it is still the last
  // car's parts sitting in the page, one un-hide away from being read as
  // this car's, and the totals underneath it are written from it.
  if (!order) {
    box.classList.remove("has-jobs");
    box.innerHTML = "";
    applyTicketTotals(0, 0, []);
    return;
  }
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  box.classList.toggle("has-jobs", jobs.length > 0);

  const jobOptionsHtml = (selectedId) => `<option value="" ${!selectedId ? "selected" : ""}>General</option>` +
    jobs.map((j) => `<option value="${j.id}" ${selectedId === j.id ? "selected" : ""}>${esc(j.title)}</option>`).join("");

  // Every field sits in its own .pr-cell wrapper carrying a data-label. Wide
  // enough and the wrappers are just grid tracks under a column header; once
  // the Parts & Labor container gets narrow (a small window, or the details
  // drawer open beside it) the same markup reflows into a stacked card and
  // the data-label becomes the field's visible caption. Before this, the row
  // was a hardcoded 11-column grid whose header was display:none -- so Qty,
  // Cost and Core were unlabelled boxes that squeezed to a few pixels wide.
  // data-label is what the narrow-screen layout prints above each field
  // (.pr-cell::before). An empty cell must not carry one, or a labor line
  // shows a "Part #"/"Core" caption with no field under it.
  // `extra` is for a cell that needs a modifier of its own -- currently only
  // the cost cell, which stacks a second line under the price on a part the
  // vendor billed at something other than its estimate.
  const cell = (cls, label, inner, extra = "") =>
    `<div class="pr-cell pr-${cls}${extra ? ` ${extra}` : ""}${inner ? "" : " pr-spacer"}"${label && inner ? ` data-label="${label}"` : ""}>${inner}</div>`;

  const rowHtml = (item, i) => {
    const remaining = (item.quantity ?? 0) - (item.received_quantity ?? 0);
    const receivable = item.kind === "part" && item.id && remaining > 0.001;
    const isPart = item.kind === "part";
    const L = fieldLabels(item.kind);
    return `
    <div class="part-row" draggable="true" data-index="${i}" data-id="${item.id || ""}" data-source="${item.source || "manual"}" data-received-quantity="${item.received_quantity ?? 0}" data-received-cost="${item.received_cost ?? ""}" data-billed-unit-cost="${item.unit_cost ?? ""}" data-quoted-unit-cost="${item.quoted_unit_cost ?? ""}" data-part-returned="${isReturnedPart(item) ? "1" : "0"}" data-po="${esc(item.po_number || "")}">
      ${cell("handle", "", `<span class="row-drag-handle" title="Drag to reorder">⋮⋮</span>`)}
      ${cell("check", "", receivable ? `<input type="checkbox" class="ei-receive-check" data-id="${item.id}" title="Select to receive against a vendor invoice">` : "")}
      ${cell("kind", "Kind", `<select class="ei-kind">
        <option value="part" ${item.kind === "part" ? "selected" : ""}>Part</option>
        <option value="labor" ${item.kind === "labor" ? "selected" : ""}>Labor</option>
        <option value="fee" ${item.kind === "fee" ? "selected" : ""}>Fee</option>
        ${/* Vendor invoice ingest writes kind="credit" lines (a returned part,
             a refunded core). Nobody picks Credit by hand, so it stays out of
             the dropdown -- but the option has to EXIST, because a <select>
             holding a value with no matching option reports "" and
             collectEstimateItems resends every row on every autosave. That
             empty kind failed validation, so a single credit on a ticket made
             the whole estimate unsaveable with a 422 naming a field the
             advisor never touched. */ ""}
        <option value="credit" hidden ${item.kind === "credit" ? "selected" : ""}>Credit</option>
      </select>`)}
      ${cell("desc", "Description", `<input class="ei-desc" value="${esc(item.description || "")}" placeholder="Description">`)}
      ${cell("part", L.part, `<input class="ei-part" value="${esc(item.part_number || "")}" placeholder="Part #"${isPart ? "" : " hidden"}>`)}
      ${cell("qty", L.qty, `<input class="ei-qty" type="number" min="0.01" step="0.01" value="${item.quantity ?? 1}"${item.kind === "labor" ? ` title="Hours"` : ""}>`)}
      ${/* A line billed at something other than what it was quoted at says so
            right here, next to the price that changed. The receive dialog
            already showed this while the invoice was being keyed in; without
            it on the row, the difference disappeared the moment the dialog
            closed and nobody could see afterwards which part had moved. */""}
      ${cell("cost", L.cost, (item.part_returned
        ? `<input class="ei-cost" type="number" value="0" disabled title="Returned to the vendor -- no longer counted" data-real-cost="${item.unit_cost ?? 0}">`
        : `<input class="ei-cost" type="number" min="0" step="0.01" value="${item.unit_cost ?? 0}"${item.kind === "labor" ? ` title="Hourly rate"` : ""}>`)
        + (showQuoteNote(item)
          ? `<span class="ei-quote-note ${item.unit_cost > item.quoted_unit_cost ? "over" : "under"}" title="This line was written up at ${money(item.quoted_unit_cost)} each; the vendor billed ${money(item.unit_cost)}">Was ${money(item.quoted_unit_cost)}</span>`
          : ""), showQuoteNote(item) ? "has-quote-note" : "")}
      ${cell("core", L.core, item.kind === "part"
        ? `<label class="core-toggle" title="Tick only if this part carries a core deposit the vendor owes back">
             <input type="checkbox" class="ei-core-on" ${(item.core_charge ?? 0) > 0 ? "checked" : ""} aria-label="This part has a core charge">
             <span>Core</span>
           </label>
           <input class="ei-core" type="number" min="0" step="0.01" placeholder="0.00" title="Core deposit owed back from the vendor" value="${item.core_charge ?? 0}" ${(item.core_charge ?? 0) > 0 ? "" : "hidden"}>`
        : "")}
      ${/* Quantity times cost, worked out on the row instead of in somebody's
            head. The printed ticket has carried this column all along; the
            screen it gets printed from did not, so the one place the shop
            actually reads a ticket -- on a monitor, all day -- was the one
            place that made you do the arithmetic. Read-only on purpose:
            everything else on the row is typed, this is the row's answer.
            lineTotal() is the same definition the job subtotals and the
            ticket's own total use, so a column of these adds up to the
            figure underneath it. */""}
      ${cell("total", "Line total", `<span class="${lineTotalClass(lineTotal(item))}">${money(lineTotal(item))}</span>`)}
      ${jobs.length ? cell("job", "Job", `<select class="ei-job">${jobOptionsHtml(item.job_id ?? null)}</select>`) : ""}
      ${/* Where the part came from, on the ticket itself. It used to show the
            invoice number alone -- "Received (WP-55123)" -- which is the one
            thing an advisor holding the part in his hand already can't use.
            The supplier's name is the answer to "who do I call about this",
            and the invoice number rides along underneath it. */""}
      ${cell("status", "Status", item.id
        ? (item.status === "received"
            ? `<span class="status-cell">
                 <span class="status-pill ${item.part_returned ? "sp-returned" : "sp-received"}" title="${esc(receivedFromTitle(item))}">${item.part_returned ? "Returned" : "Received"}</span>
                 ${poBadgeHtml(item)}
                 ${receivedSourceHtml(item)}
                 ${item.kind === "part" ? `<button type="button" class="btn btn-ghost btn-xs part-return-btn" data-id="${item.id}" data-returned="${item.part_returned ? 1 : 0}" title="${item.part_returned ? "Undo -- this part was not actually sent back" : "Send this part back to the vendor"}">${item.part_returned ? "Undo" : "Mark Returned"}</button>` : ""}
               </span>`
            : `<span class="status-cell">
                 <select class="ei-status status-pill sp-${item.status || "quoted"}" data-prev="${item.status || "quoted"}">
                   <option value="quoted" ${item.status === "quoted" ? "selected" : ""}>Quoted</option>
                   <option value="ordered" ${item.status === "ordered" ? "selected" : ""}>Ordered</option>
                 </select>
                 ${poBadgeHtml(item)}
               </span>`)
        : `<span class="status-pill sp-quoted">Saving…</span>`)}
      ${cell("move", "", item.id ? `<button type="button" class="row-move-btn" title="Move to a different ticket" data-id="${item.id}" data-desc="${esc(item.description || "")}">⇄</button>` : "")}
      ${cell("remove", "", `<button type="button" class="rm-btn" title="Remove line">×</button>`)}
    </div>
  `;
  };

  // The header row doubles as each section's caption: inside a job's Parts
  // block the first column reads "Parts" instead of "Kind", so one thin row
  // does the work that a separate section label plus a hidden header row
  // used to do.
  // `kind` is set when this header captions a single-kind section (the job
  // view splits Parts and Labor into their own blocks), so Labor reads
  // "Hours / Rate" with no Part # or Core column at all. The flat mixed list
  // passes nothing and keeps the generic captions, since one header there has
  // to serve every kind at once.
  const headRow = (leadLabel = "Kind", extraClass = "", kind = null) => {
    const L = fieldLabels(kind);
    return `<div class="part-row head ${extraClass}">
    <span class="pr-cell pr-handle"></span>
    <span class="pr-cell pr-check"></span>
    <span class="pr-cell pr-kind">${esc(leadLabel)}</span>
    <span class="pr-cell pr-desc">Description</span>
    <span class="pr-cell pr-part">${esc(L.part)}</span>
    <span class="pr-cell pr-qty">${esc(L.qty)}</span>
    <span class="pr-cell pr-cost">${esc(L.cost)}</span>
    <span class="pr-cell pr-core">${esc(L.core)}</span>
    <span class="pr-cell pr-total">Line total</span>
    ${jobs.length ? `<span class="pr-cell pr-job">Job</span>` : ""}
    <span class="pr-cell pr-status">Status</span>
    <span class="pr-cell pr-move"></span>
    <span class="pr-cell pr-remove"></span>
  </div>`;
  };

  if (!jobs.length) {
    // Unchanged flat list -- grouping only appears once a job exists, so the
    // common/simple ticket looks exactly as clean as it always has.
    // The .ei-empty wrapper is load-bearing -- adding a line looks for it by
    // that class and removes it rather than re-rendering the whole list.
    box.innerHTML = (items.length ? headRow("Kind", "head-flat") : "") + (items.length ? items.map(rowHtml).join("") : `<div class="ei-empty">${emptyState({
      icon: "invoice",
      title: "No parts or labor yet",
      hint: "Add a part or labor line, or start with ＋ Add Job to group this ticket's work by repair.",
    })}</div>`);
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    // How far through the car we are, in one line, above the work itself.
    // The ticket's own status is a single flag for the whole car and cannot
    // say this; without it a ticket with four repairs looked identical
    // whether three were finished or none were.
    const doneCount = jobs.filter((j) => j.completed_at).length;
    // The same count, plus a bar of it. The sentence has to be read; the bar
    // is answerable from across the desk, which is how this line actually
    // gets used when somebody asks how far along a car is.
    const donePct = Math.round((doneCount / jobs.length) * 100);
    // The outline under the count: one chip per repair, in ticket order, that
    // scrolls to it. On a car with eight repairs the grid runs several screens
    // tall, and "where's the windshield on this ticket" was a scroll-and-scan
    // -- the chip is the answer at the door of the ticket. A finished repair's
    // chip is struck through the same way its group header is, so the row of
    // chips is also "what's left" at a glance. One repair gets no outline:
    // there is nowhere else to jump to. General only earns a chip when it
    // actually holds lines -- an empty leftovers bucket is not a destination.
    // These are navigation, not edits, so no job-control class: they stay
    // alive on an archived read-only ticket.
    const jumpChip = (bucket, done) => `<button type="button" class="job-jump" data-jump-job="${bucket.id ?? ""}" title="Jump to ${esc(bucket.title)}">
        ${done ? `<span class="job-jump-tick" aria-hidden="true">✓</span>` : ""}<span class="job-jump-title${done ? " jump-done" : ""}">${esc(bucket.title)}</span>
      </button>`;
    const generalHasLines = items.some((i) => (i.job_id ?? null) === null);
    const outline = jobs.length < 2 ? "" : `<div class="job-outline">
      ${jobs.map((j) => jumpChip(j, !!j.completed_at)).join("")}
      ${generalHasLines ? jumpChip({ id: null, title: "General" }, false) : ""}
    </div>`;
    const progress = `<div class="job-progress${doneCount === jobs.length ? " all-done" : ""}">
      <div class="job-progress-line">
        <span class="job-progress-text">${
          doneCount === jobs.length
            ? `All ${jobs.length} repair${jobs.length === 1 ? "" : "s"} finished`
            : `${doneCount} of ${jobs.length} repair${jobs.length === 1 ? "" : "s"} finished`
        }</span>
        ${/* Decoration for the sentence beside it, so it is hidden from screen
             readers rather than read out as a second, wordless progress bar. */""}
        <span class="job-progress-track" aria-hidden="true"><span class="job-progress-fill" style="width: ${donePct}%"></span></span>
      </div>
      ${outline}
    </div>`;
    box.innerHTML = progress + buckets.map((bucket) => {
      const bucketItems = items.filter((i) => (i.job_id ?? null) === bucket.id);
      const isGeneral = bucket.id === null;
      const jobSubtotal = ticketTotal(bucketItems);
      // Parts and labor render as their own mini-sections within the job
      // (Tekmetric-style) rather than one interleaved list, so it's obvious
      // at a glance which lines are parts vs labor for this job -- not just
      // which job a line belongs to.
      const kindGroups = kindGroupsOf(bucketItems);
      const jobDone = !isGeneral && !!bucket.completed_at;
      return `
        <div class="job-group${jobDone ? " job-done" : ""}" data-job-id="${bucket.id ?? ""}">
          <div class="job-group-head">
            ${/* One click is the whole interaction, on purpose: this gets
                 ticked with a part in the other hand, and anything that
                 needed a dialog would simply not get done on a busy morning.
                 General has no checkbox -- it is the ungrouped leftovers, not
                 a repair somebody can finish. */""}
            ${/* "by Unspecified" is worse than saying nothing: that's the
                 placeholder the Working-as picker uses when nobody has
                 chosen a name, not somebody's answer. byActor knows the whole
                 family of those -- this used to name only that one and let
                 "Finished by ui" through. */""}
            ${isGeneral ? "" : `<label class="job-done-toggle" title="${bucket.completed_at ? `Finished${esc(byActor(bucket.completed_by))} — click to reopen` : "Tick when this repair is finished"}">
              ${/* job-control rides on the input, not the label: that's the
                   class the archived-vehicle pass disables, and disabling a
                   <label> does nothing at all. */""}
              <input type="checkbox" class="ei-job-done job-control" data-job-id="${bucket.id}" ${jobDone ? "checked" : ""} aria-label="${esc(bucket.title)} is finished">
              <span>Done</span>
            </label>`}
            <span class="job-group-title">${esc(bucket.title)}</span>
            ${bucketItems.length ? `<span class="job-group-subtotal">${money(jobSubtotal)}</span>` : ""}
            ${isGeneral ? "" : `
              <select class="ei-job-tech job-control" data-job-id="${bucket.id}">
                ${staffOptions({ roles: ["technician"], selectedId: bucket.technician_id, selectedName: bucket.technician_name, blankLabel: "Use ticket default" })}
              </select>
              <button type="button" class="job-control job-icon-btn job-edit" data-job-id="${bucket.id}" title="Rename job">✎</button>
              <button type="button" class="job-control job-icon-btn job-delete" data-job-id="${bucket.id}" title="Delete job">×</button>
            `}
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="part">＋ Part</button>
            <button type="button" class="job-control job-mini-add" data-job-id="${bucket.id ?? ""}" data-kind="labor">＋ Labor</button>
          </div>
          ${kindGroups.length ? kindGroups.map((g) => `
            <div class="kind-subgroup" data-kind="${g.kind}">
              ${headRow(KIND_GROUP_LABEL[g.kind] || g.kind, "", g.kind)}
              ${g.kindItems.map(rowHtml).join("")}
            </div>
          `).join("") : `<div class="ei-empty">${emptyState({ icon: "invoice", title: "No lines in this job yet", compact: true })}</div>`}
        </div>
      `;
    }).join("");
  }

  // No listeners are bound here. #vd-estimate-items carries one delegated set
  // of handlers, wired once at startup by wireEstimateGrid(), so a re-render
  // costs exactly one innerHTML swap -- it used to cost twelve
  // addEventListener calls per row plus three more per job, every time any
  // single field changed.
  $$(".part-row:not(.head)", box).forEach(syncRowKindFields);
  updateReceiveButtonState();
  renderEstimateTotals(order);
  syncClipCues();
  lastEstimateShape = estimateShape(order);
}

/* ---------- saying so when a field is holding more than it shows ----------
   The quiet-fields rule (styles.css) makes this grid read as a printed sheet,
   and a printed line that stops flush at a column edge reads as complete: on
   a 1366px shop screen "USED-COND-SPR-19-PNP" showed as "USED-COND-SPR-1",
   which is a different part number, with nothing to say so. Description and
   Part # are the two columns where a silent cut changes what the line SAYS
   (a number column that runs out of room clips digits the totals would
   contradict; these two have no cross-check). So any of those inputs whose
   text genuinely overruns its box gets .is-clipped -- the stylesheet fades
   the text out at the edge instead of cutting it clean -- and carries the
   full text as its tooltip. Focusing the field scrolls it like any input,
   so the fade lifts there (also styles.css).
   Class + title are re-derived on render, on typing in either column, and
   when the grid's own width changes (window, details drawer -- one observer
   on the box catches both, wired in wireEstimateGrid). In jsdom every
   scrollWidth is 0, so this is inert there by construction. */
function syncClipCue(input) {
  const clipped = input.scrollWidth > input.clientWidth + 1;
  input.classList.toggle("is-clipped", clipped);
  // Tooltip only while it earns its place -- titles that repeat what is
  // already fully visible are hover noise on every line of the sheet.
  if (clipped) input.title = input.value;
  else input.removeAttribute("title");
}
function syncClipCues() {
  $$(".ei-desc, .ei-part", $("#vd-estimate-items")).forEach(syncClipCue);
}

function updateReceiveButtonState() {
  const checked = $$(".ei-receive-check:checked", $("#vd-estimate-items"));
  const btn = $("#vd-receive-parts");
  btn.disabled = checked.length === 0;
  // Say how many -- on a 20-line estimate you should know what you're about
  // to post before the dialog opens.
  btn.textContent = checked.length ? `Receive ${checked.length} Line${checked.length === 1 ? "" : "s"}` : "Receive Selected";
}

/* ---------- closing a ticket without losing what it cost ----------

   The parts get picked up at the counter and thrown on the car; marking them
   received in the app is a separate step, and on a busy morning it is the
   step that gets skipped. Nothing used to ask. The ticket closed, the car
   dropped to READY, and its Cost read $0.00 for a car that had just had four
   tires put on it -- the board says so afterwards, and so does the Lot sheet,
   but by then the invoice is in a pile and nobody remembers what it said.

   Closing the ticket is the last moment anyone is looking at that car's
   parts with the paperwork still in reach, so that is where the app asks.
   Three answers, because there are genuinely three: receive them now (the
   normal case -- the parts are on the car), close anyway (the part got
   cancelled, or the bill really hasn't turned up), or back out. Escape and
   the backdrop mean back out, never "close anyway"; see confirm.js.

   Nothing here blocks anything. "Close Anyway" is one click and the ticket
   closes exactly as it always did. */

// The names of the parts, so the question is about something recognisable
// rather than a count. Three of them fits the dialog; past that it counts.
const CLOSEOUT_NAME_LIMIT = 3;
function missingPartsSentence(lines, total) {
  const names = lines.slice(0, CLOSEOUT_NAME_LIMIT).map((i) => (i.description || "").trim() || "no description");
  const rest = lines.length - names.length;
  return `${money(total)} — ${names.join(", ")}${rest ? ` and ${rest} more` : ""}.`;
}

/* Returns true to go ahead and close the ticket.
   False means leave it exactly where it is -- which includes the case where
   the receive dialog has just been opened, because posting that invoice is
   what closes the ticket (see state.afterReceive). */
async function confirmTicketCloseout(order) {
  const items = order?.estimate?.items || [];
  const missing = unreceivedPartLines(items);
  if (!missing.length) return true;
  const many = missing.length !== 1;
  const choice = await confirmAction({
    eyebrow: "PARTS",
    title: `${missing.length} part${many ? "s" : ""} on this ticket ${many ? "were" : "was"} never marked received`,
    body: `${missingPartsSentence(missing, unreceivedPartTotal(items))}`
      + ` Close the ticket now and that money stays out of what this car cost.`,
    confirmLabel: "Receive Them Now",
    altLabel: "Close Anyway",
  });
  if (choice === "alt") return true;
  if (choice === true) openCloseoutReceive(missing);
  return false;
}

// Tick exactly those lines in the grid and hand them to the dialog that
// already knows how to price and post them -- one flow for receiving, not a
// second one that could drift from it.
function openCloseoutReceive(missing) {
  const wanted = new Set(missing.map((i) => String(i.id)));
  let ticked = 0;
  for (const cb of $$(".ei-receive-check", $("#vd-estimate-items"))) {
    cb.checked = wanted.has(String(cb.dataset.id));
    if (cb.checked) ticked += 1;
  }
  updateReceiveButtonState();
  // A line with no id yet (typed but never saved) has no checkbox to tick and
  // nothing the server could receive. Saying so beats an empty dialog.
  if (!ticked) return void toast("Those parts aren't saved yet — save the ticket, then receive them", true);
  // The invoice post is the real close-out, so the status change waits for it
  // rather than being asked for a second time afterwards.
  state.afterReceive = () => setTicketStatus("complete");
  openReceiveDialog();
}

// One writer for the status change, shared by the stage strip and by the
// close-out flow above, so a ticket closed either way lands identically.
async function setTicketStatus(status) {
  // The whole strip goes quiet while the change is in flight -- a second
  // press during the round-trip would race the first. Re-enabled by
  // renderDetailPermissions on the reload below; only the failure path has
  // to put the buttons back itself.
  const steps = $$(".stage-step", $("#vd-stage-strip"));
  steps.forEach((b) => { b.disabled = true; });
  try {
    await patch(`/api/orders/${state.detail.order.id}/status`, { status, actor: currentActor() });
    toast(`Status set to ${STATUS_LABEL[status]}`);
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
    steps.forEach((b) => { b.disabled = false; });
  }
}

/* What this car's tickets say was bought and never marked received.
   Summed off the vehicle's own ticket list rather than the one ticket on
   screen, because filing a car away is a statement about the whole car.
   Voided tickets are left out here for the same reason cost_rollup leaves
   them out of the money: that work never happened. */
function vehicleUnreceived(item) {
  const orders = ((item && item.orders) || []).filter((o) => !o.voided);
  return {
    cost: orders.reduce((sum, o) => sum + (Number(o.unreceived_cost) || 0), 0),
    parts: orders.reduce((sum, o) => sum + (Number(o.unreceived_parts) || 0), 0),
  };
}

/* The sentence appended to this car's Send-to-History confirmation. Returns
   "" when there is nothing to warn about, so the caller can append it
   unconditionally rather than branching around it. */
function missingReceiptWarning({ cost, parts }) {
  if (!parts || !cost) return "";
  return ` ${parts} part${parts === 1 ? " was" : "s were"} never marked received, so ${money(cost)} of what this car cost isn't counted.`;
}

// The arithmetic itself lives in estimate-money.js, which mirrors the
// server's cost_rollup -- so this card, the board's Cost column and the
// vehicle's own total can't tell three different stories about one ticket.
// Split out of renderEstimate because an in-place sync has to recompute
// these without touching the rows.
//
// A core deposit the vendor hasn't credited back yet is in both figures, on
// the same terms cost_rollup uses server-side: it is money the shop paid for
// this car and won't see again until the old unit goes back. Counting it in
// the quote as well as the actual is what stops a deposit from reading as
// short by that part the day it lands.
const coreOwing = (i) => i.kind === "part" && !i.part_returned && !i.core_return_invoice_number ? (i.core_charge || 0) : 0;
function renderEstimateTotals(order) {
  const items = order.estimate ? order.estimate.items : [];
  applyTicketTotals(ticketTotal(items), actualTotal(items), items);
}

/* Where the not-yet-landed money on a ticket stands. The spent figure is
   actualTotal's (parts at what the bills said, labor and fees as written);
   what this adds is the rest of the written-up money cut by whether anyone
   has actually ordered it. A partially received line splits by quantity:
   3 of 4 brake pads in leaves one pad's worth still on order. Credits are
   already inside the written-up total (lineTotal subtracts them); they're
   carried out separately here only so the card can say so in words. */
function moneyStanding(items) {
  let onOrder = 0, notOrdered = 0, credit = 0;
  for (const i of items || []) {
    if (i.kind === "credit") { credit += lineTotal(i); continue; }
    if (i.kind !== "part" || isReturnedPart(i)) continue;
    const q = Number(i.quantity) || 0;
    if (q <= 0) continue;
    const undelivered = Math.max(0, q - (Number(i.received_quantity) || 0));
    const remainder = lineTotal(i) * (undelivered / q);
    // A line still marked "received" with quantity outstanding has been
    // ordered by definition -- only a plain quote counts as not ordered.
    if ((i.status || "quoted") === "quoted") notOrdered += remainder;
    else onOrder += remainder;
  }
  return { onOrder, notOrdered, credit };
}

// One writer for everything the ticket's cost card is made of, shared by
// the post-save render and the live-typing recompute below, so the figures
// can never be written from different readings of the grid.
function applyTicketTotals(written, actual, items) {
  $("#vd-ticket-total").textContent = money(written);
  $("#vd-actual-cost").textContent = money(actual);

  const { onOrder, notOrdered, credit } = moneyStanding(items);
  $("#vd-money-on-order").textContent = money(onOrder);
  $("#vd-money-not-ordered").textContent = money(notOrdered);
  const creditRow = $("#vd-money-row-credit");
  creditRow.hidden = !credit;
  if (credit) $("#vd-money-credit").textContent = money(credit);

  // The rows stay put at $0 (dimmed, so the live money reads first); the bar
  // only exists while there is money to cut up. Segment widths are shares of
  // the three figures beside them, and a sliver under 2% is drawn at 2% --
  // a $12 part on a $2,000 ticket should still be findable on the bar.
  const spent = Math.max(0, actual);
  const total = spent + Math.max(0, onOrder) + Math.max(0, notOrdered);
  $("#vd-money-bar").hidden = total <= 0;
  const seg = (id, value) => {
    const el = $(id);
    const share = total > 0 ? Math.max(0, value) / total : 0;
    el.hidden = share <= 0;
    el.style.width = `${Math.max(2, share * 100).toFixed(2)}%`;
  };
  seg("#vd-money-seg-spent", spent);
  seg("#vd-money-seg-order", onOrder);
  seg("#vd-money-seg-quoted", notOrdered);
  $("#vd-money-row-spent").classList.toggle("zero", !spent);
  $("#vd-money-row-order").classList.toggle("zero", !(onOrder > 0));
  $("#vd-money-row-quoted").classList.toggle("zero", !(notOrdered > 0));
}

// Debounce handle for keystroke-driven autosave (wired in wireEstimateGrid).
let estimateTypingTimer = null;
function clearEstimateTypingTimer() {
  clearTimeout(estimateTypingTimer);
  estimateTypingTimer = null;
}

/* Read a grid row back as the same shape estimate-money.js takes, so the
   totals that follow each keystroke run through exactly the definition the
   saved ticket does. Kind matters here and used not to be read at all: a
   credit row was summed as an ordinary cost and pushed the ticket's quote
   UP by the size of the refund. */
function rowAsEstimateItem(row) {
  const num = (sel) => {
    const el = row.querySelector(sel);
    return el ? parseFloat(el.value || "0") || 0 : 0;
  };
  return {
    kind: row.querySelector(".ei-kind")?.value || "part",
    // Ordered-or-not feeds the money bar's amber/hollow split, nothing else.
    status: row.querySelector(".ei-status")?.value || "quoted",
    quantity: num(".ei-qty"),
    // A returned part's cost input renders as a disabled 0; part_returned
    // below is what actually drops it, so either reading gives the same
    // answer and neither depends on the other.
    unit_cost: num(".ei-cost"),
    // Until a line has been received the Cost box IS the written price, so
    // typing in it moves both figures. Once the part has landed, that box
    // holds what the vendor billed and the written price is frozen on the
    // row -- the same rule the server applies when it saves. Blank means the
    // line predates the column, and falls back to the cost box either way.
    quoted_unit_cost: (parseFloat(row.dataset.receivedQuantity || "0") || 0) > 0
        && row.dataset.quotedUnitCost !== "" && row.dataset.quotedUnitCost != null
      ? parseFloat(row.dataset.quotedUnitCost)
      : null,
    received_quantity: parseFloat(row.dataset.receivedQuantity || "0") || 0,
    // What the vendor has actually billed for the units that landed. Carried
    // on the row rather than recomputed, because on a line filled by two
    // deliveries at two prices no single cost box can reproduce it.
    //
    // Typing in the Cost box on a received line is a correction to the bill --
    // "every unit that landed was at this price" -- and the server re-prices
    // the received quantity when it saves. Mirrored here so the figure under
    // the cursor is the one that comes back, instead of jumping on save.
    received_cost: receivedCostFromRow(row, num(".ei-cost")),
    part_returned: row.dataset.partReturned === "1",
  };
}

/* The running received total to use while the grid is being typed in: the
   stored one normally, or the re-priced quantity once the cost box has moved
   off what the last invoice billed. Same 0.0005 tolerance the server compares
   with, so the two can't decide differently about the same edit. */
function receivedCostFromRow(row, typedCost) {
  const receivedQuantity = parseFloat(row.dataset.receivedQuantity || "0") || 0;
  if (receivedQuantity <= 0) return 0;
  const stored = parseFloat(row.dataset.receivedCost);
  const billed = parseFloat(row.dataset.billedUnitCost);
  if (!Number.isFinite(stored)) return receivedQuantity * typedCost;
  if (Number.isFinite(billed) && Math.abs(billed - typedCost) > 0.0005) return receivedQuantity * typedCost;
  return stored;
}

// The live-typing counterpart to renderEstimateTotals: same math, but read
// straight from the grid's inputs instead of state, so totals track each
// keystroke without waiting for the save round-trip.
function updateEstimateTotalsFromDom() {
  const box = $("#vd-estimate-items");
  if (!box) return;
  const rows = $$(".part-row:not(.head)", box).map(rowAsEstimateItem);
  applyTicketTotals(ticketTotal(rows), actualTotal(rows), rows);
  writeLineTotals(box);
  // Job subtotals live in each group's header; keep them moving too.
  for (const group of $$(".job-group", box)) {
    const label = group.querySelector(".job-group-subtotal");
    if (!label) continue;
    label.textContent = money(ticketTotal($$(".part-row:not(.head)", group).map(rowAsEstimateItem)));
  }
}

/* ---------- estimate grid: applying a save without redrawing ----------

   Every field on the grid autosaves on change, and the save round-trips the
   whole estimate. Re-rendering the grid from that response is correct but
   brutal: it blew away the DOM the advisor was standing in, so tabbing
   Description -> Qty put the caret in Qty, fired the save for Description,
   and then the response landed a few hundred ms later and yanked focus back
   out of Qty mid-keystroke. Half-typed numbers went missing that way.

   So: renderEstimate() records a *shape* signature -- everything that decides
   which elements exist and in what order. When a save comes back with the
   same shape (the overwhelmingly common case: you edited a value, not the
   structure), syncEstimateInPlace() writes the server's values into the
   existing controls, skipping whichever one has focus, and nothing is
   destroyed. Only a real structural change (a line added or deleted, a status
   flipped, a job renamed, rows reordered) falls back to a full render -- and
   even then focus is captured and restored around it.

   Deliberately *not* in the signature: description, part number, quantity,
   cost, core. Those live inside inputs the user is editing; they're the
   values a re-render exists to avoid clobbering.

   Both paths still assume the response describes the grid it is about to be
   written into, which is only true while nothing was typed during the round
   trip. sendEstimate is what checks that, and holds the response back when it
   isn't -- skipping the focused control is not enough on its own, because the
   boxes the advisor has already tabbed past are the ones that were losing
   their numbers. */
let lastEstimateShape = null;

function estimateShape(order) {
  const jobs = order.estimate?.jobs ?? [];
  const items = order.estimate?.items ?? [];
  return JSON.stringify([
    // completed_at is in the shape (not just synced in place) because ticking
    // a job changes the group's classes, its title's styling and the progress
    // line above the grid -- none of which syncEstimateInPlace touches.
    jobs.map((j) => [j.id, j.title, j.technician_id ?? null, j.completed_at ? 1 : 0]),
    items.map((i) => [
      i.id ?? null,
      i.kind,
      i.job_id ?? null,
      i.status ?? "quoted",
      i.part_returned ? 1 : 0,
      i.received_invoice_number ?? "",
      // decides whether the receive checkbox cell has a checkbox in it
      i.kind === "part" && i.id && ((i.quantity ?? 0) - (i.received_quantity ?? 0)) > 0.001 ? 1 : 0,
    ]),
  ]);
}

// The single entry point for "the server just gave us a new estimate" --
// cheap path when it can, full render when it must, focus intact either way.
function applyEstimateResponse(order) {
  if (syncEstimateInPlace(order)) return;
  const snap = captureEstimateFocus();
  renderEstimate(order);
  restoreEstimateFocus(snap);
}

function syncEstimateInPlace(order) {
  const box = $("#vd-estimate-items");
  if (!box || lastEstimateShape === null) return false;
  if (estimateShape(order) !== lastEstimateShape) return false;

  const items = order.estimate?.items ?? [];
  const active = document.activeElement;
  for (const item of items) {
    const row = $(`.part-row[data-id="${item.id}"]`, box);
    if (!row) return false; // DOM drifted from what we think we rendered -- redraw
    row.dataset.receivedQuantity = item.received_quantity ?? 0;
    row.dataset.receivedCost = item.received_cost ?? "";
    row.dataset.billedUnitCost = item.unit_cost ?? "";
    // Never write into the control the user is standing in; that's the whole
    // point of this path.
    const set = (sel, value) => {
      const el = $(sel, row);
      if (!el || el === active) return;
      const next = String(value);
      if (el.value !== next) el.value = next;
    };
    set(".ei-kind", item.kind);
    set(".ei-desc", item.description || "");
    set(".ei-part", item.part_number || "");
    set(".ei-qty", item.quantity ?? 1);
    const costEl = $(".ei-cost", row);
    if (costEl && costEl.dataset.realCost !== undefined) {
      // Returned part: the visible 0 is deliberate, the real number is the attribute.
      costEl.dataset.realCost = String(item.unit_cost ?? 0);
    } else {
      set(".ei-cost", item.unit_cost ?? 0);
    }
    set(".ei-core", item.core_charge ?? 0);
    const jobSel = $(".ei-job", row);
    if (jobSel && jobSel !== active) jobSel.value = item.job_id ?? "";
    const statusSel = $(".ei-status", row);
    if (statusSel) {
      const status = item.status || "quoted";
      if (statusSel !== active) statusSel.value = status;
      statusSel.dataset.prev = status;
      statusSel.className = `ei-status status-pill sp-${status}`;
    }
  }

  // Subtotals key off quantity x cost, which the shape signature ignores on
  // purpose -- so they have to be recomputed here explicitly.
  $$(".job-group", box).forEach((groupEl) => {
    const sub = $(".job-group-subtotal", groupEl);
    if (!sub) return;
    const jobId = groupEl.dataset.jobId === "" ? null : Number(groupEl.dataset.jobId);
    sub.textContent = money(ticketTotal(items.filter((i) => (i.job_id ?? null) === jobId)));
  });
  // Same reason as the subtotals above: a line's own total is quantity x cost,
  // which the shape signature deliberately ignores, so this path has to
  // rewrite the column itself or it keeps showing pre-save numbers.
  writeLineTotals(box);
  renderEstimateTotals(order);
  updateReceiveButtonState();
  return true;
}

// Identify the focused control well enough to find it again after the grid is
// rebuilt: by row id when the row survives the round-trip, by position when it
// doesn't (a brand-new row has no id until the server assigns one).
function captureEstimateFocus() {
  const box = $("#vd-estimate-items");
  const el = document.activeElement;
  if (!box || !el || !box.contains(el)) return null;
  const row = el.closest(".part-row");
  const field = [...el.classList].find((c) => c.startsWith("ei-"));
  if (!row || !field) return null;
  const snap = { id: row.dataset.id || "", index: $$(".part-row:not(.head)", box).indexOf(row), field };
  // Number inputs report null here; only text fields carry a caret worth keeping.
  if (typeof el.selectionStart === "number") {
    snap.start = el.selectionStart;
    snap.end = el.selectionEnd;
  }
  return snap;
}

function restoreEstimateFocus(snap) {
  if (!snap) return;
  const box = $("#vd-estimate-items");
  if (!box) return;
  const row = (snap.id && $(`.part-row[data-id="${snap.id}"]`, box)) || $$(".part-row:not(.head)", box)[snap.index];
  const el = row && $(`.${snap.field}`, row);
  if (!el || el.disabled) return;
  el.focus();
  if (typeof snap.start === "number" && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(snap.start, snap.end);
    } catch {
      /* input types that don't support a selection range -- focus is enough */
    }
  }
}

/* ---------- estimate grid: one delegated listener set ----------
   Wired once at startup against #vd-estimate-items, which never gets
   replaced -- only its contents do. Everything the grid renders (rows, job
   headers, the transient row addEstimateRow paints before its save lands) is
   live the instant it exists, and re-rendering binds nothing. */
/* A part number and a core charge only mean something on a part line. The
   estimate stores all three kinds in one table with one shared part_number
   column, so before this the Part # box sat there on a labor line inviting
   someone to fill it in, and the core box sat on every part line at 0.00 with
   nothing marking it as optional -- close enough to the cost box that typing
   the part's cost into it created a deposit the shop would later chase a
   vendor for. Both now appear only where they apply. */
function syncRowKindFields(row) {
  if (!row) return;
  const kind = row.querySelector(".ei-kind")?.value || "part";
  const isPart = kind === "part";
  const L = fieldLabels(kind);

  // The captions come off data-label (.pr-cell::before draws them once the
  // grid reflows to stacked cards), so they have to be retargeted here as
  // well as at render time -- otherwise switching a line to Labor leaves it
  // captioned "Part #" and "Qty" until the save round-trips.
  const relabel = (cls, label) => {
    const box = row.querySelector(`.pr-${cls}`);
    if (!box) return;
    if (label) box.setAttribute("data-label", label);
    else box.removeAttribute("data-label");
    box.classList.toggle("pr-spacer", !label);
  };
  relabel("part", L.part);
  relabel("qty", L.qty);
  relabel("cost", L.cost);
  relabel("core", L.core);

  const partInput = row.querySelector(".ei-part");
  if (partInput) {
    partInput.hidden = !isPart;
    if (!isPart) partInput.value = "";
  }
  const coreToggle = row.querySelector(".core-toggle");
  const coreAmount = row.querySelector(".ei-core");
  if (coreToggle) coreToggle.hidden = !isPart;
  if (coreAmount) {
    const on = isPart && row.querySelector(".ei-core-on")?.checked;
    coreAmount.hidden = !on;
    if (!on) coreAmount.value = "0";
  }
}

export function wireEstimateGrid() {
  const box = $("#vd-estimate-items");
  if (!box) return;

  box.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    // Ticking Core reveals the amount; unticking clears it, so the box can't
    // keep a figure the line no longer claims.
    if (t.matches(".ei-core-on")) {
      const row = t.closest(".part-row");
      const amount = row?.querySelector(".ei-core");
      if (amount) {
        amount.hidden = !t.checked;
        if (!t.checked) amount.value = "0";
        else amount.focus();
      }
      updateEstimateTotalsFromDom();
      clearEstimateTypingTimer();
      return void persistEstimate();
    }
    // Switching a line to Labor takes away the fields that only mean
    // something on a part, rather than leaving them there to be filled in.
    if (t.matches(".ei-kind")) syncRowKindFields(t.closest(".part-row"));
    // Every field autosaves on change -- there is no "forgot to click Save and
    // it silently vanished" window, because nothing is ever left DOM-only.
    // A change (blur/Enter) supersedes any debounced keystroke save still
    // waiting -- clear it so one edit doesn't post twice.
    if (t.matches(".ei-kind, .ei-desc, .ei-part, .ei-qty, .ei-cost, .ei-core, .ei-job")) {
      clearEstimateTypingTimer();
      return void persistEstimate();
    }
    if (t.matches(".ei-receive-check")) return void updateReceiveButtonState();
    if (t.matches(".ei-status")) return void onEstimateStatusChange(t);
    if (t.matches(".ei-job-tech")) return void onJobTechnicianChange(t);
    if (t.matches(".ei-job-done")) return void onJobDoneChange(t);
  });

  // How much room a column gets changes without any re-render: the window
  // resizes, or the details drawer swings open beside the grid. Observing the
  // box itself catches both with one hook. Coalesced through a timer because
  // a drag-resize streams dozens of callbacks, and the cue only has to be
  // right once the box settles. Guarded: jsdom has no ResizeObserver (and no
  // layout for the cue to measure anyway).
  if (typeof ResizeObserver === "function") {
    let clipCueTimer = null;
    new ResizeObserver(() => {
      if (clipCueTimer) clearTimeout(clipCueTimer);
      clipCueTimer = setTimeout(() => { clipCueTimer = null; syncClipCues(); }, 120);
    }).observe(box);
  }

  // Keystroke-level feedback. The change handler above only fires on blur, so
  // while a number was being typed every total on the page -- Quoted, Actual,
  // the over/under delta, job subtotals -- sat stale until the advisor clicked
  // somewhere else. Now money and qty edits recompute those figures locally on
  // every keystroke, and the save itself follows after a short pause in typing
  // (the blur save still exists as the backstop; the token in persistEstimate
  // already keeps overlapping responses ordered).
  box.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.matches(".ei-qty, .ei-cost, .ei-core, .ei-desc, .ei-part")) return;
    if (t.matches(".ei-qty, .ei-cost, .ei-core")) updateEstimateTotalsFromDom();
    // Keeps the overflow cue and its tooltip agreeing with the text mid-edit,
    // not just after the next render.
    if (t.matches(".ei-desc, .ei-part")) syncClipCue(t);
    clearEstimateTypingTimer();
    // A row whose description is empty gets dropped by collectEstimateItems --
    // saving mid-retype would delete the line out from under the advisor. Hold
    // the autosave until the row would survive it.
    const desc = t.closest(".part-row")?.querySelector(".ei-desc");
    if (desc && !desc.value.trim()) return;
    estimateTypingTimer = setTimeout(() => { estimateTypingTimer = null; persistEstimate(); }, 800);
  });

  /* ----- keyboard entry: Tab / Enter / Shift+Enter, one handler -----
     Spreadsheet-style row entry. The three keys share one definition of the
     grid's geometry so their guards can't drift apart:

     - EST_ENTRY_ORDER is the through-path along a line (Description -> Qty ->
       Cost -> Core). Part # rides along at Description's slot: forwards it
       advances the same way Description does (it's optional, and the fast
       path is the point), backwards it steps to Description itself.
     - Enter walks the chain forwards on the grid's last line only -- a
       correction three lines up must not grow the estimate, so Enter keeps
       its default commit meaning everywhere else. From the row's last money
       field it starts the next line, same contract as Tab.
     - Shift+Enter walks backwards from anywhere, crossing up into the
       previous row's last enabled field (across job groups, the same order
       the forward keys walk downwards). It never adds a line.
     - Tab out of the last money field on the last described line adds the
       next line of the same kind, instead of dumping focus onto the status
       pill. */
  const EST_ENTRY_ORDER = ["ei-desc", "ei-qty", "ei-cost", "ei-core"];
  const estRows = () => $$(".part-row:not(.head)", box);
  const rowField = (row, cls) => row.querySelector(`.${cls}`);
  const focusField = (el) => {
    el.focus();
    if (typeof el.select === "function") el.select();
  };
  // Index of the target on the through-path, or -1 for non-entry fields.
  // Part # sits between Description (0) and Qty (1): forward chains use
  // floor -> 0 (next stop Qty), backward chains use ceil -> 1 (previous
  // stop Description).
  const entryIndex = (t, { back = false } = {}) => {
    if (t.classList.contains("ei-part")) return back ? 1 : 0;
    return EST_ENTRY_ORDER.findIndex((c) => t.classList.contains(c));
  };
  const firstEnabled = (row, classes) =>
    classes.map((c) => rowField(row, c)).find((el) => el && !el.disabled);
  // The add-a-line contract shared by Tab and Enter: only from the grid's
  // final row, only out of that row's true last money field (Core when the
  // row has one (parts), Cost otherwise), and never chaining on from a line
  // that hasn't been described yet -- there's nothing to chain onward from.
  const mayAddLineFrom = (row, t, rows) => {
    if (row !== rows[rows.length - 1]) return false;
    const lastField = rowField(row, "ei-core") || rowField(row, "ei-cost");
    if (t !== lastField || (lastField && lastField.disabled)) return false;
    return Boolean(rowField(row, "ei-desc")?.value.trim());
  };
  const addLineAfter = (row) => {
    clearEstimateTypingTimer();
    const jobIdRaw = row.closest(".job-group")?.dataset.jobId ?? row.dataset.jobId ?? "";
    addEstimateRow(rowField(row, "ei-kind")?.value || "part", {}, jobIdRaw ? Number(jobIdRaw) : null);
  };

  box.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const row = t.closest(".part-row:not(.head)");
    if (!row) return;

    if (e.key === "Tab" && !e.shiftKey) {
      if (!mayAddLineFrom(row, t, estRows())) return;
      e.preventDefault();
      return void addLineAfter(row);
    }

    if (e.key !== "Enter") return;

    if (!e.shiftKey) {
      // Enter: forwards along the last line, then the add-a-line contract.
      const idx = entryIndex(t);
      if (idx === -1) return;
      const rows = estRows();
      if (row !== rows[rows.length - 1]) return;
      const next = firstEnabled(row, EST_ENTRY_ORDER.slice(idx + 1));
      if (next) {
        e.preventDefault();
        return void focusField(next);
      }
      if (!mayAddLineFrom(row, t, rows)) return;
      e.preventDefault();
      return void addLineAfter(row);
    }

    // Shift+Enter: backwards along the line, then up into the previous row.
    const idx = entryIndex(t, { back: true });
    if (idx === -1) return;
    const prev = firstEnabled(row, EST_ENTRY_ORDER.slice(0, idx).reverse());
    if (prev) {
      e.preventDefault();
      return void focusField(prev);
    }
    const rows = estRows();
    const prevRow = rows[rows.indexOf(row) - 1];
    if (!prevRow) return; // first field of the first line: nowhere further back
    const target = firstEnabled(prevRow, [...EST_ENTRY_ORDER].reverse());
    if (!target) return;
    e.preventDefault();
    focusField(target);
  });

  box.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("button") : null;
    if (!btn || !box.contains(btn)) return;
    if (btn.classList.contains("job-jump")) return void onJobJump(btn);
    if (btn.classList.contains("rm-btn")) return void onEstimateRowRemove(btn);
    if (btn.classList.contains("row-move-btn")) return void onEstimateRowMove(btn);
    if (btn.classList.contains("part-return-btn")) return void onEstimatePartReturn(btn);
    if (btn.classList.contains("job-edit")) return void onJobEdit(btn);
    if (btn.classList.contains("job-delete")) return void onJobDelete(btn);
    if (btn.classList.contains("job-mini-add")) {
      addEstimateRow(btn.dataset.kind, {}, btn.dataset.jobId ? Number(btn.dataset.jobId) : null);
    }
  });

  wireEstimateRowDragging(box);
}

function currentEstimateJob(jobId) {
  return (state.detail.order?.estimate?.jobs ?? []).find((j) => String(j.id) === String(jobId)) || null;
}

/* Scroll the grid to a repair's own group and flash it once, so the eye lands
   on the right section instead of somewhere mid-scroll -- the same move the
   Lot report makes for its piles. data-jump-job carries "" for General, which
   is exactly what the General group's data-job-id holds, so one string match
   serves both. scrollIntoView is feature-checked for the jsdom the smoke
   tests run in; the flash class still lands there, which is what the test
   watches for. */
function onJobJump(btn) {
  const target = $$(`#vd-estimate-items .job-group`)
    .find((g) => g.dataset.jobId === btn.dataset.jumpJob);
  if (!target) return;
  if (typeof target.scrollIntoView === "function") {
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }
  // Remove-then-re-add (with a reflow between) restarts the flash when the
  // same repair is jumped to twice in a row.
  target.classList.remove("job-jump-flash");
  void target.offsetWidth;
  target.classList.add("job-jump-flash");
  target.addEventListener("animationend", () => target.classList.remove("job-jump-flash"), { once: true });
}

async function onEstimateRowRemove(btn) {
  const row = btn.closest(".part-row");
  if (!row) return;
  const desc = row.querySelector(".ei-desc").value.trim();
  if (desc && !(await confirmAction({
    eyebrow: "REMOVE LINE",
    title: `Remove "${desc}"?`,
    body: "It comes off this repair order and stops counting toward its cost.",
    confirmLabel: "Remove Line",
    danger: true,
  }))) return;
  row.remove();
  persistEstimate();
}

function onEstimateRowMove(btn) {
  const order = state.detail.order;
  if (!order) return;
  openMoveItemDialog(order.id, Number(btn.dataset.id), btn.dataset.desc);
}

async function onEstimateStatusChange(sel) {
  const order = state.detail.order;
  const itemId = sel.closest(".part-row")?.dataset.id;
  if (!order || !itemId) return;
  try {
    await patch(`/api/orders/${order.id}/estimate/items/${itemId}/status`, { status: sel.value });
    sel.dataset.prev = sel.value;
    toast("Status updated");
    await loadVehicleDetail();
  } catch (err) {
    sel.value = sel.dataset.prev || "quoted";
    toast(err.message, true);
  }
}

async function onEstimatePartReturn(btn) {
  const order = state.detail.order;
  if (!order) return;
  const returned = btn.dataset.returned !== "1";
  const desc = btn.closest(".part-row").querySelector(".ei-desc").value.trim();
  // Sending the new part back reverses the line's core charge too: there's
  // no old unit owed to anyone, so its pending core drops off the cores
  // board. Say so, because that board is where someone would otherwise go
  // looking for it.
  const line = (order.estimate?.items || []).find((i) => String(i.id) === String(btn.dataset.id));
  const coreNote = returned && line && (line.core_charge || 0) > 0 && !line.core_returned
    ? ` Its ${money(line.core_charge)} core charge reverses with it, so the core drops off the cores board — there's no old unit to send back.`
    : "";
  // No paperwork at this step: the part goes back to the vendor first, and
  // the credit invoice arrives later -- it's recorded on the Parts & Cores
  // page once it shows up.
  if (returned && !(await confirmAction({
    eyebrow: "VENDOR RETURN",
    title: `Mark "${desc}" as returned?`,
    body: `Its cost stops counting toward this ticket and it lands on the returns board as Pending — mark it picked up there once the vendor collects it, then record their credit when the paperwork arrives.${coreNote}`,
    confirmLabel: "Mark Returned",
  }))) return;
  try {
    await patch(`/api/orders/${order.id}/estimate/items/${btn.dataset.id}/part-return`, { returned });
    toast(returned ? "Marked returned — it's waiting for pickup in Parts & Cores" : "Return undone");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onJobTechnicianChange(sel) {
  const order = state.detail.order;
  const job = currentEstimateJob(sel.dataset.jobId);
  if (!order || !job) return;
  try {
    await put(`/api/orders/${order.id}/jobs/${job.id}`, {
      title: job.title,
      technician_id: sel.value ? Number(sel.value) : null,
    });
    toast("Job technician updated");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

/* Ticking a repair off. No confirmation either way -- it is one click to undo,
   and a dialog in front of the most-repeated action on the screen is how a
   feature stops being used. The checkbox is put back if the save fails, so a
   tick that never reached the server can't sit on screen looking saved. */
async function onJobDoneChange(box) {
  const order = state.detail.order;
  const job = currentEstimateJob(box.dataset.jobId);
  if (!order || !job) return;
  const done = box.checked;
  try {
    await patch(`/api/orders/${order.id}/jobs/${job.id}/done`, { done });
    toast(done ? `“${job.title}” ticked off` : `“${job.title}” reopened`);
    await loadVehicleDetail();
  } catch (err) {
    box.checked = !done;
    toast(err.message, true);
  }
}

function onJobEdit(btn) {
  const job = currentEstimateJob(btn.dataset.jobId);
  if (job) openJobDialog(job);
}

async function onJobDelete(btn) {
  const order = state.detail.order;
  if (!order) return;
  const job = currentEstimateJob(btn.dataset.jobId);
  if (!(await confirmAction({
    eyebrow: "DELETE JOB",
    title: `Delete "${job ? job.title : "this job"}"?`,
    body: "Its parts and labor move back to General. No lines are deleted.",
    confirmLabel: "Delete Job",
    danger: true,
  }))) return;
  try {
    await api(withActorParam(`/api/orders/${order.id}/jobs/${btn.dataset.jobId}`), { method: "DELETE" });
    toast("Job deleted");
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

// Native HTML5 drag-and-drop: grabbing the row (the visible affordance is the
// ⋮⋮ handle) reorders it among its siblings live as you drag; persistEstimate()
// on drop saves whatever order the DOM ends up in, same as every other estimate
// edit. Delegated from the grid container rather than bound per row, with the
// same-parent check doing what per-group wiring used to do: a row can only be
// dropped among its own group's siblings, because dragging a part into the
// Labor section wouldn't change its kind and would just look wrong. Moving a
// line to a different job or kind is the Job/Kind selects' job.
function wireEstimateRowDragging(box) {
  let dragRow = null;
  box.addEventListener("dragstart", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".part-row:not(.head)") : null;
    if (!row || row.getAttribute("draggable") === "false") return;
    dragRow = row;
    row.classList.add("dragging");
  });
  box.addEventListener("dragend", () => {
    if (!dragRow) return;
    dragRow.classList.remove("dragging");
    dragRow = null;
    persistEstimate();
  });
  box.addEventListener("dragover", (e) => {
    if (!dragRow) return;
    e.preventDefault();
    const row = e.target instanceof Element ? e.target.closest(".part-row:not(.head)") : null;
    if (!row || row === dragRow || row.parentNode !== dragRow.parentNode) return;
    const rect = row.getBoundingClientRect();
    const before = rect.height > 0 && (e.clientY - rect.top) / rect.height < 0.5;
    row.parentNode.insertBefore(dragRow, before ? row : row.nextSibling);
  });
}

/* Every editable control on a grid row, read as one string.

   This is what tells "the response describes what is on screen" apart from
   "the advisor has typed since" -- see sendEstimate. Deliberately the mirror
   image of estimateShape(): that one lists everything a save can restructure
   and leaves the typed values out, this one lists exactly the typed values. */
const EST_EDITABLE_FIELDS = [".ei-kind", ".ei-desc", ".ei-part", ".ei-qty", ".ei-cost", ".ei-core", ".ei-job"];

function rowEditableSignature(row) {
  const values = EST_EDITABLE_FIELDS.map((sel) => row.querySelector(sel)?.value ?? "");
  values.push(row.querySelector(".ei-core-on")?.checked ? "1" : "0");
  return values.join("");
}

/* The grid rows and the payload they produce, side by side.

   collectEstimateItems() below is this with the rows dropped; sendEstimate
   needs both halves, because lining a saved item up with the row it came from
   is the only way to hand a brand-new row the id the server just gave it. */
function collectEstimateRows() {
  return $$(".part-row:not(.head)", $("#vd-estimate-items"))
    .map((row) => ({ row, item: rowAsPayload(row) }))
    .filter((pair) => pair.item.description);
}

function collectEstimateItems() {
  return collectEstimateRows().map((pair) => pair.item);
}

function rowAsPayload(row) {
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
  // The core amount only counts when the line is explicitly marked as
  // carrying a core. An unticked row reports 0 no matter what is sitting in
  // the box, so a stray figure can't quietly become a deposit the shop then
  // chases a vendor for.
  const coreOn = row.querySelector(".ei-core-on")?.checked;
  const kind = row.querySelector(".ei-kind").value;
  const jobSelect = row.querySelector(".ei-job");
  return {
    id: row.dataset.id ? Number(row.dataset.id) : null,
    kind,
    description: row.querySelector(".ei-desc").value.trim(),
    // Labor has no part number -- the column is shared across line kinds,
    // so anything typed there before the kind was switched is dropped
    // rather than saved against a labor line.
    part_number: kind === "part" ? row.querySelector(".ei-part").value.trim() : "",
    quantity: parseFloat(row.querySelector(".ei-qty").value || "1"),
    unit_cost: cost,
    unit_price: cost,
    core_charge: coreOn && coreInput ? parseFloat(coreInput.value || "0") : 0,
    source: row.dataset.source || "manual",
    // A freshly-added row (addEstimateRow) has no .ei-job select yet --
    // just the data-job-id it was created with -- so fall back to that.
    job_id: jobSelect ? (jobSelect.value ? Number(jobSelect.value) : null) : (row.dataset.jobId ? Number(row.dataset.jobId) : null),
  };
}

// Saves the estimate exactly as it currently sits in the DOM, then re-renders
// from the server's response so ids/status controls attach to new rows --
// unless the grid has moved on since, in which case the response is left
// unapplied and the follow-up save's answer does the redrawing (sendEstimate).
// Called after every add/edit/remove -- an estimate line is never sitting
// unsaved in the browser waiting to be wiped out by an unrelated action
// elsewhere on the page (that was the bug: adding a part, then clicking any
// other Save/Advance/Order-Parts button, reloaded the page and discarded it).
//
/* One save is in flight at a time, and that is not just tidiness -- it is what
   keeps the estimate's optimistic lock honest.

   Every save carries the edit_version it was written against, and the server
   bumps that version as part of the UPDATE (see save_estimate in app/main.py).
   The version only moves in this browser when a response comes back. So two
   saves started before the first one answers necessarily quote the *same*
   expected_version, the server takes the first and rejects the second with
   "Someone else changed this estimate" -- from the one person typing. The
   advisor then gets a scare about a colleague who wasn't there, and the 409
   handler reloads the ticket out from under whatever they were mid-way through
   typing.
   That pairing is completely ordinary: a keystroke save fires 800ms after the
   last character (the debounce in wireEstimateGrid), and tabbing to the next
   field an instant later fires the change save on top of it. On the shop LAN,
   where a round trip to the shop PC is not free, the overlap window is wide
   open.
   So: while a save is posting, further calls collapse into one follow-up run
   that starts when the response lands -- by which time order.estimate holds the
   version the server just wrote, and the DOM is re-read so the follow-up
   carries the newest typing rather than a snapshot taken before it. Callers
   still get a promise that settles once their edit has actually been flushed
   (addEstimateRow waits on it to focus the new line). */
let estimateSaveInFlight = null;
let estimateSaveQueued = null;
function persistEstimate() {
  if (estimateSaveInFlight) {
    if (!estimateSaveQueued) {
      let settle;
      const promise = new Promise((resolve) => { settle = resolve; });
      estimateSaveQueued = { promise, settle };
    }
    return estimateSaveQueued.promise;
  }
  estimateSaveInFlight = sendEstimate().then(({ saved, stale }) => {
    estimateSaveInFlight = null;
    const queued = estimateSaveQueued;
    estimateSaveQueued = null;
    // `stale` means the answer that just came back was left on the floor
    // because the grid had already moved past it, so the shop PC is still
    // holding the older lines and another round trip is owed -- whether or
    // not anything queued one. (It normally has: every edit calls in here.
    // But the promise addEstimateRow is waiting on must not settle while the
    // line it just added is unsaved, and that is exactly the case where the
    // queue can be empty.)
    if (!queued && !stale) return;
    // A failed save has already dealt with itself -- a real conflict reloaded
    // the ticket from the server, anything else left "Not saved" showing for
    // the next edit to clear. Re-firing on top of that would either re-post
    // what the reload just replaced or fail the identical way twice.
    if (saved) return void persistEstimate().then(() => queued && queued.settle());
    if (queued) queued.settle();
  });
  return estimateSaveInFlight;
}

/** One round trip.

    `saved` is whether the estimate reached the database -- persistEstimate
    uses it to decide whether a coalesced follow-up save is still worth
    sending. `stale` is whether the response was deliberately left unapplied
    because the advisor had typed since it was sent; see below. */
async function sendEstimate() {
  const order = state.detail.order;
  if (!order) return { saved: false, stale: false };
  const pairs = collectEstimateRows();
  const items = pairs.map((pair) => pair.item);
  /* What went to the shop PC, row by row, so the answer can be checked against
     the grid it describes rather than against the grid as it is when it lands.

     Those are not the same grid. A save posts on every field change, the shop
     PC is across a LAN, and the entry path here is a spreadsheet tab-through:
     Description, Tab, Qty, Tab, Cost, Tab. Each Tab starts a save and the
     advisor keeps typing into the next box while it flies. The response then
     arrives describing the line as it was two fields ago and -- until this --
     was written straight over the grid, so the quantity and the cost just
     typed reverted to 1 and $0.00 with "All changes saved" showing underneath.
     A two-off quantity on a $96 rotor is $96 missing from what the shop spent
     on that car, and nobody was told. */
  const sentRows = $$(".part-row:not(.head)", $("#vd-estimate-items")).map((row) => ({
    row,
    signature: rowEditableSignature(row),
  }));
  const expectedVersion = order.estimate ? order.estimate.edit_version : null;
  setEstimateSaveState("saving");
  try {
    const estimate = await post(`/api/orders/${order.id}/estimate`, { labor_rate: 0, tax_rate: 0, items, expected_version: expectedVersion });
    order.estimate = estimate;
    // A brand-new row takes the id the server just gave it either way. Without
    // it the follow-up save posts the line as new all over again, and the
    // server -- which reconciles on id -- deletes the row it just wrote and
    // inserts another, churning the id out from under anything (a receive
    // tick, a vendor invoice) that had hold of it.
    adoptSavedItemIds(pairs, estimate);
    if (estimateGridMovedOn(sentRows)) {
      // Leave the grid alone: what is on screen is newer than what came back,
      // and persistEstimate is about to send it. The figures still have to
      // move, so they are recomputed from the grid rather than from the stale
      // answer, and the state line keeps saying "Saving..." because that is
      // the truth until the follow-up lands.
      updateEstimateTotalsFromDom();
      return { saved: true, stale: true };
    }
    applyEstimateResponse(order);
    setEstimateSaveState("saved");
    return { saved: true, stale: false };
  } catch (err) {
    setEstimateSaveState("failed");
    toast(err.message, true);
    // A conflict now means what it says: somebody else really did change this
    // ticket, so the only safe move is to show what they wrote.
    if (String(err.message).includes("Someone else changed")) await loadVehicleDetail();
    return { saved: false, stale: false };
  }
}

/* Has the grid changed since this save was posted?

   Rows are compared by identity, not by position, so a redraw that happened
   mid-flight counts as a change even if it produced a grid that looks the
   same -- the row objects the response was going to be written into are gone,
   and writing into their replacements is guesswork. */
function estimateGridMovedOn(sentRows) {
  const rows = $$(".part-row:not(.head)", $("#vd-estimate-items"));
  if (rows.length !== sentRows.length) return true;
  return rows.some((row, i) => row !== sentRows[i].row || rowEditableSignature(row) !== sentRows[i].signature);
}

/* Stamp each row with the id the server holds for its line.

   The server writes sort_order from the position each item arrived in and
   reads them back in that order, so the response lines up with what was sent
   one for one -- but only if it came back whole. Anything else and this does
   nothing: a wrong id here would point a row at another line entirely, and
   the next full render fixes the ids anyway. */
function adoptSavedItemIds(pairs, estimate) {
  const items = estimate?.items ?? [];
  if (items.length !== pairs.length) return;
  pairs.forEach((pair, i) => {
    if (pair.row.isConnected && !pair.row.dataset.id && items[i]?.id) pair.row.dataset.id = String(items[i].id);
  });
}

/* Autosave is invisible by design -- which also means there was no way to tell
   whether the number you just typed actually reached the database, or whether
   the app was simply ignoring you. This is the one bit of feedback: it says
   Saving while a request is in flight, settles to "All changes saved" and
   fades out, and stays put (in red) if the save failed. */
let estimateSaveStateTimer = null;
function setEstimateSaveState(kind) {
  const el = $("#vd-estimate-save-state");
  if (!el) return;
  clearTimeout(estimateSaveStateTimer);
  el.textContent = { saving: "Saving…", saved: "All changes saved", failed: "Not saved" }[kind] || "";
  el.className = `save-state show ${kind}`;
  if (kind === "saved") {
    estimateSaveStateTimer = setTimeout(() => { el.className = "save-state saved"; }, 2200);
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
  // Same .pr-cell scaffolding renderEstimate() emits, including the empty
  // spacers -- otherwise this row sits misaligned against the ones around it
  // for the half-second before the save round-trips and re-renders.
  row.innerHTML = `
    <div class="pr-cell pr-handle pr-spacer"></div>
    <div class="pr-cell pr-check pr-spacer"></div>
    <div class="pr-cell pr-kind" data-label="Kind"><select class="ei-kind">
      <option value="part" ${kind === "part" ? "selected" : ""}>Part</option>
      <option value="labor" ${kind === "labor" ? "selected" : ""}>Labor</option>
      <option value="fee" ${kind === "fee" ? "selected" : ""}>Fee</option>
      ${/* Same hidden Credit option as the rendered grid above -- a new row is
           never a credit, but this row is also what a duplicated row is built
           from, and dropping the kind here would resend it as "". */ ""}
      <option value="credit" hidden ${kind === "credit" ? "selected" : ""}>Credit</option>
    </select></div>
    <div class="pr-cell pr-desc" data-label="Description"><input class="ei-desc" placeholder="Description" value="${esc(defaults.description || `New ${label.toLowerCase()}`)}"></div>
    <div class="pr-cell pr-part"${fieldLabels(kind).part ? ` data-label="${fieldLabels(kind).part}"` : ""}><input class="ei-part" placeholder="Part #" value="${esc(defaults.part_number || "")}"></div>
    <div class="pr-cell pr-qty" data-label="${fieldLabels(kind).qty}"><input class="ei-qty" type="number" min="0.01" step="0.01" value="${defaults.quantity ?? 1}"></div>
    <div class="pr-cell pr-cost" data-label="${fieldLabels(kind).cost}"><input class="ei-cost" type="number" min="0" step="0.01" value="${defaults.unit_cost ?? 0}"></div>
    <div class="pr-cell pr-core pr-spacer"></div>
    ${/* Live from the moment the row lands: the delegated input handler on the
         grid recomputes this the first time anything is typed, and the row is
         seeded here with what the defaults already come to. */ ""}
    <div class="pr-cell pr-total" data-label="Line total"><span class="${lineTotalClass((defaults.quantity ?? 1) * (defaults.unit_cost ?? 0))}">${money((defaults.quantity ?? 1) * (defaults.unit_cost ?? 0))}</span></div>
    ${box.classList.contains("has-jobs") ? `<div class="pr-cell pr-job pr-spacer"></div>` : ""}
    <div class="pr-cell pr-status" data-label="Status"><span class="status-pill sp-quoted">Saving…</span></div>
    <div class="pr-cell pr-move pr-spacer"></div>
    <div class="pr-cell pr-remove"><button type="button" class="rm-btn" title="Remove line">×</button></div>
  `;
  // No listener wiring: the delegated handler on #vd-estimate-items already
  // covers this row's × button the moment it lands in the DOM.
  targetContainer.appendChild(row);
  // A brand-new Labor line shouldn't flash a Part # box for the half-second
  // before the save round-trips and re-renders it.
  syncRowKindFields(row);
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

function openJobDialog(job = null) {
  state.detail.editingJobId = job ? job.id : null;
  $("#job-dialog-title").textContent = job ? "Rename Job" : "Add Job";
  $("#job-title-input").value = job ? job.title : "";
  $("#job-technician-input").innerHTML = staffOptions({
    roles: ["technician"],
    selectedId: job ? job.technician_id : null,
    selectedName: job ? job.technician_name : "",
    blankLabel: "Use ticket default",
  });
  $("#job-usual").hidden = true;
  if (!job) fillUsualJobs();
  $("#job-dialog").showModal();
}

/* The shop writes the same handful of jobs all day; offer its own
   most-written names as one-click chips so a busy write-up never types
   "Front Brakes" again. Filled after the dialog opens (never blocks it),
   and any failure just leaves the section hidden -- the typed path is
   untouched. */
async function fillUsualJobs() {
  let titles = [];
  try {
    titles = await get("/api/jobs/usual-titles");
  } catch {
    return;
  }
  // Ignore a stale response if the dialog moved on to a rename meanwhile.
  if (state.detail.editingJobId !== null || !titles.length) return;
  const grid = $("#job-usual-grid");
  grid.innerHTML = titles
    .map((t) => `<button type="button" class="chip job-usual-chip" data-title="${esc(t)}">${esc(t)}</button>`)
    .join("");
  $$(".job-usual-chip", grid).forEach((chip) =>
    chip.addEventListener("click", () => {
      const input = $("#job-title-input");
      input.value = chip.dataset.title;
      $$(".job-usual-chip", grid).forEach((c) => c.classList.toggle("active", c === chip));
      input.focus();
    })
  );
  $("#job-usual").hidden = false;
}

export function wireJobDialog() {
  $("#job-cancel").addEventListener("click", () => $("#job-dialog").close());
  $("#job-cancel-2").addEventListener("click", () => $("#job-dialog").close());
  $("#job-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#job-title-input").value.trim();
    if (!title) return;
    const technicianId = $("#job-technician-input").value ? Number($("#job-technician-input").value) : null;
    const editingId = state.detail.editingJobId;
    try {
      const body = { title, technician_id: technicianId };
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
        const others = invoice.other_item_count;
        // An invoice that also covers another car is the case most worth
        // stopping on, and it used to be the one case this said nothing about.
        const cars = invoice.other_order_count > 0
          ? ` — including work on ${invoice.other_order_count} other vehicle${invoice.other_order_count === 1 ? "" : "s"}`
          : "";
        warning.textContent = `⚠ This invoice also covers ${others} other part${others === 1 ? "" : "s"}${cars}. Checking this moves ALL of them, not just this one.`;
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

export function wireMoveItemDialog() {
  $("#move-item-cancel").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-cancel-2").addEventListener("click", () => $("#move-item-dialog").close());
  $("#move-item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const targetOrderId = Number($("#move-item-target").value);
    if (!targetOrderId) return;
    const { movingItemId, movingFromOrderId } = state.detail;
    const reassignInvoice = $("#move-item-reassign-invoice").checked;
    try {
      await patch(`/api/orders/${movingFromOrderId}/estimate/items/${movingItemId}/move`, { target_order_id: targetOrderId, reassign_invoice: reassignInvoice });
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
  /* A note is filed against the repair order, so a car with no ticket has
     nowhere to put one -- and, until this, showed the last car's notes
     instead. It now says which it is. The box and the button go with it:
     leaving them live meant typing a note about the Sorento and being told
     "Cannot read properties of null", which is a message for a programmer,
     not for somebody standing at the counter. */
  if (!order) {
    box.innerHTML = emptyState({
      icon: "idea",
      title: "No ticket to note against yet",
      hint: "Notes are kept on the car's repair order. Start one above and this is where they'll be.",
      compact: true,
    });
    $("#vd-note-text").value = "";
    return;
  }
  /* The note itself is the point, so it leads at reading size and everything
     about it -- who, when, who's allowed to see it -- drops to one quiet line
     underneath. The two visibilities are told apart by the edge rather than by
     a word in the middle of the sentence: a note the customer can be shown is
     the one worth spotting while scrolling, and it carries the accent. */
  box.innerHTML = order.notes.length ? order.notes.map((n) => `
    <div class="note-item${n.visibility === "customer" ? " for-customer" : ""}">
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-meta">
        <span class="note-tag">${n.visibility === "customer" ? "Customer" : "Internal"}</span>
        <span class="note-by">${esc(actorLabel(n.actor) ? `${actorLabel(n.actor)} · ` : "")}${fmtDate(n.created_at)}</span>
      </div>
    </div>
  `).join("") : emptyState({ icon: "idea", title: "No notes yet", hint: "Anything worth remembering about this vehicle -- what the customer said, what you found.", compact: true });
}
/* The activity log's actions are database verbs, and the log used to print
   them with the underscores swapped for spaces: "technician findings
   recorded", "ap invoice voided", "estimate item moved out". Readable enough
   to debug with, but the log is on a screen advisors use, and now the same
   strings caption the "last worked on" line at the top of the page, where a
   half-translated identifier looks broken.

   Anything missing from this map falls back to the old de-underscoring, so a
   new server-side action is ugly rather than blank -- these are written in a
   dozen places across five modules and this list will drift. */
const ACTIVITY_LABEL = {
  order_created: "Ticket opened",
  status_changed: "Status changed",
  segment_changed: "Moved to another vehicle",
  concern_updated: "Concern updated",
  assignment_updated: "Assignment changed",
  note_added: "Note added",
  inspection_saved: "Check-over sheet saved",
  technician_findings_recorded: "Findings recorded",
  job_created: "Job added",
  jobs_created: "Jobs added",
  estimate_items_appended: "Lines added",
  job_updated: "Job updated",
  job_deleted: "Job removed",
  job_completed: "Repair finished",
  job_reopened: "Repair reopened",
  estimate_approved: "Estimate approved",
  estimate_declined: "Estimate declined",
  estimate_item_moved_in: "Line moved onto this ticket",
  estimate_item_moved_out: "Line moved to another ticket",
  purchase_order_created: "PO number taken",
  purchase_order_vendor_set: "Supplier recorded on a PO",
  purchase_order_expected_set: "Vendor's delivery day recorded",
  parts_ordered: "Parts marked ordered",
  parts_order_undone: "Part put back to quoted",
  parts_received: "Parts received",
  ap_invoice_posted: "Vendor invoice posted",
  part_returned: "Part returned",
  part_return_undone: "Part return undone",
  part_return_credited: "Return credited",
  core_returned: "Core picked up",
  core_return_undone: "Core return undone",
  core_credit_recorded: "Core credit recorded",
  part_picked_up: "Return picked up",
  part_pickup_undone: "Return pickup undone",
  invoice_created: "Invoice created",
  payment_recorded: "Payment recorded",
  ap_invoice_voided: "Vendor invoice voided",
  order_voided: "Ticket voided",
};

function activityLabel(action) {
  return ACTIVITY_LABEL[action] || String(action || "").replace(/_/g, " ");
}

/* Three families of event get a colour on the log; everything else stays grey.
   Forty rows of identical type is a wall, and scrolling it to answer "has this
   car actually moved this week?" meant reading every line. Money landing on
   the car and work actually finishing are the two things worth picking out of
   that wall, and something being taken back is worth picking out because
   somebody undid it on purpose. Retyping the concern or changing who's
   assigned is the background hum and stays quiet.

   Anything not listed falls through to grey, so a new server-side action is
   dull rather than mis-coloured. */
const ACTIVITY_MONEY = new Set([
  "parts_received", "ap_invoice_posted", "invoice_created", "payment_recorded",
  "part_return_credited", "core_credit_recorded", "estimate_approved",
]);
const ACTIVITY_WORK = new Set([
  "order_created", "status_changed", "job_completed", "parts_ordered",
  "job_created", "jobs_created", "estimate_items_appended", "inspection_saved",
  "technician_findings_recorded", "part_returned", "core_returned", "part_picked_up",
  "estimate_item_moved_in",
]);
const ACTIVITY_UNDONE = new Set([
  "order_voided", "ap_invoice_voided", "estimate_declined", "job_deleted",
  "job_reopened", "parts_order_undone", "part_return_undone", "core_return_undone",
  "part_pickup_undone", "estimate_item_moved_out", "segment_changed",
]);
function activityTone(action) {
  if (ACTIVITY_MONEY.has(action)) return " money";
  if (ACTIVITY_UNDONE.has(action)) return " undone";
  if (ACTIVITY_WORK.has(action)) return " work";
  return "";
}

/* Which day an event belongs to. The stamps are shop-local naive time on
   purpose (app/db.py::now), so the day printed on one is the day it happened
   and reading it locally is right -- todayLocal is the same arithmetic the
   board's date filters already use, rather than a second way to get a
   calendar day out of a Date. */
function activityDayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : todayLocal(d);
}
function activityDayLabel(key) {
  if (!key) return "Undated";
  if (key === todayLocal()) return "Today";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return key === todayLocal(yesterday) ? "Yesterday" : fmtDay(key);
}
function activityTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/* The log is the car's story, so it's told as one: newest first, broken into
   the days it happened on, with the date said once at the head of each day
   instead of re-stamped on all nine of that afternoon's rows. What's left on
   the row is the event and the time of day, which is the pair anyone is
   actually reading for. */
function renderActivity(order) {
  const box = $("#vd-activity-list");
  // The worst of the leaks, because this one is a list of things that
  // demonstrably happened: a car nobody had touched in twelve days showed a
  // morning of parts receipts and finished repairs belonging to the car
  // opened before it. Nothing has happened to a car with no ticket, and that
  // is what it now says.
  if (!order) {
    box.innerHTML = emptyState({ icon: "check", title: "No activity yet", hint: "Once a repair order is open on this vehicle, everything done to it gets logged here.", compact: true });
    return;
  }
  if (!order.activity.length) {
    box.innerHTML = emptyState({ icon: "check", title: "No activity yet", hint: "Status changes, assignments, and receipts on this ticket get logged here.", compact: true });
    return;
  }
  let day = null;
  box.innerHTML = order.activity.slice().reverse().map((a) => {
    const key = activityDayKey(a.created_at);
    const heading = key === day ? "" : `<div class="tl-day">${esc(activityDayLabel(key))}</div>`;
    day = key;
    return `${heading}
      <div class="tl-item${activityTone(a.action)}">
        <span class="tl-dot" aria-hidden="true"></span>
        <span class="tl-what">${esc(activityLabel(a.action))}</span>
        <span class="tl-when">${esc(activityTime(a.created_at))}</span>
        <span class="tl-who">${esc(actorLabel(a.actor))}</span>
      </div>`;
  }).join("");
}

/* ---------- assignment ---------- */
function renderAssignment(order) {
  /* Date in, odometer in and the promised date are all written on the ticket,
     which is why a car with no ticket has to show them empty rather than show
     the last car's. This was the leak with a number attached: the Timing card
     read 84,500 miles on a Sorento that has 71,200, three inches under the
     Vehicle Info card correctly saying 71,200. */
  if (!order) {
    $("#vd-technician").innerHTML = `<option value="">Unassigned</option>`;
    $("#vd-advisor").innerHTML = `<option value="">Unassigned</option>`;
    $("#vd-date-in").value = "";
    $("#vd-odometer").value = "";
    const blank = $("#vd-promised");
    blank.value = "";
    blank.classList.remove("overdue");
    const emptyLabel = $("#vd-assign-picker-label");
    emptyLabel.textContent = "Assign";
    emptyLabel.closest("button").title = "";
    return;
  }
  const advisors = state.staff.filter((s) => s.role === "advisor" || s.role === "manager");
  const a = order.assignment;
  /* The ticket already knows who you are -- "Working as" is set in the top
     right and stamps your name on everything you do here. Asking again which
     advisor owns the ticket was the same fact requested twice, so an
     unassigned ticket now defaults to whoever is working it, provided they're
     an advisor or manager. It's a pre-selection, not a lock: the dropdown
     still opens and anyone in it can be picked. */
  const selfAdvisor = advisors.find((s) => s.name === state.currentUser);
  const advisorId = (a && a.advisor_id) || (selfAdvisor ? selfAdvisor.id : null);
  $("#vd-technician").innerHTML = staffOptions({
    roles: ["technician"],
    selectedId: (a && a.technician_id) || null,
    selectedName: a && a.technician_name,
    blankLabel: "Unassigned",
  });
  $("#vd-advisor").innerHTML = staffOptions({
    roles: ["advisor", "manager"],
    selectedId: advisorId || null,
    // Only the ticket's own advisor has a name to fall back on; advisorId can
    // also be the current user pre-selected, and they are in the list already.
    selectedName: a && a.advisor_id === advisorId ? a.advisor_name : "",
    blankLabel: "Unassigned",
  });
  $("#vd-date-in").value = (a && a.date_in) || "";
  $("#vd-odometer").value = (a && a.odometer_in) || "";
  const promised = $("#vd-promised");
  promised.value = (a && a.promised_at) || "";
  // A promised date in the past is the single most actionable field in the
  // drawer -- it turns red instead of sitting there looking routine.
  promised.classList.toggle("overdue",
    !!(a && a.promised_at) && new Date(a.promised_at) < new Date() && order.status !== "complete");

  // The toggle used to always read "Assign" even once both roles were
  // filled in, so reading who's on the ticket meant opening the popover --
  // same first-name-only convention as the Tasks assignee summary.
  const firstName = (name) => (name || "").split(" ")[0];
  const label = $("#vd-assign-picker-label");
  if (a && (a.technician_name || a.advisor_name)) {
    label.textContent = `${firstName(a.technician_name) || "—"} / ${firstName(a.advisor_name) || "—"}`;
    label.closest("button").title = `Technician: ${a.technician_name || "Unassigned"} · Advisor: ${a.advisor_name || "Unassigned"}`;
  } else {
    label.textContent = "Assign";
    label.closest("button").title = "";
  }
}

/* ---------- print a single ticket ---------- */
// Reuses the same print-only surface and letterhead/table styling the
// Reports view already prints with -- printing a report and printing a
// ticket are mutually exclusive user actions, so sharing the one
// `#print-report` container is simpler than maintaining a second.
//
// Sharing it requires knowing who wrote it last. The Reports screen rebuilds
// its markup on beforeprint (so Ctrl+P always prints current rows), and that
// event fires for EVERY print -- including a ticket's. Without the ownership
// check, one visit to Reports left state.report set for the rest of the
// session, and every Print Ticket after that came out of the printer as the
// summary report: the rebuild overwrote the ticket between renderPrintTicket()
// and the dialog capturing the page. Looked like a haunted server, was one
// stale flag -- and "restart the server" only helped because it forced the
// page reload that cleared it.

/* Two copies of the same ticket, chosen at the printer.

   "shop" is the whole record, money included -- what the office files. "tech"
   is the work list that gets handed across the counter: the same jobs, parts
   and labor in the same order, with every dollar figure left off. What a part
   cost is the office's business, not something to hand around the floor on
   paper -- and the space the money columns took up goes to what a paper on a
   toolbox is actually for: a tick box per line, and ruled lines to write down
   what was found once the car was open. Fees and vendor credits are money
   bookkeeping with no wrench behind them, so the tech copy drops those lines
   entirely; a returned part stays, marked Returned, because "the first
   alternator went back" is something the person under the hood needs to know. */
function renderPrintTicket(copy = "shop") {
  state.printSurfaceOwner = "ticket";
  const moneyed = copy !== "tech";
  const { segment, item, order } = state.detail;
  const generated = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const isWeOwe = segment !== "recon";
  const vehicleLabel = segment === "recon"
    ? `${item.stock_number} — ${item.year} ${item.make} ${item.model}`
    : `${item.year} ${item.make} ${item.model}`;
  const customerLabel = isWeOwe ? (item.customer_name || "") : "";
  const items = order.estimate ? order.estimate.items : [];
  const jobs = order.estimate?.jobs ?? [];
  // Same rules as the on-screen card (estimate-money.js). Paper that
  // disagreed with the screen it was printed from was the worst version of
  // this bug: the screen can be refreshed, the sheet in someone's hand can't.
  const printWritten = ticketTotal(items);
  const printActual = actualTotal(items);
  const a = order.assignment;
  const techName = (a && a.technician_name) || "Unassigned";
  const advisorName = (a && a.advisor_name) || "Unassigned";
  // A we-owe ticket can end up in the customer's hands -- internal notes
  // stay off that paper. A recon ticket is a shop document; everything
  // prints, and either way the visibility tag itself stays on screen.
  const printNotes = isWeOwe ? (order.notes || []).filter((n) => n.visibility === "customer") : (order.notes || []);
  const auth = order.authorization;
  const payments = isWeOwe ? (item.payments || []) : [];
  const paid = isWeOwe ? (item.customer_paid || 0) : 0;
  // Key/value line that drops itself when there's nothing to say, so the
  // info blocks self-compact instead of printing rows of dashes.
  const kv = (k, v) => (v ? `<div class="pi-row"><span class="k">${k}</span><span class="v">${v}</span></div>` : "");

  // The lines this copy carries. The shop copy is the whole ticket; the tech
  // copy is only the lines somebody turns a wrench for.
  const printItems = moneyed ? items : items.filter((i) => i.kind === "part" || i.kind === "labor");
  // Shop copy: Description | Part # | Qty | Unit | Total | Status -- the line
  // total is what lets anyone verify the math on paper. Tech copy: a tick box
  // takes the money columns' place. Status is a parts-only concept (labor/fees
  // have no order lifecycle), mirroring the on-screen grid.
  const COLS = moneyed ? 6 : 5;
  const itemRow = (i) => {
    const returned = isReturnedPart(i);
    let status = "";
    if (i.kind === "part") {
      if (returned) status = "Returned";
      else if ((i.received_quantity ?? 0) > 0 && i.received_quantity < i.quantity) status = `Received ${i.received_quantity}/${i.quantity}`;
      else status = ITEM_STATUS_LABEL[i.status] || "Quoted";
    }
    // The deposit is in this row's own total when it's still owed back, so
    // say which it is -- a printed line that reads "Core charge $45" but adds
    // $45 into some rows and not others is unauditable on paper.
    // Say where the deposit stands, since it is in the totals below only
    // while it's still owed back.
    // The tech copy keeps only the half of it that is an instruction: the
    // old part has to go back in the box.
    const coreSub = i.kind === "part" && (i.core_charge || 0) > 0
      ? (moneyed
        ? `<div class="pt-desc-sub">Core charge ${money(i.core_charge)}${coreOwing(i) ? " — owed back" : i.core_return_invoice_number ? " — credited back" : " — reversed with the return"}</div>`
        : (coreOwing(i) ? `<div class="pt-desc-sub">Core — the old part goes back</div>` : ""))
      : "";
    const moneyCells = moneyed
      ? `<td class="num-col">${money(returned ? 0 : i.unit_cost)}</td>
      <td class="num-col">${money(lineTotal(i))}</td>`
      : "";
    const tickCell = moneyed ? "" : `<td class="tick-col"><span class="print-tick" aria-hidden="true"></span></td>`;
    return `<tr>${tickCell}<td>${esc(i.description)}${coreSub}</td><td>${i.part_number ? esc(i.part_number) : ""}</td>
      <td class="num-col">${i.quantity}</td>${moneyCells}<td>${status}</td></tr>`;
  };

  // Parts/Labor/Fees sub-headers replace the old Kind column -- the same
  // grouping (kindGroupsOf) the on-screen grid uses, so the paper and the
  // page it was printed from can't list different lines.
  const kindGroupRows = (bucketItems) =>
    kindGroupsOf(bucketItems)
      .map((g) => `<tr class="print-kind-head"><td colspan="${COLS}">${esc(KIND_GROUP_LABEL[g.kind] || g.kind)}</td></tr>` + g.kindItems.map(itemRow).join(""))
      .join("");

  // Same job/General buckets as the on-screen ticket (renderEstimate) --
  // a printed ticket that's grouped differently than what the advisor was
  // just looking at on screen would be confusing to hand to a technician.
  // One tbody per job so a page break can't strand a job title alone.
  // Job subtotals are money, so only the shop copy's job heads carry one.
  const jobHeadRow = (title, subtotalItems) => moneyed
    ? `<tr class="print-job-head"><td colspan="4">${title}</td><td class="num-col">${money(ticketTotal(subtotalItems))}</td><td></td></tr>`
    : `<tr class="print-job-head"><td colspan="${COLS}">${title}</td></tr>`;
  let bodyRows;
  if (!jobs.length) {
    bodyRows = `<tbody>${printItems.length ? kindGroupRows(printItems) : `<tr><td colspan="${COLS}">No parts or labor lines.</td></tr>`}</tbody>`;
  } else {
    const buckets = [...jobs, { id: null, title: "General" }];
    bodyRows = buckets.map((bucket) => {
      const bucketItems = printItems.filter((i) => (i.job_id ?? null) === bucket.id);
      if (!bucketItems.length) return "";
      const jobTech = bucket.id === null ? "" : (bucket.technician_name || "Use ticket default");
      const title = `${esc(bucket.title)}${jobTech ? ` — ${esc(jobTech)}` : ""}`;
      return `<tbody class="print-job">${jobHeadRow(title, bucketItems)}${kindGroupRows(bucketItems)}</tbody>`;
    }).join("") || `<tbody><tr><td colspan="${COLS}">No parts or labor lines.</td></tr></tbody>`;
  }

  // Invoice-style totals. With deposits (we-owe), the balance is the grand
  // row; without them Actual Cost is the bottom line itself.
  const totalsRows = [`<div class="tl-row"><span>Written Up</span><span class="num">${money(printWritten)}</span></div>`];
  if (paid > 0) {
    totalsRows.push(`<div class="tl-row"><span>Actual Cost</span><span class="num">${money(printActual)}</span></div>`);
    // The API returns payments newest-first; paper reads oldest-first.
    payments.slice().reverse().forEach((p) => totalsRows.push(
      `<div class="tl-row muted"><span>Deposit · ${PAY_METHOD_LABEL[p.method] || esc(p.method)} · ${esc(fmtDate(p.created_at))}</span><span class="num">−${money(p.amount)}</span></div>`));
    totalsRows.push(`<div class="tl-row grand"><span>Balance</span><span class="num">${money(item.net_cost)}</span></div>`);
  } else {
    totalsRows.push(`<div class="tl-row grand"><span>Actual Cost</span><span class="num">${money(printActual)}</span></div>`);
  }
  // net_cost/customer_paid roll up the whole vehicle, not just this RO --
  // say so whenever more than one RO shares them.
  const totalsNote = paid > 0 && (item.orders || []).length > 1
    ? `<div class="tl-note">Deposits and balance include all repair orders on this vehicle.</div>` : "";

  // Tech copy table: the tick box leads, and the money columns are gone.
  const headRow = moneyed
    ? `<tr><th>Description</th><th>Part #</th><th class="num-col">Qty</th><th class="num-col">Unit</th><th class="num-col">Total</th><th>Status</th></tr>`
    : `<tr><th class="tick-col"><span class="sr-only">Done</span></th><th>Description</th><th>Part #</th><th class="num-col">Qty</th><th>Status</th></tr>`;

  $("#print-report").innerHTML = `
    <header class="print-letterhead">
      <div>
        <div class="print-shop-name">RECON</div>
        <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
      </div>
      <div class="print-meta">
        <div class="print-report-title">Repair Order ${esc(order.number)}${moneyed ? "" : " — Technician Copy"}</div>
        <div>${esc(vehicleLabel)}${customerLabel ? " — " + esc(customerLabel) : ""}</div>
        <div class="print-meta-line">${esc(STATUS_LABEL[order.status] || order.status)} · ${segment === "recon" ? "Recon Inventory" : segment === "retail" ? "Customer Vehicle (Retail)" : "Customer Vehicle (We-Owe)"}</div>
        <div class="print-generated">Generated ${esc(generated)}</div>
      </div>
    </header>
    ${order.concern ? `<div class="print-concern"><div class="label">Concern</div><div class="text">${esc(order.concern)}</div></div>` : ""}
    <div class="print-info-grid">
      <div class="print-info-block">
        <div class="pi-label">Vehicle</div>
        ${kv("Year/Make/Model", esc([item.year, item.make, item.model].filter(Boolean).join(" ")))}
        ${kv("VIN", esc(item.vin || ""))}
        ${kv("Mileage", item.mileage ? `${item.mileage.toLocaleString()} mi` : "")}
        ${kv("Trim", esc(item.trim || ""))}
        ${kv("Engine", esc(item.engine || ""))}
        ${kv("Color", esc(item.color || ""))}
      </div>
      ${isWeOwe ? `
      <div class="print-info-block">
        <div class="pi-label">Customer</div>
        ${kv("Name", esc(item.customer_name || ""))}
        ${moneyed ? kv("Phone", esc(fmtPhone(item.customer_phone || ""))) : ""}
        ${moneyed ? kv("Email", esc(item.customer_email || "")) : ""}
        ${kv("We-Owe", esc(item.description || ""))}
      </div>` : `
      <div class="print-info-block">
        <div class="pi-label">Stock</div>
        ${kv("Stock #", esc(item.stock_number || ""))}
        ${kv("Source", esc(item.acquisition_source || ""))}
        ${kv("Acquired", item.acquisition_date ? esc(fmtDay(item.acquisition_date)) : "")}
      </div>`}
      <div class="print-info-block">
        <div class="pi-label">Service</div>
        ${kv("Technician", esc(techName))}
        ${kv("Advisor", esc(advisorName))}
        ${kv("Date in", a?.date_in ? esc(fmtDay(a.date_in)) : "")}
        ${kv("Odometer in", a?.odometer_in ? `${esc(String(a.odometer_in))} mi` : "")}
        ${kv("Promised", a?.promised_at ? esc(fmtDay(a.promised_at)) : "")}
        ${isWeOwe && item.target_date ? kv("Promised to customer", esc(fmtDay(item.target_date))) : ""}
      </div>
    </div>
    <div class="print-subhead">Parts &amp; Labor</div>
    <table class="print-table ticket${moneyed ? "" : " tech-copy"}">
      <thead>${headRow}</thead>
      ${bodyRows}
      <tfoot><tr class="tfoot-space" aria-hidden="true"><td colspan="${COLS}"></td></tr></tfoot>
    </table>
    ${moneyed ? `<div class="print-totals">${totalsRows.join("")}${totalsNote}</div>` : ""}
    ${printNotes.length ? `<div class="print-subhead">Notes</div><div class="print-notes">${printNotes.map((n) => `<div>${esc(n.text)}</div>`).join("")}</div>` : ""}
    ${moneyed && auth && auth.status === "approved" ? `<p class="print-note">Estimate approved by ${esc(auth.approved_by)}${AUTH_METHOD_LABEL[auth.method] ? ` ${AUTH_METHOD_LABEL[auth.method]}` : ""} · ${esc(fmtDate(auth.created_at))}</p>` : ""}
    ${moneyed ? "" : `
    <div class="print-writein">
      <div class="print-subhead">Found during repair</div>
      <div class="writein-rule"></div>
      <div class="writein-rule"></div>
      <div class="writein-rule"></div>
      <div class="writein-rule"></div>
    </div>`}
    <div class="print-sign">
      <div class="sign-cell"><div class="sign-rule"></div><div class="sign-label">${moneyed && isWeOwe ? "Customer Authorization" : "Technician Sign-Off"}</div></div>
      <div class="sign-cell"><div class="sign-rule"></div><div class="sign-label">Date</div></div>
    </div>
    <footer class="print-foot">
      <span>RECON · Discount Auto Repair</span>
      <span>Repair Order ${esc(order.number)}${moneyed ? "" : " · Technician Copy"} · ${esc(vehicleLabel)} · Generated ${esc(generated)}</span>
    </footer>
  `;
}

/* ---------- the lot card ----------
   The sheet that rides on the car. A recon lot is walked, not browsed: the
   person deciding what to do with a car is standing in front of it, and the
   answer to "what is this and what does it still need" lives back inside on
   a screen. This card goes under the wiper -- stock number readable through
   the windshield from the next row of cars, the work list with a tick box
   per repair, and never a dollar figure anywhere: it sits in a window where
   anyone on the lot can read it.

   A car with no ticket prints the card too, saying exactly that, with ruled
   lines to write on -- the walk around the car IS how the ticket gets
   started, and the sheet carries the notes back to the desk. */
function renderPrintLotCard() {
  // Same shared surface and the same ownership rule as the printed ticket:
  // anything but "report" keeps Reports' beforeprint rebuild off this page.
  state.printSurfaceOwner = "ticket";
  const { segment, item, order } = state.detail;
  const isWeOwe = segment === "we_owe";
  const printedOn = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const jobs = order?.estimate?.jobs ?? [];
  const items = order?.estimate?.items ?? [];

  // The identity block, loudest fact first. A recon car IS its stock number
  // -- that's what's said over the radio and written on the keytag. A we-owe
  // has no stock number; the banner says which kind of promise the car is,
  // and the customer's name carries the identity below it.
  const bigLabel = isWeOwe ? "WE-OWE" : (item.stock_number || "RECON");
  const vehicleName = [item.year, item.make, item.model].filter(Boolean).join(" ");
  const tags = [
    item.color ? esc(item.color) : "",
    item.plate ? `Plate ${esc(item.plate)}${item.plate_state ? ` (${esc(item.plate_state)})` : ""}` : "",
    // The same last-8 rule the board uses -- nobody scans 17 characters on
    // a windshield either. The full VIN is on the ticket.
    item.vin ? `VIN …${esc(String(item.vin).slice(-8))}` : "",
  ].filter(Boolean).join(" · ");

  // Where the car stands, and -- on a promise still owed -- the date the
  // customer was given, saying so plainly when that date is gone.
  // A ticketed car answers with its ticket's status -- the same word the
  // board's pill shows -- because the recon row's own enum ("in_repair") is
  // a database word no one at the shop says out loud.
  const VEHICLE_STATUS_LABEL = { acquired: "Acquired", in_repair: "In the Shop", ready: "Ready", retained: "Retained" };
  const statusLabel = order
    ? (order.voided ? "Voided" : (STATUS_LABEL[order.status] || order.status))
    : (VEHICLE_STATUS_LABEL[item.status] || STATUS_LABEL[item.status] || item.status || "");
  let promiseHtml = "";
  if (isWeOwe && item.target_date && (item.status === "open" || item.status === "in_progress")) {
    const days = calendarDaysUntil(item.target_date);
    const late = days !== null && days < 0 ? -days : 0;
    promiseHtml = `<span class="lc-promise${late ? " lc-late" : ""}">Promised for ${esc(fmtDay(item.target_date))}${
      late ? ` — ${late} day${late === 1 ? "" : "s"} past due` : days === 0 ? " — due today" : ""}</span>`;
  }

  // The work list. Jobs are the units a repair is talked about in, so they
  // are the lines; wrench lines that never got a job (or a ticket with no
  // jobs at all) list themselves. Fees and credits are money bookkeeping
  // with no wrench behind them -- same rule as the technician copy -- and a
  // returned part isn't work the car is waiting on.
  const wrenchLines = (list) => list.filter((i) => (i.kind === "part" || i.kind === "labor") && !isReturnedPart(i));
  const lines = [];
  for (const j of jobs) lines.push({ text: j.title, done: !!j.completed_at });
  const loose = jobs.length ? wrenchLines(items).filter((i) => (i.job_id ?? null) === null) : wrenchLines(items);
  for (const i of loose) lines.push({ text: i.description, done: false });
  const lineHtml = (l) => `<div class="lc-line${l.done ? " done" : ""}">
      <span class="print-tick${l.done ? " ticked" : ""}" aria-hidden="true"></span>
      <span class="lc-line-text">${esc(l.text)}</span>
    </div>`;

  // Parts that were ordered and haven't landed: the one thing that tells the
  // person at the car why nobody is working on it right now.
  const waiting = items.filter((i) => i.kind === "part" && i.status === "ordered" && !isReturnedPart(i)).length;

  let listHtml;
  if (!order) {
    listHtml = `<div class="print-subhead">No ticket written yet</div>
      <div class="print-group-note">Walk the car, write what it needs below, and hand this sheet to the desk.</div>
      <div class="print-writein lc-writein">
        <div class="writein-rule"></div><div class="writein-rule"></div>
        <div class="writein-rule"></div><div class="writein-rule"></div>
        <div class="writein-rule"></div><div class="writein-rule"></div>
      </div>`;
  } else if (!lines.length) {
    listHtml = `<div class="print-subhead">The work on this car</div>
      <div class="print-group-note">The ticket has no repair lines yet — see RECON for where it stands.</div>`;
  } else {
    listHtml = `<div class="print-subhead">The work on this car</div>
      <div class="lc-list">${lines.map(lineHtml).join("")}</div>
      ${waiting ? `<div class="lc-parts-note">${waiting} part${waiting === 1 ? "" : "s"} on order — not here yet</div>` : ""}`;
  }

  $("#print-report").innerHTML = `
    <div class="print-lotcard">
      <header class="print-letterhead">
        <div>
          <div class="print-shop-name">RECON</div>
          <div class="print-shop-sub">Discount Auto Repair · Merrillville, IN</div>
        </div>
        <div class="print-meta">
          <div class="print-report-title">Lot Card</div>
          <div class="print-generated">Printed ${esc(printedOn)}</div>
        </div>
      </header>
      <div class="lc-stock">${esc(bigLabel)}</div>
      <div class="lc-vehicle">${esc(vehicleName)}</div>
      ${tags ? `<div class="lc-tags">${tags}</div>` : ""}
      ${isWeOwe && item.customer_name ? `<div class="lc-customer">Customer: ${esc(item.customer_name)}</div>` : ""}
      <div class="lc-status">
        <span class="lc-status-word">${esc(statusLabel)}</span>
        ${promiseHtml}
      </div>
      ${listHtml}
      <footer class="print-foot">
        <span>RECON · Discount Auto Repair</span>
        <span>${order ? `Repair Order ${esc(order.number)} · ` : ""}No pricing on this sheet — costs live in RECON · Printed ${esc(printedOn)}</span>
      </footer>
    </div>
  `;
}

/* Step to the next or previous car in the board's current order, without
   going back to the board first. This is the morning walk: open the first
   car, read what it needs, flip to the next. The list is exactly what the
   board is showing -- same filters, same sort, both layouts -- so flipping
   here visits the same cars in the same order that arrowing down the board
   would, and the board's cursor follows so backing out lands on the car you
   were just looking at, not the one you started from.

   Only for cars that live on the board: a retail page's home is Customers,
   which has no car order to walk. A car the board's current filter can't see
   (opened from History search, or from a task chip while a filter narrows
   the board) has no neighbours either, so the keys quietly do nothing --
   same as pressing past the end of the list. */
function flipDetailCar(delta) {
  if (detailHomeView() !== "vehicles") return;
  const rows = displayedVehicles();
  const here = `${state.detail.segment}:${state.detail.id}`;
  const at = rows.findIndex((v) => vehicleKey(v) === here);
  const next = at === -1 ? null : rows[at + delta];
  if (!next) return;
  state.vehicleCursor = vehicleKey(next);
  applyVehicleCursor();
  openVehicleDetail(next.segment, next.segment === "recon" ? next.recon_id : next.we_owe_id);
}

/* ---------- vehicle-detail event wiring (wired once) ---------- */
export function wireVehicleDetail() {
  $("#back-to-vehicles").addEventListener("click", () => showView(detailHomeView()));

  /* The detail page's half of the keyboard model (see wireListKeyboard):
     Enter on the board opens a car, so Escape on the car backs out -- to the
     same screen the Back link goes to, with the cursor still on this car.
     Alt+Arrows flip through the board's cars directly; plain arrows keep
     scrolling this long page, which is what they already meant.

     The guards mirror wireListKeyboard's, plus this page's own popover
     menus: while any dialog or menu is open, Escape belongs to it (each one
     already closes itself), and a keystroke inside a field belongs to the
     field -- the grid's cells, the note box and the address dropdown all
     keep their own keys.

     Capture phase, deliberately: the menus close themselves from bubble
     listeners wired before this one, so by the time a bubble listener here
     saw the same Escape, the menu it should defer to had already closed and
     the key would fall through to "leave the page" -- one press closing the
     messages menu *and* the car. Capturing reads the menus as they were when
     the key was pressed, whatever order the wire* calls ran in. */
  document.addEventListener("keydown", (e) => {
    if (!$("#view-vehicle-detail").classList.contains("active")) return;
    if (document.querySelector('dialog[open], .notif-menu.open, .status-picker-menu.open, .ms-toggle[aria-expanded="true"]')) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // Used up right here: showView makes the board the active view mid-
      // dispatch, and the board's own bubble-phase Escape would then read
      // this same press as its own and drop the cursor this page just set.
      e.stopPropagation();
      showView(detailHomeView());
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      e.stopPropagation();
      flipDetailCar(e.key === "ArrowDown" ? 1 : -1);
    }
  }, true);

  $("#vd-start-ro").addEventListener("click", async () => {
    const concern = $("#vd-new-ro-concern").value.trim();
    if (!concern) return toast("Describe what's being done first", true);
    const { segment, id, item } = state.detail;
    const payload = { concern, segment, customer_id: null, vehicle_id: null };
    if (segment === "recon") payload.recon_vehicle_id = id;
    else if (segment === "retail") { payload.customer_id = item.customer_id; payload.vehicle_id = id; }
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

  // One listener on the strip itself -- the step buttons are rebuilt with
  // every render, the strip they sit in never is. Pressing the stage the
  // ticket is already at does nothing; unlike the old dropdown there is no
  // control left "reading Complete" when the close-out is backed out of,
  // because the lit step never moved.
  $("#vd-stage-strip").addEventListener("click", async (e) => {
    const btn = e.target instanceof Element && e.target.closest(".stage-step");
    if (!btn || btn.disabled || btn.classList.contains("current")) return;
    const status = btn.dataset.status;
    const order = state.detail.order;
    if (!order) return;
    if (status === "complete" && !(await confirmTicketCloseout(order))) return;
    await setTicketStatus(status);
  });

  $("#vd-concern-save").addEventListener("click", async (e) => {
    const concern = $("#vd-concern").value.trim();
    if (!concern) return toast("Concern can't be empty", true);
    await withLoading(e.target, "Saving…", async () => {
      try {
        await patch(`/api/orders/${state.detail.order.id}/concern`, { concern });
        toast("Concern updated");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $("#vd-concern").addEventListener("input", sizeConcernBox);
  // The strip gets wider and narrower as the details drawer swings and the
  // window resizes, and a box measured in the narrow layout keeps a stale
  // second line in the wide one. Only a width change re-measures -- reacting
  // to the height this very function sets would chase its own tail.
  const concernStrip = $("#vd-concern").closest(".concern-strip");
  if (concernStrip && typeof ResizeObserver === "function") {
    let lastWidth = 0;
    let pending = 0;
    new ResizeObserver(() => {
      const width = Math.round(concernStrip.getBoundingClientRect().width);
      if (width === lastWidth) return;
      lastWidth = width;
      // Resized on the next frame, not inside the callback. sizeConcernBox
      // sets the textarea's height, and changing layout while the browser is
      // still delivering resize notifications is what produces "ResizeObserver
      // loop completed with undelivered notifications" -- which the global
      // error handler then showed the shop as a red "Something went wrong".
      // Nothing was ever wrong; the measurement just has to happen after the
      // browser has finished the pass it is in the middle of.
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = 0;
        sizeConcernBox();
      });
    }).observe(concernStrip);
  }
  // Everything else on this page autosaves; the concern shouldn't silently
  // lose an edit because the Save button never got clicked before navigating
  // away. Blur commits quietly when the text actually changed.
  $("#vd-concern").addEventListener("blur", async () => {
    const order = state.detail.order;
    if (!order) return;
    const concern = $("#vd-concern").value.trim();
    if (!concern || concern === (order.concern || "").trim()) return;
    try {
      await patch(`/api/orders/${order.id}/concern`, { concern });
      order.concern = concern;
      toast("Concern updated");
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Which copy comes out of the printer. Enter still means the full shop
  // copy, so the habit of Print-then-Enter keeps doing what it always did;
  // the technician copy is the same sheet with every dollar figure left off,
  // for handing across the counter.
  $("#vd-print-ticket").addEventListener("click", async () => {
    const choice = await confirmAction({
      eyebrow: "PRINT",
      title: "Which copy?",
      body: "The shop copy is the whole ticket, money included. The technician copy is the work list with no pricing on it — a tick box per line and room to write down what was found.",
      confirmLabel: "Shop Copy",
      altLabel: "Technician Copy",
    });
    if (!choice) return;
    renderPrintTicket(choice === "alt" ? "tech" : "shop");
    window.print();
  });

  // One click, one sheet -- no copy to choose. The card only ever has the
  // one moneyless form, so a dialog here would be a question with no answer
  // to give.
  $("#vd-print-card").addEventListener("click", () => {
    renderPrintLotCard();
    window.print();
  });

  $("#vd-add-task").addEventListener("click", () => addTaskForThisVehicle());
  // Same jump as + Task, minus the empty title box: this one is for going to
  // look at the queue, not to add to it.
  $("#vd-tasks-open").addEventListener("click", () => addTaskForThisVehicle());

  $("#vd-archive-vehicle").addEventListener("click", async () => {
    const { segment, id, item } = state.detail;
    if (!(await confirmAction({
      eyebrow: "ARCHIVE",
      title: "Send this vehicle to History?",
      // A car filed away stops being looked at, so this is the last chance
      // anyone has to notice money the app can't see.
      body: "It becomes read-only until reopened. Nothing is deleted." + missingReceiptWarning(vehicleUnreceived(item)),
      confirmLabel: "Send to History",
    }))) return;
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

  $("#vd-move-segment").addEventListener("click", openMoveSegmentDialog);

  $("#vd-void-order").addEventListener("click", async () => {
    if (!(await confirmAction({
      eyebrow: "VOID TICKET",
      title: "Void this repair order?",
      body: "Its cost stops counting toward the vehicle's total. This can't be undone.",
      confirmLabel: "Void Ticket",
      danger: true,
    }))) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/void`, {});
      toast("Ticket voided");
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#vd-add-part").addEventListener("click", () => addEstimateRow("part"));
  $("#vd-add-labor").addEventListener("click", () => addEstimateRow("labor"));

  $("#vd-order-parts").addEventListener("click", async () => {
    // One click flips every quoted part on the ticket -- worth a question,
    // and the "doesn't place a real purchase order" caveat that used to hide
    // in a hover-only title belongs in it.
    const quoted = (state.detail.order?.estimate?.items || [])
      .filter((i) => i.kind === "part" && i.id && (i.status || "quoted") === "quoted").length;
    if (!quoted) return toast("No quoted parts to order");
    if (!(await confirmAction({
      eyebrow: "ORDER PARTS",
      title: `Mark ${quoted} quoted part line${quoted === 1 ? "" : "s"} as ordered?`,
      body: "They all go on one PO number, which you'll get back to give the vendor.",
      confirmLabel: "Mark Ordered",
    }))) return;
    try {
      const res = await patch(`/api/orders/${state.detail.order.id}/estimate/order-parts`, {});
      // The PO number is the thing needed next, so it goes in the toast and
      // onto the clipboard rather than making the advisor hunt for it.
      if (res.updated && res.purchase_order) {
        await copyText(res.purchase_order.number, `${res.updated} line(s) on PO ${res.purchase_order.number} —`);
      } else {
        toast("No quoted parts to order");
      }
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* Pull a PO number before the call, which is when it is actually needed.
     One click: it takes the next number, copies it, and says what it is. No
     dialog and no vendor picker -- an advisor doing this has a phone in the
     other hand, and anything more would simply not get used on a busy
     morning. */
  $("#vd-new-po").addEventListener("click", async () => {
    try {
      const po = await post(`/api/orders/${state.detail.order.id}/purchase-orders`, {});
      await copyText(po.number, `PO ${po.number} —`);
      await loadVehicleDetail();
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* Clicking a batch lights up its own parts in the grid below -- "which of
     these lines is this delivery?", answered without reading a single part
     number. Clicking it again clears it. */
  $("#vd-po-strip").addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const drop = t.closest("[data-drop-po]");
    if (drop) {
      try {
        await api(`/api/orders/${state.detail.order.id}/purchase-orders/${drop.dataset.dropPo}`, { method: "DELETE" });
        toast("PO number removed");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    // Only the number itself toggles the highlight. The supplier box sits
    // inside the chip and must be clickable without lighting up the grid.
    const chip = t.closest(".po-chip-main") && t.closest(".po-chip");
    if (!chip) return;
    const wasActive = chip.classList.contains("po-chip-active");
    $$(".po-chip", $("#vd-po-strip")).forEach((c) => c.classList.remove("po-chip-active"));
    $$(".part-row", $("#vd-estimate-items")).forEach((r) => r.classList.remove("po-highlight"));
    if (wasActive) return;
    chip.classList.add("po-chip-active");
    $$(`.part-row[data-po="${chip.dataset.po}"]`, $("#vd-estimate-items")).forEach((r) => r.classList.add("po-highlight"));
  });

  /* Recording the supplier. `change` rather than every keystroke: it fires on
     Enter, on tab, and on clicking away, which covers every way somebody
     finishes typing a name -- and it does not fire when nothing was edited,
     so simply tabbing across the strip writes nothing. */
  $("#vd-po-strip").addEventListener("focusin", (e) => {
    if (e.target instanceof Element && e.target.classList.contains("po-chip-vendor")) fillVendorOptions();
  });
  $("#vd-po-strip").addEventListener("change", async (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("po-chip-vendor")) return;
    const name = input.value.trim();
    if (name === input.dataset.was) return;
    try {
      await patch(`/api/orders/${state.detail.order.id}/purchase-orders/${input.dataset.poId}`, {
        vendor_name: name,
      });
      // A name typed here can create a vendor, so the cached list is stale.
      state.vendors = [];
      toast(name ? `Supplier saved — ${name}` : "Supplier cleared");
      await loadVehicleDetail();
    } catch (err) {
      input.value = input.dataset.was || "";
      toast(err.message, true);
    }
  });

  $("#vd-receive-parts").addEventListener("click", () => openReceiveDialog());

  const addNote = async () => {
    const text = $("#vd-note-text").value.trim();
    if (!text) return;
    try {
      await post(`/api/orders/${state.detail.order.id}/notes`, { text, visibility: $("#vd-note-visibility").value });
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

  /* The two Save buttons on the Assigned card write different halves of one
     record, and each now sends only its own half. Both used to send all five
     fields from whatever the page was showing, which had two everyday costs:
     saving a mileage on the Timing card silently stamped the pre-selected
     advisor onto a ticket nobody had assigned, and a save from either button
     overwrote a change the other workstation had just made. Anything left out
     of the payload is now left alone by the server.

     expected_version is the version this page loaded. If someone else saved
     the same ticket in between, the save is refused with a message telling
     you to reload rather than quietly winning. */
  const UNASSIGN = -1;
  const saveAssignment = async (e, fields) => {
    await withLoading(e.target, "Saving…", async () => {
      try {
        await put(`/api/orders/${state.detail.order.id}/assignment`, {
          ...fields,
          expected_version: state.detail.order.assignment?.version ?? null,
        });
        toast("Saved");
        // Close the popover so the save visibly took -- it used to stay
        // open looking like nothing happened.
        $("#vd-assign-picker-menu")?.classList.remove("open");
        await loadVehicleDetail();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };
  // Picking "Unassigned" is a real choice, not an omission, so it sends the
  // sentinel that clears the field rather than nothing at all.
  const pickedStaff = (id) => (($(id).value && Number($(id).value)) || UNASSIGN);
  $("#vd-save-assignment").addEventListener("click", (e) => saveAssignment(e, {
    advisor_id: pickedStaff("#vd-advisor"),
    technician_id: pickedStaff("#vd-technician"),
  }));
  $("#vd-save-timing").addEventListener("click", (e) => saveAssignment(e, {
    date_in: $("#vd-date-in").value,
    odometer_in: Number($("#vd-odometer").value || 0),
    promised_at: $("#vd-promised").value,
  }));

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
  // Enter in the Amount field used to fall through the form with no submit
  // handler -- record the deposit instead of doing nothing.
  $("#payment-form").addEventListener("submit", (e) => {
    e.preventDefault();
    $("#vd-deposit-add").click();
  });

  $("#vd-edit-vehicle").addEventListener("click", () => $("#vehicle-edit-dialog").showModal());
  $("#vehicle-edit-cancel").addEventListener("click", () => $("#vehicle-edit-dialog").close());
  $("#vehicle-edit-cancel-2").addEventListener("click", () => $("#vehicle-edit-dialog").close());

  $("#vd-edit-customer").addEventListener("click", () => {
    // The detail payload carries the customer flattened under customer_*
    // prefixes; the shared editor (see wireCustomerEditor) speaks plain
    // customer rows, because it also serves the Customers screen, which
    // has the real rows.
    const { item } = state.detail;
    openCustomerEditor({
      id: item.customer_id,
      name: item.customer_name, phone: item.customer_phone, email: item.customer_email,
      address_line1: item.customer_address_line1, address_line2: item.customer_address_line2,
      city: item.customer_city, state: item.customer_state, postal_code: item.customer_postal_code,
    }, () => loadVehicleDetail());
  });

  // Other Vehicles card (retail only): put the customer's second car on file
  // and land on its page, where the natural next click is "Start Repair
  // Order" -- the same landing the Customers screen's Write RO flow uses.
  $("#vd-add-other-vehicle").addEventListener("click", () => {
    const { item } = state.detail;
    openAddVehicleDialog(item.customer_id, item.customer_name, (created) => {
      delete state.customerDetails[item.customer_id]; // Customers expansion is stale now
      openVehicleDetail("retail", created.id);
    });
  });

  wirePlateFields("#vd-recon-plate", "#vd-recon-plate-state");

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
          plate: $("#vd-recon-plate").value.trim(),
          plate_state: $("#vd-recon-plate-state").value.trim(),
          expected_version: item.edit_version,
        };
        if (segment === "recon") {
          // Only recon carries an arrival date and a stock number, and only
          // recon's endpoint knows those fields -- see the rows' hidden state
          // above. The stock number is left out entirely when the box is
          // blank, so an empty field is "no change" rather than a request to
          // erase the number the whole board finds this car by.
          payload.acquisition_date = $("#vd-recon-acquired").value;
          const stock = $("#vd-recon-stock").value.trim();
          if (stock) payload.stock_number = stock;
          await patch(`/api/recon/vehicles/${id}`, payload);
        } else if (segment === "retail") {
          await patch(`/api/retail/vehicles/${id}`, payload);
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
    if (!(await confirmAction({
      eyebrow: "DELETE",
      title: `Delete ${label}?`,
      body: "The vehicle, its repair order, and everything on it are removed permanently. This can't be undone -- send it to History instead if you only want it off the board.",
      confirmLabel: "Delete Permanently",
      danger: true,
    }))) return;
    try {
      await api(segment === "recon" ? `/api/recon/vehicles/${id}` : `/api/we-owe/${id}`, { method: "DELETE" });
      toast("Deleted");
      showView("vehicles");
    } catch (err) {
      toast(err.message, true);
    }
  });
}


// The drawer module (REDESIGN ADDITIONS) decorates the status-card render
// without this module knowing how. It used to reassign the function binding,
// which ES modules forbid -- so the decoration goes through this hook.
let renderStatusCardImpl = renderStatusCardBase;
function renderStatusCard(order) {
  return renderStatusCardImpl(order);
}
export function overrideRenderStatusCard(wrap) {
  renderStatusCardImpl = wrap(renderStatusCardImpl);
}
