from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def post_invoice(client, **overrides):
    payload = {
        "vendor_name": "WorldPac",
        "invoice_number": "INV-100",
        "po_number": "RO-DOES-NOT-EXIST",
        "subtotal": 45,
        "tax": 0,
        "total": 45,
        "items": [{"part_number": "BP-100", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    }
    payload.update(overrides)
    return client.post("/api/agent/invoices/process", json=payload)


def test_vendor_crud_and_duplicate(client):
    res = client.post("/api/vendors", json={"name": "WorldPac", "aliases": ["World Pac"]})
    assert res.status_code == 201
    res = client.post("/api/vendors", json={"name": "WorldPac"})
    assert res.status_code == 409


def test_process_invoice_unknown_vendor_and_po(client):
    res = post_invoice(client)
    body = res.json()
    assert body["status"] == "review_required"
    assert any("Vendor" in issue for issue in body["issues"])
    assert any("PO" in issue for issue in body["issues"])


def test_process_invoice_posts_and_receives_parts(client):
    client.post("/api/vendors", json={"name": "WorldPac", "aliases": ["World Pac"]})
    vehicle = make_recon_vehicle(client, stock_number="R-5001")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-100", "quantity": 2, "unit_price": 45, "unit_cost": 45}],
    )
    res = post_invoice(
        client,
        vendor_name="World Pac",  # alias match
        po_number=order["number"],
        subtotal=90, total=90,
        items=[{"part_number": "bp-100", "description": "Brake pads", "quantity": 2, "unit_cost": 45, "kind": "part"}],
    )
    body = res.json()
    assert body["status"] == "posted", body

    updated = client.get(f"/api/orders/{order['id']}").json()
    part = updated["estimate"]["items"][0]
    assert part["received_quantity"] == 2
    assert part["status"] == "received"

    invoices = client.get("/api/ap/invoices").json()
    posted = next(i for i in invoices if i["invoice_number"] == "INV-100")
    assert posted["po_number"] == order["number"]
    assert posted["vehicle_label"] == "R-5001"  # PO# -> RO# -> stock# traceability


def test_process_invoice_matches_po_by_stock_number(client):
    """Shops naturally give vendors the stock number as the PO reference
    (it's what's on the car) rather than the internal RO-2607-0012 format
    -- an invoice referencing the stock number must resolve to that
    vehicle's repair order just as well as the formal RO number would."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-9201")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}],
    )
    res = post_invoice(
        client,
        po_number="r-9201",  # lowercase, exactly what a vendor might scrawl on an invoice
        subtotal=45, total=45,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )
    assert res.json()["status"] == "posted", res.text
    assert res.json()["order_id"] == order["id"]


def test_process_invoice_duplicate_rejected(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-6001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}],
    )
    kwargs = dict(po_number=order["number"], items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}])
    first = post_invoice(client, **kwargs)
    assert first.json()["status"] == "posted"
    second = post_invoice(client, **kwargs)
    assert second.json()["status"] == "duplicate"


def test_process_invoice_over_receipt_blocked(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-7001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}],
    )
    res = post_invoice(
        client,
        po_number=order["number"],
        subtotal=90, total=90,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 2, "unit_cost": 45, "kind": "part"}],
    )
    body = res.json()
    assert body["status"] == "review_required"
    assert any("exceeds" in issue for issue in body["issues"])


def test_ap_invoices_filterable_by_date(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-8101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}],
    )
    post_invoice(client, po_number=order["number"], items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}])

    all_invoices = client.get("/api/ap/invoices").json()
    assert any(i["invoice_number"] == "INV-100" for i in all_invoices)

    future_only = client.get("/api/ap/invoices", params={"start": "2099-01-01"}).json()
    assert future_only == []

    past_to_now = client.get("/api/ap/invoices", params={"start": "2000-01-01", "end": "2099-12-31"}).json()
    assert any(i["invoice_number"] == "INV-100" for i in past_to_now)


def test_process_invoice_totals_mismatch(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-8001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}],
    )
    res = post_invoice(client, po_number=order["number"], subtotal=999, total=999)
    body = res.json()
    assert body["status"] == "review_required"
    assert any("subtotal" in issue.lower() for issue in body["issues"])
