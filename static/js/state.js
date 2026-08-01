import { $, get } from "./core.js";
import { esc } from "./shortcuts.js";

/* ---------- state ---------- */
export const state = {
  // Which screen owns the shared print surface -- the vehicle-detail
  // ticket printer and the reports printer share one iframe.
  printSurfaceOwner: "report",
  vehicles: [],
  filter: "",
  search: "",
  // The board's whole view state -- which segment, which status, which column
  // it's sorted by -- is restored from localStorage on load (see
  // loadVehicleViewPrefs) so the advisor's working view survives a refresh,
  // an app restart, and a trip through a repair order and back.
  vehicleSort: { key: "", dir: "desc" }, // key "" == the server's own order (newest first)
  vehicleStatus: "",                      // "" == any status
  vehiclePartsOnly: false,                // "Waiting on parts" toggle
  vehicleOverOnly: false,                 // "Over Quote" card toggle
  vehicleIdleBucket: "",                  // "" == any; else an IDLE_SELECTIONS key (a chart bar, or "stalled" from the card)
  vehicleChartOpen: true,                 // the idle-bucket chart above the table
  vehicleCursor: null,                    // key of the keyboard-focused row
  vehicleAnchor: null,                    // key of the last row clicked, for Shift+click ranges
  // The half of the board that isn't loaded -- History while you're on the
  // live list, the live list while you're in History. Only ever read to
  // answer "the car you searched for is over there"; null until a search
  // asks for it, and the scope records which half it holds so a stale copy
  // can't be mistaken for the other one. See loadSearchElsewhere.
  searchElsewhere: null,
  searchElsewhereScope: "",               // "" | "history" | "live"
  staff: [],            // active staff only -- what every assignment picker reads
  allStaff: [],         // includes inactive; only the Staff page reads this
  staffTasks: [],       // open-task counts for the Staff page's workload column
  vendors: [],
  orders: [],
  currentUser: localStorage.getItem("dao-current-user") || "",
  detail: { segment: null, id: null, item: null, order: null },
  // The A/P invoice list's window: apRange is the lit chip's name ("" once the
  // dates are edited by hand), apFilter the dates it currently stands for. The
  // name is what's authoritative -- see refreshApRange. "all" matches the chip
  // index.html ships already lit, which is the empty range.
  apRange: "all",
  apFilter: { start: "", end: "" },
  apSearch: "",
  apAudits: [],
  staffSearch: "",
  staffFilter: "active",
  suggestionSearch: "",
  showResolvedSuggestions: false,
  apInvoices: [],
  partsOnOrder: [],
  onOrderFilter: "",            // "" == everything on order; "overdue" == waiting a week or more
  onOrderSearch: "",
  cores: [],
  coresFilter: "pending",
  coresSearch: "",
  coresSelected: new Set(),
  returns: [],
  returnsFilter: "pending",
  returnsSearch: "",
  returnsSelected: new Set(),
  postReturnItem: null,
  vehicleSelection: new Set(), // "segment:id" strings, cleared on filter change/reload
  // Customers screen: the list, its search/filter, which row is expanded,
  // and a per-open cache of /api/customers/{id} details so re-expanding the
  // same person doesn't refetch. The cache dies with the view load, so a
  // fresh visit always shows fresh orders.
  customers: [],
  customersSearch: "",
  customerFilter: "",           // "" | "open" (has open ROs) | "no_contact"
  customerCursor: null,         // customer id under the keyboard cursor
  customerOpenId: null,         // customer id whose row is expanded
  customerDetails: {},          // id -> /api/customers/{id} payload
  // Reports: which of the four reports, over what window, sorted how. Like
  // the board, all of it is restored from localStorage before the first
  // fetch (loadReportPrefs) so the screen opens on the report you were
  // last reading rather than on a blank form.
  reportType: "vehicle-spend",
  reportRange: "month",                 // the quick-range chip, "" once dates are edited by hand
  reportStart: "",
  reportEnd: "",
  reportSort: { key: "cost", dir: "desc" },
  // Which report shape reportSort was actually chosen for. Null means "nobody
  // has picked one yet", so the shape's own default wins -- see
  // generateReport. Without it, Cost and Stock # exist on more than one shape
  // and a sort silently followed you from one report to another.
  reportSortShape: null,
  report: null,                         // { rows, type, start, end } -- what's on screen, for print/CSV
  tasks: [],
  taskFilter: "",
  taskSearch: "",
  // The three filtering stat cards are mutually exclusive (a task can't be
  // both overdue and due today), so one slot holds whichever is lit.
  taskCard: "",                 // "" | "overdue" | "today" | "unassigned"
  taskAssignee: "",             // "" == anyone; else a staff name
  taskUrgentOnly: false,
  taskSelection: new Set(),     // task ids, cleared whenever the visible set changes
  taskAnchor: null,             // last row clicked, for shift+click ranges
  taskCursor: null,             // task id under the keyboard cursor, open list only
  newTaskAssignees: [],
  taskOrders: [],               // linkable orders, for the per-row vehicle picker
  showCompletedTasks: false,
  showAllCompleted: false,
  suggestions: [],
};

