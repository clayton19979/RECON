from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, save_estimate


def test_staff_crud(client):
    res = client.post("/api/staff", json={"name": "Jordan Smith", "role": "technician"})
    assert res.status_code == 201
    staff_id = res.json()["id"]

    active = client.get("/api/staff").json()
    assert any(s["id"] == staff_id for s in active)

    client.patch(f"/api/staff/{staff_id}", json={"active": False})
    active = client.get("/api/staff").json()
    assert not any(s["id"] == staff_id for s in active)

    everyone = client.get("/api/staff", params={"include_inactive": True}).json()
    assert any(s["id"] == staff_id and s["active"] == 0 for s in everyone)

    client.patch(f"/api/staff/{staff_id}", json={"name": "Jordan S.", "role": "manager"})
    updated = next(s for s in client.get("/api/staff", params={"include_inactive": True}).json() if s["id"] == staff_id)
    assert updated["name"] == "Jordan S."
    assert updated["role"] == "manager"


def test_assignment_requires_active_matching_role(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    advisor = client.post("/api/staff", json={"name": "Pat", "role": "advisor"}).json()

    # wrong role for technician slot
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": advisor["id"]})
    assert res.status_code == 400

    technician = client.post("/api/staff", json={"name": "Jordan", "role": "technician"}).json()
    res = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"advisor_id": advisor["id"], "technician_id": technician["id"], "odometer_in": 100},
    )
    assert res.status_code == 200
    assert res.json()["technician_name"] == "Jordan"


def test_date_in_defaults_to_order_creation_and_is_editable(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["assignment"]["date_in"] == order["created_at"][:10]

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"date_in": "2026-01-15"})
    assert res.status_code == 200
    assert res.json()["date_in"] == "2026-01-15"

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["assignment"]["date_in"] == "2026-01-15"


def test_status_transitions(client):
    """Statuses are a plain, ungated picker now -- any of the 4 values is
    settable from any other, with no transition graph or approval/invoice
    gating (matches the shop's real workflow: estimate / pending approval /
    in progress / complete, nothing more)."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    assert res.status_code == 200

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "estimate"})
    assert res.status_code == 200

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "pending_approval"})
    assert res.status_code == 200

    # invalid value still rejected
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "bogus"})
    assert res.status_code == 422


def test_void_order(client):
    vehicle = make_recon_vehicle(client, stock_number="R-4501")
    live_order = make_recon_order(client, vehicle["id"], concern="Real work")
    save_estimate(client, live_order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])

    mistake_order = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(client, mistake_order["id"], [{"kind": "part", "description": "Wrong part", "part_number": "X-1", "quantity": 1, "unit_price": 300, "unit_cost": 300}])
    res = client.post(f"/api/orders/{mistake_order['id']}/void", json={"actor": "Clay"})
    assert res.status_code == 200
    assert res.json() == {"id": mistake_order["id"], "status": "complete", "voided": True}

    order_after = client.get(f"/api/orders/{mistake_order['id']}").json()
    assert order_after["status"] == "complete"
    assert order_after["voided"] == 1

    # voiding twice is rejected
    res = client.post(f"/api/orders/{mistake_order['id']}/void", json={"actor": "Clay"})
    assert res.status_code == 409


def test_authorization_flow(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])

    res = client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    assert res.status_code == 201


def test_estimate_stays_editable_after_approval_for_recon(client):
    """Recon/we-owe work is internal at-cost tracking with no customer
    authorization requirement -- the advisor keeps full control to add or
    correct a line at any point in the RO's life, even after approval."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})

    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "Clay", "items": [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}]},
    )
    assert res.status_code == 200
    assert len(res.json()["items"]) == 1


def test_findings_require_part_number(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    res = client.post(
        f"/api/orders/{order['id']}/findings",
        json={"summary": "Found worn pads", "items": [{"kind": "part", "description": "Pads", "quantity": 1, "unit_price": 10}]},
    )
    assert res.status_code == 422


def test_retail_invoice_and_payment(client):
    """Invoicing/payment gating on order status was removed along with the
    old approved/closed status values -- an order can be marked complete
    freely, independent of whether its customer invoice is paid."""
    order = make_retail_order(client)
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    assert res.status_code == 200

    invoice = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"}).json()
    assert invoice["total"] == 100
    assert invoice["balance"] == 100

    # overpayment rejected
    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 200, "method": "cash"})
    assert res.status_code == 409

    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 100, "method": "cash"})
    assert res.status_code == 201
    assert res.json()["invoice"]["status"] == "paid"
