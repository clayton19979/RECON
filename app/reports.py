from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter

from .db import normalize_vin
from .recon import is_stalled, unit_lifetime, vehicle_board_rows


def vehicle_profit_rows(
    db: sqlite3.Connection, start: str | None, end: str | None, vin: str | None = None
) -> list[dict]:
    """One row per physical car: what it cost, what it sold for, what's left.

    Keyed on the unit rather than on a recon record or a we-owe promise, which
    is the only way the answer survives the car's own history -- a car bought,
    recon'd, sold, and then brought back weeks later on a we-owe has its
    purchase price on one record and that last repair bill on another, and
    the owner's question ("what did we actually make on it?") spans both.

    The date range filters on when the car was acquired or first written down,
    not on when each cost landed: a car bought in March whose we-owe work
    lands in May still belongs to March's numbers, because that's the car
    whose margin the range is asking about.

    Only the lot's own cars are listed -- a car with a recon record or a we-owe
    promise on it. A retail customer's car has a unit of its own the moment a
    ticket is written for it, and those were being listed too: the lot never
    bought them and never sold them, so every one arrived as a permanent
    all-zero row that could not be filtered out and never went away. On a shop
    that writes retail tickets every day they outnumber the lot's cars within
    weeks and bury the handful of rows the report exists for. Worse, the
    summary above the table counted them, so a lot holding three unsold cars
    reported fifteen "still in stock".

    A VIN lookup is exempt, because it is a different question. It is asked at
    we-owe intake -- "do we already know this car?" -- about a car that may
    only ever have been through here as a retail customer's, and answering
    "never seen it" would be how a second, conflicting record gets typed.
    """
    end_bound = f"{end}T23:59:59" if end else None
    rows = db.execute(
        """SELECT DISTINCT u.id, u.created_at,
                  (SELECT v.year || ' ' || v.make || ' ' || v.model FROM vehicles v
                    WHERE v.unit_id = u.id ORDER BY v.id LIMIT 1) description,
                  (SELECT v.vin FROM vehicles v WHERE v.unit_id = u.id AND v.vin != '' ORDER BY v.id LIMIT 1) vin,
                  (SELECT rv.stock_number FROM recon_vehicles rv JOIN vehicles v ON v.id = rv.vehicle_id
                    WHERE v.unit_id = u.id ORDER BY rv.id LIMIT 1) stock_number
             FROM vehicle_units u
             JOIN vehicles vv ON vv.unit_id = u.id
            WHERE (:start IS NULL OR u.created_at >= :start)
              AND (:end IS NULL OR u.created_at <= :end)
              AND (:vin IS NULL OR u.vin_key = :vin)
              AND (:vin IS NOT NULL
                   OR EXISTS (SELECT 1 FROM recon_vehicles rv JOIN vehicles v ON v.id = rv.vehicle_id
                               WHERE v.unit_id = u.id)
                   OR EXISTS (SELECT 1 FROM we_owe_items w JOIN vehicles v ON v.id = w.vehicle_id
                               WHERE v.unit_id = u.id))
            ORDER BY u.created_at DESC""",
        {"start": start, "end": end_bound, "vin": vin},
    ).fetchall()

    result = []
    for row in rows:
        lifetime = unit_lifetime(db, row["id"])
        result.append(
            {
                **lifetime,
                "vin": row["vin"] or lifetime["vin"],
                "stock_number": row["stock_number"] or "",
                "vehicle": row["description"] or "",
                "acquired_at": row["created_at"],
            }
        )
    return result


