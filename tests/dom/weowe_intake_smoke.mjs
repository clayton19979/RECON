// New We-Owe dialog smoke test: the customer half of intake.
//
// This is the only screen in the app that creates a customer, and its picker
// opens on "+ New customer...", so typing a name that is already on file is
// the default outcome rather than an unlucky one. A second record splits what
// the shop owes that person across two rows that never mention each other.
//
// What is checked here and nowhere else: that the note appears at all (it is
// driven by blur handlers, invisible to the Python tests), that it tells apart
// the two cases that look the same and mean different things -- the same
// person again (refused at the save) versus a household sharing a number
// (fine) -- and that "Use Them" actually switches the form onto that customer
// and reloads their cars, instead of leaving the advisor to find them by hand.

import { boot, click } from "./harness.mjs";

const IRIS = {
  customer_id: 12, name: "Iris Chandler", phone: "(313) 555-0304",
  vehicle_count: 2, open_promises: 1, open_orders: 0, last_visit_at: "2026-03-04T09:15:00",
};
const MARCUS = {
  customer_id: 11, name: "Marcus Doyle", phone: "(313) 555-0304",
  vehicle_count: 1, open_promises: 0, open_orders: 0, last_visit_at: "",
};

const nameKey = (value) => value.toLowerCase().replace(/[^0-9a-z]/g, "");
const phoneKey = (value) => value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

// Who the server would answer with, matched the way it matches: oldest record
// first, and the newest of the matches wins. Both of these people share a
// number, so which one comes back is decided by that rule and not by luck.
const PEOPLE = [MARCUS, IRIS];

function lookup(name, phone) {
  const newest = (matches) => (matches.length ? matches[matches.length - 1] : null);
  return {
    name: (name && newest(PEOPLE.filter((p) => nameKey(p.name) === nameKey(name)))) || null,
    phone: (phone && newest(PEOPLE.filter((p) => phoneKey(p.phone) === phoneKey(phone)))) || null,
  };
}

const vehiclesAsked = [];
const savedPromises = []; // what Save We-Owe actually put on the wire
const weOweOpened = [];   // the promise pages loaded after a save

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["openWeOweDialog", "showView"],
  fetch: async (url, opts) => {
    if (url.startsWith("/api/customers/match")) {
      const params = new URLSearchParams(url.split("?")[1] || "");
      return lookup(params.get("name") || "", params.get("phone") || "");
    }
    if (url === "/api/customers") return PEOPLE.map((c) => ({ id: c.customer_id, name: c.name }));
    if (url === "/api/vehicles") {
      vehiclesAsked.push(url);
      return [{ id: 41, customer_id: IRIS.customer_id, year: 2019, make: "Honda", model: "Civic" }];
    }
    if (url === "/api/we-owe" && opts.method === "POST") {
      savedPromises.push(JSON.parse(opts.body));
      return { id: 55 };
    }
    if (url === "/api/we-owe/55" && opts.method === "GET") {
      weOweOpened.push(url);
      return {
        id: 55, customer_id: IRIS.customer_id, customer_name: IRIS.name, vehicle_id: 41,
        year: 2019, make: "Honda", model: "Civic", vin: "", mileage: 0,
        description: "Replace missing passenger mirror", category: "other", status: "open",
        target_date: "", sale_reference: "", lot_stock_number: "", notes: "",
        archived_at: "", orders: [], payments: [], total_cost: 0, quoted_cost: 0,
      };
    }
    if (url === "/api/vehicles-board" || url.startsWith("/api/vehicles-board?")) return [];
    if (url === "/api/staff" || url === "/api/tasks") return [];
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [];
    return null;
  },
});

const $ = (sel) => doc.querySelector(sel);
const note = () => $("#we-owe-customer-match");
const noteText = () => $("#we-owe-customer-match-text").textContent;

/** Type into a field and blur it, the way the advisor leaves it for the next. */
const fill = async (sel, value) => {
  $(sel).value = value;
  $(sel).dispatchEvent(new w.Event("blur", { bubbles: false }));
  await settle();
};

await w.openWeOweDialog();
await settle();
ok($("#we-owe-dialog").open, "the we-owe dialog should be open");
ok(note().hidden, "a fresh form should say nothing about duplicates");
ok($("#we-owe-customer").value === "__new__", "the picker opens on + New customer, which is what makes this worth guarding");

/* ---------- a name already on file ---------- */
// Typed in the wrong case, which is one of the two ways the same person gets
// written down twice on two different mornings.
await fill("#we-owe-new-customer-name", "iris chandler");
ok(!note().hidden, "a customer already on file should raise the note");
ok(/Iris Chandler/.test(noteText()), `the note should name them, got "${noteText()}"`);
ok(/1 promise still open/.test(noteText()),
   `the note should say what makes them recognisable, got "${noteText()}"`);
ok(!note().classList.contains("warn"),
   "a name on its own is not refused by the save, so it should not read like a refusal");

/* ---------- a stranger clears it ---------- */
await fill("#we-owe-new-customer-name", "Nobody Here");
ok(note().hidden, "a name nobody has should leave no note behind");

