// Reports screen smoke test.
//
// Reports is the one screen whose entire job is arithmetic on top of a list:
// four summary numbers, a chart scaled to the largest bar, a sortable table
// and a printable copy, all of which have to agree with each other and with
// the rows that came back. The Python tests cover the two endpoints and the
// two CSV exports; nothing but a real DOM covers the reading of them.
//
// It's also the screen with the most state that has to survive a round trip
// (report type, range, sort, all in localStorage) and the most ways for the
// controls to end up describing a range that isn't in effect.

import { boot, click } from "./harness.mjs";

const veh = (over) => ({
  segment: "recon", recon_id: null, we_owe_id: null, stock_number: "", vehicle: "",
  vin: "", customer_name: "", status: "in_progress", status_bucket: "in_progress",
  purchase_price: 0, actual_cost: 0, quoted_cost: 0, technicians: [], customer_paid: 0,
  net_cost: 0, updated_at: "2026-07-01T09:00:00", age_days: 1, ...over,
});

// Costs chosen so every summary number is checkable by hand:
//   total 3000, 4 vehicles -> avg 750.
// The Camry is quoted at 2000 against 1000 of actual cost, which makes the
// largest *quote* larger than the largest *bar* -- the case where a chart
// scaled to its bars alone pushes the quote marker off the end.
const spend = [
  veh({ recon_id: 1, stock_number: "B204", vehicle: "2019 Ford F-150", status: "in_progress", technicians: ["Dana"], quoted_cost: 900, actual_cost: 1450 }),
  veh({ recon_id: 2, stock_number: "A118", vehicle: "2021 Honda Civic", status: "estimate", technicians: [], quoted_cost: 600, actual_cost: 550 }),
  veh({ segment: "we_owe", we_owe_id: 5, vehicle: "2017 Toyota Camry", customer_name: "R. Alvarez", status: "pending_approval", technicians: ["Chris"], quoted_cost: 2000, actual_cost: 1000 }),
  veh({ recon_id: 3, stock_number: "C007", vehicle: "2015 Chevy Silverado", status: "complete", status_bucket: "finished", technicians: ["Bo"], quoted_cost: 0, actual_cost: 0 }),
];

// 3 on the roster, 2 with work; 6 ROs, 3 completed; 25 hours; 3 still open,
// the quietest of them sitting 9 days. No money: labor here is never charged
// out, so the report carries no cost field at all.
const techs = [
  { technician: "Bo", ro_count: 4, completed_count: 2, open_count: 2, worst_idle_days: 9, labor_hours: 15 },
  { technician: "Chris", ro_count: 2, completed_count: 1, open_count: 1, worst_idle_days: 0, labor_hours: 10 },
  { technician: "Dana", ro_count: 0, completed_count: 0, open_count: 0, worst_idle_days: 0, labor_hours: 0 },
];

let failNextReport = false;

// What the previous session left behind: This Month, saved back when it meant
// something else entirely. The dates are the trap -- a named range that
// replays them reopens covering January 2020 with the This Month chip lit.
const STALE_PREFS = {
  type: "vehicle-spend", range: "month", start: "2020-01-01", end: "2020-01-05",
  sort: { key: "cost", dir: "desc" }, sortShape: "vehicle-spend",
};

const { w, doc, fetchLog, settle, ok, finish, rejections } = await boot({
  expose: ["state", "generateReport", "loadReportsView", "sortReportRows", "visibleReportRows",
           "REPORT_SORTS", "REPORT_PREFS_KEY", "loadReportPrefs", "saveReportPrefs", "setReportRange",
           "computeQuickRange", "reportCsvHref", "syncReportControls"],
  // Staged before the app boots, so the first fetch the screen ever makes is
  // the one under test. REPORT_PREFS_KEY isn't on window yet at this point.
  beforeBoot: (win) => win.localStorage.setItem("dao-report-view", JSON.stringify(STALE_PREFS)),
  fetch: async (url) => {
    if (url.startsWith("/api/reports/")) {
      if (failNextReport) return { __status: 500, body: { detail: "reporting is down" } };
      return url.startsWith("/api/reports/technicians") ? techs : spend;
    }
    if (url.startsWith("/api/vehicles-board")) return [];
    return [];
  },
});

