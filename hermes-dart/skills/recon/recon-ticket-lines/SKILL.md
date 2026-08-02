---
name: recon-ticket-lines
description: "Add work, parts, and labor lines to an existing repair order in RECON, tick jobs off, mark parts ordered, and close tickets. Use when Clayton describes work on a car already on the board, reads off parts, says a repair is done, or says a car is finished."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [RECON, shop, repair-orders, parts, estimates]
    related_skills: [recon-vin-intake, recon-parts-invoice, recon-status]
prerequisites:
  mcp_servers: [recon]
---

# Writing work onto a ticket

## Find the car first

`recon_search` takes anything Clayton says: a stock number, a VIN or its last
six, a plate, a customer name, "the silver Malibu". It returns candidates with
`order_id` already on them.

**If more than one plausibly matches, ask which.** Never pick. Two of Walt's
cars being the same year and model is routine.

If the car has no open ticket, `recon_create_ticket` with the concern in
Clayton's own words.

## Jobs vs lines — this distinction matters

**A job is a repair**: "Front brakes", "Left outer tie rod", "Windshield". Use
`recon_add_jobs`. This is the default for dictated work, and usually the only
thing you should write.

**A line is money**: a part with a cost, a fee. Use `recon_add_lines`. Only
write one when Clayton gives you an actual number, or when posting an invoice.

Most of the time the honest record is a job with no line. The cost lands later,
when the vendor's invoice is received. **Never invent a price to make a line
look complete.**

## `recon_add_lines` is additive and safe

It appends. It cannot delete or overwrite lines already on the ticket, so you
can call it without knowing everything that's there.

Each line: `{"kind": "part"|"labor"|"fee", "description": str, "quantity":
float, "unit_cost": float, "unit_price": float, "part_number": str,
"job_id": int|null}`

- **A part with no part number is normal here.** This shop runs on used and
  junkyard parts; the number often doesn't exist until the part is in hand.
  Leave it blank rather than inventing one.
- **Labor is zero** on recon and we-owe. Not "usually" — always.
- Link a line to a job with `job_id` when Clayton makes the connection.

## The other actions

- `recon_complete_job(order_id, job_id, done=True)` — a repair is finished.
  Get the job id from `recon_get_ticket`.
- `recon_order_parts(order_id)` — everything quoted on the ticket is now on
  order. Stamps the date, which is what makes "how long have we been waiting"
  answerable. Safe to re-run.
- `recon_set_status(order_id, "complete")` — the car is done.
- `recon_add_note(order_id, text)` — anything worth remembering that isn't a
  job or a cost. Describe what you were told; don't diagnose into the record as
  fact.

## When something goes wrong

**409** means Antonio changed the record while you were working. Re-read it,
tell Clayton what changed, re-propose. Never retry blind.

**`recon_add_jobs` reporting `failed`** — some jobs were created and some
weren't. Retry **only** the failed titles. Re-sending the whole list duplicates
the ones that already landed.

**422** means something required is missing. Read the message and ask for it.
Don't work around the rule; those rules are deliberate.
