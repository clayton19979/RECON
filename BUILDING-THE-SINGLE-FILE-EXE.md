# Building RECON's single-file exe

Written for an AI doing this build. Read `CLAUDE.md` first — it says who uses
this app and which obvious improvements are wrong for this shop.

## Read this before you start: it already exists

RECON already builds as a single self-contained file. If you were asked to
"make it a single-file exe", the work is done — do not restructure the build to
achieve something it is already doing.

There are two artifacts, and the distinction matters:

| Artifact | What it is | Built by |
|---|---|---|
| `dist\RECON.exe` | The app. One file. PyInstaller onefile — Python, deps, `static/`, all inside. | `installers\build_exe.ps1` |
| `dist\RECON-Setup-<version>.exe` | An installer that wraps `RECON.exe` and sets the machine up. | `installers\build_installer.ps1` |

`RECON.exe` runs on its own. The setup exe exists because a bare exe cannot
create firewall rules, decide whether this PC is the master, or grant the
Users group write access to the database folder. Those are the "everything
needed" part, and they are already automated — see below.

## The build machine needs

- **uv** — `winget install astral-sh.uv`
- **Inno Setup 6** — `winget install JRSoftware.InnoSetup`
- **Node** — the jsdom tests need it on PATH or they silently skip. `scripts/check.py` handles putting it there.
- **GitHub CLI**, signed in — `winget install GitHub.cli` then `gh auth login`. Only needed to publish.

## The sequence

Run these from the repo root, in order. Each refuses to proceed on a failure
rather than producing a build that lies about itself.

```bash
powershell -File scripts\bump_version.ps1 1.2.2
```

Sets the four files that must agree: `app/version.py`, `pyproject.toml`,
`installers/RECON.iss`, `version_info.txt`. **A bump is not optional if this
build is meant to reach anyone** — `available_update()` gates on
`is_newer(version, current)`, so a rebuilt 1.2.1 is never offered to a PC
already on 1.2.1. Follow it with `uv lock`, which the script does not do and
which otherwise drifts.

```bash
.venv\Scripts\python scripts\check.py
```

Every gate in one command: pytest, `ruff check`, `ruff format --check`,
pyright. Exits 0 only if all four are clean. Do not build on a red check.

```bash
powershell -File installers\publish_update.ps1
```

The whole "push an update from home" flow: it validates that the version files
agree, refuses if a release `v<version>` already exists, refuses if the working
tree is dirty, then builds the exe, builds the installer, pushes master, and
creates the GitHub release with the setup exe attached.

To build without publishing, run the two build steps directly:

```bash
powershell -File installers\build_exe.ps1
```

```bash
powershell -File installers\build_installer.ps1
```

## Traps already solved — do not "fix" these

Each of these is load-bearing and cost someone a debugging session.

- **`uv run python -m PyInstaller`, never bare `pyinstaller`.** The `.exe`
  shims in `.venv\Scripts` embed the absolute path the venv was created at.
  This repo has moved once already; the shims died and `python.exe` survived.
- **`$env:UV_LINK_MODE = "copy"`** in `build_exe.ps1`. OneDrive refuses to
  hardlink into uv's cache (os error 396) and aborts the sync partway through.
- **`hiddenimports` in `RECON.spec`** — `webview.platforms.edgechromium`,
  `webview.platforms.winforms`, `clr`. pywebview loads its Windows backend
  lazily through pythonnet, so PyInstaller's static analysis never sees them.
  Drop them and you ship an exe that dies on the first window with "no
  available GUI backend".
- **`RECON.spec` is the source of truth**, not command-line PyInstaller flags.
  `build_exe.ps1` invokes the spec so the two cannot drift.
- **Explicit `Test-Path dist\RECON.exe` after the build.** PowerShell does not
  stop on a native command's exit code whatever `$ErrorActionPreference` says;
  without the check the script printed "Built:" over a build that never happened.

## What the installer already installs automatically

