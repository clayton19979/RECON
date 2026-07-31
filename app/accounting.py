from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable, Sequence
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .db import inserted_id
from .workflow import estimate_line_total, record_activity


def _check_auth(request: Request) -> None:
    """Require X-API-Key header when API_DISCOUNT_AUTO_OPS_KEY is set."""
    key = os.getenv("API_DISCOUNT_AUTO_OPS_KEY", "").strip()
    if not key:
        return  # dev mode -- no auth
    provided = request.headers.get("x-api-key", "").strip()
    if not provided:
        raise HTTPException(401, "Missing X-API-Key header")
    if provided != key:
        raise HTTPException(403, "Invalid API key")


class VendorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    aliases: list[str] = []
    account_number: str = ""


class VendorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    aliases: list[str] | None = None
    account_number: str | None = None


class VoidIn(BaseModel):
    actor: str = "ui"


class InvoiceItemIn(BaseModel):
    part_number: str = Field(min_length=1)
    description: str = Field(min_length=1)
    quantity: float = Field(gt=0)
    unit_cost: float = Field(ge=0)
    kind: Literal["part", "credit", "freight", "core_charge", "shop_supplies", "labor"] = "part"


class InvoiceIn(BaseModel):
    vendor_name: str = Field(min_length=1)
    invoice_number: str = Field(min_length=1)
    # Free text, and no longer required to name a repair order. It stays the
    # vendor's own reference for the order -- often a real RO number, often a
    # counter ticket or a delivery note for something with no ticket at all.
    po_number: str = ""
    # Set when the invoice really does belong to a ticket. Explicit beats
    # inferring it from po_number: an operator who picked a ticket said so,
    # and a bill for shop supplies shouldn't get attached to a vehicle because
    # its reference number happened to look like an RO.
    order_id: int | None = None
    subtotal: float = Field(ge=0)
    tax: float = Field(ge=0)
    total: float = Field(ge=0)
    items: list[InvoiceItemIn] = Field(min_length=1)
    source: str = "ui"


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def create_ap_invoice_record(
    db: sqlite3.Connection,
    now_fn: Callable[[], str],
    *,
    # None when the invoice named a vendor nobody configured -- the bill
    # still posts (flagged as an issue), it just isn't tied to a vendor row.
    vendor_id: int | None,
    order_id: int | None,
    invoice_number: str,
    po_number: str,
    items: list[InvoiceItemIn],
    subtotal: float,
    tax: float,
    total: float,
    source: str,
    # Parallel to `items`: which estimate line each billed line paid for, when
    # the invoice came from receiving on a ticket rather than being typed in.
    estimate_item_ids: Sequence[int | None] | None = None,
) -> dict:
    """Writes one ap_invoices row + its ap_invoice_items -- the one piece of
    invoice posting that's genuinely identical whether the invoice came from
    the agent's fuzzy vendor/PO matching or a human directly receiving
    specific estimate lines on a ticket. Returns {"status": "duplicate"} or
    {"status": "posted", "ap_invoice_id": ...}."""
    normalized = normalize(invoice_number)
    if db.execute(
        "SELECT id FROM ap_invoices WHERE vendor_id=? AND normalized_invoice_number=?", (vendor_id, normalized)
    ).fetchone():
        return {"status": "duplicate"}
    try:
        cur = db.execute(
            "INSERT INTO ap_invoices(vendor_id,order_id,invoice_number,normalized_invoice_number,po_number,subtotal,tax,total,status,source,posted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                vendor_id,
                order_id,
                invoice_number.strip(),
                normalized,
                po_number.strip(),
                subtotal,
                tax,
                total,
                "posted",
                source,
                now_fn(),
            ),
        )
    except sqlite3.IntegrityError:
        db.rollback()
        return {"status": "duplicate"}
    ap_id = inserted_id(cur)
    _insert_invoice_items(db, ap_id, items, estimate_item_ids)
    return {"status": "posted", "ap_invoice_id": ap_id}


def _insert_invoice_items(
    db: sqlite3.Connection,
    ap_invoice_id: int,
    items: list[InvoiceItemIn],
    estimate_item_ids: Sequence[int | None] | None = None,
) -> None:
    links = list(estimate_item_ids or [None] * len(items))
    assert len(links) == len(items), "every billed line needs a link slot, even an empty one"
    db.executemany(
        "INSERT INTO ap_invoice_items(ap_invoice_id,part_number,description,quantity,unit_cost,line_total,estimate_item_id)"
        " VALUES(?,?,?,?,?,?,?)",
        [
            (
                ap_invoice_id,
                item.part_number.strip().upper(),
                item.description.strip(),
                item.quantity,
                item.unit_cost,
                round(item.quantity * item.unit_cost, 2),
            )
            + (link,)
            for item, link in zip(items, links, strict=True)
        ],
    )


