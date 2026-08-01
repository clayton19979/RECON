from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .accounting import InvoiceItemIn, create_ap_invoice_record, receive_onto_invoice
from .recon import age_days, assert_vehicle_editable
from .workflow import assert_estimate_editable, get_or_create_estimate, record_activity

PART_STATUSES = {"quoted", "ordered", "received"}


class ItemStatusIn(BaseModel):
    status: Literal["quoted", "ordered"]
    actor: str = "ui"


class OrderPartsIn(BaseModel):
    actor: str = "ui"


class ReceivePartsIn(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=300)
    vendor_id: int
    invoice_number: str = Field(min_length=1)
    tax: float = Field(default=0, ge=0)
    actor: str = "ui"
    cost_overrides: dict[int, Annotated[float, Field(ge=0)]] = {}


class CoreReturnIn(BaseModel):
    # No invoice number here: the core physically goes back to the vendor
    # first, and the credit/invoice paperwork arrives later -- that number is
    # captured by the separate core-credit step.
    returned: bool = True
    actor: str = "ui"


class CoreCreditIn(BaseModel):
    # The vendor's credit/invoice number, received after they've taken the
    # core back. Recording it is what moves the core into Credited.
    invoice_number: str = Field(min_length=1)
    actor: str = "ui"


class PartReturnIn(BaseModel):
    # Same shape as CoreReturnIn: parts go back first, the credit invoice
    # comes later and is captured by post-return-credit.
    returned: bool = True
    actor: str = "ui"


class PartPickupIn(BaseModel):
    # Whether the vendor has physically collected the returned part. False
    # puts it back on the shelf ("I still have this").
    picked_up: bool = True
    actor: str = "ui"


class PostReturnCreditIn(BaseModel):
    vendor_id: int
    credit_number: str = Field(min_length=1)
    actor: str = "ui"


