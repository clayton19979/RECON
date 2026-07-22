from __future__ import annotations

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
