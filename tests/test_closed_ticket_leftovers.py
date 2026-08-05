"""What a closed ticket leaves behind must not read as work still owed.

This is the other half of test_closed_ticket_parts.py. That one stopped a
closed ticket's ordered part from being chased as if it were still coming.
Two things it did not cover kept the same contradiction alive on the row Walt
actually reads:

- **The money.** A part on a closed ticket that nobody marked received is
  money already spent -- that is the whole reason the Missing Receipts desk
  exists. It was also being added into "still to spend", so the same dollars
  appeared twice on one line with opposite meanings: "$380.00 of work left"
  and "$380.00 not in the cost".

- **The repairs.** A job nobody ticked off before the ticket was closed stayed
  on the car's "still needs" list forever. A car sitting in Ready to go read
  "0 of 2 repairs finished" on its card, and the moment a second ticket was
  written -- the everyday "it came back" case -- the sheet told Walt the car
  still needed a windshield it had already had.

The rule both of these were missing is the one the app already applies to
voided tickets and to parts on order: closing a ticket is the shop saying the
work is done, so nothing on it is outstanding any more.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate

TIRES = {
    "kind": "part",
    "description": "Tires (set of 4)",
    "part_number": "TR-SET-16",
    "quantity": 1,
    "unit_price": 380,
    "unit_cost": 380,
}


def board_row(client, stock_number):
    return next(r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == stock_number)


def lot_row(client, stock_number):
    return next(r for r in client.get("/api/reports/lot").json() if r["stock_number"] == stock_number)


def add_job(client, order_id, title):
    res = client.post(f"/api/orders/{order_id}/jobs", json={"title": title})
    assert res.status_code in (200, 201), res.text
    return res.json()


def close(client, order_id):
    res = client.patch(f"/api/orders/{order_id}/status", json={"status": "complete"})
    assert res.status_code == 200, res.text


def finished_car(client, stock_number="R-LEFT1", vin=None):
    """A car whose recon is done: two repairs written up, neither ever ticked
    off, and a part that was fitted but never marked received.

    All three are ordinary. Ticking a repair is a habit not everybody has, and
    the receipt going missing is common enough to have a desk of its own.
    """
    vehicle = make_recon_vehicle(client, stock_number=stock_number, **({"vin": vin} if vin else {}))
    order = make_recon_order(client, vehicle["id"])
    add_job(client, order["id"], "Windshield")
    add_job(client, order["id"], "Front brakes")
    save_estimate(client, order["id"], [TIRES])
    close(client, order["id"])
    return vehicle, order


# ---------------------------------------------------------------------------
# The money
# ---------------------------------------------------------------------------


def test_a_part_nobody_receipted_is_spent_money_not_money_still_to_come(client):
    """The two readings cannot both be true of the same $380."""
    vehicle, _order = finished_car(client, stock_number="R-LEFT1")

    row = board_row(client, "R-LEFT1")
    assert row["unreceived_closed_cost"] == 380.0, "the money is still missing from the car's cost"
    assert row["open_cost"] == 0.0, "a closed ticket has nothing left to spend"

    # A second ticket -- the car came back -- is what takes the car out of the
    # Ready pile, and it is where the old ticket's leftovers used to surface.
    make_recon_order(client, vehicle["id"], concern="Came back with a noise")

    row = board_row(client, "R-LEFT1")
    assert row["lot_bucket"] == "working"
    assert row["remaining_cost"] == 0.0, "money already spent was counted again as money still to spend"
    assert row["unreceived_closed_cost"] == 380.0, "and it must still be reported as missing from the cost"


def test_the_lot_sheet_does_not_say_the_same_dollars_twice(client):
    """What the contradiction actually looked like to Walt, in one sentence."""
    vehicle, _order = finished_car(client, stock_number="R-LEFT2")
    make_recon_order(client, vehicle["id"], concern="Came back with a noise")

    needs = lot_row(client, "R-LEFT2")["needs"]
    assert "never marked received" in needs, "the missing receipt is the one thing this car does need"
    assert "of work left" not in needs, f"the sheet still claims work left to pay for: {needs}"


def test_work_genuinely_still_ahead_is_untouched(client):
    """The guard on the fix: a part outstanding on a ticket that is still open
    is exactly what 'still to spend' is for, and must go on saying so."""
    vehicle = make_recon_vehicle(client, stock_number="R-LEFT3")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [TIRES])

    row = board_row(client, "R-LEFT3")
    assert row["open_cost"] == 380.0
    assert row["remaining_cost"] == 380.0
    assert "$380.00 of work left" in lot_row(client, "R-LEFT3")["needs"]

    # And once a second, closed ticket sits beside it, the open one's money is
    # still the only money outstanding.
    second = make_recon_order(client, vehicle["id"], concern="Second visit")
    save_estimate(client, second["id"], [{**TIRES, "description": "Wipers", "unit_price": 22, "unit_cost": 22}])
    close(client, second["id"])

    row = board_row(client, "R-LEFT3")
    assert row["open_cost"] == 380.0, "the closed ticket's leftovers leaked back into still-to-spend"
    assert row["unreceived_closed_cost"] == 22.0


def test_a_we_owe_promise_follows_the_same_rule(client):
    """We-owe work runs through the same rollup and the same sheet."""
    promise = make_we_owe(client, description="Tie rod the salesman promised")
    order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": promise["id"]}
    ).json()
    save_estimate(client, order["id"], [TIRES])
    close(client, order["id"])

    row = next(r for r in client.get("/api/vehicles-board").json() if r["we_owe_id"] == promise["id"])
    assert row["open_cost"] == 0.0
    assert row["unreceived_closed_cost"] == 380.0


# ---------------------------------------------------------------------------
# The repairs
# ---------------------------------------------------------------------------


def test_a_closed_tickets_repairs_are_not_outstanding_work(client):
    """Same rule the app already applies to a voided ticket's repairs, for the
    same reason: they are not work anybody is still owed."""
    finished_car(client, stock_number="R-LEFT4")

    row = board_row(client, "R-LEFT4")
    assert row["jobs_open"] == [], "a finished car was still naming repairs it needs"
    assert row["jobs_total"] == 0, "and its card still drew a progress bar against them"
    assert row["jobs_done"] == 0


def test_a_car_that_came_back_is_not_asked_for_the_last_visits_repairs(client):
    """The case that put finished work on Walt's sheet as outstanding."""
    vehicle, _order = finished_car(client, stock_number="R-LEFT5")
    second = make_recon_order(client, vehicle["id"], concern="Came back with a noise")

    needs = lot_row(client, "R-LEFT5")["needs"]
    assert "Windshield" not in needs, f"a repair from the closed ticket is still being asked for: {needs}"
    assert "Front brakes" not in needs, needs

    # What the new ticket asks for is its own business, and shows normally.
    add_job(client, second["id"], "Rear wheel bearing")
    row = board_row(client, "R-LEFT5")
    assert row["jobs_open"] == ["Rear wheel bearing"]
    assert row["jobs_total"] == 1
    assert "Rear wheel bearing" in lot_row(client, "R-LEFT5")["needs"]


