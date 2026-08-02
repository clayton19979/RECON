---
name: recon-status
description: "Answer questions about the shop from RECON: what is open, which cars are ready, what a car still needs, what we spent on it, what parts we are waiting on. Use whenever Clayton or Walt asks about the state of the lot, a specific car, or outstanding work."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [RECON, shop, reporting, status]
    related_skills: [recon-ticket-lines, recon-vin-intake]
prerequisites:
  mcp_servers: [recon]
---

# Answering questions about the shop

**Always answer from RECON, never from memory of an earlier message.** The tools
are cheap and the record is authoritative. A number you remember from an hour
ago may already be wrong.

## Walt's four questions

These are why RECON exists. Be able to answer any of them instantly:

1. **Which cars are ready** — `recon_board`, look at status.
2. **Which cars are being worked on** — `recon_board`.
3. **What each remaining car still needs** — `recon_board` gives open jobs and
   parts pending per car; `recon_get_ticket` for the detail on one.
4. **How much we spent on each vehicle** — `recon_board` carries cost per unit;
   `recon_get_vehicle` for the full rollup on one car.

## The tools

- `recon_board(segment=None)` — the whole lot. Filter to `recon` or `we_owe`.
- `recon_get_ticket(order_id)` — one RO, chat-sized: jobs with done state, parts
  with status and cost, total.
- `recon_get_vehicle(kind, id)` — full detail and cost rollup for one car.
- `recon_parts_on_order()` — "what are we waiting on".
- `recon_dashboard()` — open counts and totals across the shop.
- `recon_tasks()` — outstanding reminders.

## How to answer

Clayton is on a phone, usually mid-task, often with dirty hands.

- **Lead with the answer.** "R-1042: two jobs open — front brakes, tie rod."
  No preamble, no restating the question.
- **Short.** A few lines. No tables, no headers.
- **Real numbers, not approximations.** If the total is $468.44, say $468.44.
- **Say when you don't know.** If the record doesn't answer it, say what the
  record does say and what's missing.

## Money rules that shape the answer

Recon and we-owe are billed at the shop's **cost** — no markup, labor at zero.
A ticket's total is what the parts cost.

**What the lot paid for a car is not tracked here** and profit is deliberately
left empty. If asked about profit on a car, say the app tracks what was spent
fixing it, and Walt keeps the purchase price himself. Don't compute a margin
from a sale price against an absent purchase price.
