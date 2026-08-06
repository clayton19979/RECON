// The On Order desk's Expected column, driven in a real DOM.
//
// The desk exists to decide who to ring this morning, and the promised day is
// what turns "this has been nine days" into "they said Tuesday and it's
// Friday". These assertions are about the two things that go wrong when a
// column like this is bolted onto a list:
//
//   - it starts lying. "They didn't say" is the common state and must render
//     as an empty box, never as a count and never as due-today. Due today is
//     not late; one day past is.
//   - it stops the row working. The whole row opens the vehicle, so a date box
//     inside it has to swallow its own clicks -- otherwise reaching for the
//     picker navigates away from the desk before anything can be typed.
//
// And one behaviour that is the point of putting the box here at all: typing a
// date saves it against the *batch*, so the answer from one phone call reaches
// every part that went out on that call without being typed four times.

import { boot, click } from "./harness.mjs";

const NOW = Date.now();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
// Calendar dates, the way the server hands expected_at over -- shop-local
// days, not timestamps. days_late is the server's own figure and is supplied
// alongside so the front end is never caught recomputing it from the string.
const dayOffset = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

// Two parts on one batch two days past what the vendor promised, one part due
// today, one part nobody was given a date for, and one legacy line with no
// batch at all to hang a date on. Nothing here has been waiting a week, so the
// summary card can only reach a warning tone because of the broken promises --
// which is the point of that assertion.
const ON_ORDER = [
  { id: 31, order_id: 1, po_id: 7, po_number: "1-1", po_outstanding: 2, vendor_name: "WorldPac",
    description: "Windshield", part_number: "WS-4471", ro_number: "RO-2607-0001",
    vehicle_label: "R-1042", vehicle: "2019 Ford Edge", outstanding_quantity: 1, value: 180,
    ordered_at: daysAgo(5), days_waiting: 5, expected_at: dayOffset(-2), days_late: 2,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, vehicle_id: 5, stock_number: "R-1042",
    we_owe_customer_name: null },
  { id: 32, order_id: 1, po_id: 7, po_number: "1-1", po_outstanding: 2, vendor_name: "WorldPac",
    description: "Wiper blades", part_number: "WB-9", ro_number: "RO-2607-0001",
    vehicle_label: "R-1042", vehicle: "2019 Ford Edge", outstanding_quantity: 2, value: 24,
    ordered_at: daysAgo(5), days_waiting: 5, expected_at: dayOffset(-2), days_late: 2,
    segment: "recon", recon_vehicle_id: 7, we_owe_id: null, vehicle_id: 5, stock_number: "R-1042",
    we_owe_customer_name: null },
  { id: 33, order_id: 2, po_id: 8, po_number: "2-1", po_outstanding: 1, vendor_name: "NAPA",
    description: "Serpentine belt", part_number: "SB-118", ro_number: "RO-2607-0002",
    vehicle_label: "We-Owe: Maria Soto", vehicle: "2021 Kia Sorento", outstanding_quantity: 1, value: 28,
    ordered_at: daysAgo(1), days_waiting: 1, expected_at: dayOffset(0), days_late: 0,
    segment: "we_owe", recon_vehicle_id: null, we_owe_id: 9, vehicle_id: 6, stock_number: null,
    we_owe_customer_name: "Maria Soto" },
  { id: 34, order_id: 3, po_id: 9, po_number: "3-1", po_outstanding: 1, vendor_name: "",
    description: "Rear bumper cover", part_number: "BC-3", ro_number: "RO-2607-0003",
    vehicle_label: "R-0999", vehicle: "2018 Honda Civic", outstanding_quantity: 1, value: 210,
    ordered_at: daysAgo(3), days_waiting: 3, expected_at: "", days_late: null,
    segment: "recon", recon_vehicle_id: 8, we_owe_id: null, vehicle_id: 7, stock_number: "R-0999",
    we_owe_customer_name: null },
  { id: 35, order_id: 4, po_id: null, po_number: null, po_outstanding: 0, vendor_name: "",
    description: "Mounting bracket kit", part_number: null, ro_number: "RO-2607-0004",
    vehicle_label: "R-0940", vehicle: "2014 Jeep Patriot", outstanding_quantity: 1, value: 95,
    ordered_at: "", days_waiting: null, expected_at: "", days_late: null,
    segment: "recon", recon_vehicle_id: 9, we_owe_id: null, vehicle_id: 8, stock_number: "R-0940",
    we_owe_customer_name: null },
];

const patches = [];
let served = ON_ORDER;