This is the answer to "make it install everything needed" for the RECON side.
`installers\RECON.iss` already does all of it, unattended:

- **The WebView2 runtime**, but only if missing — `NeedsWebView2` checks the
  EdgeUpdate registry key first. This is what draws the window; Windows 11 has
  it, older Windows 10 may not.
- **Asks what this PC is** (main shop PC vs workstation) and writes
  `deployment.json` accordingly, with an optional master hostname for the case
  where discovery fails across subnets.
- **Turns network mode on for the master** (`network_mode.flag`) — without it
  the app binds loopback only and no workstation can reach it.
- **Grants the Users group write access** to `ProgramData\RECON` via `icacls`.
  ProgramData subfolders are admin-writable only by default, and every shift
  needs to write to the database.
- **Adds firewall rules** for the app's TCP port and UDP discovery, master
  only, and removes them on uninstall — including the rules Windows silently
  adds under its own name, which is why the uninstall matches on program path
  and not just rule name.
- **Shortcuts**, with optional desktop icon and run-at-startup.

Installing per-machine (`PrivilegesRequired=admin`) is deliberate: a per-user
install would give the morning and evening shifts separate copies pointed at
separate databases.

Silent install for automation: `RECON-Setup-<version>.exe /SILENT /NORESTART`.
`scripts\update_shop_pc.ps1 -Install` uses exactly that.

## What it does NOT install: the DART side

This is the real gap, and the honest state of it.

The installer sets up **RECON**. It does not set up **DART** — the Hermes agent
that talks to RECON over MCP. That side needs:

- Hermes itself installed.
- `SOUL.md` and the five skills from `hermes-dart/` in this repo, placed where
  Hermes reads them.
- An `mcp_servers.recon` block in Hermes' config pointing at
  `http://127.0.0.1:8787/mcp/` with the API key.
- `.env` / `auth.json` holding the RECON API key and the ChatGPT session.

**Do not write a script that generates the Hermes config from this
description.** The exact schema is not verifiable from this repo — `hermes-dart/`
carries the content but not the config file, and `AI_ADVISOR_PROMPT.md`
describes an *earlier* design (stdio transport, `python -m app.mcp_server`) that
is not what shipped. What shipped is the HTTP mount. Guessing at the schema and
writing it over a working config is a way to break DART, not to automate it.

If you are asked to automate this, the order is:

1. On a machine with Hermes installed, run `hermes mcp --help` and look at
   `hermes_cli/mcp_config.py`. Find out what the config actually looks like.
2. Prefer the `hermes mcp` CLI over writing YAML by hand.
3. Read the existing `~/.hermes/config.yaml` before writing anything, and back
   it up.
4. Never put the API key in a file this repo tracks. It is
   `API_DISCOUNT_AUTO_OPS_KEY` and it belongs in the environment.

Bundling Hermes into RECON's installer is a bigger question than it looks —
they have separate release cycles and DART is useful without a rebuild of
RECON. Ask before designing it.

## Verify the build

```bash
powershell -File scripts\update_shop_pc.ps1
```

Against a freshly installed machine this reports the running version, the
role, whether an update is pending, and whether the MCP mount answers. A 401
from `/mcp/` is the **correct** answer when an API key is configured — it
proves the mount is both present and guarded.

Beyond that: open the app, load the Vehicles board, and confirm cars are there.
A bad PyInstaller build fails at the first window, which no endpoint check
catches.

## Do not

- **Do not add a frontend build step.** No bundler, no transpiler, no
  framework. Clayton fixes things on the shop PC before opening; frontend edits
  are live on refresh and that is load-bearing.
- **Do not run `seed_mock_data.py` on the shop PC.** It writes fake customers
  into what are real records there.
- **Do not sign or ship a build from a dirty tree.** `publish_update.ps1`
  already refuses; do not work around it. An exe no commit corresponds to is
  fine on a bench and not fine on every PC in the shop.
