from __future__ import annotations

import sqlite3
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID, inserted_id, normalize_vin


def age_days(created_at: str | None) -> int:
    """Whole days since created_at (an ISO timestamp) -- how long a car has
    actually been sitting, the natural companion to "what we have in it".
    One malformed value (a hand-edited row, an old backup with a different
    format) must never 500 the entire vehicle board -- every other row's
    age is computed in the same loop, so a single bad timestamp would take
    the whole list down with it rather than just looking wrong on one row."""
    try:
        created = datetime.fromisoformat(created_at or "")
    except (TypeError, ValueError):
        return 0
    # Timestamps are shop-local and naive now (see db.now). Rows written before
    # that change carry a UTC offset, so convert those to local rather than
    # reading them five hours off.
    if created.tzinfo is not None:
        created = created.astimezone().replace(tzinfo=None)
    return (datetime.now() - created).days


def last_activity(db: sqlite3.Connection, column: str, ref_id: int, fallback: str, segment: str | None = None) -> str:
    """When anything last actually happened to this vehicle.

    The newest last_activity_at across the vehicle's tickets (bumped by every
    mutating route -- see workflow.touch_order), falling back to when the
    vehicle landed on the lot for a car with no ticket started yet.

    Deliberately *not* the vehicle's updated_at, in either position. Patching
    the vehicle record is a data correction, not work on the car, so using it
    would let a VIN fix reset the idle clock and hide exactly the cars this
    column exists to surface -- and for a car with no ticket at all, updated_at
    is the *only* thing there is, which made every never-started car report as
    touched today. A car nobody has written a ticket for is the most idle thing
    in the shop, and now says so.

    Voided tickets are excluded for the same reason cost_rollup excludes them:
    voiding one means the work never happened."""
    row = db.execute(
        f"SELECT max(last_activity_at) FROM orders WHERE {column}=? AND voided=0 AND last_activity_at!=''"
        + (" AND segment=?" if segment else ""),
        (ref_id, segment) if segment else (ref_id,),
    ).fetchone()
    return (row[0] if row and row[0] else None) or fallback


def idle_days(last_activity_at: str) -> int:
    """Whole days since anything happened. Same shape as age_days, and the same
    reason for tolerating garbage: one unparseable timestamp shouldn't take
    the board down."""
    return age_days(last_activity_at)


# Anything this or newer counts as stalled. Named here rather than written as a
# 7 at each call site because the board's card, the board's row colouring and
# the API all have to agree about which cars are stalled -- and it's the same
# boundary the "cold" idle bucket starts at in app.js.
STALLED_AFTER_DAYS = 7


def is_stalled(row: Mapping[str, Any]) -> bool:
    """Is this car sitting when it shouldn't be?

    Idle and stalled are not the same question, and conflating them is what
    this exists to stop. Idle is a plain measurement -- days since anything
    happened -- and every car has one. Stalled is a judgement: *this car still
    needs work and nobody has touched it in a week*. A car whose work is
    finished has no such problem, however long it has sat.

    That distinction matters more the longer the app runs. A fulfilled we-owe
    or a completed recon car never gets touched again, so its idle count climbs
    forever: counting those as stalled meant the board's red alarm only ever
    went up, until the number said "17 cars in trouble" on a lot where three
    were. An alarm that is always on is an alarm nobody reads.
    """
    if row.get("status_bucket") == "finished":
        return False
    return max(0, int(row.get("idle_days") or 0)) >= STALLED_AFTER_DAYS


def order_status_bucket(orders: list[dict]) -> str:
    """Finished or still in progress, judged by the repair tickets themselves.

    Recon records carry a status field of their own but nobody maintains it,
    so the ticket is what the answer has to come from: finished means every
    ticket that exists is closed, and at least one exists. A car with no
    ticket at all has not finished anything -- it has not started.
    """
    active = next((o for o in reversed(orders) if o["status"] != "complete"), None)
    has_closed = any(o["status"] == "complete" for o in orders)
    return "finished" if (active is None and has_closed) else "in_progress"


def we_owe_status_bucket(status: str) -> str:
    """A promise is done when the advisor says it is -- fulfilled or waived.

    Unlike recon, this doesn't read the ticket: waiving a promise closes it
    with no work done and often no ticket at all.
    """
    return "finished" if status in ("fulfilled", "waived") else "in_progress"


def last_activity_detail(
    db: sqlite3.Connection, column: str, ref_id: int, fallback: str, segment: str | None = None
) -> dict:
    """When work last happened on this vehicle, and -- where we can honestly
    say -- what it was and who did it.

    Two sources, deliberately kept apart. `at` comes from orders.last_activity_at
    (see last_activity above); that's the authoritative clock, the one the
    board's Idle column reads, and it moves for *every* write. The attribution
    comes from the newest row in activity_events, which only exists for writes
    worth logging -- the estimate grid autosaves through touch_order without
    logging an event, on purpose, or the log would be nothing but noise.

    So the two can disagree, and when they do the event is not what last
    happened. Rather than captioning a fresh timestamp with a stale name, we
    only attribute when the newest event *is* the newest activity; otherwise
    action/actor come back empty and the UI says when without claiming who.
    A slightly thinner answer beats a confidently wrong one."""
    at = last_activity(db, column, ref_id, fallback, segment)
    row = db.execute(
        f"""SELECT e.action, e.actor, e.created_at
            FROM activity_events e JOIN orders o ON o.id=e.order_id
            WHERE o.{column}=? AND o.voided=0"""
        + (" AND o.segment=?" if segment else "")
        + " ORDER BY e.created_at DESC, e.id DESC LIMIT 1",
        (ref_id, segment) if segment else (ref_id,),
    ).fetchone()
    detail = {"at": at, "idle_days": idle_days(at), "action": "", "actor": ""}
    if row and row["created_at"] and row["created_at"] >= at:
        detail["action"] = row["action"] or ""
        detail["actor"] = row["actor"] or ""
    return detail


RECON_STATUSES = {"acquired", "in_repair", "ready", "sold", "retained"}
WE_OWE_STATUSES = {"open", "fulfilled", "waived"}