// Who's actually using the app right now -- every save used to hardcode
// "Clay" as the actor, misattributing everything when anyone else touched
// it. Populated from the staff list, remembered in localStorage.
export async function refreshCurrentUserOptions() {
  const select = $("#current-user");
  try {
    const staff = await get("/api/staff");
    select.innerHTML = `<option value="">Unspecified</option>` + staff.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("");
    select.value = state.currentUser;
  } catch {}
}
export function initCurrentUser() {
  refreshCurrentUserOptions();
  $("#current-user").addEventListener("change", () => {
    state.currentUser = $("#current-user").value;
    localStorage.setItem("dao-current-user", state.currentUser);
  });
}

export const STATUS_OPTIONS = ["estimate", "pending_approval", "in_progress", "complete"];
export const STATUS_LABEL = {
  estimate: "Estimate", pending_approval: "Pending Approval", in_progress: "In Progress", complete: "Complete",
  // Vehicle-board labels for statuses that aren't ticket statuses: recon's
  // "acquired" (no RO started yet) and we-owe's own open/fulfilled/waived
  // (shown only once the promise itself has been marked resolved, or before
  // any ticket exists -- otherwise the board shows the ticket's own status).
  acquired: "Acquired", open: "Open", fulfilled: "Fulfilled", waived: "Waived",
};
export const STATUS_PILL_CLASS = {
  estimate: "pill-status-estimate", pending_approval: "pill-status-pending",
  in_progress: "pill-status-progress", complete: "pill-status-complete",
};
// The three groups a person builds a ticket out of, in the order they read.
// "credit" is deliberately not one of them -- nobody adds a credit by hand, it
// arrives on a vendor invoice -- but it is a kind that turns up on real
// tickets, so it needs a heading wherever lines are grouped by kind.
export const KIND_GROUP_ORDER = ["part", "labor", "fee"];
export const KIND_GROUP_LABEL = { part: "Parts", labor: "Labor", fee: "Fees", credit: "Credits" };

/* The same three database columns mean different things per line kind, and an
   RO is read by people who know what a labor line looks like. estimate_items
   stores quantity + unit_cost for everything, but on labor those ARE hours and
   an hourly rate, and on a fee the "cost" is just the amount. Showing "Qty"
   and "Cost" over a labor line -- next to a Part # box that has no business
   being there at all -- is how you get a ticket nobody trusts.

   An empty label means the column doesn't apply to that kind and renders as a
   blank spacer rather than a captioned empty box. */
const KIND_FIELD_LABELS = {
  part:  { part: "Part #", qty: "Qty",   cost: "Cost",   core: "Core" },
  labor: { part: "",       qty: "Hours", cost: "Rate",   core: "" },
  fee:   { part: "",       qty: "Qty",   cost: "Amount", core: "" },
};
export const fieldLabels = (kind) => KIND_FIELD_LABELS[kind] || KIND_FIELD_LABELS.part;
// Print-surface label maps. Value domains match the backend enums:
// estimate-item status (quoted/ordered/received), estimate-authorization
// method (workflow.py AuthorizationIn), we-owe payment method (recon.py
// PaymentIn) -- raw enum strings on paper read as a rendering fault.
export const ITEM_STATUS_LABEL = { quoted: "Quoted", ordered: "Ordered", received: "Received" };
export const AUTH_METHOD_LABEL = { in_person: "in person", phone: "by phone", sms: "by text", email: "by email", other: "" };
export const PAY_METHOD_LABEL = { cash: "Cash", card: "Card", check: "Check", bank: "Bank", other: "Other" };
