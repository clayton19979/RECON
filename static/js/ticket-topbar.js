import { $ } from "./core.js";

/* ==================================================================
   TICKET TOP BAR

   The ticket page runs three screens tall once a car has real work on
   it, and everything that says *which* car -- stock number, status, the
   money -- scrolls away with the first screen. Deep in a forty-line
   parts grid, "R-1002" and "R-1003" are the same wall of part numbers,
   and reading the wrong car's ticket costs real money at the counter.

   This is the identity band's understudy: a slim bar that steps in at
   the top of the screen only while the real band is out of sight. It
   never says anything of its own -- every fact on it is copied from the
   band, so the two can't disagree. One press on it puts you back at the
   top; the chevron is the same "Back to Vehicles" the band's button is.

   Wiring: an IntersectionObserver watches the band leave and re-enter
   the scrollport (jsdom has no IntersectionObserver, so in tests the
   bar simply never shows -- the copy itself is what's tested), and a
   MutationObserver re-copies whenever a render rewrites the band while
   the bar is standing in for it -- a part received from the receive
   dialog moves "Spent so far" without the page ever scrolling up.
   ================================================================== */

// rAF-debounced: a render that rewrites the whole band fires the observer
// once per changed node, and one copy at the next frame answers all of them.
let topbarSyncPending = 0;

export function syncTicketTopbar() {
  const head = $("#view-vehicle-detail .detail-head");
  const bar = $("#vd-topbar");
  if (!head || !bar) return;
  $("#vd-topbar-title").textContent = $("#vd-title").textContent;
  // On a we-owe the customer is half of "which car" -- the band says so on
  // its own line, so the bar says so too. Hidden whenever the band hides it
  // (recon cars have no customer to name).
  const whoSrc = $("#vd-customer-line");
  const who = $("#vd-topbar-who");
  who.textContent = whoSrc.textContent;
  who.hidden = whoSrc.hidden || !whoSrc.textContent.trim();
  const pillSrc = $("#vd-status-pill");
  const pill = $("#vd-topbar-pill");
  // className whole, not classList surgery: the band's pill carries its
  // status color as a class, and copying all of it is what keeps the bar's
  // pill the same color without knowing the status vocabulary.
  pill.className = pillSrc.className;
  pill.textContent = pillSrc.textContent;
  pill.hidden = pillSrc.hidden;
  const costSrc = $("#vd-head-cost");
  $("#vd-topbar-cost").hidden = costSrc.hidden;
  $("#vd-topbar-cost-value").textContent = $("#vd-head-cost-value").textContent;
  // Same edge rule as the band -- steel, amber or accent -- so the page
  // doesn't change color when the understudy steps in.
  bar.classList.toggle("dh-weowe", head.classList.contains("dh-weowe"));
  bar.classList.toggle("dh-retail", head.classList.contains("dh-retail"));
}

function scheduleTopbarSync() {
  if (topbarSyncPending) return;
  topbarSyncPending = requestAnimationFrame(() => {
    topbarSyncPending = 0;
    syncTicketTopbar();
  });
}

export function wireTicketTopbar() {
  const bar = $("#vd-topbar");
  const head = $("#view-vehicle-detail .detail-head");
  const content = bar.closest(".content");
  $("#vd-topbar-back").addEventListener("click", () => $("#back-to-vehicles").click());
  $("#vd-topbar-ident").addEventListener("click", () => {
    // jsdom (and a couple of embedded WebViews) have no Element.scrollTo.
    if (typeof content.scrollTo === "function") content.scrollTo({ top: 0, behavior: "smooth" });
    else content.scrollTop = 0;
  });
  new MutationObserver(scheduleTopbarSync)
    .observe(head, { subtree: true, childList: true, characterData: true, attributes: true });
  if (typeof IntersectionObserver !== "function") return;
  const io = new IntersectionObserver((entries) => {
    const last = entries[entries.length - 1];
    // A band that is display:none (another view is up) reports "gone" too,
    // but with a zero-size rect -- that's the page hiding, not scrolling,
    // and the bar must not arm itself over a different screen.
    const gone = !last.isIntersecting && last.boundingClientRect.height > 0;
    if (gone) syncTicketTopbar();
    bar.classList.toggle("shown", gone);
  }, { root: content, threshold: 0 });
  io.observe(head);
}
