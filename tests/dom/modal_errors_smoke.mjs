// Errors inside dialogs smoke test (issue #126).
//
// showModal() puts a dialog in the browser's top layer, which paints above
// everything at body level regardless of z-index -- so every toast fired
// while a dialog was open (a refused save, "enter the customer's name")
// appeared *behind* the dialog. The advisor saw the save do nothing, with
// the reason invisible under the form they were looking at.
//
// Two halves to the fix, both driven here:
//   - toast() re-homes #toast into the open dialog, so messages about the
//     form as a whole (server refusals) are readable above it;
//   - the dialogs' own "this box is missing" checks stopped being toasts at
//     all and became notes standing next to the field itself (fieldError),
//     which is what the issue asked for.

import { boot, click } from "./harness.mjs";

const weOwePosts = [];
const customerPosts = [];
const vehiclePosts = [];

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["openReconDialog", "openWeOweDialog", "toast", "state"],
  fetch: async (url, opts = {}) => {
    if (url.startsWith("/api/customers/match")) return { name: null, phone: null };
    if (url === "/api/customers" && opts.method === "POST") {
      customerPosts.push(JSON.parse(opts.body));
      return { id: 91, ...JSON.parse(opts.body) };
    }
    if (url === "/api/customers") return [];
    if (url === "/api/vehicles" && opts.method === "POST") {
      vehiclePosts.push(JSON.parse(opts.body));
      return { id: 71, ...JSON.parse(opts.body) };
    }
    if (url === "/api/vehicles") return [];
    if (url === "/api/we-owe" && opts.method === "POST") {
      weOwePosts.push(JSON.parse(opts.body));
      return { id: 5 };
    }
    if (url.startsWith("/api/recon/vehicles/lookup")) return {};
    if (url === "/api/vehicles-board" || url.startsWith("/api/vehicles-board?")) return [];
    return [];
  },
});

const $ = (sel) => doc.querySelector(sel);
const toastEl = () => $("#toast");
const noteIn = (sel) => $(sel).closest("label")?.querySelector(".field-error")?.textContent || "";
const type = (sel, value) => {
  $(sel).value = value;
  $(sel).dispatchEvent(new w.Event("input", { bubbles: true }));
};
const submitWeOwe = () => $("#we-owe-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));

await settle();

/* ------------------------------------------------------------------
   A toast fired while a dialog is open must live inside that dialog --
   a top-layer subtree is the only place it can paint above the backdrop.
   ------------------------------------------------------------------ */
w.toast("plain message with nothing open");
ok(toastEl().parentElement === doc.body, "with no dialog open the toast lives at body level");

await w.openReconDialog();
await settle();
ok($("#recon-dialog").open, "the recon dialog should be open");
w.toast("a save was refused", true);
ok(toastEl().parentElement === $("#recon-dialog"),
   "a toast fired while a dialog is open must render inside that dialog, not behind it");
ok(toastEl().classList.contains("show") && toastEl().classList.contains("error"),
   "the re-homed toast still shows as an error");

$("#recon-dialog").close();
await settle();
w.toast("back outside");
ok(toastEl().parentElement === doc.body, "after the dialog closes the toast goes home to the body");

/* ------------------------------------------------------------------
   The recon dialog's own checks point at the field they're about.
   ------------------------------------------------------------------ */
await w.openReconDialog();
await settle();
click(w, $("#recon-decode-vin"));
await settle();
ok(/Enter a VIN first/.test(noteIn("#recon-vin")),
   `Decode with no VIN should say so beside the VIN box, got "${noteIn("#recon-vin")}"`);
ok(doc.activeElement === $("#recon-vin"), "the VIN box should be focused, ready to type into");
type("#recon-vin", "1HGCV1F34JA123456");
ok(!noteIn("#recon-vin"), "typing in the VIN box should clear its note");

click(w, $("#recon-decode-plate"));
await settle();
ok(/Enter the plate first/.test(noteIn("#recon-plate")),
   `Decode with no plate should say so beside the plate box, got "${noteIn("#recon-plate")}"`);
type("#recon-plate", "TK7Q419");
click(w, $("#recon-decode-plate"));
await settle();
ok(/plate's state/.test(noteIn("#recon-plate-state")),
   `a plate without a state should point at the state box, got "${noteIn("#recon-plate-state")}"`);

// Closing the dialog takes any standing note with it -- reopening a form
// must not resurrect last time's scolding.
$("#recon-dialog").close();
await settle();
await w.openReconDialog();
await settle();
ok(!doc.querySelector("#recon-dialog .field-error"),
   "a reopened dialog should carry no field notes from last time");
$("#recon-dialog").close();
await settle();

/* ------------------------------------------------------------------
   The we-owe intake ladder: each save attempt names the next missing box,
   beside that box -- the exact flow issue #126 describes.
   ------------------------------------------------------------------ */
await w.openWeOweDialog();
await settle();
ok($("#we-owe-dialog").open, "the we-owe dialog should be open");
ok($("#we-owe-customer").value === "__new__", "the picker opens on + New customer");
type("#we-owe-description", "Replace missing passenger mirror");

submitWeOwe();
await settle();
ok(weOwePosts.length === 0 && customerPosts.length === 0, "nothing should save with the name missing");
ok(/Enter the customer's name/.test(noteIn("#we-owe-new-customer-name")),
   `the missing name should be called out beside its box, got "${noteIn("#we-owe-new-customer-name")}"`);
ok(doc.activeElement === $("#we-owe-new-customer-name"), "focus should land on the name box");

type("#we-owe-new-customer-name", "Jordan Whitfield");
ok(!noteIn("#we-owe-new-customer-name"), "typing the name should clear its note");

submitWeOwe();
await settle();
ok(/Enter the make/.test(noteIn("#we-owe-new-make")),
   `the missing make should be called out beside its box, got "${noteIn("#we-owe-new-make")}"`);
// A refused save must write nothing at all: the customer used to be created
// before the vehicle boxes were checked, so retrying after fixing the make
// tripped the duplicate-person guard on the half-finished record.
ok(customerPosts.length === 0, "a save refused over the vehicle boxes must not have created the customer");
type("#we-owe-new-make", "Kia");

submitWeOwe();
await settle();
ok(/Enter the model/.test(noteIn("#we-owe-new-model")),
   `the missing model should be called out beside its box, got "${noteIn("#we-owe-new-model")}"`);
type("#we-owe-new-model", "Soul");

submitWeOwe();
await settle();
ok(/mileage, or tick Odometer broken/.test(noteIn("#we-owe-new-mileage")),
   `the missing mileage should be called out beside its box, got "${noteIn("#we-owe-new-mileage")}"`);
type("#we-owe-new-mileage", "84500");

submitWeOwe();
await settle();
ok(customerPosts.length === 1 && vehiclePosts.length === 1 && weOwePosts.length === 1,
   `with every box answered the save should go through once, saw ${customerPosts.length}/${vehiclePosts.length}/${weOwePosts.length}`);
ok(!$("#we-owe-dialog").open, "the dialog should close after the save");
ok(weOwePosts[0].description === "Replace missing passenger mirror",
   "the promise should save what was typed");

ok(rejections.length === 0, `unhandled rejections: ${rejections.join(", ")}`);
finish("dialog errors: toasts render above open dialogs, missing-field notes stand beside their fields");
