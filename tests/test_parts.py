from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def test_order_parts_flips_quoted_to_ordered(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10},
            {"kind": "part", "description": "Rotors", "part_number": "RT-1", "quantity": 1, "unit_price": 30, "unit_cost": 30},
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 50, "unit_cost": 50},
        ],
    )
    assert all(i["status"] == "quoted" for i in estimate["items"])

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 200
    assert res.json()["updated"] == 2  # only the two part lines, not labor

    updated = client.get(f"/api/orders/{order['id']}").json()
    statuses = {i["part_number"]: i["status"] for i in updated["estimate"]["items"] if i["kind"] == "part"}
    assert statuses == {"BP-1": "ordered", "RT-1": "ordered"}

    # calling again is a no-op (nothing left in 'quoted')
    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.json()["updated"] == 0


def test_manual_received_status_actually_counts_as_received(client):
    """Marking a part 'received' via the quick per-line toggle (a
    cash-and-carry parts-store run with no formal vendor invoice) must move
    received_quantity too -- otherwise the status label lies about cost."""
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 2, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "received", "invoice_number": "INV-1"})
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 20  # 2 * 10, actually counted now

    updated_item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert updated_item["received_quantity"] == 2
    assert updated_item["received_invoice_number"] == "INV-1"

    # stepping back off "received" clears it so cost doesn't stay stale
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "quoted"})
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 0


def test_received_requires_invoice_number(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "received"})
    assert res.status_code == 422


def test_set_item_status_directly(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "received", "invoice_number": "INV-9"})
    assert res.status_code == 200
    assert res.json() == {"id": item_id, "status": "received", "invoice_number": "INV-9"}


def test_set_item_status_wrong_order_404(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    other_order = make_recon_order(client, make_recon_vehicle(client, stock_number="R-9999")["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{other_order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})
    assert res.status_code == 404


def test_order_parts_no_estimate_404(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 404
