from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def test_create_recon_vehicle(client):
    vehicle = make_recon_vehicle(client)
    assert vehicle["stock_number"] == "R-1001"
    assert vehicle["status"] == "acquired"
    assert vehicle["total_cost"] == 0
    assert vehicle["quoted_cost"] == 0


def test_duplicate_stock_number_rejected(client):
    make_recon_vehicle(client, stock_number="R-2001")
    res = client.post(
        "/api/recon/vehicles",
        json={"stock_number": "R-2001", "year": 2020, "make": "Toyota", "model": "Camry"},
    )
    assert res.status_code == 409


def test_recon_patch_status_and_sale(client):
    vehicle = make_recon_vehicle(client)
    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"status": "sold", "sale_price": 8000, "sale_date": "2026-03-01"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "sold"
    # profit = sale_price - purchase_price - total_cost = 8000 - 4000 - 0
    assert body["profit"] == 4000


def test_we_owe_requires_vehicle_belongs_to_customer(client):
    customer = client.post("/api/customers", json={"name": "A"}).json()
    other_customer = client.post("/api/customers", json={"name": "B"}).json()
    vehicle = client.post(
        "/api/vehicles", json={"customer_id": other_customer["id"], "year": 2020, "make": "Kia", "model": "Soul"}
    ).json()
    res = client.post(
        "/api/we-owe",
        json={"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": "Fix mirror"},
    )
    assert res.status_code == 400


def test_we_owe_fulfilled_sets_timestamp(client):
    item = make_we_owe(client)
    assert item["status"] == "open"
    res = client.patch(f"/api/we-owe/{item['id']}", json={"status": "fulfilled"})
    body = res.json()
    assert body["status"] == "fulfilled"
    assert body["fulfilled_at"]


def test_cancelled_order_does_not_count_toward_vehicle_cost(client):
    """A cancelled RO is kept in the vehicle's order history for traceability
    but its cost must never count toward the vehicle's actual/quoted totals --
    that work was never actually done."""
    vehicle = make_recon_vehicle(client, stock_number="R-4501")
    live_order = make_recon_order(client, vehicle["id"], concern="Real work")
    save_estimate(client, live_order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])

    cancelled_order = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(client, cancelled_order["id"], [{"kind": "part", "description": "Wrong part", "part_number": "X-1", "quantity": 1, "unit_price": 300, "unit_cost": 300}])
    client.patch(f"/api/orders/{cancelled_order['id']}/status", json={"status": "cancelled"})

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 100
    assert detail["quoted_cost"] == 100
    assert len(detail["orders"]) == 2  # still visible in history
    assert any(o["status"] == "cancelled" for o in detail["orders"])


def test_vehicles_board_merges_segments(client):
    make_recon_vehicle(client, stock_number="R-3001")
    make_we_owe(client)
    board = client.get("/api/vehicles-board").json()
    segments = {row["segment"] for row in board}
    assert segments == {"recon", "we_owe"}

    recon_only = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert all(row["segment"] == "recon" for row in recon_only)


def test_cost_rollup_actual_vs_quoted(client):
    """Core business rule: labor counts in full immediately; parts only
    count once received. quoted_cost always reflects the full estimate."""
    vehicle = make_recon_vehicle(client, stock_number="R-4001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 2, "unit_price": 10, "unit_cost": 10},
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 50, "unit_cost": 50},
        ],
    )
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    # No parts received yet: actual = labor only = 50; quoted = full estimate = 2*10 + 50 = 70
    assert detail["total_cost"] == 50
    assert detail["quoted_cost"] == 70

    # Receive the part via a vendor invoice (the only way received_quantity changes)
    client.post("/api/vendors", json={"name": "PartsCo"})
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "PartsCo",
            "invoice_number": "INV-1",
            "po_number": order["number"],
            "subtotal": 20,
            "tax": 0,
            "total": 20,
            "items": [{"part_number": "BP-1", "description": "Brake pads", "quantity": 2, "unit_cost": 10, "kind": "part"}],
        },
    )
    assert res.json()["status"] == "posted", res.text

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 70  # now fully landed
    assert detail["quoted_cost"] == 70
