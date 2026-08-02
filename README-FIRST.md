# RECON work copy — 2026-08-01

Everything needed to keep working on RECON and the DART advisor from another
machine. Safe to put in cloud storage: no database, no API keys, no credentials.

## What's here

```
app/ static/ tests/  the app source, at version 1.2.0
hermes-dart/         DART's Hermes configuration
  SOUL.md            the agent's identity and rules (176 lines)
  skills/recon/      the five RECON skills
```

## What was deliberately left out

- **`.venv/`** (161 MB) — machine-specific, and rebuilt in one command below.
- **`build/`, `dist/`** (129 MB) — build artifacts, regenerated from source.
  That includes `RECON-Setup-1.2.0.exe`; rebuild it rather than syncing it.
- **Databases** — the shop's real records live on the shop PC and are backed up
  separately. They do not belong in cloud storage.
- **Hermes `.env` and `auth.json`** — these hold the RECON API key and the
  ChatGPT session. Both stay on the shop PC.

## Getting running at home

```
uv sync
.venv\Scripts\python -m pytest -q
```

Expect **626 passed, 19 skipped**. Then:

```
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Frontend edits are live on refresh; backend edits need a restart. There is no
build step and it should stay that way.

## Reading order

1. `CLAUDE.md` — who uses this and which "obvious improvements"
   are wrong for this shop. Read before changing anything.
2. `AI_ADVISOR_PLAN.md` — the original design for the advisor.
3. `AI_ADVISOR_PROMPT.md`, `_2`, `_3` — the three build prompts, in order.
4. `hermes-dart/SOUL.md` — what DART actually is.

## Where things stand

Shipped and running on the shop PC:

- RECON **1.2.0** installed on the master, MCP mounted at
  `http://127.0.0.1:8787/mcp/`, API-key authenticated.
- **22 MCP tools** (10 read, 12 write). Writes enabled.
- Hermes registered as the `recon` MCP server; DART's SOUL.md and five skills
  in place.

Built this session:

- `vin_check_digit_ok()` in `app/db.py` — ISO 3779 validation, enforced on
  `decode-vin` and agent intake, deliberately not on the manual form.
- `POST /api/orders/{id}/estimate/items` — **appends** lines. The grid's
  `POST /estimate` replaces the whole set and will delete anything absent from
  its payload; no agent tool may ever call it, and a test enforces that.
- `POST /api/agent/intake` — vehicle + RO + jobs in one transaction.
- `GET /api/agent/search` — free-text lookup across all three segments.

## The cross-instance write bug — fixed

**`RECON_API_BASE` used to default to `127.0.0.1:8787` regardless of which
instance hosted the MCP mount**, so a second RECON instance's tools wrote to the
first one's database. This caught me mid-testing — a dev server on port 8899 was
issuing writes against production. It only did no damage because production was
still running the pre-MCP build and returned 404.

A mounted MCP server now calls the app it is mounted in, directly, instead of
looping back over HTTP. There is no port in the path to get wrong, so running a
dev instance needs no special care and `RECON_API_BASE` no longer has to be set.
`tests/test_mcp_server.py` runs two apps in one process and asserts each mount's
tools reach only their own database.

`RECON_API_BASE` still exists for the standalone `python -m app.mcp_server`
server, which has no app to call. It is now read per call rather than at import,
so setting it from a launcher actually takes effect.

## Environment variables

Set on the shop PC, needed if you run the full stack elsewhere:

| Variable | Purpose |
|---|---|
| `API_DISCOUNT_AUTO_OPS_KEY` | shared secret; enables auth on the MCP mount |
| `RECON_MCP_ENABLE_WRITES` | `1` to expose the 12 write tools |
| `RECON_API_BASE` | standalone MCP server only; the mounted one calls its own app |
| `PLATETOVIN_API_KEY` | plate decoding; **not configured** — that tool reports so |
