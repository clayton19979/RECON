from __future__ import annotations

import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import inserted_id
from .recon import assert_vehicle_editable
from .workflow import assert_assignable, assert_estimate_editable, get_or_create_estimate, record_activity


class JobIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    technician_id: int | None = None
    actor: str = "ui"


class JobDoneIn(BaseModel):
    done: bool = True
    actor: str = "ui"


def build_jobs_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def order_row(db: sqlite3.Connection, order_id: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Repair order not found")
        return row

    def job_row(db: sqlite3.Connection, order_id: int, job_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT ej.* FROM estimate_jobs ej JOIN estimates e ON e.id=ej.estimate_id
               WHERE ej.id=? AND e.order_id=?""",
            (job_id, order_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Job not found on this repair order")
        return row

    def job_dict(db: sqlite3.Connection, job_id: int) -> dict:
        row = db.execute(
            """SELECT ej.*, s.name technician_name FROM estimate_jobs ej
               LEFT JOIN staff s ON s.id=ej.technician_id WHERE ej.id=?""",
            (job_id,),
        ).fetchone()
        return dict(row)

    def assert_valid_technician(
        db: sqlite3.Connection, technician_id: int | None, current_id: int | None = None
    ) -> None:
        """Whoever already owns this repair stays valid on it -- see
        assert_assignable. Renaming "Front brakes" is not the moment to
        discover that the tech who had it has left the shop."""
        assert_assignable(db, technician_id, {"technician"}, "Technician", current_id)

    @router.get("/jobs/usual-titles")
    def usual_job_titles(limit: int = 12):
        """The job names this shop actually writes, most-written first.

        Feeds the one-click choices in the Add Job dialog, so it comes from
        the shop's own tickets rather than a canned list -- a shop that does
        windshields all day sees "Windshield", not somebody's guess. Grouped
        case-insensitively; the spelling shown is whichever was written most
        recently (SQLite's bare-column-with-MAX(id) rule), so correcting a
        title's capitalization once eventually corrects the chip too.
        """
        limit = max(1, min(limit, 30))
        with connect() as db:
            rows = db.execute(
                """SELECT trim(title) AS title, max(id)
                   FROM estimate_jobs WHERE trim(title) != ''
                   GROUP BY lower(trim(title))
                   ORDER BY count(*) DESC, max(id) DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
        return [row["title"] for row in rows]

    @router.post("/orders/{order_id}/jobs", status_code=201)
    def create_job(order_id: int, item: JobIn):
        with connect() as db:
            order = order_row(db, order_id)
            assert_vehicle_editable(db, order)
            assert_estimate_editable(db, order_id)
            assert_valid_technician(db, item.technician_id)
            estimate = get_or_create_estimate(db, order_id, now_fn)
            next_sort = db.execute(
                "SELECT coalesce(max(sort_order),-1)+1 FROM estimate_jobs WHERE estimate_id=?", (estimate["id"],)
            ).fetchone()[0]
            cur = db.execute(
                "INSERT INTO estimate_jobs(estimate_id,title,technician_id,sort_order,created_at) VALUES(?,?,?,?,?)",
                (estimate["id"], item.title.strip(), item.technician_id, next_sort, now_fn()),
            )
            job_id = inserted_id(cur)
            record_activity(
                db, order_id, "job_created", item.actor, {"job_id": job_id, "title": item.title.strip()}, now_fn
            )
            return job_dict(db, job_id)

    @router.put("/orders/{order_id}/jobs/{job_id}")
    def update_job(order_id: int, job_id: int, item: JobIn):
        with connect() as db:
            order = order_row(db, order_id)
            assert_vehicle_editable(db, order)
            assert_estimate_editable(db, order_id)
            job = job_row(db, order_id, job_id)
            assert_valid_technician(db, item.technician_id, job["technician_id"])
            db.execute(
                "UPDATE estimate_jobs SET title=?,technician_id=? WHERE id=?",
                (item.title.strip(), item.technician_id, job_id),
            )
            record_activity(
                db, order_id, "job_updated", item.actor, {"job_id": job_id, "title": item.title.strip()}, now_fn
            )
            return job_dict(db, job_id)

    @router.patch("/orders/{order_id}/jobs/{job_id}/done")
    def set_job_done(order_id: int, job_id: int, item: JobDoneIn):
        """Tick a repair off, or put it back.

        Deliberately does NOT call assert_estimate_editable. That guard exists
        to freeze the *money* on a ticket once it's been billed out, and
        whether the brake job is finished is not a number on an invoice --
        locking it would leave a retail ticket's work permanently un-tickable
        while the car is still in the bay. Voided and archived vehicles are
        still blocked (assert_vehicle_editable): there is no work left to
        record on a ticket that never happened.

        Ticking a job is real work happening on the car, so it goes through
        record_activity -- which bumps the ticket's idle clock. That matters:
        finishing a repair is exactly the moment a car should stop counting as
        forgotten, and before this it was invisible to the board unless
        somebody also happened to change the ticket's status.
        """
        with connect() as db:
            order = order_row(db, order_id)
            assert_vehicle_editable(db, order)
            job = job_row(db, order_id, job_id)
            already_done = bool(job["completed_at"])
            if already_done == item.done:
                return job_dict(db, job_id)
            actor = item.actor.strip() or "ui"
            db.execute(
                "UPDATE estimate_jobs SET completed_at=?,completed_by=? WHERE id=?",
                (now_fn() if item.done else "", actor if item.done else "", job_id),
            )
            record_activity(
                db,
                order_id,
                "job_completed" if item.done else "job_reopened",
                actor,
                {"job_id": job_id, "title": job["title"]},
                now_fn,
            )
            return job_dict(db, job_id)

    @router.delete("/orders/{order_id}/jobs/{job_id}", status_code=204)
    def delete_job(order_id: int, job_id: int, actor: str = "ui"):
        with connect() as db:
            order = order_row(db, order_id)
            assert_vehicle_editable(db, order)
            assert_estimate_editable(db, order_id)
            job = job_row(db, order_id, job_id)
            # Deleting a job un-groups its lines back to General -- the parts
            # and labor themselves are never touched, only how they're grouped.
            db.execute("UPDATE estimate_items SET job_id=NULL WHERE job_id=?", (job_id,))
            db.execute("DELETE FROM estimate_jobs WHERE id=?", (job_id,))
            record_activity(db, order_id, "job_deleted", actor, {"job_id": job_id, "title": job["title"]}, now_fn)

    return router
