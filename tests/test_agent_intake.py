"""The agent's write path: VIN validation, atomic intake, and additive lines.

These cover the three things that make an AI advisor safe to point at a live
shop database -- it cannot record a misread VIN, it cannot leave a half-created
car behind, and it cannot delete work it wasn't looking at.
"""

from __future__ import annotations

import pytest

from app.db import vin_check_digit_ok
from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate, valid_vin

# The worked example from the ISO 3779 / NHTSA documentation, whose check digit
# is the X case -- the one an implementation using str(remainder) gets wrong.
REFERENCE_VIN = "1M8GDM9AXKP042788"


@pytest.mark.parametrize(
    "vin,expected",
    [
        (REFERENCE_VIN, True),
        ("5YJ3E1EA6PF384836", True),  # a real Tesla Model 3 VIN
        ("11111111111111111", True),  # degenerate but genuinely valid
        ("1M8GDM9AXKP042789", False),  # last character transposed
        ("1M8GDM9A0KP042788", False),  # check digit itself wrong
        ("1M8GDM9AXKP04278I", False),  # I is not a legal VIN character
        ("1M8GDM9AXKP0427", False),  # too short to check
        ("", False),
        (None, False),
    ],
)
def test_vin_check_digit(vin, expected):
    assert vin_check_digit_ok(vin) is expected


def test_decode_vin_refuses_a_vin_that_fails_its_check_digit(client):
    """400, not 404: "that isn't a VIN" and "no such vehicle" are different
    answers, and only one of them means look at the plate again."""
    response = client.post("/api/vehicles/decode-vin", json={"vin": "1M8GDM9AXKP042789"})

    assert response.status_code == 400
    assert "check digit" in response.json()["detail"]


def test_decode_vin_still_accepts_a_partial_vin(client):
    """A short VIN can't be check-digit verified and isn't wrong -- the field
    accepts 5 characters on purpose. It must not be rejected as malformed."""
    response = client.post("/api/vehicles/decode-vin", json={"vin": "1M8GD"})

    assert response.status_code != 400


