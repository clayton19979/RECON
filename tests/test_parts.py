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


def test_set_item_status_no_longer_accepts_received(client):
    """Parts are only ever marked received through /estimate/receive-parts,
    which posts a real A/P record -- the quick per-line status endpoint no
    longer accepts "received" for a part line, so there's exactly one
    receiving mechanism."""
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

    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})
    assert res.status_code == 200
    assert res.json() == {"id": item_id, "status": "ordered"}


def test_receive_parts_posts_single_ap_invoice_for_multiple_lines(client):
    """The real workflow bug this fixes: ordering 2 parts on one invoice used
    to require posting them separately with no resulting A/P entry. Selecting
    both and receiving them together must create exactly one ap_invoices row
    covering both lines, and it must show up in the A/P tab."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 2, "unit_price": 10, "unit_cost": 10},
            {"kind": "part", "description": "Rotors", "part_number": "RT-1", "quantity": 1, "unit_price": 30, "unit_cost": 30},
        ],
    )
    item_ids = [i["id"] for i in estimate["items"]]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["received_items"] == 2

    updated = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert all(i["status"] == "received" for i in updated)
    assert {i["received_invoice_number"] for i in updated} == {"INV-1"}

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 50  # 2*10 + 1*30, actually landed now

    invoices = client.get("/api/ap/invoices").json()
    matching = [i for i in invoices if i["invoice_number"] == "INV-1"]
    assert len(matching) == 1  # one AP invoice, not two
    assert matching[0]["order_id"] == order["id"]


def test_receive_parts_rejects_negative_cost_override(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client, order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1", "cost_overrides": {str(item_id): -5}},
    )
    assert res.status_code == 422


def test_receive_parts_requires_known_vendor(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": 999999, "invoice_number": "INV-1"},
    )
    assert res.status_code == 404


def test_receive_parts_requires_invoice_number(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": ""},
    )
    assert res.status_code == 422


def test_receive_parts_wrong_order_404(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    other_order = make_recon_order(client, make_recon_vehicle(client, stock_number="R-9999")["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{other_order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert res.status_code == 404


def test_receive_parts_duplicate_invoice_number_shared_with_agent_path(client):
    """The uniqueness constraint (vendor_id, normalized_invoice_number) must
    be shared between the ticket-side receive flow and the agent/A-P-tab
    invoice flow -- posting the same vendor+invoice number through either
    path blocks the other."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3302")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-DUP"},
    )
    assert res.status_code == 200

    # Same vendor + invoice number via the agent path is rejected as a duplicate
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "WorldPac",
            "invoice_number": "INV-DUP",
            "po_number": order["number"],
            "subtotal": 10, "tax": 0, "total": 10,
            "items": [{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 10, "kind": "part"}],
        },
    )
    assert res.json()["status"] == "duplicate"


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
