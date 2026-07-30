from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx

from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    save_estimate,
)


def test_customers_and_vehicles_crud(client):
    customer = client.post("/api/customers", json={"name": "Jamie Lee", "phone": "219-555-0100"}).json()
    assert customer["name"] == "Jamie Lee"

    res = client.post("/api/vehicles", json={"customer_id": 999999, "year": 2020, "make": "Kia", "model": "Soul"})
    assert res.status_code == 404

    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2020, "make": "Kia", "model": "Soul", "vin": "abc123"},
    ).json()
    assert vehicle["vin"] == "ABC123"  # normalized uppercase

    listed = client.get("/api/vehicles").json()
    assert any(v["id"] == vehicle["id"] for v in listed)

    # shop-owned sentinel customer must never leak into the customers list
    make_recon_vehicle(client)
    customers = client.get("/api/customers").json()
    assert all(c["name"] != "Discount Auto — Shop-Owned Recon Inventory" for c in customers)


def test_customer_patch_updates_fields(client):
    customer = client.post("/api/customers", json={"name": "Jamie Lee", "phone": "219-555-0100"}).json()
    res = client.patch(f"/api/customers/{customer['id']}", json={"phone": "219-555-9999", "email": "jamie@example.com"})
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Jamie Lee"
    assert body["phone"] == "(219) 555-9999"  # normalized to the canonical shape
    assert body["email"] == "jamie@example.com"


def test_customer_phone_normalized_on_create_and_patch(client):
    # Ten digits in any punctuation come out in the one canonical shape.
    for raw in ("313.555.0142", "3135550142", "(313) 555-0142", "+1 313-555-0142", "1-313-555-0142"):
        customer = client.post("/api/customers", json={"name": "Pat", "phone": raw}).json()
        assert customer["phone"] == "(313) 555-0142", f"{raw!r} -> {customer['phone']!r}"

    # Anything that isn't a 10-digit number is kept as typed, not rejected:
    # legacy records and oddball entries (extensions, short codes) still save.
    kept = client.post("/api/customers", json={"name": "Pat", "phone": "555-0142"}).json()
    assert kept["phone"] == "555-0142"
    empty = client.post("/api/customers", json={"name": "Pat", "phone": "  "}).json()
    assert empty["phone"] == ""

    # PATCH goes through the same normalization as create.
    res = client.patch(f"/api/customers/{kept['id']}", json={"phone": "219 555 0100"})
    assert res.json()["phone"] == "(219) 555-0100"


