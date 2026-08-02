# Prompt 2 — make the MCP server usable, and build skills

Paste into Hermes on the work PC, or say: "read `AI_ADVISOR_PROMPT_2.md` in the
RECON repo and do it."

---

You built `app/mcp_server.py`, `app/agent_routes.py` and `tests/test_mcp_server.py`
in the RECON repo. Good foundation — `/api/agent/search` ranks properly and ruff
is clean. Now make it something you can actually drive from a phone, and build
skills around the jobs it does every day.

Re-read `CLAUDE.md` and `AI_ADVISOR_PLAN.md` first. The money rule and the §5
hazards still apply, unchanged.

---

# PART A — fix the server

In rough priority order. Items 1–5 are what stand between this and usable.

## 1. Every tool needs a docstring. This is the biggest problem.

Not one `@mcp.tool` function in `mcp_server.py` has a docstring, so the model
sees `recon_create_recon_vehicle(stock_number, year, make, model, vin, mileage,
color)` and nothing else — no idea what a stock number is, when to use this
instead of `recon_create_ticket`, or that inventing a price is forbidden.

**The docstring becomes the tool description the model reads.** It is the single
cheapest accuracy win available here. Write one for every tool covering: what it
does, when to reach for it, what the arguments mean in shop terms, and what it
returns. Be concrete — "stock number as written on the windshield, e.g. R-1042"
beats "the stock number".

On write tools, state the constraint in the docstring itself: never invent a
price, never invent a part number, recon and we-owe are billed at cost.

## 2. Plate decoding isn't exposed at all

`POST /api/vehicles/decode-plate` exists in `app/main.py` and has no tool. Add
`recon_decode_plate(plate, state)`.

It needs `PLATETOVIN_API_KEY` and **returns 503 when that's unset — which it
currently is on this machine.** Don't let that surface as a bare "RECON API error
503". Detect it and return something Clayton can act on: plate decoding needs an
API key from platetovin.com set as `PLATETOVIN_API_KEY`, and until then he should
send a VIN photo instead. Check whether the key is configured before you write
the tool, and tell me in your summary either way.

## 3. There's no way to check for a duplicate before creating

`GET /api/recon/vehicles/lookup?stock_number=&vin=` exists and no tool exposes
it, so `recon_create_recon_vehicle` can only discover a duplicate by failing with
a 409. Add `recon_lookup_vehicle(stock_number="", vin="")`.

Remember the asymmetry: a **live** VIN match means the car is already on the lot
and intake should stop. An **archived** match is fine and expected — Walt buys
cars back. The docstring must say this or the model will refuse legitimate
intakes.

## 4. VIN check digits are validated nowhere

Not in the MCP server, not in RECON. A misread VIN silently binds two different
cars together through `vehicle_units.vin_key`, and OCR from a phone photo is
exactly where that happens.

Write the ISO 3779 position-9 check-digit validation as a helper in `app/db.py`
next to `normalize_vin` (it belongs with the other VIN logic, and it's pure
arithmetic — easy to test hard). Use it in two places: reject an invalid 17-char
VIN in `decode_vin`, and check it in the intake endpoint below.

Note `VinDecodeIn` currently accepts `min_length=5`, so partial VINs are allowed
through — only apply the check digit to full 17-character VINs, and don't break
the partial-VIN path that already works.

## 5. "VIN photo → ticket" takes four round trips and can half-fail

Today: `recon_decode_vin` → `recon_lookup_vehicle` → `recon_create_recon_vehicle`
→ `recon_create_ticket` → `recon_add_jobs`. Five calls, each able to fail
independently. A failure at step 4 leaves a recon vehicle with no ticket — an
orphan Clayton has to clean up by hand, which is worse than not having the
feature.

Add **`POST /api/agent/intake`** in `agent_routes.py`, doing the whole thing in
**one transaction** on one connection, so a failure anywhere rolls back all of it:

- decode the VIN (or accept already-decoded fields)
- validate the check digit
- duplicate-check stock number and VIN
- create the recon vehicle
- create the repair order
- create the jobs

Return the new `recon_vehicle_id`, `order_id`, `number`, and the decoded vehicle.
Expose it as `recon_intake(...)`. Reuse the existing helpers in `recon.py` and
`workflow.py` rather than reimplementing — in particular `resolve_unit` and
`initialize_order_workflow` must still run, or the car won't be linked to its
`vehicle_unit` and the ticket won't have a workflow row.

