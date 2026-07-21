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


def test_estimate_item_source_is_recorded(client):
    vehicle = make_recon_vehicle(client, stock_number="R-3401")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "OEM sensor", "part_number": "PT-1", "quantity": 1, "unit_price": 80, "unit_cost": 80, "source": "partstech"},
            {"kind": "part", "description": "Filter", "part_number": "F-1", "quantity": 1, "unit_price": 10, "unit_cost": 10},
        ],
    )
    by_desc = {i["description"]: i for i in estimate["items"]}
    assert by_desc["OEM sensor"]["source"] == "partstech"
    assert by_desc["Filter"]["source"] == "manual"

    # editing an existing line doesn't reset its source
    partstech_id = by_desc["OEM sensor"]["id"]
    estimate2 = save_estimate(
        client,
        order["id"],
        [
            {"id": partstech_id, "kind": "part", "description": "OEM sensor", "part_number": "PT-1", "quantity": 2, "unit_price": 80, "unit_cost": 80},
            {"kind": "part", "description": "Filter", "part_number": "F-1", "quantity": 1, "unit_price": 10, "unit_cost": 10, "id": by_desc["Filter"]["id"]},
        ],
    )
    updated = next(i for i in estimate2["items"] if i["id"] == partstech_id)
    assert updated["source"] == "partstech"
    assert updated["quantity"] == 2


def test_estimate_save_conflict_when_stale_version(client):
    """The estimate save is a full replace of the line-item set -- the
    highest-risk spot for two people editing the same RO to silently
    clobber each other. A stale expected_version must be rejected."""
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    assert estimate["edit_version"] == 1

    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "tester", "items": [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}], "expected_version": 1},
    )
    assert res.status_code == 200
    assert res.json()["edit_version"] == 2

    # A second client still holding version=1 tries to save over it
    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "tester", "items": [{"kind": "labor", "description": "Different", "quantity": 1, "unit_price": 99, "unit_cost": 99}], "expected_version": 1},
    )
    assert res.status_code == 409

    # the first save's data must survive untouched
    current = client.get(f"/api/orders/{order['id']}").json()
    assert current["estimate"]["items"][0]["description"] == "Diag"


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
    assert res["credentials_configured"] is False
    assert res["live_search_available"] is False  # no public API contract to build against yet


def test_partstech_credentials_stored_and_never_echo_key(client):
    res = client.get("/api/integrations/partstech/credentials").json()
    assert res["configured"] is False

    res = client.put("/api/integrations/partstech/credentials", json={"username": "shop@example.com", "api_key": "secret-key-value"})
    assert res.status_code == 200

    res = client.get("/api/integrations/partstech/credentials").json()
    assert res["configured"] is True
    assert res["username"] == "shop@example.com"
    assert "api_key" not in res  # the key itself is stored but never sent back to the browser

    res = client.get("/api/integrations/partstech").json()
    assert res["credentials_configured"] is True


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
