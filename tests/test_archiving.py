from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def test_archive_and_reopen_recon_vehicle(client):
    vehicle = make_recon_vehicle(client, stock_number="R-8801")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    board = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert any(r["stock_number"] == "R-8801" for r in board)

    res = client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")
    assert res.status_code == 200
    assert res.json()["archived_at"]

    # disappears from the live board, appears in history
    board = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert not any(r["stock_number"] == "R-8801" for r in board)
    history = client.get("/api/vehicles-board", params={"segment": "recon", "archived": True}).json()
    assert any(r["stock_number"] == "R-8801" for r in history)

    # frozen while archived
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    assert res.status_code == 409
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"purchase_price": 1})
    assert res.status_code == 409
    res = client.post(f"/api/orders/{order['id']}/notes", json={"text": "hi"})
    assert res.status_code == 409
    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "tester", "items": [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}]},
    )
    assert res.status_code == 409
    res = client.post("/api/orders", json={"concern": "New work", "segment": "recon", "recon_vehicle_id": vehicle["id"]})
    assert res.status_code == 409
    res = client.patch(f"/api/orders/{order['id']}/concern", json={"concern": "Different work"})
    assert res.status_code == 409

    # reopen restores full editing, data untouched
    res = client.post(f"/api/recon/vehicles/{vehicle['id']}/reopen")
    assert res.status_code == 200
    assert res.json()["archived_at"] == ""
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    assert res.status_code == 200
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 50  # nothing lost while archived


def test_archive_and_reopen_we_owe_item(client):
    item = make_we_owe(client, description="Fix mirror")
    order = client.post("/api/orders", json={"concern": "Fix it", "segment": "we_owe", "we_owe_id": item["id"]}).json()

    res = client.post(f"/api/we-owe/{item['id']}/archive")
    assert res.status_code == 200

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    assert not any(r["we_owe_id"] == item["id"] for r in board)
    history = client.get("/api/vehicles-board", params={"segment": "we_owe", "archived": True}).json()
    assert any(r["we_owe_id"] == item["id"] for r in history)

    res = client.patch(f"/api/we-owe/{item['id']}", json={"category": "mirror"})
    assert res.status_code == 409
    res = client.post(f"/api/we-owe/{item['id']}/payments", json={"amount": 10, "method": "cash"})
    assert res.status_code == 409
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"odometer_in": 100})
    assert res.status_code == 409

    client.post(f"/api/we-owe/{item['id']}/reopen")
    res = client.patch(f"/api/we-owe/{item['id']}", json={"category": "mirror"})
    assert res.status_code == 200


def test_retail_orders_unaffected_by_archiving_guard(client):
    """Retail orders have no recon_vehicle_id/we_owe_id -- the archiving
    guard must be a no-op for them, never blocking normal retail work."""
    customer = client.post("/api/customers", json={"name": "Retail Customer"}).json()
    vehicle = client.post("/api/vehicles", json={"customer_id": customer["id"], "year": 2020, "make": "Ford", "model": "Focus"}).json()
    order = client.post(
        "/api/orders",
        json={"concern": "Check engine light", "segment": "retail", "customer_id": customer["id"], "vehicle_id": vehicle["id"]},
    ).json()
    res = save_estimate_res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "tester", "items": [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}]},
    )
    assert res.status_code == 200
