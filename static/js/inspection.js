/* ---------- the check-over sheet ----------

   Recon starts with a walk around the car: drive it, open the hood, kick the
   tires, and write down what would stop it being sold. The database has had a
   place for that sheet since the schema was first laid down (inspections /
   inspection_items, PUT /api/orders/{id}/inspection) -- but no screen ever
   showed it, so the walk-around lived on paper and the ticket only ever heard
   about it as jobs, with the "looked at it, it's fine" half lost entirely.

   This module is that missing screen. One card on the ticket, above Parts &
   Labor because the walk-around happens before the write-up: a standard list
   of the things the shop checks on every car, each answered Good / Watch /
   Fix with an optional note ("4mm pads left"). A flagged line offers
   "Write it up", which files it straight onto the ticket as a job -- the
   sheet is where work is found, the estimate is where it goes. Finishing the
   sheet folds it down to one readable verdict ("15 looked at, 2 flagged"),
   so a finished check-over takes no more of the page than its answer.

   The sheet autosaves like the estimate grid does: the whole list rides one
   PUT (the server replaces the items wholesale), debounced so a run of
   clicks down the list is one request, with the same Saving / All changes
   saved caption the grid uses. The working copy lives on state.detail and is
   only re-read from the server while it has nothing unsaved -- otherwise a
   background refresh landing mid-walk would quietly undo the last tick. */

import { $, post, put } from "./core.js";
import { toast } from "./notify.js";
import { currentActor, esc, fmtDate } from "./shortcuts.js";
import { state } from "./state.js";
import { loadVehicleDetail } from "./vehicle-detail.js";

/* What the shop looks at on every car. Categories are the walk itself, in the
   order it actually happens: drive it, pop the hood, walk around it, sit in
   it. Trunk struts are on the list because they are the standing example of
   the cheap extra that always gets done (see CLAUDE.md). A car that's missing
   one of these (no AC to check) just gets its line taken off the sheet. */
const CHECKOVER_SHEET = [
  ["Road test", ["Starts & idles", "Shifts through the gears", "Brakes feel", "Steering & tracking", "No warning lights", "AC & heat"]],
  ["Under the hood", ["Fluids & leaks", "Battery & charging", "Belts & hoses"]],
  ["Walk-around", ["Tires & tread", "Lights all around", "Glass & wipers", "Body & paint"]],
  ["Inside", ["Seats & interior", "Windows & locks", "Trunk struts & spare"]],
];

// Where a line typed by hand files on the sheet. Its own group so the
// standard walk keeps its shape however many one-offs a car collects.
const CHECKOVER_CUSTOM_CATEGORY = "More checks";

function checkoverBlankSheet() {
  return CHECKOVER_SHEET.flatMap(([category, names]) =>
    names.map((name) => ({ category, name, condition: "not_checked", measurement: "", notes: "" })));
}

/* One writer for the working copy: the sheet as drawn, plus whether it holds
   anything the server hasn't seen yet. `dirty` is what stops a re-render from
   the next background load stomping an unsaved tick. */
function checkoverWorking() {
  return state.detail.checkover;
}

function checkoverCounts(items) {
  const looked = items.filter((it) => it.condition !== "not_checked").length;
  const fix = items.filter((it) => it.condition === "red").length;
  const watch = items.filter((it) => it.condition === "yellow").length;
  return { looked, fix, watch, total: items.length };
}

let checkoverSaveTimer = null;
let checkoverSaveInFlight = null;

function setCheckoverSaveState(kind) {
  const el = $("#vd-checkover-save-state");
  if (!el) return;
  el.textContent = { saving: "Saving…", saved: "All changes saved", failed: "Not saved" }[kind] || "";
  el.className = `save-state show ${kind}`;
  if (kind === "saved") setTimeout(() => { if (el.textContent === "All changes saved") el.className = "save-state saved"; }, 2200);
}

