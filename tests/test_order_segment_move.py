"""Moving a ticket between recon and we-owe.

Before this, a ticket written up on the wrong side could only be fixed by
deleting it and starting over -- which threw away the estimate, the history
and any vendor invoice already posted against it. So in practice the wrong
ticket was kept and its cost sat on the wrong vehicle forever.
"""
from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def _spend(client, order_id, amount):
    save_estimate(client, order_id, [
        {"kind": "labor", "description": "Work", "quantity": 1, "unit_price": amount, "unit_cost": amount},
    ])


def _cost_of(client, segment, ref_id):
    path = f"/api/recon/vehicles/{ref_id}" if segment == "recon" else f"/api/we-owe/{ref_id}"
    return client.get(path).json()["total_cost"]


def test_moving_a_ticket_takes_its_cost_with_it(client):
    """The whole point: the money leaves the wrong vehicle and joins the right
    one, because cost rolls up through the ticket's segment link."""
    recon = make_recon_vehicle(client, stock_number="R-7100")
    we_owe = make_we_owe(client)
    order = make_recon_order(client, recon["id"])
    _spend(client, order["id"], 425)

    assert _cost_of(client, "recon", recon["id"]) == 425
    assert _cost_of(client, "we_owe", we_owe["id"]) == 0

    res = client.patch(f"/api/orders/{order['id']}/segment",
                       json={"segment": "we_owe", "we_owe_id": we_owe["id"], "actor": "clay"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["segment"] == "we_owe"
    assert body["we_owe_id"] == we_owe["id"]
    assert body["recon_vehicle_id"] is None

    assert _cost_of(client, "recon", recon["id"]) == 0, "cost must leave the old vehicle"
    assert _cost_of(client, "we_owe", we_owe["id"]) == 425, "cost must land on the new one"


def test_moving_back_to_recon_works_too(client):
    recon = make_recon_vehicle(client, stock_number="R-7101")
    we_owe = make_we_owe(client)
    order = client.post("/api/orders", json={
        "concern": "Promised work", "segment": "we_owe", "we_owe_id": we_owe["id"],
    }).json()
    _spend(client, order["id"], 200)

    res = client.patch(f"/api/orders/{order['id']}/segment",
                       json={"segment": "recon", "recon_vehicle_id": recon["id"], "actor": "clay"})
    assert res.status_code == 200, res.text
    assert res.json()["we_owe_id"] is None
    assert _cost_of(client, "recon", recon["id"]) == 200
    assert _cost_of(client, "we_owe", we_owe["id"]) == 0


def test_the_estimate_and_its_lines_follow_the_ticket(client):
    """Nothing may be lost in the move -- that was the reason people avoided
    fixing a mis-filed ticket in the first place."""
    recon = make_recon_vehicle(client, stock_number="R-7102")
    we_owe = make_we_owe(client)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [
        {"kind": "part", "description": "Alternator", "part_number": "ALT-9", "quantity": 1, "unit_price": 190, "unit_cost": 190},
        {"kind": "labor", "description": "Install", "quantity": 2, "unit_price": 95, "unit_cost": 95},
    ])

    client.patch(f"/api/orders/{order['id']}/segment",
                 json={"segment": "we_owe", "we_owe_id": we_owe["id"], "actor": "clay"})

    detail = client.get(f"/api/orders/{order['id']}").json()
    descriptions = [i["description"] for i in detail["estimate"]["items"]]
    assert descriptions == ["Alternator", "Install"]


def test_move_is_recorded_in_the_activity_log(client):
    recon = make_recon_vehicle(client, stock_number="R-7103")
    we_owe = make_we_owe(client)
    order = make_recon_order(client, recon["id"])

    client.patch(f"/api/orders/{order['id']}/segment",
                 json={"segment": "we_owe", "we_owe_id": we_owe["id"], "actor": "clay"})

    actions = [a["action"] for a in client.get(f"/api/orders/{order['id']}").json()["activity"]]
    assert "segment_changed" in actions


def test_moving_to_the_same_segment_is_rejected(client):
    recon = make_recon_vehicle(client, stock_number="R-7104")
    other = make_recon_vehicle(client, stock_number="R-7105")
    order = make_recon_order(client, recon["id"])

    res = client.patch(f"/api/orders/{order['id']}/segment",
                       json={"segment": "recon", "recon_vehicle_id": other["id"]})
    assert res.status_code == 409


def test_target_must_exist_and_be_named(client):
    recon = make_recon_vehicle(client, stock_number="R-7106")
    order = make_recon_order(client, recon["id"])

    assert client.patch(f"/api/orders/{order['id']}/segment", json={"segment": "we_owe"}).status_code == 422
    assert client.patch(f"/api/orders/{order['id']}/segment",
                        json={"segment": "we_owe", "we_owe_id": 99999}).status_code == 404


def test_cannot_move_onto_an_archived_vehicle(client):
    recon = make_recon_vehicle(client, stock_number="R-7107")
    we_owe = make_we_owe(client)
    order = make_recon_order(client, recon["id"])
    client.post(f"/api/we-owe/{we_owe['id']}/archive", json={})

    res = client.patch(f"/api/orders/{order['id']}/segment",
                       json={"segment": "we_owe", "we_owe_id": we_owe["id"]})
    assert res.status_code == 409


def test_cannot_move_a_voided_ticket(client):
    recon = make_recon_vehicle(client, stock_number="R-7108")
    we_owe = make_we_owe(client)
    order = make_recon_order(client, recon["id"])
    client.post(f"/api/orders/{order['id']}/void", json={"actor": "clay"})

    res = client.patch(f"/api/orders/{order['id']}/segment",
                       json={"segment": "we_owe", "we_owe_id": we_owe["id"]})
    assert res.status_code == 409
