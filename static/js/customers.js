import { $, $$, get, patch, post } from "./core.js";
import { toast } from "./notify.js";
// fmtDay used to be a private copy here, for the Last Visit column. It is
// shared now: the ticket printer needed the same "a day, not a timestamp"
// answer, and two functions of the same name in two modules become one
// arbitrary winner in the flattened bundle the DOM tests run against.
import { esc, fmtDay, withLoading } from "./shortcuts.js";
import { emptyRow } from "./empty-states.js";
import { CUSTOMER_COLUMNS } from "./skeletons.js";
import { STATUS_LABEL, STATUS_PILL_CLASS, state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { wireListKeyboard } from "./list-keyboard.js";
import { US_STATE_CODES, emailFieldOk, fmtPhone, focusInvalidField, hideAddressSuggestions, openVehicleDetail, phoneDigits, phoneFieldOk, setupAddressAutocomplete, wirePhoneInput } from "./vehicle-detail.js";

/* ==================================================================
   CUSTOMERS

   Until this screen existed, a customer's phone number was only reachable
   by remembering which car they own and going through the board -- fine
   for "the Civic that's on the lift", useless for "Mrs. Alvarez is on
   line two". This is the shop's rolodex: everyone a ticket has ever been
   written for, searchable by anything you'd know about them mid-phone-call
   (name, number, email, city), with their vehicles and every RO's status
   one click deep. Rows expand in place rather than navigating away --
   the caller is on hold; losing the list to a detail page costs the
   context of the search that found them.
   ================================================================== */
export async function loadCustomersView() {
  try {
    state.customers = await get("/api/customers");
  } catch (err) {
    return renderViewFailure("customers", err);
  }
  // Fresh visit, fresh details: the cached expansions are only trusted
  // within one load of the list, so a ticket closed from the board shows
  // its new status the next time the row is opened. The open row collapses
  // too -- otherwise a row left expanded before jumping to a vehicle would
  // come back as a permanent "Loading…" with no fetch in flight.
  state.customerDetails = {};
  state.customerOpenId = null;
  renderCustomersStats();
  renderCustomersTable();
}

function customerHasContact(c) {
  return Boolean(String(c.phone || "").trim() || String(c.email || "").trim());
}

// One reading of "the shop still owes this person work", used by the column,
// the stat card and the card's filter so the three can never disagree about
// who is on the hook list. Archived promises are already excluded server-side.
function openPromises(c) {
  return Number(c.we_owe_open || 0);
}

function visibleCustomers() {
  const query = state.customersSearch.trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, "");
  let rows = state.customers.filter((c) => {
    if (state.customerFilter === "open" && !c.open_orders) return false;
    if (state.customerFilter === "owed" && !openPromises(c)) return false;
    if (state.customerFilter === "no_contact" && customerHasContact(c)) return false;
    if (!query) return true;
    // Phone matches on digits so "(219) 555" and "2195 55" both find the
    // number however it was stored.
    if (queryDigits.length >= 3 && phoneDigits(c.phone).includes(queryDigits)) return true;
    return [c.name, c.email, c.city, c.state]
      .some((field) => String(field || "").toLowerCase().includes(query));
  });
  // Alphabetical, not insertion order: this list is read like a phone book,
  // and "newest customer first" answers a question nobody brings to it.
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

// Single writer for state.customerFilter -- the stat cards are the only
// control, and re-rendering both keeps the pressed states truthful.
function applyCustomerFilter(filter) {
  state.customerFilter = state.customerFilter === filter ? "" : filter;
  state.customerCursor = null;
  renderCustomersStats();
  renderCustomersTable();
}

function resetCustomerView() {
  state.customersSearch = "";
  state.customerFilter = "";
  state.customerCursor = null;
  const box = $("#customers-search");
  if (box) box.value = "";
  renderCustomersStats();
  renderCustomersTable();
}

function renderCustomersStats() {
  const all = state.customers;
  const vehicles = all.reduce((n, c) => n + (c.vehicle_count || 0), 0);
  const withOpen = all.filter((c) => c.open_orders > 0).length;
  const owed = all.filter((c) => openPromises(c) > 0).length;
  const promises = all.reduce((n, c) => n + openPromises(c), 0);
  const noContact = all.filter((c) => !customerHasContact(c)).length;
  const openOn = state.customerFilter === "open";
  const owedOn = state.customerFilter === "owed";
  const contactOn = state.customerFilter === "no_contact";
  $("#customers-stats").innerHTML = `
    <div class="stat">
      <div class="stat-label">Customers</div>
      <div class="stat-value">${all.length}</div>
      <div class="stat-sub">${all.length ? "everyone a ticket was written for" : "none on file yet"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Vehicles on File</div>
      <div class="stat-value">${vehicles}</div>
      <div class="stat-sub">${vehicles === 1 ? "customer-owned vehicle" : "customer-owned vehicles"}</div>
    </div>
    <button type="button" class="stat stat-action" data-customer-filter="open" aria-pressed="${openOn}" ${withOpen || openOn ? "" : "disabled"} title="${openOn ? "Showing customers with open ROs — click to clear" : (withOpen ? "Show only customers with open repair orders" : "")}">
      <div class="stat-label">With Open ROs</div>
      <div class="stat-value">${withOpen}</div>
      <div class="stat-sub">${withOpen ? "have work in the shop right now" : "no open repair orders"}</div>
    </button>
    <button type="button" class="stat stat-action" data-customer-filter="owed" aria-pressed="${owedOn}" ${owed || owedOn ? "" : "disabled"} title="${owedOn ? "Showing customers still owed a we-owe — click to clear" : (owed ? "Show only customers the shop still owes work" : "")}">
      <div class="stat-label">Owed a We-Owe</div>
      <div class="stat-value${owed ? " warn" : ""}">${owed}</div>
      <div class="stat-sub">${owed ? `${promises} promise${promises === 1 ? "" : "s"} still open` : "nothing promised outstanding"}</div>
    </button>
    <button type="button" class="stat stat-action" data-customer-filter="no_contact" aria-pressed="${contactOn}" ${noContact || contactOn ? "" : "disabled"} title="${contactOn ? "Showing customers with no contact info — click to clear" : (noContact ? "Show customers the shop has no way to reach" : "")}">
      <div class="stat-label">Missing Contact</div>
      <div class="stat-value${noContact ? " warn" : ""}">${noContact}</div>
      <div class="stat-sub">${noContact ? "no phone or email on file" : "everyone is reachable"}</div>
    </button>`;
}

// A we-owe's target date is a bare calendar date ("2026-08-15"), not a moment.
// new Date() reads those as UTC midnight, and Indiana is hours behind UTC, so
// running one through fmtDay prints the day before -- a promise due Saturday
// shown as due Friday. Split the string instead of parsing it.
function fmtCalendarDay(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!parts) return fmtDay(value);
  const [, year, month, day] = parts;
  return new Date(Number(year), Number(month) - 1, Number(day))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function customerRowHtml(c, open) {
  const phone = fmtPhone(c.phone);
  const email = String(c.email || "").trim();
  const contact = [
    phone ? `<div>${esc(phone)}</div>` : "",
    email ? `<div class="cust-sub">${esc(email)}</div>` : "",
  ].join("") || '<span class="muted-dash">—</span>';
  const place = [c.city, c.state].map((s) => String(s || "").trim()).filter(Boolean).join(", ");
  const since = c.created_at ? String(new Date(c.created_at).getFullYear()) : "";
  const ros = c.order_count
    ? `${c.order_count}${c.open_orders ? ` <span class="cust-open-badge">· ${c.open_orders} open</span>` : ""}`
    : '<span class="muted-dash">—</span>';
  // The We-Owe cell reads "how many promises are still owed", not "how many
  // were ever made" -- a settled promise is not something anyone needs to
  // scan for. When they're all settled the count is still worth saying
  // quietly, because "0 owed" and "never promised anything" are different
  // answers to give someone on the phone.
  const owedCount = openPromises(c);
  const owed = owedCount
    ? `<span class="cust-owed-badge">${owedCount} owed</span>`
    : (c.we_owe_count ? `<span class="cust-sub">${c.we_owe_count} settled</span>` : '<span class="muted-dash">—</span>');
  return `
    <tr class="clickable${open ? " cust-open" : ""}" data-id="${c.id}" aria-expanded="${open}">
      <td><strong>${esc(c.name)}</strong>${since ? `<div class="cust-sub">customer since ${since}</div>` : ""}</td>
      <td>${contact}</td>
      <td>${place ? esc(place) : '<span class="muted-dash">—</span>'}</td>
      <td class="num-col">${c.vehicle_count || '<span class="muted-dash">—</span>'}</td>
      <td class="num-col">${ros}</td>
      <td class="num-col">${owed}</td>
      <td>${c.last_visit_at ? esc(fmtDay(c.last_visit_at)) : '<span class="muted-dash">never</span>'}</td>
    </tr>
    ${open ? customerExpandRowHtml(c) : ""}`;
}

// A promise's own chip, above the vehicle's repair-order chips. It jumps to
// the same we-owe page the promise's ticket would, which is where a ticket
// for promised work is started -- so the advisor who came here looking for
// "what were we supposed to do for them?" lands somewhere they can act.
const WE_OWE_PILL_CLASS = { open: "pill-status-pending", fulfilled: "pill-status-complete", waived: "pill-inactive" };

function promiseChipHtml(p) {
  const status = STATUS_LABEL[p.status] || p.status;
  const pill = WE_OWE_PILL_CLASS[p.status] || "";
  // Only ever said about a promise that is still owed: "no ticket written
  // yet" on a fulfilled or waived promise is noise, not a nudge.
  const bits = [
    p.archived_at ? "History" : "",
    p.status === "open" && !p.order_count ? "no ticket yet" : "",
    p.target_date ? `due ${fmtCalendarDay(p.target_date)}` : "",
  ].filter(Boolean);
  return `<button type="button" class="cust-owe-chip" data-owe-id="${p.id}" title="Open this we-owe promise">
      <span class="cust-owe-what">${esc(p.description)}</span>
      <span class="pill ${pill}">${esc(status)}</span>
      ${bits.length ? `<span class="cust-sub">${esc(bits.join(" · "))}</span>` : ""}
    </button>`;
}

/* The expansion: contact block on the left, vehicles-with-their-promises-and-ROs
   on the right. Every unvoided chip jumps to the vehicle detail page -- recon
   and we-owe to their container's page, retail to the vehicle's own retail
   page. Voided ROs stay visible but inert: there's nothing left to do on them.
   Each vehicle also gets a Write RO button -- this is where a retail ticket
   for an existing customer starts.

   Promises sit above the tickets because they come first in time and in the
   conversation: the promise is the reason the car is coming back, and it can
   exist for weeks before anyone writes a ticket against it. */
function customerExpandRowHtml(c) {
  const detail = state.customerDetails[c.id];
  let body;
  if (!detail) {
    body = '<div class="cust-loading">Loading…</div>';
  } else {
    const addr = [detail.address_line1, detail.address_line2,
      [detail.city, detail.state].filter(Boolean).join(", ") + (detail.postal_code ? ` ${detail.postal_code}` : "")]
      .map((s) => String(s || "").trim()).filter(Boolean);
    const phone = fmtPhone(detail.phone);
    const email = String(detail.email || "").trim();
    const contact = [
      phone ? `<a href="tel:${esc(phoneDigits(detail.phone))}">${esc(phone)}</a>` : "",
      email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "",
      ...addr.map((line) => `<span>${esc(line)}</span>`),
    ].filter(Boolean).join("");
    const vehicles = detail.vehicles.length ? detail.vehicles.map((v) => {
      const name = [v.year, v.make, v.model].filter(Boolean).join(" ");
      const meta = [v.plate ? `${esc(v.plate)}${v.plate_state ? ` (${esc(v.plate_state)})` : ""}` : "", v.vin ? esc(v.vin) : ""]
        .filter(Boolean).join(" · ");
      const orders = v.orders.length ? v.orders.map((o) => {
        const status = o.voided ? "Voided" : (STATUS_LABEL[o.status] || o.status);
        const pill = o.voided ? "pill-inactive" : (STATUS_PILL_CLASS[o.status] || "");
        const label = `${esc(o.number)} <span class="pill ${pill}">${esc(status)}</span>`;
        const refId = o.segment === "recon" ? o.recon_vehicle_id : o.segment === "we_owe" ? o.we_owe_id : v.id;
        const jumpable = !o.voided && refId != null;
        return jumpable
          ? `<button type="button" class="cust-ro-chip" data-seg="${esc(o.segment)}" data-ref-id="${refId}" title="${esc(o.concern || "Open this repair order")}">${label}</button>`
          : `<span class="cust-ro-chip cust-ro-static" title="${esc(o.concern || "")}">${label}</span>`;
      }).join("") : '<span class="cust-sub">no repair orders yet</span>';
      const promises = (v.we_owe || []).map(promiseChipHtml).join("");
      // Said on the button itself so the warning arrives before the click,
      // not only inside the dialog it opens.
      const stillOwed = (v.we_owe || []).some((p) => p.status === "open" && !p.archived_at);
      return `
        <div class="cust-vehicle">
          <div class="cust-vehicle-name">${esc(name)}${meta ? `<span class="cust-sub"> · ${meta}</span>` : ""}
            <button type="button" class="btn btn-ghost btn-sm cust-new-ro" data-vehicle-id="${v.id}" title="${stillOwed ? "Start a retail (paid) repair order — promised work belongs on the we-owe above" : "Start a retail repair order on this vehicle"}">+ Write RO</button>
          </div>
          ${promises ? `<div class="cust-owe-chips">${promises}</div>` : ""}
          <div class="cust-ro-chips">${orders}</div>
        </div>`;
    }).join("") : '<div class="cust-sub">No vehicles on file.</div>';
    body = `
      <div class="cust-expand-grid">
        <div class="cust-contact-block">
          ${contact || '<span class="cust-sub">No contact info on file.</span>'}
          <button type="button" class="btn btn-ghost btn-sm cust-edit" data-id="${c.id}">Edit Customer</button>
        </div>
        <div class="cust-vehicles">${vehicles}
          <div><button type="button" class="btn btn-ghost btn-sm cust-add-vehicle" data-id="${c.id}" title="Put another of this customer's vehicles on file">+ Add Vehicle</button></div>
        </div>
      </div>`;
  }
  return `<tr class="cust-expand-row" data-expand-for="${c.id}"><td colspan="${CUSTOMER_COLUMNS}">${body}</td></tr>`;
}

function renderCustomersTable() {
  const rows = visibleCustomers();
  const query = state.customersSearch.trim();
  const filtered = Boolean(query || state.customerFilter);
  $("#customers-reset-view").hidden = !filtered;
  $("#customers-count").textContent = filtered
    ? `${rows.length} of ${state.customers.length} customers`
    : `${rows.length} customer${rows.length === 1 ? "" : "s"}`;

  if (state.customerCursor && !rows.some((c) => c.id === state.customerCursor)) state.customerCursor = null;
  if (state.customerOpenId && !rows.some((c) => c.id === state.customerOpenId)) state.customerOpenId = null;

  if (!rows.length) {
    $("#customers-table").innerHTML = emptyRow(CUSTOMER_COLUMNS, filtered
      ? { icon: "search", title: "No customers match", hint: query ? `Nothing matched "${query}".` : "Nothing matches this filter.",
          actions: '<button type="button" class="btn btn-ghost btn-sm" id="customers-empty-clear">Clear search &amp; filters</button>' }
      : { icon: "staff", title: "No customers yet",
          hint: "Customers appear here automatically the first time a repair order or We-Owe promise is written for them." });
    $("#customers-empty-clear")?.addEventListener("click", () => resetCustomerView());
    return;
  }
  $("#customers-table").innerHTML = rows.map((c) => customerRowHtml(c, c.id === state.customerOpenId)).join("");
  applyCustomerCursor();
}

function applyCustomerCursor() {
  $$("#customers-table tr.cursor").forEach((tr) => tr.classList.remove("cursor"));
  if (!state.customerCursor) return;
  $(`#customers-table tr[data-id="${state.customerCursor}"]`)?.classList.add("cursor");
}

function moveCustomerCursor(delta) {
  const ids = visibleCustomers().map((c) => c.id);
  if (!ids.length) return;
  const at = state.customerCursor ? ids.indexOf(state.customerCursor) : -1;
  let next;
  if (delta === "first") next = 0;
  else if (delta === "last") next = ids.length - 1;
  else next = at === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
  state.customerCursor = ids[next];
  applyCustomerCursor();
  const tr = $(`#customers-table tr[data-id="${state.customerCursor}"]`);
  if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
}

async function toggleCustomerExpand(id) {
  if (state.customerOpenId === id) {
    state.customerOpenId = null;
    renderCustomersTable();
    return;
  }
  state.customerOpenId = id;
  renderCustomersTable(); // paints "Loading…" if the detail isn't cached yet
  if (!state.customerDetails[id]) {
    try {
      const detail = await get(`/api/customers/${id}`);
      state.customerDetails[id] = detail;
    } catch (err) {
      state.customerOpenId = null;
      renderCustomersTable();
      return toast(`Could not load customer: ${err.message}`, true);
    }
    // Only repaint if this row is still the open one -- the advisor may have
    // moved on while the fetch was in flight.
    if (state.customerOpenId === id) renderCustomersTable();
  }
}

export function wireCustomersView() {
  $("#customers-search").addEventListener("input", (e) => {
    state.customersSearch = e.target.value;
    state.customerCursor = null;
    renderCustomersTable();
  });
  $("#customers-reset-view").addEventListener("click", () => resetCustomerView());

  $("#customers-stats").addEventListener("click", (e) => {
    const card = e.target.closest("[data-customer-filter]");
    if (card && !card.disabled) applyCustomerFilter(card.dataset.customerFilter);
  });

  $("#customers-table").addEventListener("click", (e) => {
    const edit = e.target.closest(".cust-edit");
    if (edit) {
      const customer = state.customerDetails[Number(edit.dataset.id)];
      if (customer) openCustomerEditorFor(customer);
      return;
    }
    const newRo = e.target.closest(".cust-new-ro");
    if (newRo) {
      openRetailRoDialog(Number(newRo.dataset.vehicleId));
      return;
    }
    const addVehicle = e.target.closest(".cust-add-vehicle");
    if (addVehicle) {
      const id = Number(addVehicle.dataset.id);
      const row = state.customers.find((c) => c.id === id);
      openAddVehicleDialog(id, row ? row.name : "", () => {
        // Refetch the expansion (new car, no ROs yet) and bump the list
        // row's vehicle count without a full-screen reload.
        delete state.customerDetails[id];
        state.customers = state.customers.map((c) => (c.id === id ? { ...c, vehicle_count: (c.vehicle_count || 0) + 1 } : c));
        if (state.customerOpenId === id) {
          state.customerOpenId = null;
          toggleCustomerExpand(id);
        } else {
          renderCustomersTable();
        }
      });
      return;
    }
    const chip = e.target.closest(".cust-ro-chip[data-seg]");
    if (chip) {
      openVehicleDetail(chip.dataset.seg, Number(chip.dataset.refId));
      return;
    }
    const oweChip = e.target.closest(".cust-owe-chip[data-owe-id]");
    if (oweChip) {
      openVehicleDetail("we_owe", Number(oweChip.dataset.oweId));
      return;
    }
    if (e.target.closest("a")) return; // tel:/mailto: links do their own thing
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = Number(tr.dataset.id);
    state.customerCursor = id;
    applyCustomerCursor();
    toggleCustomerExpand(id);
  });

  // The shared triage-list keyboard model (see wireListKeyboard). Enter
  // expands/collapses the cursor row; there's no selection on this list, so
  // Space is left to the browser (scroll).
  wireListKeyboard({
    view: "#view-customers",
    search: "#customers-search",
    searchEscape: (box) => {
      box.value = "";
      state.customersSearch = "";
      state.customerCursor = null;
      renderCustomersTable();
      box.blur();
    },
    move: (delta) => moveCustomerCursor(delta),
    primary: () => { if (state.customerCursor) toggleCustomerExpand(state.customerCursor); },
    select: () => false,
    escape: () => {
      if (state.customerOpenId) {
        state.customerOpenId = null;
        renderCustomersTable();
      } else if (state.customersSearch || state.customerFilter) {
        resetCustomerView();
      } else if (state.customerCursor) {
        state.customerCursor = null;
        applyCustomerCursor();
      }
    },
  });
}

// Open the shared customer editor for a customer as this screen knows them,
// then fold the save back into both the list row and the cached expansion.
function openCustomerEditorFor(customer) {
  openCustomerEditor(customer, (updated) => {
    state.customers = state.customers.map((c) => (c.id === updated.id ? { ...c, ...updated } : c));
    // The expansion re-fetches on next open; simplest way to keep the
    // address block honest without hand-merging two payload shapes.
    delete state.customerDetails[updated.id];
    if (state.customerOpenId === updated.id) {
      state.customerOpenId = null;
      toggleCustomerExpand(updated.id);
    }
    renderCustomersStats();
    renderCustomersTable();
  });
}

/* ---------- write a retail RO (Customers screen) ----------
   The one place a retail ticket for an existing customer can start. The
   button lives on the vehicle row inside the expansion, so the customer and
   vehicle are already chosen -- the dialog only asks the one thing the
   advisor actually has to type: what's being done. On success we land on
   the vehicle's retail detail page, same as clicking the new chip would. */
let retailRoTarget = null; // { customer, vehicle } while the dialog is open

function openRetailRoDialog(vehicleId) {
  const customer = state.customerDetails[state.customerOpenId];
  const vehicle = customer && (customer.vehicles || []).find((v) => v.id === vehicleId);
  if (!vehicle) return;
  retailRoTarget = { customer, vehicle };
  $("#retail-ro-customer").textContent = customer.name || "";
  $("#retail-ro-vehicle").textContent = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  // A retail ticket on a car that's still owed a we-owe is legitimate (they
  // came in and paid for something else) but it is also the easy mistake:
  // promised work billed as retail never reaches the promise, so the promise
  // stays open forever and the cost lands on the wrong side of the shop's
  // books. Naming the promise is enough -- the advisor knows which it is.
  const owed = (vehicle.we_owe || []).filter((p) => p.status === "open" && !p.archived_at);
  const note = $("#retail-ro-owe-note");
  note.hidden = owed.length === 0;
  note.textContent = owed.length
    ? `This car is still owed: ${owed.map((p) => p.description).join("; ")}. If that's what you're writing up, do it on the we-owe instead — it's billed at cost and closes the promise.`
    : "";
  $("#retail-ro-concern").value = "";
  $("#retail-ro-dialog").showModal();
  $("#retail-ro-concern").focus();
}

export function wireRetailRoDialog() {
  $("#retail-ro-cancel").addEventListener("click", () => $("#retail-ro-dialog").close());
  $("#retail-ro-cancel-2").addEventListener("click", () => $("#retail-ro-dialog").close());
  $("#retail-ro-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const concern = $("#retail-ro-concern").value.trim();
    if (concern.length < 3) return toast("Describe what's being done first", true);
    const { customer, vehicle } = retailRoTarget || {};
    if (!vehicle) return;
    await withLoading(e.submitter, "Starting…", async () => {
      try {
        await post("/api/orders", { segment: "retail", customer_id: customer.id, vehicle_id: vehicle.id, concern });
        $("#retail-ro-dialog").close();
        toast("Repair order started");
        // The cached expansion (and the list's RO counts) are stale now;
        // dropping the cache is enough -- the Customers view reloads on
        // re-entry, and the advisor lands on the new ticket meanwhile.
        delete state.customerDetails[customer.id];
        openVehicleDetail("retail", vehicle.id);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ---------- add a vehicle for an existing customer ----------
   One dialog, two call sites: the retail vehicle page's Other Vehicles card
   and a customer's expanded row on the Customers screen. The customer is
   already chosen at both, so the form only asks about the car; what happens
   after the POST differs per caller (jump to the new page vs. refresh the
   expansion), which is what onCreated carries. */
let addVehicleTarget = null; // { customerId, onCreated } while the dialog is open

export function openAddVehicleDialog(customerId, customerName, onCreated) {
  addVehicleTarget = { customerId, onCreated };
  $("#vehicle-add-customer").textContent = customerName || "";
  ["year", "make", "model", "vin", "mileage", "plate", "plate-state", "color"]
    .forEach((f) => { $(`#vehicle-add-${f}`).value = ""; });
  $("#vehicle-add-dialog").showModal();
  $("#vehicle-add-year").focus();
}

export function wireAddVehicleDialog() {
  $("#vehicle-add-cancel").addEventListener("click", () => $("#vehicle-add-dialog").close());
  $("#vehicle-add-cancel-2").addEventListener("click", () => $("#vehicle-add-dialog").close());
  // VIN/plate/plate-state uppercase as you type, same shapes the backend
  // normalizes to -- so what the form shows is what the record will say.
  [["#vehicle-add-vin", /[^A-Z0-9]/g, 17], ["#vehicle-add-plate", /[^A-Z0-9]/g, 8], ["#vehicle-add-plate-state", /[^A-Z]/g, 2]]
    .forEach(([sel, strip, max]) => {
      $(sel).addEventListener("input", (e) => {
        e.target.value = e.target.value.toUpperCase().replace(strip, "").slice(0, max);
      });
    });
  $("#vehicle-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!addVehicleTarget) return;
    const year = Number($("#vehicle-add-year").value);
    const make = $("#vehicle-add-make").value.trim();
    const model = $("#vehicle-add-model").value.trim();
    if (!year || !make || !model) return toast("Year, make and model are required", true);
    await withLoading(e.submitter, "Adding…", async () => {
      try {
        const created = await post("/api/vehicles", {
          customer_id: addVehicleTarget.customerId,
          year, make, model,
          vin: $("#vehicle-add-vin").value.trim(),
          mileage: Number($("#vehicle-add-mileage").value || 0),
          plate: $("#vehicle-add-plate").value.trim(),
          plate_state: $("#vehicle-add-plate-state").value.trim(),
          color: $("#vehicle-add-color").value.trim(),
        });
        $("#vehicle-add-dialog").close();
        toast("Vehicle added");
        await addVehicleTarget.onCreated?.(created);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ---------- shared customer editor ----------
   One dialog, two call sites: the vehicle detail page ("Edit Customer" on
   the info card) and the Customers screen's expanded row. The dialog's
   wiring (masks, autocomplete, validation, submit) happens once at init;
   openCustomerEditor() stages a plain customer row and says what to do
   after a successful save. */
let customerEditorTarget = null; // { id, onSaved } while the dialog is open

export function openCustomerEditor(customer, onSaved) {
  customerEditorTarget = { id: customer.id, onSaved };
  $("#customer-edit-name").value = customer.name || "";
  $("#customer-edit-phone").value = customer.phone || "";
  // Remembered so an untouched legacy phone (saved before the mask
  // existed) doesn't fail validation on an unrelated edit -- see phoneFieldOk.
  $("#customer-edit-phone").dataset.loadedValue = $("#customer-edit-phone").value;
  $("#customer-edit-email").value = customer.email || "";
  // Same keep-legacy contract for email -- see emailFieldOk.
  $("#customer-edit-email").dataset.loadedValue = $("#customer-edit-email").value;
  $("#customer-edit-address1").value = customer.address_line1 || "";
  $("#customer-edit-address2").value = customer.address_line2 || "";
  $("#customer-edit-city").value = customer.city || "";
  $("#customer-edit-state").value = customer.state || "";
  $("#customer-edit-postal").value = customer.postal_code || "";
  hideAddressSuggestions();
  $("#customer-edit-dialog").showModal();
}

export function wireCustomerEditor() {
  $("#customer-edit-cancel").addEventListener("click", () => $("#customer-edit-dialog").close());
  $("#customer-edit-cancel-2").addEventListener("click", () => $("#customer-edit-dialog").close());
  setupAddressAutocomplete();
  wirePhoneInput($("#customer-edit-phone"));
  // State uppercases and strips non-letters as you type; ZIP keeps digits
  // (and the ZIP+4 hyphen) only. Both are optional fields, but if filled in
  // they must be real: a two-letter USPS code and a 5-digit (or 5+4) ZIP.
  // Validated here rather than with pattern= so the autocomplete's fills and
  // the error toasts behave the same in every browser (and in jsdom).
  $("#customer-edit-state").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  });
  $("#customer-edit-postal").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d-]/g, "").slice(0, 10);
  });
  $("#customer-edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const stateEl = $("#customer-edit-state");
    const stateVal = stateEl.value.trim().toUpperCase();
    if (stateVal && !US_STATE_CODES.has(stateVal)) {
      toast(`"${stateVal}" isn't a state code — use the two-letter abbreviation (MI, OH…)`, true);
      return void focusInvalidField(stateEl);
    }
    const postalEl = $("#customer-edit-postal");
    const postalVal = postalEl.value.trim();
    if (postalVal && !/^\d{5}(-\d{4})?$/.test(postalVal)) {
      toast("ZIP should be 5 digits (or ZIP+4, like 48203-1234)", true);
      return void focusInvalidField(postalEl);
    }
    if (!phoneFieldOk($("#customer-edit-phone"))) return;
    if (!emailFieldOk($("#customer-edit-email"))) return;
    if (!customerEditorTarget) return;
    try {
      const updated = await patch(`/api/customers/${customerEditorTarget.id}`, {
        name: $("#customer-edit-name").value.trim(),
        phone: $("#customer-edit-phone").value.trim(),
        email: $("#customer-edit-email").value.trim(),
        address_line1: $("#customer-edit-address1").value.trim(),
        address_line2: $("#customer-edit-address2").value.trim(),
        city: $("#customer-edit-city").value.trim(),
        state: $("#customer-edit-state").value.trim().toUpperCase(),
        postal_code: $("#customer-edit-postal").value.trim(),
      });
      $("#customer-edit-dialog").close();
      toast("Customer updated");
      await customerEditorTarget.onSaved?.(updated);
    } catch (err) {
      toast(err.message, true);
    }
  });
}
