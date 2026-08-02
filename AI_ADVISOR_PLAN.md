# RECON AI Advisor — implementation plan

A Telegram bot that lets Clayton run RECON from his phone: photograph a VIN plate,
a windshield sticker, a parts invoice, or a scribbled list — or just talk into it —
and have tickets get created and updated correctly, with a confirm tap where it
matters.

---

## 0. One thing to fix before you budget for this

**A ChatGPT Plus/Pro subscription does not include API access.** They are separate
products on separate billing. The bot needs an API key from
`platform.openai.com` with its own prepaid credit balance; the subscription you
already pay for gets you nothing here.

The good news is the cost is trivial at this volume. A photo plus the tool-loop
overhead is on the order of a few thousand tokens per message; at the small
multimodal tier that is a fraction of a cent. Even a heavy catch-up day of 200
messages lands in single-digit dollars. **Budget $5–15/month and put a hard
spend cap on the key** so a runaway loop can't quietly bill hundreds. Check
current per-token pricing on the platform when you set it up — it moves.

---

## 1. What it actually does

These are the workflows worth building, in the order they pay off. Each maps to
something Clayton already does on a busy morning.

### 1.1 Ask it things (read-only)

> "what's open on R-1042"
> "which cars are ready"
> "what did we spend on the silver Malibu"
> "what parts are we still waiting on"

Zero risk, immediately useful, and it exercises the whole pipeline. This is
phase 1 for that reason, not as a warm-up.

### 1.2 Photograph a VIN → car on the board

Photo of a door-jamb sticker or dash plate, caption `"new car R-1042"`.

1. Vision model reads the VIN off the photo.
2. **VIN check digit is validated** (ISO 3779 position 9) before anything else.
   This is deterministic arithmetic and catches most OCR slips — a
   mis-read VIN is the single worst failure mode here, because
   `vehicle_units.vin_key` silently binds two records of the same car together
   by VIN.
3. Existing `POST /api/vehicles/decode-vin` (NHTSA, free, already in the app)
   fills year/make/model/trim/engine. **The AI never guesses the vehicle** — it
   only reads characters and hands them to the decoder you already trust.
4. Existing `GET /api/recon/vehicles/lookup` checks the stock number and VIN
   aren't already on the lot.
5. Bot replies with the decoded car and a Confirm button.

### 1.3 Photograph / dictate work → jobs and parts on a ticket

> Voice: *"R-1042 needs front brakes — rotors and pads — and the left outer tie rod."*

Creates the RO if there isn't one, adds `Front brakes` and `Left outer tie rod`
as jobs. **Do not let it invent part prices.** Recon is billed at cost with no
markup; a made-up number becomes a real number in Walt's report. Parts lines go
in with the description and whatever price Clayton dictates, or they go in as a
job with no line at all and get priced when the invoice arrives.

Voice notes are worth building. Walking the lot talking into a phone is the
fastest way there is to clear a week of undocumented work, and Telegram voice
messages → transcription → same tool loop is maybe half a day of work on top of
what the photo path already needs.

### 1.4 Photograph a parts invoice

**This one is nearly free.** `POST /api/agent/invoices/process` already exists,
already does fuzzy vendor matching, PO→RO/stock-number matching, duplicate
detection, arithmetic validation, over-receipt checks, and writes an
`invoice_audits` row with a `review_required` state that the Accounting screen
already renders.

All the AI adds is: photo → structured `InvoiceIn` JSON. Everything downstream
is code you already trust. Highest value-to-effort ratio in the whole plan.

### 1.5 Housekeeping

Create tasks, tick a job done, add a note to a ticket, mark a car ready.

---

## 2. Where it runs

**In-process, on the shop PC, as a daemon thread in the tray app.**