**`recon_vehicles.stock_number` is `TEXT NOT NULL UNIQUE`.** Intake cannot
proceed without one. Do **not** auto-generate a placeholder — a made-up stock
number is exactly the kind of invented data the shop can't trust. Return a clear
error telling the caller to ask Clayton for it.

## 6. `recon_add_jobs` loses work on partial failure

It loops one POST per title and returns the error string on the first failure —
so three jobs in, a failure on the fourth returns only the error, and the model
has no idea three already exist. It'll retry and duplicate them.

Return both halves: which titles were created (with ids) and which failed, with
the reason. The model can then act on the truth.

## 7. Writes aren't gated

All sixteen tools register unconditionally. The plan called for reads by default
and writes opt-in, and that's still what I want until I've watched the read side
for a week.

Gate write-tool registration behind `RECON_MCP_ENABLE_WRITES=1`. Off by default.
`TOOL_SPECS` already carries `read_only` on every entry — use it rather than a
second hand-maintained list that can drift.

## 8. `mcp` isn't declared as a dependency

It's installed in `.venv` (1.29.0) but absent from `pyproject.toml`, so a fresh
checkout won't reproduce this environment.

Put it in the **main `dependencies` list**. This reverses what the first prompt
said — see Part C for why. `installers\build_exe.ps1` runs `uv sync --group build`,
which installs the main dependencies, so anything outside that list simply won't
exist at build time and won't be bundled.

## 9. Make errors tell the model what to do next

`_request` returns `"RECON API error 409: <detail>"`. RECON's own messages are
written for humans and are genuinely good, so keep them — but add the next step
for the cases that have one. A 409 on a version guard should say to re-read the
record and retry with the current version. A 422 from Pydantic is machine-shaped
noise; translate it into which field is wrong and what it wants.

---

# PART B — build the skills