def technician_productivity_rows(db: sqlite3.Connection, start: str | None, end: str | None) -> list[dict]:
    end_bound = f"{end}T23:59:59" if end else None
    technicians = db.execute("SELECT * FROM staff WHERE role='technician' ORDER BY name").fetchall()
    result = []
    for tech in technicians:
        orders = db.execute(
            """SELECT o.id, o.status FROM orders o JOIN order_workflow w ON w.order_id=o.id
               WHERE w.technician_id=:tech_id AND (:start IS NULL OR o.created_at>=:start) AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchall()
        # Labor is attributed to whichever technician actually owns it: a
        # job's own technician if the line is grouped under one, else the
        # ticket's default assignee -- so per-job reassignment (e.g. another
        # tech picks up just the brake job) shows up here instead of every
        # labor line on the RO being credited to whoever the ticket default is.
        totals = db.execute(
            """SELECT coalesce(sum(ei.quantity),0), coalesce(sum(ei.quantity*ei.unit_cost),0)
               FROM estimate_items ei
               JOIN estimates e ON e.id=ei.estimate_id
               JOIN orders o ON o.id=e.order_id
               LEFT JOIN estimate_jobs ej ON ej.id=ei.job_id
               LEFT JOIN order_workflow w ON w.order_id=o.id
               WHERE ei.kind='labor' AND coalesce(ej.technician_id, w.technician_id)=:tech_id
                 AND (:start IS NULL OR o.created_at>=:start) AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchone()
        labor_hours, labor_cost = totals[0], totals[1]
        result.append(
            {
                "technician": tech["name"],
                "ro_count": len(orders),
                "completed_count": sum(1 for row in orders if row["status"] == "complete"),
                "labor_hours": round(labor_hours, 2),
                "labor_cost": round(labor_cost, 2),
            }
        )
    return result


# The three groups the lot report sorts cars into, in the order Walt reads
# them: what can go out, what is being worked, what has not been touched yet.
LOT_READY = "ready"
LOT_WORKING = "working"
LOT_WAITING = "waiting"

LOT_GROUP_LABEL = {
    LOT_READY: "Ready to sell",
    LOT_WORKING: "In the shop",
    LOT_WAITING: "Not started",
}


def lot_needs_text(row: dict) -> str:
    """One plain sentence answering "what does this car still need?".

    Built on the server rather than in the browser so the screen, the printed
    sheet and the CSV cannot drift into three different phrasings of the same
    car -- Walt reads whichever one is in front of him and they have to agree.
    """
    if row["lot_bucket"] == LOT_READY:
        return "Nothing — ready to go"

    bits = []
    if row["status"] == "pending_approval":
        bits.append("waiting on approval")
    if not row.get("order_id"):
        bits.append("no ticket written yet")
    elif row["status"] == "estimate" and row["lot_bucket"] == LOT_WAITING:
        # Only true while nothing has actually been spent or ordered -- see
        # lot_bucket. Saying it about a car with parts in it reads as a
        # contradiction of the money on the same row.
        bits.append("quoted, work not started")

    pending = row.get("parts_pending") or 0
    if pending:
        value = row.get("parts_pending_value") or 0
        amount = f" (${value:,.2f})" if value else ""
        bits.append(f"{pending} part{'' if pending == 1 else 's'} on order{amount}")

    if row["remaining_cost"]:
        bits.append(f"${row['remaining_cost']:,.2f} of quoted work left")

    # Only worth saying once a car has actually gone quiet; every car is idle
    # for a day or two between visits and flagging that is just noise. Same
    # is_stalled the board's card uses, so the two screens can't disagree
    # about which cars have been forgotten.
    if is_stalled(row):
        bits.append(f"untouched {row['idle_days']} days")

    if not bits:
        return "work under way"
    return " · ".join(bits).capitalize()


def lot_bucket(row: dict) -> str:
    """Which of Walt's three piles this car is in.

    Driven by the repair ticket, same as the board -- the recon record has a
    status field of its own but nobody maintains it, and a report that reads
    the field nobody updates is a report that quietly lies.

    Money already spent or parts already on order also count as started, no
    matter what the ticket still says. A ticket sits on "Estimate" until
    somebody thinks to move it, so grouping on status alone put cars with
    hundreds of dollars of parts in them under a heading that read "Not
    started" -- and the group's own subtotal then contradicted its title on
    the same line. What has actually happened to the car wins over what the
    ticket was last set to.
    """
    if row["status_bucket"] == "finished":
        return LOT_READY
    if row["status"] in ("in_progress", "pending_approval"):
        return LOT_WORKING
    if (row.get("actual_cost") or 0) > 0 or (row.get("parts_pending") or 0) > 0:
        return LOT_WORKING
    return LOT_WAITING


def lot_rows(db: sqlite3.Connection) -> list[dict]:
    """Every live car on the lot as it stands right now.

    Deliberately unfiltered by date, which is the whole point of this report.
    The spend report windows on when a car was *acquired*, so a car bought in
    July and still sitting unfinished in September falls out of the default
    "This Month" view -- and that is exactly the car Walt is asking about. His
    questions ("what's ready, what's being worked on, what does it still
    need") are about the lot today, not about a date range.

    Built on the same vehicle_board_rows the job board uses, so the costs and
    the statuses here can never disagree with the board's.
    """
    rows = vehicle_board_rows(db)
    for row in rows:
        row["lot_bucket"] = lot_bucket(row)
        # Quoted but not yet spent: what finishing this car should still cost.
        # Floored at zero -- going over the estimate is real, but it is money
        # already counted in what we spent, not money still to come.
        #
        # Zero on a finished car, whatever the quote said. Nothing is open on
        # it, so nobody is going to spend that money: a car that came in under
        # its estimate was putting the difference in the "still to spend"
        # column and into the lot's total, on the same row whose Needs cell
        # read "Nothing -- ready to go". Two answers to one question, one line
        # apart. The shortfall against the quote is still visible where it
        # belongs, in the board's Cost-against-quote column.
        row["remaining_cost"] = (
            0.0 if row["lot_bucket"] == LOT_READY else max(round(row["quoted_cost"] - row["actual_cost"], 2), 0)
        )
        row["needs"] = lot_needs_text(row)
    order = {LOT_READY: 0, LOT_WORKING: 1, LOT_WAITING: 2}
    # Within a group, the longest-idle car first: the one most likely to have
    # been forgotten is the one Walt most needs to be asked about.
    rows.sort(key=lambda r: (order[r["lot_bucket"]], -r["idle_days"]))
    return rows


def build_reports_router(connect: Callable[[], sqlite3.Connection]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/reports/lot")
    def lot():
        with connect() as db:
            return lot_rows(db)

    @router.get("/reports/vehicle-spend")
    def vehicle_spend(
        start: str | None = None, end: str | None = None, segment: Literal["recon", "we_owe"] | None = None
    ):
        with connect() as db:
            return vehicle_board_rows(db, start, end, segment)

    @router.get("/reports/vehicle-profit")
    def vehicle_profit(start: str | None = None, end: str | None = None, vin: str | None = None):
        with connect() as db:
            return vehicle_profit_rows(db, start, end, normalize_vin(vin))

    @router.get("/reports/technicians")
    def technician_productivity(start: str | None = None, end: str | None = None):
        with connect() as db:
            return technician_productivity_rows(db, start, end)

    return router
