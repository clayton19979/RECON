// Ticket top bar smoke test.
//
// The bar that stands in for the ticket page's identity band while it's
// scrolled away is only trustworthy if it is a copy, never an author: every
// fact on it must be read off the band, and must follow the band when a
// render rewrites it. jsdom has no IntersectionObserver, so the show/hide
// half stays untested here -- what's tested is the copy itself, the
// mutation-follow, and that the bar's chevron really is the band's
// "Back to Vehicles" under another coat of paint.

import { boot, click } from "./harness.mjs";

const vehicle = {
  id: 7, stock_number: "R-0997", year: 2018, make: "Honda", model: "Accord",
  vin: "1HGCV1F34JA123456", mileage: 52300, trim: "", color: "",
  plate: "", plate_state: "",
  purchase_price: 0, sale_price: null, status: "in_repair", archived_at: "",
  edit_version: 1, created_at: "2026-07-01T09:00:00", updated_at: "2026-07-20T09:00:00",
  orders: [], total_cost: 0, quoted_cost: 0, profit: null, status_bucket: "in_progress",
  last_activity: null,
};

const { w, doc, settle, ok, finish, rejections } = await boot({
  expose: ["openVehicleDetail", "syncTicketTopbar"],
  fetch: async (url) => {
    if (/^\/api\/recon\/vehicles\/7$/.test(url)) return vehicle;
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/orders")) return [];
    return [];
  },
});
await settle();

const raf = () => new Promise((r) => w.requestAnimationFrame(() => r()));

/* ---------- the copy ----------
   Open a car, run one sync, and the bar must say what the band says --
   title, pill (text, color class and hidden state) and the cost block's
   hidden state all read from the band, not re-derived. */
{
  w.openVehicleDetail("recon", 7);
  await settle();
  ok(doc.querySelector("#view-vehicle-detail").classList.contains("active"),
     "the vehicle page never opened");
  w.syncTicketTopbar();
  const bandTitle = doc.querySelector("#vd-title").textContent;
  ok(bandTitle.includes("R-0997"), `band title doesn't name the car: "${bandTitle}"`);
  ok(doc.querySelector("#vd-topbar-title").textContent === bandTitle,
     "the bar's title isn't the band's title");
  const pillSrc = doc.querySelector("#vd-status-pill");
  const pill = doc.querySelector("#vd-topbar-pill");
  ok(pill.hidden === pillSrc.hidden, "the bar's pill doesn't match the band pill's visibility");
  ok(pill.textContent === pillSrc.textContent, "the bar's pill says something different from the band's");
  ok(pill.className === pillSrc.className, "the bar's pill lost the band pill's color class");
  ok(doc.querySelector("#vd-topbar-cost").hidden === doc.querySelector("#vd-head-cost").hidden,
     "the bar's cost block doesn't match the band's cost visibility");
  // A recon car has no customer to name, and the bar must not invent one.
  ok(doc.querySelector("#vd-topbar-who").hidden,
     "the bar names a customer on a recon car");
}

/* ---------- the follow ----------
   A render that rewrites the band while the bar is standing in for it must
   reach the bar without anyone calling sync by hand -- that's the
   MutationObserver's whole job. */
{
  doc.querySelector("#vd-title").textContent = "R-0997 — 2018 Honda Accord (renamed)";
  // One frame for the rAF debounce behind the observer.
  await raf();
  await raf();
  ok(doc.querySelector("#vd-topbar-title").textContent.includes("(renamed)"),
     "a band rewrite never reached the bar");
}

/* ---------- the chevron ----------
   The bar's back button is the band's Back to Vehicles, not a second
   opinion about where "back" goes. */
{
  click(w, doc.querySelector("#vd-topbar-back"));
  await settle();
  ok(!doc.querySelector("#view-vehicle-detail").classList.contains("active"),
     "the bar's chevron didn't leave the ticket");
  ok(doc.querySelector("#view-vehicles").classList.contains("active"),
     "the bar's chevron didn't land on the Vehicles board");
}

ok(rejections.length === 0, `unhandled rejections: ${rejections.map(String).join(", ")}`);
finish("the ticket top bar copies the band, follows its rewrites, and goes back where the band goes");
