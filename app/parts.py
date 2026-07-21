from __future__ import annotations

import sqlite3
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

PART_STATUSES = {"quoted", "ordered", "received"}


class ItemStatusIn(BaseModel):
    status: Literal["quoted", "ordered", "received"]
    invoice_number: str = ""


def build_parts_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def estimate_for_order(db: sqlite3.Connection, order_id: int) -> sqlite3.Row:
        estimate = db.execute("SELECT id FROM estimates WHERE order_id=?", (order_id,)).fetchone()
        if not estimate:
            raise HTTPException(404, "No estimate on this repair order")
        return estimate

    @router.patch("/orders/{order_id}/estimate/order-parts")
    def order_parts(order_id: int):
        with connect() as db:
            estimate = estimate_for_order(db, order_id)
            cur = db.execute(
                "UPDATE estimate_items SET status='ordered' WHERE estimate_id=? AND kind='part' AND status='quoted'",
                (estimate["id"],),
            )
            return {"updated": cur.rowcount}

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/status")
    def set_item_status(order_id: int, item_id: int, item: ItemStatusIn):
        if item.status == "received" and not item.invoice_number.strip():
            raise HTTPException(422, "An invoice number is required to mark a part received, for proper tracking")
        with connect() as db:
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, quantity, kind FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            # Marking a part received here (a cash-and-carry parts-store run with
            # no formal vendor invoice) must actually count toward actual cost --
            # otherwise the status label lies about what's really been spent.
            # Stepping back off "received" clears it so cost doesn't stay stale.
            if row["kind"] == "part":
                received_quantity = row["quantity"] if item.status == "received" else 0
                invoice_number = item.invoice_number.strip() if item.status == "received" else ""
                db.execute(
                    "UPDATE estimate_items SET status=?,received_quantity=?,received_invoice_number=? WHERE id=?",
                    (item.status, received_quantity, invoice_number, item_id),
                )
            else:
                db.execute("UPDATE estimate_items SET status=? WHERE id=?", (item.status, item_id))
        return {"id": item_id, "status": item.status, "invoice_number": item.invoice_number.strip()}

    return router
