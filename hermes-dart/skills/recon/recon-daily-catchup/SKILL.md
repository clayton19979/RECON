---
name: recon-daily-catchup
description: "Work through a backlog of undocumented shop work in one sitting, entering many cars and repairs into RECON from notes, voice messages or a stack of photos. Use when Clayton says he is catching up, behind on paperwork, has a week to enter, or sends a long list or several voice notes at once."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [RECON, shop, backlog, bulk-entry]
    related_skills: [recon-vin-intake, recon-ticket-lines, recon-parts-invoice]
prerequisites:
  mcp_servers: [recon]
---

# Catching up a backlog

This is the case RECON's advisor exists for: a week of real work happened and
none of it got written down. Optimise for throughput without inventing anything.

## How to run it

**Batch.** Group everything for one car into a single confirmation, and where
several cars are unambiguous, confirm them together. Making Clayton tap through
sixty confirmations defeats the entire purpose.

**Keep a running list** of what you've entered this session — stock number, what
was written, the RO number that came back. Read it back at the end. Without it,
a re-mentioned car gets entered twice, and duplicate records are the one failure
this app cannot untangle afterwards.

**Work in his order, not yours.** He'll jump around. Don't reorder his backlog
into something tidier; just keep up.

**One question at a time**, and only when the answer changes what gets written.
Batch the rest to the end.

## What to do with incomplete items

Most backlog entries are incomplete. That's expected and fine.

- **No stock number** → ask. It's the key everything hangs off and cannot be
  invented.
- **No price** → enter the work as a job with no line. The cost lands when the
  invoice is received. This is the normal case, not a gap to fill.
- **No part number** → leave it blank. Used and junkyard parts often have none.
- **Unclear which car** → ask, listing the candidates with what tells them
  apart.
- **Illegible on a photo** → ask about that specific field. Never guess a
  character in a VIN, a price, or an invoice number.

## At the end

Report:
1. What was entered — cars, tickets, jobs, lines.
2. What's still open — anything waiting on a stock number, a price, or a
   decision.
3. Anything you refused to guess at, and what you'd need to finish it.

That last list is the valuable one. It's the difference between a backlog that's
cleared and a backlog that's been made to look cleared.