def test_an_open_tickets_repairs_still_read_exactly_as_before(client):
    """The guard: none of this may change a car actually being worked on."""
    vehicle = make_recon_vehicle(client, stock_number="R-LEFT6")
    order = make_recon_order(client, vehicle["id"])
    brakes = add_job(client, order["id"], "Front brakes")
    add_job(client, order["id"], "Windshield")
    res = client.patch(f"/api/orders/{order['id']}/jobs/{brakes['id']}/done", json={"done": True, "actor": "Antonio"})
    assert res.status_code == 200, res.text

    row = board_row(client, "R-LEFT6")
    assert row["jobs_total"] == 2
    assert row["jobs_done"] == 1
    assert row["jobs_open"] == ["Windshield"]
    assert "Windshield (1 of 2 done)" in lot_row(client, "R-LEFT6")["needs"]


def test_closing_the_ticket_does_not_leave_the_car_told_to_close_it(client):
    """A trap in the obvious version of this fix. Counting a closed ticket's
    repairs as finished rather than dropping them empties jobs_open while
    leaving jobs_total set -- which is the exact shape open_jobs_text reads as
    "all 2 jobs ticked off, close the ticket", said about a ticket that is
    already closed."""
    vehicle, _order = finished_car(client, stock_number="R-LEFT7")
    make_recon_order(client, vehicle["id"], concern="Came back with a noise")

    assert "close the ticket" not in lot_row(client, "R-LEFT7")["needs"]
