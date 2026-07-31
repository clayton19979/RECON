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

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((r) => r && r.message).join("; ")}`);

finish("recon intake: duplicate stock number and VIN caught before the form is typed, History told apart from the lot");
