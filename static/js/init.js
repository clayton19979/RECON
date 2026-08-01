import { $, $$ } from "./core.js";
import { wireUpdateBar } from "./updates-banner.js";
import { toast, wireMessageLog } from "./notify.js";
import { wireConfirmDialog } from "./confirm.js";
import { wireInvoicePromptDialog, wireShortcutsDialog } from "./shortcuts.js";
import { initCurrentUser, state } from "./state.js";
import { initTheme, showView, wireGlobalErrorReporting, wireViewRetry } from "./error-boundary.js";
import { loadVehicleViewPrefs } from "./vehicles-board.js";
import { wireVehiclesView } from "./list-keyboard.js";
import { wireEstimateGrid, wireJobDialog, wireMoveItemDialog, wireVehicleDetail } from "./vehicle-detail.js";
import { wireMoveSegmentDialog } from "./move-ticket.js";
import { wireReconDialog } from "./dialog-new-recon.js";
import { wireWeOweDialog } from "./dialog-new-weowe.js";
import { wireReceiveDialog } from "./dialog-receive-parts.js";
import { loadReportPrefs, setReportRange, wireReportsView } from "./reports.js";
import { wireAccountingView } from "./accounting.js";
import { wireCoresView, wirePartsOnOrderView, wirePostReturnDialog, wireReturnsView } from "./cores.js";
import { wireAddVehicleDialog, wireCustomerEditor, wireCustomersView, wireRetailRoDialog } from "./customers.js";
import { wireStaffView } from "./staff.js";
import { wireTasksView } from "./task-bulk.js";
import { wireSuggestionsView } from "./ideas.js";
import { wireBackupView } from "./drawer.js";

/* ==================================================================
   INIT
   ================================================================== */
export function startApp() {
  document.addEventListener("DOMContentLoaded", () => {
    wireGlobalErrorReporting();
    wireMessageLog();
    initTheme();
    initCurrentUser();
    wireConfirmDialog();
    // Before wireVehiclesView: both watch document-level keydown, and the "?"
    // handler has to see (and swallow) the keystroke before the board's
    // type-to-search does.
    wireShortcutsDialog();
    wireInvoicePromptDialog();
    wireViewRetry();
    wireVehiclesView();
    wireCustomersView();
    wireRetailRoDialog();
    wireAddVehicleDialog();
    // Before wireVehicleDetail: the detail page's "Edit Customer" opens the
    // shared dialog this wires.
    wireCustomerEditor();
    wireVehicleDetail();
    wireEstimateGrid();
    wireReconDialog();
    wireWeOweDialog();
    wireMoveSegmentDialog();
    wireUpdateBar();
    wireReceiveDialog();
    wireJobDialog();
    wireMoveItemDialog();
    wireReportsView();
    wireAccountingView();
    wirePartsOnOrderView();
    wireCoresView();
    wireReturnsView();
    wirePostReturnDialog();
    wireStaffView();
    wireTasksView();
    wireSuggestionsView();
    wireBackupView();

    $$(".rail-item").forEach((btn) => btn.addEventListener("click", () => showView(btn.dataset.view)));

    // Before the first load, so the board fetches the right side of the
    // archived/live split rather than loading the live board and then
    // discovering the saved filter was History.
    loadVehicleViewPrefs();
    // Same reasoning for Reports: the saved range has to be in state before
    // loadReportsView() builds its query string, or the first render is of
    // the default month and the saved one only appears on the second.
    loadReportPrefs();
    if (!state.reportStart && !state.reportEnd && state.reportRange) setReportRange(state.reportRange);

    // Replay a one-shot flash stashed before a deliberate reload (a database
    // restore) -- the toast fired before location.reload() died with the page,
    // leaving the most consequential action in the app with no confirmation.
    let flash = null;
    try {
      flash = JSON.parse(sessionStorage.getItem("dao-flash") || "null");
      sessionStorage.removeItem("dao-flash");
    } catch {}
    const startView = flash?.view && $(`.rail-item[data-view="${flash.view}"]`) ? flash.view : "vehicles";
    showView(startView);
    if (flash?.message) toast(flash.message);
  });
}