const { w, doc, settle, ok, finish, rejections, fetchLog } = await boot({
  expose: ["state", "showView", "loadCoresView"],
  fetch: async (url, opts) => {
    if (url === "/api/parts/on-order") return served;
    if (url === "/api/parts/missing-receipts") return [];
    if (url === "/api/cores") return [];
    if (url === "/api/returns") return [];
    if (url === "/api/vendors") return [];
    if (url.includes("/purchase-orders/") && opts.method === "PATCH") {
      const body = JSON.parse(opts.body);
      const poId = Number(url.split("/").pop());
      patches.push({ url, body, poId });
      // The server answers per batch, so every line on that batch moves --
      // which is exactly the behaviour the last assertion below is about.
      served = served.map((p) => (p.po_id === poId
        ? { ...p, expected_at: body.expected_at, days_late: body.expected_at ? -4 : null }
        : p));
      return { ok: true, expected_at: body.expected_at };
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    if (url.startsWith("/api/staff")) return [];
    return [];
  },
});

w.showView("cores");
await settle();

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const row = (id) => $(`#on-order-table tr[data-id="${id}"]`);
const etaBox = (id) => row(id) && row(id).querySelector(".eta-input");
const etaText = (id) => row(id).querySelector(".eta-col").textContent.replace(/\s+/g, " ").trim();
const chip = (filter) => $(`[data-on-order-filter="${filter}"]`);

/* ---------- the header and the rows are the same width ---------- */
const headers = $$("#view-cores .desk-order thead th").length;
const cells = row(31).querySelectorAll("td").length;
ok(headers === cells, `the On Order header has ${headers} columns but a row emits ${cells} cells`);

/* ---------- broken promises lead, and the server's order is kept ---------- */
const order = $$("#on-order-table tr[data-id]").map((tr) => Number(tr.dataset.id));
ok(JSON.stringify(order) === JSON.stringify([31, 32, 33, 34, 35]),
   `the desk re-sorted what the server handed it: ${JSON.stringify(order)}`);

/* ---------- what each state renders as ---------- */
ok(etaBox(31).value === dayOffset(-2), `a promised day isn't in its box: "${etaBox(31).value}"`);
ok(etaBox(31).classList.contains("late"), "a promise two days broken isn't flagged late");
ok(/2d late/.test(etaText(31)), `a broken promise doesn't say how far past it is: "${etaText(31)}"`);

ok(etaBox(33).value === dayOffset(0), "a part due today isn't showing its date");
ok(!etaBox(33).classList.contains("late"),
   "a part due today is flagged late -- it may still turn up this afternoon");
ok(/due today/.test(etaText(33)), `a part due today doesn't say so: "${etaText(33)}"`);

// The honesty case: 19 days out and nobody was given a date. The box has to be
// empty and say nothing at all -- not "due today", not "0d late".
ok(etaBox(34).value === "", `a part nobody gave a day for invented one: "${etaBox(34).value}"`);
ok(!/late|due|in \d/.test(etaText(34)),
   `a part with no promised day is being described as if it had one: "${etaText(34)}"`);

// A line from before batches existed has nothing to hang a date on, so it gets
// a dash rather than a box that would silently save nowhere.
ok(!etaBox(35), "a line with no batch is offering an editable date box it cannot save");
ok(etaText(35) === "—", `a batch-less line should render a plain dash: "${etaText(35)}"`);

/* ---------- the summary says what can be acted on today ---------- */
const onOrderCard = $$("#cores-returns-stats .stat")[0];
const cardText = onOrderCard.textContent.replace(/\s+/g, " ");
ok(/2 past the promised day/.test(cardText),
   `the On Order card doesn't count broken promises: "${cardText.trim()}"`);
ok(onOrderCard.querySelector(".stat-value").classList.contains("warn"),
   "broken promises don't tone the On Order card, so nothing on screen says to act");

/* ---------- the chip filters to exactly the broken promises ---------- */
chip("late").click();
await settle();
const late = $$("#on-order-table tr[data-id]").map((tr) => Number(tr.dataset.id));
ok(JSON.stringify(late) === JSON.stringify([31, 32]),
   `"Past the promised day" isn't showing exactly the broken promises: ${JSON.stringify(late)}`);
ok(/2 parts/.test($("#on-order-count").textContent), `the count didn't follow the chip: "${$("#on-order-count").textContent}"`);

// Nothing broken -> the empty state has to say the promises are being kept,
// not that nothing is on order at all.
served = ON_ORDER.map((p) => ({ ...p, days_late: p.days_late == null ? null : -1 }));
await w.loadCoresView();
await settle();
ok(/broken a promise/i.test($("#on-order-table").textContent),
   `the "past the promised day" empty state doesn't say why it's empty: "${$("#on-order-table").textContent.trim()}"`);

chip("").click();
served = ON_ORDER;
await w.loadCoresView();
await settle();

/* ---------- the box swallows its own clicks ---------- */
// Opening the vehicle fetches its detail, so a request going out for one is
// the observable proof the click escaped the box and reached the row.
const quiet = fetchLog.length;
click(w, etaBox(31));
await settle();
const escaped = fetchLog.slice(quiet).filter((r) => /^\/api\/(recon|we-owe|orders)\//.test(r.url));
ok(escaped.length === 0,
   `clicking the date box navigated away instead of letting the date be typed: ${JSON.stringify(escaped)}`);

/* ---------- typing a day saves it against the batch ---------- */
const box = etaBox(31);
box.value = dayOffset(4);
box.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
await settle();

ok(patches.length === 1, `typing a date should send exactly one save, sent ${patches.length}`);
ok(patches[0].url === "/api/orders/1/purchase-orders/7",
   `the date was saved to the wrong place: ${patches[0] && patches[0].url}`);
ok(patches[0].body.expected_at === dayOffset(4),
   `the date sent isn't the one typed: ${patches[0] && patches[0].body.expected_at}`);

// One call, one answer: the second part on that batch has to have moved too,
// without anybody typing the date again.
ok(etaBox(32).value === dayOffset(4),
   `the other part on the same batch kept the old date: "${etaBox(32).value}"`);
ok(!etaBox(32).classList.contains("late"), "a promise moved into the future is still flagged late");

/* ---------- clearing it goes back to "they didn't say" ---------- */
const box2 = etaBox(31);
box2.value = "";
box2.dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
await settle();
ok(patches.length === 2 && patches[1].body.expected_at === "",
   "clearing the box didn't send an empty date, so a wrong day can never be taken back off");
ok(etaBox(31).value === "" && !/late|due today/.test(etaText(31)),
   `a cleared promise is still being described: "${etaText(31)}"`);

ok(rejections.length === 0, `unhandled rejections: ${rejections.map((e) => e && e.message).join(", ")}`);
finish("on order — expected day");
