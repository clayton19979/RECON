from __future__ import annotations

import sqlite3
from typing import Annotated, Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .accounting import InvoiceItemIn, create_ap_invoice_record
from .recon import assert_vehicle_editable
from .workflow import assert_estimate_editable, record_activity

PART_STATUSES = {"quoted", "ordered", "received"}


class ItemStatusIn(BaseModel):
    status: Literal["quoted", "ordered"]


class ReceivePartsIn(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=300)
    vendor_id: int
    invoice_number: str = Field(min_length=1)
    tax: float = Field(default=0, ge=0)
    actor: str = "ui"
    cost_overrides: dict[int, Annotated[float, Field(ge=0)]] = {}


def build_parts_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def order_row(db: sqlite3.Connection, order_id: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Repair order not found")
        return row

    def estimate_for_order(db: sqlite3.Connection, order_id: int) -> sqlite3.Row:
        estimate = db.execute("SELECT id FROM estimates WHERE order_id=?", (order_id,)).fetchone()
        if not estimate:
            raise HTTPException(404, "No estimate on this repair order")
        return estimate

    @router.patch("/orders/{order_id}/estimate/order-parts")
    def order_parts(order_id: int):
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            assert_estimate_editable(db, order_id)
            estimate = estimate_for_order(db, order_id)
            cur = db.execute(
                "UPDATE estimate_items SET status='ordered' WHERE estimate_id=? AND kind='part' AND status='quoted'",
                (estimate["id"],),
            )
            return {"updated": cur.rowcount}

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/status")
    def set_item_status(order_id: int, item_id: int, item: ItemStatusIn):
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            assert_estimate_editable(db, order_id)
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, kind FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            # Parts are only ever marked received through /estimate/receive-parts,
            # which posts a real A/P record -- this endpoint no longer accepts
            # "received" for a part line so there's exactly one receiving path.
            db.execute("UPDATE estimate_items SET status=? WHERE id=?", (item.status, item_id))
        return {"id": item_id, "status": item.status}

    @router.post("/orders/{order_id}/estimate/receive-parts")
    def receive_parts(order_id: int, item: ReceivePartsIn):
        with connect() as db:
            current_order = order_row(db, order_id)
            assert_vehicle_editable(db, current_order)
            assert_estimate_editable(db, order_id)
            if not db.execute("SELECT 1 FROM vendors WHERE id=?", (item.vendor_id,)).fetchone():
                raise HTTPException(404, "Vendor not found")
            estimate = estimate_for_order(db, order_id)

            unique_ids = list(dict.fromkeys(item.item_ids))
            placeholders = ",".join("?" for _ in unique_ids)
            rows = db.execute(
                f"SELECT * FROM estimate_items WHERE id IN ({placeholders}) AND estimate_id=? AND kind='part'",
                (*unique_ids, estimate["id"]),
            ).fetchall()
            if len(rows) != len(unique_ids):
                raise HTTPException(404, "One or more selected parts were not found on this repair order")

            invoice_items: list[InvoiceItemIn] = []
            remaining_by_id: dict[int, tuple[float, float]] = {}
            for row in rows:
                remaining = float(row["quantity"]) - float(row["received_quantity"])
                if remaining <= 0.001:
                    raise HTTPException(409, f"'{row['description']}' has already been fully received")
                unit_cost = item.cost_overrides.get(row["id"], row["unit_cost"])
                remaining_by_id[row["id"]] = (remaining, unit_cost)
                invoice_items.append(InvoiceItemIn(
                    part_number=row["part_number"] or "N/A",
                    description=row["description"],
                    quantity=remaining,
                    unit_cost=unit_cost,
                    kind="part",
                ))

            subtotal = round(sum(i.quantity * i.unit_cost for i in invoice_items), 2)
            total = round(subtotal + item.tax, 2)

            result = create_ap_invoice_record(
                db, now_fn,
                vendor_id=item.vendor_id, order_id=order_id,
                invoice_number=item.invoice_number, po_number=current_order["number"],
                items=invoice_items, subtotal=subtotal, tax=item.tax, total=total,
                source="ticket_receive",
            )
            if result["status"] == "duplicate":
                raise HTTPException(409, "This vendor invoice number is already posted for this vendor")

            for row in rows:
                remaining, unit_cost = remaining_by_id[row["id"]]
                db.execute(
                    "UPDATE estimate_items SET received_quantity=received_quantity+?,unit_cost=?,status='received',received_invoice_number=? WHERE id=?",
                    (remaining, unit_cost, item.invoice_number.strip(), row["id"]),
                )

            # Same subtotal/tax/total recompute accounting.py's agent-invoice
            # path already does -- driven by line_total (set from unit_price
            # at quote time, this being an at-cost shop where price==cost),
            # not by the just-received unit_cost.
            totals = db.execute(
                "SELECT coalesce(sum(line_total),0),coalesce(sum(CASE WHEN kind='part' THEN line_total ELSE 0 END),0) FROM estimate_items WHERE estimate_id=?",
                (estimate["id"],),
            ).fetchone()
            estimate_row = db.execute("SELECT tax_rate FROM estimates WHERE id=?", (estimate["id"],)).fetchone()
            estimate_subtotal = round(totals[0], 2)
            estimate_tax = round(totals[1] * float(estimate_row["tax_rate"]), 2)
            db.execute(
                "UPDATE estimates SET subtotal=?,tax=?,total=? WHERE id=?",
                (estimate_subtotal, estimate_tax, round(estimate_subtotal + estimate_tax, 2), estimate["id"]),
            )
            record_activity(
                db, order_id, "parts_received", item.actor,
                {"invoice_number": item.invoice_number.strip(), "vendor_id": item.vendor_id, "item_ids": unique_ids},
                now_fn,
            )
            return {"ap_invoice_id": result["ap_invoice_id"], "received_items": len(rows)}

    return router