const rail = (name) => doc.querySelector(`.rail-item[data-view="${name}"]`);
const stats = () => [...doc.querySelectorAll("#report-stats .stat")].map((s) => ({
  label: s.querySelector(".stat-label").textContent,
  value: s.querySelector(".stat-value").textContent,
  sub: s.querySelector(".stat-sub").textContent,
}));
const bars = () => [...doc.querySelectorAll("#report-chart .bar-row")];
const rows = () => [...doc.querySelectorAll("#report-output tbody tr")];
const cells = (i) => [...rows()[i].children].map((td) => td.textContent.trim());
const th = (key) => doc.querySelector(`#report-output th[data-report-sort="${key}"]`);
const col = (key) => {
  const heads = [...doc.querySelectorAll("#report-output thead th")];
  return heads.findIndex((h) => h.dataset.reportSort === key);
};

/* ---------- the screen loads itself ---------- */
// The old version was a form: you landed on an empty card and nothing
// happened until you pressed Generate.
click(w, rail("reports"));
await settle();

ok(fetchLog.some((f) => f.url.startsWith("/api/reports/vehicle-spend")),
   `opening Reports didn't fetch a report; saw ${fetchLog.map((f) => f.url).join(", ")}`);
ok(rows().length > 0, "Reports opened with no table");
ok(doc.querySelector("#report-output .skeleton-row") === null, "loading skeleton is still on screen after the fetch resolved");

/* ---------- a saved quick range means today, not the day it was saved ----------
   The live symptom of getting this wrong: This Month lit over July 1-29 on
   July 31, with two days of work missing from every number on the screen, the
   printed sheet and the CSV. */
const thisMonth = w.computeQuickRange("month");
const opening = fetchLog.find((f) => f.url.startsWith("/api/reports/vehicle-spend"));
ok(opening.url.includes(`start=${thisMonth.start}`) && opening.url.includes(`end=${thisMonth.end}`),
   `the first fetch replayed the saved dates instead of resolving This Month against today: ${opening.url}`);
ok(!opening.url.includes("2020-01"), `the range saved by the previous session reached the query: ${opening.url}`);
ok(doc.querySelector("#report-start").value === thisMonth.start && doc.querySelector("#report-end").value === thisMonth.end,
   `the From/To fields show ${doc.querySelector("#report-start").value} – ${doc.querySelector("#report-end").value}, not the month the numbers cover`);
ok(doc.querySelector('[data-report-range="month"]').classList.contains("active"),
   "This Month isn't lit, so the toolbar and the range in effect disagree the other way");

// ...and nothing writes those dates back down, so there is nothing to go stale.
w.saveReportPrefs();
const storedMonth = JSON.parse(w.localStorage.getItem(w.REPORT_PREFS_KEY));
ok(!storedMonth.start && !storedMonth.end,
   `a named range was saved with dates attached (${storedMonth.start} – ${storedMonth.end}); it has to be stored by name alone`);

// The other half of the same bug: the app is left open, the shop works
// evenings, and past midnight "Today" still means yesterday. Any refresh has
// to correct it -- simulated here by putting yesterday's answer back.
w.state.reportStart = "2020-01-01";
w.state.reportEnd = "2020-01-05";
await w.loadReportsView();
await settle();
ok(fetchLog.at(-1).url.includes(`start=${thisMonth.start}`),
   `reopening the screen kept a range that had gone stale on the clock: ${fetchLog.at(-1).url}`);
ok(doc.querySelector("#report-start").value === thisMonth.start,
   "the From field kept the stale date after the fetch moved on without it");

/* ---------- summary cards ---------- */
const s = stats();
ok(s.length === 3, `expected 3 summary cards, got ${s.length}`);
ok(s[0].value === "4", `Vehicles card reads ${s[0].value}, expected 4`);
ok(s[0].sub === "3 recon · 1 we-owe", `segment split reads "${s[0].sub}"`);
ok(s[1].value === "$3,000.00", `Total Cost reads ${s[1].value}, expected $3,000.00`);
ok(s[2].value === "$750.00", `Average Per Vehicle reads ${s[2].value}, expected $750.00 ($3,000 over all 4)`);

