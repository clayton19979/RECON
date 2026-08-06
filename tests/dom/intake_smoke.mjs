// New Recon Vehicle dialog smoke test.
//
// Intake is the last point where the app can still tell that two records are
// the same physical car, and the only screen whose mistakes are permanent:
// once a car is written down twice, the lot count is one too high and "what
// did we spend on this car" has two partial answers forever. The save refuses
// what it can, but a refusal after the whole form is typed is a bad way to
// find out -- so the dialog asks as each identifying field is filled in.
//
// What is checked here and nowhere else: that the note appears at all (it is
// driven by blur handlers, invisible to the Python tests), that it separates
// the two cases that look identical and mean opposite things -- a car already
// on the board (a mistake) versus a car coming back from History (routine) --
// and that "Open It" goes to the record it just named instead of leaving the
// advisor to find it by hand.

import { boot, click } from "./harness.mjs";

const ON_BOARD = { recon_id: 7, stock_number: "R-1042", vehicle: "2018 Kia Sorento", vin: "5XYPGDA31JG123456", archived: false };
const IN_HISTORY = { recon_id: 3, stock_number: "R-0904", vehicle: "2015 Ford Focus", vin: "1FADP3F20FL123456", archived: true };

// What the lookup answers, keyed on what the fields hold. Deliberately
// separators-stripped and upper-cased the way the server matches, so a test
// typing "r1042" exercises the same path as one typing "R-1042".
const key = (value) => value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

const opened = [];
const saved = []; // what Save Recon Vehicle actually put on the wire

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["openReconDialog", "openVehicleDetail"],
  fetch: async (url, opts) => {
    if (url.startsWith("/api/recon/vehicles/lookup")) {
      const params = new URLSearchParams(url.split("?")[1] || "");
      const stock = key(params.get("stock_number") || "");
      const vin = key(params.get("vin") || "");
      return {
        stock_number: [ON_BOARD, IN_HISTORY].find((v) => key(v.stock_number) === stock && stock) || null,
        vin: [ON_BOARD, IN_HISTORY].find((v) => key(v.vin) === vin && vin) || null,
      };
    }
    if (url.startsWith("/api/recon/vehicles/") && opts.method === "GET") {
      opened.push(url);
      return { id: 7, stock_number: "R-1042", year: 2018, make: "Kia", model: "Sorento", orders: [], archived_at: "" };
    }
    if (url === "/api/recon/vehicles" && opts.method === "POST") {
      saved.push(JSON.parse(opts.body));
      return { id: 7, stock_number: "R-2200" };
    }
    if (url === "/api/vehicles-board" || url.startsWith("/api/vehicles-board?")) return [];
    if (url === "/api/staff") return [];
    if (url === "/api/tasks") return [];
    if (url === "/api/orders" || url === "/api/customers") return [];
    return null;
  },
});

const $ = (sel) => doc.querySelector(sel);
const note = () => $("#recon-match-note");
const noteText = () => $("#recon-match-text").textContent;

/** Type into a field and blur it, the way the advisor leaves it for the next. */
const fill = async (sel, value) => {
  $(sel).value = value;
  $(sel).dispatchEvent(new w.Event("blur", { bubbles: false }));
  await settle();
};

w.openReconDialog();
await settle();
ok($("#recon-dialog").open, "the intake dialog should be open");
ok(note().hidden, "a fresh form should say nothing about duplicates");

/* ---------- a stock number already on the board ---------- */
// Typed without the dash, which is exactly the duplicate the old exact-match
// check let through.
await fill("#recon-stock", "r1042");
ok(!note().hidden, "a stock number already on the board should raise the note");
ok(note().classList.contains("warn"), "a car already on the board is a mistake, and the note should read as one");
ok(/R-1042/.test(noteText()) && /2018 Kia Sorento/.test(noteText()),
   `the note should name the car holding the number, got "${noteText()}"`);

/* ---------- clearing the field clears the note ---------- */
await fill("#recon-stock", "R-9999");
ok(note().hidden, "a stock number nobody has should leave no note behind");

/* ---------- a VIN last seen on a car in History ---------- */
// Not a duplicate: Walt buys cars back, and a second recon episode on one VIN
// is a real thing the app adds up. It should be said, not warned about.
await fill("#recon-vin", "1FADP3F20FL123456");
ok(!note().hidden, "a VIN the shop has seen before should be mentioned");
ok(!note().classList.contains("warn"), "a car coming back from History is routine, not a mistake");
ok(/History/.test(noteText()), `the note should say where that car is, got "${noteText()}"`);
ok(/R-0904/.test(noteText()), `the note should name the earlier record, got "${noteText()}"`);

/* ---------- a VIN on a car still sitting on the lot ---------- */
await fill("#recon-vin", "5XYPGDA31JG123456");
ok(note().classList.contains("warn"), "the same car twice on the lot is a mistake");
ok(/already on the board/.test(noteText()), `got "${noteText()}"`);