class MoveItemIn(BaseModel):
    target_order_id: int
    reassign_invoice: bool = False
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

    def label_vehicle(value: dict) -> str:
        """What to call the car a part line belongs to, in one place.

        Recon cars go by stock number, we-owe and retail work by whose car it
        is. The three cross-ticket part lists (cores, returns, on order) all
        print this same string, and three copies of the rule is three chances
        for one screen to name a car differently from the one beside it.
        """
        if value["stock_number"]:
            return value["stock_number"]
        if value["we_owe_customer_name"]:
            return f"We-Owe: {value['we_owe_customer_name']}"
        if value["order_customer_name"]:
            return f"Retail: {value['order_customer_name']}"
        return "Retail"

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
    def order_parts(order_id: int, item: OrderPartsIn = OrderPartsIn()):
        """Flag every quoted part on this ticket as ordered.

        Stamping ordered_at is what makes "how long have we been waiting on
        this?" answerable at all -- see /parts/on-order. It is set only on the
        rows this call actually moves, so re-running it can't reset the clock
        on a part that was already on order.

        Logging it is the other half, and it is a fix rather than a flourish.
        Ordering parts was one of only two mutating routes that never reached
        touch_order, so the single most common thing anyone does to a waiting
        car did not count as work on it: the board's Idle column kept climbing,
        the Stalled card kept counting the car, and the Lot Report printed
        "1 part on order - untouched 20 days" about a part ordered a minute
        earlier. One line of Walt's report contradicting itself.
        """
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            assert_estimate_editable(db, order_id)
            estimate = estimate_for_order(db, order_id)
            cur = db.execute(
                "UPDATE estimate_items SET status='ordered',ordered_at=? "
                "WHERE estimate_id=? AND kind='part' AND status='quoted'",
                (now_fn(), estimate["id"]),
            )
            # Only when something actually moved: a click that ordered nothing
            # is not work on the car, and logging it would reset the idle clock
            # on a car nobody has touched.
            if cur.rowcount:
                record_activity(db, order_id, "parts_ordered", item.actor, {"count": cur.rowcount}, now_fn)
            return {"updated": cur.rowcount}

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/status")
    def set_item_status(order_id: int, item_id: int, item: ItemStatusIn):
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            assert_estimate_editable(db, order_id)
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, kind, status FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            # Parts are only ever marked received through /estimate/receive-parts,
            # which posts a real A/P record -- this endpoint no longer accepts
            # "received" for a part line so there's exactly one receiving path.
            #
            # Putting a line back to quoted clears the order date with it: the
            # part is not on order any more, and a stale stamp would have the
            # on-order list ageing something nobody is waiting for.
            db.execute(
                "UPDATE estimate_items SET status=?,ordered_at=? WHERE id=?",
                (item.status, now_fn() if item.status == "ordered" else "", item_id),
            )
            # Same rule as the bulk route above: a real change to what the shop
            # is waiting on is work on the car, and a no-op change is not.
            if row["status"] != item.status:
                record_activity(
                    db,
                    order_id,
                    "parts_ordered" if item.status == "ordered" else "parts_order_undone",
                    item.actor,
                    {"item_id": item_id, "count": 1},
                    now_fn,
                )
        return {"id": item_id, "status": item.status}

    def find_received_invoice(
        db: sqlite3.Connection, order_id: int, invoice_number: str, vendor_id: int | None = None
    ) -> sqlite3.Row | None:
        """A part's received_invoice_number is just the string it was posted
        under -- this is the one place that's resolved back to the actual
        ap_invoices row, needed both to show the reassign-invoice warning and
        to do the reassignment itself.

        Resolved by vendor + invoice number, which is what actually identifies
        a vendor invoice (and is the pair the unique constraint is on). It used
        to be resolved by the invoice's own order_id, and that quietly stopped
        working in the single most ordinary case there is: one invoice covering
        parts for two cars. receive_onto_invoice nulls order_id the moment an
        invoice spans tickets -- deliberately, because it no longer belongs to
        one -- and every lookup keyed on it then came back empty. The part was
        still received, the money was still right, but nothing could say who
        supplied it any more.

        The old order-scoped match stays as the fallback for lines too old to
        have a received_vendor_id, which is exactly what those rows had before.
        """
        if vendor_id is not None:
            return db.execute(
                "SELECT * FROM ap_invoices WHERE vendor_id=? AND invoice_number=? AND status!='voided'"
                " ORDER BY id DESC LIMIT 1",
                (vendor_id, invoice_number),
            ).fetchone()
        return db.execute(
            "SELECT * FROM ap_invoices WHERE order_id=? AND invoice_number=? AND status!='voided' ORDER BY id DESC LIMIT 1",
            (order_id, invoice_number),
        ).fetchone()

    @router.get("/orders/{order_id}/estimate/items/{item_id}/received-invoice")
    def get_received_invoice(order_id: int, item_id: int):
        """Feeds the Move dialog's reassign-invoice checkbox: which invoice
        (if any) this line was received under, and what else it covers, so the
        advisor can see the blast radius before deciding to drag the whole
        invoice along with this one line.

        The blast radius counts every part line on the invoice, on whatever
        ticket -- not just the ones on this one. Reassigning moves the invoice
        entire, so an invoice shared with another car is precisely the case
        worth warning about, and counting only this ticket's lines said "0
        others" about exactly that."""
        with connect() as db:
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT * FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if not row["received_invoice_number"]:
                return None
            invoice = find_received_invoice(db, order_id, row["received_invoice_number"], row["received_vendor_id"])
            if not invoice:
                return None
            other_items, other_orders = invoice_line_reach(db, invoice["id"], item_id, order_id)
            if not other_items:
                # Lines received before per-line invoice links existed have no
                # ap_invoice_items row to count, so fall back to the string
                # match that was the only answer available then.
                other_items = db.execute(
                    "SELECT count(*) FROM estimate_items WHERE estimate_id=? AND received_invoice_number=? AND id!=?",
                    (estimate["id"], row["received_invoice_number"], item_id),
                ).fetchone()[0]
            vendor = db.execute("SELECT name FROM vendors WHERE id=?", (invoice["vendor_id"],)).fetchone()
            return {
                "invoice_id": invoice["id"],
                "invoice_number": invoice["invoice_number"],
                "vendor_name": vendor["name"] if vendor else "",
                "posted_at": invoice["posted_at"],
                "other_item_count": other_items,
                "other_order_count": other_orders,
            }

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/move")
    def move_item(order_id: int, item_id: int, item: MoveItemIn):
        """Corrects a part (often already received) logged against the wrong
        repair order -- moves the line itself, quantity/cost/received state
        and all, onto a different ticket's estimate. The vendor A/P invoice
        that was posted when it was received is left exactly where it is
        UNLESS reassign_invoice is set, in which case the whole invoice (every
        line it covers, not just this one) is reassigned to the target order
        too -- get_received_invoice is what lets the UI warn the advisor
        before they opt into that."""
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
                "SELECT * FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, source_estimate["id"])
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

            reassigned_invoice_id = None
            if item.reassign_invoice and row["received_invoice_number"]:
                invoice = find_received_invoice(db, order_id, row["received_invoice_number"], row["received_vendor_id"])
                if invoice:
                    db.execute(
                        "UPDATE ap_invoices SET order_id=?,po_number=? WHERE id=?",
                        (item.target_order_id, target_order["number"], invoice["id"]),
                    )
                    reassigned_invoice_id = invoice["id"]

            record_activity(
                db,
                order_id,
                "estimate_item_moved_out",
                item.actor,
                {
                    "item_id": item_id,
                    "target_order_id": item.target_order_id,
                    "reassigned_invoice_id": reassigned_invoice_id,
                },
                now_fn,
            )
            record_activity(
                db,
                item.target_order_id,
                "estimate_item_moved_in",
                item.actor,
                {"item_id": item_id, "source_order_id": order_id, "reassigned_invoice_id": reassigned_invoice_id},
                now_fn,
            )
        return {
            "id": item_id,
            "moved_to_order_id": item.target_order_id,
            "reassigned_invoice_id": reassigned_invoice_id,
        }

    def posted_core_deposit(db: sqlite3.Connection, order_id: int, row: sqlite3.Row) -> tuple[int, float] | None:
        """The live vendor invoice line that charged this part's core deposit,
        as (vendor_id, amount) -- or None if there isn't one.

        Deposits only started riding on the vendor invoice from this version
        on, and an invoice can be voided after the fact, so "there is a deposit
        to give back" has to be looked up rather than assumed. A core recorded
        against a bill that never carried its deposit still closes out on the
        cores board; it just has nothing in A/P to reverse.
        """
        if not row["received_invoice_number"]:
            return None
        invoice = find_received_invoice(db, order_id, row["received_invoice_number"])
        if not invoice or invoice["vendor_id"] is None:
            return None
        billed = db.execute(
            "SELECT coalesce(sum(line_total),0) FROM ap_invoice_items"
            " WHERE ap_invoice_id=? AND estimate_item_id=? AND kind='core_charge'",
            (invoice["id"], row["id"]),
        ).fetchone()[0]
        amount = round(float(billed), 2)
        return (invoice["vendor_id"], amount) if amount > 0 else None

    def posted_core_credit(db: sqlite3.Connection, order_id: int, row: sqlite3.Row) -> sqlite3.Row | None:
        """The live A/P credit that already gave this core's deposit back."""
        if not row["core_return_invoice_number"]:
            return None
        return db.execute(
            "SELECT * FROM ap_invoices WHERE order_id=? AND invoice_number=?"
            " AND source='core_return' AND status!='voided' ORDER BY id DESC LIMIT 1",
            (order_id, row["core_return_invoice_number"]),
        ).fetchone()

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
                "SELECT * FROM estimate_items WHERE id=? AND estimate_id=?",
                (item_id, estimate["id"]),
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if float(row["core_charge"]) <= 0:
                raise HTTPException(400, "This line has no core charge to return")
            # Sending the new part back reverses the whole line -- there is no
            # old unit owed to anyone, so there's no core to send with it.
            if item.returned and row["part_returned"]:
                raise HTTPException(
                    400,
                    "This part is going back to the vendor, so its core charge reverses with it — there's no core to return",
                )
            # Undoing the return clears the credit number below, which would
            # put the deposit back into the car's cost while the vendor credit
            # it was given back under is still sitting in A/P. The money has to
            # move in one direction at a time, so the A/P side goes first.
            if not item.returned and posted_core_credit(db, order_id, row):
                raise HTTPException(
                    400,
                    "The vendor's credit for this core is posted to Accounts Payable — void it there first",
                )
            # A fresh return has no credit yet, and undoing a return can't
            # leave a stale credit number behind -- cleared either way.
            db.execute(
                "UPDATE estimate_items SET core_returned=?,core_returned_at=?,core_return_invoice_number='' WHERE id=?",
                (1 if item.returned else 0, now_fn() if item.returned else "", item_id),
            )
            record_activity(
                db,
                order_id,
                "core_returned" if item.returned else "core_return_undone",
                item.actor,
                {"item_id": item_id},
                now_fn,
            )
        return {"id": item_id, "core_returned": item.returned}

    @router.post("/orders/{order_id}/estimate/items/{item_id}/core-credit")
    def post_core_credit(order_id: int, item_id: int, item: CoreCreditIn):
        """Records the vendor's credit/invoice number for a core that already
        went back -- the paperwork arrives after the vendor receives the old
        unit, so this is a separate step from marking it returned. A non-empty
        core_return_invoice_number is what moves the core into Credited.

        The deposit was charged on the vendor's invoice when the part came in,
        so getting it back posts the matching negative A/P row -- the same
        shape post_return_credit uses for a returned part. Without it, A/P
        would carry every deposit the shop has ever paid and none of the money
        that came back.
        """
        with connect() as db:
            current_order = order_row(db, order_id)
            assert_vehicle_editable(db, current_order)
            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if not estimate:
                raise HTTPException(404, "No estimate on this repair order")
            row = db.execute(
                "SELECT * FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if not row["core_returned"]:
                raise HTTPException(400, "Only a core already marked returned can have its credit recorded")
            if row["core_return_invoice_number"]:
                raise HTTPException(409, "A credit has already been recorded for this core")
            invoice_number = item.invoice_number.strip()

            ap_invoice_id = None
            credit_total = 0.0
            deposit = posted_core_deposit(db, order_id, row)
            if deposit:
                vendor_id, amount = deposit
                credit_total = -amount
                result = create_ap_invoice_record(
                    db,
                    now_fn,
                    vendor_id=vendor_id,
                    order_id=order_id,
                    invoice_number=invoice_number,
                    po_number=current_order["number"],
                    items=[
                        InvoiceItemIn(
                            part_number=row["part_number"] or "N/A",
                            description=f"Core deposit refund — {row['description']}",
                            quantity=1,
                            unit_cost=amount,
                            kind="credit",
                        )
                    ],
                    subtotal=credit_total,
                    tax=0,
                    total=credit_total,
                    source="core_return",
                )
                if result["status"] == "duplicate":
                    raise HTTPException(409, "This credit number is already posted for this vendor")
                ap_invoice_id = result["ap_invoice_id"]

            db.execute(
                "UPDATE estimate_items SET core_return_invoice_number=? WHERE id=?",
                (invoice_number, item_id),
            )
            record_activity(
                db,
                order_id,
                "core_credit_recorded",
                item.actor,
                {"item_id": item_id, "invoice_number": invoice_number, "credit_total": credit_total},
                now_fn,
            )
        return {
            "id": item_id,
            "core_return_invoice_number": invoice_number,
            "ap_invoice_id": ap_invoice_id,
            "credit_total": credit_total,
        }

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/part-return")
    def set_part_return(order_id: int, item_id: int, item: PartReturnIn):
        """Marks a received part as returned to the vendor (or undoes that) --
        wrong part, defective, no longer needed. Deliberately does not call
        assert_estimate_editable, same reasoning as core-return: parts often
        go back to the vendor well after the ticket's estimate is invoiced
        and locked. Voided/archived orders are still blocked via
        assert_vehicle_editable. received_quantity and received_invoice_number
        are left alone as the audit trail of what was actually received --
        cost_rollup is what stops a returned part's cost from still counting
        toward the vehicle."""
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, kind, status FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if row["kind"] != "part" or row["status"] != "received":
                raise HTTPException(400, "Only a received part can be marked returned")
            # A freshly flagged return is still physically at the shop, and
            # undoing a return can't leave a stale pickup stamp behind.
            db.execute(
                "UPDATE estimate_items SET part_returned=?,part_returned_at=?,part_picked_up_at='' WHERE id=?",
                (1 if item.returned else 0, now_fn() if item.returned else "", item_id),
            )
            record_activity(
                db,
                order_id,
                "part_returned" if item.returned else "part_return_undone",
                item.actor,
                {"item_id": item_id},
                now_fn,
            )
        return {"id": item_id, "part_returned": item.returned}

    @router.patch("/orders/{order_id}/estimate/items/{item_id}/part-pickup")
    def set_part_pickup(order_id: int, item_id: int, item: PartPickupIn):
        """Records that the vendor has actually collected a part flagged for
        return -- the difference between "it's still on my shelf" and "it's
        gone, waiting on their credit". Same no-assert_estimate_editable
        reasoning as part-return: pickups happen long after a ticket locks."""
        with connect() as db:
            assert_vehicle_editable(db, order_row(db, order_id))
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT id, part_returned, return_invoice_number FROM estimate_items WHERE id=? AND estimate_id=?",
                (item_id, estimate["id"]),
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if not row["part_returned"]:
                raise HTTPException(400, "Only a part marked returned can be picked up")
            if not item.picked_up and row["return_invoice_number"]:
                raise HTTPException(400, "This return has already been credited -- it can't go back on the shelf")
            stamp = now_fn() if item.picked_up else ""
            db.execute("UPDATE estimate_items SET part_picked_up_at=? WHERE id=?", (stamp, item_id))
            record_activity(
                db,
                order_id,
                "part_picked_up" if item.picked_up else "part_pickup_undone",
                item.actor,
                {"item_id": item_id},
                now_fn,
            )
        return {"id": item_id, "part_picked_up_at": stamp}

    @router.post("/orders/{order_id}/estimate/items/{item_id}/post-return-credit")
    def post_return_credit(order_id: int, item_id: int, item: PostReturnCreditIn):
        """Posts the vendor credit for a part that's already been marked
        returned -- a negative ap_invoices row (the same log receive-parts
        posts into, just with a negative total) so the A/P books reflect
        what the vendor owes back. Same no-assert_estimate_editable
        reasoning as core-return/part-return: this typically happens well
        after the ticket is locked. return_invoice_number being non-empty
        is what marks a returned line as already credited, so it can't be
        double-posted."""
        with connect() as db:
            current_order = order_row(db, order_id)
            assert_vehicle_editable(db, current_order)
            if not db.execute("SELECT 1 FROM vendors WHERE id=?", (item.vendor_id,)).fetchone():
                raise HTTPException(404, "Vendor not found")
            estimate = estimate_for_order(db, order_id)
            row = db.execute(
                "SELECT * FROM estimate_items WHERE id=? AND estimate_id=?", (item_id, estimate["id"])
            ).fetchone()
            if not row:
                raise HTTPException(404, "Estimate item not found on this repair order")
            if row["kind"] != "part" or not row["part_returned"]:
                raise HTTPException(400, "Only a part marked returned can have a credit posted")
            if row["return_invoice_number"]:
                raise HTTPException(409, "A credit has already been posted for this return")

            quantity = float(row["received_quantity"])
            unit_cost = float(row["unit_cost"])
            credit_total = -round(quantity * unit_cost, 2)

            result = create_ap_invoice_record(
                db,
                now_fn,
                vendor_id=item.vendor_id,
                order_id=order_id,
                invoice_number=item.credit_number,
                po_number=current_order["number"],
                items=[
                    InvoiceItemIn(
                        part_number=row["part_number"] or "N/A",
                        description=row["description"],
                        quantity=quantity,
                        unit_cost=unit_cost,
                        kind="credit",
                    )
                ],
                subtotal=credit_total,
                tax=0,
                total=credit_total,
                source="part_return",
            )
            if result["status"] == "duplicate":
                raise HTTPException(409, "This credit/RMA number is already posted for this vendor")

            # A credit that has arrived is proof the vendor took the part, so
            # a line still sitting in Pending gets its pickup stamped here
            # rather than being left in a state its own paperwork contradicts.
            db.execute(
                """UPDATE estimate_items
                   SET return_invoice_number=?,
                       part_picked_up_at=CASE WHEN part_picked_up_at='' THEN ? ELSE part_picked_up_at END
                   WHERE id=?""",
                (item.credit_number.strip(), now_fn(), item_id),
            )
            record_activity(
                db,
                order_id,
                "part_return_credited",
                item.actor,
                {
                    "item_id": item_id,
                    "vendor_id": item.vendor_id,
                    "credit_number": item.credit_number.strip(),
                    "credit_total": credit_total,
                },
                now_fn,
            )
            return {"ap_invoice_id": result["ap_invoice_id"], "credit_total": credit_total}

    @router.get("/returns")
    def list_returns():
        """Feeds the Parts & Cores page's Returned Parts table -- every
        part line marked returned (set_part_return), regardless of order,
        with the original receiving vendor so the Post Credit dialog can
        default to it, and whether a credit has already been posted for it.

        The vendor comes off the part line's own received_vendor_id. It used to
        be looked up by finding an invoice with a matching number on the same
        ticket, which came back empty for any part received on an invoice that
        also covered another car -- so the screen that exists to say where to
        take a part back named no vendor at all on exactly those lines."""
        with connect() as db:
            rows = db.execute(
                """SELECT ei.id, ei.description, ei.part_number, ei.received_quantity, ei.unit_cost,
                       ei.part_returned_at, ei.received_invoice_number, ei.return_invoice_number,
                       ei.part_return_reference, ei.part_picked_up_at,
                       ei.received_vendor_id vendor_id, coalesce(rvn.name,'') vendor_name,
                       o.id order_id, o.number ro_number, o.voided, o.segment,
                       o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                       rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name
                   FROM estimate_items ei
                   JOIN estimates e ON e.id=ei.estimate_id
                   JOIN orders o ON o.id=e.order_id
                   LEFT JOIN vendors rvn ON rvn.id=ei.received_vendor_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   LEFT JOIN customers oc ON oc.id=o.customer_id
                   WHERE ei.part_returned=1
                   ORDER BY (ei.return_invoice_number!='') ASC,
                            (ei.part_picked_up_at!='') ASC,
                            ei.part_returned_at DESC""",
            )
            result = []
            for row in rows:
                value = dict(row)
                value["vehicle_label"] = label_vehicle(value)
                vendor_id = None
                vendor_name = ""
                if value["received_invoice_number"]:
                    invoice = find_received_invoice(db, value["order_id"], value["received_invoice_number"])
                    if invoice:
                        vendor = db.execute(
                            "SELECT id,name FROM vendors WHERE id=?", (invoice["vendor_id"],)
                        ).fetchone()
                        if vendor:
                            vendor_id, vendor_name = vendor["id"], vendor["name"]
                value["vendor_id"] = vendor_id
                value["vendor_name"] = vendor_name
                value["credit_total"] = -round(value["received_quantity"] * value["unit_cost"], 2)
                result.append(value)
            return result

    @router.get("/parts/on-order")
    def list_parts_on_order():
        """Every part the shop is waiting on, across every ticket, oldest first.

        The board already counts these per car ("Waiting on Parts"), and the
        Lot Report already says a car is waiting on two of them. Neither can
        say *which* parts, or -- the question that actually gets a car
        finished -- how long each one has been coming. Answering that meant
        opening every ticket in turn, which during a busy morning means it
        doesn't get answered.

        Scope matches the board's on purpose, so the count here and the count
        on the card can never disagree: part lines still on 'ordered', not sent
        back, on a ticket that hasn't been voided and a vehicle that hasn't
        been archived to History.

        days_waiting is None, not 0, for a line ordered before ordered_at
        existed -- "we don't know" and "it went on order today" are opposite
        answers and must not share a rendering.
        """
        with connect() as db:
            rows = db.execute(
                """SELECT ei.id, ei.description, ei.part_number, ei.quantity, ei.received_quantity,
                       ei.unit_cost, ei.ordered_at, ei.core_charge,
                       o.id order_id, o.number ro_number, o.segment,
                       o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                       v.year, v.make, v.model,
                       rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name
                   FROM estimate_items ei
                   JOIN estimates e ON e.id=ei.estimate_id
                   JOIN orders o ON o.id=e.order_id
                   JOIN vehicles v ON v.id=o.vehicle_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   LEFT JOIN customers oc ON oc.id=o.customer_id
                   WHERE ei.kind='part' AND ei.status='ordered' AND ei.part_returned=0
                     AND o.voided=0
                     AND coalesce(rv.archived_at,'')='' AND coalesce(wi.archived_at,'')=''
                   -- Longest wait first: the part most likely to have been
                   -- forgotten is the one worth asking about. Lines with no
                   -- recorded date sort last rather than leading the list,
                   -- since nothing is known about how old they are.
                   ORDER BY (ei.ordered_at='') ASC, ei.ordered_at ASC, ei.id ASC""",
            )
            result = []
            for row in rows:
                value = dict(row)
                value["vehicle_label"] = label_vehicle(value)
                value["vehicle"] = f"{value['year']} {value['make']} {value['model']}"
                # What's still coming, not what was quoted -- a line half
                # received is only outstanding for the rest of it.
                outstanding = round(float(value["quantity"]) - float(value["received_quantity"]), 4)
                value["outstanding_quantity"] = outstanding
                value["value"] = round(outstanding * float(value["unit_cost"]), 2)
                value["days_waiting"] = age_days(value["ordered_at"]) if value["ordered_at"] else None
                result.append(value)
            return result

    @router.get("/cores")
    def list_cores():
        """A core deposit only exists because a new part was bought and the
        old unit is owed back. If the new part itself goes back to the vendor
        instead of onto the car, there is no old unit to return -- the whole
        line reverses, core charge included -- so a still-pending core on a
        returned part is dropped rather than left on the board as work that
        will never happen. A core that had already gone back before the part
        was returned stays visible: that one physically moved and may carry a
        credit, so it's a record, not a chore. Filtered rather than deleted,
        so undoing the part return brings the core obligation straight back."""
        with connect() as db:
            rows = db.execute(
                """SELECT ei.id, ei.description, ei.part_number, ei.core_charge, ei.quantity,
                       -- The deposit is charged per unit, so two calipers owe
                       -- two deposits. The board summed the per-unit figure and
                       -- under-reported anything bought in pairs -- which on a
                       -- brake job is most of them.
                       round(ei.quantity*ei.core_charge, 2) core_total,
                       ei.core_returned, ei.core_returned_at, ei.core_return_invoice_number,
                       ei.received_invoice_number,
                       ei.received_vendor_id vendor_id, coalesce(rvn.name,'') vendor_name,
                       o.id order_id, o.number ro_number, o.voided, o.segment,
                       o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                       rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name
                   FROM estimate_items ei
                   JOIN estimates e ON e.id=ei.estimate_id
                   JOIN orders o ON o.id=e.order_id
                   LEFT JOIN vendors rvn ON rvn.id=ei.received_vendor_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   LEFT JOIN customers oc ON oc.id=o.customer_id
                   WHERE ei.core_charge > 0
                     AND NOT (ei.part_returned=1 AND ei.core_returned=0)
                   ORDER BY (ei.core_return_invoice_number!='') ASC, ei.core_returned ASC, ei.id DESC""",
            )
            result = []
            for row in rows:
                value = dict(row)
                value["vehicle_label"] = label_vehicle(value)
                # Same vendor resolution as /returns: the core deposit belongs
                # to whichever vendor invoice received the part it came with.
                vendor_id = None
                vendor_name = ""
                if value["received_invoice_number"]:
                    invoice = find_received_invoice(db, value["order_id"], value["received_invoice_number"])
                    if invoice:
                        vendor = db.execute(
                            "SELECT id,name FROM vendors WHERE id=?", (invoice["vendor_id"],)
                        ).fetchone()
                        if vendor:
                            vendor_id, vendor_name = vendor["id"], vendor["name"]
                value["vendor_id"] = vendor_id
                value["vendor_name"] = vendor_name
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
            invoice_links: list[int | None] = []
            remaining_by_id: dict[int, tuple[float, float]] = {}
            for row in rows:
                remaining = float(row["quantity"]) - float(row["received_quantity"])
                if remaining <= 0.001:
                    raise HTTPException(409, f"'{row['description']}' has already been fully received")
                override = item.cost_overrides.get(row["id"])
                unit_cost = float(row["unit_cost"]) if override is None else override
                remaining_by_id[row["id"]] = (remaining, unit_cost)
                invoice_items.append(
                    InvoiceItemIn(
                        part_number=row["part_number"] or "N/A",
                        description=row["description"],
                        quantity=remaining,
                        unit_cost=unit_cost,
                        kind="part",
                    )
                )
                invoice_links.append(row["id"])
                # The core deposit is on the vendor's paper invoice, so it has
                # to be on ours. Leaving it off meant the total RECON posted
                # was short by every deposit on the bill and there was no way
                # to make the two agree. It rides as its own line, linked to
                # the part it came with, so post_core_credit can find and
                # reverse exactly this deposit when the old unit goes back.
                core_charge = float(row["core_charge"] or 0)
                if core_charge > 0:
                    invoice_items.append(
                        InvoiceItemIn(
                            part_number=row["part_number"] or "N/A",
                            description=f"Core deposit — {row['description']}",
                            quantity=remaining,
                            unit_cost=core_charge,
                            kind="core_charge",
                        )
                    )
                    invoice_links.append(row["id"])

            result = receive_onto_invoice(
                db,
                now_fn,
                vendor_id=item.vendor_id,
                order_id=order_id,
                invoice_number=item.invoice_number,
                po_number=current_order["number"],
                items=invoice_items,
                # Same order the invoice lines were built in just above, so
                # each billed line points back at the part it paid for.
                estimate_item_ids=invoice_links,
                tax=item.tax,
            )
            if result["status"] == "duplicate":
                raise HTTPException(409, "This vendor invoice number is already posted for this vendor")

            for row in rows:
                remaining, unit_cost = remaining_by_id[row["id"]]
                db.execute(
                    "UPDATE estimate_items SET received_quantity=received_quantity+?,unit_cost=?,status='received',"
                    "received_invoice_number=?,received_vendor_id=? WHERE id=?",
                    (remaining, unit_cost, item.invoice_number.strip(), item.vendor_id, row["id"]),
                )

            recompute_estimate_totals(db, estimate["id"])
            record_activity(
                db,
                order_id,
                "parts_received",
                item.actor,
                {"invoice_number": item.invoice_number.strip(), "vendor_id": item.vendor_id, "item_ids": unique_ids},
                now_fn,
            )
            return {"ap_invoice_id": result["ap_invoice_id"], "received_items": len(rows)}

    return router
