from __future__ import annotations

import sqlite3
from typing import Annotated, Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .accounting import InvoiceItemIn, create_ap_invoice_record
from .recon import assert_vehicle_editable
from .workflow import assert_estimate_editable, get_or_create_estimate, record_activity

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


class CoreReturnIn(BaseModel):
    returned: bool = True
    actor: str = "ui"


class MoveItemIn(BaseModel):
    target_order_id: int
    actor: str = "ui"


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

    def recompute_estimate_totals(db: sqlite3.Connection, estimate_id: int) -> None:
        """Rebuilds subtotal/tax/total from the estimate_items rows currently
        on this estimate -- shared by every path that edits estimate_items
        directly rather than through save_estimate (receiving parts, moving a
        misreceived line to a different ticket). Tax only applies to parts,
        matching the at-cost-only-parts-are-taxed rule used everywhere else."""
        totals = db.execute(
            "SELECT coalesce(sum(line_total),0),coalesce(sum(CASE WHEN kind='part' THEN line_total ELSE 0 END),0) FROM estimate_items WHERE estimate_id=?",
            (estimate_id,),
        ).fetchone()
        estimate_row = db.execute("SELECT tax_rate FROM estimates WHERE id=?", (estimate_id,)).fetchone()
        subtotal = round(totals[0], 2)
        tax = round(totals[1] * float(estimate_row["tax_rate"]), 2)
        db.execute(
            "UPDATE estimates SET subtotal=?,tax=?,total=? WHERE id=?",
            (subtotal, tax, round(subtotal + tax, 2), estimate_id),
        )

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

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/move")
    def move_item(order_id: int, item_id: int, item: MoveItemIn):
        """Corrects a part (often already received) logged against the wrong
        repair order -- moves the line itself, quantity/cost/received state
        and all, onto a different ticket's estimate. The vendor A/P invoice
        that was posted when it was received is left exactly where it is (an
        A/P invoice can cover several lines at once and has no link back to
        which specific one this was, same reason void_ap_invoice doesn't
        reverse receiving) -- it's just the historical record of what was
        ordered from the vendor and under which PO, whereas this line's
        estimate_id is what actually drives which vehicle's cost this part
        counts against, so moving that is what fixes the vehicle's numbers."""
        if item.target_order_id == order_id:
            raise HTTPException(400, "That is already this repair order")
        with connect() as db:
            source_order = order_row(db, order_id)
            assert_vehicle_editable(db, source_order)
            assert_estimate_editable(db, order_id)
            target_order = order_row(db, item.target_order_id)
            assert_vehicle_editable(db, target_order)
            assert_estimate_editable(db, item.target_order_id)

            source_estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, source_estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")

            target_estimate = get_or_create_estimate(db, item.target_order_id, now_fn)
            next_sort = db.execute(
                "SELECT coalesce(max(sort_order),0)+1 FROM estimate_items WHERE estimate_id=?", (target_estimate["id"],)
            ).fetchone()[0]
            # job_id would otherwise point at a job that belongs to the OLD
            # estimate -- cleared so the moved line lands as a plain General
            # line on the new ticket rather than a dangling foreign key.
            db.execute(
                "UPDATE estimate_items SET estimate_id=?,job_id=NULL,sort_order=? WHERE id=?",
                (target_estimate["id"], next_sort, item_id),
            )
            recompute_estimate_totals(db, source_estimate["id"])
            recompute_estimate_totals(db, target_estimate["id"])
            record_activity(db, order_id, "estimate_item_moved_out", item.actor, {"item_id": item_id, "target_order_id": item.target_order_id}, now_fn)
            record_activity(db, item.target_order_id, "estimate_item_moved_in", item.actor, {"item_id": item_id, "source_order_id": order_id}, now_fn)
        return {"id": item_id, "moved_to_order_id": item.target_order_id}

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/core-return")
    def set_core_return(order_id: int, item_id: int, item: CoreReturnIn):
        """Marks a part's core deposit as returned to the vendor (or undoes
        that). Deliberately does not call assert_estimate_editable -- cores
        are typically taken back to the vendor for refund well after the
        ticket's estimate is invoiced and locked, so that lock shouldn't
        block this action. Voided/archived orders are still blocked via
        assert_vehicle_editable since there's nothing left to reconcile."""
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, core_charge FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if float(row["core_charge"]) <= 0:
                raise HTTPException(400, "This line has no core charge to return")
            db.execute(
                "UPDATE estimate_items SET core_returned=?,core_returned_at=? WHERE id=?",
                (1 if item.returned else 0, now_fn() if item.returned else "", item_id),
            )
            record_activity(
                db, order_id, "core_returned" if item.returned else "core_return_undone", item.actor,
                {"item_id": item_id}, now_fn,
            )
        return {"id": item_id, "core_returned": item.returned}

    @router.get("/cores")
    def list_cores():
        with connect() as db:
            rows = db.execute(
                """SELECT ei.id, ei.description, ei.part_number, ei.core_charge,
                       ei.core_returned, ei.core_returned_at,
                       o.id order_id, o.number ro_number, o.voided, o.segment,
                       o.recon_vehicle_id, o.we_owe_id,
                       rv.stock_number, wc.name we_owe_customer_name
                   FROM estimate_items ei
                   JOIN estimates e ON e.id=ei.estimate_id
                   JOIN orders o ON o.id=e.order_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   WHERE ei.core_charge > 0
                   ORDER BY ei.core_returned ASC, ei.id DESC""",
            )
            result = []
            for row in rows:
                value = dict(row)
                if value["stock_number"]:
                    value["vehicle_label"] = value["stock_number"]
                elif value["we_owe_customer_name"]:
                    value["vehicle_label"] = f"We-Owe: {value['we_owe_customer_name']}"
                else:
                    value["vehicle_label"] = "Retail"
                result.append(value)
            return result

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

            recompute_estimate_totals(db, estimate["id"])
            record_activity(
                db, order_id, "parts_received", item.actor,
                {"invoice_number": item.invoice_number.strip(), "vendor_id": item.vendor_id, "item_ids": unique_ids},
                now_fn,
            )
            return {"ap_invoice_id": result["ap_invoice_id"], "received_items": len(rows)}

    return router
