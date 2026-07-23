from __future__ import annotations

import json

from app.db import connect, init_db


def test_status_migration_maps_old_values_and_is_idempotent(tmp_path):
    db_path = tmp_path / "legacy.db"
    init_db(db_path)

    with connect(db_path) as db:
        customer_id = db.execute(
            "INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,?)",
            ("Retail Customer", "", "", 0, "2026-01-01T00:00:00"),
        ).lastrowid
        vehicle_id = db.execute(
            "INSERT INTO vehicles(customer_id,year,make,model,created_at) VALUES(?,?,?,?,?)",
            (customer_id, 2020, "Kia", "Soul", "2026-01-01T00:00:00"),
        ).lastrowid

        old_statuses = ["draft", "inspection", "awaiting_approval", "approved", "in_progress", "completed", "closed", "cancelled"]
        order_ids: dict[str, int] = {}
        for i, status in enumerate(old_statuses):
            order_id = db.execute(
                "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,status,created_at) VALUES(?,?,?,?,?,?,?)",
                (f"RO-LEGACY-{i:04d}", customer_id, vehicle_id, "Legacy row", "retail", status, "2026-01-01T00:00:00"),
            ).lastrowid
            order_ids[status] = order_id
        db.commit()

    # Re-running init_db (as happens on every app start) must migrate the
    # legacy statuses forward -- and be a no-op the second time.
    init_db(db_path)

    with connect(db_path) as db:
        rows = {row["number"]: dict(row) for row in db.execute("SELECT * FROM orders")}

    expected = {
        "draft": "estimate",
        "inspection": "estimate",
        "awaiting_approval": "pending_approval",
        "approved": "in_progress",
        "in_progress": "in_progress",
        "completed": "complete",
        "closed": "complete",
        "cancelled": "complete",
    }
    for old_status, new_status in expected.items():
        row = rows[f"RO-LEGACY-{old_statuses.index(old_status):04d}"]
        assert row["status"] == new_status, f"{old_status} should map to {new_status}, got {row['status']}"
        assert row["voided"] == (1 if old_status == "cancelled" else 0)

    # Idempotent: running init_db again doesn't change anything further.
    init_db(db_path)
    with connect(db_path) as db:
        rows_again = {row["number"]: dict(row) for row in db.execute("SELECT * FROM orders")}
    assert rows_again == rows


def test_date_in_backfills_from_order_created_at_and_is_idempotent(tmp_path):
    db_path = tmp_path / "legacy_workflow.db"
    init_db(db_path)

    with connect(db_path) as db:
        customer_id = db.execute(
            "INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,?)",
            ("Retail Customer", "", "", 0, "2026-01-01T00:00:00"),
        ).lastrowid
        vehicle_id = db.execute(
            "INSERT INTO vehicles(customer_id,year,make,model,created_at) VALUES(?,?,?,?,?)",
            (customer_id, 2020, "Kia", "Soul", "2026-01-01T00:00:00"),
        ).lastrowid
        order_id = db.execute(
            "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,status,created_at) VALUES(?,?,?,?,?,?,?)",
            ("RO-LEGACY-0001", customer_id, vehicle_id, "Legacy row", "retail", "estimate", "2026-03-04T09:15:00"),
        ).lastrowid
        db.execute("INSERT INTO order_workflow(order_id) VALUES(?)", (order_id,))
        # init_db's own SCHEMA already includes date_in (it's a live column
        # now, not a hypothetical future one) -- drop it back off to actually
        # simulate a database from before this column existed.
        db.execute("ALTER TABLE order_workflow DROP COLUMN date_in")
        db.commit()

    init_db(db_path)

    with connect(db_path) as db:
        row = db.execute("SELECT date_in FROM order_workflow WHERE order_id=?", (order_id,)).fetchone()
    assert row["date_in"] == "2026-03-04"

    # Idempotent: a real (non-blank) date_in is never overwritten on a later start.
    with connect(db_path) as db:
        db.execute("UPDATE order_workflow SET date_in='2026-01-01' WHERE order_id=?", (order_id,))
        db.commit()
    init_db(db_path)
    with connect(db_path) as db:
        row_again = db.execute("SELECT date_in FROM order_workflow WHERE order_id=?", (order_id,)).fetchone()
    assert row_again["date_in"] == "2026-01-01"


def test_task_assigned_to_migrates_plain_string_to_json_list_and_is_idempotent(tmp_path):
    db_path = tmp_path / "legacy_tasks.db"
    init_db(db_path)

    with connect(db_path) as db:
        with_name = db.execute(
            "INSERT INTO tasks(title,assigned_to,created_at,updated_at) VALUES(?,?,?,?)",
            ("Legacy task with an assignee", "Antonio", "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
        ).lastrowid
        unassigned = db.execute(
            "INSERT INTO tasks(title,assigned_to,created_at,updated_at) VALUES(?,?,?,?)",
            ("Legacy task with no assignee", "", "2026-01-01T00:00:00", "2026-01-01T00:00:00"),
        ).lastrowid
        db.commit()

    init_db(db_path)

    with connect(db_path) as db:
        rows = {row["id"]: dict(row) for row in db.execute("SELECT * FROM tasks")}
    assert json.loads(rows[with_name]["assigned_to"]) == ["Antonio"]
    assert json.loads(rows[unassigned]["assigned_to"]) == []

    # Idempotent: already-migrated (list) values are left alone.
    init_db(db_path)
    with connect(db_path) as db:
        rows_again = {row["id"]: dict(row) for row in db.execute("SELECT * FROM tasks")}
    assert rows_again == rows
