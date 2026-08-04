import { $, get, post } from "./core.js";
import { toast } from "./notify.js";
import { esc, fmtDate, money, withLoading } from "./shortcuts.js";
import { loadVehiclesView } from "./vehicles-board.js";
import { phoneFieldOk, wirePhoneInput } from "./vehicle-detail.js";

/* ==================================================================
   NEW WE-OWE DIALOG
   ================================================================== */

/* Which existing customer the note's "Use Them" button switches to, set by
   checkForExistingCustomer. */
let matchedCustomerId = null;

function clearCustomerMatchNote() {
  matchedCustomerId = null;
  $("#we-owe-customer-match").hidden = true;
  $("#we-owe-customer-match").classList.remove("warn");
}

/* What the shop already knows about this person, in the order it helps.
   A customer with an open promise is the one most likely to be the reason
   somebody is on the phone; "last in Mar 4" is what makes an advisor sure
   they have the right person before clicking. */
function describeCustomer(match) {
  const bits = [];
  if (match.phone) bits.push(match.phone);
  if (match.open_promises) bits.push(`${match.open_promises} promise${match.open_promises === 1 ? "" : "s"} still open`);
  if (match.open_orders) bits.push(`${match.open_orders} open ticket${match.open_orders === 1 ? "" : "s"}`);
  if (match.vehicle_count) bits.push(`${match.vehicle_count} vehicle${match.vehicle_count === 1 ? "" : "s"}`);
  if (match.last_visit_at) bits.push(`last in ${fmtDate(match.last_visit_at).replace(/,\s+\d{1,2}:\d{2}\s*(AM|PM)$/i, "")}`);
  return bits.join(" · ");
}

/* Is this person already on file? Asked as each identifying field is left,
   for the same reason the recon dialog asks about the stock number: writing
   the same customer down twice cannot be undone from the counter, and it
   splits what they are owed across two records that never mention each other.

   Same name and same number is what the save itself refuses, so the note says
   so plainly before the rest of the form is typed. Same number under another
   name is a household, not a mistake -- worth mentioning, not worth warning
   about. */
async function checkForExistingCustomer() {
  const name = $("#we-owe-new-customer-name").value.trim();
  const phone = $("#we-owe-new-customer-phone").value.trim();
  if (!name && !phone) return clearCustomerMatchNote();
  let match;
  try {
    match = await get(`/api/customers/match?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`);
  } catch {
    return clearCustomerMatchNote();  // a failed lookup is not worth interrupting intake over
  }
  // The dialog may have been closed, or the fields changed, while that was in
  // flight -- a note about a value nobody is looking at any more is noise.
  if (!$("#we-owe-dialog").open) return clearCustomerMatchNote();
  if ($("#we-owe-new-customer-name").value.trim() !== name) return;
  if ($("#we-owe-new-customer-phone").value.trim() !== phone) return;

  const byName = match.name;
  const byPhone = match.phone;
  const target = byName || byPhone;
  if (!target) return clearCustomerMatchNote();

  // Refused by the save: the same name on the same number is the same person.
  const blocking = Boolean(byName && byPhone && byName.customer_id === byPhone.customer_id);
  let sentence;
  if (blocking) {
    sentence = `${byName.name} is already on file with this number — adding them again would split what they're owed across two records.`;
  } else if (byName) {
    sentence = `${byName.name} is already on file.`;
  } else {
    sentence = `This number is already on file for ${byPhone.name} — the same household, or the same person under another name.`;
  }
  const detail = describeCustomer(target);

  matchedCustomerId = target.customer_id;
  $("#we-owe-customer-match-text").textContent = detail ? `${sentence} ${detail}.` : sentence;
  $("#we-owe-customer-match").classList.toggle("warn", blocking);
  $("#we-owe-customer-match").hidden = false;
}