Skills live at `C:\Users\disco\AppData\Local\hermes\profiles\dar\skills\`, one
directory per skill, each with a `SKILL.md` carrying YAML frontmatter (`name`,
`description`, `version`, `author`, `platforms`, `metadata.hermes.tags`). Copy
the shape from an existing one — `skills/apple/apple-notes/SKILL.md` is a clean
example. Put these in a new `recon/` category.

Write them to the **`dar` profile**, not machine-level — this is shop work.

The `description` field is what decides whether the skill triggers. Write it in
the words Clayton actually uses, not abstractions.

## `recon-vin-intake` — the headline one

Triggered by: a VIN photo, a VIN typed out, "new car", "just got a car in".

Steps: read the VIN → validate the check digit → `recon_decode_vin` →
`recon_lookup_vehicle` → confirm with Clayton → `recon_intake`.

The skill must encode the judgment calls, not just the call sequence:

- A failed check digit means **I misread it**, not that the VIN is bad. Ask for a
  re-send as a *file* — Telegram's photo compression is usually the culprit.
- Never guess year/make/model. The decoder is authoritative.
- A stock number is required and must be asked for if absent. Never invent one.
- A live duplicate stops intake. An archived one doesn't.
- Always show the VIN back in the confirmation — Clayton spots a bad character
  faster than any check can.
- Work described in the same message becomes jobs in the same intake call, so
  it's one confirmation rather than three.

## `recon-plate-lookup`

Plate + state → vehicle. Must degrade honestly when `PLATETOVIN_API_KEY` isn't
configured: say so and suggest a VIN photo instead. Don't fail silently or
pretend.

## `recon-daily-catchup`

The backlog case — Clayton sitting down to enter a week of work from notes or
voice. Batch aggressively, confirm in groups, keep a running list of what's been
entered so nothing is double-entered, and report at the end what landed and what
still needs a price or a part number.

## `recon-parts-invoice`

Invoice photo → structured extraction → `recon_post_vendor_invoice`. RECON does
its own duplicate detection and arithmetic checking; on `review_required`, say
which check failed rather than retrying. Flag totals that don't add up on the
paper itself — catching a vendor error is worth real money.

## `recon-status`

Read-only questions: what's open, what's ready, what are we waiting on parts for,
what did we spend on a car. Answer from RECON, never from memory of an earlier
message. Short answers — he's on a phone.

---

---

# PART C — it has to survive the single-exe rebuild

This is a hard requirement, and the current design fails it outright. Read this
before writing any code, because it changes the transport.

## Why stdio can't work in the frozen build

Three independent blockers, all verifiable in the repo:

1. **`RECON.spec` sets `console=False`.** In a windowed PyInstaller build
   `sys.stdin` and `sys.stdout` are `None`. A stdio MCP server has no channel to
   speak on. This alone is fatal. It's the same root cause as the comment in
   `tray_app.start_server` about uvicorn's log formatter crashing on
   `sys.stdout.isatty()`.
2. **`Analysis` entry point is `app\tray_app.py`**, which never imports
   `mcp_server`. PyInstaller follows imports from the entry point, so
   `app/mcp_server.py` is **not in the exe at all** right now. Rebuild today and
   the MCP server silently isn't there.
3. **`app/single_instance.py`** guards on a named mutex. A second
   `RECON.exe --mcp-server` process wouldn't start a server — it would signal the
   running copy to focus its window and exit.

## Do this instead: mount MCP on the uvicorn server that's already running

RECON.exe already serves uvicorn on `127.0.0.1:8787`. `FastMCP` can expose a
streamable-HTTP ASGI app; mount it in `create_app` in `app/main.py` alongside the
existing routers.

I checked — Hermes supports URL transport (`hermes mcp add <name> --url <endpoint>`,
see `hermes_cli/mcp_config.py`), so this is a config change on the Hermes side,
not a limitation.

This clears every blocker at once: no stdio, so `console=False` is fine; no
subprocess, so no single-instance conflict; no per-launch onefile extraction; and
because `main.py` imports it, PyInstaller's analysis finally reaches
`mcp_server.py`. The MCP server is then alive exactly when RECON is alive, which
is the correct lifetime anyway.

Re-register the server in the Hermes config to point at the URL instead of a
command.

## Security — do not skip this

I checked this machine: **RECON.exe is currently listening on `0.0.0.0:8787`**,
not loopback. Network mode is on. Mounting MCP there without auth would expose
every tool — including the write tools — to anything on the shop LAN.

Require the API key on the MCP mount, reusing the existing `_check_auth` pattern
from `app/accounting.py` (`API_DISCOUNT_AUTO_OPS_KEY`, `X-API-Key` header). The
key then goes in the Hermes server config as a header. If `API_DISCOUNT_AUTO_OPS_KEY`
isn't set, refuse to mount the write tools at all rather than serving them open —
and tell me, so I can set one.

## Then actually prove it

Don't declare this done off a passing test suite. Rebuild and verify:

```
powershell -File installers\build_exe.ps1
```

Then run `dist\RECON.exe`, and from a *separate* process confirm the MCP endpoint
responds and lists tools. A frozen-import failure shows up nowhere else — it will
not appear in pytest, because pytest runs from the venv where every import
resolves fine.

Expect to need `hiddenimports` entries in `RECON.spec` for `mcp` and its dynamic
imports, the same way `webview.platforms.edgechromium` and `clr` are already
listed there with a comment explaining why. If you add any, comment them in the
same style.

If the build breaks in a way you can't resolve, stop and tell me what failed —
do not work around it by reverting to stdio, which cannot work here.

---

# CONSTRAINTS

- `ruff` and `pyright` clean, `.venv/Scripts/python -m pytest -q` green.
- No network in tests. Drive tools against the `TestClient` via the injected
  transport, the way `tests/test_mcp_server.py` already does.
- New tests for: the check-digit helper (real VINs and corrupted ones), intake
  rolling back cleanly on a mid-sequence failure, `recon_add_jobs` partial
  failure reporting, and write tools being absent when
  `RECON_MCP_ENABLE_WRITES` is unset.
- Keep the §5.1 guard test — no tool may ever target
  `POST /api/orders/{id}/estimate`.
- Don't commit. Show me the diff.

# WHEN DONE

1. The full tool list with its one-line description, reads and writes separated.
2. Whether `PLATETOVIN_API_KEY` is configured, and what plate lookup does today.
3. The skills you wrote and the phrasing that triggers each.
4. Exactly what to set to turn writes on.
5. **Confirmation you rebuilt `dist\RECON.exe` and reached the MCP endpoint from
   the frozen build** — not just from the venv. Include any `hiddenimports` you
   had to add.
6. The new Hermes server config block, with how the API key is passed.
7. Anything you skipped and why.
