from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable, Sequence
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .db import inserted_id, normalize_po_reference
from .workflow import AT_COST_SEGMENTS, estimate_line_total, parts_bill_block_reason, record_activity


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


def record_invoice_audit(
    db: sqlite3.Connection,
    now_fn: Callable[[], str],
    *,
    invoice_number: str,
    vendor_text: str,
    po_number: str,
    status: str,
    issues: list[str],
    source: str,
    order_id: int | None,
    vendor_id: int | None,
) -> None:
    """Write one line of the A/P Control Log.

    The Control Log is the shop's answer to "what happened to that bill?", and
    it says so on screen -- its empty state promises that posting or voiding a
    vendor invoice is recorded here. For a long time only one of the three ways
    a bill can arrive actually wrote to it: an invoice typed into the
    Accounting screen (or handed over by the agent) was logged, an invoice
    created by receiving parts on a ticket was not, and no void was ever logged
    at all. Since receiving parts is how nearly every bill in this shop gets
    posted, the log was empty on a day the shop had posted a thousand dollars
    of parts -- and a bill that was voided, which is the single event most
    worth being able to point at later, left no trace on the screen that
    claims to keep the record.

    So this is the one writer, called from every path that creates, extends or
    voids a vendor invoice.
    """
    db.execute(
        "INSERT INTO invoice_audits(invoice_number,vendor_text,po_number,status,issues,source,order_id,vendor_id,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        (
            invoice_number.strip(),
            vendor_text.strip(),
            po_number.strip(),
            status,
            json.dumps(issues),
            source,
            order_id,
            vendor_id,
            now_fn(),
        ),
    )


def vendor_name_for(db: sqlite3.Connection, vendor_id: int | None) -> str:
    """The vendor's name for the log, from its id.

    The log stores the name as text as well as the id, because it also has to
    record bills naming a vendor nobody has set up -- there is no row to point
    at in that case, and the name the paper carried is the whole point.
    """
    if vendor_id is None:
        return ""
    row = db.execute("SELECT name FROM vendors WHERE id=?", (vendor_id,)).fetchone()
    return row["name"] if row else ""


def _insert_invoice_items(
    db: sqlite3.Connection,
    ap_invoice_id: int,
    items: list[InvoiceItemIn],
    estimate_item_ids: Sequence[int | None] | None = None,
) -> None:
    links = list(estimate_item_ids or [None] * len(items))
    assert len(links) == len(items), "every billed line needs a link slot, even an empty one"
    db.executemany(
        "INSERT INTO ap_invoice_items(ap_invoice_id,part_number,description,quantity,unit_cost,line_total,kind,estimate_item_id)"
        " VALUES(?,?,?,?,?,?,?,?)",
        [
            (
                ap_invoice_id,
                item.part_number.strip().upper(),
                item.description.strip(),
                item.quantity,
                item.unit_cost,
                round(item.quantity * item.unit_cost, 2),
                item.kind,
            )
            + (link,)
            for item, link in zip(items, links, strict=True)
        ],
    )


def ticket_vehicle_label(row: Any) -> str:
    """How a repair order's car is named on the money screens.

    One definition, because three screens print it (A/P, Returns, Cores) and a
    car that reads "R-1002" on one and "Retail" on another is a car nobody can
    reconcile against a vendor statement.
    """
    if row["stock_number"]:
        return row["stock_number"]
    if row["we_owe_customer_name"]:
        return f"We-Owe: {row['we_owe_customer_name']}"
    if row["order_customer_name"]:
        return f"Retail: {row['order_customer_name']}"
    return "Retail"


# Everything needed to name and link the car behind a repair order. Shared by
# the coverage query below and the A/P list itself so the two cannot drift.
_TICKET_COLUMNS = """o.id order_id, o.number ro_number, o.segment,
                     o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                     -- A voided ticket's cost counts toward nothing (see
                     -- recon.live_orders), so a bill hanging off one is money
                     -- the shop owes that no car is carrying. Voiding a ticket
                     -- with a live bill on it is refused now
                     -- (workflow.vendor_bill_void_block_reason), but tickets
                     -- voided before that rule existed still have theirs, and
                     -- this screen is where somebody with a vendor statement
                     -- in hand would go looking.
                     o.voided ticket_voided,
                     rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name"""

