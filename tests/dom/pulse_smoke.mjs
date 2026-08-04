// "This screen is out of date" smoke test.
//
// Two people on two PCs share one database, and every screen used to be a
// photograph taken when it was opened. The server now keeps a counter that
// moves on every write; this is the browser half, and the only part of it
// worth testing is the judgement call: when is it safe to redraw a screen
// under somebody, and when must it wait to be asked?
//
// Getting that backwards is not a cosmetic bug. Redraw a list while an
// advisor is halfway through ticking rows for a bulk action, or while their
// cursor is in a box, and the app throws away work they were in the middle
// of -- which is a far worse failure than the staleness it was fixing.

import { boot, click } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "in_progress", status_bucket: "in_progress",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], updated_at: "2026-07-01T09:00:00",
  acquired_at: "", age_days: 1, parts_pending: 0, parts_pending_value: 0,
  idle_days: 0, last_activity_at: "2026-07-25T08:00:00", order_id: null,
  lot_bucket: "working", needs: "work under way", remaining_cost: 0, ...over,
});

const board = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150" }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic" }),
];

// What the other PC has done, as far as this browser can tell.
let revision = 7;

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["checkPulse", "state", "openVehicleDetail"],
  fetch: async (url) => {
    if (url === "/api/pulse") return { revision };
    if (url.startsWith("/api/vehicles-board")) return board;
    if (/^\/api\/recon\/vehicles\/\d+$/.test(url)) {
      return { id: 1, archived_at: "", stock_number: "B204", year: 2019, make: "Ford", model: "F-150", orders: [] };
    }
    if (url.startsWith("/api/orders")) return [];
    return [];
  },
});
await settle();

const bar = doc.querySelector("#stale-bar");
const boardLoads = () => fetchLog.filter((f) => f.url.startsWith("/api/vehicles-board")).length;

/* Anything that loads or saves resets the baseline to "whatever the counter
   says next is current", and the next poll is what adopts it. In the real app
   that poll comes round on its own a few seconds later; here it is asked for,
   so each section below starts from a screen that knows what it is showing. */
const adopt = async () => { await w.checkPulse(); await settle(); };
await adopt();

ok(bar, "index.html has no #stale-bar for the freshness notice to live in");
ok(bar.hidden, "the notice was showing before anything had changed");

/* ---------- nothing in progress: just put it right ----------
   The board is a list of cars and nobody is holding anything on it. Making
   the advisor press a button to see a number that is already wrong would be
   asking permission to stop lying. */
{
  const before = boardLoads();
  revision = 8;
  await w.checkPulse();
  await settle();
  ok(boardLoads() > before, "a change on the other PC didn't refresh an idle board");
  ok(bar.hidden, "an idle board that refreshed itself still showed the notice");
}

/* ---------- rows ticked for a bulk action ----------
   Reloading a list clears its selection, so a silent redraw here would undo
   the picking somebody had just done -- with no error, and nothing to say
   where their ticks went. */
{
  w.state.vehicleSelection.add("recon:1");
  const before = boardLoads();
  revision = 9;
  await w.checkPulse();
  await settle();
  ok(boardLoads() === before, "a redraw threw away rows that were ticked for a bulk action");
  ok(!bar.hidden, "the screen went stale behind a selection and said nothing");

  // Refresh is the way out, and it takes the notice with it.
  click(w, doc.querySelector("#stale-refresh"));
  await settle();
  ok(boardLoads() > before, "the Refresh button didn't reload the screen");
  ok(bar.hidden, "the notice stayed up after refreshing");
  w.state.vehicleSelection.clear();
  await adopt();
}

/* ---------- a cursor in a box ---------- */
{
  const search = doc.querySelector("#global-search");
  search.focus();
  const before = boardLoads();
  revision = 10;
  await w.checkPulse();
  await settle();
  ok(boardLoads() === before, "the screen redrew itself while someone was typing in it");
  ok(!bar.hidden, "a change while typing wasn't reported at all");

  // Later hides this one and nothing else: the next change says so again,
  // rather than the notice either nagging forever or never coming back.
  click(w, doc.querySelector("#stale-dismiss"));
  ok(bar.hidden, "Later didn't hide the notice");
  revision = 11;
  await w.checkPulse();
  await settle();
  ok(!bar.hidden, "after Later, the next change never got reported");
  search.blur();
  click(w, doc.querySelector("#stale-dismiss"));
}

/* ---------- a dialog open ---------- */
{
  doc.querySelector("#recon-dialog").showModal();
  const before = boardLoads();
  revision = 12;
  await w.checkPulse();
  await settle();
  ok(boardLoads() === before, "the screen redrew itself underneath an open dialog");
  ok(!bar.hidden, "a change while a dialog was open wasn't reported");
  doc.querySelector("#recon-dialog").close();
  click(w, doc.querySelector("#stale-dismiss"));
}

/* ---------- a repair order on screen ----------
   The vehicle's page carries the editable parts-and-labour grid, so it is
   never redrawn unasked however idle it looks. */
{
  await w.openVehicleDetail("recon", 1);
  await settle();
  ok(doc.querySelector("#view-vehicle-detail").classList.contains("active"), "the vehicle page didn't open");
  ok(bar.hidden, "opening a car carried the previous screen's stale notice onto it");
  await adopt();

  const before = fetchLog.filter((f) => /^\/api\/recon\/vehicles\/1$/.test(f.url)).length;
  revision = 13;
  await w.checkPulse();
  await settle();
  ok(fetchLog.filter((f) => /^\/api\/recon\/vehicles\/1$/.test(f.url)).length === before,
     "a repair order on screen was redrawn without being asked");
  ok(!bar.hidden, "a change while a repair order was open wasn't reported");

  // ...and Refresh reloads the car, not whatever screen it came from.
  click(w, doc.querySelector("#stale-refresh"));
  await settle();
  ok(fetchLog.filter((f) => /^\/api\/recon\/vehicles\/1$/.test(f.url)).length > before,
     "Refresh on a vehicle page didn't reload the vehicle");
  ok(bar.hidden, "the notice survived a refresh on the vehicle page");
}

/* ---------- this PC's own saves ----------
   Every save reloads the screen that made it, so the counter moving because
   of us is not news. Telling Clayton his own click has made his screen stale
   is the fastest way to teach him to ignore the notice. */
{
  await adopt();
  ok(bar.hidden, "the notice was still up going into the last case");
  revision = 20;
  doc.dispatchEvent(new w.CustomEvent("recon:wrote"));
  await adopt();
  ok(bar.hidden, "the app reported this PC's own save as somebody else's change");
}

ok(rejections.length === 0, `unhandled rejections: ${rejections.map(String).join(", ")}`);
finish("stale screens refresh when idle, and wait to be asked when they can't");
