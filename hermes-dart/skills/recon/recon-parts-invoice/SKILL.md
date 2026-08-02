---
name: recon-parts-invoice
description: "Post a vendor parts invoice into RECON from a photo or dictated details. Use when Clayton sends a picture of a parts receipt, an invoice from O'Reilly, AutoZone, a junkyard or any supplier, or reads off invoice numbers and line items."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [RECON, shop, accounting, invoices, parts]
    related_skills: [recon-ticket-lines, recon-status]
prerequisites:
  mcp_servers: [recon]
---

# Posting a vendor invoice

RECON does the hard part. `recon_post_vendor_invoice` already handles fuzzy
vendor matching, PO-to-ticket resolution, duplicate detection, arithmetic
checks, and over-receipt checks, and it writes an audit row the Accounting
screen renders. Your job is only to turn the paper into structured data.

## Extract

```json
{
  "vendor_name": "O'Reilly Auto Parts",
  "invoice_number": "1234-567890",
  "po_number": "R-1042",
  "order_id": null,
  "subtotal": 128.44,
  "tax": 8.99,
  "total": 137.43,
  "items": [
    {"part_number": "BRK-1234", "description": "Front rotors",
     "quantity": 2, "unit_cost": 41.50, "kind": "part"}
  ]
}
```

`kind` is one of `part`, `credit`, `freight`, `core_charge`, `shop_supplies`,
`labor`.

**`po_number` is often the stock number** — shops give vendors the number that's
on the car. RECON matches either an RO number or a stock number, so pass what
the paper says.

**Set `order_id` only when you're certain which ticket it belongs to.** Leaving
it null is correct for shop supplies, bulk oil, tools — real bills with no
ticket behind them. They post as money owed without rolling into any car's cost.

## Read carefully

**Transcribe, don't compute.** Take subtotal, tax and total off the paper as
printed. RECON checks the arithmetic itself, and that check only means something
if you didn't do the sum for it.

**Say when the paper doesn't add up.** Vendors make mistakes, and catching one
is worth real money. Report it; don't quietly correct it.

**A credit line is negative money** — a returned part, a refunded core. Mark it
`kind: "credit"` with a positive quantity and cost, the way it reads on the
vendor's own paperwork. RECON applies the sign.

## What comes back

- **`posted`** — done. Say the invoice number and which car, if any.
- **`duplicate`** — already posted. Don't retry, don't change the number to get
  around it. Tell Clayton.
- **`review_required`** — RECON held it and told you exactly which check failed.
  Relay that specific reason. Do not retry with adjusted numbers to get it
  through; the hold is the point.

If the photo is unreadable in a spot, ask about that specific field rather than
guessing. A wrong invoice total is real money wrong in the shop's books.
