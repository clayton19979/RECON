"""The number on the paper ticket has to lead back to the car.

Every repair order has a short shop-wide number -- RO 41 -- and that is the
one anybody says out loud, writes on the printed copy, and reads off a vendor's
invoice. It is also the thing an advisor most often has in hand when they need
the car: somebody rings up quoting an RO, or a printed ticket comes back from
the shop floor.

The board could not answer from it. Search covered stock number, VIN, customer
name and the vehicle description, and the number was not on the board rows at
all -- so the only way from an RO to its car was opening tickets until one
matched.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe


def board(client, **params):
    return client.get("/api/vehicles-board", params=params).json()


def row_for(client, stock_number):
    return next(r for r in board(client) if r["stock_number"] == stock_number)


def test_a_board_row_carries_its_tickets_number(client):
    recon = make_recon_vehicle(client, stock_number="R-RO1")
    order = make_recon_order(client, recon["id"])

    row = row_for(client, "R-RO1")
    assert row["ro_number"] == order["ro_number"], "the board is not carrying the ticket's short number"
    assert row["order_number"] == order["number"], "the board is not carrying the long filed number"
    assert row["ro_number"], "the short number is falsy, so the board would render it as no ticket at all"


def test_a_car_with_no_ticket_has_no_number_to_show(client):
    """Zero rather than a stale one: the row says "no ticket", which is a
    different statement from naming one."""
    make_recon_vehicle(client, stock_number="R-NORO")
    row = row_for(client, "R-NORO")
    assert row["ro_number"] == 0
    assert row["order_number"] == ""


def test_the_number_shown_is_the_live_ticket_not_a_voided_one(client):
    """Board actions already point at the live ticket; the number printed
    beside them has to be the same one, or the row names a ticket its own
    buttons will not open."""
    recon = make_recon_vehicle(client, stock_number="R-ROVOID")
    mistake = make_recon_order(client, recon["id"])
    client.post(f"/api/orders/{mistake['id']}/void", json={"actor": "tester"})
    real = make_recon_order(client, recon["id"], concern="The real one")

    row = row_for(client, "R-ROVOID")
    assert row["ro_number"] == real["ro_number"]
    assert row["ro_number"] != mistake["ro_number"]
    assert row["order_id"] == real["id"], "the row's number and its actions are pointing at different tickets"


def test_a_we_owe_row_carries_its_number_too(client):
    promise = make_we_owe(client, customer_name="Renata Silva", description="Mirror")
    order = client.post(
        "/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": promise["id"]}
    ).json()

    row = next(r for r in board(client) if r.get("we_owe_id") == promise["id"])
    assert row["ro_number"] == order["ro_number"]


def test_numbers_are_shop_wide_so_two_cars_never_share_one(client):
    """The board is searched by this number, so two cars answering to it would
    make the search useless exactly when it matters."""
    a = make_recon_vehicle(client, stock_number="R-RO-A")
    b = make_we_owe(client, customer_name="Marcus Doyle", description="Tie rod")
    order_a = make_recon_order(client, a["id"])
    order_b = client.post("/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": b["id"]}).json()

    assert order_a["ro_number"] != order_b["ro_number"]
    numbers = [r["ro_number"] for r in board(client) if r["ro_number"]]
    assert len(numbers) == len(set(numbers)), f"two live cars share a repair order number: {numbers}"