def receive_onto_invoice(
    db: sqlite3.Connection,
    now_fn: Callable[[], str],
    *,
    vendor_id: int,
    order_id: int,
    invoice_number: str,
    po_number: str,
    items: list[InvoiceItemIn],
    estimate_item_ids: Sequence[int | None],
    tax: float,
) -> dict:
    """Put parts received on a ticket onto the vendor's invoice, opening it on
    the first delivery and adding to it on every one after.

    One vendor invoice routinely covers parts for several cars, and those
    parts rarely arrive together -- two axles for one car today, a mirror for
    another tomorrow, all on the same invoice. Posting used to create the
    invoice outright and refuse the second delivery as a duplicate, so the
    only way through was to invent invoice numbers ("WP-5512-A", "WP-5512-B").
    That put numbers in the system the vendor had never issued, which is both
    the thing that made the real invoice impossible to reconcile and the thing
    that broke the only link back to who supplied a part.

    So the invoice accumulates. Each delivery adds its lines and its share of
    tax, and the running total is what the vendor will actually bill.

    An invoice that ends up covering more than one ticket stops claiming to
    belong to any single one -- `order_id` goes null and the per-line links
    carry the truth. Cars are costed from their own received part lines, never
    from an invoice total, so spanning tickets cannot disturb what any car has
    in it.
    """
    subtotal = round(sum(i.quantity * i.unit_cost for i in items), 2)
    existing = db.execute(
        "SELECT * FROM ap_invoices WHERE vendor_id=? AND normalized_invoice_number=? AND status!='voided'",
        (vendor_id, normalize(invoice_number)),
    ).fetchone()

    if existing is None:
        result = create_ap_invoice_record(
            db,
            now_fn,
            vendor_id=vendor_id,
            order_id=order_id,
            invoice_number=invoice_number,
            po_number=po_number,
            items=items,
            subtotal=subtotal,
            tax=tax,
            total=round(subtotal + tax, 2),
            source="ticket_receive",
            estimate_item_ids=estimate_item_ids,
        )
        return result

    _insert_invoice_items(db, existing["id"], items, estimate_item_ids)
    new_subtotal = round(existing["subtotal"] + subtotal, 2)
    new_tax = round(existing["tax"] + tax, 2)
    spans_tickets = existing["order_id"] is not None and existing["order_id"] != order_id
    db.execute(
        "UPDATE ap_invoices SET subtotal=?,tax=?,total=?,order_id=? WHERE id=?",
        (
            new_subtotal,
            new_tax,
            round(new_subtotal + new_tax, 2),
            None if spans_tickets else existing["order_id"],
            existing["id"],
        ),
    )
    return {"status": "extended", "ap_invoice_id": existing["id"]}