export async function openWeOweDialog() {
  $("#we-owe-form").reset();
  clearCustomerMatchNote();
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
export function wireWeOweDialog() {
  $("#we-owe-cancel").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-cancel-2").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-customer").addEventListener("change", async () => {
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
    // The note belongs to the two boxes that just went away, and it would
    // otherwise sit there talking about a customer nobody is typing any more.
    if ($("#we-owe-customer").value !== "__new__") clearCustomerMatchNote();
    await refreshWeOweVehicleOptions();
  });
  $("#we-owe-new-customer-name").addEventListener("blur", () => checkForExistingCustomer());
  $("#we-owe-new-customer-phone").addEventListener("blur", () => checkForExistingCustomer());
  /* One click instead of retyping: pick the person the note just named, and
     the vehicle list under it reloads to the cars already on their record --
     which is the other half of not writing the same customer down twice. */
  $("#we-owe-customer-match-use").addEventListener("click", async () => {
    const id = matchedCustomerId;
    if (id == null) return;
    const select = $("#we-owe-customer");
    // Only if that person is actually in the list -- the list is loaded when
    // the dialog opens, so somebody added on the other PC since then would
    // silently leave the select on "+ New customer..." and the advisor would
    // never know the click did nothing.
    if (!Array.from(select.options).some((o) => o.value === String(id))) {
      return toast("That customer isn't in the list yet — close and reopen this form", true);
    }
    select.value = String(id);
    // Set from code, so no change event is coming -- do what the handler
    // above would have done.
    $("#we-owe-new-customer").style.display = "none";
    $("#we-owe-new-customer-name").value = "";
    $("#we-owe-new-customer-phone").value = "";
    clearCustomerMatchNote();
    await refreshWeOweVehicleOptions();
  });
  $("#we-owe-vehicle").addEventListener("change", () => {
    $("#we-owe-new-vehicle").style.display = $("#we-owe-vehicle").value === "__new__" ? "" : "none";
  });
  wirePhoneInput($("#we-owe-new-customer-phone"));
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
  /* The moment a VIN is entered, say whether this car is already known.
     This is the case that prompted the whole thing: a car recon'd and sold
     months ago comes back on a we-owe, and without this the advisor has no
     way of knowing the shop already has a purchase price and a repair
     history on file for it -- so they'd type a second, conflicting one. */
  $("#we-owe-new-vin").addEventListener("blur", async () => {
    const note = $("#we-owe-vin-match");
    const vin = $("#we-owe-new-vin").value.trim();
    if (vin.length < 11) return void (note.hidden = true);
    try {
      const [match] = await get(`/api/reports/vehicle-profit?vin=${encodeURIComponent(vin)}`);
      if (!match) return void (note.hidden = true);
      const bits = [`Already on file${match.stock_number ? ` as ${match.stock_number}` : ""}`];
      if (match.recon_cost) bits.push(`${money(match.recon_cost)} of recon in it`);
      note.textContent = `${bits.join(" · ")}. This car has been through the shop before — its history carries over.`;
      note.hidden = false;
    } catch {
      note.hidden = true;  // a failed lookup is not worth interrupting intake over
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
          if (!phoneFieldOk($("#we-owe-new-customer-phone"))) return;
          let customer;
          try {
            customer = await post("/api/customers", { name, phone: $("#we-owe-new-customer-phone").value.trim(), email: "" });
          } catch (err) {
            // The save refused this person as a duplicate. Say who they are
            // and put Use Them on screen, rather than a toast that names the
            // problem and leaves the advisor to solve it by hand.
            await checkForExistingCustomer();
            throw err;
          }
          customerId = customer.id;
        } else {
          customerId = Number(customerId);
        }
        let vehicleId = $("#we-owe-vehicle").value;
        const isNewVehicle = vehicleId === "__new__";
        if (isNewVehicle) {
          const make = $("#we-owe-new-make").value.trim();
          const model = $("#we-owe-new-model").value.trim();
          if (!make || !model) return toast("Enter the vehicle's make and model", true);
          const odoBroken = $("#we-owe-new-odo-broken").checked;
          const mileage = Number($("#we-owe-new-mileage").value || 0);
          // Mileage is asked for, and "the odometer is broken" is a real
          // answer to that question -- but silence isn't. Without one or the
          // other a zero is unreadable a month from now.
          if (!odoBroken && !mileage) {
            return toast("Enter the mileage, or tick Odometer broken", true);
          }
          const vehicle = await post("/api/vehicles", {
            customer_id: customerId,
            year: Number($("#we-owe-new-year").value),
            make, model,
            vin: $("#we-owe-new-vin").value.trim(),
            mileage,
            odometer_broken: odoBroken,
          });
          vehicleId = vehicle.id;
        } else {
          vehicleId = Number(vehicleId);
        }
        const salePrice = $("#we-owe-new-sale-price").value.trim();
        await post("/api/we-owe", {
          customer_id: customerId,
          vehicle_id: vehicleId,
          description: $("#we-owe-description").value.trim(),
          category: $("#we-owe-category").value.trim() || "other",
          target_date: $("#we-owe-target").value,
          sale_reference: $("#we-owe-sale-ref").value.trim(),
          lot_stock_number: $("#we-owe-lot-stock").value.trim(),
          // Left out entirely when blank: the server only fills a gap, so an
          // empty box must not arrive as a 0 that overwrites what's on file.
          ...(salePrice === "" ? {} : { sale_price: Number(salePrice) }),
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