/* The whole sheet rides every save -- the server replaces the items and that
   is the contract that keeps this simple. Debounced: ticking six boxes on the
   way around the car is one PUT, not six. */
function scheduleCheckoverSave() {
  const working = checkoverWorking();
  if (!working) return;
  working.dirty = true;
  clearTimeout(checkoverSaveTimer);
  checkoverSaveTimer = setTimeout(() => { flushCheckoverSave(); }, 700);
}

async function flushCheckoverSave() {
  clearTimeout(checkoverSaveTimer);
  const working = checkoverWorking();
  if (!working || !working.dirty) return checkoverSaveInFlight;
  const order = state.detail.order;
  if (!order) return null;
  working.dirty = false;
  setCheckoverSaveState("saving");
  const body = {
    status: working.status,
    actor: currentActor(),
    items: working.items.map(({ category, name, condition, measurement, notes }) =>
      ({ category, name, condition, measurement, notes })),
  };
  checkoverSaveInFlight = put(`/api/orders/${order.id}/inspection`, body)
    .then((saved) => {
      working.savedAt = saved && saved.updated_at ? saved.updated_at : working.savedAt;
      setCheckoverSaveState("saved");
    })
    .catch((err) => {
      working.dirty = true;
      setCheckoverSaveState("failed");
      toast(`Check-over not saved: ${err.message}`, true);
    })
    .finally(() => { checkoverSaveInFlight = null; });
  return checkoverSaveInFlight;
}

function checkoverRowHtml(item, index) {
  const flagged = item.condition === "red" || item.condition === "yellow";
  const conditionButton = (value, word) => `
      <button type="button" class="chk-cond chk-${value} insp-control${item.condition === value ? " on" : ""}"
              data-chk-set="${value}" data-chk-index="${index}" aria-pressed="${item.condition === value}"
              title="${value === "green" ? "Looked at it — it's fine" : value === "yellow" ? "Keep an eye on it — worth a note" : "Needs work before the car goes anywhere"}">${word}</button>`;
  return `
    <div class="chk-row${flagged ? ` flagged-${item.condition}` : ""}" data-chk-index="${index}">
      <span class="chk-name">${esc(item.name)}</span>
      <span class="chk-conds" role="group" aria-label="${esc(item.name)}">
        ${conditionButton("green", "Good")}${conditionButton("yellow", "Watch")}${conditionButton("red", "Fix")}
      </span>
      <input class="chk-note insp-control" data-chk-index="${index}" value="${esc(item.notes)}"
             placeholder="Note — e.g. 4mm pads left" aria-label="Note on ${esc(item.name)}">
      <button type="button" class="chk-writeup insp-control" data-chk-index="${index}" ${flagged ? "" : "hidden"}
              title="Put this on the ticket as a job">Write it up</button>
      <button type="button" class="chk-remove insp-control" data-chk-index="${index}"
              title="Take this line off the sheet — this car doesn't have one to check" aria-label="Remove ${esc(item.name)}">×</button>
    </div>`;
}

function checkoverProgressHtml(items) {
  const { looked, fix, watch, total } = checkoverCounts(items);
  const flags = [
    fix ? `<span class="chk-count-fix">${fix} to fix</span>` : "",
    watch ? `<span class="chk-count-watch">${watch} to watch</span>` : "",
  ].filter(Boolean).join(" · ");
  return `${looked} of ${total} looked at${flags ? ` · ${flags}` : ""}`;
}

/* The finished sheet folds down to its verdict. The flagged lines stay in
   sight -- they are the whole answer -- and the clean ones compress into the
   count, which is exactly the half of the walk paper never kept. */