def test_customer_address_create_and_patch_round_trip(client):
    customer = client.post(
        "/api/customers",
        json={
            "name": "Address Tester",
            "phone": "219-555-0111",
            "address_line1": "123 Broadway",
            "address_line2": "Apt 4",
            "city": "Merrillville",
            "state": "IN",
            "postal_code": "46410",
        },
    ).json()
    assert customer["address_line1"] == "123 Broadway"
    assert customer["address_line2"] == "Apt 4"
    assert customer["city"] == "Merrillville"
    assert customer["state"] == "IN"
    assert customer["postal_code"] == "46410"

    # Partial patch touches only the sent fields, leaving the rest intact.
    res = client.patch(
        f"/api/customers/{customer['id']}", json={"address_line1": "500 Main St", "postal_code": "46411"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["address_line1"] == "500 Main St"
    assert body["postal_code"] == "46411"
    assert body["city"] == "Merrillville"  # untouched
    assert body["address_line2"] == "Apt 4"  # untouched


def test_we_owe_detail_exposes_customer_address(client):
    from tests.helpers import make_we_owe

    we_owe = make_we_owe(client)
    client.patch(
        f"/api/customers/{we_owe['customer_id']}",
        json={
            "address_line1": "77 Sunset Blvd",
            "city": "Gary",
            "state": "IN",
            "postal_code": "46402",
        },
    )
    detail = client.get(f"/api/we-owe/{we_owe['id']}").json()
    assert detail["customer_address_line1"] == "77 Sunset Blvd"
    assert detail["customer_city"] == "Gary"
    assert detail["customer_state"] == "IN"
    assert detail["customer_postal_code"] == "46402"


def test_address_suggest_parses_provider_results(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "features": [
            {
                "properties": {
                    "housenumber": "1600",
                    "street": "Amphitheatre Parkway",
                    "city": "Mountain View",
                    "state": "California",
                    "postcode": "94043",
                    "countrycode": "US",
                }
            },
            {
                "properties": {"housenumber": "10", "street": "Downing Street", "city": "London", "countrycode": "GB"}
            },  # non-US, filtered out
        ]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.get("/api/address-suggest", params={"q": "1600 Amphitheatre"})
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1  # GB result dropped
    assert body[0]["line1"] == "1600 Amphitheatre Parkway"
    assert body[0]["city"] == "Mountain View"
    assert body[0]["state"] == "CA"  # full name folded to abbreviation
    assert body[0]["postal_code"] == "94043"


def test_address_suggest_degrades_to_empty_when_provider_unreachable(client):
    import httpx as _httpx

    with patch("app.main.httpx.get", side_effect=_httpx.ConnectError("offline")):
        res = client.get("/api/address-suggest", params={"q": "123 Main St"})
    assert res.status_code == 200
    assert res.json() == []


def test_customer_patch_rejects_shop_owned_sentinel(client):
    make_recon_vehicle(client)
    res = client.patch("/api/customers/-1", json={"name": "Hijacked"})
    assert res.status_code == 409


def test_customer_patch_404_for_missing_customer(client):
    res = client.patch("/api/customers/999999", json={"name": "Nobody"})
    assert res.status_code == 404


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
            {
                "kind": "part",
                "description": "Filter",
                "part_number": "F-1",
                "quantity": 1,
                "unit_price": 20,
                "unit_cost": 20,
            },
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
            {
                "id": keep_id,
                "kind": "part",
                "description": "Filter",
                "part_number": "F-1",
                "quantity": 2,
                "unit_price": 20,
                "unit_cost": 20,
            },
            {"kind": "fee", "description": "Shop supplies", "quantity": 1, "unit_price": 5, "unit_cost": 5},
        ],
    )
    descriptions = {i["description"] for i in estimate2["items"]}
    assert descriptions == {"Filter", "Shop supplies"}
    assert estimate2["subtotal"] == 45  # 2*20 + 5, labor line dropped


def test_save_estimate_rejects_oversized_item_list(client):
    """Capped well under SQLite's ~999-host-parameter limit -- the delete
    step builds one placeholder per retained id in a single statement, so an
    unbounded list could otherwise raise an uncaught OperationalError."""
    vehicle = make_recon_vehicle(client, stock_number="R-3502")
    order = make_recon_order(client, vehicle["id"])
    items = [
        {"kind": "part", "description": "x", "part_number": f"P-{i}", "quantity": 1, "unit_price": 1, "unit_cost": 1}
        for i in range(301)
    ]
    res = client.post(f"/api/orders/{order['id']}/estimate", json={"actor": "t", "items": items})
    assert res.status_code == 422


def test_save_estimate_never_deletes_a_received_line(client):
    """The real risk: save_estimate replaces the whole line-item set on every
    call, deleting anything not in the payload. A received line already has
    a real A/P invoice posted against it -- it must survive even if a save
    (stale tab, slow response, a future frontend bug) omits it."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3501")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            },
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 30, "unit_cost": 30},
        ],
    )
    received_id = estimate["items"][0]["id"]
    labor_id = estimate["items"][1]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [received_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    # Resave with a payload that omits the now-received part entirely.
    estimate2 = save_estimate(
        client,
        order["id"],
        [{"id": labor_id, "kind": "labor", "description": "Install", "quantity": 1, "unit_price": 30, "unit_cost": 30}],
    )
    ids = {i["id"] for i in estimate2["items"]}
    assert received_id in ids  # survived despite being left out of the payload
    assert next(i for i in estimate2["items"] if i["id"] == received_id)["status"] == "received"
    # The surviving received line must still count toward the total -- it's
    # computed from what's actually in estimate_items, not from the payload
    # that omitted it.
    assert estimate2["subtotal"] == 40  # 10 (surviving received part) + 30 (labor)


def test_estimate_item_source_is_recorded(client):
    vehicle = make_recon_vehicle(client, stock_number="R-3401")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "OEM sensor",
                "part_number": "PT-1",
                "quantity": 1,
                "unit_price": 80,
                "unit_cost": 80,
                "source": "technician_finding",
            },
            {
                "kind": "part",
                "description": "Filter",
                "part_number": "F-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            },
        ],
    )
    by_desc = {i["description"]: i for i in estimate["items"]}
    assert by_desc["OEM sensor"]["source"] == "technician_finding"
    assert by_desc["Filter"]["source"] == "manual"

    # editing an existing line doesn't reset its source
    finding_id = by_desc["OEM sensor"]["id"]
    estimate2 = save_estimate(
        client,
        order["id"],
        [
            {
                "id": finding_id,
                "kind": "part",
                "description": "OEM sensor",
                "part_number": "PT-1",
                "quantity": 2,
                "unit_price": 80,
                "unit_cost": 80,
            },
            {
                "kind": "part",
                "description": "Filter",
                "part_number": "F-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
                "id": by_desc["Filter"]["id"],
            },
        ],
    )
    updated = next(i for i in estimate2["items"] if i["id"] == finding_id)
    assert updated["source"] == "technician_finding"
    assert updated["quantity"] == 2


def test_estimate_save_conflict_when_stale_version(client):
    """The estimate save is a full replace of the line-item set -- the
    highest-risk spot for two people editing the same RO to silently
    clobber each other. A stale expected_version must be rejected."""
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}],
    )
    assert estimate["edit_version"] == 1

    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={
            "actor": "tester",
            "items": [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}],
            "expected_version": 1,
        },
    )
    assert res.status_code == 200
    assert res.json()["edit_version"] == 2

    # A second client still holding version=1 tries to save over it
    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={
            "actor": "tester",
            "items": [{"kind": "labor", "description": "Different", "quantity": 1, "unit_price": 99, "unit_cost": 99}],
            "expected_version": 1,
        },
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
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 60, "unit_cost": 60}],
    )

    dashboard = client.get("/api/dashboard").json()
    assert dashboard["recon_open"] == 1
    assert dashboard["recon_actual_open"] == 60


def test_decode_vin_success(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "Results": [
            {
                "ModelYear": "2019",
                "Make": "Honda",
                "Model": "Civic",
                "Trim": "EX",
                "DisplacementL": "2.0",
                "EngineCylinders": "4",
            }
        ]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.post("/api/vehicles/decode-vin", json={"vin": "1HGCM82633A004352"})
    assert res.status_code == 200
    body = res.json()
    assert body["make"] == "Honda"
    assert body["engine"] == "2.0L 4-cyl"


def test_decode_vin_folds_series_into_model(client):
    """NHTSA reports the payload/cab designation separately from Model
    (Model='Silverado', Series='1500') -- without it, a decoded truck can't
    be told apart from any other Silverado."""
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "Results": [{"ModelYear": "2021", "Make": "Chevrolet", "Model": "Silverado", "Series": "1500", "Trim": "LT"}]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.post("/api/vehicles/decode-vin", json={"vin": "3GCPWCED5KG123456"})
    assert res.status_code == 200
    assert res.json()["model"] == "Silverado 1500"


def test_decode_vin_does_not_duplicate_series_already_in_model(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "Results": [{"ModelYear": "2021", "Make": "Ford", "Model": "F-150", "Series": "F-150", "Trim": "XLT"}]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        res = client.post("/api/vehicles/decode-vin", json={"vin": "1FTEW1EP7KFA00000"})
    assert res.json()["model"] == "F-150"


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


# --- address autocomplete ----------------------------------------------
#
# A typeahead that can 500 is worse than no typeahead: it turns a helper into
# an error the advisor has to think about while they're mid-address.


def test_address_suggest_ignores_short_queries(client):
    """Two characters match half the country; the request isn't worth making."""
    # If the provider were consulted at all, this patch would blow the test up.
    with patch("app.main.httpx.get", side_effect=AssertionError("should not call provider")):
        res = client.get("/api/address-suggest", params={"q": "12"})
    assert res.status_code == 200
    assert res.json() == []


def test_address_suggest_maps_a_result_into_the_form_fields(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "features": [
            {
                "properties": {
                    "countrycode": "US",
                    "housenumber": "1600",
                    "street": "Pennsylvania Ave NW",
                    "city": "Washington",
                    "state": "District of Columbia",
                    "postcode": "20500",
                }
            }
        ]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        body = client.get("/api/address-suggest?q=1600 Pennsylvania").json()
    assert len(body) == 1
    # The form field holds a two-letter code; the geocoder returns the full
    # name, so an unmapped state would land in the box as unusable text.
    assert body[0] == {
        "label": "1600 Pennsylvania Ave NW, Washington, DC 20500",
        "line1": "1600 Pennsylvania Ave NW",
        "city": "Washington",
        "state": "DC",
        "postal_code": "20500",
    }


def test_address_suggest_skips_non_us_results(client):
    fake_response = MagicMock()
    fake_response.raise_for_status.return_value = None
    fake_response.json.return_value = {
        "features": [
            {"properties": {"countrycode": "CA", "street": "Yonge St", "city": "Toronto"}},
            {"properties": {"countrycode": "US", "street": "Broadway", "city": "Gary", "state": "Indiana"}},
        ]
    }
    with patch("app.main.httpx.get", return_value=fake_response):
        body = client.get("/api/address-suggest?q=street").json()
    assert [s["city"] for s in body] == ["Gary"]


def test_address_suggest_degrades_to_empty_on_any_provider_failure(client):
    """Not just connection errors. This ran as a 500 in a sandbox behind a
    SOCKS proxy, where httpx raises ImportError for a missing optional extra
    -- neither an HTTPError nor a ValueError, which is what the handler used
    to catch. The promise this endpoint makes is that nothing it touches can
    break the form, so the failure it swallows has to be just as broad."""
    for boom in (httpx.ConnectError("offline"), ValueError("not json"), ImportError("no socksio"), RuntimeError("?")):
        with patch("app.main.httpx.get", side_effect=boom):
            res = client.get("/api/address-suggest?q=1600 Pennsylvania")
        assert res.status_code == 200, f"{type(boom).__name__} escaped as {res.status_code}"
        assert res.json() == []


def test_customers_list_carries_visit_aggregates(client):
    """The Customers screen sorts and filters on these counts server-side data,
    so the list endpoint has to carry them: vehicles, unvoided orders, how many
    of those are still open, and the newest order's timestamp."""
    order = make_retail_order(client)  # creates "Retail Customer" + a Focus + 1 RO
    customer_id = order["customer_id"]
    # A second vehicle with no orders bumps vehicle_count only.
    client.post("/api/vehicles", json={"customer_id": customer_id, "year": 2015, "make": "Jeep", "model": "Patriot"})

    row = next(c for c in client.get("/api/customers").json() if c["id"] == customer_id)
    assert row["vehicle_count"] == 2
    assert row["order_count"] == 1
    assert row["open_orders"] == 1
    assert row["last_visit_at"] == order["created_at"]

    # Completing the RO closes it but keeps it counted; voiding removes it
    # from every aggregate including last_visit_at.
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "t"})
    row = next(c for c in client.get("/api/customers").json() if c["id"] == customer_id)
    assert (row["order_count"], row["open_orders"]) == (1, 0)

    client.post(f"/api/orders/{order['id']}/void", json={"actor": "t"})
    row = next(c for c in client.get("/api/customers").json() if c["id"] == customer_id)
    assert (row["order_count"], row["open_orders"]) == (0, 0)
    assert row["last_visit_at"] is None

    # A customer with nothing at all reads zeros, not NULL-shaped surprises.
    bare = client.post("/api/customers", json={"name": "No Car Yet"}).json()
    row = next(c for c in client.get("/api/customers").json() if c["id"] == bare["id"])
    assert (row["vehicle_count"], row["order_count"], row["open_orders"], row["last_visit_at"]) == (0, 0, 0, None)