```
Telegram servers
      ▲  outbound HTTPS long-poll (getUpdates), no inbound port
      │
┌─────┴──────────────────────────────────────────┐
│  RECON.exe (shop PC)                           │
│                                                │
│  ┌──────────────┐    ┌─────────────────────┐   │
│  │ advisor      │───▶│ uvicorn / FastAPI   │   │
│  │ thread       │    │ 127.0.0.1:8787      │   │
│  │ (bot loop)   │    │ (existing app)      │   │
│  └──────┬───────┘    └─────────────────────┘   │
│         │                                      │
└─────────┼──────────────────────────────────────┘
          ▼ outbound HTTPS
      api.openai.com
```

Why this and not a cloud webhook:

- **No inbound exposure.** `getUpdates` long-polling is outbound-only, so it
  works behind the shop's NAT with no port forwarding, no tunnel, no public
  hostname. A webhook would require exposing RECON to the internet, and right
  now the API has no authentication at all on the LAN (`_check_auth` guards
  exactly one endpoint) — that is fine for a shop LAN and absolutely not fine
  facing the internet.
- **The shop PC is already the master** and is already always on. Nothing new
  to keep alive.
- **The single-file installer story survives.** New thread, existing process,
  same `RECON.exe`.
- **No new heavy dependency.** Telegram's Bot API is plain JSON over HTTPS and
  `httpx` is already a dependency (it's what `decode-vin` and `address-suggest`
  use). Same for OpenAI — the REST call is a JSON POST.

**Recommendation: call OpenAI with `httpx`, not the `openai` SDK.** The SDK is
pleasant but it's a large dependency with its own transitive tree, and every new
dependency is a new way for the PyInstaller onefile build to break — which
CLAUDE.md flags as load-bearing. The tool-calling loop is ~60 lines of `httpx`.
Keep the request-building in one module so swapping to the SDK later is a
contained change if you decide you want it.

Trade-off to accept: if the shop PC is off, the bot is off. Telegram queues
updates for 24h, so messages sent overnight are processed when it comes back up.
That is the correct behaviour anyway — you do not want tickets being written
while nobody is there.

---

## 3. What the AI is allowed to do

This is the part that decides whether the thing is trustworthy. The rule is:
**the model chooses which tool to call and with what arguments; it never touches
SQL, and it never reaches an endpoint that isn't on this list.**

### Tier A — automatic (read-only)

Executes immediately, no confirmation.

| Tool | Backed by |
|---|---|
| `search(query)` | **new** `GET /api/agent/search` |
| `get_vehicle(kind, id)` | `/api/recon/vehicles/{id}`, `/api/we-owe/{id}`, `/api/retail/vehicles/{id}` |
| `get_ticket(order_id)` | `GET /api/orders/{id}` |
| `list_board(segment)` | `GET /api/vehicles-board` |
| `list_parts_on_order()` | `GET /api/parts/on-order` |
| `list_tasks()` | `GET /api/tasks` |
| `decode_vin(vin)` | `POST /api/vehicles/decode-vin` |

`search` is the keystone: every write tool needs an id, and the model has no
business guessing one. One endpoint that takes free text (`"R-1042"`,
`"silver Malibu"`, `"Tyrell Banks"`, a VIN, a plate) and returns ranked
candidates with `{kind, id, label, stock_number, vin}`. If it returns more than
one plausible match, **the bot asks rather than picking**.

### Tier B — automatic, but reversible and additive

Executes immediately; the bot reports what it did and `/undo` reverses it.

- `add_note(order_id, text)`
- `create_task(title, order_id?, assigned_to?, due_date?)`
- `complete_job(order_id, job_id)` / un-complete

These are cheap to be wrong about and expensive to gate. When the goal is
clearing a week of backlog, making Clayton tap Confirm sixty times defeats the
purpose.

### Tier C — confirm before writing

Bot posts a summary with `[Confirm] [Cancel]` inline buttons. Nothing is written
until the tap.

- `create_recon_vehicle(...)`
- `create_ticket(vehicle_ref, concern, segment)`
- `add_jobs(order_id, titles[])`
- `add_parts(order_id, lines[])`
- `post_vendor_invoice(...)`
- `update_vehicle(...)` — mileage, colour, VIN correction
- `set_ticket_status(order_id, status)`

