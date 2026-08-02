---
name: recon-vin-intake
description: "Put a new lot car into RECON from a VIN photo, a typed VIN, or a plate. Use when Clayton says new car, just got one in, sends a photo of a VIN plate or door jamb sticker, or gives a stock number for a car not on the board yet."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [RECON, shop, intake, VIN, vehicles]
    related_skills: [recon-ticket-lines, recon-status]
prerequisites:
  mcp_servers: [recon]
---

# New car into RECON

The single most common thing Clayton needs: a car showed up on the lot, get it
on the board with whatever work he described.

## The call

Use **`recon_intake`**. It creates the vehicle, the repair order and the jobs in
one transaction. Do not assemble this from `recon_create_recon_vehicle` +
`recon_create_ticket` + `recon_add_jobs` — three calls can fail halfway and
leave a car with no ticket that nobody is looking for.

## Steps

1. **Read the VIN** off the photo, or take it as typed.
2. **`recon_decode_vin`** — it returns year, make, model, trim, engine.
   **Never fill those in yourself.** The decoder is the authority; you are not.
   If it refuses the VIN for a check digit, you misread a character (see below).
3. **`recon_lookup_vehicle`** with the stock number and VIN.
   - A **live** match means the car is already on the board. Stop, and say
     which one it is.
   - An **archived** VIN match is fine and normal. Walt buys cars back; a
     second recon episode on one VIN is expected. Carry on.
4. **Confirm with Clayton** before writing — show the VIN, the decoded car, the
   stock number, and the jobs you're about to create.
5. **`recon_intake`**.

## Judgment

**A failed check digit means you misread it, not that the VIN is bad.** Say so,
and ask for a re-send **as a file, not a photo** — Telegram's compression is
usually what ate the character. Never retry the same read hoping it passes.

**Always show the VIN back.** Clayton spots a wrong character faster than any
check can.

**The stock number is required and you must not invent one.** It's on the
windshield or the lot sheet. If you don't have it, ask. A made-up stock number
is worse than no record — it silently becomes the key everything else hangs off.

**No prices.** Recon is billed at the shop's cost with no markup and labor at
zero. Costs arrive with the vendor invoice. If Clayton dictates work, it goes in
as jobs, not as priced lines.

**A car with no work yet is a real state.** Omit `concern` and you get the car
on the board with no ticket. Don't invent a concern to force a ticket into
existence.

**Work described in the same message goes in the same call** — pass it as
`jobs`. One confirmation, not three.

## Plates

If Clayton sends a plate instead of a VIN, use `recon_decode_plate`. It needs a
paid provider key that may not be configured; if it tells you so, relay that and
ask for a VIN photo instead. Don't guess a vehicle from a plate.
