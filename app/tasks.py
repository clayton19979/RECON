from __future__ import annotations

import json
import sqlite3
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


def _clean_names(names: list[str]) -> list[str]:
    """Trims and dedupes while keeping first-seen order."""
    return list(dict.fromkeys(n.strip() for n in names if n.strip()))


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    notes: str = ""
    assigned_to: list[str] = []
    due_date: str = ""
    urgent: bool = False
    order_id: int | None = None
    actor: str = "ui"


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    notes: str | None = None
    assigned_to: list[str] | None = None
    due_date: str | None = None
    urgent: bool | None = None
    done: bool | None = None
    order_id: int | None = Field(default=None, description="Use -1 to clear an existing link")


class SuggestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    author: str = ""


class SuggestionPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    resolved: bool | None = None


def build_tasks_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    # --- Tasks ---

    # A task's linked order shows a "jump to vehicle" chip -- resolved here
    # rather than making the frontend cross-reference /api/orders itself.
    task_query = """
        SELECT t.*, o.number order_number, o.segment order_segment,
               o.recon_vehicle_id order_recon_vehicle_id, o.we_owe_id order_we_owe_id,
               rv.stock_number, wc.name we_owe_customer_name
        FROM tasks t
        LEFT JOIN orders o ON o.id=t.order_id
        LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
        LEFT JOIN we_owe_items wi ON wi.id=o.we_owe_id
        LEFT JOIN customers wc ON wc.id=wi.customer_id
    """

    def task_dict(row: sqlite3.Row) -> dict:
        value = dict(row)
        value["assigned_to"] = json.loads(value["assigned_to"]) if value["assigned_to"] else []
        if value["order_id"] is None:
            value["order_label"] = None
        elif value["stock_number"]:
            value["order_label"] = value["stock_number"]
        elif value["we_owe_customer_name"]:
            value["order_label"] = f"We-Owe: {value['we_owe_customer_name']}"
        else:
            value["order_label"] = value["order_number"]
        return value

    def assert_valid_order(db: sqlite3.Connection, order_id: int | None) -> None:
        if order_id is None:
            return
        if not db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
            raise HTTPException(404, "Repair order not found")

    @router.get("/tasks")
    def list_tasks():
        with connect() as db:
            return [task_dict(row) for row in db.execute(
                task_query + " ORDER BY t.done, t.urgent DESC, coalesce(nullif(t.due_date,''), '9999-99-99'), t.id DESC"
            )]

    @router.post("/tasks", status_code=201)
    def create_task(item: TaskIn):
        with connect() as db:
            assert_valid_order(db, item.order_id)
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO tasks(title,notes,assigned_to,due_date,urgent,order_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (item.title.strip(), item.notes.strip(), json.dumps(_clean_names(item.assigned_to)), item.due_date.strip(), int(item.urgent), item.order_id, item.actor.strip(), ts, ts),
            )
            return task_dict(db.execute(task_query + " WHERE t.id=?", (cur.lastrowid,)).fetchone())

    @router.patch("/tasks/{task_id}")
    def update_task(task_id: int, item: TaskPatch):
        with connect() as db:
            if not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise HTTPException(404, "Task not found")
            fields: list[str] = []
            params: list[object] = []
            if item.title is not None:
                fields.append("title=?"); params.append(item.title.strip())
            if item.notes is not None:
                fields.append("notes=?"); params.append(item.notes.strip())
            if item.assigned_to is not None:
                fields.append("assigned_to=?"); params.append(json.dumps(_clean_names(item.assigned_to)))
            if item.due_date is not None:
                fields.append("due_date=?"); params.append(item.due_date.strip())
            if item.urgent is not None:
                fields.append("urgent=?"); params.append(int(item.urgent))
            if item.done is not None:
                fields.append("done=?"); params.append(int(item.done))
                fields.append("completed_at=?"); params.append(now_fn() if item.done else "")
            if item.order_id is not None:
                # -1 is the "unlink" sentinel -- None already means "field
                # not sent" for a PATCH, so a real NULL needs its own value.
                new_order_id = None if item.order_id == -1 else item.order_id
                assert_valid_order(db, new_order_id)
                fields.append("order_id=?"); params.append(new_order_id)
            if fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                params.append(task_id)
                db.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", params)
            return task_dict(db.execute(task_query + " WHERE t.id=?", (task_id,)).fetchone())

    @router.delete("/tasks/{task_id}", status_code=204)
    def delete_task(task_id: int):
        with connect() as db:
            if not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise HTTPException(404, "Task not found")
            db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        return None

    # --- Suggestions ---

    @router.get("/suggestions")
    def list_suggestions():
        with connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM suggestions ORDER BY resolved, id DESC")]

    @router.post("/suggestions", status_code=201)
    def create_suggestion(item: SuggestionIn):
        with connect() as db:
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO suggestions(text,author,created_at,updated_at) VALUES(?,?,?,?)",
                (item.text.strip(), item.author.strip(), ts, ts),
            )
            return dict(db.execute("SELECT * FROM suggestions WHERE id=?", (cur.lastrowid,)).fetchone())

    @router.patch("/suggestions/{suggestion_id}")
    def update_suggestion(suggestion_id: int, item: SuggestionPatch):
        with connect() as db:
            if not db.execute("SELECT 1 FROM suggestions WHERE id=?", (suggestion_id,)).fetchone():
                raise HTTPException(404, "Suggestion not found")
            fields: list[str] = []
            params: list[object] = []
            if item.text is not None:
                fields.append("text=?"); params.append(item.text.strip())
            if item.resolved is not None:
                fields.append("resolved=?"); params.append(int(item.resolved))
            if fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                params.append(suggestion_id)
                db.execute(f"UPDATE suggestions SET {','.join(fields)} WHERE id=?", params)
            return dict(db.execute("SELECT * FROM suggestions WHERE id=?", (suggestion_id,)).fetchone())

    @router.delete("/suggestions/{suggestion_id}", status_code=204)
    def delete_suggestion(suggestion_id: int):
        with connect() as db:
            if not db.execute("SELECT 1 FROM suggestions WHERE id=?", (suggestion_id,)).fetchone():
                raise HTTPException(404, "Suggestion not found")
            db.execute("DELETE FROM suggestions WHERE id=?", (suggestion_id,))
        return None

    return router
