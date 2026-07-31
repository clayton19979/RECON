"""What we said it would cost, kept apart from what it actually cost.

Receiving a part writes the price the vendor's invoice really said onto the
line -- that part is right, and it is the whole reason the shop's cost figures
can be trusted. What it also used to do was overwrite the only record of what
the line was quoted at, so every "cost against quote" figure in the app ended
up comparing a number to itself. A part written down at $100 and billed at
$175 reported quoted $175, actual $175, on quote; the board's Over Quote card
could not say anything but zero, and the Lot Report's "still to spend" column
was only ever right by accident.

The quote now lives in its own column and survives the bill.
"""

from __future__ import annotations

from app.db import connect
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def part(cost, description="Alternator", part_number="ALT-1", quantity=1):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": 0,
        "unit_cost": cost,
    }


def board_row(client, stock):
    rows = client.get("/api/vehicles-board").json()
    match = [r for r in rows if r["stock_number"] == stock]
    assert len(match) == 1, f"expected one board row for {stock}, got {len(match)}"
    return match[0]


def receive(client, order_id, vendor_id, item_id, invoice_number, unit_cost=None):
    payload = {"item_ids": [item_id], "vendor_id": vendor_id, "invoice_number": invoice_number}
    if unit_cost is not None:
        payload["cost_overrides"] = {str(item_id): unit_cost}
    res = client.post(f"/api/orders/{order_id}/estimate/receive-parts", json=payload)
    assert res.status_code == 200, res.text
    return res.json()


def setup_car(client, stock="R-Q1", vin="1HGCM82633A100001", quoted=100.0):
    vendor = client.post("/api/vendors", json={"name": "NAPA Merrillville"}).json()
    vehicle = make_recon_vehicle(client, stock_number=stock, vin=vin, purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part(quoted)])
    return vendor, vehicle, order, estimate["items"][0]["id"]


def test_a_part_billed_over_its_estimate_keeps_the_estimate(client):
    """The bug in one test. Quote $100, invoice says $175: the car cost $175
    and was quoted $100, and the board has to be able to say both."""
    vendor, _vehicle, order, item_id = setup_car(client)

    before = board_row(client, "R-Q1")
    assert before["quoted_cost"] == 100.0
    assert before["actual_cost"] == 0.0

    receive(client, order["id"], vendor["id"], item_id, "INV-100", unit_cost=175)

    after = board_row(client, "R-Q1")
    assert after["actual_cost"] == 175.0, "the car really did cost what the invoice said"
    assert after["quoted_cost"] == 100.0, (
        "receiving the part overwrote what it was quoted at -- the $75 overrun is gone"
    )


def test_a_part_billed_under_its_estimate_keeps_the_estimate_too(client):
    """The cheaper half of the same coin. Used parts are the norm here, so
    coming in under the quote is at least as common as going over."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q2", vin="1HGCM82633A100002")
    receive(client, order["id"], vendor["id"], item_id, "INV-101", unit_cost=60)

    row = board_row(client, "R-Q2")
    assert row["actual_cost"] == 60.0
    assert row["quoted_cost"] == 100.0


def test_a_part_that_came_in_at_the_quoted_price_reads_the_same_as_before(client):
    """The ordinary case has to be untouched -- most parts cost what they were
    quoted at, and those cars must not start reporting a variance."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q3", vin="1HGCM82633A100003")
    receive(client, order["id"], vendor["id"], item_id, "INV-102")

    row = board_row(client, "R-Q3")
    assert row["quoted_cost"] == 100.0
    assert row["actual_cost"] == 100.0
    assert row["open_cost"] == 0.0


def test_still_to_spend_is_the_unreceived_parts_not_quote_minus_spent(client):
    """A car with one part in at $60 against a $100 quote and a second part
    still on order owes the second part's money and nothing else. Worked out
    as quote-minus-spent it would come to $140 -- the real $100 outstanding
    plus the $40 the first part happened to save."""
    vendor = client.post("/api/vendors", json={"name": "Pull-A-Part"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-Q4", vin="1HGCM82633A100004", purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [part(100, "Alternator", "ALT-1"), part(100, "Starter", "ST-1")],
    )
    first = estimate["items"][0]["id"]
    receive(client, order["id"], vendor["id"], first, "INV-103", unit_cost=60)

    row = board_row(client, "R-Q4")
    assert row["quoted_cost"] == 200.0
    assert row["actual_cost"] == 60.0
    assert row["open_cost"] == 100.0, "only the part that hasn't landed is still to spend"

    lot = [r for r in client.get("/api/reports/lot").json() if r["stock_number"] == "R-Q4"]
    assert lot[0]["remaining_cost"] == 100.0
    assert "$100.00 of quoted work left" in lot[0]["needs"]


def test_a_finished_car_that_came_in_cheap_still_needs_nothing(client):
    """The regression this could most easily have introduced: with the quote
    kept, quote-minus-spent on a finished car under its estimate is a positive
    number, and the Needs cell would have contradicted itself."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q5", vin="1HGCM82633A100005")
    receive(client, order["id"], vendor["id"], item_id, "INV-104", unit_cost=60)
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    row = next(r for r in client.get("/api/reports/lot").json() if r["stock_number"] == "R-Q5")
    assert row["lot_bucket"] == "ready"
    assert row["remaining_cost"] == 0.0
    assert row["needs"] == "Nothing — ready to go"


def test_labor_and_fees_are_never_outstanding(client):
    """They cost the shop the moment they are logged -- there is nothing left
    to wait on -- so they must not land in the still-to-spend column."""
    vehicle = make_recon_vehicle(client, stock_number="R-Q6", vin="1HGCM82633A100006", purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Install", "quantity": 2, "unit_price": 0, "unit_cost": 0},
            {"kind": "fee", "description": "Disposal", "quantity": 1, "unit_price": 0, "unit_cost": 15},
        ],
    )
    row = board_row(client, "R-Q6")
    assert row["open_cost"] == 0.0
    assert row["actual_cost"] == 15.0


def test_a_returned_part_is_not_still_to_spend(client):
    """Sending a part back to the vendor closes it out -- it is neither money
    in the car nor money the car is still waiting on."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q7", vin="1HGCM82633A100007")
    receive(client, order["id"], vendor["id"], item_id, "INV-105", unit_cost=175)
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"returned": True, "actor": "tester"}
    )
    assert res.status_code == 200, res.text

    row = board_row(client, "R-Q7")
    assert row["actual_cost"] == 0.0
    assert row["open_cost"] == 0.0


