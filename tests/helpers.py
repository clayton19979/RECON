from __future__ import annotations

from datetime import datetime, timedelta

from app.db import connect


def days_ago(days: int) -> str:
    """A timestamp `days` in the past, on the same shop-local clock app/db.py
    stamps records with -- see its now() for why that isn't UTC."""
    return (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")


def backdate_activity(db_path, order_id: int, when: str) -> None:
    """Push a ticket's last activity back in time.

    There's no API for "pretend nobody has touched this for a month" -- every
    write moves the clock forward, which is the point of it -- and freezing the
    clock app-wide would only prove the arithmetic, not that the column is
    wired to the right source. So the test opens the same database file the
    app is using, which is what the db_path fixture exists for.
    """
    with connect(db_path) as db:
        db.execute("UPDATE orders SET last_activity_at=? WHERE id=?", (when, order_id))
        db.commit()


def make_recon_vehicle(client, stock_number="R-1001", **overrides):
    payload = {
        "stock_number": stock_number,
        "year": 2019,
        "make": "Honda",
        "model": "Civic",
        "vin": "1HGCM82633A004352",
        "mileage": 60000,
        "purchase_price": 4000,
        "acquisition_source": "auction",
        "acquisition_date": "2026-01-01",
    }
    payload.update(overrides)
    res = client.post("/api/recon/vehicles", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def make_we_owe(client, customer_name="Jordan Whitfield", description="Fix mirror", **overrides):
    customer = client.post("/api/customers", json={"name": customer_name}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2020, "make": "Kia", "model": "Soul"},
    ).json()
    payload = {"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": description}
    payload.update(overrides)
    res = client.post("/api/we-owe", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def make_recon_order(client, recon_id, concern="Recon prep"):
    res = client.post("/api/orders", json={"concern": concern, "segment": "recon", "recon_vehicle_id": recon_id})
    assert res.status_code == 201, res.text
    return res.json()


def make_retail_order(client, concern="Check engine light"):
    customer = client.post("/api/customers", json={"name": "Retail Customer"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2018, "make": "Ford", "model": "Focus"},
    ).json()
    res = client.post(
        "/api/orders",
        json={"concern": concern, "segment": "retail", "customer_id": customer["id"], "vehicle_id": vehicle["id"]},
    )
    assert res.status_code == 201, res.text
    return res.json()


def save_estimate(client, order_id, items, actor="tester"):
    res = client.post(f"/api/orders/{order_id}/estimate", json={"actor": actor, "items": items})
    assert res.status_code == 200, res.text
    return res.json()
