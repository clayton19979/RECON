"""One list of the money the app is not counting.

`tests/test_unreceived_parts.py` pins down the number itself: a part on a
finished ticket that nobody marked received is money already spent that never
landed in the car's cost. The board and the lot sheet say so per car, one
sentence at a time, on the row it belongs to.

That is the right place to be told and the wrong place to act. Clearing them
meant spotting the sentence on each row in turn, on the one screen it appears
on, which during a busy morning means it does not happen -- and every one left
makes the answer to "what did we spend on this car" a little further from the
truth. These tests cover the desk that puts them in one list, and the scope
rules that keep its total from ever disagreeing with the warning on the car's
own row.
"""

from __future__ import annotations

from tests.helpers import (
    backdate_activity,
    days_ago,
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    make_we_owe,
    save_estimate,
)


def part(description="Tires (set of 4)", part_number="T-4", unit_cost=380.0, quantity=1, **overrides):
    line = {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }
    line.update(overrides)
    return line


def missing(client):
    res = client.get("/api/parts/missing-receipts")
    assert res.status_code == 200, res.text
    return res.json()


def receive(client, order_id, item_ids, invoice_number="INV-9"):
    vendor = client.post("/api/vendors", json={"name": "NAPA Merrillville"}).json()
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": invoice_number},
    )
    assert res.status_code == 200, res.text
    return res.json()


def closed_recon_ticket(client, stock_number="R-9001", items=None):
    """Work finished, parts never receipted -- the situation this desk exists
    for, and the one the shop actually creates: parts picked up at the counter,
    fitted, ticket moved to Complete, nobody goes back to receive the lines."""
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], items or [part()])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    return vehicle, order, estimate


def board_row(client, stock_number):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


# ---------------------------------------------------------------------------
# What lands on the desk
# ---------------------------------------------------------------------------


def test_a_finished_ticket_with_an_unreceipted_part_is_listed(client):
    closed_recon_ticket(client, stock_number="R-9001")

    rows = missing(client)
    assert len(rows) == 1
    row = rows[0]
    assert row["description"] == "Tires (set of 4)"
    assert row["part_number"] == "T-4"
    assert row["value"] == 380
    assert row["missing_quantity"] == 1
    assert row["vehicle_label"] == "R-9001"
    assert row["vehicle"] == "2019 Honda Civic"
    assert row["segment"] == "recon"


def test_the_desk_total_is_the_same_number_the_car_warns_about(client):
    """The whole point of one rule in one place. If this desk and the board's
    sentence could ever disagree, the desk would be a third opinion rather than
    a way to clear the second one."""
    closed_recon_ticket(client, stock_number="R-9002", items=[part(unit_cost=95, quantity=4)])

    row = board_row(client, "R-9002")
    listed = [p for p in missing(client) if p["vehicle_label"] == "R-9002"]
    assert sum(p["value"] for p in listed) == row["unreceived_closed_cost"] == 380
    assert len(listed) == row["unreceived_closed_parts"] == 1


def test_an_open_ticket_is_work_ahead_and_stays_off_the_desk(client):
    """The same unreceived line on a ticket still being worked is normal --
    that part simply has not turned up yet, which is the On Order desk's
    question, not this one's."""
    vehicle = make_recon_vehicle(client, stock_number="R-9003")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [part()])

    assert missing(client) == []


def test_receiving_the_part_clears_it_off_the_desk(client):
    _, order, estimate = closed_recon_ticket(client, stock_number="R-9004")
    assert len(missing(client)) == 1

    receive(client, order["id"], [estimate["items"][0]["id"]])

    assert missing(client) == []
    assert board_row(client, "R-9004")["actual_cost"] == 380


def test_a_line_received_short_still_shows_the_rest(client):
    """One tire receipted, then the line grown to a set of four. The line reads
    "received" and three tires' worth of money is still missing -- counting the
    status rather than the quantity would call this settled."""
    vehicle = make_recon_vehicle(client, stock_number="R-9005")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part(quantity=1, unit_cost=95)])
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id], invoice_number="INV-SHORT")

    save_estimate(client, order["id"], [dict(part(quantity=4, unit_cost=95), id=item_id)])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    rows = missing(client)
    assert len(rows) == 1
    assert rows[0]["missing_quantity"] == 3
    assert rows[0]["value"] == 285