def build_accounting_router(connect: Callable[[], sqlite3.Connection], now: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/vendors")
    def list_vendors():
        with connect() as db:
            return [
                dict(row) | {"aliases": json.loads(row["aliases"])}
                for row in db.execute("SELECT * FROM vendors ORDER BY name")
            ]

    @router.post("/vendors", status_code=201)
    def create_vendor(vendor: VendorIn):
        canonical = normalize(vendor.name)
        try:
            with connect() as db:
                cur = db.execute(
                    "INSERT INTO vendors(name,normalized_name,aliases,account_number,created_at) VALUES(?,?,?,?,?)",
                    (vendor.name.strip(), canonical, json.dumps(vendor.aliases), vendor.account_number.strip(), now()),
                )
                row = dict(db.execute("SELECT * FROM vendors WHERE id=?", (cur.lastrowid,)).fetchone())
                row["aliases"] = json.loads(row["aliases"])
                return row
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "Vendor already exists") from exc

    @router.patch("/vendors/{vendor_id}")
    def update_vendor(vendor_id: int, item: VendorPatch):
        with connect() as db:
            if not db.execute("SELECT 1 FROM vendors WHERE id=?", (vendor_id,)).fetchone():
                raise HTTPException(404, "Vendor not found")
            fields: list[str] = []
            params: list[object] = []
            if item.name is not None:
                fields.append("name=?")
                params.append(item.name.strip())
                fields.append("normalized_name=?")
                params.append(normalize(item.name))
            if item.aliases is not None:
                fields.append("aliases=?")
                params.append(json.dumps(item.aliases))
            if item.account_number is not None:
                fields.append("account_number=?")
                params.append(item.account_number.strip())
            if fields:
                params.append(vendor_id)
                try:
                    db.execute(f"UPDATE vendors SET {','.join(fields)} WHERE id=?", params)
                except sqlite3.IntegrityError as exc:
                    raise HTTPException(409, "Another vendor already has that name") from exc
            row = dict(db.execute("SELECT * FROM vendors WHERE id=?", (vendor_id,)).fetchone())
            row["aliases"] = json.loads(row["aliases"])
            return row

    @router.get("/ap/invoices")
    def list_ap_invoices(start: str | None = None, end: str | None = None):
        end_bound = f"{end}T23:59:59" if end else None
        with connect() as db:
            rows = db.execute(
                """SELECT a.*, v.name vendor_name, o.number ro_number, o.segment,
                       o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                       rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name
                   FROM ap_invoices a
                   JOIN vendors v ON v.id=a.vendor_id
                   -- LEFT: an invoice with no repair order behind it (shop
                   -- supplies, a bulk delivery) must still appear in the A/P
                   -- list. An inner join silently hid them entirely.
                   LEFT JOIN orders o ON o.id=a.order_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   LEFT JOIN customers oc ON oc.id=o.customer_id
                   WHERE (:start IS NULL OR a.posted_at>=:start) AND (:end IS NULL OR a.posted_at<=:end)
                   ORDER BY a.id DESC""",
                {"start": start, "end": end_bound},
            )
            result = []
            for row in rows:
                value = dict(row)
                if value["stock_number"]:
                    value["vehicle_label"] = value["stock_number"]
                elif value["we_owe_customer_name"]:
                    value["vehicle_label"] = f"We-Owe: {value['we_owe_customer_name']}"
                elif value["order_customer_name"]:
                    value["vehicle_label"] = f"Retail: {value['order_customer_name']}"
                elif value["order_id"] is None:
                    # No ticket by design, not a broken link -- say so plainly
                    # rather than mislabelling it as a retail job.
                    value["vehicle_label"] = "No ticket"
                else:
                    value["vehicle_label"] = "Retail"
                result.append(value)
            return result

    @router.patch("/ap/invoices/{invoice_id}/void")
    def void_ap_invoice(invoice_id: int, item: VoidIn):
        """Voids a mistakenly-posted vendor invoice (wrong vendor, wrong PO
        match, duplicate entry) -- the row is kept for audit trail, just
        excluded from being picked as a duplicate match going forward. This
        does NOT reverse the "received" status it may have set on estimate
        lines; ap_invoice_items has no link back to which specific estimate
        line it came from, so that side has to be corrected on the ticket
        itself if needed."""
        with connect() as db:
            invoice = db.execute("SELECT * FROM ap_invoices WHERE id=?", (invoice_id,)).fetchone()
            if not invoice:
                raise HTTPException(404, "Vendor invoice not found")
            if invoice["status"] == "voided":
                raise HTTPException(409, "Invoice is already voided")
            # Suffixing the normalized number frees it up -- otherwise the
            # unique constraint on (vendor_id, normalized_invoice_number)
            # would block ever re-posting a corrected invoice under the
            # same real invoice number.
            freed_number = f"{invoice['normalized_invoice_number']}-voided-{invoice_id}"
            db.execute(
                "UPDATE ap_invoices SET status='voided', normalized_invoice_number=? WHERE id=?",
                (freed_number, invoice_id),
            )
            # The activity log is per-ticket, so an invoice that belongs to no
            # ticket has nowhere to log to. The void is still recorded on the
            # invoice row itself, which is where anyone would look for it.
            if invoice["order_id"] is not None:
                record_activity(
                    db,
                    invoice["order_id"],
                    "ap_invoice_voided",
                    item.actor,
                    {"invoice_id": invoice_id, "invoice_number": invoice["invoice_number"]},
                    now,
                )
            return dict(db.execute("SELECT * FROM ap_invoices WHERE id=?", (invoice_id,)).fetchone())

    @router.get("/accounting/audits")
    def list_audits():
        with connect() as db:
            return [
                dict(row) | {"issues": json.loads(row["issues"])}
                for row in db.execute("SELECT * FROM invoice_audits ORDER BY id DESC LIMIT 100")
            ]

    def find_vendor(db: sqlite3.Connection, supplied: str):
        target = normalize(supplied)
        for row in db.execute("SELECT * FROM vendors"):
            names = [row["normalized_name"], *(normalize(alias) for alias in json.loads(row["aliases"]))]
            if target in names:
                return row
        return None

    def find_order(db: sqlite3.Connection, po_number: str):
        """Matches a PO# against either an RO number (RO-2607-0012) or a
        vehicle's stock number (R-1042) -- shops naturally give vendors the
        stock number as the PO reference since it's what's on the car, so
        an invoice that comes back referencing the stock number needs to
        resolve to that vehicle's repair order just as well as the formal
        RO number would."""
        target = normalize(po_number)
        for row in db.execute("SELECT * FROM orders"):
            if normalize(row["number"]) == target:
                return row
        for recon_vehicle in db.execute("SELECT * FROM recon_vehicles"):
            if normalize(recon_vehicle["stock_number"]) == target:
                orders = db.execute(
                    "SELECT * FROM orders WHERE recon_vehicle_id=? ORDER BY id DESC", (recon_vehicle["id"],)
                ).fetchall()
                active = next((o for o in orders if o["status"] != "complete"), None)
                if active is not None:
                    return active
                if orders:
                    return orders[0]
        return None

    def audit(
        db: sqlite3.Connection,
        invoice: InvoiceIn,
        status: str,
        issues: list[str],
        order_id: int | None,
        vendor_id: int | None,
    ):
        db.execute(
            "INSERT INTO invoice_audits(invoice_number,vendor_text,po_number,status,issues,source,order_id,vendor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                invoice.invoice_number.strip(),
                invoice.vendor_name.strip(),
                invoice.po_number.strip(),
                status,
                json.dumps(issues),
                invoice.source,
                order_id,
                vendor_id,
                now(),
            ),
        )

    RECEIVABLE_ORDER_STATUSES = {"estimate", "pending_approval", "in_progress"}

    @router.post("/agent/invoices/process")
    def process_invoice(invoice: InvoiceIn, request: Request):
        _check_auth(request)
        issues: list[str] = []
        with connect() as db:
            vendor = find_vendor(db, invoice.vendor_name)
            vendor_id = vendor["id"] if vendor else None

            # An explicitly chosen ticket is a decision and is honoured as-is.
            # Otherwise the PO text is still matched against RO numbers, which
            # is what the automated ingestion path relies on -- but failing to
            # match no longer holds the invoice back. A bill that belongs to no
            # ticket is an ordinary thing (shop supplies, a bulk oil delivery,
            # a tool purchase); it simply posts without rolling into any
            # vehicle's cost.
            if invoice.order_id is not None:
                order = db.execute("SELECT * FROM orders WHERE id=?", (invoice.order_id,)).fetchone()
                if not order:
                    raise HTTPException(404, "Repair order not found")
            else:
                order = find_order(db, invoice.po_number) if invoice.po_number.strip() else None
            order_id = order["id"] if order else None

            if not vendor:
                issues.append(f"Vendor '{invoice.vendor_name}' did not exactly match a configured vendor or alias")
            if order and order["status"] not in RECEIVABLE_ORDER_STATUSES:
                issues.append(
                    f"Repair order '{order['number']}' has status '{order['status']}' and cannot receive parts"
                )
            if (
                vendor
                and db.execute(
                    "SELECT id FROM ap_invoices WHERE vendor_id=? AND normalized_invoice_number=?",
                    (vendor_id, normalize(invoice.invoice_number)),
                ).fetchone()
            ):
                duplicate_issues = ["Vendor invoice number was already posted"]
                audit(db, invoice, "duplicate", duplicate_issues, order_id, vendor_id)
                return {"status": "duplicate", "issues": duplicate_issues, "vendor_id": vendor_id, "order_id": order_id}

            # There used to be a $500 ceiling here that pushed any larger
            # invoice to review_required instead of posting it. Removed at the
            # shop's request: a $500 parts bill is an ordinary Tuesday, the
            # people posting invoices are the same people who approve them,
            # and the hold achieved nothing except a second trip through the
            # Control Log. Every invoice is still logged, still attributed,
            # and still voidable, so the audit trail is unchanged -- what's
            # gone is only the gate. The genuine correctness checks below
            # (duplicate number, unknown vendor, arithmetic that doesn't add
            # up, over-receipt) all still hold an invoice back.

            # Signed, so a credit line subtracts here exactly as it does on the
            # vendor's own paperwork. Summing credits as positives made an
            # ordinary mixed invoice (a part, plus a credit for the one it
            # replaced) fail its own arithmetic check and get held for review.
            line_subtotal = round(
                sum(estimate_line_total(item.kind, item.quantity, item.unit_cost) for item in invoice.items), 2
            )
            if abs(line_subtotal - invoice.subtotal) > 0.02:
                issues.append(f"Line items total {line_subtotal:.2f}, but invoice subtotal is {invoice.subtotal:.2f}")
            calculated_total = round(invoice.subtotal + invoice.tax, 2)
            if abs(calculated_total - invoice.total) > 0.02:
                issues.append(f"Subtotal plus tax is {calculated_total:.2f}, but invoice total is {invoice.total:.2f}")

            # Collapse repeated part numbers into one line: quantities accumulate,
            # last unit_cost wins. Keyed by (kind, part number) -- a labor line
            # and a part line that happen to share the same code (e.g. a
            # generic "MISC" part number) must never be merged into one row of
            # whichever kind was seen first.
            merged_items: dict[tuple[str, str], InvoiceItemIn] = {}
            for item in invoice.items:
                key = (item.kind, normalize(item.part_number))
                prior = merged_items.get(key)
                if prior:
                    merged_items[key] = prior.model_copy(
                        update={"quantity": prior.quantity + item.quantity, "unit_cost": item.unit_cost}
                    )
                else:
                    merged_items[key] = item

            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone() if order else None
            existing_by_part: dict[str, sqlite3.Row] = {}
            if estimate:
                existing_by_part = {
                    normalize(row["part_number"]): row
                    for row in db.execute(
                        "SELECT * FROM estimate_items WHERE estimate_id=? AND kind='part' AND part_number!=''",
                        (estimate["id"],),
                    )
                }
                # Only a "part" line's quantity is ever tracked against the
                # repair order's received_quantity -- labor/credit lines have
                # no such concept and must not be checked against a
                # same-numbered part's existing row.
                for (kind, part_key), item in merged_items.items():
                    if kind != "part":
                        continue
                    existing = existing_by_part.get(part_key)
                    if (
                        existing
                        and float(existing["received_quantity"]) + item.quantity > float(existing["quantity"]) + 0.001
                    ):
                        issues.append(
                            f"Receipt quantity for {item.part_number} exceeds the quantity on the repair order"
                        )

            if issues:
                audit(db, invoice, "review_required", issues, order_id, vendor_id)
                return {"status": "review_required", "issues": issues, "vendor_id": vendor_id, "order_id": order_id}

            received_parts: list[dict[str, Any]] = []
            added_parts: list[dict[str, Any]] = []
            added_labor: list[dict[str, Any]] = []

            # Everything below writes the invoice's lines onto a ticket's
            # estimate. With no ticket there is nothing to write them to, and
            # nothing should be invented: the invoice is recorded as money
            # owed to the vendor and stops there, which is exactly what a bill
            # for shop supplies is.
            if order is None:
                result = create_ap_invoice_record(
                    db,
                    now,
                    vendor_id=vendor_id,
                    order_id=None,
                    invoice_number=invoice.invoice_number,
                    po_number=invoice.po_number,
                    items=invoice.items,
                    subtotal=invoice.subtotal,
                    tax=invoice.tax,
                    total=invoice.total,
                    source=invoice.source,
                )
                if result["status"] == "duplicate":
                    duplicate_issues = ["Vendor invoice number was already posted"]
                    audit(db, invoice, "duplicate", duplicate_issues, None, vendor_id)
                    return {"status": "duplicate", "issues": duplicate_issues, "vendor_id": vendor_id, "order_id": None}
                audit(db, invoice, "posted", [], None, vendor_id)
                return {
                    "status": "posted",
                    "ap_invoice_id": result["ap_invoice_id"],
                    "vendor_id": vendor_id,
                    "order_id": None,
                    "received_parts": [],
                    "added_parts": [],
                    "added_labor": [],
                    "issues": [],
                }

            if not estimate:
                cur = db.execute(
                    "INSERT INTO estimates(order_id,labor_rate,tax_rate,subtotal,tax,total,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (order_id, 0.0, 0.0, 0, 0, 0, "draft", now()),
                )
                estimate_id = cur.lastrowid
                estimate = db.execute("SELECT * FROM estimates WHERE id=?", (estimate_id,)).fetchone()
            estimate_id = estimate["id"]
            # None of the inserts below set quoted_unit_cost, on purpose. A
            # line that arrives on a vendor invoice and was never on the
            # ticket was never quoted, so it has no estimate to be measured
            # against; leaving the column NULL makes every reader price it at
            # what it cost, which is the only figure that exists for it. The
            # UPDATE branch further down (a billed line matching a part
            # already on the ticket) likewise leaves the quote alone -- that
            # is the whole point of keeping it in its own column.
            for (_kind, part_key), item in merged_items.items():
                if item.kind == "labor":
                    # At-cost shop: no markup, unit_price is just unit_cost.
                    hours = item.quantity  # quantity = hours for labor items
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            estimate_id,
                            "labor",
                            item.description.strip(),
                            item.part_number.strip().upper(),
                            hours,
                            item.unit_cost,
                            item.unit_cost,
                            0,
                            round(hours * item.unit_cost, 2),
                            "received",
                        ),
                    )
                    added_labor.append(
                        {"description": item.description.strip(), "hours": hours, "cost": item.unit_cost}
                    )
                    continue

                if item.kind == "credit":
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            estimate_id,
                            "credit",
                            item.description.strip(),
                            item.part_number.strip().upper(),
                            item.quantity,
                            item.unit_cost,
                            item.unit_cost,
                            0,
                            estimate_line_total("credit", item.quantity, item.unit_cost),
                            "received",
                        ),
                    )
                    received_parts.append(
                        {
                            "part_number": item.part_number.strip().upper(),
                            "quantity": -item.quantity,
                            "unit_cost": item.unit_cost,
                            "type": "credit",
                        }
                    )
                    continue

                existing = existing_by_part.get(part_key)
                if existing:
                    db.execute(
                        "UPDATE estimate_items SET received_quantity=received_quantity+?,unit_cost=?,status='received',received_invoice_number=? WHERE id=?",
                        (item.quantity, item.unit_cost, invoice.invoice_number.strip(), existing["id"]),
                    )
                else:
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status,received_invoice_number) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            estimate_id,
                            "part",
                            item.description.strip(),
                            item.part_number.strip().upper(),
                            item.quantity,
                            item.unit_cost,
                            item.unit_cost,
                            item.quantity,
                            round(item.quantity * item.unit_cost, 2),
                            "received",
                            invoice.invoice_number.strip(),
                        ),
                    )
                    added_parts.append({"part_number": item.part_number.strip().upper(), "cost": item.unit_cost})
                received_parts.append(
                    {
                        "part_number": item.part_number.strip().upper(),
                        "quantity": item.quantity,
                        "unit_cost": item.unit_cost,
                    }
                )

            totals = db.execute(
                "SELECT coalesce(sum(line_total),0),coalesce(sum(CASE WHEN kind='part' THEN line_total ELSE 0 END),0) FROM estimate_items WHERE estimate_id=?",
                (estimate_id,),
            ).fetchone()
            estimate_subtotal = round(totals[0], 2)
            estimate_tax = round(totals[1] * float(estimate["tax_rate"]), 2)
            db.execute(
                "UPDATE estimates SET subtotal=?,tax=?,total=? WHERE id=?",
                (estimate_subtotal, estimate_tax, round(estimate_subtotal + estimate_tax, 2), estimate_id),
            )
            result = create_ap_invoice_record(
                db,
                now,
                vendor_id=vendor_id,
                order_id=order_id,
                invoice_number=invoice.invoice_number,
                po_number=invoice.po_number,
                items=invoice.items,
                subtotal=invoice.subtotal,
                tax=invoice.tax,
                total=invoice.total,
                source=invoice.source,
            )
            if result["status"] == "duplicate":
                duplicate_issues = ["Vendor invoice number was already posted"]
                audit(db, invoice, "duplicate", duplicate_issues, order_id, vendor_id)
                return {"status": "duplicate", "issues": duplicate_issues, "vendor_id": vendor_id, "order_id": order_id}
            ap_id = result["ap_invoice_id"]
            audit(db, invoice, "posted", [], order_id, vendor_id)
            return {
                "status": "posted",
                "ap_invoice_id": ap_id,
                "vendor_id": vendor_id,
                "order_id": order_id,
                "received_parts": received_parts,
                "added_parts": added_parts,
                "added_labor": added_labor,
                "issues": [],
            }

    return router