Anything that creates an entity or moves money gets a human tap. Multiple
actions from one message are batched into **one** confirm card, so the VIN photo
above is a single tap for "create the car *and* open the ticket".

### Tier D — never exposed as a tool

Not reachable from the bot at any risk tier. These live in the UI where there's
a full screen of context:

- Any `DELETE`
- Void a ticket or an AP invoice
- Record or delete a payment
- Archive / reopen a vehicle
- Purchase price, sale price, sale date
- Editing cost on an already-received part line

### The confirm mechanism (get this right)

**On Confirm, do not re-run the model.** Re-prompting is non-deterministic and
could execute something other than what was shown on screen.

Instead: when the model proposes a Tier-C action, write the fully-resolved call
list to an `ai_actions` row (`status='pending'`, payload as JSON) and put its id
in the button's `callback_data`. The tap executes exactly that stored payload,
flips the row to `applied`, and records the resulting ids. Pending rows expire
after ~30 minutes so a stale button in yesterday's chat can't fire.

---

## 4. Safety and attribution

1. **Chat allowlist.** `ADVISOR_TELEGRAM_ALLOWED_CHATS` — Clayton's and
   Antonio's numeric chat ids. Anyone else who finds the bot gets silence, and
   the attempt is logged. Non-negotiable: a bot username is guessable, and this
   bot can write to the shop's records.
2. **Everything is attributed.** Every call passes
   `actor="ai:telegram:clayton"`, which flows into the existing
   `activity_events` / `order_notes` / audit trails. The ticket's Activity tab
   will say an AI did it and which human asked.
3. **`ai_actions` is the audit log** — prompt, transcript, tool calls, resulting
   row ids, and the message that triggered it. Modelled directly on
   `invoice_audits`, which is already the right shape for this.
4. **Money is never invented.** The system prompt states the cost rule from
   CLAUDE.md explicitly: recon and we-owe are billed at cost, no markup, labor
   is zero. If a price isn't in the message or on an invoice, the tool call is
   made without one and the bot says so.
5. **Spend cap on the OpenAI key**, plus a local per-day call ceiling that stops
   the loop and notifies rather than burning credit.
6. **Max 5 tool-call rounds per message.** Then it stops and reports. No
   unbounded agent loops against a live shop database.
7. **`/undo`** reverses the last applied `ai_actions` row where the operation is
   reversible, and says so plainly when it isn't.

---

## 5. Codebase-specific hazards

These are the things that will bite during implementation. Each is real and
each is in the current code.

### 5.1 `POST /api/orders/{id}/estimate` replaces the entire line set

`save_estimate` deletes every non-received line not present in the payload. If
the AI ever builds that payload from what it "remembers" about a ticket, it will
silently delete Clayton's work.

**The AI must never call that endpoint.** Add parts through
`POST /api/orders/{id}/findings` instead, which *appends* lines and recomputes
totals — exactly the semantics needed — and already marks them
`review_required=1`.

### 5.2 …but `findings` requires a part number on every part line

`add_findings` raises 422 on `kind='part'` with an empty `part_number`
("Every proposed part requires a traceable part number"). A dictated note rarely
has one.

That rule is deliberate, so **don't weaken it**. Two honest options: the bot
asks for the part number, or — better for a junkyard-parts shop where the number
often doesn't exist until the part is in hand — the work goes in as a **job**
(`POST /api/orders/{id}/jobs`, no part number required) and the part line
appears when the invoice is received. Recommend the second as the default and
the first only when Clayton dictates a number.

### 5.3 `review_required` on an estimate line is invisible and self-clearing

Grep says `review_required` is only rendered on the Accounting screen for AP
audits. On estimate lines it displays as nothing — and worse, opening the ticket
lets the grid's autosave `POST` the estimate, which sets `review_required=0` on
every row. So it cannot be the record that a line came from the AI.

Two small pieces of work: render a marker on flagged lines in the ticket grid,
and rely on `estimate_items.source` (which `save_estimate` preserves on existing
rows) as the durable provenance.

### 5.4 Adding `source='ai'` needs the Pydantic Literal widened too

