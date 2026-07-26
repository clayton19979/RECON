"""The retail vehicle detail endpoints -- a customer's own car as a
first-class page, keyed by vehicles.id rather than a recon/we-owe
container row."""
from __future__ import annotations

from tests.helpers import make_recon_vehicle, make_retail_order, save_estimate


def _retail_setup(client, name="Dana Retail"):
    customer = client.post("/api/customers", json={"name": name}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2017, "make": "Toyota", "model": "Camry", "vin": "4t1bf1fk5hu300001"},
    ).json()
    return customer, vehicle


def _retail_order(client, customer, vehicle, concern="Brakes grinding"):
    res = client.post(
        "/api/orders",
        json={"concern": concern, "segment": "retail", "customer_id": customer["id"], "vehicle_id": vehicle["id"]},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_retail_detail_carries_customer_and_rollup(client):
    customer, vehicle = _retail_setup(client)
    order = _retail_order(client, customer, vehicle)
    save_estimate(client, order["id"], [
        {"kind": "labor", "description": "Brake job", "quantity": 2, "unit_price": 120, "unit_cost": 80},
    ])

    detail = client.get(f"/api/retail/vehicles/{vehicle['id']}").json()
    assert detail["customer_name"] == "Dana Retail"
    assert detail["customer_id"] == customer["id"]
    assert detail["make"] == "Toyota"
    # The detail page treats all three segments uniformly: falsy archived_at
    # means never locked, and edit_version exists but carries no meaning.
    assert not detail["archived_at"]
    assert detail["edit_version"] == 0
    assert [o["id"] for o in detail["orders"]] == [order["id"]]
    assert detail["quoted_cost"] == 160.0
    assert detail["last_activity"]["at"]


def test_retail_detail_unknown_and_shop_owned_404(client):
    assert client.get("/api/retail/vehicles/9999").status_code == 404
    recon = make_recon_vehicle(client)
    # A recon car's vehicle row belongs to the shop sentinel customer: it has
    # a recon page, so the retail endpoint must refuse to double-serve it.
    assert client.get(f"/api/retail/vehicles/{recon['vehicle_id']}").status_code == 404
    assert client.patch(f"/api/retail/vehicles/{recon['vehicle_id']}", json={"color": "Red"}).status_code == 404


def test_retail_rollup_excludes_other_segments_and_voided(client):
    customer, vehicle = _retail_setup(client)
    # A we-owe promise on the same physical car must not leak into the
    # retail page's totals -- it has its own page and its own money story.
    we_owe = client.post(
        "/api/we-owe",
        json={"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": "Owed mirror"},
    ).json()
    wo_order = client.post(
        "/api/orders", json={"concern": "Owed mirror", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, wo_order["id"], [
        {"kind": "labor", "description": "Mirror swap", "quantity": 1, "unit_price": 90, "unit_cost": 60},
    ])

    keep = _retail_order(client, customer, vehicle, concern="Brake job")
    save_estimate(client, keep["id"], [
        {"kind": "labor", "description": "Brakes", "quantity": 1, "unit_price": 200, "unit_cost": 150},
    ])
    voided = _retail_order(client, customer, vehicle, concern="Started by mistake")
    save_estimate(client, voided["id"], [
        {"kind": "labor", "description": "Oops", "quantity": 1, "unit_price": 500, "unit_cost": 400},
    ])
    client.post(f"/api/orders/{voided['id']}/void", json={"actor": "tester"})

    detail = client.get(f"/api/retail/vehicles/{vehicle['id']}").json()
    # Voided stays visible in order history (traceability), we-owe doesn't
    # appear at all, and only the live retail ticket counts toward cost.
    assert {o["id"] for o in detail["orders"]} == {keep["id"], voided["id"]}
    assert detail["quoted_cost"] == 150.0


def test_retail_patch_updates_vehicle_info(client):
    customer, vehicle = _retail_setup(client)
    _retail_order(client, customer, vehicle)
    res = client.patch(
        f"/api/retail/vehicles/{vehicle['id']}",
        json={"vin": "4t1bf1fk5hu300002", "mileage": 88123, "color": " Silver ", "plate": "abc1234", "expected_version": 0},
    )
    assert res.status_code == 200, res.text
    detail = res.json()
    assert detail["vin"] == "4T1BF1FK5HU300002"
    assert detail["mileage"] == 88123
    assert detail["color"] == "Silver"
    assert detail["plate"] == "ABC1234"
    # And it stuck.
    again = client.get(f"/api/retail/vehicles/{vehicle['id']}").json()
    assert again["mileage"] == 88123


def test_retail_detail_lists_customers_other_vehicles(client):
    customer, camry = _retail_setup(client)
    truck = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2020, "make": "Ford", "model": "F-150", "plate": "TRK 42", "plate_state": "mi"},
    ).json()
    # Someone else's car must never show up in this customer's list.
    other_customer, other_vehicle = _retail_setup(client, name="Sam Stranger")

    open_ro = _retail_order(client, customer, truck, concern="Rattle over bumps")
    done_ro = _retail_order(client, customer, truck, concern="Oil change")
    client.patch(f"/api/orders/{done_ro['id']}/status", json={"status": "complete", "actor": "tester"})
    voided = _retail_order(client, customer, truck, concern="Started by mistake")
    client.post(f"/api/orders/{voided['id']}/void", json={"actor": "tester"})

    detail = client.get(f"/api/retail/vehicles/{camry['id']}").json()
    others = detail["other_vehicles"]
    # The truck, and only the truck: not the page's own car, not a stranger's.
    assert [v["id"] for v in others] == [truck["id"]]
    row = others[0]
    assert (row["year"], row["make"], row["model"]) == (2020, "Ford", "F-150")
    # Counts answer "does this car have history / is something open" -- the
    # voided ticket is nobody's history.
    assert row["order_count"] == 2
    assert row["open_orders"] == 1

    # And symmetric from the truck's own page.
    from_truck = client.get(f"/api/retail/vehicles/{truck['id']}").json()
    assert [v["id"] for v in from_truck["other_vehicles"]] == [camry["id"]]
    assert from_truck["other_vehicles"][0]["order_count"] == 0

    # An only-car customer gets an empty list, not a missing key.
    assert client.get(f"/api/retail/vehicles/{other_vehicle['id']}").json()["other_vehicles"] == []


def test_add_second_vehicle_then_it_appears_as_other(client):
    customer, camry = _retail_setup(client)
    res = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2015, "make": "Honda", "model": "Odyssey", "vin": "5fnrl5h60fb000001"},
    )
    assert res.status_code == 201, res.text
    van = res.json()
    detail = client.get(f"/api/retail/vehicles/{camry['id']}").json()
    assert [v["id"] for v in detail["other_vehicles"]] == [van["id"]]
    assert detail["other_vehicles"][0]["vin"] == "5FNRL5H60FB000001"


def test_task_linked_to_retail_order_is_jumpable(client):
    order = make_retail_order(client)
    task = client.post("/api/tasks", json={"title": "Call about brakes", "order_id": order["id"]}).json()
    row = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    # The chip needs a segment, a ref id (the vehicle row), and a label that
    # says whose car it is -- same contract recon/we-owe rows already meet.
    assert row["order_segment"] == "retail"
    assert row["order_vehicle_id"] == order["vehicle_id"]
    assert row["order_label"] == "Retail: Retail Customer"