def test_a_voided_ticket_owes_nothing(client):
    """Voiding means the work never happened, so there is no money to chase."""
    _, order, _ = closed_recon_ticket(client, stock_number="R-9006")
    assert client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"}).status_code == 200

    assert missing(client) == []


def test_a_returned_part_is_not_awaiting_a_receipt(client):
    """A line sent back to the vendor costs the car nothing and is the Returned
    Parts desk's business, not this one's."""
    _, order, estimate = closed_recon_ticket(client, stock_number="R-9007")
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id])
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return",
        json={"returned": True, "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    assert missing(client) == []


def test_labor_lines_are_never_missing_receipts(client):
    """Labor is not charged out on recon work and there is nothing to receive
    against it -- a zero-cost labor line listed here would be noise on the one
    desk that has to stay all-signal."""
    vehicle = make_recon_vehicle(client, stock_number="R-9008")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Fit tires", "quantity": 2, "unit_price": 0, "unit_cost": 0}],
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    assert missing(client) == []


def test_a_car_archived_to_history_drops_off_the_desk(client):
    """Same scope as the On Order desk and the board: History is closed books.
    A desk that keeps listing cars nobody can act on stops being a to-do list."""
    vehicle, _, _ = closed_recon_ticket(client, stock_number="R-9009")
    assert len(missing(client)) == 1

    res = client.post(f"/api/recon/vehicles/{vehicle['id']}/archive", json={})
    assert res.status_code == 200, res.text

    assert missing(client) == []


# ---------------------------------------------------------------------------
# All three kinds of work, and the order they're read in
# ---------------------------------------------------------------------------


def test_we_owe_and_retail_tickets_are_listed_too(client):
    """This is a parts desk, not a lot report. Money spent on a we-owe promise
    or on a retail customer's car is just as uncounted, and the person clearing
    these works the whole parts bench -- the screen's Lot Cars Only chip is
    what narrows it to the cars the Lot Status sheet totals."""
    we_owe = make_we_owe(client)
    we_owe_order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, we_owe_order["id"], [part(description="Tie rod end", unit_cost=64)])
    client.patch(f"/api/orders/{we_owe_order['id']}/status", json={"status": "complete"})

    retail_order = make_retail_order(client)
    save_estimate(client, retail_order["id"], [part(description="Oil filter", unit_cost=6)])
    client.patch(f"/api/orders/{retail_order['id']}/status", json={"status": "complete"})

    segments = {row["segment"] for row in missing(client)}
    assert segments == {"we_owe", "retail"}


def test_the_biggest_hole_is_listed_first(client):
    """This desk exists to make a cost figure true again, and the line that
    moves it most is the one worth walking to the filing cabinet for."""
    closed_recon_ticket(client, stock_number="R-9010", items=[part(description="Wiper blades", unit_cost=22)])
    closed_recon_ticket(client, stock_number="R-9011", items=[part(description="Radiator", unit_cost=310)])
    closed_recon_ticket(client, stock_number="R-9012", items=[part(description="Battery", unit_cost=140)])

    assert [row["value"] for row in missing(client)] == [310, 140, 22]


def test_the_ticket_idle_count_is_the_boards_own_measure(client, db_path):
    """A ticket closed last week is probably paperwork in somebody's pocket;
    one closed two months ago is money that is never getting written down. The
    count is read off the same column the board's Idle number uses, so the two
    screens cannot say different things about the same ticket."""
    _, order, _ = closed_recon_ticket(client, stock_number="R-9013")
    backdate_activity(db_path, order["id"], days_ago(40))

    row = missing(client)[0]
    assert row["days_idle"] == 40
    assert board_row(client, "R-9013")["idle_days"] == 40