// The cards describe the same rows as the table below them -- the whole
// reason they live on this screen rather than being a second lot-wide
// summary that quietly disagrees with the list.
const tableTotal = doc.querySelector("#report-output tfoot").textContent;
ok(tableTotal.includes("$3,000.00"), `table footer total "${tableTotal}" doesn't match the Total Cost card`);
ok(tableTotal.includes("4 vehicles"), `table footer says "${tableTotal.trim()}" but the Vehicles card says 4`);

/* ---------- chart ---------- */
ok(bars().length === 3, `expected 3 bars (the $0 vehicle is dropped), got ${bars().length}`);
const widths = bars().map((b) => parseFloat(b.querySelector(".bar-fill").style.width));
ok(widths[0] > widths[1] && widths[1] > widths[2], `bars aren't sorted by size: ${widths.join(", ")}`);
// One scale, set by the largest cost on the chart -- the biggest bar fills
// the track and every other bar is read against it. There is deliberately
// nothing else on the track: the shop doesn't quote recon work, so a marker
// showing "what this was supposed to cost" would be a number nobody gave.
const near = (a, b) => Math.abs(a - b) < 0.05;
ok(near(widths[0], 100), `largest bar is ${widths[0]}%, expected it to fill the track`);
ok(near(widths[1], (1000 / 1450) * 100), `second bar is ${widths[1]}%, expected ${(1000 / 1450) * 100}%`);
ok(!doc.querySelector(".bar-marker"), "a quote marker is back on the report chart");

/* ---------- sorting ---------- */
const costCol = col("cost");
ok(costCol >= 0, "the Cost column isn't sortable");
ok(cells(0)[costCol] === "$1,450.00", `default sort isn't cost-descending; first row cost is ${cells(0)[costCol]}`);
click(w, th("cost"));
ok(cells(0)[costCol] === "$0.00", `clicking the sorted column didn't flip it; first row cost is ${cells(0)[costCol]}`);

const stockCol = col("stock");
click(w, th("stock"));
// Text columns open ascending, and blanks sort last in both directions --
// the we-owe row has no stock number.
ok(cells(0)[stockCol] === "A118", `Stock # ascending starts at ${cells(0)[stockCol]}, expected A118`);
ok(cells(rows().length - 1)[stockCol] === "—", "the row with no stock number didn't sort last");
click(w, th("stock"));
ok(cells(0)[stockCol] === "C007", `Stock # descending starts at ${cells(0)[stockCol]}, expected C007`);
ok(cells(rows().length - 1)[stockCol] === "—", "the row with no stock number jumped to the top when the sort flipped");
ok(th("stock").getAttribute("aria-sort") === "descending", "the sorted header doesn't announce its direction");
ok(th("cost").getAttribute("aria-sort") === "none", "the previously sorted header still claims to be sorted");

// Sorting re-renders from what's already in memory.
const before = fetchLog.length;
click(w, th("cost"));
ok(fetchLog.length === before, "sorting refetched the report instead of reordering the rows it had");

// ...and the printable copy follows the sort, so paper matches screen.
const printFirst = doc.querySelector("#print-report tbody tr");
ok(printFirst && printFirst.textContent.includes("B204"),
   `print copy leads with "${printFirst && printFirst.textContent.trim().slice(0, 20)}" but the screen leads with ${cells(0)[stockCol]}`);

/* ---------- switching reports ---------- */
// Leave the board sorted by a column the technician report doesn't have, so
// the switch has something it has to reset rather than carry over.
click(w, th("stock"));
ok(w.state.reportSort.key === "stock", `expected the screen to be sorted by stock, got ${w.state.reportSort.key}`);

click(w, doc.querySelector('[data-report-type="technicians"]'));
await settle();

