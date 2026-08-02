# Deploying a RECON update to the shop PC

Written for an AI agent doing this on the shop PC, with Clayton present. The
worked example is **1.2.1**, which carries the MCP cross-instance write fix.

Read `CLAUDE.md` first if you have not. The short version: this app is used
every working day by two people, the database on this machine holds the shop's
real records, and there is no staging copy of it.

## Do not do these

- **Do not type the GitHub token, the RECON API key, or any password.** Two
  steps below need them. Both are Clayton's to perform. Ask, wait, continue.
- **Do not touch `data\shop.db`** — not to inspect it, not to "clean" it, not
  to back it up by hand. The app has a Backup view for that.
- **Do not re-register the MCP server in Hermes.** Nothing about it changed;
  see "What needs no work" below.
- **Do not run `seed_mock_data.py` on this machine.** It is for throwaway
  databases. On the shop PC it would write fake customers into real records.

## What needs no work

The 1.2.1 change is internal to how an MCP tool executes: it calls the app it
is mounted in, directly, instead of looping back over HTTP to
`RECON_API_BASE`. Nothing an MCP client can observe changed — the mount is
still at `/mcp/`, the API-key auth is unchanged, and all 22 tool names,
descriptions and input schemas are byte-identical to 1.2.0.

So **DART's `~/.hermes/config.yaml` stays exactly as it is.** No
re-registration, no re-auth, no tool-list refresh.

`RECON_API_BASE` is now ignored by the mounted server. Leaving it set does
nothing; it is still read by the standalone `python -m app.mcp_server`, which
this machine does not run.

## Step 1 — find out what is running

```bash
curl -s http://127.0.0.1:8787/api/version
```

```json
{"version": "1.2.0", "role": "master", "updates_dir": "...", "update": null}
```

- `version` — what this process is running right now.
- `role` — must be `master` on this machine.
- `update` — what this PC has to hand out. `null` means the updates folder has
  nothing newer than `version`.

If `version` is already `1.2.1`, the update is installed; skip to Step 4.

If the request fails, RECON is not running. Start it before going further.

## Step 2 — get 1.2.1 into the updates folder

The release must already be published from the dev machine
(`installers\publish_update.ps1` does that; it is not run here). Two ways in:

**Normal: let the app fetch it.** Tray icon → **Check Online for Updates**.
This reads `update_source.json` next to the database and pulls the latest
GitHub release into the updates folder.

That file needs a token because the repo is private:

```json
{"repo": "clayton19979/RECON", "token": "github_pat_..."}
```

**If the check reports nothing and that file is missing or has no token, stop
and ask Clayton to fill it in.** Do not paste a token yourself. If he would
rather not, use the fallback below instead.

**Fallback: a carried-in installer.** If `RECON-Setup-1.2.1.exe` was brought in
on a USB stick, copy it into the `updates_dir` from Step 1. The app finds it
there and offers it the same way — that is what makes a hand-carried build
installable by clicking.

Confirm it landed:

```bash
curl -s http://127.0.0.1:8787/api/version
```

`update` should now be an object naming `1.2.1`, not `null`. If it is still
`null`, the file is in the wrong folder or is not named
`RECON-Setup-<version>.exe`.

## Step 3 — install and restart

Install from the banner in the app. It runs the setup exe, which replaces the
installed build.

**RECON must restart for this to take effect** — it is a backend change, and
the running process keeps the old code until then. The installer handles the
restart; if it does not, close RECON from the tray and reopen it.

Then confirm:

```bash
curl -s http://127.0.0.1:8787/api/version
```

`version` must read `1.2.1`. If it still says `1.2.0`, the install did not
replace the running exe — check that RECON actually restarted before
retrying.

## Step 4 — verify

Three checks, in order of what they would catch.

**The app serves.** Open it and load the Vehicles board. Cars are there, counts
look like a normal morning. This catches a bad install faster than any endpoint.

**MCP answers.** From DART, ask for something read-only — "what's on the board"
(`recon_board`) or "how many cars are open" (`recon_dashboard`). A tool result
means the mount is up and the API key still matches.

**The fix is live.** The change is internal, so the version number is the
honest signal that the new code is running, and `/api/version` already gave
you that. It is covered by `tests/test_mcp_server.py`, which runs two apps in
one process and asserts each one's tools reach only its own database.

If you want a behavioural check, have DART add a note to a real RO
(`recon_add_note`) and confirm it appears in the app. A note is the safest
write to make and undo. **Ask Clayton before writing anything to a live
ticket.**

## Step 5 — the workstations

The other PCs update themselves from this one. Each shows the banner once it
asks this machine for `/api/version` and hears `1.2.1`, and installing stays a
click on that PC.

Nothing to do here beyond leaving the shop PC running. If a workstation never
offers the update, check that it can reach this machine and that network mode
is on in the tray.

## If it goes wrong

Roll back by installing the previous setup exe — it is in the updates folder
if it was ever published there, or on the dev machine under `dist\`. The
database is untouched by an install in either direction; 1.2.1 makes no schema
change.

The thing actually worth watching after this update is DART's writes landing on
the right records. That is what the fix is about. If a write lands somewhere
unexpected, capture the RO number and stop DART before it does it again.