class RecondVehicleIn(BaseModel):
    stock_number: str = Field(min_length=1, max_length=40)
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    mileage: int = Field(default=0, ge=0)
    odometer_broken: bool = False
    trim: str = ""
    engine: str = ""
    color: str = ""
    acquisition_source: str = ""
    acquisition_date: str = ""
    purchase_price: float = Field(default=0, ge=0)
    notes: str = ""


class RecondVehiclePatch(BaseModel):
    status: Literal["acquired", "in_repair", "ready", "sold", "retained"] | None = None
    sale_price: float | None = Field(default=None, ge=0)
    sale_date: str | None = None
    sale_customer_id: int | None = None
    notes: str | None = None
    # Core vehicle info -- correcting a typo (wrong purchase price, VIN, etc.)
    # shouldn't require touching the database directly.
    purchase_price: float | None = Field(default=None, ge=0)
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    odometer_broken: bool | None = None
    expected_version: int | None = None


class WeOweIn(BaseModel):
    customer_id: int
    vehicle_id: int
    description: str = Field(min_length=1)
    category: str = "other"
    target_date: str = ""
    sale_reference: str = ""
    lot_stock_number: str = ""
    # A we-owe car was very often bought and recon'd before it was ever in
    # RECON -- the promise is the first time the shop writes it down. Without
    # somewhere to put what the car cost, its profit can never be worked out,
    # so the intake accepts it and it lands on the unit, not on the promise.
    purchase_price: float | None = Field(default=None, ge=0)
    sale_price: float | None = Field(default=None, ge=0)


class WeOwePatch(BaseModel):
    status: Literal["open", "fulfilled", "waived"] | None = None
    description: str | None = Field(default=None, min_length=1)
    category: str | None = None
    target_date: str | None = None
    lot_stock_number: str | None = None
    # Core vehicle info -- a car is sometimes entered quickly with the VIN
    # added later, same as recon vehicles below.
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    odometer_broken: bool | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    sale_price: float | None = Field(default=None, ge=0)
    expected_version: int | None = None


class ArchiveIn(BaseModel):
    expected_version: int | None = None


class WeOwePaymentIn(BaseModel):
    """Customers are sometimes talked into putting money down toward a
    we-owe repair -- tracked separately from shop cost so the net amount
    the shop is actually out of pocket is visible, not just gross spend."""

    amount: float = Field(gt=0)
    method: Literal["cash", "card", "check", "bank", "other"] = "cash"
    note: str = ""
    actor: str = ""


def cost_rollup(db: sqlite3.Connection, column: str, ref_id: int, segment: str | None = None) -> dict:
    """Actual cost = what's really landed: labor/fees count in full the moment
    they're logged, but parts only count once received, and stop counting
    again once sent back to the vendor (part_returned). quoted_cost (full
    quantity regardless of receipt) is returned alongside for comparison.

    A core deposit is money out of the shop's pocket that comes back only when
    the old unit does, so an outstanding one counts as part of what the car
    cost -- quoted and actual alike, so a deposit can never make a car read as
    over its own quote. It stops counting the moment the vendor's credit is
    recorded (core_return_invoice_number), which is the same "outstanding"
    line the Cores board draws. A car whose alternator core never went back
    really did cost that $45, and leaving it out understated every such car
    forever while the only place the money appeared was a board nobody had a
    money reason to work. A returned part takes its deposit with it: there is
    no old unit owed to anyone once the new part goes back.

    parts_pending counts part lines that have been ordered from a vendor but
    haven't shown up yet (status='ordered'; 'received' means it landed,
    'quoted' means nobody has actually ordered it). That's the single most
    common reason a car sits on the lot doing nothing, and until now it was
    only visible by opening the ticket -- see the board's Parts column.
    Returned parts are excluded: a line sent back to the vendor isn't
    something the shop is still waiting on."""
    # An outstanding deposit: charged per unit, so it scales with quantity the
    # same way the part's own cost does.
    core_owing = "ei.kind='part' AND ei.part_returned=0 AND ei.core_return_invoice_number='' AND ei.core_charge>0"
    rows = db.execute(
        f"""SELECT o.id, o.number, o.status, o.voided,
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=0 THEN ei.received_quantity*ei.unit_cost ELSE 0 END),0)
                 + coalesce(sum(CASE WHEN {core_owing} THEN ei.received_quantity*ei.core_charge ELSE 0 END),0) parts_cost,
               coalesce(sum(CASE WHEN ei.kind='labor' THEN ei.quantity*ei.unit_cost ELSE 0 END),0) labor_cost,
               -- Hours in their own right, not just as an input to cost. On
               -- recon and we-owe the labor rate is always 0 (in-house time
               -- isn't money out the door), so labor_cost is permanently 0
               -- and the hours the techs flagged were invisible everywhere.
               coalesce(sum(CASE WHEN ei.kind='labor' THEN ei.quantity ELSE 0 END),0) labor_hours,
               coalesce(sum(CASE WHEN ei.kind='fee'   THEN ei.quantity*ei.unit_cost ELSE 0 END),0) fee_cost,
               -- A credit line (a returned part, a refunded core) is stored
               -- positive, the way the vendor prints it, so the sign has to be
               -- applied here: summing it raw made a $150 credit RAISE the
               -- car's quoted cost by $150. Actual cost needs no matching term
               -- -- parts_cost above already drops a returned line via
               -- part_returned, and subtracting the credit as well would count
               -- the same money back twice.
               coalesce(sum(CASE WHEN ei.kind='credit' THEN -ei.quantity*ei.unit_cost ELSE ei.quantity*ei.unit_cost END),0)
                 + coalesce(sum(CASE WHEN {core_owing} THEN ei.quantity*ei.core_charge ELSE 0 END),0) quoted_cost,
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.status='ordered' AND ei.part_returned=0 THEN 1 ELSE 0 END),0) parts_pending,
               -- Core deposits ride in here too: they land on the same vendor
               -- invoice as the part, so this is what that bill will say.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.status='ordered' AND ei.part_returned=0 THEN ei.quantity*ei.unit_cost ELSE 0 END),0)
                 + coalesce(sum(CASE WHEN {core_owing} AND ei.status='ordered' THEN ei.quantity*ei.core_charge ELSE 0 END),0) parts_pending_value
           FROM orders o
           LEFT JOIN estimates e ON e.order_id=o.id
           LEFT JOIN estimate_items ei ON ei.estimate_id=e.id
           WHERE o.{column}=?"""
        + (" AND o.segment=?" if segment else "")
        + """
           GROUP BY o.id
           ORDER BY o.id""",
        (ref_id, segment) if segment else (ref_id,),
    ).fetchall()
    orders = []
    for row in rows:
        value = dict(row)
        value["total_cost"] = round(value["parts_cost"] + value["labor_cost"] + value["fee_cost"], 2)
        orders.append(value)
    # Voided ROs (started by mistake) are kept in the order history
    # (traceability) but never count toward the vehicle's cost -- that work
    # was never actually done.
    countable = [o for o in orders if not o["voided"]]
    return {
        "orders": orders,
        "total_cost": round(sum(o["total_cost"] for o in countable), 2),
        "quoted_cost": round(sum(o["quoted_cost"] for o in countable), 2),
        "labor_hours": round(sum(o["labor_hours"] for o in countable), 2),
        "parts_pending": int(sum(o["parts_pending"] for o in countable)),
        "parts_pending_value": round(sum(o["parts_pending_value"] for o in countable), 2),
    }


