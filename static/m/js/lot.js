/* The lot, as cards you can read standing next to the car.
 *
 * Four piles in the order a car moves through them, same names and same
 * blank lines as the desktop board. Every number here is the server's:
 * `lot_bucket` decides the pile, `needs` is the sentence, `age_days` and
 * `idle_days` are the two clocks. The phone formats them and nothing else --
 * a second implementation of "what does this car still need" is a second
 * answer to Walt's question, and one of them would be wrong.
 */

import { $, get } from "../../js/core.js";
import { LOT_PILES, ageClass, esc, idleClass, idleText, money, pileKey, statusLabel, statusPillClass, vinTail } from "./format.js";
import { openCar } from "./car.js";
import { renderFailure } from "./shell.js";

function carSubHtml(v) {
  const bits = [];
  if (v.color) bits.push(esc(v.color));
  if (v.plate) bits.push(esc(v.plate));
  if (v.segment === "we_owe") {
    if (v.customer_name) bits.push(esc(v.customer_name));
  } else if (v.vin) {
    bits.push(`<span class="num" title="${esc(v.vin)}">…${esc(vinTail(v.vin))}</span>`);
  }
  return bits.join(" · ");
}

export function carCardHtml(v) {
  const finished = v.status_bucket === "finished";
  const age = v.age_days == null
    ? ""
    : `<span class="${ageClass(v.age_days)}">${v.age_days}d old</span>`;
  const stock = v.segment === "we_owe" ? "We-Owe" : (v.stock_number || "—");
  const ro = v.ro_number ? `<span class="m-car-stock num">RO ${esc(String(v.ro_number))}</span>` : "";
  const weowe = v.segment === "we_owe" ? `<span class="m-pill m-pill-weowe">We-Owe</span>` : "";

  return `
    <button class="m-car" type="button" data-segment="${esc(v.segment)}"
            data-kind="${v.segment === "we_owe" ? "we_owe" : "recon"}"
            data-id="${esc(String(v.segment === "we_owe" ? v.we_owe_id : v.recon_id))}">
      <div class="m-car-top">
        <span class="m-pill ${statusPillClass(v)}">${esc(statusLabel(v.status))}</span>
        ${weowe}
        <span class="m-car-stock num">${esc(stock)}</span>
        ${ro}
      </div>
      <div class="m-car-name">${esc(v.vehicle || "Vehicle")}</div>
      <div class="m-car-sub">${carSubHtml(v)}</div>
      ${v.needs ? `<div class="m-car-needs">${esc(v.needs)}</div>` : ""}
      <div class="m-car-foot">
        <span class="${idleClass(v.idle_days, finished)}">${esc(idleText(v.idle_days))}</span>
        ${age}
        <span class="m-car-spend num">${money(v.actual_cost)}</span>
      </div>
    </button>`;
}

export function lotHtml(rows) {
  if (!rows.length) {
    return `<p class="m-empty">Nothing on the lot right now.<br>Cars written up on the shop PC show up here.</p>`;
  }
  return LOT_PILES.map((pile) => {
    const cars = rows.filter((v) => pileKey(v) === pile.key);
    // An empty pile still prints, with its own blank line. A pile that
    // vanished when it emptied would make the lot look shorter than it is
    // and hide the fact that nothing is ready.
    const body = cars.length
      ? cars.map(carCardHtml).join("")
      : `<p class="m-pile-blank">${esc(pile.blank)}</p>`;
    return `
      <section class="m-pile" data-pile="${pile.key}">
        <div class="m-pile-head">
          <h2>${esc(pile.label)}</h2>
          <span class="m-pile-count">${cars.length}</span>
        </div>
        ${body}
      </section>`;
  }).join("");
}

export async function loadLot() {
  const target = $("#m-lot");
  target.innerHTML = `<p class="m-loading">Loading the lot…</p>`;
  try {
    // `view=active` is what the desktop Vehicles board sends: the cars that
    // are still the shop's problem, both recon and we-owe, no History, no
    // voided tickets.
    const rows = await get("/api/vehicles-board?view=active");
    target.innerHTML = lotHtml(rows);
  } catch (err) {
    renderFailure(target, err, loadLot);
  }
}

export function wireLot() {
  // One listener on the container rather than one per card: the list is
  // redrawn on every refresh and on every wake from a pocket.
  $("#m-lot").addEventListener("click", (e) => {
    const card = e.target.closest(".m-car");
    if (!card) return;
    openCar(card.dataset.kind, Number(card.dataset.id));
  });
}
