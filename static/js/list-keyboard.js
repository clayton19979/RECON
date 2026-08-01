import { $, $$, post } from "./core.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { currentActor } from "./shortcuts.js";
import { state } from "./state.js";
import { showView } from "./error-boundary.js";
import { applyVehicleCursor, bulkTaskTitle, clearGlobalSearch, loadVehiclesView, moveVehicleCursor, renderVehicleStatusOptions, renderVehiclesTable, resetVehicleView, selectVehicleRange, setVehicleLayout, setVehicleSelected, syncPartsFilterChip, syncSearchChrome, vehicleKey, vehicleNodeFor, visibleVehicles } from "./vehicles-board.js";
import { openVehicleDetail } from "./vehicle-detail.js";
import { openReconDialog } from "./dialog-new-recon.js";
import { openWeOweDialog } from "./dialog-new-weowe.js";

/* ==================================================================
   SHARED LIST KEYBOARD MODEL

   The board and the Tasks screen are the same shape of work -- a list you
   triage -- so they share one keyboard contract: Arrows/Home/End move a
   cursor row, Enter fires the row's primary action, Space selects it for
   bulk work, "/" jumps to that screen's search box, Escape backs out one
   layer at a time (selection first, then the cursor), and any plain
   character typed while nothing has focus lands in the search box, so
   starting to type before clicking it can never "type outside the box".
   (Single-letter shortcuts like j/k don't exist for the same reason: a
   keystroke either navigates or searches, never both depending on the
   letter.)

   One implementation instead of two hand-kept copies, because the copies
   had already drifted: the board's didn't ignore keys while a modal
   <dialog> was open (arrowing behind a confirm box moved the cursor under
   it), and its Escape couldn't drop the cursor once the selection was
   gone. Screens differ only in what move/open/select/clear-search mean,
   and say so through the config:
     view          -- "#view-..." selector; keys apply only while active
     search        -- selector for this screen's search <input>
     searchEscape(box) -- Escape pressed inside that box
     move(d)       -- 1 | -1 | "first" | "last"
     primary()     -- Enter; the callback guards on its own cursor
     select()      -- Space; return false when there is no cursor so the
                      key keeps its default (page scroll)
     escape()      -- Escape outside the box: peel selection, then cursor

   Registration order still matters per screen (the Tasks call sits after
   wireShortcutsDialog so "?" reaches the overlay before type-to-search),
   so each screen calls this where its old inline handler was wired. */
export function wireListKeyboard({ view, search, searchEscape, move, primary, select, escape }) {
  document.addEventListener("keydown", (e) => {
    if (!$(view).classList.contains("active")) return;
    if (document.querySelector("dialog[open]")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      const box = $(search);
      box.focus();
      box.select();
      return;
    }
    if (typing) {
      if (e.key === "Escape" && e.target.id === search.slice(1)) searchEscape(e.target);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); move("first"); }
    else if (e.key === "End") { e.preventDefault(); move("last"); }
    else if (e.key === "Enter") primary();
    else if (e.key === " ") { if (select() !== false) e.preventDefault(); }
    else if (e.key === "Escape") escape();
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      // Type-to-search: focus the box mid-keydown and let the browser's
      // default action put this same character into it.
      $(search).focus();
    }
  });
}

