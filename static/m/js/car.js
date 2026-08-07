/* One car: what it still needs, what it has cost, and the one thing worth
   letting a phone change -- ticking a repair off from under the hood.

   Costs are deliberately read-only here. The estimate grid is money entry
   with optimistic locking and 300-row payloads; fat-fingering a unit cost on
   a phone in a bay is how the ledger stops being trustworthy. Read the
   numbers on the phone, type them at the desk. */

import { $, get, patch, post } from "../../js/core.js";
import { unreceivedPartLines, unreceivedQuantity, writtenUnitCost } from "../../js/estimate-money.js";
import { ageClass, esc, fmtDay, money, relativeTime, statusLabel, vinTail } from "./format.js";
import { renderFailure, showScreen, state, toast } from "./shell.js";

// What is on screen right now, so a job tick can redraw without refetching
// the whole car and so a wake-from-pocket knows what to reload.
let current = null;   // {kind, id, item, order}

/* The newest ticket that hasn't been voided.

   A recon car collects tickets over its life; the phone shows the one that is
   live, which is what "what does this car need" means to somebody standing
   next to it. Voided ones are skipped rather than shown greyed out -- a
   voided ticket's repairs are not work anybody is going to do. */
function liveOrder(orders) {
  const live = (orders || []).filter((o) => !o.voided);
  return live.length ? live[live.length - 1] : null;
}

function detailPath(kind, id) {
  if (kind === "we_owe") return `/api/we-owe/${id}`;
  if (kind === "retail") return `/api/retail/vehicles/${id}`;
  return `/api/recon/vehicles/${id}`;
}

function carName(item) {
  const parts = [item.year, item.make, item.model].filter(Boolean).join(" ");
  return parts || "Vehicle";
}

function subLine(kind, item) {
  const bits = [];
  if (kind === "recon" && item.stock_number) bits.push(esc(item.stock_number));
  if (item.color) bits.push(esc(item.color));
  if (item.plate) bits.push(esc(`${item.plate}${item.plate_state ? ` ${item.plate_state}` : ""}`));
  if (item.mileage) bits.push(`${Number(item.mileage).toLocaleString()} mi`);
  if (kind !== "recon" && item.customer_name) bits.push(esc(item.customer_name));
  return bits.join(" · ");
}

function jobsHtml(order) {
  if (!order) {
    return `<p class="m-empty">No ticket written yet.<br>Open one on the shop PC and the repairs show up here.</p>`;
  }
  const jobs = (order.estimate && order.estimate.jobs) || [];
  if (!jobs.length) {
    return `<p class="m-pile-blank">No repairs written on this ticket yet.</p>`;
  }
  return jobs.map((j) => {
    const done = Boolean(j.completed_at);
    const who = done && j.completed_by ? ` · ${esc(j.completed_by)}` : "";
    const when = done && j.completed_at ? esc(relativeTime(j.completed_at)) : "";
    const meta = done ? `<div class="m-task-meta">Done ${when}${who}</div>` : "";
    const tech = !done && j.technician_name ? `<div class="m-task-meta">${esc(j.technician_name)}</div>` : "";
    return `
      <button class="m-job" type="button" data-job="${j.id}" data-done="${done ? 1 : 0}"
              aria-pressed="${done}">
        <span class="m-job-box" aria-hidden="true">${done ? "&#10003;" : ""}</span>
        <span class="m-job-title">${esc(j.title)}${meta}${tech}</span>
      </button>`;
  }).join("");
}

/* Parts, read-only: the answer to "is the part here yet", which is the other
   question asked standing at a car. A part that has landed is not listed --
   it's on the car, or in the bin, and it isn't news.
 *
 * Which lines count and what they are worth both come from
 * estimate-money.js, the one definition the board, the ticket card, the
 * reports and the CSV are all built on. Filtering by hand here looked
 * simpler and got two things wrong: a part sent back to the vendor is not
 * money the shop is going to spend, and a line half-received still has the
 * other half outstanding. `unit_price` is not the field either -- recon work
 * carries no markup, so unit_cost is the only price this app has and
 * unit_price is a shared-schema leftover that is always 0. */
function partsHtml(order) {
  const lines = unreceivedPartLines((order && order.estimate && order.estimate.items) || []);
  if (!lines.length) return "";
  const rows = lines.map((i) => {
    const label = i.status === "ordered" ? "On order" : "Not ordered yet";
    const qty = unreceivedQuantity(i);
    const owed = qty * (Number(writtenUnitCost(i)) || 0);
    // The count sits with the status, not the description: "On order ×2"
    // reads as "two of them still coming", which is the question. Hung off
    // the description it just collides with whatever the writer already
    // typed there.
    const count = qty > 1 ? ` ×${qty % 1 === 0 ? qty : qty.toFixed(2)}` : "";
    return `
      <div class="m-line">
        <span class="m-line-label">${esc(i.description || i.part_number || "Part")}</span>
        <span class="m-line-value">${esc(label)}${count}<br><span class="num">${money(owed)}</span></span>
      </div>`;
  }).join("");
  return `<section class="m-sec"><div class="m-sec-title">Parts not here yet</div>${rows}</section>`;
}

function notesHtml(order) {
  if (!order) return "";
  const notes = order.notes || [];
  const list = notes.length
    ? notes.map((n) => `
        <div class="m-note">
          <div class="m-note-meta">${esc(relativeTime(n.created_at))}${n.actor ? ` · ${esc(n.actor)}` : ""}</div>
          <div class="m-note-text">${esc(n.text)}</div>
        </div>`).join("")
    : `<p class="m-pile-blank">Nothing written down yet.</p>`;
  return `
    <section class="m-sec">
      <div class="m-sec-title">Notes</div>
      ${list}
      <form class="m-note-form" id="m-note-form">
        <textarea class="m-note-input" id="m-note-text" placeholder="Something worth writing down…"
                  aria-label="Add a note"></textarea>
        <button class="m-btn" type="submit">Add note</button>
      </form>
    </section>`;
}

