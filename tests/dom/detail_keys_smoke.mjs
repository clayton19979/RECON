// Vehicle detail keyboard smoke test.
//
// The board has been fully keyboard-drivable for a while: arrow to a car,
// Enter opens it -- and then the keyboard stopped working. Getting back out,
// or on to the next car, meant reaching for the mouse, once per car, all
// morning. This drives the other half of that loop: Escape backs out to the
// board with the cursor still on the car you were reading, and Alt+Arrows
// flip straight to the board's previous/next car without going back at all.
//
// Also covers the stale-load guard: flipping quickly means a slow fetch for
// the car you already left can resolve *after* the next car's page loaded,
// and it must not paint the old car's data over the new car's page.

import { boot, press } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", plate: "", plate_state: "", color: "", customer_name: "", status: "in_progress", status_bucket: "in_progress",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  acquired_at: "", age_days: 1, parts_pending: 0, parts_pending_value: 0,
  idle_days: 0, last_activity_at: "2026-07-25T08:00:00", order_id: null,
  lot_bucket: "working", needs: "work under way", remaining_cost: 0, ...over,
});

// Three cars in one pile, so the board shows them in exactly this order in
// both layouts and "next" is unambiguous.
const board = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150" }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic" }),
  veh({ recon_id: 3, stock_number: "C007", vehicle: "2015 Chevy Silverado" }),
];

const NAMES = { 1: ["Ford", "F-150"], 2: ["Honda", "Civic"], 3: ["Chevy", "Silverado"] };
const reconItem = (id) => ({
  id, stock_number: board.find((v) => v.recon_id === id)?.stock_number || "", year: 2019,
  make: NAMES[id][0], model: NAMES[id][1],
  vin: "", mileage: 0, trim: "", color: "", plate: "", plate_state: "",
  purchase_price: 0, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 1, created_at: "2026-07-01T09:00:00", updated_at: "2026-07-01T09:00:00",
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
  last_activity: { at: "2026-07-25T08:00:00", idle_days: 0, action: "", actor: "" },
});

// When set, the fetch for car 1's record parks on this promise -- the "slow
// server answers late" the stale-load guard exists for.
let gateCar1 = null;

const { w, doc, settle, ok, finish } = await boot({
  expose: ["state", "openVehicleDetail", "displayedVehicles", "vehicleKey"],
  fetch: async (url) => {
    if (url.startsWith("/api/vehicles-board")) {
      if (url.includes("view=history") || url.includes("view=void")) return [];
      return board;
    }
    const recon = url.match(/^\/api\/recon\/vehicles\/(\d+)$/);
    if (recon) {
      const id = Number(recon[1]);
      if (id === 1 && gateCar1) await gateCar1;
      return reconItem(id);
    }
    const retail = url.match(/^\/api\/retail\/vehicles\/(\d+)$/);
    if (retail) return { id: Number(retail[1]), customer_id: 1, customer_name: "Marta Alvarez", year: 2015, make: "Jeep", model: "Patriot",
      vin: "", mileage: 0, trim: "", color: "", archived_at: "", edit_version: 0, orders: [], total_cost: 0, quoted_cost: 0,
      last_activity: { at: "2026-01-10T09:30:00", idle_days: 0, action: "", actor: "" },
      other_vehicles: [] };
    if (url === "/api/orders" || url.startsWith("/api/orders?")) return [];
    return [];
  },
});

await settle();

const detailActive = () => doc.querySelector("#view-vehicle-detail").classList.contains("active");
const viewActive = (name) => doc.querySelector(`#view-${name}`).classList.contains("active");

/* ---------- open a car the way the board does ---------- */
await w.openVehicleDetail("recon", 1);
await settle();
w.state.vehicleCursor = "recon:1"; // what the click/Enter that opened it sets
ok(detailActive(), "the detail page should be showing after opening a car");

/* ---------- Alt+ArrowDown walks the board's order ---------- */
const expected = w.displayedVehicles().map((v) => w.vehicleKey(v));
ok(expected.join(",") === "recon:1,recon:2,recon:3",
   `fixture order should be unambiguous, got ${expected.join(",")}`);

press(w, "ArrowDown", { altKey: true });
await settle();
ok(w.state.detail.id === 2, `Alt+ArrowDown should flip to the next car, got recon ${w.state.detail.id}`);
ok(w.state.vehicleCursor === "recon:2",
   `the board's cursor should follow the flip, got ${w.state.vehicleCursor}`);
ok(detailActive(), "flipping cars should stay on the detail page");

