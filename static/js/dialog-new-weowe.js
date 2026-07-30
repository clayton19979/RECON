import { $, get, post } from "./core.js";
import { toast } from "./notify.js";
import { esc, money, withLoading } from "./shortcuts.js";
import { loadVehiclesView } from "./vehicles-board.js";
import { phoneFieldOk, wirePhoneInput } from "./vehicle-detail.js";

/* ==================================================================
   NEW WE-OWE DIALOG
   ================================================================== */
export async function openWeOweDialog() {
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
export function wireWeOweDialog() {
  $("#we-owe-cancel").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-cancel-2").addEventListener("click", () => $("#we-owe-dialog").close());
  $("#we-owe-customer").addEventListener("change", async () => {
    $("#we-owe-new-customer").style.display = $("#we-owe-customer").value === "__new__" ? "" : "none";
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
      if (match.purchase_price) bits.push(`bought for ${money(match.purchase_price)}`);
      if (match.recon_cost) bits.push(`${money(match.recon_cost)} of recon in it`);
      note.textContent = `${bits.join(" · ")}. Its purchase price carries over — you don't need to re-enter it.`;
      note.hidden = false;
      // Its history is the record; don't invite a second, conflicting figure.
      $("#we-owe-new-purchase-price").placeholder = "Already on file";
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
          const customer = await post("/api/customers", { name, phone: $("#we-owe-new-customer-phone").value.trim(), email: "" });
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
        const purchasePrice = $("#we-owe-new-purchase-price").value.trim();
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
          // empty box must not arrive as a 0 that overwrites a real price
          // already on file from this car's recon life.
          ...(purchasePrice === "" ? {} : { purchase_price: Number(purchasePrice) }),
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
