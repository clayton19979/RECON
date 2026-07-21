from __future__ import annotations

from unittest.mock import MagicMock, patch

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, save_estimate


def test_customers_and_vehicles_crud(client):
    customer = client.post("/api/customers", json={"name": "Jamie Lee", "phone": "219-555-0100"}).json()
    assert customer["name"] == "Jamie Lee"

    res = client.post("/api/vehicles", json={"customer_id": 999999, "year": 2020, "make": "Kia", "model": "Soul"})
    assert res.status_code == 404

    vehicle = client.post(
        "/api/vehicles", json={"customer_id": customer["id"], "year": 2020, "make": "Kia", "model": "Soul", "vin": "abc123"}
    ).json()
    assert vehicle["vin"] == "ABC123"  # normalized uppercase

    listed = client.get("/api/vehicles").json()
    assert any(v["id"] == vehicle["id"] for v in listed)

    # shop-owned sentinel customer must never leak into the customers list
    make_recon_vehicle(client)
    customers = client.get("/api/customers").json()
    assert all(c["name"] != "Discount Auto — Shop-Owned Recon Inventory" for c in customers)


def test_order_lifecycle_and_estimate_editing(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    assert order["number"].startswith("RO-")
    assert order["segment"] == "recon"

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["recon_vehicle"]["id"] == vehicle["id"]
    assert detail["we_owe_item"] is None
    assert detail["estimate"] is None

    estimate = save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Filter", "part_number": "F-1", "quantity": 1, "unit_price": 20, "unit_cost": 20},
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 30, "unit_cost": 30},
        ],
    )
    assert estimate["subtotal"] == 50
    assert len(estimate["items"]) == 2

    # editing again: update one line, drop the other, add a new one
    keep_id = estimate["items"][0]["id"]
    estimate2 = save_estimate(
        client,
        order["id"],
        [
            {"id": keep_id, "kind": "part", "description": "Filter", "part_number": "F-1", "quantity": 2, "unit_price": 20, "unit_cost": 20},
            {"kind": "fee", "description": "Shop supplies", "quantity": 1, "unit_price": 5, "unit_cost": 5},
        ],
    )
    descriptions = {i["description"] for i in estimate2["items"]}
    assert descriptions == {"Filter", "Shop supplies"}
    assert estimate2["subtotal"] == 45  # 2*20 + 5, labor line dropped


def test_order_requires_valid_recon_vehicle(client):
    res = client.post("/api/orders", json={"concern": "Test", "segment": "recon", "recon_vehicle_id": 99999})
    assert res.status_code == 404


def test_order_requires_valid_we_owe_item(client):
    res = client.post("/api/orders", json={"concern": "Test", "segment": "we_owe", "we_owe_id": 99999})
    assert res.status_code == 404


def test_retail_order_requires_customer_and_vehicle_match(client):
    res = client.post("/api/orders", json={"concern": "Test", "segment": "retail"})
    assert res.status_code == 422


def test_dashboard_aggregates_open_work(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2201", purchase_price=5000)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 60, "unit_cost": 60}])

    dashboard = client.get("/api/dashboard").json()
    assert dashboard["recon_open"] == 1
    assert dashboard["recon_actual_open"] == 60


def test_integrations_partstech(client):
    res = client.get("/api/integrations/partstech").json()
    assert res["stores_password"] is False
    assert "login_url" in res


def test_decode_vin_success(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "Results": [{"ModelYear": "2019", "Make": "Honda", "Model": "Civic", "Trim": "EX", "DisplacementL": "2.0", "EngineCylinders": "4"}]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.post("/api/vehicles/decode-vin", json={"vin": "1HGCM82633A004352"})
    assert res.status_code == 200
    body = res.json()
    assert body["make"] == "Honda"
    assert body["engine"] == "2.0L 4-cyl"


def test_decode_vin_not_found(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {"Results": [{}]}
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.post("/api/vehicles/decode-vin", json={"vin": "1HGCM82633A004352"})
    assert res.status_code == 404


def test_decode_plate_without_api_key(client, monkeypatch):
    monkeypatch.delenv("PLATETOVIN_API_KEY", raising=False)
    res = client.post("/api/vehicles/decode-plate", json={"plate": "ABC123", "state": "IN"})
    assert res.status_code == 503
