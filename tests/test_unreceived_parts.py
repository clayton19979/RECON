"""A closed ticket whose parts were never marked received.

The Cost column counts a part once it has been received. Receiving is a
separate deliberate step, and on recon work it is the step that gets skipped:
the parts are picked up at the counter, thrown on the car, and the ticket is
moved to Complete without anybody going back to receive the lines. The car
then reads as having cost $0.00 forever -- and worse, the board subtracted
that $0.00 from the quote and reported the difference as coming in *under*
estimate, in green.

These tests pin the shortfall down as a number the app carries around
(unreceived_cost, and the closed-ticket half of it) so the screens can say it
out loud instead of quietly reporting a car as free.
"""

from __future__ import annotations

from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


def part(description="Tires (set of 4)", quantity=1, unit_cost=380.0, **overrides):
    line = {
        "kind": "part",
        "description": description,
        "part_number": "T-4",
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }
    line.update(overrides)
    return line


def board_row(client, stock_number):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def lot_row(client, stock_number):
    rows = client.get("/api/reports/lot").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def receive(client, order_id, item_ids, invoice_number="INV-9"):
    vendor = client.post("/api/vendors", json={"name": "NAPA Merrillville"}).json()
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": invoice_number},
    )
    assert res.status_code == 200, res.text
    return res.json()


def closed_ticket_with_unreceived_part(client, stock_number="R-9001", **part_overrides):
    """The exact situation: work finished, parts never receipted."""
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part(**part_overrides)])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    return vehicle, order, estimate


def test_finished_car_reports_the_cost_its_ticket_never_recorded(client):
    closed_ticket_with_unreceived_part(client, stock_number="R-9001")
    row = board_row(client, "R-9001")

    # What the board has always said, and it isn't wrong -- nothing has been
    # receipted, so nothing has landed.
    assert row["actual_cost"] == 0
    assert row["quoted_cost"] == 380
    # What it can now also say: the ticket is closed and $380 of it was never
    # accounted for.
    assert row["unreceived_closed_cost"] == 380
    assert row["unreceived_closed_parts"] == 1


def test_an_open_ticket_is_work_ahead_not_a_bookkeeping_hole(client):
    """The same unreceived line on a ticket still being worked is normal --
    it's the quote, not a gap. Only closed tickets flag."""
    vehicle = make_recon_vehicle(client, stock_number="R-9002")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [part()])

    row = board_row(client, "R-9002")
    assert row["unreceived_cost"] == 380, "still money quoted and not landed"
    assert row["unreceived_closed_cost"] == 0
    assert row["unreceived_closed_parts"] == 0


def test_receiving_the_parts_clears_the_shortfall(client):
    _, order, estimate = closed_ticket_with_unreceived_part(client, stock_number="R-9003")
    receive(client, order["id"], [estimate["items"][0]["id"]])

    row = board_row(client, "R-9003")
    assert row["actual_cost"] == 380, "the money landed where it belongs"
    assert row["unreceived_closed_cost"] == 0
    assert row["unreceived_cost"] == 0


def test_a_line_received_short_still_counts_the_rest(client):
    """One tire receipted, then the line grown to four because the car needed
    a set: three tires' worth of money is still missing even though the line
    reads "received". Counting the line's status rather than its quantity
    would call this settled."""
    vehicle = make_recon_vehicle(client, stock_number="R-9004")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part(quantity=1, unit_cost=95)])
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id], invoice_number="INV-SHORT")

    grown = dict(part(quantity=4, unit_cost=95), id=item_id)
    save_estimate(client, order["id"], [grown])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    row = board_row(client, "R-9004")
    assert row["actual_cost"] == 95  # only the one that actually landed
    assert row["quoted_cost"] == 380
    assert row["unreceived_closed_cost"] == 285  # the other three
    assert row["unreceived_closed_parts"] == 1


def test_a_voided_ticket_owes_nothing(client):
    """Voiding means this never happened. A voided ticket's unreceived parts
    are not a hole in the car's cost -- they were never spent."""
    _, order, _ = closed_ticket_with_unreceived_part(client, stock_number="R-9005")
    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text

    row = board_row(client, "R-9005")
    assert row["unreceived_closed_cost"] == 0
    assert row["unreceived_cost"] == 0


def test_a_returned_part_is_not_money_the_car_owes(client):
    """A line sent back to the vendor costs the car nothing and is not
    something anybody still needs to receive."""
    _, order, estimate = closed_ticket_with_unreceived_part(client, stock_number="R-9006")
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id])
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return",
        json={"returned": True, "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    row = board_row(client, "R-9006")
    assert row["actual_cost"] == 0
    assert row["unreceived_closed_cost"] == 0, "returned, not awaiting receipt"


def test_we_owe_cars_carry_the_same_figure(client):
    """The board is one list of two kinds of work; a number that only exists
    on half the rows is a number the cards can't add up."""
    we_owe = make_we_owe(client)
    order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, order["id"], [part(description="Tie rod end", unit_cost=64)])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    row = next(r for r in client.get("/api/vehicles-board").json() if r["segment"] == "we_owe")
    assert row["actual_cost"] == 0
    assert row["unreceived_closed_cost"] == 64
    assert row["unreceived_closed_parts"] == 1


def test_lot_report_will_not_call_an_unpaid_car_ready_and_leave_it_there(client):
    """Walt reads this sheet to answer "what did we spend on each car". A car
    whose ticket is closed with unreceived parts used to read "Nothing --
    ready to go" beside a cost of $0.00, which is two wrong answers on one
    line."""
    closed_ticket_with_unreceived_part(client, stock_number="R-9007")
    row = lot_row(client, "R-9007")

    assert row["lot_bucket"] == "ready", "the car really is ready; it's the money that's short"
    assert row["needs"] != "Nothing — ready to go"
    assert "never marked received" in row["needs"]
    assert "$380.00" in row["needs"]


def test_lot_report_says_nothing_extra_once_the_parts_are_receipted(client):
    _, order, estimate = closed_ticket_with_unreceived_part(client, stock_number="R-9008")
    receive(client, order["id"], [estimate["items"][0]["id"]])

    row = lot_row(client, "R-9008")
    assert row["needs"] == "Nothing — ready to go"


def test_a_car_still_in_the_shop_mentions_an_earlier_unreceipted_ticket(client):
    """A car can have one ticket closed out with parts nobody receipted and
    still be in the shop on a second one. The note belongs on that row too."""
    vehicle = make_recon_vehicle(client, stock_number="R-9009")
    first = make_recon_order(client, vehicle["id"], concern="Brakes")
    save_estimate(client, first["id"], [part(description="Brake pads", unit_cost=52)])
    client.patch(f"/api/orders/{first['id']}/status", json={"status": "complete"})

    second = make_recon_order(client, vehicle["id"], concern="Windshield")
    client.patch(f"/api/orders/{second['id']}/status", json={"status": "in_progress"})

    row = lot_row(client, "R-9009")
    assert row["lot_bucket"] == "working"
    assert "never marked received" in row["needs"]
    assert "$52.00" in row["needs"]
