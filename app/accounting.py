from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field


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


class InvoiceItemIn(BaseModel):
    part_number: str = Field(min_length=1)
    description: str = Field(min_length=1)
    quantity: float = Field(gt=0)
    unit_cost: float = Field(ge=0)
    kind: Literal["part", "credit", "freight", "core_charge", "shop_supplies", "labor"] = "part"


class InvoiceIn(BaseModel):
    vendor_name: str = Field(min_length=1)
    invoice_number: str = Field(min_length=1)
    po_number: str = Field(min_length=1)
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
    vendor_id: int,
    order_id: int,
    invoice_number: str,
    po_number: str,
    items: list[InvoiceItemIn],
    subtotal: float,
    tax: float,
    total: float,
    source: str,
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
            (vendor_id, order_id, invoice_number.strip(), normalized, po_number.strip(), subtotal, tax, total, "posted", source, now_fn()),
        )
    except sqlite3.IntegrityError:
        db.rollback()
        return {"status": "duplicate"}
    ap_id = cur.lastrowid
    db.executemany(
        "INSERT INTO ap_invoice_items(ap_invoice_id,part_number,description,quantity,unit_cost,line_total) VALUES(?,?,?,?,?,?)",
        [(ap_id, item.part_number.strip().upper(), item.description.strip(), item.quantity, item.unit_cost, round(item.quantity * item.unit_cost, 2)) for item in items],
    )
    return {"status": "posted", "ap_invoice_id": ap_id}


