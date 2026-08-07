# RECON on a phone — the plan

Read `CLAUDE.md` first. This document is the *why* behind `static/m/`; the
code is the *what*.

## The problem

RECON lives on the shop PC and on workstations. But the work it describes
happens **out on the lot**, standing next to a car. Today, answering "what
does this one still need?" means walking back inside to a desk. Every
recon car gets walked past a dozen times a day by someone who cannot see
its record without leaving it.

The four questions `CLAUDE.md` says the app exists to answer —
which cars are ready, which are being worked, what each still needs, how
much we spent — are all questions you ask **while looking at the car**.

## The decision: an installable web app, not a native one

RECON on a phone is a **mobile-first web app served by the same FastAPI
process**, at `http://<shop-pc>:8787/m/`, installable to the home screen
via a web manifest so it gets an icon and opens without browser chrome.

Alternatives considered and rejected:

| Option | Why not |
|---|---|
| Native iOS + Android (Swift/Kotlin) | Two codebases, two toolchains, an Apple developer account, and an App Store review cycle — for two users on one wifi network. Clayton could never fix it before opening. |
| React Native / Flutter | **Introduces a build step**, which `CLAUDE.md` calls load-bearing. A phone build could not be produced or repaired on the shop PC. |
| Make the existing desktop UI responsive | The desktop layout is a 212px rail plus a wide board table with fixed columns, and its own CSS says min-widths are "the backstop rather than the plan". Squeezing it to 390px produces a bad desktop app *and* a bad phone app. The phone needs a different information design, not a narrower one. |
| A separate mobile service | Second process, second deploy, second thing to break. The API is already there and already correct. |

The web app wins on every axis that matters here: no build step, no store,
no second deploy, ships inside the existing single-file installer, and
updates the instant the shop PC updates.

## What it does — v1 scope

Four screens. Everything else is deliberately absent.

### 1. Lot — the home screen
Every active car as a tappable card: stock number, vehicle, status, what it
still needs, what's been spent, how long it's sat. Grouped into the same
four piles the desktop board uses (**Not started / In the shop / Ready to
go / Finished — file away**), because the phone and the desk must never
disagree about which pile a car is in.

Data: `GET /api/vehicles-board?view=active`. The server already stamps
`lot_bucket` and writes the `needs` sentence, so the phone renders what the
desk renders — it does not re-derive either.

### 2. Search
One box. Type a stock number, a plate, part of a VIN, a customer name, or
"blue Kia". Uses `GET /api/agent/search`, which already scores across
recon, we-owe and retail.

This is the screen that justifies the whole app: you are standing at a car
with no idea what it is, and eight keystrokes tell you.

### 3. Car
What the car needs and what it cost. The repair list is **tappable** —
tick a repair off from under the hood. That single write is the highest
value thing a phone can do here, and it is the one the desk version makes
you walk inside for.

- Reads: `GET /api/recon/vehicles/{id}` | `/api/we-owe/{id}` | `/api/retail/vehicles/{id}`, plus `GET /api/orders/{id}`.
- Writes: `PATCH /api/orders/{id}/jobs/{job_id}/done`, `POST /api/orders/{id}/notes`.

### 4. Tasks
The follow-up list, filtered to the person holding the phone, with a
checkbox. `GET /api/tasks`, `PATCH /api/tasks/{id}`.

### What v1 deliberately does not do

**No estimate editing.** The parts grid is money entry with optimistic
locking and 300-row payloads. Fat-fingering a unit cost on a phone in a
bay is how the ledger stops being trustworthy. Costs are **read-only** on
the phone.

No customers, no A/P, no vendors, no reports, no backup, no staff admin.
Those are desk work and they stay at the desk.

## Architecture

```
app/mobile.py              new router: GET /m/, /m/sw.js, /m/manifest.webmanifest
static/m/index.html        the phone shell (its own document, not index.html)
static/m/mobile.css        layout + components, all classes m- prefixed
static/m/js/*.js           ES modules, no build step, same rules as static/js/
static/m/icon-192.png      manifest icons
static/m/icon-512.png
```

Five decisions worth writing down:

**Separate directory, not `static/js/`.** `tests/test_js_modules.py` asserts
every file in `static/js/` is reachable from `main.js`. Mobile modules are
a second entry point, so they live in `static/m/js/` and get their own
equivalent test.

**Themes are single-sourced.** The phone links `/assets/styles.css` for its
design tokens and fonts, then overrides layout in `mobile.css`. Every
mobile class is `m-` prefixed so no desktop rule can reach it. This means
Clayton's six themes work on the phone on day one and can never drift out
of sync with the desk. It reads the same `dao-theme` localStorage key.

**Formatting is copied, not reinvented.** `money()`, `fmtDay()`,
`relativeTime()`, the idle-day buckets and the age thresholds are ported
verbatim from `static/js/shortcuts.js` and `vehicles-board.js`. In
particular `fmtDay()` parses a bare `YYYY-MM-DD` by hand rather than
handing it to `Date` — for the same reason `db.now()` is shop-local: UTC
midnight is 7pm the previous day in Indiana.

**A service worker that caches nothing.** It exists only so Android treats
the app as installable. Caching app code would mean a phone running last
week's RECON against this week's database, and the shop PC's whole update
story assumes everyone is on the same version. Network-only, on purpose.

**Writes round-trip `edit_version`.** Every mutating call the phone makes
either carries the version it read or is a route with no version (the
job-done tick and note POST). No blind writes.

## How it gets on the phones

1. Shop PC tray → turn **network mode** on. The server then binds `0.0.0.0`
   instead of loopback. This is the same switch workstations already need.
2. On the phone, on shop wifi: browse to the address printed on the
   **Updates** screen — `http://<shop-pc-ip>:8787/m/`.
3. iPhone: Share → Add to Home Screen. Android: the install prompt appears.

That address had to be built, not just documented. A phone cannot use
`127.0.0.1` and the shop PC has no name a phone could resolve, so without it
"set up the phone" begins with reading `ipconfig` out of a Command Prompt —
which is not a thing to ask of a mechanic before opening. `GET
/api/mobile/link` reports the interface the server would actually reach the
network on, and the Updates screen prints it along with whether network mode
is on yet. A correct address that silently fails is worse than no address:
it sends somebody hunting through their phone's wifi settings for a problem
that is on the PC.

**Security note, stated plainly rather than quietly changed:** RECON has no
login, and anything on the shop wifi that can reach port 8787 can already
read and write everything. Putting the app on a phone does not create that
exposure — it is the existing posture for every workstation — but it does
mean the shop's wifi password is the only thing protecting the records.
This plan does not weaken it and does not paper over it. Adding real auth
is a separate, larger piece of work worth doing on its own terms.

## Tests

- `tests/test_mobile.py` — routes serve, manifest is valid JSON with the
  required fields, the shell references only assets that exist, the service
  worker declares no cache.
- `tests/test_js_modules.py` extended to cover `static/m/js/` with the same
  reachability and import rules as the desktop modules.
- `tests/dom/mobile_smoke.mjs` — renders the lot screen from a fixture and
  asserts the four piles and the needs sentence appear.

## Later, not now

Offline read cache · photos on a ticket (`activity_events` has nowhere to
put a blob yet) · push for "car is ready" · barcode/VIN scan via the camera
· a QR code beside the address on the Updates screen, so a new phone can be
set up without typing anything at all.