_TICKET_JOINS = """LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                   LEFT JOIN customers wc ON wc.id=wi.customer_id
                   LEFT JOIN customers oc ON oc.id=o.customer_id"""


def invoice_coverage(db: sqlite3.Connection) -> dict[int, list[dict]]:
    """Which cars each vendor invoice actually paid for, and how much of it
    went to each, worked out from the billed lines rather than from the
    invoice's own order_id.

    A vendor invoice routinely covers parts for more than one car -- that is
    the normal way a parts counter works, not an edge case -- and when it does,
    `ap_invoices.order_id` goes null on purpose because the invoice no longer
    belongs to any single ticket. The A/P screen read that null and printed
    "No ticket", the same words it uses for a genuine shop-supplies bill. So
    the biggest invoices, the ones covering three cars at once, were the ones
    that named no car at all -- and reconciling a vendor statement meant
    opening tickets one by one to find where the money went.

    The per-line links (`ap_invoice_items.estimate_item_id`) have carried the
    real answer since they were added. This is what reads it back out.
    """
    rows = db.execute(
        f"""SELECT ai.ap_invoice_id, {_TICKET_COLUMNS},
                   round(sum(ai.line_total), 2) amount
              FROM ap_invoice_items ai
              JOIN estimate_items ei ON ei.id=ai.estimate_item_id
              JOIN estimates e ON e.id=ei.estimate_id
              JOIN orders o ON o.id=e.order_id
              {_TICKET_JOINS}
             GROUP BY ai.ap_invoice_id, o.id
             ORDER BY ai.ap_invoice_id, amount DESC, o.id"""
    ).fetchall()
    coverage: dict[int, list[dict]] = {}
    for row in rows:
        entry = dict(row)
        entry.pop("ap_invoice_id")
        entry["vehicle_label"] = ticket_vehicle_label(row)
        entry["ticket_voided"] = bool(row["ticket_voided"])
        coverage.setdefault(row["ap_invoice_id"], []).append(entry)
    return coverage