`EstimateItem.source` is `Literal["manual", "technician_finding"]`. The grid
resends every row it displays on each autosave, so a line written with a source
outside that list makes the whole estimate unsaveable with a 422 naming a field
Clayton never touched — the exact bug the `"credit"` comment in `main.py`
documents. If you add an `ai` source, widen the Literal in the same commit.

### 5.5 Optimistic locking

`recon_vehicles`, `we_owe_items` and `estimates` carry `edit_version`, and the
guard is in the `WHERE` clause. Every AI write must read the current version and
pass `expected_version`. On a 409 the bot re-reads and re-proposes rather than
retrying blind — Antonio may have been editing the same car.

### 5.6 Photos are not covered by backups

`backup_database` copies the SQLite file and nothing else. Photos stored on disk
would not survive a restore onto a fresh install.

Decision to make: store photos on disk under `data_root/attachments/` and accept
that they're not backed up, or store the ones that matter (VIN plates, invoices)
as BLOBs so they ride along in the `.db`. **Recommend disk + a separate
attachments sync in `usb_backup`** — invoice photos will add up fast and bloating
the database hurts every backup, every restore, and every WAL checkpoint.

### 5.7 Telegram compresses photos

A VIN plate sent as a normal photo can lose the characters you need. Take the
largest available `photo` size, and tell Clayton to send VIN plates and invoices
as **files/documents** when the read fails. Worth putting in the bot's `/help`.

### 5.8 Media groups arrive as separate updates

Several photos sent together arrive as N updates sharing a `media_group_id`.
Buffer for ~2 seconds and process them as one message, or a four-page invoice
becomes four half-read invoices.

### 5.9 Update de-duplication

Telegram redelivers everything after the last acknowledged `offset`. Persist the
last processed `update_id` in SQLite and drop anything at or below it — a crash
mid-processing must not create the same ticket twice on restart.

---

## 6. New code

```
app/advisor/
  __init__.py
  config.py       # env/config load, allowlist, model ids, spend ceiling
  telegram.py     # getUpdates loop, send, inline keyboards, file download
  openai_client.py# responses + tool-calling + transcription, over httpx
  tools.py        # tool schemas + dispatch to the local API
  plans.py        # propose → store → confirm → apply → undo
  vin.py          # check-digit validation, normalisation
  agent_routes.py # /api/agent/search, /api/agent/attachments
```

Everything else is additive:

- `app/tray_app.py` — start the advisor thread alongside the existing
  auto-backup and update-check threads (same `threading.Thread(..., daemon=True)`
  pattern already used twice); tray menu entry to enable/disable and show status.
- `app/db.py` — new tables in `SCHEMA` plus idempotent `_migrate` steps, per the
  per-column guard convention already documented there.
- `app/main.py` — mount the agent router.
- `pyproject.toml` — no new runtime dependencies if you go the `httpx` route.

### Schema additions

```sql
CREATE TABLE IF NOT EXISTS ai_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,             -- 'telegram'
  chat_id TEXT NOT NULL,
  requester TEXT NOT NULL,           -- 'clayton'
  request_text TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '{}',  -- model turns + tool calls, JSON
  plan TEXT NOT NULL DEFAULT '[]',        -- resolved calls awaiting confirm
  status TEXT NOT NULL,              -- proposed|applied|cancelled|expired|failed
  result TEXT NOT NULL DEFAULT '{}', -- created ids, for /undo
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  kind TEXT NOT NULL,                -- vin_plate|invoice|damage|other
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',   -- 'telegram:<file_id>'
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advisor_state (
  key TEXT PRIMARY KEY,              -- 'telegram_offset', 'chat:<id>:context'
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`advisor_state` also carries the per-chat conversation context — the last few
turns plus a pinned "active vehicle / active ticket", so `"add a tie rod to
that"` resolves. In SQLite rather than memory so it survives a restart, expiring
after a couple of hours or on `/done`.

### Configuration

Environment variables, read at startup (same pattern as
`API_DISCOUNT_AUTO_OPS_KEY` and `PLATETOVIN_API_KEY`):

