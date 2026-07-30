import { loadVehiclesView } from "./vehicles-board.js";
import { loadReportsView } from "./reports.js";
import { loadAccountingView } from "./accounting.js";
import { loadCoresView } from "./cores.js";
import { loadCustomersView } from "./customers.js";
import { loadStaffView } from "./staff.js";
import { loadTasksView } from "./task-bulk.js";
import { loadSuggestionsView } from "./ideas.js";
import { loadBackupView } from "./drawer.js";

/* ---------- nav / shell ---------- */
// One place that knows how each view loads itself, so switching views can put
// a boundary around it (below) instead of a chain of `if (name === ...)`.
export const VIEW_LOADERS = {
  vehicles: () => loadVehiclesView(),
  customers: () => loadCustomersView(),
  reports: () => loadReportsView(),
  accounting: () => loadAccountingView(),
  cores: () => loadCoresView(),
  staff: () => loadStaffView(),
  tasks: () => loadTasksView(),
  suggestions: () => loadSuggestionsView(),
  backup: () => loadBackupView(),
};