/* ---------- Open It goes to the car it just named ---------- */
click(w, $("#recon-match-open"));
await settle();
ok(!$("#recon-dialog").open, "Open It should close the intake form");
ok(opened.some((u) => u.includes("/api/recon/vehicles/7")),
   `Open It should load the car the note named, requested: ${opened.join(", ") || "nothing"}`);

/* ---------- reopening starts clean ---------- */
w.openReconDialog();
await settle();
ok(note().hidden, "last car's warning must not greet the next one");
ok($("#recon-stock").value === "", "the form should be empty again");

/* ---------- the VIN proves itself while it's being typed ----------

   Every 17-character VIN carries its own check digit, and the server already
   refuses one that fails it -- but only after the whole form is typed. The
   box now answers while the eyes are still on the car: a count on the way
   to 17, then the verdict. */
const vinBox = $("#recon-vin");
const verdict = $("#recon-vin-verdict");
const typeVin = async (value) => {
  vinBox.value = value;
  vinBox.dispatchEvent(new w.Event("input", { bubbles: true }));
  await settle();
};
ok(verdict.hidden, "an empty VIN box should say nothing");
await typeVin("1hgcm826");
ok(vinBox.value === "1HGCM826", `the box should show the shape the record will store, shows "${vinBox.value}"`);
ok(!verdict.hidden && /8 of 17/.test(verdict.textContent),
   `a short VIN should be counted, not judged, got "${verdict.textContent}"`);
await typeVin("1HGCM82633A004352");
ok(verdict.classList.contains("ok") && /checks out/.test(verdict.textContent),
   `a VIN whose check digit works out should say so, got "${verdict.textContent}"`);

/* Decode VIN lights up while it is the shortest path -- the VIN just proved
   itself and make/model are still empty -- and rests once they're typed. */
ok($("#recon-decode-vin").classList.contains("btn-decode-ready"),
   "a proven VIN over an empty make/model should light up Decode VIN");
$("#recon-make").value = "Honda";
$("#recon-make").dispatchEvent(new w.Event("input", { bubbles: true }));
ok(!$("#recon-decode-vin").classList.contains("btn-decode-ready"),
   "typing the make by hand should put the Decode button back to rest");
$("#recon-make").value = "";
$("#recon-make").dispatchEvent(new w.Event("input", { bubbles: true }));

/* One character off fails the arithmetic; the letter O gets named as the
   usual suspect it is. */
await typeVin("1HGCM82633A004353");
ok(verdict.classList.contains("bad") && /misread/.test(verdict.textContent),
   `a VIN one character off should be doubted, got "${verdict.textContent}"`);
await typeVin("1HGCM82633AO04352");
ok(/letter O/.test(verdict.textContent),
   `the letter O should be called out as a probable zero, got "${verdict.textContent}"`);
await typeVin("");
ok(verdict.hidden, "clearing the box should clear the verdict with it");

/* ---------- the head line assembles the car ----------

   What's about to be saved, readable in one place while it's still being
   typed. The year only joins once a make exists -- the field defaults to
   the current year, and a bare year is the form talking to itself. */
const preview = $("#recon-preview");
const typeField = async (sel, value) => {
  $(sel).value = value;
  $(sel).dispatchEvent(new w.Event("input", { bubbles: true }));
  await settle();
};
ok(preview.hidden, "an empty form should have no head line");
await typeField("#recon-stock", "R-2200");
ok(!preview.hidden && /R-2200/.test(preview.textContent),
   `the stock number should lead the head line, got "${preview.textContent}"`);
await typeField("#recon-make", "Kia");
ok(new RegExp(`${new w.Date().getFullYear()} Kia`).test(preview.textContent),
   `the year should join once a make exists, got "${preview.textContent}"`);
await typeField("#recon-model", "Sorento");
await typeField("#recon-color", "White");
ok(/R-2200 · \d{4} Kia Sorento · White/.test(preview.textContent),
   `the head line should read like the board card will, got "${preview.textContent}"`);

/* ---------- the plate box actually saves ----------

   It sat on this form from the beginning and the save simply left it out, so
   every lot car went in with no plate on file -- and the plate is the one
   identifier you can read off a car standing in the lot. */
$("#recon-stock").value = "R-2200";
$("#recon-make").value = "Kia";
$("#recon-model").value = "Sorento";
const plateBox = $("#recon-plate");
plateBox.value = "tk7-q419";
plateBox.dispatchEvent(new w.Event("input", { bubbles: true }));
ok(plateBox.value === "TK7Q419", `the box should show what will be stored, shows "${plateBox.value}"`);
$("#recon-plate-state").value = "IN";
$("#recon-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(saved.length === 1, `the form should have saved once, saved ${saved.length} times`);
ok(saved[0].plate === "TK7Q419", `the plate never reached the server: ${JSON.stringify(saved[0])}`);
ok(saved[0].plate_state === "IN", `the plate's state never reached the server: ${JSON.stringify(saved[0])}`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((r) => r && r.message).join("; ")}`);

finish("recon intake: duplicates caught before the form is typed, the VIN checks itself as it lands, the head line assembles the car, plate saved");
