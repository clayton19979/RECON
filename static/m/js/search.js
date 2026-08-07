/* Find a car you are standing next to.
 *
 * The reason this app exists in the shape it does: you are in the lot with a
 * key in your hand and no idea which of Walt's cars this is. Eight keystrokes
 * off the plate or the dash VIN should tell you. The server already scores
 * across recon, we-owe and retail (app/agent_routes.py::search), so this
 * screen is a text box and a list. */

import { $, get } from "../../js/core.js";
import { esc, statusLabel } from "./format.js";
import { openCar } from "./car.js";

const HINT = `<p class="m-search-hint">Type a stock number, a plate, the last few digits of a VIN, or a customer's name.</p>`;

// Typed on a phone, one thumb, standing up. Long enough that a single
// keystroke doesn't fire a request, short enough not to feel laggy.
const DEBOUNCE_MS = 250;
let timer = null;
// Requests can come back out of order on a slow network -- a stale answer
// overwriting a fresh one is how a search box shows the wrong car. Only the
// most recent query is allowed to paint.
let latest = 0;

export function resultsHtml(rows) {
  if (!rows.length) {
    return `<p class="m-empty">Nothing matched that.<br>Try the stock number, or the last few digits of the VIN.</p>`;
  }
  return rows.map((r) => {
    const bits = [r.color, r.plate, r.customer_name].filter(Boolean).map(esc).join(" · ");
    const kindPill = r.kind === "we_owe"
      ? `<span class="m-pill m-pill-weowe">We-Owe</span>`
      : r.kind === "retail" ? `<span class="m-pill m-pill-estimate">Retail</span>` : "";
    // No stock-number chip here: the server's `label` already opens with it
    // ("R-1002 — 2017 Hyundai Elantra"), and printing it twice on a 375px
    // card reads as two different facts.
    return `
      <button class="m-car" type="button" data-segment="${esc(r.kind)}"
              data-kind="${esc(r.kind)}" data-id="${esc(String(r.id))}">
        <div class="m-car-top">
          <span class="m-pill m-pill-progress">${esc(statusLabel(r.status))}</span>
          ${kindPill}
        </div>
        <div class="m-car-name">${esc(r.label || "Vehicle")}</div>
        ${bits ? `<div class="m-car-sub">${bits}</div>` : ""}
      </button>`;
  }).join("");
}

async function runSearch(query) {
  const target = $("#m-search-results");
  const q = query.trim();
  if (!q) {
    target.innerHTML = HINT;
    return;
  }
  const ticket = ++latest;
  try {
    const rows = await get(`/api/agent/search?q=${encodeURIComponent(q)}`);
    if (ticket !== latest) return;
    target.innerHTML = resultsHtml(rows);
  } catch (err) {
    if (ticket !== latest) return;
    target.innerHTML = `<p class="m-empty">${esc(err.message || "The shop PC didn't answer.")}</p>`;
  }
}

export function wireSearch() {
  const box = $("#m-search");
  box.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(box.value), DEBOUNCE_MS);
  });
  // Enter on the phone keyboard searches now and drops the keyboard, which is
  // what the enterkeyhint="search" on the input promises.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    box.blur();
    runSearch(box.value);
  });

  $("#m-search-results").addEventListener("click", (e) => {
    const card = e.target.closest(".m-car");
    if (!card) return;
    openCar(card.dataset.kind, Number(card.dataset.id));
  });
}
