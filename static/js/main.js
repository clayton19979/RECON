// RECON front-end entry point.
//
// One module per screen or shared concern, split out of the old 9,000-line
// app.js. Module bodies only declare things -- every listener registration
// or boot step happens in the wire calls below, in the same order the old
// flat file ran them. The DOM smoke harness and test_static_assets.py both
// rebuild the flat script by concatenating these files in import order, so
// keep imports one per line and side effects out of module bodies.

import "./core.js";
import "./updates-banner.js";
import "./clipboard.js";
import { wireDownloadIntercept } from "./downloads.js";
import "./notify.js";
import "./confirm.js";
import "./shortcuts.js";
import "./empty-states.js";
import "./skeletons.js";
import "./state.js";
import "./nav.js";
import "./error-boundary.js";
import "./estimate-money.js";
import "./vehicles-board.js";
import "./list-keyboard.js";
import "./vehicle-detail.js";
import "./move-ticket.js";
import "./dialog-new-recon.js";
import "./dialog-new-weowe.js";
import "./dialog-receive-parts.js";
import "./reports.js";
import "./accounting.js";
import "./cores.js";
import "./customers.js";
import "./staff.js";
import { wireAssigneeMenuDismiss } from "./multi-picker.js";
import "./tasks.js";
import "./task-bulk.js";
import "./ideas.js";
import "./updates-page.js";
import "./pulse.js";
import { startApp } from "./init.js";
import { wireDrawer } from "./drawer.js";

wireDownloadIntercept();
wireAssigneeMenuDismiss();
startApp();
wireDrawer();