def test_intake_creates_vehicle_order_and_jobs_in_one_call(client):
    response = client.post(
        "/api/agent/intake",
        json={
            "stock_number": "R-1042",
            "year": 2014,
            "make": "Chevrolet",
            "model": "Malibu",
            "vin": REFERENCE_VIN,
            "concern": "front brakes grinding",
            "jobs": [{"title": "Front brakes"}, {"title": "Left outer tie rod"}],
            "actor": "ai:hermes",
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["stock_number"] == "R-1042"
    assert body["vehicle"] == "2014 Chevrolet Malibu"
    assert [job["title"] for job in body["jobs"]] == ["Front brakes", "Left outer tie rod"]

    ticket = client.get(f"/api/orders/{body['order_id']}").json()
    assert ticket["segment"] == "recon"
    assert ticket["concern"] == "front brakes grinding"
    assert len(ticket["estimate"]["jobs"]) == 2
    # The workflow row is what Date In and the assignment card hang off; an
    # intake that skipped it would produce a ticket the board can't fully read.
    assert ticket["assignment"]["date_in"]


def test_intake_records_a_car_with_no_work_yet(client):
    """A car can arrive before anyone has written work against it. Forcing a
    concern would mean inventing one."""
    body = client.post(
        "/api/agent/intake",
        json={"stock_number": "R-2000", "year": 2015, "make": "Ford", "model": "Fusion"},
    ).json()

    assert body["order_id"] is None
    assert client.get(f"/api/recon/vehicles/{body['recon_vehicle_id']}").status_code == 200


def test_intake_refuses_a_vin_that_fails_its_check_digit_and_writes_nothing(client):
    response = client.post(
        "/api/agent/intake",
        json={
            "stock_number": "R-1042",
            "year": 2014,
            "make": "Chevrolet",
            "model": "Malibu",
            "vin": "1M8GDM9AXKP042789",
            "concern": "front brakes",
        },
    )

    assert response.status_code == 400
    assert client.get("/api/vehicles-board").json() == []


def test_intake_refuses_a_duplicate_stock_number(client):
    make_recon_vehicle(client, stock_number="R-1042")

    response = client.post(
        "/api/agent/intake",
        json={"stock_number": "R1042", "year": 2014, "make": "Chevrolet", "model": "Malibu"},
    )

    # Normalized: R-1042 and R1042 are one car, and the refusal names it.
    assert response.status_code == 409
    assert "R-1042" in response.json()["detail"]
    assert len(client.get("/api/vehicles-board").json()) == 1


def test_intake_allows_a_vin_last_seen_on_an_archived_car(client):
    """Walt buys cars back. A second recon episode on one VIN is the case
    unit_lifetime exists to add up, not a duplicate."""
    first = make_recon_vehicle(client, stock_number="R-1042", vin=valid_vin("R-1042"))
    client.post(f"/api/recon/vehicles/{first['id']}/archive")

    response = client.post(
        "/api/agent/intake",
        json={
            "stock_number": "R-2042",
            "year": 2014,
            "make": "Chevrolet",
            "model": "Malibu",
            "vin": valid_vin("R-1042"),
        },
    )

    assert response.status_code == 201, response.text


def test_intake_rolls_back_everything_when_a_later_step_fails(client, monkeypatch):
    """The reason this endpoint exists. Three separate API calls can fail at
    step two and leave a car with no ticket; one transaction cannot."""
    from app import agent_routes

    monkeypatch.setattr(
        agent_routes, "initialize_order_workflow", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    )

    with pytest.raises(RuntimeError):
        client.post(
            "/api/agent/intake",
            json={
                "stock_number": "R-1042",
                "year": 2014,
                "make": "Chevrolet",
                "model": "Malibu",
                "concern": "front brakes",
            },
        )

    # No orphan vehicle, no orphan recon record.
    assert client.get("/api/vehicles-board").json() == []


def test_append_lines_does_not_delete_lines_it_was_not_shown(client):
    """The hazard this endpoint exists to avoid: POST /estimate replaces the
    whole line set, so a caller working from a partial picture wipes the rest."""
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Front rotors", "quantity": 2, "unit_price": 41.5, "unit_cost": 41.5},
            {"kind": "part", "description": "Front pads", "quantity": 1, "unit_price": 28.0, "unit_cost": 28.0},
        ],
    )

    response = client.post(
        f"/api/orders/{order['id']}/estimate/items",
        json={
            "items": [
                {
                    "kind": "part",
                    "description": "Left outer tie rod",
                    "quantity": 1,
                    "unit_cost": 34.0,
                    "unit_price": 34.0,
                }
            ],
            "actor": "ai:hermes",
        },
    )

    assert response.status_code == 201, response.text
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert [item["description"] for item in items] == ["Front rotors", "Front pads", "Left outer tie rod"]
    assert response.json()["total"] == pytest.approx(145.0)


def test_append_lines_marks_provenance_that_survives_a_grid_resave(client):
    """source is the durable marker. review_required is not: the estimate grid
    autosaves on open and resets it, so a line would lose its history simply
    because somebody looked at the ticket."""
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    order = make_recon_order(client, vehicle["id"])
    client.post(
        f"/api/orders/{order['id']}/estimate/items",
        json={
            "items": [{"kind": "part", "description": "Tie rod", "quantity": 1, "unit_cost": 34.0, "unit_price": 34.0}]
        },
    )

    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert items[0]["source"] == "ai"

    # Round-trip the grid the way the browser does -- every row it is showing,
    # sent straight back. An 'ai' source the API rejected would 422 here and
    # make the whole ticket unsaveable.
    resave = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={
            "labor_rate": 0,
            "tax_rate": 0,
            "actor": "ui",
            "items": [
                {
                    "id": items[0]["id"],
                    "kind": "part",
                    "description": "Tie rod",
                    "quantity": 1,
                    "unit_price": 34.0,
                    "unit_cost": 34.0,
                    "source": "ai",
                }
            ],
        },
    )

    assert resave.status_code == 200, resave.text
    assert resave.json()["items"][0]["source"] == "ai"


def test_append_lines_accepts_a_part_with_no_part_number(client):
    """This shop runs on used and junkyard parts; the number frequently does
    not exist until the part is in hand. /findings requires one and is the
    wrong door for an advisor writing down work."""
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    order = make_recon_order(client, vehicle["id"])

    response = client.post(
        f"/api/orders/{order['id']}/estimate/items",
        json={"items": [{"kind": "part", "description": "Used door mirror, junkyard", "quantity": 1}]},
    )

    assert response.status_code == 201, response.text
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert item["part_number"] == ""
    # No price invented. It lands when the vendor invoice is received.
    assert item["unit_cost"] == 0