def resolve_unit(db: sqlite3.Connection, vehicle_id: int, vin: str | None, ts: str) -> int:
    """Attach a vehicle row to the physical car it describes, found by VIN.

    This is the single point where the recon half and the we-owe half of one
    car's life meet. A car recon'd under the shop's own account and later sold
    and brought back on a we-owe is two `vehicles` rows by necessity (that
    table carries a NOT NULL customer_id), and matching their VINs here is what
    lets the money from both halves land on one ledger.

    A vehicle with no VIN still gets a unit, just a private one -- the app has
    to keep working for a car someone entered in a hurry.
    """
    key = normalize_vin(vin)
    if key:
        found = db.execute("SELECT id FROM vehicle_units WHERE vin_key=?", (key,)).fetchone()
        if found:
            db.execute("UPDATE vehicles SET unit_id=? WHERE id=?", (found["id"], vehicle_id))
            return found["id"]
    unit_id = inserted_id(
        db.execute("INSERT INTO vehicle_units(vin_key,created_at,updated_at) VALUES(?,?,?)", (key, ts, ts))
    )
    db.execute("UPDATE vehicles SET unit_id=? WHERE id=?", (unit_id, vehicle_id))
    return unit_id


def unit_id_for_vehicle(db: sqlite3.Connection, vehicle_id: int, ts: str) -> int:
    """The unit a vehicle belongs to, creating it if this row predates units."""
    row = db.execute("SELECT id, unit_id, vin FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Vehicle not found")
    if row["unit_id"]:
        return row["unit_id"]
    return resolve_unit(db, vehicle_id, row["vin"], ts)