press(w, "ArrowDown", { altKey: true });
await settle();
ok(w.state.detail.id === 3, `a second Alt+ArrowDown should reach the third car, got ${w.state.detail.id}`);

/* ---------- clamped at the ends, like the board's own cursor ---------- */
press(w, "ArrowDown", { altKey: true });
await settle();
ok(w.state.detail.id === 3, "Alt+ArrowDown past the last car should stay put");

press(w, "ArrowUp", { altKey: true });
await settle();
ok(w.state.detail.id === 2, `Alt+ArrowUp should flip back, got ${w.state.detail.id}`);

/* ---------- plain arrows are not stolen from the page ---------- */
press(w, "ArrowDown");
await settle();
ok(w.state.detail.id === 2, "a plain ArrowDown (scrolling) must not change cars");

/* ---------- Escape backs out, cursor still on the car you left ---------- */
press(w, "Escape");
await settle();
ok(viewActive("vehicles"), "Escape should land back on the board");
ok(!detailActive(), "the detail page should be gone after Escape");
ok(w.state.vehicleCursor === "recon:2",
   `the cursor should still be on the car that was open, got ${w.state.vehicleCursor}`);
const cursorNode = doc.querySelector('#view-vehicles [data-key="recon\\:2"].cursor');
ok(cursorNode, "the board should show the cursor on the car that was open");

/* ---------- guards: a dialog or menu owns Escape while it is open ---------- */
await w.openVehicleDetail("recon", 2);
await settle();

const dlg = doc.querySelector("#shortcuts-dialog");
dlg.setAttribute("open", "");
press(w, "Escape");
await settle();
ok(detailActive(), "Escape with a dialog open must not leave the page");
press(w, "ArrowDown", { altKey: true });
await settle();
ok(w.state.detail.id === 2, "Alt+ArrowDown with a dialog open must not flip cars");
dlg.removeAttribute("open");

const notif = doc.querySelector("#notif-menu");
notif.classList.add("open");
press(w, "Escape");
await settle();
ok(detailActive(), "Escape with the messages menu open must not leave the page");
notif.classList.remove("open");

const assignMenu = doc.querySelector("#vd-assign-picker-menu");
assignMenu.classList.add("open");
press(w, "Escape");
await settle();
ok(detailActive(), "Escape with the assign menu open must not leave the page");
assignMenu.classList.remove("open");

/* ---------- guards: a keystroke inside a field belongs to the field ---------- */
press(w, "Escape", { target: doc.querySelector("#vd-new-ro-concern") });
await settle();
ok(detailActive(), "Escape while typing in a field must not leave the page");
press(w, "ArrowDown", { altKey: true, target: doc.querySelector("#vd-new-ro-concern") });
await settle();
ok(w.state.detail.id === 2, "Alt+ArrowDown while typing must not flip cars");

/* ---------- a retail page: home is Customers, and there is no walk ---------- */
await w.openVehicleDetail("retail", 55);
await settle();
press(w, "ArrowDown", { altKey: true });
await settle();
ok(w.state.detail.segment === "retail" && w.state.detail.id === 55,
   "Alt+ArrowDown on a retail page must not walk the board's cars");
press(w, "Escape");
await settle();
ok(viewActive("customers"), "Escape on a retail page should go home to Customers");

/* ---------- the stale-load guard ----------
   Car 1's record fetch is parked; car 2 is opened and finishes rendering
   first. When car 1's fetch finally answers, its load must notice the page
   has moved on and throw the answer away, not paint the F-150's name over
   the Civic's page. */
let releaseCar1;
gateCar1 = new Promise((resolve) => { releaseCar1 = resolve; });
const slowOpen = w.openVehicleDetail("recon", 1); // parks on the gate
const fastOpen = w.openVehicleDetail("recon", 2); // replaces state.detail, runs to the end
await fastOpen;
await settle();
ok(/Civic/.test(doc.querySelector("#vd-title").textContent),
   `the page should be on the Civic before the stale answer lands, reads "${doc.querySelector("#vd-title").textContent}"`);
releaseCar1();
gateCar1 = null;
await slowOpen;
await settle();
ok(w.state.detail.id === 2 && /Civic/.test(doc.querySelector("#vd-title").textContent),
   `a stale load must not repaint the page: expected the Civic, page reads "${doc.querySelector("#vd-title").textContent}"`);
ok(w.state.detail.item && w.state.detail.item.id === 2,
   `a stale load must not overwrite the loaded car's data, item is ${w.state.detail.item && w.state.detail.item.id}`);

finish("vehicle detail: Escape backs out, Alt+Arrows walk the board's cars, stale loads discarded");