ok(fetchLog.at(-1).url.startsWith("/api/reports/technicians"), `switching report fetched ${fetchLog.at(-1).url}`);
ok(doc.querySelector('[data-report-type="technicians"]').classList.contains("active"), "the chosen report isn't lit");
// The segmented control is a radiogroup: state rides on aria-checked.
ok(doc.querySelector('[data-report-type="vehicle-spend"]').getAttribute("aria-checked") === "false",
   "the previous report still reports itself as selected");

const t = stats();
ok(t[0].value === "2" && t[0].sub === "of 3 on staff", `technicians working reads ${t[0].value} / "${t[0].sub}"`);
ok(t[1].value === "6" && t[1].sub === "3 completed · 50%", `repair orders card reads ${t[1].value} / "${t[1].sub}"`);
ok(t[2].value === "25", `labor hours reads ${t[2].value}, expected 25`);
// The fourth card used to be Labor Cost, which on recon and we-owe work is
// always $0.00. What is actually actionable is who is still holding a car.
ok(t[3].label === "Still Open" && t[3].value === "3" && t[3].sub === "worst sitting 9 days",
   `fourth card reads "${t[3].label}" ${t[3].value} / "${t[3].sub}"`);
ok(doc.querySelectorAll("#report-stats .stat")[3].querySelector(".stat-value").classList.contains("warn"),
   "9 days of silence should be flagged on the card, the same week boundary the board uses");
ok(!stats().some((s) => /cost|\$/i.test(s.label) || /\$/.test(s.value)),
   `the technician report is showing money: ${JSON.stringify(stats())}`);
ok(bars().length === 2, `expected 2 technician bars (Dana logged nothing), got ${bars().length}`);
ok(doc.querySelector("#report-output tbody tr.row-muted"), "the technician with no work isn't muted");

// "stock" doesn't exist on this shape; carrying it over would leave the
// table sorted by nothing at all, with no header claiming to be sorted.
// There is no money column here to fall back to, so the shape opens on hours.
ok(w.state.reportSort.key === "hours", `sort key after switching shape is ${w.state.reportSort.key}, expected hours`);
ok(doc.querySelector("#report-output th.sorted"), "no column is marked sorted after the shape changed");
ok(cells(0)[col("hours")] === "15", `opening sorted by hours put ${cells(0)[col("hours")]} first`);

// A tech holding nothing gets a dash, not "today" -- an empty hand is not
// the same as a car touched this morning.
ok(cells(0)[col("idle")] === "9 days", `Bo's sitting cell reads "${cells(0)[col("idle")]}"`);
const danaRow = [...doc.querySelectorAll("#report-output tbody tr")]
  .map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()))
  .find((r) => r[0] === "Dana");
ok(danaRow && danaRow[col("idle")] === "—", `the technician with nothing open reads "${danaRow && danaRow[col("idle")]}"`);

// Sitting is coloured on the same week boundary the board's Idle column uses.
const sittingCells = [...doc.querySelectorAll("#report-output tbody tr")].map((r) => r.querySelectorAll("td")[col("idle")]);
ok(sittingCells.filter((c) => c.classList.contains("money-bad")).length === 1,
   "only the technician past a week of silence should be flagged");

/* ---------- range ---------- */
click(w, doc.querySelector('[data-report-range="today"]'));
await settle();
const today = w.computeQuickRange("today");
ok(doc.querySelector("#report-start").value === today.start, "the From field doesn't show the range that's in effect");
ok(fetchLog.at(-1).url.includes(`start=${today.start}`), `range chip didn't reach the query: ${fetchLog.at(-1).url}`);
ok(doc.querySelector('[data-report-range="today"]').classList.contains("active"), "the active range chip isn't lit");

// A hand-edited date matches no chip, so none should stay lit claiming a
// range that isn't in effect.
doc.querySelector("#report-start").value = "2020-01-01";
doc.querySelector("#report-start").dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(!doc.querySelector("#view-reports .chip.active"), "a quick-range chip stayed lit after the dates were edited by hand");
ok(fetchLog.at(-1).url.includes("start=2020-01-01"), `hand-typed date didn't reach the query: ${fetchLog.at(-1).url}`);

