from __future__ import annotations

import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .recon import assert_vehicle_editable
from .workflow import assert_estimate_editable, get_or_create_estimate, record_activity


class JobIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    technician_id: int | None = None
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

    def assert_valid_technician(db: sqlite3.Connection, technician_id: int | None) -> None:
        if technician_id is None:
            return
        staff = db.execute("SELECT role,active FROM staff WHERE id=?", (technician_id,)).fetchone()
        if not staff or not staff["active"] or staff["role"] != "technician":
            raise HTTPException(400, "Technician is not an active technician")

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
            record_activity(
                db, order_id, "job_created", item.actor, {"job_id": cur.lastrowid, "title": item.title.strip()}, now_fn
            )
            return job_dict(db, cur.lastrowid)

    @router.put("/orders/{order_id}/jobs/{job_id}")
    def update_job(order_id: int, job_id: int, item: JobIn):
        with connect() as db:
            order = order_row(db, order_id)
            assert_vehicle_editable(db, order)
            assert_estimate_editable(db, order_id)
            job_row(db, order_id, job_id)
            assert_valid_technician(db, item.technician_id)
            db.execute(
                "UPDATE estimate_jobs SET title=?,technician_id=? WHERE id=?",
                (item.title.strip(), item.technician_id, job_id),
            )
            record_activity(
                db, order_id, "job_updated", item.actor, {"job_id": job_id, "title": item.title.strip()}, now_fn
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
