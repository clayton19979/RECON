"""A part on a ticket that has been closed is not a part anyone is waiting on.

The bug, in one sentence: closing a ticket with a part line still sitting on
'ordered' left that line counted as *both* things it could possibly be, at
once. The car went into "Ready to go" and its row said "1 part never marked
received"; the Waiting on Parts card at the top of the same screen kept
counting it; and the On Order desk in Parts & Cores kept listing it, ageing,
under a heading that asks somebody to ring the vendor.

Both readings cannot be true. Closing a ticket is the shop saying the work is
done, and everywhere else in the app that already means the unreceived line is
money spent that nobody wrote down -- which is what the Missing Receipts desk
one section below is for. So the "waiting on the vendor" reading is the one
that has to go, and it has to go from the card and the desk together or they
just disagree in a new way.

The desk it leaves behind is also one that can be finished. Before this, every
ticket ever closed over an outstanding part left a row on the On Order list
that no action could clear -- receiving it is what clears it, and receiving is
exactly the step that was skipped.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def part(description="Tie rod end", part_number="TR-12", unit_cost=25.0, quantity=2):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }


def board_row(client, recon_id):
    board = client.get("/api/vehicles-board").json()
    return next(r for r in board if r["recon_id"] == recon_id)


def car_with_an_ordered_part(client, stock_number="R-8100", items=None):
    """A recon car whose parts are on order and haven't turned up."""
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], items or [part()])
    assert client.patch(f"/api/orders/{order['id']}/estimate/order-parts").status_code == 200
    return vehicle, order


def close(client, order_id):
    res = client.patch(f"/api/orders/{order_id}/status", json={"status": "complete"})
    assert res.status_code == 200, res.text


# ---------------------------------------------------------------------------
# The board card
# ---------------------------------------------------------------------------


def test_closing_the_ticket_stops_the_car_claiming_parts_on_order(client):
    """The whole bug on one car, on the screen it is worst on."""
    vehicle, order = car_with_an_ordered_part(client)

    row = board_row(client, vehicle["id"])
    assert row["parts_pending"] == 1, "an ordered part on an open ticket is genuinely awaited"
    assert row["parts_pending_value"] == 50

    close(client, order["id"])

    row = board_row(client, vehicle["id"])
    assert row["lot_bucket"] == "ready", "closing the only ticket finishes the car"
    assert row["parts_pending"] == 0, "a finished car is still being counted on Waiting on Parts"
    assert row["parts_pending_value"] == 0, "a finished car is still adding to the on-order money"
    # The other reading of the same line, which is the one that survives.
    assert row["unreceived_closed_cost"] == 50
    assert row["unreceived_closed_parts"] == 1
    assert "never marked received" in row["needs"]
    assert "on order" not in row["needs"], "one part, two contradictory sentences on one row"


def test_a_car_with_two_tickets_only_counts_the_open_ones_parts(client):
    """The normal shape of a busy car: one repair finished, another written.

    Only the live ticket's parts are on their way. The closed ticket's are
    already the other problem, and mixing them means the card can never come
    down even while somebody is clearing it.
    """
    vehicle, first = car_with_an_ordered_part(client, stock_number="R-8110")
    close(client, first["id"])

    second = make_recon_order(client, vehicle["id"])
    save_estimate(client, second["id"], [part("Wheel bearing", "WB-9", 70.0, 1)])
    assert client.patch(f"/api/orders/{second['id']}/estimate/order-parts").status_code == 200

    row = board_row(client, vehicle["id"])
    assert row["parts_pending"] == 1
    assert row["parts_pending_value"] == 70
    assert row["unreceived_closed_cost"] == 50, "the closed ticket's line is still money spent"


