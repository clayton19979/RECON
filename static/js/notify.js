import { $ } from "./core.js";
import { esc } from "./shortcuts.js";

/* ---------- message log ----------
   A toast lives for 3.2 seconds and then is gone for good. That's fine for
   "Saved" and genuinely bad for "Could not reach the server", which tends to
   fire while the advisor is looking at the keyboard rather than the screen --
   the only evidence the save failed disappears unseen. Every toast is also
   appended here, and the topbar bell opens the last 50 with timestamps.

   The unread dot counts *errors* only. A wall of successful saves shouldn't
   be the thing nagging you to go look.

   The log survives a reload (localStorage, same cap). The whole point of the
   bell is the message you didn't see in time -- and "didn't see in time"
   very often looks like closing the window and coming back later. The unread
   error count rides along, so a failure from the last session still gets the
   dot. */

// toast lives with the message log because every toast is also logged --
// logMessage() is the other half of the same announcement.
let toastTimer = null;
export function toast(message, isError = false) {
  logMessage(message, isError);
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
const MESSAGE_LOG_LIMIT = 50;
const MESSAGE_LOG_KEY = "dao-message-log";
const messageLog = [];
let messageLogUnread = 0;

function saveMessageLog() {
  // Storage can be full or disabled; the in-memory log keeps working either way.
  try {
    localStorage.setItem(MESSAGE_LOG_KEY, JSON.stringify({
      unread: messageLogUnread,
      entries: messageLog.map((e) => ({ m: e.message, e: e.isError ? 1 : 0, at: e.at.getTime() })),
    }));
  } catch {}
}

function loadMessageLog() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(MESSAGE_LOG_KEY) || "null"); } catch {}
  if (!saved || !Array.isArray(saved.entries)) return;
  for (const e of saved.entries.slice(0, MESSAGE_LOG_LIMIT)) {
    const at = new Date(Number(e.at));
    if (typeof e.m !== "string" || Number.isNaN(at.getTime())) continue; // one bad entry shouldn't dump the log
    messageLog.push({ message: e.m, isError: !!e.e, at });
  }
  messageLogUnread = Math.max(0, Number(saved.unread) || 0);
}

// "2:14 PM" reads as *today's* 2:14 once yesterday's entries can still be on
// the list after a reload, so anything older than today says which day.
function messageLogTime(at) {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  return at.toDateString() === today.toDateString()
    ? time
    : `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${time}`;
}

function logMessage(message, isError) {
  messageLog.unshift({ message: String(message), isError: !!isError, at: new Date() });
  if (messageLog.length > MESSAGE_LOG_LIMIT) messageLog.length = MESSAGE_LOG_LIMIT;
  if (isError && !$("#notif-menu")?.classList.contains("open")) messageLogUnread += 1;
  saveMessageLog();
  renderMessageLog();
}

function renderMessageLog() {
  const list = $("#notif-list");
  const dot = $("#notif-dot");
  if (dot) {
    dot.hidden = messageLogUnread === 0;
    dot.textContent = messageLogUnread > 9 ? "9+" : String(messageLogUnread);
  }
  if (!list) return;
  if (!messageLog.length) {
    list.innerHTML = `<p class="notif-empty">Nothing yet. Saves, errors and status changes show up here.</p>`;
    return;
  }
  list.innerHTML = messageLog.map((entry) => `
    <div class="notif-item ${entry.isError ? "error" : ""}">
      <span class="notif-item-text">${esc(entry.message)}</span>
      <span class="notif-item-time">${esc(messageLogTime(entry.at))}</span>
    </div>
  `).join("");
}

export function wireMessageLog() {
  const wrap = $("#notif");
  const toggle = $("#notif-toggle");
  const menu = $("#notif-menu");
  if (!wrap || !toggle || !menu) return;
  const setOpen = (open) => {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      // Opening the panel *is* reading it -- persisted, so a reload doesn't
      // resurrect a dot for errors that were already looked at.
      messageLogUnread = 0;
      saveMessageLog();
      renderMessageLog();
    }
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  $("#notif-clear").addEventListener("click", () => {
    messageLog.length = 0;
    messageLogUnread = 0;
    saveMessageLog();
    renderMessageLog();
  });
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("open")) setOpen(false);
  });
  loadMessageLog();
  renderMessageLog();
}