/* ...but typing the exact dates a chip stands for should light it again.

   Which chip to test with has to be decided on the day: two chips can
   describe the identical range and then only the first one can ever light.
   On the 1st of a month "Today" and "This Month" are the same two dates; on
   the 1st of January so is "This Year", and "This Week" collides with
   "Today" every Sunday. That's a real tie, not a bug -- the range in effect
   is the same either way -- so this picks a chip that is unambiguous today
   rather than asserting one that only holds for part of the year. */
const RANGE_KINDS = ["today", "week", "month", "year", "all"];
const rangeKey = (k) => { const r = w.computeQuickRange(k); return `${r.start}..${r.end}`; };
const unambiguous = (k) => RANGE_KINDS.filter((o) => rangeKey(o) === rangeKey(k)).length === 1;
const rangeKind = ["month", "year", "week"].find(unambiguous);
ok(!!rangeKind, "no quick range is unambiguous today, so no chip could ever light");
const month = w.computeQuickRange(rangeKind);
doc.querySelector("#report-start").value = month.start;
doc.querySelector("#report-end").value = month.end;
doc.querySelector("#report-end").dispatchEvent(new w.Event("change", { bubbles: true }));
await settle();
ok(doc.querySelector(`[data-report-range="${rangeKind}"]`).classList.contains("active"),
   `typing the ${rangeKind} range by hand didn't light its chip`);

/* ---------- CSV link ---------- */
const href = doc.querySelector("#report-csv").getAttribute("href");
ok(href.startsWith("/api/export/report/technicians.csv"), `CSV link points at ${href} while showing the technician report`);
ok(href.includes(`start=${month.start}`), `CSV link doesn't carry the range in effect: ${href}`);
click(w, doc.querySelector('[data-report-type="vehicle-spend-recon"]'));
await settle();
const reconHref = doc.querySelector("#report-csv").getAttribute("href");
ok(reconHref.startsWith("/api/export/report/vehicle-spend.csv") && reconHref.includes("segment=recon"),
   `CSV link for the recon report is ${reconHref}`);

/* ---------- prefs survive a reload ---------- */
const saved = JSON.parse(w.localStorage.getItem(w.REPORT_PREFS_KEY));
ok(saved.type === "vehicle-spend-recon", `saved report type is ${saved.type}`);
ok(saved.range === rangeKind, `saved range is ${saved.range}, expected ${rangeKind}`);
w.state.reportType = "technicians";
w.state.reportRange = "all";
w.state.reportSort = { key: "cost", dir: "asc" };
w.loadReportPrefs();
ok(w.state.reportType === "vehicle-spend-recon" && w.state.reportRange === rangeKind,
   `prefs didn't round-trip: ${w.state.reportType} / ${w.state.reportRange}`);

// A hand-typed window is the one kind of range that does survive literally --
// it names days somebody asked for, and it means the same thing next week.
w.state.reportRange = "";
w.state.reportStart = "2026-03-02";
w.state.reportEnd = "2026-03-09";
w.saveReportPrefs();
w.state.reportStart = "";
w.state.reportEnd = "";
w.loadReportPrefs();
ok(w.state.reportStart === "2026-03-02" && w.state.reportEnd === "2026-03-09",
   `a hand-typed range came back as ${w.state.reportStart} – ${w.state.reportEnd}`);
ok(w.state.reportRange === "", "a hand-typed range came back claiming to be one of the chips");
// Put the screen back where the rest of the file expects it.
w.setReportRange("month");
w.syncReportControls();

/* ---------- rows, but nothing to chart ----------
   Early in a month every car on the list can legitimately be at $0: parts
   ordered, nothing received. A chart panel that just disappears reads like
   it broke, so it has to say which of the two it is. */
const costed = spend.map((v) => v.actual_cost);
spend.forEach((v) => { v.actual_cost = 0; });
click(w, doc.querySelector('[data-report-type="vehicle-spend"]'));
await settle();
ok(rows().length > 1, "the all-zero board lost its rows");
ok(bars().length === 0, "a $0 vehicle was plotted");
ok(doc.querySelector("#report-chart .chart-empty"), "the chart vanished silently instead of saying there was nothing to plot");
spend.forEach((v, i) => { v.actual_cost = costed[i]; });

