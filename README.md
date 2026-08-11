# RECON

The shop-management app for the recon side of **Discount Auto Repair,
Merrillville, Indiana**. Clayton and Antonio use it every working day to track
the cars Walt buys at auction and takes on trade — what each car needs, who's
working on it, and what the shop has spent putting it right for the lot.

It exists to answer the four questions Walt actually asks:

1. **Which cars are ready.**
2. **Which cars are being worked on.**
3. **What each remaining car still needs.**
4. **How much we spent on each vehicle.**

## What it deliberately is not

- **Not a retail shop system.** Paying customers go through Tekmetric; RECON
  carries some retail records but Tekmetric is the system of record.
- **No markup, no labor charges** on recon and we-owe work. A ticket's total
  is what the parts cost, full stop.
- **No purchase-price tracking.** Walt keeps that number himself. The app
  answers *"what did we spend fixing this car?"* — nothing more.

`CLAUDE.md` explains all of this in full, including which "obvious
improvements" are wrong for this shop. **Read it before changing anything.**

## Running it

**At the shop:** each PC runs the installed exe (`RECON-Setup-<version>.exe`
from the [releases](../../releases)). One machine is the main shop PC and
holds the database; workstations connect to it. Updates arrive through the
tray icon — the shop PC checks daily and installing is a click.

**From source** (Windows dev box: double-click `Run RECON.bat`):

```
uv sync
uv run uvicorn app.main:app --port 8000
```

There is **no frontend build step**, on purpose — frontend edits are live on
refresh, backend edits need a restart. Keep it that way; it's what lets a
problem be fixed on the shop PC before opening.

## Checks

```
uv sync
cd tests/dom && npm install jsdom && cd ../..
uv run python scripts/check.py
```

`scripts/check.py` runs the whole gate — pytest, ruff check, ruff format,
pyright — and prints only what failed. The `jsdom` install is not optional:
without it the frontend DOM tests silently skip instead of running.
`uv run python scripts/smoke.py` boots the server and confirms every screen's
data endpoint answers.

Every database in this repo is throwaway mock data (seeded names like Maria
Alvarez mean it's fake). Reset it with `uv run python seed_mock_data.py`. The
real shop records live on the shop PC and are backed up separately.

## Where things live

| Path | What it is |
| --- | --- |
| `app/` | FastAPI backend, SQLite, one module per screen area |
| `static/` | Vanilla-JS frontend — ES modules in `static/js/`, dialogs in `static/dialogs/` |
| `tests/` | Python + jsdom test suite (`scripts/check.py` runs it all) |
| `installers/` | Windows exe + installer build, release publishing |
| `scripts/` | `check.py`, `smoke.py`, `bump_version.ps1` |
| `CLAUDE.md` | The part not recoverable from code: who this is for and why |
| `auto_improvements.log` | Running log of the nightly automated improvement runs |

## How changes ship

A nightly automated run opens at most one pull request; nothing merges itself
— every change waits for review. When a merged change bumps the version
(`app/version.py` and friends), the release is built and published
automatically, and the shop PC picks it up on its daily check.
`installers/publish_update.ps1` remains the manual from-home path.