/* ---------- somebody else's number, under a new name ---------- */
await fill("#we-owe-new-customer-phone", "3135550304");
ok(!note().hidden, "a number already on file should be mentioned");
ok(!note().classList.contains("warn"), "a shared household number is not a mistake");
ok(/Iris Chandler/.test(noteText()), `the note should name whose number it is, got "${noteText()}"`);

/* ---------- the same person, name and number both ---------- */
await fill("#we-owe-new-customer-name", "Iris  Chandler");
ok(note().classList.contains("warn"), "the same name on the same number is what the save refuses");
ok(/split what they're owed/.test(noteText()), `the note should say why it matters, got "${noteText()}"`);

/* ---------- Use Them switches the form onto that customer ---------- */
const before = vehiclesAsked.length;
click(w, $("#we-owe-customer-match-use"));
await settle();
ok($("#we-owe-customer").value === String(IRIS.customer_id),
   `Use Them should pick that customer, picker is on "${$("#we-owe-customer").value}"`);
ok($("#we-owe-new-customer").style.display === "none", "the new-customer fields should go away with them");
ok($("#we-owe-new-customer-name").value === "" && $("#we-owe-new-customer-phone").value === "",
   "the half-typed name must not be left behind to be saved as a second person");
ok(note().hidden, "the note is about a customer nobody is typing any more");
ok(vehiclesAsked.length > before, "their cars should be loaded into the vehicle picker");
ok(Array.from($("#we-owe-vehicle").options).some((o) => /Civic/.test(o.textContent)),
   "the vehicle picker should now offer the car already on their record");

/* ---------- the head line assembles the promise ----------

   Who it's for, which car, what was said -- built up under the title as the
   form is typed, so what's about to be saved is readable in one place. The
   customer picked by Use Them above is already on it. */
const preview = $("#we-owe-preview");
ok(!preview.hidden && /Iris Chandler/.test(preview.textContent),
   `the picked customer should be on the head line, got "${preview.textContent}"`);
const civicOption = Array.from($("#we-owe-vehicle").options).find((o) => /Civic/.test(o.textContent));
$("#we-owe-vehicle").value = civicOption.value;
$("#we-owe-vehicle").dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(/Iris Chandler · 2019 Honda Civic/.test(preview.textContent),
   `the picked car should join the head line, got "${preview.textContent}"`);
$("#we-owe-description").value = "Replace missing passenger mirror";
$("#we-owe-description").dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(/Civic · Replace missing passenger mirror/.test(preview.textContent),
   `what was promised should finish the head line, got "${preview.textContent}"`);

/* ---------- the VIN proves itself here too ----------

   Same live verdict the recon write-up gives: a count on the way to 17
   characters, then the check-digit answer. */
const vinBox = $("#we-owe-new-vin");
const verdict = $("#we-owe-vin-verdict");
vinBox.value = "1hgcm826";
vinBox.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(vinBox.value === "1HGCM826", `the box should show the shape the record will store, shows "${vinBox.value}"`);
ok(!verdict.hidden && /8 of 17/.test(verdict.textContent),
   `a short VIN should be counted, not judged, got "${verdict.textContent}"`);
vinBox.value = "1HGCM82633A004352";
vinBox.dispatchEvent(new w.Event("input", { bubbles: true }));
await settle();
ok(verdict.classList.contains("ok") && /checks out/.test(verdict.textContent),
   `a VIN whose check digit works out should say so, got "${verdict.textContent}"`);

/* ---------- reopening starts clean ---------- */
await fill("#we-owe-new-customer-name", "Iris Chandler");
await w.openWeOweDialog();
await settle();
ok(note().hidden, "last customer's warning must not greet the next one");
ok($("#we-owe-new-customer-name").value === "", "the form should be empty again");
ok(preview.hidden, "last promise's head line must not greet the next one");
ok(verdict.hidden, "last car's VIN verdict must not greet the next one");

/* ---------- Save lands on the promise it just made ----------

   Same landing as recon intake: the next thing done with a fresh we-owe is
   writing its ticket, and the Start Repair Order box is on the promise's own
   page -- the board would only be a search for the record just saved. */
$("#we-owe-customer").value = String(IRIS.customer_id);
$("#we-owe-customer").dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
const civic = Array.from($("#we-owe-vehicle").options).find((o) => /Civic/.test(o.textContent));
$("#we-owe-vehicle").value = civic.value;
$("#we-owe-vehicle").dispatchEvent(new w.Event("change", { bubbles: true }));
$("#we-owe-description").value = "Replace missing passenger mirror";
w.showView("vehicles");
await settle();
$("#we-owe-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await settle();
ok(savedPromises.length === 1, `the form should have saved once, saved ${savedPromises.length} times`);
ok(!$("#we-owe-dialog").open, "Save should close the dialog");
ok($("#view-vehicle-detail").classList.contains("active"),
   "Save should land on the promise's own page, not back on the board");
ok(weOweOpened.length === 1,
   `the landing should load the promise the save returned, requested: ${weOweOpened.join(", ") || "nothing"}`);

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((r) => r && r.message).join("; ")}`);

finish("we-owe intake: a customer already on file is caught and picked in one click, the head line assembles the promise, Save lands on the promise's page");
