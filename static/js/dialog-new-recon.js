import { $, get, post } from "./core.js";
import { toast } from "./notify.js";
import { fieldError, todayLocal, wirePlateFields, withLoading } from "./shortcuts.js";
import { state } from "./state.js";
import { loadVehiclesView } from "./vehicles-board.js";
import { openVehicleDetail } from "./vehicle-detail.js";
import { wireVinField } from "./vin.js";

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

/* ---------- the car assembling in the dialog head ----------
   The head line builds itself out of the identity fields as they're typed --
   stock number, then the car, then its color -- so what's about to be saved
   is readable in one place without re-scanning six boxes. The year only
   joins once a make exists: the field defaults to the current year, and a
   bare "2026" up there would just be the form talking to itself. */
function syncReconPreview() {
  const stock = $("#recon-stock").value.trim().toUpperCase();
  const make = $("#recon-make").value.trim();
  const car = [make ? $("#recon-year").value.trim() : "", make, $("#recon-model").value.trim()]
    .filter(Boolean).join(" ");
  const text = [stock, car, $("#recon-color").value.trim()].filter(Boolean).join(" · ");
  $("#recon-preview").textContent = text;
  $("#recon-preview").hidden = !text;
}

/* The last VIN state wireVinField reported, for the Decode nudge below. */
let reconVinState = "empty";
/* Re-run the VIN verdict after the field is set from code (form reset,
   decoded plate); assigned in wireReconDialog. */
let syncReconVin = () => {};

/* Light up Decode VIN the moment it becomes the shortest path: the VIN just
   proved itself and year/make/model are still waiting to be typed. Filling
   either by hand, or decoding, puts the button back to rest. */
function syncReconDecodeNudge() {
  const untyped = !$("#recon-make").value.trim() && !$("#recon-model").value.trim();
  $("#recon-decode-vin").classList.toggle("btn-decode-ready", reconVinState === "ok" && untyped);
}

export function openReconDialog() {
  $("#recon-form").reset();
  clearMatchNote();
  $("#recon-year").value = new Date().getFullYear();
  // The day the car landed, and it is what the board's Age column counts
  // from -- so this default has to be the shop's today, not UTC's.
  $("#recon-date").value = todayLocal();
  syncReconPreview();
  syncReconVin();
  $("#recon-dialog").showModal();
}
export function wireReconDialog() {
  $("#recon-cancel").addEventListener("click", () => $("#recon-dialog").close());
  $("#recon-cancel-2").addEventListener("click", () => $("#recon-dialog").close());
  wirePlateFields("#recon-plate", "#recon-plate-state");
  $("#recon-stock").addEventListener("blur", () => checkForExistingCar());
  $("#recon-vin").addEventListener("blur", () => checkForExistingCar());
  syncReconVin = wireVinField($("#recon-vin"), $("#recon-vin-verdict"), (vinState) => {
    reconVinState = vinState;
    syncReconDecodeNudge();
  });
  for (const sel of ["#recon-stock", "#recon-year", "#recon-make", "#recon-model", "#recon-color"]) {
    $(sel).addEventListener("input", () => syncReconPreview());
  }
  // Typing the make or model by hand answers the question the lit-up Decode
  // button was asking, so it goes back to rest.
  for (const sel of ["#recon-make", "#recon-model"]) {
    $(sel).addEventListener("input", () => syncReconDecodeNudge());
  }
  $("#recon-match-open").addEventListener("click", () => {
    const id = matchedReconId;
    $("#recon-dialog").close();
    if (id) openVehicleDetail("recon", id);
  });
  $("#recon-decode-vin").addEventListener("click", async () => {
    const vin = $("#recon-vin").value.trim();
    if (vin.length < 5) return fieldError($("#recon-vin"), "Enter a VIN first");
    try {
      const data = await post("/api/vehicles/decode-vin", { vin });
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      // Filled from code, so no input events fired: rebuild the head line
      // and put the lit-up Decode button (its job is done) back to rest.
      syncReconPreview();
      syncReconDecodeNudge();
      toast("VIN decoded");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#recon-decode-plate").addEventListener("click", async () => {
    const plate = $("#recon-plate").value.trim();
    const state_ = $("#recon-plate-state").value.trim();
    // Pointed at the box that's actually empty; plate first, same order as
    // the form.
    if (!plate) return fieldError($("#recon-plate"), "Enter the plate first");
    if (!state_) return fieldError($("#recon-plate-state"), "Enter the plate's state");
    try {
      const data = await post("/api/vehicles/decode-plate", { plate, state: state_ });
      $("#recon-vin").value = data.vin;
      $("#recon-year").value = data.year;
      $("#recon-make").value = data.make;
      $("#recon-model").value = data.model;
      $("#recon-trim").value = data.trim;
      $("#recon-engine").value = data.engine;
      $("#recon-color").value = data.color;
      // All set from code -- no input events fired for any of it.
      syncReconPreview();
      syncReconVin();
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
          // The form has always asked for these two and used to throw both
          // away at Save, so a lot car never had a plate on file and the
          // search bar could never find one by it.
          plate: $("#recon-plate").value.trim(),
          plate_state: $("#recon-plate-state").value.trim(),
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