export function wireVehiclesView() {
  // Scoped to this view's own chips. ".filters .chip" matched every chip in
  // the app -- the A/P date ranges, the cores and returns filters, the task
  // filters -- so clicking any one of those also ran this handler, wiping the
  // active state off every chip on every screen and setting state.filter to
  // undefined. Every other view already scopes its chip wiring this way.
  //
  // [data-filter] narrows it further, to the four mutually-exclusive segment
  // chips. The "Waiting on parts" toggle beside them is also a .chip but it's
  // an independent on/off, so it must not be swept into the radio-group
  // behaviour below (nor lit up by the prefs loader, which decides active
  // state by comparing dataset.filter to state.filter -- undefined || ""
  // would have matched the All case and lit the toggle on every load).
  const vehicleChips = $$("#view-vehicles .filters .chip[data-filter]");
  vehicleChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      vehicleChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const wasHistory = state.filter === "history";
      state.filter = chip.dataset.filter;
      state.vehicleCursor = null;
      if (wasHistory !== (state.filter === "history")) loadVehiclesView();
      else { renderVehicleStatusOptions(); renderVehiclesTable(); }
    });
  });
  $("#vehicles-status-filter").addEventListener("change", (e) => {
    state.vehicleStatus = e.target.value;
    state.vehicleCursor = null;
    renderVehiclesTable();
  });
  // An independent toggle, not one of the segment chips: "Recon" and
  // "Waiting on parts" are a question worth asking together.
  $("#vehicles-parts-filter").addEventListener("click", () => {
    state.vehiclePartsOnly = !state.vehiclePartsOnly;
    state.vehicleCursor = null;
    syncPartsFilterChip();
    renderVehiclesTable();
  });
  $("#vehicles-reset-view").addEventListener("click", () => resetVehicleView());

  /* The summary cards double as the filter for what they count. Reading "3
     over quote" and then having to work out which three is the same
     half-feature the chart's bars fixed; the number you're looking at should
     be the thing you can click.

     Delegated from the row and keyed off data-board-filter rather than the
     card's position, because these are <button>s inside a grid whose
     :nth-child rules already caught us once colouring by position. Stalled
     writes the same state the chart's bars do -- one idle filter, whether it
     came from a bar or from the card -- so the two can never both be on and
     disagree. */
  const statsRow = $("#vehicles-stats");
  if (statsRow) {
    statsRow.addEventListener("click", (e) => {
      const card = e.target.closest("[data-board-filter]");
      if (!card || card.disabled) return;
      const which = card.dataset.boardFilter;
      if (which === "parts") state.vehiclePartsOnly = !state.vehiclePartsOnly;
      else if (which === "over") state.vehicleOverOnly = !state.vehicleOverOnly;
      else if (which === "stalled") {
        // Any other bucket selected means the chart owns the idle filter;
        // taking it over is what the advisor asked for by clicking here.
        state.vehicleIdleBucket = state.vehicleIdleBucket === "stalled" ? "" : "stalled";
      } else return;
      state.vehicleCursor = null;
      renderVehiclesTable();
    });
  }

  // The chart's bars are filters. Delegated from the container because the
  // whole chart is re-rendered on every filter change, so per-bar listeners
  // would be re-bound (or lost) constantly. Clicking the selected bucket
  // clears it, which is the only affordance a one-of-five filter needs.
  const chart = $("#vehicles-chart");
  if (chart) {
    const pickBucket = (bar) => {
      const key = bar.dataset.idleBucket;
      state.vehicleIdleBucket = state.vehicleIdleBucket === key ? "" : key;
      // The cursor is deliberately left alone: renderVehiclesTable already
      // drops it when the filter hides the row it was on, so a cursor that
      // survives into the new view should keep its place rather than sending
      // you back to the top of the list.
      renderVehiclesTable();
    };
    chart.addEventListener("click", (e) => {
      const bar = e.target.closest("[data-idle-bucket]");
      if (bar) pickBucket(bar);
    });
    // role="button" without keyboard activation is a lie to a screen reader,
    // and the rest of this board is fully keyboard-drivable.
    chart.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const bar = e.target.closest("[data-idle-bucket]");
      if (!bar) return;
      e.preventDefault();
      // The board's document-level keydown handler owns Enter (open the cursor
      // row) and Space (select it). Both would also fire on the way up from a
      // bar, so activating a filter would open a car at the same time.
      e.stopPropagation();
      pickBucket(bar);
    });
  }
  const chartToggle = $("#vehicles-chart-toggle");
  if (chartToggle) {
    chartToggle.addEventListener("click", () => {
      state.vehicleChartOpen = !state.vehicleChartOpen;
      // Hiding the chart must not silently leave a filter on that only the
      // chart could show or clear -- that's how a board ends up "missing" cars
      // with no visible reason why. "stalled" is the exception and stays: it
      // was set from the Stalled card, which is still on screen still lit up,
      // so there's nothing invisible about it.
      if (!state.vehicleChartOpen && state.vehicleIdleBucket !== "stalled") state.vehicleIdleBucket = "";
      renderVehiclesTable();
    });
  }
  const searchBar = $("#global-search-bar");
  const searchInput = $("#global-search");
  const searchClear = $("#global-search-clear");

  searchInput.addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    syncSearchChrome();
    if (!$("#view-vehicles").classList.contains("active")) showView("vehicles");
    renderVehiclesTable();
    // Nothing in the render path may steal the caret mid-word -- if anything
    // did, put it straight back where the user is typing.
    if (document.activeElement !== e.target) e.target.focus();
  });

  searchClear.addEventListener("click", () => clearGlobalSearch({ focus: true }));

  // Clicking the pill's padding focuses the field, the way wrapping it in a
  // <label> used to -- without a label owning two controls.
  searchBar.addEventListener("mousedown", (e) => {
    if (e.target === searchInput || e.target.closest(".search-clear")) return;
    e.preventDefault();
    searchInput.focus();
  });
  $("#add-recon-btn").addEventListener("click", () => openReconDialog());
  $("#add-we-owe-btn").addEventListener("click", () => openWeOweDialog());

  // Reading the same list as columns instead of as rows. Not a filter, so it
  // doesn't touch the cursor, the selection or Reset view -- the exact same
  // cars stay on screen, dealt into piles instead of stacked in one list.
  const layoutSwitch = $("#vehicles-layout-switch");
  if (layoutSwitch) {
    layoutSwitch.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-veh-layout]");
      if (btn) setVehicleLayout(btn.dataset.vehLayout);
    });
  }

  /* One delegated click handler, bound to both layouts: the empty state's
     buttons, the per-row checkboxes and opening a vehicle. Rows and cards are
     both recycled across renders, so per-row binding would either double up
     or be lost depending on which side of the reuse a node landed on.

     Table rows and column cards are deliberately handled by one function
     rather than two: click, ctrl-click to toggle and shift-click for a range
     have to behave identically, and two copies of this is exactly how they
     would stop. */
  const handleBoardClick = (e) => {
    const trigger = e.target.closest("[data-empty-action]");
    if (trigger) {
      if (trigger.dataset.emptyAction === "add-recon") openReconDialog();
      if (trigger.dataset.emptyAction === "add-we-owe") openWeOweDialog();
      if (trigger.dataset.emptyAction === "clear-search") clearGlobalSearch();
      if (trigger.dataset.emptyAction === "clear-parts") {
        state.vehiclePartsOnly = false;
        syncPartsFilterChip();
        renderVehiclesTable();
      }
      if (trigger.dataset.emptyAction === "clear-over") {
        state.vehicleOverOnly = false;
        renderVehiclesTable();
      }
      if (trigger.dataset.emptyAction === "clear-idle") {
        state.vehicleIdleBucket = "";
        renderVehiclesTable();
      }
      return;
    }
    const row = e.target.closest("tr.clickable, article.veh-card");
    if (!row) return;
    const key = row.dataset.key;
    // The whole select cell (or, on a card, the corner it sits in) is the hit
    // target, not just the ~13px native box inside it -- clicking the padding
    // used to fall through to the row handler and navigate away mid-bulk-
    // selection.
    const selectCell = e.target.closest("td.col-select, .veh-card-select");
    const box = e.target.closest(".veh-select") || (selectCell ? $(".veh-select", selectCell) : null);
    if (box) {
      // the checkbox owns the click; opening the vehicle would be a surprise
      const isDirect = e.target.closest(".veh-select");
      if (e.shiftKey && state.vehicleAnchor && state.vehicleAnchor !== key) selectVehicleRange(state.vehicleAnchor, key);
      else setVehicleSelected(key, isDirect ? box.checked : !state.vehicleSelection.has(key));
      state.vehicleAnchor = key;
      state.vehicleCursor = key;
      renderVehiclesTable();
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // modifier-click anywhere on the row is a selection gesture, not navigation
      if (e.shiftKey && state.vehicleAnchor) selectVehicleRange(state.vehicleAnchor, key);
      else setVehicleSelected(key, !state.vehicleSelection.has(key));
      state.vehicleAnchor = key;
      state.vehicleCursor = key;
      renderVehiclesTable();
      return;
    }
    state.vehicleCursor = key;
    openVehicleDetail(row.dataset.segment, Number(row.dataset.id));
  };
  $("#vehicles-table").addEventListener("click", handleBoardClick);
  const columnsHost = $("#vehicles-columns");
  if (columnsHost) columnsHost.addEventListener("click", handleBoardClick);

  // The shared triage-list keyboard model (see wireListKeyboard). Enter
  // opens the cursor row's detail page -- on this screen a row is a door,
  // where on Tasks it's the work itself.
  wireListKeyboard({
    view: "#view-vehicles",
    search: "#global-search",
    searchEscape: () => clearGlobalSearch(),
    move: moveVehicleCursor,
    primary: () => {
      // Looked up in whichever layout is showing -- the cursor is a table row
      // in one and a card in the other, and carries the same key in both.
      const el = vehicleNodeFor(state.vehicleCursor);
      if (el) openVehicleDetail(el.dataset.segment, Number(el.dataset.id));
    },
    select: () => {
      if (!state.vehicleCursor) return false;
      setVehicleSelected(state.vehicleCursor, !state.vehicleSelection.has(state.vehicleCursor));
      state.vehicleAnchor = state.vehicleCursor;
      renderVehiclesTable();
    },
    escape: () => {
      if (state.vehicleSelection.size) {
        state.vehicleSelection.clear();
        renderVehiclesTable();
      } else if (state.vehicleCursor) {
        // Layered escape, same as Tasks: with nothing selected, drop the
        // cursor itself. The board used to strand it on the row forever.
        state.vehicleCursor = null;
        applyVehicleCursor();
      }
    },
  });

  $$("#view-vehicles th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (state.vehicleSort.key !== key) state.vehicleSort = { key, dir: "desc" };
      else if (state.vehicleSort.dir === "desc") state.vehicleSort = { key, dir: "asc" };
      else state.vehicleSort = { key: "", dir: "desc" }; // third click clears back to newest-first
      renderVehiclesTable();
    });
  });

  $("#vehicles-select-all").addEventListener("change", (e) => {
    // Select-all means every row the current filter shows, not every row the
    // DOM happens to have painted.
    visibleVehicles().forEach((v) => setVehicleSelected(vehicleKey(v), e.target.checked));
    renderVehiclesTable();
  });

  $("#vehicles-bulk-clear").addEventListener("click", () => {
    state.vehicleSelection.clear();
    renderVehiclesTable();
  });

  /* Turns a selection into one follow-up task per vehicle.

     This is the action the Stalled card was always pointing at: the card
     tells you eight cars have gone a week untouched, the filter shows you
     which eight, and until now the only thing you could do about it from
     here was open each one and retype its name into the task box. The single
     + Task button on the detail page covers one car well; eight is where the
     board has to do it.

     One task per vehicle rather than one task listing eight, because a task
     is the unit that gets assigned, dated and ticked off -- and each one
     carries its vehicle's order_id, so it shows the jump-to-vehicle chip on
     the Tasks screen and closes the loop back.

     Selecting one vehicle deliberately does *not* shortcut to the prefilled
     Tasks form the detail page's nudge uses: the same button doing two
     different things depending on how many rows are ticked is the kind of
     surprise that makes people stop trusting a control. */
  const bulkTask = $("#vehicles-bulk-task");
  if (bulkTask) {
    bulkTask.addEventListener("click", async () => {
      const byKey = new Map(state.vehicles.map((v) => [vehicleKey(v), v]));
      const targets = [...state.vehicleSelection].map((k) => byKey.get(k)).filter(Boolean);
      if (!targets.length) return;
      const plural = `${targets.length} task${targets.length === 1 ? "" : "s"}`;
      // Shows the exact first title rather than describing it, because the
      // wording is generated and this is the only chance to see it before
      // twenty of them land in the queue.
      const preview = bulkTaskTitle(targets[0]);
      if (!(await confirmAction({
        eyebrow: "TASKS",
        title: `Create ${plural}?`,
        body: `One per selected vehicle, linked to its ticket. The first will read “${preview}”.`,
        confirmLabel: `Create ${plural}`,
      }))) return;
      /* One request, not N. The old version fanned out a POST per vehicle and
         counted settled promises, which could report "6 created, 2 failed"
         without being able to say which two -- leaving the only recovery as
         re-ticking the right subset from memory or creating duplicates. The
         server now takes the whole batch and refuses it whole if any ticket
         link is bad, so the outcome is one of two states the user can act on. */
      let created;
      try {
        const result = await post("/api/tasks/bulk-create", {
          items: targets.map((v) => ({ title: bulkTaskTitle(v), order_id: v.order_id || null })),
          actor: currentActor(),
        });
        created = result.created ?? targets.length;
      } catch (err) {
        toast(`Could not create tasks: ${err.message}`, true);
        return;
      }
      toast(`${created} task${created === 1 ? "" : "s"} created`);
      // Clearing the selection is the point: these cars have been dealt
      // with as far as this screen is concerned, and leaving them ticked
      // invites creating the same tasks twice.
      state.vehicleSelection.clear();
      renderVehiclesTable();
    });
  }

  $("#vehicles-bulk-archive").addEventListener("click", async () => {
    const reopening = state.filter === "history";
    const targets = [...state.vehicleSelection].map((key) => {
      const [segment, id] = key.split(":");
      return { segment, id };
    });
    const plural = `${targets.length} vehicle${targets.length === 1 ? "" : "s"}`;
    if (!(await confirmAction({
      eyebrow: reopening ? "REOPEN" : "ARCHIVE",
      title: reopening ? `Reopen ${plural}?` : `Send ${plural} to History?`,
      body: reopening
        ? "They come back onto the active board and become editable again."
        : "Archived vehicles are read-only until reopened. Nothing is deleted.",
      confirmLabel: reopening ? "Reopen" : "Send to History",
    }))) return;
    const results = await Promise.allSettled(targets.map(({ segment, id }) =>
      post(`/api/${segment === "recon" ? "recon/vehicles" : "we-owe"}/${id}/${reopening ? "reopen" : "archive"}`, {})
    ));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(failed ? `${targets.length - failed} succeeded, ${failed} failed` : `${targets.length} vehicle${targets.length === 1 ? "" : "s"} updated`, !!failed);
    await loadVehiclesView();
  });
}
