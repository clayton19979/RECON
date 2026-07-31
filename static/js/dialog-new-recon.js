import { $, get, post } from "./core.js";
import { toast } from "./notify.js";
import { withLoading } from "./shortcuts.js";
import { state } from "./state.js";
import { loadVehiclesView } from "./vehicles-board.js";
import { openVehicleDetail } from "./vehicle-detail.js";

/* ==================================================================
   NEW RECON VEHICLE DIALOG
   ================================================================== */

/* Which car the note's "Open It" button goes to, set by checkForExistingCar. */
let matchedReconId = null;

function clearMatchNote() {
  matchedReconId = null;
  $("#recon-match-note").hidden = true;
}

/* Is this car already written down? Asked as soon as either identifying field
   is filled in, because the cost of finding out late is high and permanent:
   a car entered twice answers "what did we spend on it" twice, with two
   partial numbers, and neither record knows the other is there. The save
   refuses the duplicates it can (see recon_match), but a refusal after the
   whole form is typed is a worse way to learn it than a line under the field.

   A VIN last seen on an archived car is not a duplicate -- Walt buys cars
   back, and a second recon episode on one VIN is a real thing the app adds up
   on purpose. That case is said plainly and left alone. */
async function checkForExistingCar() {
  const stock = $("#recon-stock").value.trim();
  const vin = $("#recon-vin").value.trim();
  if (!stock && !vin) return clearMatchNote();
  let match;
  try {
    match = await get(`/api/recon/vehicles/lookup?stock_number=${encodeURIComponent(stock)}&vin=${encodeURIComponent(vin)}`);
  } catch {
    return clearMatchNote();  // a failed lookup is not worth interrupting intake over
  }
  // The dialog may have been closed, or the fields changed, while that was in
  // flight -- a note about a value nobody is looking at any more is noise.
  if (!$("#recon-dialog").open) return clearMatchNote();
  if ($("#recon-stock").value.trim() !== stock || $("#recon-vin").value.trim() !== vin) return;

  const lines = [];
  let blocking = false;
  let target = null;
  const name = (m) => `${m.stock_number} — ${m.vehicle}`;
  if (match.stock_number) {
    target = match.stock_number;
    blocking = true;
    lines.push(match.stock_number.archived
      ? `${name(match.stock_number)} already has this stock number and is in History. Reopen it instead of adding it again.`
      : `${name(match.stock_number)} is already on the board with this stock number.`);
  }
  if (match.vin && match.vin.recon_id !== match.stock_number?.recon_id) {
    target = target || match.vin;
    if (match.vin.archived) {
      lines.push(`This VIN was here before as ${name(match.vin)}, now in History — adding it again starts a second visit.`);
    } else {
      blocking = true;
      lines.push(`This VIN is already on the board as ${name(match.vin)}.`);
    }
  }
  if (!lines.length) return clearMatchNote();

  matchedReconId = target.recon_id;
  $("#recon-match-text").textContent = lines.join(" ");
  $("#recon-match-note").classList.toggle("warn", blocking);
  $("#recon-match-note").hidden = false;
}

export function openReconDialog() {
  $("#recon-form").reset();
  clearMatchNote();
  $("#recon-year").value = new Date().getFullYear();
  $("#recon-date").value = new Date().toISOString().slice(0, 10);
  $("#recon-dialog").showModal();
}
export function wireReconDialog() {
  $("#recon-cancel").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-cancel-2").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-stock").addEventListener("blur", () => checkForExistingCar());
  $("#recon-vin").addEventListener("blur", () => checkForExistingCar());
  $("#recon-match-open").addEventListener("click", () => {
    const id = matchedReconId;
    $("#recon-dialog").close();
    if (id) openVehicleDetail("recon", id);
  });
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
      // The VIN just arrived without anyone typing in the field, so no blur
      // is coming -- ask now, or a plate-decoded duplicate goes unnoticed.
      checkForExistingCar();
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
          odometer_broken: $("#recon-odo-broken").checked,
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
