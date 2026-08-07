/* The frame around the four screens: which one is showing, who is holding
   the phone, and how a failure gets said out loud.

   Same house rule as static/js/: this module only *declares*. Every
   addEventListener lives in a wire* function that main.js calls. */

import { $, $$, get, setActorSource } from "../../js/core.js";
import { esc } from "./format.js";

/* ---------- who ----------
   Deliberately the same localStorage key the desk uses ("dao-current-user"),
   so a phone opened on a workstation's browser already knows who you are, and
   so the name that lands in a ticket's history is the same string either way. */
export const state = {
  screen: "lot",
  carRef: null,   // {kind, id} while the car screen is up
  user: localStorage.getItem("dao-current-user") || "",
};

const TITLES = { lot: "The Lot", search: "Find a Car", tasks: "To Do", car: "Car" };

// Reloaders registered by each screen module, so shell can refresh whatever
// is on top without knowing anything about what it draws.
const loaders = {};
export function registerScreen(name, loader) {
  loaders[name] = loader;
}

export function toast(message, isError = false) {
  const el = $("#m-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", Boolean(isError));
  el.classList.add("is-on");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("is-on"), 3200);
}

/* A screen that failed to load says so where the content would have been,
   and offers the one thing that helps -- try again. A toast would scroll away
   and leave an empty screen that looks like an empty lot. */
export function renderFailure(target, err, retry) {
  target.innerHTML = `
    <div class="m-fail">
      <div class="m-fail-title">This didn't load.</div>
      <div class="m-fail-why">${esc(err && err.message ? err.message : "The shop PC didn't answer.")}</div>
      <button class="m-btn m-btn-ghost" type="button" data-retry="1">Try again</button>
    </div>`;
  const button = target.querySelector("[data-retry]");
  if (button && retry) button.addEventListener("click", retry);
}

export async function runLoader(name) {
  const loader = loaders[name];
  if (!loader) return;
  try {
    await loader();
  } catch (err) {
    // Each loader paints its own failure; this is the backstop for one that
    // throws before it gets that far.
    toast(err.message || "Something went wrong.", true);
  }
}

export function showScreen(name) {
  state.screen = name;
  document.body.dataset.screen = name;
  $$(".m-screen").forEach((el) => el.classList.toggle("is-on", el.id === `m-screen-${name}`));
  $$(".m-tab").forEach((el) => el.setAttribute("aria-selected", String(el.dataset.tab === name)));
  const title = $("#m-title");
  if (title) title.textContent = TITLES[name] || "RECON";
  // A new screen starts at the top. Without this, opening a car from halfway
  // down a long lot list drops you halfway down the car.
  const main = $("#m-main");
  if (main) main.scrollTop = 0;
}

export function goBack() {
  state.carRef = null;
  showScreen("lot");
  /* Reload rather than reveal what was there before. Coming back from a car
     you have just ticked a repair off on, the card behind it still says "1 of
     3 done" and still carries the old "still needs" sentence -- the one screen
     in the app most likely to be stale is the one you just changed. */
  runLoader("lot");
}

export function wireShell() {
  $("#m-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".m-tab");
    if (!tab) return;
    const name = tab.dataset.tab;
    showScreen(name);
    // Unconditionally, so tapping the tab you are already on is a refresh --
    // the gesture people already expect from every phone app they use.
    runLoader(name);
    if (name === "search") $("#m-search").focus();
  });

  $("#m-back").addEventListener("click", goBack);

  const who = $("#m-who");
  who.addEventListener("change", () => {
    state.user = who.value;
    localStorage.setItem("dao-current-user", state.user);
    // The To Do list is filtered by who you are, so it has to be redrawn.
    if (state.screen === "tasks") runLoader("tasks");
  });

  /* A phone spends most of its life in a pocket. Coming back to the app after
     twenty minutes and reading a stale lot is the failure mode here -- not the
     desktop's "someone else is editing this right now" -- so the phone
     refreshes on wake rather than polling a revision counter on a 12-second
     timer it would mostly sleep through. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.screen === "search") return;   // don't wipe typed results
    runLoader(state.screen);
  });
}

/* The name picker, filled from the staff list. Inactive staff are left out --
   the phone is for people who are here today. */
export async function loadUsers() {
  const who = $("#m-who");
  let staff = [];
  try {
    staff = await get("/api/staff");
  } catch {
    // Not fatal: without a name the server records its own placeholder, which
    // is a better record of "we don't know" than a made-up one.
    return;
  }
  const names = staff.filter((s) => s.active).map((s) => s.name);
  who.innerHTML = `<option value="">Who?</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (state.user && names.includes(state.user)) who.value = state.user;
  else if (state.user) {
    // Somebody who is no longer on the staff list, or a name typed on the
    // desk. Keep it rather than silently reassigning their work to nobody.
    who.insertAdjacentHTML("beforeend", `<option value="${esc(state.user)}">${esc(state.user)}</option>`);
    who.value = state.user;
  }
}

// Same contract as the desktop's state.js: core.js attaches the actor to
// every write, so no call site can forget to say who did it.
export function initActor() {
  setActorSource(() => state.user);
}
