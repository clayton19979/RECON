# RECON — what this app is for

Read this before changing anything. It is the part that isn't recoverable from
the code: who uses this, what they need, and which "obvious improvements" are
actually wrong for this shop.

## The shop

**Discount Auto Repair, Merrillville, Indiana.** The users are **Clayton**
(manager / service advisor, who owns this app) and his co-worker **Antonio**.
They use it every working day. It is not a demo or a portfolio piece — if it
breaks or lies, two people's actual workday breaks with it.

The wider business, which explains nearly every design decision here:

- **Walt** owns the group. He buys cars at **auction** and takes them on
  **trade-in**.
- Those cars come to this repair facility as **recon** work — recondition and
  inspect before resale.
- There is a **used car dealership down the road** that sells them, and a
  **body shop** the group also owns. Both are separate from this repair
  facility, and neither uses this app.

## The three kinds of work

**Recon** — Walt's lot cars. Inspect, test drive, and fix whatever would stop
the car from being sold. Cheap, sensible extras get done too (trunk struts are
the standing example). The goal is maximum profit on the car, so **the cheapest
parts that will do the job win, and junkyard / used parts are normal and
preferred** — not a compromise to design around.

**We-owe** — a car already sold where a salesman promised the customer
something to close the deal. The classic case: the customer hears a clunk from
a worn tie rod, and the salesman promises it'll be fixed after they buy. The
promise is the shop's problem now, so it gets tracked here.

**Retail** — ordinary paying customers. **This is handled in Tekmetric, not
here, on purpose.** Recon work must not muddy the retail end-of-day reports.
The app does carry some retail records, but Tekmetric is the retail system of
record; do not build this out into a general-purpose retail shop system.

## The money rule — read this twice

**Recon and we-owe work is billed at the shop's cost. No markup, ever, on parts
or labor.** Labor is not charged out at all. A ticket's total is what the parts
cost, full stop.

So: any feature that assumes a normal repair-shop margin — labor rates,
retail-vs-cost pricing, gross-profit-per-ticket — is wrong for this app.
Existing labor-rate fields exist because the schema is shared; on recon and
we-owe they are 0 and that is correct.

**What the lot paid for a car is deliberately not tracked here.** Walt keeps
that number and does that math himself. The app answers *"what did we spend
fixing this car?"* — nothing more. There is no purchase-price entry, and
`profit` stays empty rather than subtracting an absent purchase from a real
sale price and reporting the entire sale as margin. Do not add a purchase-price
input back. (Cars from before this rule still have theirs and still show it.)

## What Walt actually asks for

This is the app's reason to exist, and the bar any reporting change is held to.
Walt wants, about the cars on his lot:

1. **Which cars are ready.**
2. **Which cars are being worked on.**
3. **What each remaining car still needs.**
4. **How much we spent on each vehicle.**

Answer those four clearly and the app is doing its job. The reports partly do
this today; making them a better answer to those four questions is always
worthwhile work.

## Working on this codebase

Full technical detail lives in the code and its comments; this is the short
orientation.

- **FastAPI + SQLite + vanilla JS.** No frontend framework and **no build
  step** — that last one is load-bearing. Clayton can fix something on the shop
  PC before opening; keep it that way. Frontend edits are live on refresh,
  backend edits need a server restart.
- **Frontend layout**: ES modules in `static/js/` (entry `static/js/main.js`),
  dialogs one-per-file in `static/dialogs/`, assembled per request by
  `app/pages.py`. Two rules the tests enforce: module bodies only *declare*
  (listener registration goes in a `wire*()` called from `main.js`), and a
  module never assigns another module's binding.
- **Tests**: `.venv/Scripts/python -m pytest -q`. Node is installed, so the
  jsdom smoke tests actually run — they are not optional. `ruff` and `pyright`
  are both clean and expected to stay clean.
- **The jsdom tests cannot catch a missing ES import** (they flatten the
  modules into one scope). `tests/test_js_modules.py` is what catches that.
  For frontend work, also load the app in a browser and watch the console.
- **Every database in this repo is throwaway mock data.** The real shop records
  live on a separate PC at the shop. Seeded names (Maria Alvarez, Tyrell Banks,
  Iris Chandler…) mean it's fake.
- **The shop PC is the master**; workstations connect to it. Updates are
  published from home and installed from the tray. Don't break the single-file
  installer story.

## Judgment calls

Things that look like improvements and are not:

- Adding markup, labor rates, or margin to recon/we-owe work.
- Adding a purchase-price field so profit "works".
- Turning this into a full retail shop-management system (that's Tekmetric).
- Anything that introduces a build step for the frontend.
- Assuming new parts; used parts are the norm here.
- **"Correcting" `app/db.py::now()` to UTC.** It stores shop-local naive time on
  purpose. Every date filter in the UI is a local calendar date, and the shop
  works evenings — with UTC stamps (Indiana is five hours behind), a car
  written down at 8pm was dated tomorrow and disappeared from the day's report.
  `tests/test_shop_local_time.py` will fail if this is changed back. Backup
  filenames are a separate case and legitimately stay UTC.

When a change would affect what Walt sees or what Clayton and Antonio type
every day, prefer the version that needs fewer keystrokes during a busy morning
and that never shows a number it can't stand behind.
