from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter

from .db import normalize_vin
from .recon import (
    LOT_READY,
    LOT_SETTLED,
    LOT_WAITING,
    LOT_WORKING,
    idle_days,
    unit_lifetimes,
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

    lifetimes = unit_lifetimes(db, [row["id"] for row in rows])
    result = []
    for row in rows:
        lifetime = lifetimes[row["id"]]
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
    """What each technician has worked on, is still holding, and how long.

    Deliberately reports no money. Labor on recon and we-owe is never charged
    out (see CLAUDE.md), so every labor line carries a zero cost and a
    "labor cost per technician" figure is a column of $0.00 dressed up as a
    result -- it sorted the table by a number that was always zero and put a
    chart of three empty bars on the screen. Hours worked, tickets touched,
    tickets finished and what is still sitting with each tech are the parts of
    this that are true and that somebody acts on.

    A ticket belongs to a technician if they are its assignee *or* they own a
    job on it, which is the same attribution the hours use -- counting hours
    one way and tickets another meant a tech pulled in for a single brake job
    showed three hours against zero repair orders.

    Voided tickets count for nothing, exactly as they do everywhere else in
    the app. Voiding means the work never happened, and a voided ticket is
    stored as complete (see workflow.void), so leaving them in credited
    whoever was assigned with a finished repair order for a mistake.
    """
    end_bound = f"{end}T23:59:59" if end else None
    technicians = db.execute("SELECT * FROM staff WHERE role='technician' ORDER BY name").fetchall()
    result = []
    for tech in technicians:
        # Voided tickets are left out of both halves of this, the same way
        # cost_rollup leaves them out of the money and the board leaves them
        # out of the car's status: a ticket taken back is work that never
        # happened, so crediting a technician with the order -- or with the
        # hours flagged on it before it was voided -- is crediting them with
        # nothing.
        # A ticket counts for a tech if they're its default assignee OR they
        # own any job on it -- the "only owns the brake job" case. DISTINCT
        # because a tech can be both at once, and the columns carry the two
        # timestamps the idle figure below is measured from.
        orders = db.execute(
            """SELECT DISTINCT o.id, o.status, o.created_at, o.last_activity_at
                 FROM orders o
                 LEFT JOIN order_workflow w ON w.order_id=o.id
                 LEFT JOIN estimates e ON e.order_id=o.id
                 LEFT JOIN estimate_jobs ej ON ej.estimate_id=e.id
                WHERE o.voided=0
                  AND (w.technician_id=:tech_id OR ej.technician_id=:tech_id)
                  AND (:start IS NULL OR o.created_at>=:start)
                  AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchall()
        # Labor is attributed to whichever technician actually owns it: a
        # job's own technician if the line is grouped under one, else the
        # ticket's default assignee -- so per-job reassignment (e.g. another
        # tech picks up just the brake job) shows up here instead of every
        # labor line on the RO being credited to whoever the ticket default is.
        totals = db.execute(
            """SELECT coalesce(sum(ei.quantity),0)
               FROM estimate_items ei
               JOIN estimates e ON e.id=ei.estimate_id
               JOIN orders o ON o.id=e.order_id
               LEFT JOIN estimate_jobs ej ON ej.id=ei.job_id
               LEFT JOIN order_workflow w ON w.order_id=o.id
               WHERE ei.kind='labor' AND coalesce(ej.technician_id, w.technician_id)=:tech_id AND o.voided=0
                 AND (:start IS NULL OR o.created_at>=:start) AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchone()
        # Still open: what this tech is holding right now. The worst idle
        # figure is measured the same way the board's Idle column is, off
        # last_activity_at, so "sitting 9 days" means the same thing on both
        # screens.
        open_orders = [row for row in orders if row["status"] != "complete"]
        idles = [idle_days(row["last_activity_at"] or row["created_at"]) for row in open_orders]
        result.append(
            {
                "technician": tech["name"],
                "ro_count": len(orders),
                "completed_count": sum(1 for row in orders if row["status"] == "complete"),
                "open_count": len(open_orders),
                "worst_idle_days": max(idles) if idles else 0,
                "labor_hours": round(totals[0], 2),
            }
        )
    return result


# The groups the lot report sorts cars into, in the order Walt reads them:
# what can go out, what is being worked, what has not been touched yet, and
# last the cars whose lot life is already over. Which pile a car is in is
# decided in recon.py, next to the board rows it is stamped onto; only the
# wording is a report concern.
LOT_GROUP_LABEL = {
    # "Ready to sell" was only ever true of Walt's lot cars. Half this board
    # is we-owe work on cars a customer already owns and is waiting on, and
    # telling the advisor to sell one of those is nonsense. "Ready to go"
    # covers both: the work is done and the car can leave.
    LOT_READY: "Ready to go",
    LOT_WORKING: "In the shop",
    LOT_WAITING: "Not started",
    # Deliberately not "Sold": half this pile is we-owe promises that were
    # fulfilled or waived on a customer's own car, which was never the lot's
    # to sell. What all of them have in common is that the shop is done and
    # the record is still sitting on the live board.
    LOT_SETTLED: "Finished — file away",
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
    # Settled cars last: they are the only pile that is not asking anybody to
    # do shop work, so they belong under the three that are.
    order = {LOT_READY: 0, LOT_WORKING: 1, LOT_WAITING: 2, LOT_SETTLED: 3}
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
        # Both sides of History (archived=None). This report is asked about a
        # stretch of time that has already happened, and the cars that stretch
        # was mostly about are the ones since sold and filed away -- leaving
        # them out meant every car dropped off this report the day it was
        # finished with, so "what did we spend last quarter" answered with
        # whatever happened to still be sitting on the lot today. Each row says
        # which side it is on (archived_at) so the screen can mark it.
        with connect() as db:
            return vehicle_board_rows(db, start, end, segment, archived=None)

    @router.get("/reports/vehicle-profit")
    def vehicle_profit(start: str | None = None, end: str | None = None, vin: str | None = None):
        with connect() as db:
            return vehicle_profit_rows(db, start, end, normalize_vin(vin))

    @router.get("/reports/technicians")
    def technician_productivity(start: str | None = None, end: str | None = None):
        with connect() as db:
            return technician_productivity_rows(db, start, end)

    return router
