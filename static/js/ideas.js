import { $, $$, api, get, patch, post } from "./core.js";
import { copyText } from "./clipboard.js";
import { toast } from "./notify.js";
import { confirmAction } from "./confirm.js";
import { currentActor, esc, fmtDate, relativeTime, withLoading } from "./shortcuts.js";
import { emptyState } from "./empty-states.js";
import { state } from "./state.js";
import { renderViewFailure } from "./error-boundary.js";
import { inlineEdit } from "./tasks.js";

/* ==================================================================
   SUGGESTIONS / IDEAS
   ================================================================== */
function suggestionCardHtml(s) {
  const author = !s.author ? "" : (s.author === currentActor() ? "You" : s.author);
  return `
    <div class="suggestion-card ${s.resolved ? "resolved" : ""}" data-id="${s.id}">
      <button type="button" class="suggestion-text" title="Click to edit">${esc(s.text)}</button>
      <div class="suggestion-meta">
        <span title="${esc(fmtDate(s.created_at))}">${author ? `${esc(author)} · ` : ""}${esc(relativeTime(s.created_at))}</span>
        ${s.resolved ? `<span class="pill pill-done">Done</span>${s.updated_at && s.updated_at !== s.created_at ? `<span title="${esc(fmtDate(s.updated_at))}">done ${esc(relativeTime(s.updated_at))}</span>` : ""}` : ""}
        <div class="suggestion-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(s.text)}" data-copy-label="Idea" title="Copy this idea">Copy</button>
          ${s.resolved ? "" : `<button type="button" class="btn btn-ghost btn-sm suggestion-make-task">Make a Task</button>`}
          <button type="button" class="btn btn-ghost btn-sm suggestion-toggle">${s.resolved ? "Reopen" : "Mark Done"}</button>
          <button type="button" class="rm-btn suggestion-delete" title="Delete" aria-label="Delete idea">×</button>
        </div>
      </div>
    </div>
  `;
}

