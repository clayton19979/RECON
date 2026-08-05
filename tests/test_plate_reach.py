"""The plate on the back of the car has to lead back to the record.

A plate is the one identifier you can read standing in the lot: no stock number
on the glass, no VIN without opening a door, and on a lot car often no customer
name to ask for either. The write-up form has always had a Plate box.

It went nowhere. `create_recon_vehicle` wrote two empty strings into the plate
columns no matter what was typed, the patch models had no plate field so it
could not be filled in afterwards either, the detail queries never selected the
column, and the board rows never carried it -- so no lot car had a plate on
file, no screen showed one, and the search bar could not find a car by one.
Meanwhile the agent search and the MCP tool both advertise plate lookup, which
could only ever come back empty for exactly the cars this shop owns.

This covers the whole path: typed at intake, corrected later, carried on the
board rows the search filters, and shown on the car's own page.
"""

from __future__ import annotations

from app.db import normalize_plate
from tests.helpers import make_recon_vehicle, make_we_owe


def board_row(client, stock_number):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def test_normalize_plate_folds_the_ways_one_plate_gets_typed():
    """Read off a dirty bumper and typed in a hurry, one plate arrives three
    ways. Letters and digits only, upper-cased, so they are one value."""
    assert normalize_plate("abc 1234") == "ABC1234"
    assert normalize_plate("ABC-1234") == "ABC1234"
    assert normalize_plate(" abc1234 ") == "ABC1234"
    # Empty stays empty rather than becoming None: the column is NOT NULL.
    assert normalize_plate("") == ""
    assert normalize_plate(None) == ""


def test_intake_keeps_the_plate_that_was_typed(client):
    recon = make_recon_vehicle(client, stock_number="R-PL1", plate="abc 1234", plate_state="in")

    assert recon["plate"] == "ABC1234", "the write-up form's Plate box was thrown away at save"
    assert recon["plate_state"] == "IN"


def test_a_car_written_up_without_a_plate_simply_has_none(client):
    """The box is optional -- a car off an auction run often arrives with no
    plate on it at all -- and a blank must stay blank, not become a stray
    value the search could match."""
    recon = make_recon_vehicle(client, stock_number="R-PL2")

    assert recon["plate"] == ""
    assert recon["plate_state"] == ""
    assert board_row(client, "R-PL2")["plate"] == ""


def test_the_board_row_carries_the_plate(client):
    """The search bar filters the rows the browser already holds, so a plate
    the row does not carry is a plate nobody can find the car by."""
    make_recon_vehicle(client, stock_number="R-PL3", plate="XYZ-9080", plate_state="IN")

    row = board_row(client, "R-PL3")
    assert row["plate"] == "XYZ9080", "the board row is not carrying the plate the search matches on"
    assert row["plate_state"] == "IN"


def test_a_mistyped_plate_can_be_corrected(client):
    """A plate is misread off a dirty car as often as a VIN is, and a lot
    car's plate changes outright when the dealer tag comes off it."""
    recon = make_recon_vehicle(client, stock_number="R-PL4", plate="AAA1111", plate_state="IN")

    res = client.patch(f"/api/recon/vehicles/{recon['id']}", json={"plate": "bbb-2222", "plate_state": "il"})
    assert res.status_code == 200, res.text
    assert res.json()["plate"] == "BBB2222"
    assert res.json()["plate_state"] == "IL"
    assert board_row(client, "R-PL4")["plate"] == "BBB2222"


def test_the_plate_can_be_taken_off_again(client):
    """Blanking the box means the tag came off the car, which is a real edit
    -- not "no change". Otherwise a sold car keeps answering to a plate that
    is now on somebody else's bumper."""
    recon = make_recon_vehicle(client, stock_number="R-PL5", plate="CCC3333", plate_state="IN")

    res = client.patch(f"/api/recon/vehicles/{recon['id']}", json={"plate": "", "plate_state": ""})
    assert res.status_code == 200, res.text
    assert res.json()["plate"] == ""
    assert board_row(client, "R-PL5")["plate"] == ""


def test_an_edit_that_does_not_mention_the_plate_leaves_it_alone(client):
    """Every other field on the edit dialog saves through the same patch, so
    a mileage correction must not wipe the plate."""
    recon = make_recon_vehicle(client, stock_number="R-PL6", plate="DDD4444", plate_state="IN")

    res = client.patch(f"/api/recon/vehicles/{recon['id']}", json={"mileage": 71000})
    assert res.status_code == 200, res.text
    assert res.json()["plate"] == "DDD4444"
    assert res.json()["plate_state"] == "IN"


def test_the_cars_own_page_can_show_its_plate(client):
    make_recon_vehicle(client, stock_number="R-PL7", plate="EEE5555", plate_state="IN")
    recon_id = board_row(client, "R-PL7")["recon_id"]

    detail = client.get(f"/api/recon/vehicles/{recon_id}").json()
    assert detail["plate"] == "EEE5555", "the detail query is not selecting the plate column"
    assert detail["plate_state"] == "IN"


def test_a_we_owe_car_carries_its_customers_plate_too(client):
    """A we-owe car is the customer's, and it sits in this lot waiting on the
    promise exactly like a recon car does -- so it has to be findable the same
    way. Its plate is entered on the customer's vehicle record."""
    we_owe = make_we_owe(client, customer_name="Renata Silva")
    res = client.patch(f"/api/we-owe/{we_owe['id']}", json={"plate": "fff 6666", "plate_state": "in"})
    assert res.status_code == 200, res.text
    assert res.json()["plate"] == "FFF6666"
    assert res.json()["plate_state"] == "IN"

    rows = client.get("/api/vehicles-board").json()
    row = next(r for r in rows if r["we_owe_id"] == we_owe["id"])
    assert row["plate"] == "FFF6666", "the we-owe board row is not carrying the plate"


def test_a_retail_car_stores_its_plate_the_same_way(client):
    """Retail vehicles already accepted a plate, but through their own
    spelling of the rule -- one that kept a dash. Two records of one car have
    to agree, whichever screen entered them."""
    customer = client.post("/api/customers", json={"name": "Whitney Cole"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={
            "customer_id": customer["id"],
            "year": 2016,
            "make": "Subaru",
            "model": "Outback",
            "plate": "ggg-7777",
            "plate_state": "in",
        },
    ).json()

    assert vehicle["plate"] == "GGG7777"
    assert vehicle["plate_state"] == "IN"

    updated = client.patch(f"/api/retail/vehicles/{vehicle['id']}", json={"plate": "hhh 8888"}).json()
    assert updated["plate"] == "HHH8888"
