from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter

from .db import normalize_vin
from .recon import (
    LOT_READY,
    LOT_WAITING,
    LOT_WORKING,
    unit_lifetime,
    vehicle_board_rows,
)


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
# Which pile a car is in is decided in recon.py, next to the board rows it is
# stamped onto; only the wording is a report concern.
LOT_GROUP_LABEL = {
    LOT_READY: "Ready to sell",
    LOT_WORKING: "In the shop",
    LOT_WAITING: "Not started",
}


def lot_rows(db: sqlite3.Connection) -> list[dict]:
    """Every live car on the lot as it stands right now.

    Deliberately unfiltered by date, which is the whole point of this report.
    The spend report windows on when a car was *acquired*, so a car bought in
    July and still sitting unfinished in September falls out of the default
    "This Month" view -- and that is exactly the car Walt is asking about. His
    questions ("what's ready, what's being worked on, what does it still
    need") are about the lot today, not about a date range.

    Built on the same vehicle_board_rows the job board uses, so the costs, the
    statuses and the grouping here can never disagree with the board's -- the
    rows arrive already stamped with their pile, what's left to spend on them
    and what each one is waiting on. All this adds is Walt's reading order.
    """
    rows = vehicle_board_rows(db)
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
