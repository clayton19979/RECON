# Prompt for the Hermes agent

Paste everything below into Hermes on the work PC (or say: "read
`AI_ADVISOR_PROMPT.md` in the RECON repo and do it").

---

Build an MCP server for RECON and register it with yourself, so I can manage the
shop from Telegram by talking to you.

## Context you need first

RECON is a FastAPI + SQLite + vanilla-JS desktop app for Discount Auto Repair.
It runs on this PC as `RECON.exe` — a system-tray app that serves uvicorn on
`127.0.0.1:8787` in a background thread. The repo is on this machine; find it
before you do anything else (look for a folder containing `app/main.py`,
`RECON.spec` and `CLAUDE.md`).

**Read `CLAUDE.md` in that repo start to finish before writing a line of code.**
It is the non-recoverable context: who uses this, what the money rules are, and
which obvious improvements are actually wrong here. There is also
`AI_ADVISOR_PLAN.md` in the same folder — the design this task comes from. Read
that too; §5 lists hazards that will bite you.

The short version of what matters:

- Two people use this every working day. If it breaks or lies, their workday
  breaks with it.
- Three kinds of work: **recon** (lot cars being reconditioned for resale),
  **we-owe** (a promise made to a customer when a car was sold), **retail**
  (ordinary customers — mostly lives in Tekmetric, not here).
- **Recon and we-owe are billed at cost. No markup, ever. Labor is zero.**
  Never invent, estimate, or infer a price.
- No frontend build step. Don't introduce one.
- `ruff` and `pyright` are clean and stay clean. Tests are
  `.venv/Scripts/python -m pytest -q` and they pass before you're done.

## What to build

### 1. `GET /api/agent/search` — a new endpoint in the RECON app

Free-text lookup across everything, because every other tool needs an id and the
model has no business guessing one. Takes `q` and returns ranked candidates:

```json
[{"kind": "recon", "id": 12, "order_id": 84, "label": "R-1042 — 2014 Chevrolet Malibu",
  "stock_number": "R-1042", "vin": "1G11C5SL4EF...", "status": "in_progress"}]
```

It must match on: stock number (normalized — `R-1042`, `R1042` and `r 1042` are
one car; `normalize_stock_number` in `app/db.py` already does this), VIN (full or
last 6, via `normalize_vin`), plate, customer name, and year/make/model/color
free text. Cover `recon_vehicles`, `we_owe_items` and retail `vehicles`. Cap the
result at ~10. Put it in a new `app/agent_routes.py` and mount it in
`create_app`, following the `build_*_router(connect, now)` pattern every other
router in `app/` uses.

### 2. `app/mcp_server.py` — the MCP server

**A standalone stdio MCP server, launched by Hermes as a subprocess.** It talks
to RECON over `http://127.0.0.1:8787/api/...` with `httpx`.

Do **not** import RECON's app internals and do **not** open `shop.db` directly.
Going through HTTP means you reuse every validation, optimistic-lock check and
audit trail already in the app, and you can't fight the running process for the
SQLite write lock. Base URL from `RECON_API_BASE`, default
`http://127.0.0.1:8787`.

Use the official Python MCP SDK (`mcp`, i.e. `FastMCP`). Add it to
`pyproject.toml` under a **new optional dependency group**, not the main
`dependencies` list — the main list is what PyInstaller bundles into
`RECON.exe`, and CLAUDE.md flags the single-file installer as load-bearing.
Install it into the existing project venv with `uv`.

Every tool returns compact JSON and, on failure, a plain-English error string
rather than raising — a failed tool call should tell me what went wrong, not
kill your turn.

#### Read tools — safe, enabled by default

| Tool | Endpoint |
|---|---|
| `recon_search(query)` | `GET /api/agent/search?q=` |
| `recon_get_vehicle(kind, id)` | `/api/recon/vehicles/{id}`, `/api/we-owe/{id}`, `/api/retail/vehicles/{id}` |
| `recon_get_ticket(order_id)` | `GET /api/orders/{id}` |
| `recon_board(segment=None, archived=False)` | `GET /api/vehicles-board` |
| `recon_parts_on_order()` | `GET /api/parts/on-order` |
| `recon_tasks()` | `GET /api/tasks` |
| `recon_dashboard()` | `GET /api/dashboard` |
| `recon_decode_vin(vin)` | `POST /api/vehicles/decode-vin` |

`recon_get_ticket` returns a lot. Trim it to what's useful in a chat reply —
number, segment, status, concern, the vehicle line, jobs with done state, parts
with status and cost, and the total — not the raw payload.

#### Write tools — opt-in, NOT enabled by default

| Tool | Endpoint |
|---|---|
| `recon_create_recon_vehicle(...)` | `POST /api/recon/vehicles` |
| `recon_create_ticket(segment, recon_vehicle_id \| we_owe_id, concern)` | `POST /api/orders` |
| `recon_add_jobs(order_id, titles[])` | `POST /api/orders/{id}/jobs` per title |
| `recon_complete_job(order_id, job_id, done)` | `PATCH /api/orders/{id}/jobs/{job_id}/done` |
| `recon_add_note(order_id, text)` | `POST /api/orders/{id}/notes` |
| `recon_create_task(title, order_id?, assigned_to?, due_date?)` | `POST /api/tasks` |
| `recon_update_vehicle(...)` | `PATCH /api/recon/vehicles/{id}` — mileage/colour/VIN only |
| `recon_post_vendor_invoice(...)` | `POST /api/agent/invoices/process` |

Every write passes `actor="ai:hermes"` where the endpoint accepts an actor, so
the existing activity log records that an AI did it.

#### Tools that must NOT exist

Do not write these at any risk tier. They're irreversible or money-critical and
belong in the UI where there's a full screen of context: any `DELETE`, voiding a
ticket or invoice, recording or deleting payments, archiving or reopening a
vehicle, setting purchase price / sale price / sale date, and editing cost on an
already-received part line.

### 3. Register with Hermes

Write an `mcp_servers.recon` block into `~/.hermes/config.yaml` — the same shape
`_save_mcp_server()` in `hermes_cli/mcp_config.py` writes, and the same shape the
manifests in `hermes-agent/optional-mcps/*/manifest.yaml` describe. Prefer the
`hermes mcp` CLI over hand-editing if it can do this; check `hermes mcp --help`
first.

stdio transport, command = the RECON venv's `python.exe`, args =
`["-m", "app.mcp_server"]`, with the repo as the working directory.

**Enable only the read tools by default**, exactly like the `n8n` manifest prunes
its mutating tools. I'll turn writes on myself once I've watched the read side
behave for a while.

## Hazards — these are real, they're in the current code

1. **Never call `POST /api/orders/{id}/estimate` from any tool.** It replaces the
   entire line-item set and deletes every non-received line missing from the
   payload. A model building that payload from memory will silently destroy
   work. There is no safe way to expose it. To add parts, use
   `POST /api/orders/{id}/findings`, which appends and recomputes totals.

2. **`/findings` rejects a part line with an empty `part_number`** (422, "Every
   proposed part requires a traceable part number"). That rule is deliberate —
   don't weaken it. This shop runs on used and junkyard parts where the number
   often doesn't exist until the part is in hand, so the default path for
   dictated work is `recon_add_jobs` (no part number needed) and the part line
   appears when the invoice is received. Only use `/findings` when I give you an
   actual part number and price.

3. **Optimistic locking.** `recon_vehicles`, `we_owe_items` and `estimates` carry
   `edit_version` and the guard is in the SQL `WHERE` clause. Read the current
   version and pass `expected_version` on every write that accepts it. On a 409,
   re-read and tell me what changed — never retry blind. Antonio may be editing
   the same car.

4. **VIN check digits.** When I send you a photo of a VIN plate, validate the
   check digit (ISO 3779, position 9) before doing anything with it. A mis-read
   VIN silently binds two records of different cars together through
   `vehicle_units.vin_key`, and it is the worst failure mode in this app. If the
   check digit fails, say so and ask me to re-send — as a *file*, not a
   compressed photo. Then hand the VIN to `recon_decode_vin`; never guess the
   year/make/model yourself.

5. **Duplicate cars.** Before creating a recon vehicle, call
   `GET /api/recon/vehicles/lookup?stock_number=&vin=`. A live match means it's
   already on the lot. An *archived* VIN match is fine — Walt buys cars back and
   a second recon episode on one VIN is expected.

6. **Ambiguous search results.** If `recon_search` returns more than one
   plausible match, ask me which one. Do not pick.

## Tests

Match the existing bar — see `tests/` for the house style.

- **Nothing in the test suite touches the network.** Inject the httpx transport
  into the MCP server so tools can be driven against the FastAPI `TestClient`
  from `tests/conftest.py`.
- Test `/api/agent/search` directly: stock number in three formats resolves to
  one car, VIN last-6 matches, a customer name finds their we-owe.
- Test each read tool end-to-end against a seeded database.
- **Add a test asserting no registered tool targets
  `POST /api/orders/{id}/estimate`** — hazard 1 is severe enough to deserve a
  guard that fails loudly if someone adds it later.
- Test the 409 path: a stale `expected_version` produces a clear message, not a
  traceback.

`ruff` and `pyright` clean, full suite green.

## When you're done

Tell me:
1. Where the MCP server lives and how to run it by hand for debugging.
2. The exact `mcp_servers.recon` block you added and which tools are enabled.
3. What to type to make the write tools live when I'm ready.
4. Anything in the plan you couldn't do, and why.

Don't commit anything. Show me the diff and let me look first.