def test_customer_detail_groups_orders_under_vehicles(client):
    order = make_retail_order(client)
    customer_id, vehicle_id = order["customer_id"], order["vehicle_id"]
    second = client.post(
        "/api/vehicles", json={"customer_id": customer_id, "year": 2015, "make": "Jeep", "model": "Patriot"}
    ).json()

    detail = client.get(f"/api/customers/{customer_id}").json()
    assert detail["name"] == "Retail Customer"
    assert [v["id"] for v in detail["vehicles"]] == [second["id"], vehicle_id]  # newest first
    by_id = {v["id"]: v for v in detail["vehicles"]}
    assert by_id[second["id"]]["orders"] == []
    (ro,) = by_id[vehicle_id]["orders"]
    assert (ro["id"], ro["number"], ro["segment"], ro["voided"]) == (order["id"], order["number"], "retail", 0)

    # Voided orders stay in the detail, flagged -- history shouldn't lose tickets.
    client.post(f"/api/orders/{order['id']}/void", json={"actor": "t"})
    detail = client.get(f"/api/customers/{customer_id}").json()
    (ro,) = {v["id"]: v for v in detail["vehicles"]}[vehicle_id]["orders"]
    assert ro["voided"] == 1


def test_customer_detail_hides_shop_sentinel_and_404s_unknown(client):
    assert client.get("/api/customers/999999").status_code == 404
    # The shop-owned recon sentinel is not a customer; asking for it directly
    # 404s the same as its absence from the list.
    make_recon_vehicle(client)
    from app.main import RECON_SHOP_CUSTOMER_ID

    assert client.get(f"/api/customers/{RECON_SHOP_CUSTOMER_ID}").status_code == 404
