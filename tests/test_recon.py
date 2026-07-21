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


def test_recon_patch_edits_core_vehicle_info(client):
    """Correcting a typo'd purchase price or VIN shouldn't require touching
    the database directly."""
    vehicle = make_recon_vehicle(client, stock_number="R-2101", purchase_price=4000, vin="OLDVIN")
    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"purchase_price": 4500, "vin": "1hgcm82633a004352", "make": "Honda", "model": "Accord", "year": 2021, "mileage": 12345},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["purchase_price"] == 4500
    assert body["vin"] == "1HGCM82633A004352"  # normalized uppercase like creation does
    assert body["make"] == "Honda"
    assert body["model"] == "Accord"
    assert body["year"] == 2021
    assert body["mileage"] == 12345


def test_delete_recon_vehicle_without_orders(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2201")
    res = client.delete(f"/api/recon/vehicles/{vehicle['id']}")
    assert res.status_code == 204
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").status_code == 404
    assert not any(row["stock_number"] == "R-2201" for row in client.get("/api/vehicles-board").json())


def test_delete_recon_vehicle_with_orders_blocked(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2301")
    make_recon_order(client, vehicle["id"])
    res = client.delete(f"/api/recon/vehicles/{vehicle['id']}")
    assert res.status_code == 409
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").status_code == 200


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


def test_we_owe_patch_edits_description_and_category(client):
    item = make_we_owe(client, description="Fix mirror")
    res = client.patch(
        f"/api/we-owe/{item['id']}",
        json={"description": "Replace passenger mirror", "category": "mirror", "target_date": "2026-08-01"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["description"] == "Replace passenger mirror"
    assert body["category"] == "mirror"
    assert body["target_date"] == "2026-08-01"


def test_delete_we_owe_item_without_orders(client):
    item = make_we_owe(client)
    res = client.delete(f"/api/we-owe/{item['id']}")
    assert res.status_code == 204
    assert client.get(f"/api/we-owe/{item['id']}").status_code == 404


def test_delete_we_owe_item_with_orders_blocked(client):
    item = make_we_owe(client)
    client.post("/api/orders", json={"concern": "Fix it", "segment": "we_owe", "we_owe_id": item["id"]})
    res = client.delete(f"/api/we-owe/{item['id']}")
    assert res.status_code == 409
    assert client.get(f"/api/we-owe/{item['id']}").status_code == 200


def test_we_owe_customer_deposit_reduces_net_cost(client):
    """Customers are sometimes talked into putting money down toward a
    we-owe repair -- that must show up separately from shop spend, netting
    against it, not just get lost."""
    item = make_we_owe(client, description="Fix AC")
    order = client.post("/api/orders", json={"concern": "AC repair", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 200, "unit_cost": 200}])

    res = client.post(f"/api/we-owe/{item['id']}/payments", json={"amount": 75, "method": "cash", "note": "Down payment"})
    assert res.status_code == 201
    body = res.json()
    assert body["customer_paid"] == 75
    assert body["net_cost"] == 125  # 200 - 75
    assert len(body["payments"]) == 1

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["customer_paid"] == 75
    assert row["net_cost"] == 125

    payment_id = body["payments"][0]["id"]
    res = client.delete(f"/api/we-owe/{item['id']}/payments/{payment_id}")
    assert res.status_code == 204
    detail = client.get(f"/api/we-owe/{item['id']}").json()
    assert detail["customer_paid"] == 0
    assert detail["net_cost"] == 200


def test_we_owe_payment_requires_positive_amount(client):
    item = make_we_owe(client)
    res = client.post(f"/api/we-owe/{item['id']}/payments", json={"amount": 0})
    assert res.status_code == 422


def test_vehicle_board_rows_include_age_days(client):
    make_recon_vehicle(client, stock_number="R-6701")
    board = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert board[0]["age_days"] == 0  # created moments ago


def test_recon_patch_conflict_when_stale_version(client):
    """Two people editing the same car at once: the second save with a
    stale expected_version must be rejected, not silently overwrite."""
    vehicle = make_recon_vehicle(client, stock_number="R-6801")
    assert vehicle["edit_version"] == 1

    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"purchase_price": 5000, "expected_version": 1})
    assert res.status_code == 200
    assert res.json()["edit_version"] == 2

    # A second client still holding the old version=1 tries to save
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"purchase_price": 6000, "expected_version": 1})
    assert res.status_code == 409

    # Without expected_version, no conflict check is performed (backwards compatible)
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"notes": "no version check"})
    assert res.status_code == 200


def test_we_owe_patch_conflict_when_stale_version(client):
    item = make_we_owe(client)
    client.patch(f"/api/we-owe/{item['id']}", json={"category": "mirror", "expected_version": item["edit_version"]})
    res = client.patch(f"/api/we-owe/{item['id']}", json={"category": "seatbelt", "expected_version": item["edit_version"]})
    assert res.status_code == 409


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