def test_editing_the_cost_before_a_part_lands_moves_the_quote_with_it(client):
    """While a line is still a quote, the Cost box IS the quote -- repricing a
    part nobody has ordered yet must not leave a stale estimate behind."""
    _vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q8", vin="1HGCM82633A100008")
    save_estimate(client, order["id"], [{**part(140), "id": item_id}])

    row = board_row(client, "R-Q8")
    assert row["quoted_cost"] == 140.0
    assert row["open_cost"] == 140.0


def test_correcting_a_keyed_wrong_invoice_price_does_not_rewrite_the_quote(client):
    """Once the part has landed, the Cost box holds what the vendor billed.
    Fixing a typo in it is a correction to the bill, not to the estimate."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q9", vin="1HGCM82633A100009")
    receive(client, order["id"], vendor["id"], item_id, "INV-106", unit_cost=1750)
    save_estimate(client, order["id"], [{**part(175), "id": item_id}])

    row = board_row(client, "R-Q9")
    assert row["actual_cost"] == 175.0, "the corrected bill is what the car cost"
    assert row["quoted_cost"] == 100.0, "correcting the bill rewrote what the shop had quoted"


def test_the_ticket_carries_the_quoted_price_to_the_screen(client):
    """The grid puts a "Quoted $100.00" note under a line that was billed at
    something else; it can only do that if the API sends the figure."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q10", vin="1HGCM82633A100010")
    receive(client, order["id"], vendor["id"], item_id, "INV-107", unit_cost=175)

    detail = client.get(f"/api/orders/{order['id']}").json()
    line = detail["estimate"]["items"][0]
    assert line["unit_cost"] == 175.0
    assert line["quoted_unit_cost"] == 100.0


def test_a_line_that_arrived_only_on_an_invoice_has_no_quote_to_miss(client):
    """A part nobody wrote on the ticket was never quoted, so it must not be
    reported as an overrun against an estimate that never existed."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-Q11", vin="1HGCM82633A100011", purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "WorldPac",
            "invoice_number": "INV-108",
            "order_id": order["id"],
            "items": [{"part_number": "BLT-9", "description": "Serpentine belt", "quantity": 1, "unit_cost": 45}],
            "subtotal": 45,
            "tax": 0,
            "total": 45,
        },
    )
    assert res.status_code in (200, 201), res.text
    assert res.json()["status"] == "posted", res.text

    row = board_row(client, "R-Q11")
    assert row["actual_cost"] == 45.0
    assert row["quoted_cost"] == 45.0, "an unquoted part must not read as money we said we'd spend and didn't"
    assert row["open_cost"] == 0.0


def test_a_we_owe_keeps_its_quote_too(client):
    """We-owe work runs through the same rollup; the promise is quoted and
    billed exactly like a recon ticket."""
    vendor = client.post("/api/vendors", json={"name": "O'Reilly"}).json()
    item = make_we_owe(client, description="Tie rod the salesman promised")
    order = client.post("/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    estimate = save_estimate(client, order["id"], [part(80, "Tie rod end", "TR-1")])
    receive(client, order["id"], vendor["id"], estimate["items"][0]["id"], "INV-109", unit_cost=110)

    rows = client.get("/api/vehicles-board").json()
    row = next(r for r in rows if r["we_owe_id"] == item["id"])
    assert row["actual_cost"] == 110.0
    assert row["quoted_cost"] == 80.0


def test_lines_written_before_the_quote_was_kept_still_read_as_they_did(client, db_path):
    """An upgraded database arrives with no quote recorded on any existing
    line. Those rows must go on answering exactly what they answered before,
    not start reporting a $0 estimate for every car in the shop's history."""
    vendor, _vehicle, order, item_id = setup_car(client, stock="R-Q12", vin="1HGCM82633A100012")
    receive(client, order["id"], vendor["id"], item_id, "INV-110", unit_cost=175)
    # Exactly the state the migration leaves behind: the column exists and is
    # empty, because there was never anywhere to write the quote down.
    with connect(db_path) as db:
        db.execute("UPDATE estimate_items SET quoted_unit_cost=NULL")
        db.commit()

    row = board_row(client, "R-Q12")
    assert row["quoted_cost"] == 175.0, "a row with no quote on file falls back to what it cost"
    assert row["actual_cost"] == 175.0
    assert row["open_cost"] == 0.0
