"""The check-over sheet's server half.

PUT /api/orders/{id}/inspection predates its screen by the app's whole life
and had no test of its own -- the front end now leans on its replace-wholesale
contract (every save sends the full sheet; the response and the next order
fetch carry it back exactly), so that contract gets pinned here.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle


def sheet(status="draft", items=None, actor="Ray Ortiz"):
    return {
        "status": status,
        "actor": actor,
        "items": items
        if items is not None
        else [
            {
                "category": "Road test",
                "name": "Brakes feel",
                "condition": "red",
                "measurement": "",
                "notes": "Metal to metal",
            },
            {"category": "Road test", "name": "Starts & idles", "condition": "green", "measurement": "", "notes": ""},
            {
                "category": "Inside",
                "name": "Trunk struts & spare",
                "condition": "not_checked",
                "measurement": "",
                "notes": "",
            },
        ],
    }


def test_inspection_round_trips_on_the_order(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    saved = client.put(f"/api/orders/{order['id']}/inspection", json=sheet())
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["status"] == "draft"
    assert [(it["name"], it["condition"], it["notes"]) for it in body["items"]] == [
        ("Brakes feel", "red", "Metal to metal"),
        ("Starts & idles", "green", ""),
        ("Trunk struts & spare", "not_checked", ""),
    ]

    # The next fetch of the order carries the sheet back whole -- this is what
    # lets the screen redraw after any other save without losing the walk.
    fetched = client.get(f"/api/orders/{order['id']}").json()
    assert fetched["inspection"] is not None
    assert len(fetched["inspection"]["items"]) == 3


def test_inspection_save_replaces_the_sheet_wholesale(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    client.put(f"/api/orders/{order['id']}/inspection", json=sheet())

    # Second save: one line answered differently, one line gone (the car has
    # no AC to check, say). The old rows must not linger underneath.
    second = sheet(
        status="completed",
        items=[
            {
                "category": "Road test",
                "name": "Brakes feel",
                "condition": "yellow",
                "measurement": "",
                "notes": "Worn, not urgent",
            }
        ],
    )
    saved = client.put(f"/api/orders/{order['id']}/inspection", json=second).json()
    assert saved["status"] == "completed"
    assert [(it["name"], it["condition"]) for it in saved["items"]] == [("Brakes feel", "yellow")]


def test_inspection_saves_land_in_the_activity_log(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    client.put(f"/api/orders/{order['id']}/inspection", json=sheet(actor="Antonio"))

    activity = client.get(f"/api/orders/{order['id']}").json()["activity"]
    saves = [a for a in activity if a["action"] == "inspection_saved"]
    assert len(saves) == 1
    assert saves[0]["actor"] == "Antonio"
    assert saves[0]["details"]["item_count"] == 3


def test_inspection_refuses_a_condition_it_does_not_speak(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    bad = sheet(
        items=[{"category": "Road test", "name": "Brakes feel", "condition": "broken", "measurement": "", "notes": ""}]
    )
    assert client.put(f"/api/orders/{order['id']}/inspection", json=bad).status_code == 422