def relink_unit(db: sqlite3.Connection, vehicle_id: int, new_vin: str | None, ts: str) -> int:
    """Re-point a vehicle at the right unit after its VIN was corrected.

    A VIN typed wrong at intake and fixed later is exactly the case where a
    car would otherwise stay stranded on a unit of its own forever, so the
    correction has to move it. Any economics already entered against the old
    private unit come along, rather than being silently abandoned -- but only
    into blanks, so a figure already recorded on the shared unit wins.
    """
    current = db.execute("SELECT unit_id FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
    old_unit_id = current["unit_id"] if current else None
    new_unit_id = resolve_unit(db, vehicle_id, new_vin, ts)
    if not old_unit_id or old_unit_id == new_unit_id:
        return new_unit_id

    old = db.execute("SELECT * FROM vehicle_units WHERE id=?", (old_unit_id,)).fetchone()
    new = db.execute("SELECT * FROM vehicle_units WHERE id=?", (new_unit_id,)).fetchone()
    if old and new:
        merged = {
            "purchase_price": new["purchase_price"] or old["purchase_price"],
            "purchase_source": new["purchase_source"] or old["purchase_source"],
            "purchase_date": new["purchase_date"] or old["purchase_date"],
            "sale_price": new["sale_price"] if new["sale_price"] is not None else old["sale_price"],
            "sale_date": new["sale_date"] or old["sale_date"],
        }
        db.execute(
            """UPDATE vehicle_units SET purchase_price=?,purchase_source=?,purchase_date=?,
                                        sale_price=?,sale_date=?,updated_at=? WHERE id=?""",
            (*merged.values(), ts, new_unit_id),
        )
    # Only drop the vacated unit if nothing else still points at it.
    still_used = db.execute("SELECT 1 FROM vehicles WHERE unit_id=? LIMIT 1", (old_unit_id,)).fetchone()
    if not still_used:
        db.execute("DELETE FROM vehicle_units WHERE id=?", (old_unit_id,))
    return new_unit_id


def unit_lifetime(db: sqlite3.Connection, unit_id: int) -> dict:
    """Everything one physical car cost and earned, across its whole life.

    This is the number the owner is actually after: not "what did recon cost"
    but "what is this car up to, counting the we-owe work that landed weeks
    after it was sold and quietly ate the margin". So it sums every ticket
    reachable from every recon episode AND every we-owe promise on this VIN,
    then nets out whatever the customer chipped in on the we-owe side.

    profit is None when it cannot honestly be worked out, which is either of
    two cases. No sale price: an unsold car has a cost, not a profit, and
    showing 0 or a negative would read as a loss it hasn't taken. No purchase
    price: the lot's cost for the car is deliberately not tracked in this app
    (Walt keeps that figure -- see CLAUDE.md), and subtracting an absent
    purchase from a real sale price would report the whole sale as margin. A
    missing number has to stay missing rather than become a flattering one.
    Cars from when purchase price *was* entered still get a real profit.
    """
    unit = db.execute("SELECT * FROM vehicle_units WHERE id=?", (unit_id,)).fetchone()
    if unit is None:
        raise HTTPException(404, "Vehicle unit not found")

    recon_ids = [
        r["id"]
        for r in db.execute(
            "SELECT rv.id FROM recon_vehicles rv JOIN vehicles v ON v.id=rv.vehicle_id WHERE v.unit_id=?", (unit_id,)
        )
    ]
    we_owe_ids = [
        r["id"]
        for r in db.execute(
            "SELECT w.id FROM we_owe_items w JOIN vehicles v ON v.id=w.vehicle_id WHERE v.unit_id=?", (unit_id,)
        )
    ]

    recon_rollups = [cost_rollup(db, "recon_vehicle_id", rid) for rid in recon_ids]
    we_owe_rollups = [cost_rollup(db, "we_owe_id", wid) for wid in we_owe_ids]
    recon_cost = sum(r["total_cost"] for r in recon_rollups)
    we_owe_cost = sum(r["total_cost"] for r in we_owe_rollups)
    # Every hour any tech flagged on this car, across both halves of its life.
    # On recon and we-owe the rate is 0, so this is the only measure of the
    # work that actually went into it.
    labor_hours = round(sum(r["labor_hours"] for r in recon_rollups + we_owe_rollups), 2)
    customer_paid = 0.0
    if we_owe_ids:
        placeholders = ",".join("?" for _ in we_owe_ids)
        customer_paid = db.execute(
            f"SELECT coalesce(sum(amount),0) FROM we_owe_payments WHERE we_owe_id IN ({placeholders})", we_owe_ids
        ).fetchone()[0]

    purchase_price = unit["purchase_price"] or 0.0
    we_owe_net = round(we_owe_cost - customer_paid, 2)
    total_invested = round(purchase_price + recon_cost + we_owe_net, 2)
    sale_price = unit["sale_price"]
    profit = round(sale_price - total_invested, 2) if sale_price is not None and purchase_price > 0 else None
    return {
        "unit_id": unit_id,
        "vin": unit["vin_key"] or "",
        "purchase_price": round(purchase_price, 2),
        "purchase_source": unit["purchase_source"],
        "purchase_date": unit["purchase_date"],
        "recon_cost": round(recon_cost, 2),
        "we_owe_cost": round(we_owe_cost, 2),
        "labor_hours": labor_hours,
        "we_owe_customer_paid": round(customer_paid, 2),
        "we_owe_net_cost": we_owe_net,
        "total_invested": total_invested,
        "sale_price": sale_price,
        "sale_date": unit["sale_date"],
        "profit": profit,
        # Margin is against the sale price, which is how a lot talks about it
        # ("we made 12 points on that car"), not against what was put in.
        "margin_pct": round(profit / sale_price * 100, 1) if profit is not None and sale_price else None,
        "recon_count": len(recon_ids),
        "we_owe_count": len(we_owe_ids),
    }


def _assert_not_archived(row: sqlite3.Row) -> None:
    if row["archived_at"]:
        raise HTTPException(409, "This vehicle is archived to History -- reopen it to make changes")


def assert_vehicle_editable(db: sqlite3.Connection, order_row: sqlite3.Row) -> None:
    """Once a vehicle's ticket is archived to History it's fully frozen --
    reopening it is the only way back to an editable state. Retail orders
    have neither a recon_vehicle_id nor a we_owe_id, so this is always a
    no-op for them; archiving only applies to recon/we-owe vehicles.

    Also blocks any further edit to an order that's been voided -- voiding
    means "this never happened, don't count it," which every single caller
    of this function (status, concern, notes, assignment, estimate, jobs,
    ordering/receiving parts, invoicing) would otherwise silently let keep
    changing, including posting a real vendor A/P invoice against a
    cancelled job."""
    if order_row["voided"]:
        raise HTTPException(409, "This repair order has been voided and can no longer be edited")
    if order_row["recon_vehicle_id"]:
        row = db.execute(
            "SELECT archived_at FROM recon_vehicles WHERE id=?", (order_row["recon_vehicle_id"],)
        ).fetchone()
        if row:
            _assert_not_archived(row)
    if order_row["we_owe_id"]:
        row = db.execute("SELECT archived_at FROM we_owe_items WHERE id=?", (order_row["we_owe_id"],)).fetchone()
        if row:
            _assert_not_archived(row)


def technician_names(db: sqlite3.Connection, order_ids: list[int]) -> list[str]:
    if not order_ids:
        return []
    placeholders = ",".join("?" for _ in order_ids)
    rows = db.execute(
        f"""SELECT DISTINCT s.name FROM order_workflow w JOIN staff s ON s.id=w.technician_id
            WHERE w.order_id IN ({placeholders}) AND w.technician_id IS NOT NULL ORDER BY s.name""",
        order_ids,
    ).fetchall()
    return [row["name"] for row in rows]


def vehicle_board_rows(
    db: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
    segment: str | None = None,
    archived: bool = False,
) -> list[dict]:
    """The unified Vehicles list: recon + we-owe merged, one row per vehicle,
    with rolled-up cost and assigned technicians. This is the primary view
    of the app and also backs the date-range vehicle-spend report.
    `archived` selects the History view instead of the live job board --
    reports/export always use the default (live board only)."""
    end_bound = f"{end}T23:59:59" if end else None
    archived_flag = 1 if archived else 0
    result = []
    if segment in (None, "recon"):
        rows = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage, v.unit_id,
                      u.purchase_price unit_purchase_price, u.sale_price unit_sale_price
               FROM recon_vehicles rv
               JOIN vehicles v ON v.id=rv.vehicle_id
               LEFT JOIN vehicle_units u ON u.id=v.unit_id
               WHERE (:start IS NULL OR rv.created_at>=:start) AND (:end IS NULL OR rv.created_at<=:end)
                 AND (rv.archived_at != '') = :archived
               ORDER BY rv.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "recon_vehicle_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            # Recon status/sale tracking isn't used here -- the repair order's
            # own status is what the advisor actually maintains, so that's
            # what drives the displayed status and in-progress/finished bucket.
            active_order = next((o for o in reversed(rollup["orders"]) if o["status"] != "complete"), None)
            latest_order = rollup["orders"][-1] if rollup["orders"] else None
            current_order = active_order or latest_order
            display_status = current_order["status"] if current_order else "acquired"
            activity_at = last_activity(db, "recon_vehicle_id", row["id"], row["created_at"])
            result.append(
                {
                    "segment": "recon",
                    "recon_id": row["id"],
                    "we_owe_id": None,
                    "stock_number": row["stock_number"],
                    "vehicle": f"{row['year']} {row['make']} {row['model']}",
                    "vin": row["vin"],
                    "status": display_status,
                    "status_bucket": order_status_bucket(rollup["orders"]),
                    # From the unit, not recon_vehicles' legacy column of the same
                    # name -- one car, one purchase price, whichever half of its
                    # life you happen to be looking at.
                    "purchase_price": row["unit_purchase_price"] or 0,
                    "sale_price": row["unit_sale_price"],
                    "unit_id": row["unit_id"],
                    "actual_cost": rollup["total_cost"],
                    "quoted_cost": rollup["quoted_cost"],
                    "labor_hours": rollup["labor_hours"],
                    "parts_pending": rollup["parts_pending"],
                    "parts_pending_value": rollup["parts_pending_value"],
                    "technicians": technician_names(db, order_ids),
                    # The ticket a board-level action should attach itself to:
                    # the open one if there is one, else the most recent, else
                    # nothing (a car with no ticket yet). Tasks created off the
                    # board link through this, so "follow up on that stalled car"
                    # lands on the RO rather than floating unattached.
                    "order_id": current_order["id"] if current_order else None,
                    "updated_at": row["updated_at"],
                    "age_days": age_days(row["created_at"]),
                    "last_activity_at": activity_at,
                    "idle_days": idle_days(activity_at),
                }
            )
    if segment in (None, "we_owe"):
        rows = db.execute(
            """SELECT w.*, c.name customer_name, v.year, v.make, v.model, v.vin, v.unit_id,
                      u.purchase_price unit_purchase_price, u.sale_price unit_sale_price
               FROM we_owe_items w
               JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               LEFT JOIN vehicle_units u ON u.id=v.unit_id
               WHERE (:start IS NULL OR w.created_at>=:start) AND (:end IS NULL OR w.created_at<=:end)
                 AND (w.archived_at != '') = :archived
               ORDER BY w.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "we_owe_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            active_order = next((o for o in reversed(rollup["orders"]) if o["status"] != "complete"), None)
            latest_order = rollup["orders"][-1] if rollup["orders"] else None
            current_order = active_order or latest_order
            # fulfilled/waived is the authoritative "is this promise resolved"
            # signal (set explicitly by the advisor, separate from any
            # ticket) -- but while it's still open, what's actually changing
            # day to day is the linked ticket's own workflow status, so that's
            # what the board shows, same as recon already does.
            display_status = (
                row["status"] if row["status"] != "open" else (current_order["status"] if current_order else "open")
            )
            customer_paid = round(
                db.execute(
                    "SELECT coalesce(sum(amount),0) FROM we_owe_payments WHERE we_owe_id=?", (row["id"],)
                ).fetchone()[0],
                2,
            )
            activity_at = last_activity(db, "we_owe_id", row["id"], row["created_at"])
            result.append(
                {
                    "segment": "we_owe",
                    "recon_id": None,
                    "we_owe_id": row["id"],
                    "stock_number": row["lot_stock_number"] or None,
                    "vehicle": f"{row['year']} {row['make']} {row['model']}",
                    "vin": row["vin"],
                    "customer_name": row["customer_name"],
                    "description": row["description"],
                    "status": display_status,
                    "status_bucket": we_owe_status_bucket(row["status"]),
                    # A we-owe car has a purchase price too -- it's just usually
                    # entered here, because the shop bought and recon'd it long
                    # before RECON ever saw it.
                    "purchase_price": row["unit_purchase_price"] or 0,
                    "sale_price": row["unit_sale_price"],
                    "unit_id": row["unit_id"],
                    "actual_cost": rollup["total_cost"],
                    "quoted_cost": rollup["quoted_cost"],
                    "labor_hours": rollup["labor_hours"],
                    "parts_pending": rollup["parts_pending"],
                    "parts_pending_value": rollup["parts_pending_value"],
                    "customer_paid": customer_paid,
                    "net_cost": round(rollup["total_cost"] - customer_paid, 2),
                    "technicians": technician_names(db, order_ids),
                    # The ticket a board-level action should attach itself to:
                    # the open one if there is one, else the most recent, else
                    # nothing (a car with no ticket yet). Tasks created off the
                    # board link through this, so "follow up on that stalled car"
                    # lands on the RO rather than floating unattached.
                    "order_id": current_order["id"] if current_order else None,
                    "updated_at": row["updated_at"],
                    "age_days": age_days(row["created_at"]),
                    "last_activity_at": activity_at,
                    "idle_days": idle_days(activity_at),
                }
            )
    return result


def build_recon_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def assert_current_version(row: sqlite3.Row, expected_version: int | None) -> None:
        """Fail fast, with a clear message, before doing any work.

        This is a courtesy check, not the guarantee -- see version_guard. On its
        own it is check-then-act: two saves can both read the same version and
        both pass here before either writes.
        """
        if expected_version is not None and expected_version != row["edit_version"]:
            raise HTTPException(409, "Someone else changed this since you loaded it -- reload to see their update")

    def version_guard(expected_version: int | None) -> tuple[str, tuple[object, ...]]:
        """SQL fragment making an UPDATE apply only if the row is still at the
        version the client loaded.

        Appended to the UPDATE that bumps edit_version, so the comparison
        happens against what is actually committed at write time rather than
        what was read moments earlier. Callers must treat rowcount == 0 as a
        409: the row is known to exist (the *_row helpers already 404), so the
        only way to match nothing is that someone else got there first.
        """
        if expected_version is None:
            return "", ()
        return " AND edit_version=?", (expected_version,)

    def assert_version_won(cur: sqlite3.Cursor, message: str) -> None:
        if cur.rowcount == 0:
            raise HTTPException(409, message)

    def recon_row(db: sqlite3.Connection, recon_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage, v.odometer_broken,
                      v.trim, v.engine, v.color, v.unit_id
               FROM recon_vehicles rv JOIN vehicles v ON v.id=rv.vehicle_id WHERE rv.id=?""",
            (recon_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Recon vehicle not found")
        return row

    def recon_detail(db: sqlite3.Connection, recon_id: int) -> dict:
        row = recon_row(db, recon_id)
        detail = dict(row)
        rollup = cost_rollup(db, "recon_vehicle_id", recon_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["labor_hours"] = rollup["labor_hours"]
        # The same finished/in-progress answer the board gives, so the detail
        # page can tell a car that has gone quiet from one that is simply done
        # -- see is_stalled. Without it the page had no way to know, and put a
        # "Stalled 41 days -- make a task" nudge on finished work.
        detail["status_bucket"] = order_status_bucket(rollup["orders"])
        # Purchase and sale price come off the unit, which is what makes them
        # survive the car being sold and coming back on a we-owe. The legacy
        # recon_vehicles columns of the same name are no longer authoritative.
        unit_id = unit_id_for_vehicle(db, row["vehicle_id"], now_fn())
        lifetime = unit_lifetime(db, unit_id)
        detail["purchase_price"] = lifetime["purchase_price"]
        detail["sale_price"] = lifetime["sale_price"]
        detail["sale_date"] = lifetime["sale_date"] or detail["sale_date"]
        detail["lifetime"] = lifetime
        # This vehicle's own profit still counts only its own recon spend, so
        # the recon screen keeps meaning what it always did; `lifetime` is
        # where the whole-car picture (we-owe work included) lives.
        # Same rule as unit_lifetime(): no purchase price on file means no
        # honest profit, not a profit that's really just the sale price.
        detail["profit"] = (
            round(lifetime["sale_price"] - lifetime["purchase_price"] - rollup["total_cost"], 2)
            if lifetime["sale_price"] is not None and lifetime["purchase_price"] > 0
            else None
        )
        detail["last_activity"] = last_activity_detail(db, "recon_vehicle_id", recon_id, detail["created_at"])
        return detail

    def we_owe_row(db: sqlite3.Connection, we_owe_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT w.*, c.name customer_name, c.phone customer_phone, c.email customer_email,
                      c.address_line1 customer_address_line1, c.address_line2 customer_address_line2,
                      c.city customer_city, c.state customer_state, c.postal_code customer_postal_code,
                      v.year, v.make, v.model, v.vin, v.mileage, v.odometer_broken,
                      v.trim, v.engine, v.color, v.unit_id
               FROM we_owe_items w JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               WHERE w.id=?""",
            (we_owe_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "We-owe item not found")
        return row

    def we_owe_detail(db: sqlite3.Connection, we_owe_id: int) -> dict:
        row = we_owe_row(db, we_owe_id)
        detail = dict(row)
        rollup = cost_rollup(db, "we_owe_id", we_owe_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["labor_hours"] = rollup["labor_hours"]
        # Same reason as recon_detail: a waived promise is closed, not stalled.
        detail["status_bucket"] = we_owe_status_bucket(row["status"])
        payments = [
            dict(p)
            for p in db.execute("SELECT * FROM we_owe_payments WHERE we_owe_id=? ORDER BY id DESC", (we_owe_id,))
        ]
        detail["payments"] = payments
        detail["customer_paid"] = round(sum(p["amount"] for p in payments), 2)
        detail["net_cost"] = round(detail["total_cost"] - detail["customer_paid"], 2)
        # The whole-car picture. On a we-owe this is the point: the promise
        # itself is a cost, and what it does to the car's profit is only
        # visible once the purchase price and the recon spend are alongside it.
        detail["lifetime"] = unit_lifetime(db, unit_id_for_vehicle(db, row["vehicle_id"], now_fn()))
        detail["last_activity"] = last_activity_detail(db, "we_owe_id", we_owe_id, detail["created_at"])
        return detail

    @router.get("/vehicles-board")
    def vehicles_board(segment: Literal["recon", "we_owe"] | None = None, archived: bool = False):
        with connect() as db:
            return vehicle_board_rows(db, segment=segment, archived=archived)

    # --- Recon vehicles ---

    @router.post("/recon/vehicles", status_code=201)
    def create_recon_vehicle(item: RecondVehicleIn):
        stock_number = item.stock_number.strip().upper()
        with connect() as db:
            if db.execute("SELECT 1 FROM recon_vehicles WHERE stock_number=?", (stock_number,)).fetchone():
                raise HTTPException(409, "Stock number already in use")
            ts = now_fn()
            vehicle_cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,odometer_broken,plate,plate_state,trim,engine,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    RECON_SHOP_CUSTOMER_ID,
                    item.year,
                    item.make.strip(),
                    item.model.strip(),
                    item.vin.strip().upper(),
                    item.mileage,
                    int(item.odometer_broken),
                    "",
                    "",
                    item.trim.strip(),
                    item.engine.strip(),
                    item.color.strip(),
                    ts,
                ),
            )
            recon_cur = db.execute(
                "INSERT INTO recon_vehicles(vehicle_id,stock_number,acquisition_source,acquisition_date,purchase_price,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    vehicle_cur.lastrowid,
                    stock_number,
                    item.acquisition_source.strip(),
                    item.acquisition_date.strip(),
                    item.purchase_price,
                    item.notes.strip(),
                    ts,
                    ts,
                ),
            )
            # What the car cost belongs to the car, not to this recon episode:
            # the same VIN coming back on a we-owe months later has to find
            # this number waiting for it.
            unit_id = resolve_unit(db, inserted_id(vehicle_cur), item.vin, ts)
            db.execute(
                "UPDATE vehicle_units SET purchase_price=?,purchase_source=?,purchase_date=?,updated_at=? WHERE id=?",
                (item.purchase_price, item.acquisition_source.strip(), item.acquisition_date.strip(), ts, unit_id),
            )
            return recon_detail(db, inserted_id(recon_cur))

    @router.get("/recon/vehicles/{recon_id}")
    def get_recon_vehicle(recon_id: int):
        with connect() as db:
            return recon_detail(db, recon_id)

    @router.post("/recon/vehicles/{recon_id}/archive")
    def archive_recon_vehicle(recon_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = recon_row(db, recon_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE recon_vehicles SET archived_at=?,edit_version=edit_version+1 WHERE id=?{guard}",
                (now_fn(), recon_id, *guard_params),
            )
            assert_version_won(
                cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
            )
            return recon_detail(db, recon_id)

    @router.post("/recon/vehicles/{recon_id}/reopen")
    def reopen_recon_vehicle(recon_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = recon_row(db, recon_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE recon_vehicles SET archived_at='',edit_version=edit_version+1 WHERE id=?{guard}",
                (recon_id, *guard_params),
            )
            assert_version_won(
                cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
            )
            return recon_detail(db, recon_id)

    @router.patch("/recon/vehicles/{recon_id}")
    def update_recon_vehicle(recon_id: int, item: RecondVehiclePatch):
        with connect() as db:
            row = recon_row(db, recon_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(
                    409, "Someone else changed this vehicle since you loaded it -- reload to see their update"
                )
            fields: list[str] = []
            params: list[object] = []
            if item.status is not None:
                fields.append("status=?")
                params.append(item.status)
            if item.sale_price is not None:
                fields.append("sale_price=?")
                params.append(item.sale_price)
            if item.sale_date is not None:
                fields.append("sale_date=?")
                params.append(item.sale_date.strip())
            if item.sale_customer_id is not None:
                if not db.execute("SELECT 1 FROM customers WHERE id=?", (item.sale_customer_id,)).fetchone():
                    raise HTTPException(404, "Sale customer not found")
                fields.append("sale_customer_id=?")
                params.append(item.sale_customer_id)
            if item.notes is not None:
                fields.append("notes=?")
                params.append(item.notes.strip())
            if item.purchase_price is not None:
                fields.append("purchase_price=?")
                params.append(item.purchase_price)
            # Core vehicle info (VIN, make/model, etc.) lives on the shared
            # vehicles table, not recon_vehicles -- correcting a typo here
            # shouldn't require touching the database directly.
            vehicle_fields: list[str] = []
            vehicle_params: list[object] = []
            for name, value in (
                ("vin", item.vin.strip().upper() if item.vin is not None else None),
                ("year", item.year),
                ("make", item.make.strip() if item.make is not None else None),
                ("model", item.model.strip() if item.model is not None else None),
                ("trim", item.trim.strip() if item.trim is not None else None),
                ("engine", item.engine.strip() if item.engine is not None else None),
                ("color", item.color.strip() if item.color is not None else None),
                ("mileage", item.mileage),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            ts = now_fn()
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            # A corrected VIN can mean this car is the same one already on file
            # from the other side of its life, so the unit has to be re-resolved
            # rather than left pointing where the typo put it.
            if item.vin is not None:
                unit_id = relink_unit(db, row["vehicle_id"], item.vin, ts)
            else:
                unit_id = unit_id_for_vehicle(db, row["vehicle_id"], ts)

            unit_fields, unit_params = [], []
            for name, value in (
                ("purchase_price", item.purchase_price),
                ("sale_price", item.sale_price),
                ("sale_date", item.sale_date.strip() if item.sale_date is not None else None),
            ):
                if value is not None:
                    unit_fields.append(f"{name}=?")
                    unit_params.append(value)
            if unit_fields:
                unit_params += [ts, unit_id]
                db.execute(f"UPDATE vehicle_units SET {','.join(unit_fields)},updated_at=? WHERE id=?", unit_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(ts)
                fields.append("edit_version=edit_version+1")
                params.append(recon_id)
                guard, guard_params = version_guard(item.expected_version)
                params.extend(guard_params)
                cur = db.execute(f"UPDATE recon_vehicles SET {','.join(fields)} WHERE id=?{guard}", params)
                # Raising here rolls back the vehicles/vehicle_units writes
                # above too -- they share this connection's transaction -- so a
                # lost race leaves nothing half-applied.
                assert_version_won(
                    cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
                )

            return recon_detail(db, recon_id)

    @router.delete("/recon/vehicles/{recon_id}", status_code=204)
    def delete_recon_vehicle(recon_id: int):
        with connect() as db:
            row = recon_row(db, recon_id)
            if db.execute("SELECT 1 FROM orders WHERE recon_vehicle_id=?", (recon_id,)).fetchone():
                raise HTTPException(
                    409, "Can't delete a vehicle with repair order history -- cancel or close its orders instead"
                )
            db.execute("DELETE FROM recon_vehicles WHERE id=?", (recon_id,))
            db.execute("DELETE FROM vehicles WHERE id=?", (row["vehicle_id"],))

    # --- We-owe items ---

    @router.post("/we-owe", status_code=201)
    def create_we_owe_item(item: WeOweIn):
        with connect() as db:
            vehicle = db.execute(
                "SELECT 1 FROM vehicles WHERE id=? AND customer_id=?", (item.vehicle_id, item.customer_id)
            ).fetchone()
            if not vehicle:
                raise HTTPException(400, "Vehicle does not belong to customer")
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO we_owe_items(customer_id,vehicle_id,description,category,promised_at,target_date,sale_reference,lot_stock_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    item.customer_id,
                    item.vehicle_id,
                    item.description.strip(),
                    item.category.strip() or "other",
                    ts,
                    item.target_date.strip(),
                    item.sale_reference.strip(),
                    item.lot_stock_number.strip().upper(),
                    ts,
                    ts,
                ),
            )
            # A we-owe is very often the first time a car is written down at
            # all -- bought and recon'd before RECON ever saw it. Recording
            # what it cost here is what makes its profit answerable later.
            # Only fills blanks: if this VIN already has a purchase price from
            # its recon life, that one is the record and stands.
            unit_id = unit_id_for_vehicle(db, item.vehicle_id, ts)
            if item.purchase_price is not None:
                db.execute(
                    "UPDATE vehicle_units SET purchase_price=?,updated_at=? WHERE id=? AND purchase_price=0",
                    (item.purchase_price, ts, unit_id),
                )
            if item.sale_price is not None:
                db.execute(
                    "UPDATE vehicle_units SET sale_price=?,updated_at=? WHERE id=? AND sale_price IS NULL",
                    (item.sale_price, ts, unit_id),
                )
            return we_owe_detail(db, inserted_id(cur))

    @router.get("/we-owe/{we_owe_id}")
    def get_we_owe_item(we_owe_id: int):
        with connect() as db:
            return we_owe_detail(db, we_owe_id)

    @router.post("/we-owe/{we_owe_id}/archive")
    def archive_we_owe_item(we_owe_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE we_owe_items SET archived_at=?,edit_version=edit_version+1 WHERE id=?{guard}",
                (now_fn(), we_owe_id, *guard_params),
            )
            assert_version_won(cur, "Someone else changed this item since you loaded it -- reload to see their update")
            return we_owe_detail(db, we_owe_id)

    @router.post("/we-owe/{we_owe_id}/reopen")
    def reopen_we_owe_item(we_owe_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE we_owe_items SET archived_at='',edit_version=edit_version+1 WHERE id=?{guard}",
                (we_owe_id, *guard_params),
            )
            assert_version_won(cur, "Someone else changed this item since you loaded it -- reload to see their update")
            return we_owe_detail(db, we_owe_id)

    @router.patch("/we-owe/{we_owe_id}")
    def update_we_owe_item(we_owe_id: int, item: WeOwePatch):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(
                    409, "Someone else changed this item since you loaded it -- reload to see their update"
                )
            fields: list[str] = []
            params: list[object] = []
            if item.status is not None:
                fields.append("status=?")
                params.append(item.status)
                fields.append("fulfilled_at=?")
                params.append(now_fn() if item.status == "fulfilled" else "")
            if item.description is not None:
                fields.append("description=?")
                params.append(item.description.strip())
            if item.category is not None:
                fields.append("category=?")
                params.append(item.category.strip() or "other")
            if item.target_date is not None:
                fields.append("target_date=?")
                params.append(item.target_date.strip())
            if item.lot_stock_number is not None:
                fields.append("lot_stock_number=?")
                params.append(item.lot_stock_number.strip().upper())

            # Core vehicle info (VIN, make/model, etc.) lives on the shared
            # vehicles table, not we_owe_items -- same pattern as recon.
            vehicle_fields: list[str] = []
            vehicle_params: list[object] = []
            for name, value in (
                ("vin", item.vin.strip().upper() if item.vin is not None else None),
                ("year", item.year),
                ("make", item.make.strip() if item.make is not None else None),
                ("model", item.model.strip() if item.model is not None else None),
                ("trim", item.trim.strip() if item.trim is not None else None),
                ("engine", item.engine.strip() if item.engine is not None else None),
                ("color", item.color.strip() if item.color is not None else None),
                ("mileage", item.mileage),
                ("odometer_broken", int(item.odometer_broken) if item.odometer_broken is not None else None),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            ts = now_fn()
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            # A VIN filled in after the fact is how a we-owe car finds the
            # recon record it already had -- so the unit is re-resolved and
            # the two halves of the car's life join up from that moment on.
            if item.vin is not None:
                unit_id = relink_unit(db, row["vehicle_id"], item.vin, ts)
            else:
                unit_id = unit_id_for_vehicle(db, row["vehicle_id"], ts)

            unit_fields, unit_params = [], []
            for name, value in (("purchase_price", item.purchase_price), ("sale_price", item.sale_price)):
                if value is not None:
                    unit_fields.append(f"{name}=?")
                    unit_params.append(value)
            if unit_fields:
                unit_params += [ts, unit_id]
                db.execute(f"UPDATE vehicle_units SET {','.join(unit_fields)},updated_at=? WHERE id=?", unit_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(ts)
                fields.append("edit_version=edit_version+1")
                params.append(we_owe_id)
                guard, guard_params = version_guard(item.expected_version)
                params.extend(guard_params)
                cur = db.execute(f"UPDATE we_owe_items SET {','.join(fields)} WHERE id=?{guard}", params)
                # Rolls back the vehicles/vehicle_units writes above with it --
                # same transaction, so a lost race applies nothing.
                assert_version_won(
                    cur, "Someone else changed this item since you loaded it -- reload to see their update"
                )
            return we_owe_detail(db, we_owe_id)

    @router.delete("/we-owe/{we_owe_id}", status_code=204)
    def delete_we_owe_item(we_owe_id: int):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            if db.execute("SELECT 1 FROM orders WHERE we_owe_id=?", (we_owe_id,)).fetchone():
                raise HTTPException(
                    409, "Can't delete a we-owe item with repair order history -- cancel or close its orders instead"
                )
            db.execute("DELETE FROM we_owe_items WHERE id=?", (we_owe_id,))

    @router.post("/we-owe/{we_owe_id}/payments", status_code=201)
    def add_we_owe_payment(we_owe_id: int, item: WeOwePaymentIn):
        with connect() as db:
            _assert_not_archived(we_owe_row(db, we_owe_id))
            db.execute(
                "INSERT INTO we_owe_payments(we_owe_id,amount,method,note,actor,created_at) VALUES(?,?,?,?,?,?)",
                (we_owe_id, item.amount, item.method, item.note.strip(), item.actor.strip(), now_fn()),
            )
            return we_owe_detail(db, we_owe_id)

    @router.delete("/we-owe/{we_owe_id}/payments/{payment_id}", status_code=204)
    def delete_we_owe_payment(we_owe_id: int, payment_id: int):
        with connect() as db:
            _assert_not_archived(we_owe_row(db, we_owe_id))
            if not db.execute(
                "SELECT 1 FROM we_owe_payments WHERE id=? AND we_owe_id=?", (payment_id, we_owe_id)
            ).fetchone():
                raise HTTPException(404, "Payment not found")
            db.execute("DELETE FROM we_owe_payments WHERE id=?", (payment_id,))

    return router