function checkoverSummaryHtml(items, savedAt) {
  const { looked, fix, watch } = checkoverCounts(items);
  const flagged = items.filter((it) => it.condition === "red" || it.condition === "yellow");
  const when = savedAt ? ` ${fmtDate(savedAt)}` : "";
  const verdict = flagged.length
    ? `${looked} things looked at — ${fix ? `${fix} to fix` : ""}${fix && watch ? ", " : ""}${watch ? `${watch} to watch` : ""}.`
    : `${looked} things looked at — nothing flagged. Clean sheet.`;
  return `
    <div class="chk-summary${flagged.length ? "" : " clean"}">
      <div class="chk-summary-verdict">Checked over${when} · ${esc(verdict)}</div>
      ${flagged.map((it) => `
        <div class="chk-summary-line">
          <span class="chk-dot ${it.condition === "red" ? "chk-dot-fix" : "chk-dot-watch"}" aria-hidden="true"></span>
          <span class="chk-summary-name">${esc(it.name)}</span>
          ${it.notes ? `<span class="chk-summary-note">${esc(it.notes)}</span>` : ""}
        </div>`).join("")}
    </div>`;
}

function renderCheckoverBody() {
  const working = checkoverWorking();
  const body = $("#vd-checkover-body");
  const progress = $("#vd-checkover-progress");
  const finish = $("#vd-checkover-finish");
  const reopen = $("#vd-checkover-reopen");
  if (!body) return;

  if (!working) {
    // Not started. The card stays one quiet line -- a sheet nobody has
    // reached for shouldn't push the estimate down the page.
    body.innerHTML = `
      <div class="chk-start">
        <p class="chk-start-hint">Drive it, pop the hood, walk around it — the sheet keeps what you find, and what was fine.</p>
        <button type="button" class="btn btn-primary btn-sm insp-control" id="vd-checkover-start">Start the Check-Over Sheet</button>
      </div>`;
    progress.hidden = true;
    finish.hidden = true;
    reopen.hidden = true;
    return;
  }

  if (working.status === "completed") {
    body.innerHTML = checkoverSummaryHtml(working.items, working.savedAt);
    progress.hidden = true;
    finish.hidden = true;
    reopen.hidden = false;
    return;
  }

  const groups = [];
  working.items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (!last || last.category !== item.category) groups.push({ category: item.category, rows: [] });
    groups[groups.length - 1].rows.push(checkoverRowHtml(item, index));
  });
  body.innerHTML = groups.map((g) => `
      <div class="chk-group">
        <div class="chk-group-head">${esc(g.category)}</div>
        ${g.rows.join("")}
      </div>`).join("") + `
    <form class="chk-add" id="vd-checkover-add">
      <input id="vd-checkover-add-name" class="insp-control" placeholder="Something else you checked — e.g. Sunroof drains"
             aria-label="Add your own line to the sheet" autocomplete="off">
      <button type="submit" class="btn btn-ghost btn-sm insp-control">＋ Add to the Sheet</button>
    </form>`;
  progress.innerHTML = checkoverProgressHtml(working.items);
  progress.hidden = false;
  finish.hidden = false;
  reopen.hidden = true;
}

/* Called from renderOrderPanel with the rest of the ticket's panels. Reads
   the server's copy only while nothing local is unsaved: a save in flight or
   a tick the debounce hasn't sent yet must survive a background reload. */
export function renderInspection(order) {
  const card = $("#vd-checkover-card");
  if (!card) return;
  // A voided ticket has left the workflow; its sheet (if any) is history the
  // activity log already tells. No order, nothing to check against yet.
  if (!order || order.voided) {
    card.style.display = "none";
    state.detail.checkover = null;
    return;
  }
  card.style.display = "";
  const working = checkoverWorking();
  const sameOrder = working && working.orderId === order.id;
  if (!sameOrder || !(working.dirty || checkoverSaveInFlight)) {
    const saved = order.inspection;
    state.detail.checkover = saved ? {
      orderId: order.id,
      status: saved.status === "completed" ? "completed" : "draft",
      savedAt: saved.updated_at || "",
      dirty: false,
      items: (saved.items || []).map((it) => ({
        category: it.category, name: it.name,
        condition: it.condition || "not_checked",
        measurement: it.measurement || "", notes: it.notes || "",
      })),
    } : null;
  }
  renderCheckoverBody();
}

