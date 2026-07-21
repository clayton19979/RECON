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


def test_status_transitions(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    # invalid transition
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "closed"})
    assert res.status_code == 409

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "inspection"})
    assert res.status_code == 200
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "awaiting_approval"})
    assert res.status_code == 200

    # cannot jump straight to approved via status endpoint -- must use authorization
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "approved"})
    assert res.status_code == 409


def test_authorization_flow(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "inspection"})

    # must be awaiting_approval first
    res = client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    assert res.status_code == 409

    client.patch(f"/api/orders/{order['id']}/status", json={"status": "awaiting_approval"})
    res = client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    assert res.status_code == 201
    order_after = client.get(f"/api/orders/{order['id']}").json()
    assert order_after["status"] == "approved"


def test_estimate_stays_editable_after_approval_for_recon(client):
    """Recon/we-owe work is internal at-cost tracking with no customer
    authorization requirement -- the advisor keeps full control to add or
    correct a line at any point in the RO's life, even after approval."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "inspection"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "awaiting_approval"})
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


def test_retail_invoice_and_payment_gate_close(client):
    order = make_retail_order(client)
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "inspection"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "awaiting_approval"})
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "completed"})

    # cannot close a retail RO until its invoice is paid
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "closed"})
    assert res.status_code == 409

    invoice = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"}).json()
    assert invoice["total"] == 100
    assert invoice["balance"] == 100

    # overpayment rejected
    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 200, "method": "cash"})
    assert res.status_code == 409

    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 100, "method": "cash"})
    assert res.status_code == 201
    assert res.json()["invoice"]["status"] == "paid"

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "closed"})
    assert res.status_code == 200