function wireSuggestionCardActions(container) {
  // Ideas are editable after posting -- same invisible-button-until-hover
  // treatment as a task's title, same Ctrl+Enter/Esc contract.
  $$(".suggestion-text", container).forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.closest(".suggestion-card").dataset.id;
      inlineEdit(el, {
        value: el.textContent.trim(),
        multiline: true,
        placeholder: "Idea — Ctrl+Enter to save, Esc to cancel",
        cancel: renderSuggestionsList,
        commit: async (text) => {
          if (!text) { toast("An idea needs some words", true); return renderSuggestionsList(); }
          try {
            await patch(`/api/suggestions/${id}`, { text });
            await loadSuggestionsView();
          } catch (err) {
            toast(err.message, true);
            renderSuggestionsList();
          }
        },
      });
    });
  });
  // Turns an idea into real, trackable work: posts a task titled from the
  // idea's text (truncated to the task title's 300-char limit -- ideas can
  // run to 2000) and resolves the idea, so it doesn't sit open twice over.
  $$(".suggestion-make-task", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      const s = state.suggestions.find((x) => x.id === Number(card.dataset.id));
      if (!s) return;
      const title = s.text.length > 300 ? `${s.text.slice(0, 297)}...` : s.text;
      await withLoading(btn, "Creating…", async () => {
        try {
          await post("/api/tasks", { title, actor: currentActor() });
          await patch(`/api/suggestions/${s.id}`, { resolved: true });
          toast("Task created from this idea");
          await loadSuggestionsView();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  });
  $$(".suggestion-toggle", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      try {
        await patch(`/api/suggestions/${card.dataset.id}`, { resolved: !card.classList.contains("resolved") });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  $$(".suggestion-delete", container).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".suggestion-card");
      if (!(await confirmAction({
        eyebrow: "IDEA",
        title: "Delete this idea?",
        body: "This can't be undone. Mark it done instead if you want to keep the record.",
        confirmLabel: "Delete",
        danger: true,
      }))) return;
      try {
        await api(`/api/suggestions/${card.dataset.id}`, { method: "DELETE" });
        await loadSuggestionsView();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// Open/resolved are separated (matching Tasks' open/completed split) instead
// of interleaved by array order, with the resolved list collapsed by default.
function renderSuggestionsList() {
  const query = (state.suggestionSearch || "").toLowerCase();
  const matches = (s) => s.text.toLowerCase().includes(query) || (s.author || "").toLowerCase().includes(query);
  const totalOpen = state.suggestions.filter((s) => !s.resolved).length;
  let open = state.suggestions.filter((s) => !s.resolved);
  let resolved = state.suggestions.filter((s) => s.resolved);
  if (query) {
    open = open.filter(matches);
    resolved = resolved.filter(matches);
  }

  // A search that only hits resolved ideas used to show "no matches" while
  // the matches sat in a collapsed list -- the user concluded the idea was
  // deleted and re-posted it. Searching forces the resolved section open.
  const showResolved = state.showResolvedSuggestions || (query && resolved.length > 0);

  $("#suggestions-count").textContent = query && open.length !== totalOpen
    ? `${open.length} of ${totalOpen} open`
    : `${open.length} open`;
  $("#suggestions-list").innerHTML = open.length
    ? open.map(suggestionCardHtml).join("")
    : emptyState(query
        ? {
            icon: "search",
            title: "No open ideas match that search",
            hint: resolved.length
              ? `No open ideas matched "${state.suggestionSearch}" — ${resolved.length} resolved match${resolved.length === 1 ? "" : "es"} shown below.`
              : `Nothing matched "${state.suggestionSearch}".`,
          }
        : { icon: "idea", title: "No open ideas", hint: "Write down anything the system should add or fix while it's fresh — mark it done once it's handled." });

  const toggle = $("#suggestions-toggle-resolved");
  toggle.textContent = `${showResolved ? "Hide" : "Show"} done (${resolved.length})`;
  toggle.setAttribute("aria-expanded", showResolved ? "true" : "false");
  $("#suggestions-resolved-list").hidden = !showResolved;
  $("#suggestions-resolved-list").innerHTML = resolved.length
    ? resolved.map(suggestionCardHtml).join("")
    : (showResolved ? emptyState({ icon: "check", title: "Nothing resolved yet", hint: "Ideas you mark done collect here.", compact: true }) : "");

  wireSuggestionCardActions($("#suggestions-list"));
  wireSuggestionCardActions($("#suggestions-resolved-list"));
}

export async function loadSuggestionsView() {
  try {
    state.suggestions = await get("/api/suggestions");
    renderSuggestionsList();
  } catch (err) {
    renderViewFailure("suggestions", err);
  }
}

export function wireSuggestionsView() {
  const input = $("#suggestion-text-input");
  const submitBtn = $("#suggestion-submit");
  // The disabled button is the empty-state affordance -- no un-themed
  // native validation bubble.
  input.addEventListener("input", () => { submitBtn.disabled = !input.value.trim(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("#suggestion-add").requestSubmit();
    }
  });
  $("#suggestion-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    await withLoading(submitBtn, "Posting…", async () => {
      try {
        await post("/api/suggestions", { text, author: currentActor() });
        $("#suggestion-add").reset();
        toast("Idea posted");
        await loadSuggestionsView();
        input.focus();
      } catch (err) {
        toast(err.message, true);
      }
    });
    // withLoading restores the button's pre-call disabled state; re-derive
    // it from the (now empty) textarea.
    submitBtn.disabled = !input.value.trim();
  });
  $("#suggestion-search").addEventListener("input", (e) => {
    state.suggestionSearch = e.target.value.trim();
    renderSuggestionsList();
  });
  $("#suggestions-toggle-resolved").addEventListener("click", () => {
    state.showResolvedSuggestions = !state.showResolvedSuggestions;
    renderSuggestionsList();
  });
  /* Copies exactly what's on screen -- open ideas, filtered by whatever is
     in the search box. Copying the whole table regardless of the filter
     would quietly hand over ideas the user had just filtered away. */
  $("#suggestions-copy-all").addEventListener("click", () => {
    const query = (state.suggestionSearch || "").toLowerCase();
    const shown = state.suggestions
      .filter((s) => !s.resolved)
      .filter((s) => !query || s.text.toLowerCase().includes(query) || (s.author || "").toLowerCase().includes(query));
    if (!shown.length) return toast("No open ideas to copy", true);
    const text = shown
      .map((s, i) => `${i + 1}. ${s.text}${s.author ? ` — ${s.author}` : ""}`)
      .join("\n");
    copyText(text, `${shown.length} idea${shown.length === 1 ? "" : "s"}`);
  });
}