function checkoverItemAt(target) {
  const working = checkoverWorking();
  if (!working) return null;
  const index = Number(target.dataset.chkIndex);
  return Number.isInteger(index) ? working.items[index] : null;
}

/* A flagged line becomes a job with one press: the sheet found the work, the
   ticket gets it, and the two stay one story. The sheet saves first so the
   reload the new job triggers can't come back without the tick that earned
   it. */
async function checkoverWriteUp(item) {
  const order = state.detail.order;
  if (!order || !item) return;
  await flushCheckoverSave();
  const title = item.notes ? `${item.name} — ${item.notes}` : item.name;
  try {
    await post(`/api/orders/${order.id}/jobs`, { title: title.slice(0, 120), technician_id: null });
    toast(`On the ticket: ${item.name}`);
    await loadVehicleDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

export function wireInspection() {
  const card = $("#vd-checkover-card");
  if (!card) return;

  card.addEventListener("click", (e) => {
    const working = checkoverWorking();
    if (e.target.closest("#vd-checkover-start")) {
      state.detail.checkover = {
        orderId: state.detail.order ? state.detail.order.id : null,
        status: "draft", savedAt: "", dirty: false, items: checkoverBlankSheet(),
      };
      scheduleCheckoverSave();
      renderCheckoverBody();
      return;
    }
    const cond = e.target.closest(".chk-cond");
    if (cond && working) {
      const item = checkoverItemAt(cond);
      if (!item) return;
      // Pressing the answer it already has takes it back: a mis-click must
      // not need a fourth button to undo.
      item.condition = item.condition === cond.dataset.chkSet ? "not_checked" : cond.dataset.chkSet;
      scheduleCheckoverSave();
      renderCheckoverBody();
      return;
    }
    const writeup = e.target.closest(".chk-writeup");
    if (writeup && working) {
      checkoverWriteUp(checkoverItemAt(writeup));
      return;
    }
    const remove = e.target.closest(".chk-remove");
    if (remove && working) {
      const index = Number(remove.dataset.chkIndex);
      if (Number.isInteger(index)) {
        working.items.splice(index, 1);
        scheduleCheckoverSave();
        renderCheckoverBody();
      }
    }
  });

  // Notes save on the same debounce as the ticks; typing re-renders nothing,
  // so the cursor stays where the mechanic left it.
  card.addEventListener("input", (e) => {
    const note = e.target.closest(".chk-note");
    if (!note) return;
    const item = checkoverItemAt(note);
    if (!item) return;
    item.notes = note.value;
    const row = note.closest(".chk-row");
    if (row) $(".chk-writeup", row).hidden = !(item.condition === "red" || item.condition === "yellow");
    scheduleCheckoverSave();
  });

  card.addEventListener("submit", (e) => {
    if (!e.target.closest("#vd-checkover-add")) return;
    e.preventDefault();
    const working = checkoverWorking();
    const input = $("#vd-checkover-add-name");
    const name = input ? input.value.trim() : "";
    if (!working || !name) return;
    working.items.push({ category: CHECKOVER_CUSTOM_CATEGORY, name, condition: "not_checked", measurement: "", notes: "" });
    scheduleCheckoverSave();
    renderCheckoverBody();
    const again = $("#vd-checkover-add-name");
    if (again) again.focus();
  });

  $("#vd-checkover-finish").addEventListener("click", async () => {
    const working = checkoverWorking();
    if (!working) return;
    working.status = "completed";
    working.dirty = true;
    await flushCheckoverSave();
    renderCheckoverBody();
  });

  $("#vd-checkover-reopen").addEventListener("click", () => {
    const working = checkoverWorking();
    if (!working) return;
    working.status = "draft";
    working.dirty = true;
    scheduleCheckoverSave();
    renderCheckoverBody();
  });
}