| Variable | Purpose |
|---|---|
| `ADVISOR_ENABLED` | master switch, default off |
| `ADVISOR_TELEGRAM_TOKEN` | from BotFather |
| `ADVISOR_TELEGRAM_ALLOWED_CHATS` | comma-separated numeric chat ids |
| `OPENAI_API_KEY` | platform key, **not** the subscription |
| `ADVISOR_MODEL` | tool-calling + vision model |
| `ADVISOR_EXTRACT_MODEL` | cheaper model for OCR/extraction |
| `ADVISOR_TRANSCRIBE_MODEL` | voice notes |
| `ADVISOR_DAILY_CALL_LIMIT` | local circuit breaker |

Keep model ids in config, never inline. Pin the exact current ids from
`platform.openai.com/docs/models` when you set it up — a small multimodal model
for extraction and a stronger one for the planning loop. `gpt-4o-mini` /
`gpt-4o` are a known-good conservative baseline; newer and cheaper tiers are
likely available now, and being config means switching costs nothing.

---

## 7. Build order

Each phase is independently useful and independently shippable. Estimates assume
focused days, not calendar days.

| Phase | Scope | Effort |
|---|---|---|
| **0. Groundwork** | `ai_actions` / `attachments` / `advisor_state` tables, `GET /api/agent/search`, config module, extend `_check_auth` across agent routes | 1 day |
| **1. Read-only bot** | Telegram loop, allowlist, offset persistence, tool dispatch, the seven read tools | 1 day |
| **2. Photos → vehicles** | Image download, VIN OCR, check-digit validation, decode, intake with confirm | 1 day |
| **3. Ticket writes** | Plan/confirm/apply/undo, create ticket, jobs, notes, tasks, status | 1.5 days |
| **4. Invoices** | Photo → `InvoiceIn` → existing `/agent/invoices/process`; review queue already renders | 0.5 day |
| **5. Voice** | Transcription, straight into the phase-3 loop | 0.5 day |
| **6. Polish** | Tray toggle + status, `/help`, `review_required` marker in the ticket grid, attachments in USB backup | 1 day |

**Stop after phase 1 and use it for a week** before building writes. Read-only
Q&A over Telegram will tell you more about whether the model handles shop
vocabulary — stock numbers, "we-owe", part names as Clayton says them — than any
amount of up-front design. If it can't reliably answer "what's open on R-1042",
it has no business writing tickets.

### Testing

The existing bar is pytest + jsdom smoke tests, with `ruff` and `pyright` clean.
Hold the new code to it:

- **Nothing in the test suite touches the network.** Inject the OpenAI and
  Telegram transports; record real responses once as JSON fixtures and replay.
- **Test the plan layer without a model at all** — a stored plan is just JSON,
  so `plan → apply → verify rows → undo → verify rollback` needs no AI.
- VIN check-digit tests with real VINs and deliberately corrupted ones.
- A test that the AI's write path never calls `POST /api/orders/{id}/estimate`
  (assert on the tool registry) — the §5.1 hazard is severe enough to deserve a
  guard that fails loudly.
- Update de-dup: replay the same `update_id` twice, assert one ticket.

---

## 8. Decisions for you

1. **Tier B auto-apply** — is "add a note / create a task / tick a job done
   without asking" right, or do you want a tap on everything? I've assumed
   auto-apply plus `/undo` because sixty confirmations defeats the point of a
   catch-up day, but it's your records.
2. **Antonio** — same access as you, read-only, or not on the allowlist at all?
3. **Photo retention** — do invoice photos stay forever (they're your paper
   trail) or age out after N months? Affects §5.6.
4. **Telegram specifically** — it's the right pick for this (real file upload,
   voice notes, inline buttons, works on any phone, no per-message cost). Worth
   confirming you're not tied to something else the shop already uses.
5. **Retail tickets** — CLAUDE.md is clear that Tekmetric is the retail system
   of record. I've assumed the bot writes recon and we-owe only, and refuses
   retail with an explanation. Say if that's wrong.
