from __future__ import annotations

import sqlite3
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    notes: str = ""
    assigned_to: str = ""
    due_date: str = ""
    urgent: bool = False
    actor: str = "ui"


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    notes: str | None = None
    assigned_to: str | None = None
    due_date: str | None = None
    urgent: bool | None = None
    done: bool | None = None


class SuggestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    author: str = ""


class SuggestionPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    resolved: bool | None = None


def build_tasks_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    # --- Tasks ---

    @router.get("/tasks")
    def list_tasks():
        with connect() as db:
            return [dict(row) for row in db.execute(
                """SELECT * FROM tasks
                   ORDER BY done, urgent DESC, coalesce(nullif(due_date,''), '9999-99-99'), id DESC"""
            )]

    @router.post("/tasks", status_code=201)
    def create_task(item: TaskIn):
        with connect() as db:
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO tasks(title,notes,assigned_to,due_date,urgent,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (item.title.strip(), item.notes.strip(), item.assigned_to.strip(), item.due_date.strip(), int(item.urgent), item.actor.strip(), ts, ts),
            )
            return dict(db.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone())

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
                fields.append("assigned_to=?"); params.append(item.assigned_to.strip())
            if item.due_date is not None:
                fields.append("due_date=?"); params.append(item.due_date.strip())
            if item.urgent is not None:
                fields.append("urgent=?"); params.append(int(item.urgent))
            if item.done is not None:
                fields.append("done=?"); params.append(int(item.done))
                fields.append("completed_at=?"); params.append(now_fn() if item.done else "")
            if fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                params.append(task_id)
                db.execute(f"UPDATE tasks SET {','.join(fields)} WHERE id=?", params)
            return dict(db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

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
