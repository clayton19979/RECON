// Message log + keyboard shortcuts overlay smoke test.
//
// Two features that share a failure mode: both live at the app shell level
// (topbar bell, "?" overlay), so no screen-specific suite exercises them, and
// both are the kind of thing that breaks quietly -- a log that stops
// persisting still *looks* fine until the reload that was its whole reason to
// exist, and a "?" that leaks into type-to-search doesn't error, it just
// types "?" into the search box instead of opening the help.

import { boot, press, click } from "./harness.mjs";

const KEY = "dao-message-log";

/* ============================================================
   First boot: empty storage. Log fills, persists, and the "?"
   overlay opens without feeding the board's type-to-search.
   ============================================================ */
{
  const { w, doc, settle, ok, finish, rejections } = await boot({
    expose: ["toast", "logMessage"],
    fetch: async () => [],
  });
  await settle();

  const items = () => [...doc.querySelectorAll("#notif-list .notif-item")];
  const dot = doc.querySelector("#notif-dot");
  const stored = () => JSON.parse(w.localStorage.getItem(KEY) || "null");

  // A plain save lands in the list and in storage, but doesn't light the dot.
  w.toast("Saved");
  ok(items().length === 1, `expected 1 log item after a toast, got ${items().length}`);
  ok(dot.hidden, "success toast lit the unread dot; only errors should");
  let s = stored();
  ok(s && s.entries.length === 1 && s.entries[0].m === "Saved",
    `storage after one toast: ${JSON.stringify(s)}`);
  ok(s.unread === 0, `success toast persisted unread=${s.unread}`);

  // An error lights the dot and persists the count with it.
  w.toast("Could not reach the server", true);
  ok(!dot.hidden && dot.textContent === "1", `error dot reads "${dot.textContent}" (hidden=${dot.hidden})`);
  ok(items()[0].classList.contains("error"), "newest entry should render first, flagged as an error");
  s = stored();
  ok(s.unread === 1, `error toast persisted unread=${s.unread}`);
  ok(s.entries[0].e === 1 && s.entries[0].m === "Could not reach the server",
    `newest stored entry: ${JSON.stringify(s.entries[0])}`);

  // Opening the bell reads the panel: dot goes out, and *that* persists too.
  click(w, doc.querySelector("#notif-toggle"));
  ok(dot.hidden, "opening the panel should clear the unread dot");
  ok(stored().unread === 0, "cleared unread should persist");

  // Clear empties both the list and storage.
  click(w, doc.querySelector("#notif-clear"));
  ok(items().length === 0, "Clear left items in the list");
  ok(stored().entries.length === 0, "Clear left entries in storage");

  // The log caps itself at 50 -- in memory and in storage.
  for (let i = 0; i < 60; i++) w.logMessage(`msg ${i}`, false);
  ok(items().length === 50, `expected the list capped at 50, got ${items().length}`);
  ok(stored().entries.length === 50, `expected storage capped at 50, got ${stored().entries.length}`);

  /* ---------- "?" overlay ---------- */
  const dlg = doc.querySelector("#shortcuts-dialog");
  const search = doc.querySelector("#global-search");

  // The vehicles board is the active view, so this press races the board's
  // type-to-search handler -- exactly the collision the init-order comment
  // in app.js exists for.
  press(w, "?");
  ok(dlg.open, '"?" did not open the shortcuts overlay');
  ok(doc.activeElement !== search, '"?" leaked into type-to-search and focused the search box');
  ok(!search.value, `"?" typed into the search box: "${search.value}"`);

  // Same key closes it again.
  press(w, "?");
  ok(!dlg.open, 'second "?" should close the overlay');

  // While typing, "?" is just a character.
  search.focus();
  press(w, "?", { target: search });
  ok(!dlg.open, '"?" opened the overlay from inside an input');
  search.blur();

  // The close button works.
  press(w, "?");
  click(w, doc.querySelector("#shortcuts-close"));
  ok(!dlg.open, "the overlay's close button did nothing");

  ok(rejections.length === 0, `unhandled rejections: ${rejections.map(String).join(", ")}`);
  finish("message log fills, persists and caps; ? overlay opens without touching search");
}

/* ============================================================
   Second boot: storage already holds a log with an unread error
   from "yesterday". The bell must come up already loaded.
   ============================================================ */
{
  const yesterday = Date.now() - 26 * 60 * 60 * 1000;
  const { w, doc, settle, ok, finish } = await boot({
    fetch: async () => [],
    beforeBoot: (win) => {
      win.localStorage.setItem(KEY, JSON.stringify({
        unread: 2,
        entries: [
          { m: "Vehicle saved", e: 0, at: Date.now() - 60 * 1000 },
          { m: "Could not reach the server", e: 1, at: yesterday },
          { m: "corrupt", e: 1 }, // no timestamp: must be skipped, not fatal
        ],
      }));
    },
  });
  await settle();

  const items = [...doc.querySelectorAll("#notif-list .notif-item")];
  const dot = doc.querySelector("#notif-dot");

  ok(items.length === 2, `expected the 2 valid saved entries, got ${items.length}`);
  ok(!dot.hidden && dot.textContent === "2", `restored dot reads "${dot.textContent}" (hidden=${dot.hidden})`);
  ok(items[0].textContent.includes("Vehicle saved"), "restored log lost its order");
  ok(items[1].classList.contains("error"), "restored error entry lost its error styling");

  // Yesterday's entry says which day; today's doesn't.
  const dayName = new Date(yesterday).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  ok(items[1].querySelector(".notif-item-time").textContent.includes(dayName),
    `old entry's timestamp should carry "${dayName}": "${items[1].querySelector(".notif-item-time").textContent}"`);
  ok(!items[0].querySelector(".notif-item-time").textContent.includes("·"),
    `today's entry should be time-only: "${items[0].querySelector(".notif-item-time").textContent}"`);

  finish("message log restores from a previous session, unread dot intact");
}