def invoice_line_reach(
    db: sqlite3.Connection, ap_invoice_id: int, excluding_item_id: int, excluding_order_id: int
) -> tuple[int, int]:
    """(other part lines, *other* repair orders) this invoice still covers --
    what moving the whole invoice would drag along with it.

    The ticket being looked at is excluded from the vehicle count. Counting it
    made a plain two-part invoice on one car claim to reach "1 other vehicle",
    which is the kind of warning people learn to ignore.
    """
    row = db.execute(
        """SELECT count(DISTINCT ei.id),
                  count(DISTINCT CASE WHEN e.order_id != :order_id THEN e.order_id END)
             FROM ap_invoice_items ai
             JOIN estimate_items ei ON ei.id=ai.estimate_item_id
             JOIN estimates e ON e.id=ei.estimate_id
            WHERE ai.ap_invoice_id=:invoice_id AND ei.id!=:item_id""",
        {"invoice_id": ap_invoice_id, "item_id": excluding_item_id, "order_id": excluding_order_id},
    ).fetchone()
    return int(row[0]), int(row[1])


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

    Every outcome here writes one line of the Control Log, because this is how
    nearly every vendor bill in this shop actually gets posted -- see
    record_invoice_audit.
    """
    subtotal = round(sum(i.quantity * i.unit_cost for i in items), 2)
    existing = db.execute(
        "SELECT * FROM ap_invoices WHERE vendor_id=? AND normalized_invoice_number=? AND status!='voided'",
        (vendor_id, normalize(invoice_number)),
    ).fetchone()

    def logged(status: str, issues: list[str]) -> None:
        record_invoice_audit(
            db,
            now_fn,
            invoice_number=invoice_number,
            vendor_text=vendor_name_for(db, vendor_id),
            po_number=po_number,
            status=status,
            issues=issues,
            source="ticket_receive",
            order_id=order_id,
            vendor_id=vendor_id,
        )

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
        # Whatever came back, including the rare refusal: the advisor sees a
        # refusal as a message that disappears, and the log is where it lasts
        # long enough to be explained afterwards.
        logged(
            result["status"],
            ["this invoice number is already on a bill from this vendor"] if result["status"] == "duplicate" else [],
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
    # Not "posted": nothing new was created. A second delivery landing on a
    # bill already on file is what "extended" means, and logging it as a fresh
    # post would have the log claim two invoices where the vendor sent one.
    logged("extended", [])
    return {"status": "extended", "ap_invoice_id": existing["id"]}


def unreceive_invoice_lines(db: sqlite3.Connection, invoice: sqlite3.Row) -> dict:
    """Put the parts a voided invoice received back on order.

    Voiding says "this bill is not real". The bill is how a part's cost got
    onto a car, so leaving the receipt behind left the car carrying money the
    shop had just said it does not owe -- the A/P total dropped and the
    vehicle's spend did not, and the two screens disagreed with nothing on
    either of them to explain why.

    It also left no way forward. Receiving takes the whole outstanding
    quantity, so a line already marked received refuses a second receipt: the
    advisor who voided a mistyped invoice could not then post the corrected
    one, and the only escape was to delete the line and retype it. Undoing the
    receipt is what makes the corrected invoice postable.

    Lines come back as `ordered`, not `quoted`: something is still outstanding
    on that part -- a corrected invoice, usually -- and `ordered` is the state
    that says so and keeps it in the board's Parts column until it is settled.

    `unit_cost` is deliberately left where the invoice put it. What the vendor
    actually billed is a better number than the guess it replaced, and the
    original quote was overwritten at receiving time rather than kept.
    `received_cost` is not left alone, because it is a running total of real
    bills: a bill taken back has to come out of it.
    """
    # Which estimate line each billed line paid for, and what it was billed at.
    # Recorded per line since ap_invoice_items grew estimate_item_id; invoices
    # posted before that (and by the agent endpoint, which posts the bill
    # whole) have no links, so those fall back to the invoice number the
    # receipt itself recorded.
    #
    # Only the part lines. A core deposit rides on the same bill and points at
    # the same estimate line, so summing every linked line counted the deposit
    # as a second delivery of the part: voiding a bill for two of the four
    # rotors put all four back on order instead of two, and dragged the money
    # for a delivery this invoice never covered off the car with them.
    quantities: dict[int, float] = {}
    billed: dict[int, float] = {}
    for row in db.execute(
        "SELECT estimate_item_id, quantity, unit_cost FROM ap_invoice_items"
        " WHERE ap_invoice_id=? AND estimate_item_id IS NOT NULL AND kind='part'",
        (invoice["id"],),
    ):
        item_id = row["estimate_item_id"]
        quantities[item_id] = quantities.get(item_id, 0.0) + float(row["quantity"])
        billed[item_id] = round(billed.get(item_id, 0.0) + float(row["quantity"]) * float(row["unit_cost"]), 2)
    if not quantities and invoice["order_id"] is not None:
        for row in db.execute(
            """SELECT ei.id, ei.received_quantity, ei.received_cost FROM estimate_items ei
               JOIN estimates e ON e.id=ei.estimate_id
               WHERE e.order_id=? AND ei.received_invoice_number=? AND ei.received_quantity>0""",
            (invoice["order_id"], invoice["invoice_number"]),
        ):
            quantities[row["id"]] = float(row["received_quantity"])
            billed[row["id"]] = float(row["received_cost"])

    unreceived = 0
    value = 0.0
    order_ids: set[int] = set()
    for item_id, quantity in quantities.items():
        row = db.execute(
            """SELECT ei.*, e.order_id FROM estimate_items ei JOIN estimates e ON e.id=ei.estimate_id
               WHERE ei.id=?""",
            (item_id,),
        ).fetchone()
        if not row or float(row["received_quantity"]) <= 0:
            continue
        # A receipt that has since been superseded by a different invoice is
        # not this invoice's to undo. Receiving always takes the whole
        # outstanding quantity, so a line carries one invoice at a time and
        # this is a straight identity check rather than an apportionment.
        if row["received_invoice_number"] and normalize(row["received_invoice_number"]) != normalize(
            invoice["invoice_number"]
        ):
            continue
        remaining = round(max(0.0, float(row["received_quantity"]) - quantity), 4)
        # What comes off the car is what this bill charged, not the quantity
        # re-priced at whatever unit_cost currently says -- on a line filled by
        # two deliveries those are different numbers, and the vendor's own
        # paper is the one that is true. Floored at zero and at the line's own
        # running total so an old invoice with no per-line links (the fallback
        # above) can never drive a car's cost negative.
        taken = min(round(billed.get(item_id, 0.0), 2), round(float(row["received_cost"]), 2))
        if remaining <= 0.0001:
            taken = round(float(row["received_cost"]), 2)
        taken = max(0.0, taken)
        value += taken
        if remaining <= 0.0001:
            db.execute(
                "UPDATE estimate_items SET received_quantity=0,received_cost=0,status='ordered',"
                "received_invoice_number='',received_vendor_id=NULL WHERE id=?",
                (item_id,),
            )
        else:
            db.execute(
                "UPDATE estimate_items SET received_quantity=?,received_cost=round(received_cost-?,2),"
                "received_invoice_number='',received_vendor_id=NULL WHERE id=?",
                (remaining, taken, item_id),
            )
        unreceived += 1
        order_ids.add(row["order_id"])

    # A voided credit is not a credit. Clearing the number the return was
    # credited under puts the part back in Cores & Returns as still owed a
    # credit, which is where post-return-credit can reach it again.
    credits_cleared = 0
    if invoice["source"] == "part_return" and invoice["order_id"] is not None:
        cur = db.execute(
            """UPDATE estimate_items SET return_invoice_number=''
               WHERE return_invoice_number=?
                 AND estimate_id IN (SELECT id FROM estimates WHERE order_id=?)""",
            (invoice["invoice_number"], invoice["order_id"]),
        )
        credits_cleared = cur.rowcount
        if credits_cleared:
            order_ids.add(invoice["order_id"])

    return {
        "unreceived_items": unreceived,
        "unreceived_value": round(value, 2),
        "credits_cleared": credits_cleared,
        "order_ids": sorted(order_ids),
    }


def build_accounting_router(connect: Callable[[], sqlite3.Connection], now: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/vendors")
    def list_vendors():
        """Every vendor, alphabetical, each carrying when it was last bought from.

        `last_invoice_at` is the newest non-voided A/P invoice posted against
        the vendor, or "" for one never used. It exists so a screen that has to
        guess a vendor can guess the one the shop actually deals with instead
        of whichever name sorts first -- the receive dialog uses it as its last
        fallback. Voided invoices are excluded for the same reason they are
        excluded everywhere else: a bill taken back is a purchase that never
        happened, and it should not keep a vendor looking current forever.

        The list stays sorted by name. Recency picks a default; it must not
        reorder the dropdown, or the option under the cursor would move around
        as the day goes on.
        """
        with connect() as db:
            return [
                dict(row) | {"aliases": json.loads(row["aliases"])}
                for row in db.execute(
                    """SELECT v.*, coalesce((SELECT max(a.posted_at) FROM ap_invoices a
                                              WHERE a.vendor_id = v.id AND a.status != 'voided'), '') last_invoice_at
                         FROM vendors v ORDER BY v.name"""
                )
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
                f"""SELECT a.*, v.name vendor_name, {_TICKET_COLUMNS}
                   FROM ap_invoices a
                   JOIN vendors v ON v.id=a.vendor_id
                   -- LEFT: an invoice with no repair order behind it (shop
                   -- supplies, a bulk delivery) must still appear in the A/P
                   -- list. An inner join silently hid them entirely.
                   LEFT JOIN orders o ON o.id=a.order_id
                   {_TICKET_JOINS}
                   WHERE (:start IS NULL OR a.posted_at>=:start) AND (:end IS NULL OR a.posted_at<=:end)
                   ORDER BY a.id DESC""",
                {"start": start, "end": end_bound},
            ).fetchall()
            coverage = invoice_coverage(db)
            result = []
            for row in rows:
                value = dict(row)
                covers = coverage.get(value["id"], [])
                if not covers and value["order_id"] is not None:
                    # Typed in on this screen against a ticket: no per-line
                    # links to read, so the invoice's own order is the answer.
                    covers = [
                        {
                            "order_id": value["order_id"],
                            "ro_number": value["ro_number"],
                            "segment": value["segment"],
                            "recon_vehicle_id": value["recon_vehicle_id"],
                            "we_owe_id": value["we_owe_id"],
                            "vehicle_id": value["vehicle_id"],
                            "stock_number": value["stock_number"],
                            "we_owe_customer_name": value["we_owe_customer_name"],
                            "order_customer_name": value["order_customer_name"],
                            "vehicle_label": ticket_vehicle_label(row),
                            "ticket_voided": bool(value["ticket_voided"]),
                            "amount": value["subtotal"],
                        }
                    ]
                value["coverage"] = covers
                value.pop("ticket_voided", None)
                # Money on this bill that no car is carrying, because the
                # ticket behind it was voided. Nearly always 0; when it isn't,
                # the screen says so rather than leaving it to be found by
                # opening cars one at a time.
                value["stranded_total"] = round(
                    sum(cover["amount"] or 0 for cover in covers if cover.get("ticket_voided")), 2
                )
                if not covers:
                    # No ticket by design, not a broken link -- say so plainly
                    # rather than mislabelling it as a retail job.
                    value["vehicle_label"] = "No ticket"
                else:
                    # A one-line summary for search and for anywhere too narrow
                    # to list every car. The invoice's own ro_number/segment are
                    # deliberately left alone: they are null once it spans
                    # tickets, because it no longer belongs to one, and the
                    # coverage list is where the per-car truth lives.
                    value["vehicle_label"] = covers[0]["vehicle_label"]
                    if len(covers) > 1:
                        value["vehicle_label"] += f" +{len(covers) - 1} more"
                result.append(value)
            return result

    @router.patch("/ap/invoices/{invoice_id}/void")
    def void_ap_invoice(invoice_id: int, item: VoidIn):
        """Voids a mistakenly-posted vendor invoice (wrong vendor, wrong PO
        match, duplicate entry) -- the row is kept for audit trail, just
        excluded from being picked as a duplicate match going forward.

        Voiding also undoes what the invoice did to the tickets behind it: the
        parts it received go back on order and their cost comes off the
        vehicle (see unreceive_invoice_lines). An invoice that covers parts
        for several cars undoes all of them, because the whole bill is what
        was declared unreal."""
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
            reversal = unreceive_invoice_lines(db, invoice)
            # The activity log is per-ticket, so an invoice that belongs to no
            # ticket has nowhere to log to. The void is still recorded on the
            # invoice row itself, which is where anyone would look for it.
            # Every ticket the reversal actually touched gets the entry, not
            # just the invoice's own order: a bill covering three cars carries
            # no single order_id, and the two cars whose parts went back on
            # order are exactly the ones whose history has to say why.
            order_ids = list(reversal["order_ids"])
            if invoice["order_id"] is not None and invoice["order_id"] not in order_ids:
                order_ids.append(invoice["order_id"])
            for order_id in order_ids:
                record_activity(
                    db,
                    order_id,
                    "ap_invoice_voided",
                    item.actor,
                    {
                        "invoice_id": invoice_id,
                        "invoice_number": invoice["invoice_number"],
                        "parts_put_back_on_order": reversal["unreceived_items"],
                    },
                    now,
                )
            # The Control Log gets it too, and it is the only screen that does
            # for a bill belonging to no ticket. A void is the event most worth
            # being able to point at weeks later -- it takes real money back
            # off a car -- so the log says what it undid, not just that it
            # happened.
            put_back = reversal["unreceived_items"]
            record_invoice_audit(
                db,
                now,
                invoice_number=invoice["invoice_number"],
                vendor_text=vendor_name_for(db, invoice["vendor_id"]),
                po_number=invoice["po_number"],
                status="voided",
                issues=([f"{put_back} part{'' if put_back == 1 else 's'} put back on order"] if put_back else []),
                source=item.actor,
                order_id=invoice["order_id"],
                vendor_id=invoice["vendor_id"],
            )
            return dict(db.execute("SELECT * FROM ap_invoices WHERE id=?", (invoice_id,)).fetchone()) | {
                # Response metadata, not invoice columns -- the UI says what
                # the void actually changed instead of a bare "Invoice voided"
                # that hides a car's cost dropping by four hundred dollars.
                "unreceived_items": reversal["unreceived_items"],
                "unreceived_value": reversal["unreceived_value"],
                "credits_cleared": reversal["credits_cleared"],
            }

    @router.get("/accounting/audits")
    def list_audits():
        """The Control Log, newest first.

        Each line carries the vendor and the car as well as the invoice
        number, because an invoice number on its own is not something anybody
        in this shop recognises. "INV-88213 — held for review" told the advisor
        nothing they could act on; "NAPA · R-1042 — held for review" is the
        same event with the two facts that make it findable.

        The vendor name is taken from the vendor row when the bill matched one
        and falls back to the name written on the paper, which is the only
        thing there is when it didn't -- and an unmatched vendor is exactly why
        a bill gets held.
        """
        with connect() as db:
            # Columns named one by one rather than a.* + _TICKET_COLUMNS: that
            # shared fragment starts with `o.id order_id`, which would shadow
            # the audit row's own order_id with the joined ticket's.
            rows = db.execute(
                """SELECT a.id, a.invoice_number, a.vendor_text, a.po_number, a.status, a.issues,
                          a.source, a.order_id, a.vendor_id, a.created_at,
                          v.name matched_vendor_name,
                          o.number ro_number, o.segment, o.recon_vehicle_id, o.we_owe_id, o.vehicle_id,
                          rv.stock_number, wc.name we_owe_customer_name, oc.name order_customer_name
                     FROM invoice_audits a
                     LEFT JOIN vendors v ON v.id=a.vendor_id
                     LEFT JOIN orders o ON o.id=a.order_id
                     LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                     LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
                     LEFT JOIN customers wc ON wc.id=wi.customer_id
                     LEFT JOIN customers oc ON oc.id=o.customer_id
                    ORDER BY a.id DESC LIMIT 100"""
            ).fetchall()
            result = []
            for row in rows:
                value = dict(row)
                value["issues"] = json.loads(value["issues"])
                value["vendor_name"] = value.pop("matched_vendor_name") or value["vendor_text"]
                # "No ticket" rather than a blank: a bill for shop supplies
                # legitimately names no car, and a blank reads as a lost link.
                value["vehicle_label"] = ticket_vehicle_label(row) if value["ro_number"] else "No ticket"
                result.append(value)
            return result

    def find_vendor(db: sqlite3.Connection, supplied: str):
        target = normalize(supplied)
        for row in db.execute("SELECT * FROM vendors"):
            names = [row["normalized_name"], *(normalize(alias) for alias in json.loads(row["aliases"]))]
            if target in names:
                return row
        return None

    def find_order(db: sqlite3.Connection, po_number: str):
        """Matches a PO# against a purchase order (20-2), an RO number
        (RO-2607-0012 or plain 20), or a vehicle's stock number (R-1042) --
        shops naturally give vendors the stock number as the PO reference since
        it's what's on the car, so an invoice that comes back referencing the
        stock number needs to resolve to that vehicle's repair order just as
        well as the formal RO number would.

        Tried most specific first. A purchase order names one batch on one
        ticket, so it is the least ambiguous thing a vendor can quote and wins
        outright; a bare repair order number is tried last, after stock
        numbers, so nothing that used to resolve one way starts resolving
        another.
        """
        # Kept apart from `normalize` on purpose: that strips the hyphen, and
        # the hyphen is what separates the ticket from the batch. See
        # db.normalize_po_reference.
        reference = normalize_po_reference(po_number)
        if reference:
            batch = db.execute("SELECT order_id FROM purchase_orders WHERE upper(number)=?", (reference,)).fetchone()
            if batch:
                found = db.execute("SELECT * FROM orders WHERE id=?", (batch["order_id"],)).fetchone()
                if found:
                    return found

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
        # Last resort: the short repair order number on its own, with or
        # without the R that this shop's purchase orders carry. Digits only
        # beyond that, so this can never swallow a reference that merely looks
        # numeric once punctuation is stripped out of it.
        bare = reference[1:] if reference[:1] == "R" and reference[1:].isdigit() else reference
        if bare.isdigit():
            found = db.execute("SELECT * FROM orders WHERE ro_number=?", (int(bare),)).fetchone()
            if found:
                return found
        return None

    def audit(
        db: sqlite3.Connection,
        invoice: InvoiceIn,
        status: str,
        issues: list[str],
        order_id: int | None,
        vendor_id: int | None,
    ):
        record_invoice_audit(
            db,
            now,
            invoice_number=invoice.invoice_number,
            vendor_text=invoice.vendor_name,
            po_number=invoice.po_number,
            status=status,
            issues=issues,
            source=invoice.source,
            order_id=order_id,
            vendor_id=vendor_id,
        )

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
            # A finished ticket takes a late parts bill, because that is when
            # most of them arrive. The three tickets that cannot are named by
            # workflow.parts_bill_block_reason -- the same rule the car's own
            # Receive Selected button enforces.
            blocked = parts_bill_block_reason(db, order) if order else None
            if blocked:
                issues.append(blocked)
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
                        # This is the everyday split delivery: two of the four
                        # rotors on today's bill, the other two on next week's
                        # at whatever the vendor charges then. The money adds
                        # up bill by bill; unit_cost keeps only the newest
                        # price. See received_cost's comment in db.SCHEMA.
                        "UPDATE estimate_items SET received_quantity=received_quantity+?,"
                        "received_cost=round(received_cost+?,2),unit_cost=?,status='received',"
                        "received_invoice_number=? WHERE id=?",
                        (
                            item.quantity,
                            round(item.quantity * item.unit_cost, 2),
                            item.unit_cost,
                            invoice.invoice_number.strip(),
                            existing["id"],
                        ),
                    )
                    if order["segment"] in AT_COST_SEGMENTS:
                        # On the lot's own work a line's price IS its cost
                        # (workflow.reconcile_at_cost_money). Without this the
                        # billed price landed on every cost rollup while the
                        # ticket's own subtotal kept the written-up number --
                        # which quoted_unit_cost already preserves.
                        db.execute(
                            "UPDATE estimate_items SET unit_price=unit_cost,"
                            "line_total=round(quantity*unit_cost,2) WHERE id=?",
                            (existing["id"],),
                        )
                else:
                    db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,received_cost,line_total,status,received_invoice_number) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
            # A vendor bill landing on a ticket puts real money on the car and
            # marks its parts received -- the biggest single thing that happens
            # to a repair order short of closing it. It was invisible on the
            # ticket: nothing in the activity log, and no movement on the idle
            # clock (record_activity is what moves orders.last_activity_at), so
            # a car whose parts arrived this morning still read as untouched.
            # The invoice's own source is the actor: this path is fed by the
            # invoice ingestion agent as often as by a person, and saying which
            # is more use than logging a blank "ui".
            record_activity(
                db,
                # order["id"], not order_id: the early return above means order
                # is definitely a row by now, and reading it straight keeps
                # that obvious instead of leaning on the nullable local.
                order["id"],
                "ap_invoice_posted",
                invoice.source,
                {
                    "ap_invoice_id": ap_id,
                    "invoice_number": invoice.invoice_number.strip(),
                    "vendor_id": vendor_id,
                    "total": invoice.total,
                },
                now,
            )
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
