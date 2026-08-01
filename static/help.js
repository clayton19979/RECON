/* Help: the Help screen, the F1 overlay, and the "?" button on each screen.

   Loaded after app.js as a plain script, so it can call showView() and reuse
   $/$$ without app.js needing to know this file exists. Nothing here touches
   the server -- HELP_TOPICS is the whole data set, so the Help screen is
   built once at load and never refetched.

   The overlay is the point of the feature. Someone who doesn't know the app
   doesn't know what your screens are called, so browsing a manual is the
   slow path; typing what they're trying to do is the fast one. Search runs
   over every word of a topic -- title, aliases, summary and steps -- because
   the words people reach for are far more often in the explanation than in
   the heading. */

(function () {
  const byId = new Map(HELP_TOPICS.map((t) => [t.id, t]));

  const VIEW_LABELS = {
    vehicles: "Vehicles", customers: "Customers", reports: "Reports",
    accounting: "Accounts Payable", cores: "Parts & Cores", staff: "Staff",
    tasks: "Tasks", suggestions: "Ideas", backup: "Backup & Restore",
  };

  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- search ----------
     Every term has to match somewhere in the topic (AND, not OR) -- with 44
     topics, an OR search returns half the manual for a two-word query and is
     worse than useless. Field weights just decide the order of what matched. */
  function scoreTopic(topic, terms) {
    const title = topic.title.toLowerCase();
    const aliases = topic.aliases.map((a) => a.toLowerCase());
    const summary = topic.summary.toLowerCase();
    const steps = topic.steps.join(" ").toLowerCase();
    let total = 0;
    for (const term of terms) {
      let best = 0;
      if (aliases.some((a) => a === term)) best = 100;
      else if (title.includes(term)) best = 60;
      else if (aliases.some((a) => a.includes(term))) best = 45;
      else if (summary.includes(term)) best = 25;
      else if (steps.includes(term)) best = 12;
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  function searchTopics(query, pool = HELP_TOPICS) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return pool.slice();
    return pool
      .map((topic) => ({ topic, score: scoreTopic(topic, terms) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title))
      .map((hit) => hit.topic);
  }

  /* ---------- shared rendering ---------- */

  function stepsHtml(topic) {
    return `<ol class="help-steps">${topic.steps.map((s) => `<li>${escape(s)}</li>`).join("")}</ol>`;
  }

  function relatedHtml(topic) {
    const links = (topic.related || [])
      .filter((id) => byId.has(id))
      .map((id) => `<button type="button" class="help-related" data-help-goto="${id}">${escape(byId.get(id).title)}</button>`);
    const where = VIEW_LABELS[topic.view] || topic.view;
    return `<div class="help-topic-foot">
      <button type="button" class="btn btn-ghost btn-sm" data-help-view="${escape(topic.view)}">Take me to ${escape(where)}</button>
      ${links.length ? `<span class="help-related-label">See also</span>${links.join("")}` : ""}
    </div>`;
  }

  /* ---------- the Help screen ---------- */

  function topicCardHtml(topic) {
    return `<details class="help-topic" id="help-topic-${escape(topic.id)}">
      <summary>
        <span class="help-topic-title">${escape(topic.title)}</span>
        <span class="help-topic-summary">${escape(topic.summary)}</span>
      </summary>
      <div class="help-topic-body">${stepsHtml(topic)}${relatedHtml(topic)}</div>
    </details>`;
  }

  function renderHelpView(filter = "") {
    const host = document.getElementById("help-topics");
    if (!host) return;
    const matched = new Set(searchTopics(filter).map((t) => t.id));
    const groups = HELP_GROUPS
      .map((group) => ({ title: group.title, topics: group.ids.filter((id) => matched.has(id)).map((id) => byId.get(id)) }))
      .filter((group) => group.topics.length);

    if (!groups.length) {
      host.innerHTML = `<p class="help-empty">Nothing matches “${escape(filter)}”. Try a word you'd say out loud — “core”, “we owe”, “backup”.</p>`;
      return;
    }
    host.innerHTML = groups
      .map((group) => `<section class="help-group">
        <h2 class="help-group-title">${escape(group.title)}</h2>
        ${group.topics.map(topicCardHtml).join("")}
      </section>`)
      .join("");
    // A filtered list is a short list, and leaving it collapsed would hide the
    // answer the search just found.
    if (filter) host.querySelectorAll(".help-topic").forEach((el) => { el.open = true; });
  }

  /* ---------- the overlay ---------- */

  let overlayPool = HELP_TOPICS;

  function renderOverlayResults() {
    const box = document.getElementById("help-results");
    const query = document.getElementById("help-search").value.trim();
    const hits = searchTopics(query, overlayPool).slice(0, 12);
    if (!hits.length) {
      box.innerHTML = `<p class="help-empty">Nothing matches “${escape(query)}”.<br>Try what you'd call it out loud, or browse the Help screen for the full list.</p>`;
      return;
    }
    box.innerHTML = hits
      .map((topic) => `<button type="button" class="help-result" data-help-open="${escape(topic.id)}">
        <span class="help-result-title">${escape(topic.title)}</span>
        <span class="help-result-summary">${escape(topic.summary)}</span>
        <span class="help-result-where">${escape(VIEW_LABELS[topic.view] || topic.view)}</span>
      </button>`)
      .join("");
  }

  function showOverlayTopic(id) {
    const topic = byId.get(id);
    if (!topic) return;
    document.getElementById("help-results").innerHTML = `<div class="help-detail">
      <button type="button" class="help-detail-back" data-help-back>← All results</button>
      <h3>${escape(topic.title)}</h3>
      <p class="help-detail-summary">${escape(topic.summary)}</p>
      ${stepsHtml(topic)}${relatedHtml(topic)}
    </div>`;
  }

  function openOverlay({ view = null, query = "" } = {}) {
    const dlg = document.getElementById("help-dialog");
    if (!dlg) return;
    const scoped = view ? HELP_TOPICS.filter((t) => t.view === view) : [];
    // A screen with no topics of its own falls back to everything -- and stops
    // claiming to be scoped, because a message saying it filtered to a screen
    // while showing all 44 topics is worse than no message at all.
    if (!scoped.length) view = null;
    overlayPool = view ? scoped : HELP_TOPICS;
    const scope = document.getElementById("help-scope");
    scope.textContent = view
      ? `Showing help for ${VIEW_LABELS[view] || view}. Clear the box to search everything.`
      : "Type what you're trying to do — “core charge”, “take a payment”, “send it back”.";
    const input = document.getElementById("help-search");
    input.value = query;
    if (!dlg.open) dlg.showModal();
    renderOverlayResults();
    input.focus();
    input.select();
  }

  function goToView(view) {
    const dlg = document.getElementById("help-dialog");
    if (dlg && dlg.open) dlg.close();
    if (typeof showView === "function") showView(view);
  }

  /* ---------- the per-screen "?" buttons ----------
     Injected rather than written into index.html for each screen: this is one
     button with one behaviour, and nine hand-placed copies is nine chances
     for one of them to be wired to the wrong view. */
  function injectPageButtons() {
    const covered = new Set(HELP_TOPICS.map((t) => t.view));
    for (const section of document.querySelectorAll(".view[id^='view-']")) {
      const view = section.id.replace("view-", "");
      // The vehicle detail page isn't a rail screen, but everything on it is
      // filed under Vehicles.
      const topicView = covered.has(view) ? view : (view === "vehicle-detail" ? "vehicles" : null);
      if (!topicView) continue;
      const head = section.querySelector(".page-head, .detail-head");
      if (!head) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "help-page-btn";
      button.textContent = "?";
      button.title = `Help for this screen (F1)`;
      button.setAttribute("aria-label", "Help for this screen");
      button.addEventListener("click", () => openOverlay({ view: topicView }));
      (head.querySelector(".page-head-actions") || head).appendChild(button);
    }
  }

  /* ---------- wiring ---------- */

  function currentView() {
    const active = document.querySelector(".view.active");
    if (!active) return null;
    const view = active.id.replace("view-", "");
    return view === "vehicle-detail" ? "vehicles" : view;
  }

  function init() {
    renderHelpView();
    injectPageButtons();

    const filter = document.getElementById("help-filter");
    filter.addEventListener("input", () => renderHelpView(filter.value.trim()));

    // Print the whole guide, not just whatever happens to be filtered and
    // expanded -- the printed copy is for taping up by the desk.
    document.getElementById("help-print").addEventListener("click", () => {
      filter.value = "";
      renderHelpView();
      window.print();
    });

    const dlg = document.getElementById("help-dialog");
    document.getElementById("help-search").addEventListener("input", renderOverlayResults);
    document.getElementById("help-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    document.getElementById("help-browse-all").addEventListener("click", () => {
      dlg.close();
      goToView("help");
    });
    document.getElementById("help-open-btn").addEventListener("click", () => openOverlay());

    // One delegated handler for both surfaces -- the overlay's markup is
    // replaced on every keystroke, so per-button listeners wouldn't survive.
    document.addEventListener("click", (e) => {
      const open = e.target.closest("[data-help-open]");
      if (open) return showOverlayTopic(open.dataset.helpOpen);
      if (e.target.closest("[data-help-back]")) return renderOverlayResults();
      const go = e.target.closest("[data-help-view]");
      if (go) return goToView(go.dataset.helpView);
      const related = e.target.closest("[data-help-goto]");
      if (!related) return;
      if (dlg.open) return showOverlayTopic(related.dataset.helpGoto);
      // On the Help screen, "See also" expands the other topic in place and
      // scrolls to it rather than opening a dialog over the page.
      const target = document.getElementById(`help-topic-${related.dataset.helpGoto}`);
      if (target) {
        target.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "F1" || e.ctrlKey || e.metaKey || e.altKey) return;
      // Browsers open their own help on F1; this feature is the app's answer
      // to that key, so it has to win.
      e.preventDefault();
      if (dlg.open) dlg.close();
      else openOverlay({ view: currentView() });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
