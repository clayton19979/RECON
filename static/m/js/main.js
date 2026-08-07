/* The phone app's one entry point.
 *
 * Same house rule as static/js/main.js: every module above only *declares*,
 * and every addEventListener in the app is registered from here, in one
 * readable list. If a screen is dead, it's because its wire* call is missing
 * from this file and nowhere else. */

import { loadCar, wireCar } from "./car.js";
import { loadLot, wireLot } from "./lot.js";
import { wireSearch } from "./search.js";
import { initActor, loadUsers, registerScreen, wireShell } from "./shell.js";
import { loadTasks, wireTasks } from "./tasks.js";

/* The theme Clayton picked at the desk, applied before anything paints.

   Same localStorage key the desktop writes ("dao-theme"), so the phone is
   whatever colour the shop PC is. Read straight rather than imported:
   error-boundary.js owns this on the desktop and pulls in half the app. */
function applyTheme() {
  const saved = localStorage.getItem("dao-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
}

/* Network-only, and registered only because Android wants a fetch handler
   before it will offer to install the app. See static/m/sw.js -- caching
   RECON's code would put a phone on last week's version against this week's
   database, and the shop PC's whole update story assumes one version. */
function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }).catch(() => {
    // An install prompt is a nicety. The app works without one.
  });
}

function start() {
  applyTheme();
  initActor();

  registerScreen("lot", loadLot);
  registerScreen("search", async () => {});   // driven by typing, not by tabbing
  registerScreen("tasks", loadTasks);
  registerScreen("car", loadCar);

  wireShell();
  wireLot();
  wireSearch();
  wireTasks();
  wireCar();

  loadUsers();
  loadLot();
  registerWorker();
}

start();