def build_accounting_router(connect: Callable[[], sqlite3.Connection], now: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/vendors")
    def list_vendors():
        with connect() as db:
            return [dict(row) | {"aliases": json.loads(row["aliases"])} for row in db.execute("SELECT * FROM vendors ORDER BY name")]

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

    @router.get("/ap/invoices")
    def list_ap_invoices(start: str | None = None, end: str | None = None):
        end_bound = f"{end}T23:59:59" if end else None
        with connect() as db:
            rows = db.execute(
                """SELECT a.*, v.name vendor_name, o.number ro_number, o.segment,
                       rv.stock_number, wc.name we_owe_customer_name
                   FROM ap_invoices a
                   JOIN vendors v ON v.id=a.vendor_id
                   JOIN orders o ON o.id=a.order_id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
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
                else:
                    value["vehicle_label"] = "Retail"
                result.append(value)
            return result

    @router.get("/accounting/audits")
    def list_audits():
        with connect() as db:
            return [dict(row) | {"issues": json.loads(row["issues"])} for row in db.execute("SELECT * FROM invoice_audits ORDER BY id DESC LIMIT 100")]

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

    def audit(db: sqlite3.Connection, invoice: InvoiceIn, status: str, issues: list[str], order_id: int | None, vendor_id: int | None):
        db.execute(
            "INSERT INTO invoice_audits(invoice_number,vendor_text,po_number,status,issues,source,order_id,vendor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (invoice.invoice_number.strip(), invoice.vendor_name.strip(), invoice.po_number.strip(), status, json.dumps(issues), invoice.source, order_id, vendor_id, now()),
        )

    RECEIVABLE_ORDER_STATUSES = {"estimate", "pending_approval", "in_progress"}
    LARGE_INVOICE_THRESHOLD = 500.0

    @router.post("/agent/invoices/process")
    def process_invoice(invoice: InvoiceIn, request: Request):
        _check_auth(request)
        issues: list[str] = []
        with connect() as db:
            vendor = find_vendor(db, invoice.vendor_name)
            order = find_order(db, invoice.po_number)
            vendor_id = vendor["id"] if vendor else None
            order_id = order["id"] if order else None

            if not vendor:
                issues.append(f"Vendor '{invoice.vendor_name}' did not exactly match a configured vendor or alias")
            if not order:
                issues.append(f"PO '{invoice.po_number}' did not exactly match a repair order number")
            elif order["status"] not in RECEIVABLE_ORDER_STATUSES:
                issues.append(f"Repair order '{order['number']}' has status '{order['status']}' and cannot receive parts")
            if vendor and db.execute("SELECT id FROM ap_invoices WHERE vendor_id=? AND normalized_invoice_number=?", (vendor_id, normalize(invoice.invoice_number))).fetchone():
                duplicate_issues = ["Vendor invoice number was already posted"]
                audit(db, invoice, "duplicate", duplicate_issues, order_id, vendor_id)
                return {"status": "duplicate", "issues": duplicate_issues, "vendor_id": vendor_id, "order_id": order_id}

            if invoice.total > LARGE_INVOICE_THRESHOLD:
                issues.append(f"Invoice total ${invoice.total:.2f} exceeds ${LARGE_INVOICE_THRESHOLD:.2f} threshold -- requires manual approval")

            line_subtotal = round(sum(item.quantity * item.unit_cost for item in invoice.items), 2)
            if abs(line_subtotal - invoice.subtotal) > 0.02:
                issues.append(f"Line items total {line_subtotal:.2f}, but invoice subtotal is {invoice.subtotal:.2f}")
            calculated_total = round(invoice.subtotal + invoice.tax, 2)
            if abs(calculated_total - invoice.total) > 0.02:
                issues.append(f"Subtotal plus tax is {calculated_total:.2f}, but invoice total is {invoice.total:.2f}")

            # Collapse repeated part numbers into one line: quantities accumulate, last unit_cost wins.
            merged_items: dict[str, InvoiceItemIn] = {}
            for item in invoice.items:
                key = normalize(item.part_number)
                prior = merged_items.get(key)
                if prior:
                    merged_items[key] = prior.model_copy(update={"quantity": prior.quantity + item.quantity, "unit_cost": item.unit_cost})
                else:
                    merged_items[key] = item

            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone() if order else None
            existing_by_part: dict[str, sqlite3.Row] = {}
            if estimate:
                existing_by_part = {
                    normalize(row["part_number"]): row
                    for row in db.execute("SELECT * FROM estimate_items WHERE estimate_id=? AND kind='part' AND part_number!=''", (estimate["id"],))
                }
                for key, item in merged_items.items():
                    existing = existing_by_part.get(key)
                    if existing and float(existing["received_quantity"]) + item.quantity > float(existing["quantity"]) + 0.001:
                        issues.append(f"Receipt quantity for {item.part_number} exceeds the quantity on the repair order")

            if issues:
                audit(db, invoice, "review_required", issues, order_id, vendor_id)
                return {"status": "review_required", "issues": issues, "vendor_id": vendor_id, "order_id": order_id}

            if not estimate:
                cur = db.execute(
                    "INSERT INTO estimates(order_id,labor_rate,tax_rate,subtotal,tax,total,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (order_id, 0.0, 0.0, 0, 0, 0, "draft", now()),
                )
                estimate_id = cur.lastrowid
                estimate = db.execute("SELECT * FROM estimates WHERE id=?", (estimate_id,)).fetchone()
            estimate_id = estimate["id"]
            received_parts: list[dict[str, Any]] = []
            added_parts: list[dict[str, Any]] = []
            added_labor: list[dict[str, Any]] = []
            for key, item in merged_items.items():
                if item.kind == "labor":
                    # At-cost shop: no markup, unit_price is just unit_cost.
                    hours = item.quantity  # quantity = hours for labor items
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (estimate_id, "labor", item.description.strip(), item.part_number.strip().upper(), hours, item.unit_cost, item.unit_cost, 0, round(hours * item.unit_cost, 2), "received"),
                    )
                    added_labor.append({"description": item.description.strip(), "hours": hours, "cost": item.unit_cost})
                    continue

                if item.kind == "credit":
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (estimate_id, "credit", item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_cost, item.unit_cost, 0, round(item.quantity * item.unit_cost, 2), "received"),
                    )
                    received_parts.append({"part_number": item.part_number.strip().upper(), "quantity": -item.quantity, "unit_cost": item.unit_cost, "type": "credit"})
                    continue

                existing = existing_by_part.get(key)
                if existing:
                    db.execute(
                        "UPDATE estimate_items SET received_quantity=received_quantity+?,unit_cost=?,status='received',received_invoice_number=? WHERE id=?",
                        (item.quantity, item.unit_cost, invoice.invoice_number.strip(), existing["id"]),
                    )
                else:
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,status,received_invoice_number) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (estimate_id, "part", item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_cost, item.unit_cost, item.quantity, round(item.quantity * item.unit_cost, 2), "received", invoice.invoice_number.strip()),
                    )
                    added_parts.append({"part_number": item.part_number.strip().upper(), "cost": item.unit_cost})
                received_parts.append({"part_number": item.part_number.strip().upper(), "quantity": item.quantity, "unit_cost": item.unit_cost})

            totals = db.execute(
                "SELECT coalesce(sum(line_total),0),coalesce(sum(CASE WHEN kind='part' THEN line_total ELSE 0 END),0) FROM estimate_items WHERE estimate_id=?",
                (estimate_id,),
            ).fetchone()
            estimate_subtotal = round(totals[0], 2)
            estimate_tax = round(totals[1] * float(estimate["tax_rate"]), 2)
            db.execute("UPDATE estimates SET subtotal=?,tax=?,total=? WHERE id=?", (estimate_subtotal, estimate_tax, round(estimate_subtotal + estimate_tax, 2), estimate_id))
            result = create_ap_invoice_record(
                db, now,
                vendor_id=vendor_id, order_id=order_id,
                invoice_number=invoice.invoice_number, po_number=invoice.po_number,
                items=invoice.items, subtotal=invoice.subtotal, tax=invoice.tax, total=invoice.total,
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