function factsHtml(kind, item) {
  const rows = [];
  if (item.vin) rows.push(["VIN", `<span class="num" title="${esc(item.vin)}">…${esc(vinTail(item.vin))}</span>`]);
  if (kind === "recon" && item.acquisition_date) rows.push(["On the lot since", esc(fmtDay(item.acquisition_date))]);
  if (kind === "we_owe" && item.target_date) rows.push(["Promised by", esc(fmtDay(item.target_date))]);
  if (item.engine) rows.push(["Engine", esc(item.engine)]);
  if (item.notes) rows.push(["Notes", esc(item.notes)]);
  if (!rows.length) return "";
  const body = rows.map(([k, v]) => `<div class="m-line"><span class="m-line-label">${k}</span><span class="m-line-value">${v}</span></div>`).join("");
  return `<section class="m-sec"><div class="m-sec-title">The car</div>${body}</section>`;
}

export function carHtml(kind, item, order) {
  const spent = money(item.total_cost);
  // "Written up" only appears when it actually differs from what was spent.
  // Printing both when they agree is two numbers where there is one fact.
  const quoted = Math.abs(Number(item.quoted_cost || 0) - Number(item.total_cost || 0)) >= 0.005
    ? `<span class="m-detail-spend-label">written up ${money(item.quoted_cost)}</span>`
    : "";
  const statusPill = order
    ? `<span class="m-pill m-pill-progress">${esc(statusLabel(order.status))}</span>`
    : "";
  // Don't offer the gesture when there is nothing to perform it on. A car with
  // no ticket -- or a we-owe nobody has written up yet -- was headed "tap to
  // tick one off" above a line explaining that there is nothing here.
  const tickable = Boolean(order && order.estimate && (order.estimate.jobs || []).length);

  return `
    <div class="m-detail-head">
      <div class="m-car-top">
        ${statusPill}
        ${kind === "we_owe" ? `<span class="m-pill m-pill-weowe">We-Owe</span>` : ""}
        ${order && order.ro_number ? `<span class="m-car-stock num">RO ${esc(String(order.ro_number))}</span>` : ""}
      </div>
      <h2 class="m-detail-name">${esc(carName(item))}</h2>
      <div class="m-detail-sub">${subLine(kind, item)}</div>
      <div class="m-detail-spend">
        <span class="m-detail-spend-value num">${spent}</span>
        <span class="m-detail-spend-label">spent on this car</span>
        ${quoted}
      </div>
    </div>
    <section class="m-sec">
      <div class="m-sec-title">${tickable ? "Repairs — tap to tick one off" : "Repairs"}</div>
      ${jobsHtml(order)}
    </section>
    ${partsHtml(order)}
    ${notesHtml(order)}
    ${factsHtml(kind, item)}`;
}

export async function openCar(kind, id) {
  state.carRef = { kind, id };
  showScreen("car");
  const target = $("#m-car");
  target.innerHTML = `<p class="m-loading">Loading…</p>`;
  await loadCar();
}

export async function loadCar() {
  if (!state.carRef) return;
  const { kind, id } = state.carRef;
  const target = $("#m-car");
  // Two round trips, and a thumb can start a third before either lands. If a
  // slower answer for the previous car arrived last it would paint that car's
  // repairs and that car's costs under this car's heading -- the app showing a
  // number it can't stand behind. Only the car still being asked for may draw.
  const stale = () => !state.carRef || state.carRef.kind !== kind || state.carRef.id !== id;
  try {
    const item = await get(detailPath(kind, id));
    if (stale()) return;
    const summary = liveOrder(item.orders);
    // The rollup in the vehicle detail carries totals but not the repairs or
    // the notes, so the ticket itself is fetched second.
    const order = summary ? await get(`/api/orders/${summary.id}`) : null;
    if (stale()) return;
    current = { kind, id, item, order };
    target.innerHTML = carHtml(kind, item, order);
  } catch (err) {
    if (stale()) return;
    renderFailure(target, err, loadCar);
  }
}

export function wireCar() {
  const target = $("#m-car");

  target.addEventListener("click", async (e) => {
    const button = e.target.closest(".m-job");
    if (!button || !current || !current.order) return;
    if (button.getAttribute("aria-busy") === "true") return;
    const jobId = Number(button.dataset.job);
    const done = button.dataset.done !== "1";
    // Busy rather than optimistic: the tick is the record that the work
    // happened, and showing it ticked before the shop PC agrees is exactly
    // the lie this app is not allowed to tell.
    button.setAttribute("aria-busy", "true");
    try {
      await patch(`/api/orders/${current.order.id}/jobs/${jobId}/done`, { done });
      await loadCar();
      toast(done ? "Ticked off." : "Put back on the list.");
    } catch (err) {
      button.setAttribute("aria-busy", "false");
      toast(err.message || "Couldn't save that.", true);
    }
  });

  target.addEventListener("submit", async (e) => {
    const form = e.target.closest("#m-note-form");
    if (!form || !current || !current.order) return;
    e.preventDefault();
    const box = $("#m-note-text");
    const text = box.value.trim();
    if (!text) return;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await post(`/api/orders/${current.order.id}/notes`, { visibility: "internal", text });
      box.value = "";
      await loadCar();
      toast("Note added.");
    } catch (err) {
      toast(err.message || "Couldn't add that note.", true);
    } finally {
      button.disabled = false;
    }
  });
}