def test_the_second_ticket_does_not_make_the_car_look_untouched(client):
    """The regression the fix has to not cause.

    A car with a closed repair behind it and a fresh ticket on it has had real
    money spent on it, even when none of that money landed as cost because
    nobody receipted the parts. It used to be held out of "Not started" by
    parts_pending, which no longer counts those lines -- so the closed
    ticket's unreceipted money has to hold it out instead.
    """
    vehicle, first = car_with_an_ordered_part(client, stock_number="R-8120")
    close(client, first["id"])
    make_recon_order(client, vehicle["id"])  # written up, nothing on it yet

    row = board_row(client, vehicle["id"])
    assert row["actual_cost"] == 0, "nothing was receipted, so nothing landed as cost"
    assert row["parts_pending"] == 0
    assert row["lot_bucket"] == "working", "a car with a finished repair on it is not 'Not started'"


def test_receiving_the_part_late_still_puts_the_money_on_the_car(client):
    """Clearing the real problem still works, and clears it everywhere."""
    vehicle, order = car_with_an_ordered_part(client, stock_number="R-8130")
    close(client, order["id"])
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-501"},
    )
    assert res.status_code == 200, res.text

    row = board_row(client, vehicle["id"])
    assert row["actual_cost"] == 50, "the money finally landed on the car"
    assert row["parts_pending"] == 0
    assert row["unreceived_closed_cost"] == 0
    assert client.get("/api/parts/missing-receipts").json() == []
    assert client.get("/api/parts/on-order").json() == []


# ---------------------------------------------------------------------------
# The Parts & Cores desks
# ---------------------------------------------------------------------------


def test_the_on_order_desk_drops_a_closed_tickets_part(client):
    vehicle, order = car_with_an_ordered_part(client, stock_number="R-8140")
    assert [r["part_number"] for r in client.get("/api/parts/on-order").json()] == ["TR-12"]

    close(client, order["id"])

    assert client.get("/api/parts/on-order").json() == [], (
        "a finished ticket's part is still on the desk that asks somebody to chase the vendor"
    )
    missing = client.get("/api/parts/missing-receipts").json()
    assert [(r["part_number"], r["value"]) for r in missing] == [("TR-12", 50.0)], (
        "and it has to be on the desk that can actually clear it"
    )
    assert vehicle["id"]


def test_no_part_is_on_both_desks_at_once(client):
    """The two desks sit one above the other on Parts & Cores and give
    opposite instructions. No line may appear on both."""
    _, open_order = car_with_an_ordered_part(client, stock_number="R-8150")
    _, closed_order = car_with_an_ordered_part(
        client, stock_number="R-8160", items=[part("Windshield", "WS-4", 180.0, 1)]
    )
    close(client, closed_order["id"])

    on_order = {r["id"] for r in client.get("/api/parts/on-order").json()}
    missing = {r["id"] for r in client.get("/api/parts/missing-receipts").json()}
    assert on_order and missing, "both desks should have something on them"
    assert not (on_order & missing), "the same part line is on both desks"
    assert open_order["id"] and closed_order["id"]


def test_the_desk_and_the_card_still_agree_after_a_ticket_closes(client):
    """The parity the On Order desk is written to keep: one row on the list
    for every part the board says a car is waiting on."""
    _, live = car_with_an_ordered_part(client, stock_number="R-8170")
    _, done = car_with_an_ordered_part(client, stock_number="R-8180")
    close(client, done["id"])

    rows = client.get("/api/parts/on-order").json()
    board_pending = sum(r["parts_pending"] for r in client.get("/api/vehicles-board").json())
    assert len(rows) == board_pending == 1
    assert {r["vehicle_label"] for r in rows} == {"R-8170"}
    assert live["id"]


def test_a_we_owe_promise_behaves_the_same_way(client):
    """Half the board is we-owe work, and the rule cannot be recon-only."""
    item = make_we_owe(client, customer_name="Renata Silva", description="Tie rod")
    order = client.post("/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    save_estimate(client, order["id"], [part("Tie rod end", "TR-77", 45.0, 1)])
    assert client.patch(f"/api/orders/{order['id']}/estimate/order-parts").status_code == 200

    def row():
        board = client.get("/api/vehicles-board").json()
        return next(r for r in board if r.get("we_owe_id") == item["id"])

    assert row()["parts_pending"] == 1
    close(client, order["id"])
    assert row()["parts_pending"] == 0
    assert row()["unreceived_closed_cost"] == 45
    assert client.get("/api/parts/on-order").json() == []