/* ---------- cars already filed to History ----------
   This report covers both sides of History on purpose: the cars a past month
   was mostly about are the ones since sold. So a sold car's money is on the
   sheet -- but the row has to say it is off the lot, or it reads as a car
   still sitting there waiting on somebody. */
spend[3].archived_at = "2026-07-28T16:20:00";
click(w, doc.querySelector('[data-report-range="all"]'));
await settle();

const filedRow = rows().find((r) => r.textContent.includes("C007"));
ok(filedRow, "the filed car is missing from the report entirely");
ok(filedRow.classList.contains("row-filed"), "a car filed to History isn't marked apart from the cars still on the lot");
ok(filedRow.textContent.includes("History"), `the filed row carries no History tag: "${filedRow.textContent.trim()}"`);
ok(filedRow.querySelector(".pill-filed").getAttribute("title").includes("2026-07-28"),
   "the History tag doesn't say when the car was filed");
// Still clickable: this is the report somebody opens to find out what a car
// that has already gone ended up costing.
ok(filedRow.classList.contains("clickable"), "a filed car's row stopped opening the vehicle");

// ...and the count above the table has to say how much of it is finished
// business, or "4 vehicles" reads as the size of the lot today.
ok(stats()[0].sub === "3 recon · 1 we-owe · 1 in History",
   `the Vehicles card doesn't account for filed cars: "${stats()[0].sub}"`);

// A report with nothing filed says nothing about History rather than "0 in
// History" -- the ordinary case shouldn't grow a clause about an empty set.
delete spend[3].archived_at;
click(w, doc.querySelector('[data-report-range="month"]'));
await settle();
ok(stats()[0].sub === "3 recon · 1 we-owe", `the History clause stuck around with nothing filed: "${stats()[0].sub}"`);
ok(!doc.querySelector("#report-output tbody tr.row-filed"), "a row is still marked filed after the flag was cleared");

/* ---------- empty state ---------- */
const emptied = spend.splice(0, spend.length);
click(w, doc.querySelector('[data-report-type="vehicle-spend-recon"]'));
await settle();
ok(doc.querySelector("#report-output .empty-state"), "an empty report shows no empty state");
ok(doc.querySelector("#report-chart").innerHTML === "", "the chart panel is still drawn with no rows at all");
// The empty state's own "Show all time" button is a range chip like any
// other, which only works because the handler is delegated on the view.
click(w, doc.querySelector('#report-output [data-report-range="all"]'));
spend.push(...emptied);
await settle();
ok(w.state.reportRange === "all" && !doc.querySelector("#report-start").value,
   "the empty state's Show all time button didn't clear the range");

/* ---------- failure ---------- */
// A failed refetch has to say so in the view; a toast would leave the
// previous report's numbers sitting there looking current.
failNextReport = true;
click(w, doc.querySelector('[data-report-type="technicians"]'));
await settle();
ok(doc.querySelector("#report-output .empty-state.error"), "a failed report didn't paint the error boundary");
// The cards and chart aren't error-boundary targets, so they have to be
// cleared by hand -- a skeleton still shimmering above the error message
// reads as "any second now" rather than "this failed".
ok(doc.querySelector("#report-stats").innerHTML === "", "the summary cards' skeleton survived a failed report");
ok(doc.querySelector("#report-chart").innerHTML === "", "the chart's skeleton survived a failed report");
failNextReport = false;

// ...and recovering repaints all three.
click(w, doc.querySelector('[data-report-type="vehicle-spend"]'));
await settle();
// Three, same as the first vehicle-spend render asserted above -- this line
// used to expect four, which is the technicians shape's card count.
ok(doc.querySelectorAll("#report-stats .stat").length === 3, "the summary cards didn't come back after a failed report");
ok(bars().length === 3, "the chart didn't come back after a failed report");
ok(!doc.querySelector("#report-output .empty-state.error"), "the error message outlived the failure");

ok(rejections.length === 0, `unhandled rejections during the run: ${rejections.map((e) => e && e.message).join(" | ")}`);

finish("reports: summary cards, chart scaling, sorting, ranges, CSV link, prefs, empty + error states");
