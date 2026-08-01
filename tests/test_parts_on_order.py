"""What the shop is waiting on, and for how long.

Two things are checked here, and they're two halves of one complaint: a car
sits because a part hasn't come, and nobody could see either which part it was
or how long it had been coming.

The second half is the bug. Marking parts ordered never reached touch_order,
so the single most common thing anyone does to a waiting car didn't count as
work on it -- the Lot Report would print "1 part on order" and "untouched 20
days" on the same line about a part ordered a minute earlier.
"""

from __future__ import annotations

from app.db import connect
from tests.helpers import (
    backdate_activity,
    days_ago,
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    make_we_owe,
    save_estimate,
)


def part(description="Wheel bearing", part_number="WB-1", unit_cost=70.0, quantity=1):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }


def order_with_parts(client, stock_number="R-1001", items=None):
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], items or [part()])
    return vehicle, order


def set_ordered_at(db_path, order_id: int, when: str) -> None:
    """Age a part line the same way backdate_activity ages a ticket -- every
    write moves the clock forward, so "ordered three weeks ago" can only be
    arranged in the database the app is already using."""
    with connect(db_path) as db:
        db.execute(
            """UPDATE estimate_items SET ordered_at=?
                WHERE estimate_id=(SELECT id FROM estimates WHERE order_id=?)""",
            (when, order_id),
        )
        db.commit()


# ---------------------------------------------------------------------------
# Ordering parts is work on the car
# ---------------------------------------------------------------------------


def test_ordering_parts_stops_the_car_looking_untouched(client, db_path):
    """The bug, end to end on the screen it broke.

    A car nobody has touched for three weeks, whose parts are ordered right
    now, must stop reading as untouched -- on the board's Idle column, in the
    Stalled count, and in the sentence the Lot Report prints about it.
    """
    vehicle, order = order_with_parts(client)
    backdate_activity(db_path, order["id"], days_ago(20))

    before = next(r for r in client.get("/api/reports/lot").json() if r["recon_id"] == vehicle["id"])
    assert before["idle_days"] >= 20
    assert "untouched" in before["needs"]

    assert client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["updated"] == 1

    after = next(r for r in client.get("/api/reports/lot").json() if r["recon_id"] == vehicle["id"])
    assert after["idle_days"] == 0, "ordering parts still doesn't count as work on the car"
    assert "untouched" not in after["needs"], (
        "the Lot Report still calls a car untouched on the same line it says its parts are on order"
    )
    assert "1 part on order" in after["needs"]


def test_ordering_nothing_does_not_touch_the_car(client, db_path):
    """A second click, with nothing left in quoted, orders nothing -- and must
    not quietly reset the idle clock on a car nobody has been near."""
    vehicle, order = order_with_parts(client)
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    backdate_activity(db_path, order["id"], days_ago(9))

    assert client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["updated"] == 0

    row = next(r for r in client.get("/api/vehicles-board").json() if r["recon_id"] == vehicle["id"])
    assert row["idle_days"] >= 9, "a no-op click reset the idle clock"


def test_ordering_parts_is_logged_against_the_ticket(client):
    _, order = order_with_parts(client)
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts", json={"actor": "clayton"})

    activity = client.get(f"/api/orders/{order['id']}").json()["activity"]
    logged = [a for a in activity if a["action"] == "parts_ordered"]
    assert logged, "ordering parts leaves no trace in the ticket's history"
    assert logged[-1]["actor"] == "clayton"
    assert logged[-1]["details"]["count"] == 1


def test_single_line_status_change_counts_and_is_reversible(client, db_path):
    _, order = order_with_parts(client)
    item = next(i for i in client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"])
    backdate_activity(db_path, order["id"], days_ago(12))

    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item['id']}/status",
        json={"status": "ordered", "actor": "antonio"},
    )
    on_order = client.get("/api/parts/on-order").json()
    assert [p["id"] for p in on_order] == [item["id"]]
    assert on_order[0]["days_waiting"] == 0

    # Putting it back to quoted takes it off the list and clears the date with
    # it -- nothing is waiting on a part that was never really ordered.
    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item['id']}/status",
        json={"status": "quoted", "actor": "antonio"},
    )
    assert client.get("/api/parts/on-order").json() == []
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["estimate"]["items"][0]["ordered_at"] == ""
    assert [a["action"] for a in detail["activity"]].count("parts_order_undone") == 1


def test_setting_the_same_status_again_is_not_activity(client, db_path):
    _, order = order_with_parts(client)
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/status", json={"status": "ordered"})
    backdate_activity(db_path, order["id"], days_ago(5))

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/status", json={"status": "ordered"})

    board = client.get("/api/vehicles-board").json()[0]
    assert board["idle_days"] >= 5, "re-saying what a line already said reset the idle clock"


def test_receiving_keeps_the_order_date(client):
    """How long a part took to turn up stays answerable after it lands --
    received clears the wait, not the record of it."""
    _, order = order_with_parts(client)
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    vendor = client.post("/api/vendors", json={"name": "Advance"}).json()

    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    received = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert received["status"] == "received"
    assert received["ordered_at"], "the order date was wiped when the part arrived"
    assert client.get("/api/parts/on-order").json() == [], "a received part is still listed as on order"


# ---------------------------------------------------------------------------
# The list itself
# ---------------------------------------------------------------------------


def test_on_order_lists_every_waiting_part_longest_first(client, db_path):
    _, old_order = order_with_parts(client, "R-OLD", [part("Windshield", "WS-1", 180.0)])
    _, new_order = order_with_parts(client, "R-NEW", [part("Serpentine belt", "SB-1", 14.0)])
    client.patch(f"/api/orders/{old_order['id']}/estimate/order-parts")
    client.patch(f"/api/orders/{new_order['id']}/estimate/order-parts")
    set_ordered_at(db_path, old_order["id"], days_ago(21))

    rows = client.get("/api/parts/on-order").json()
    assert [r["part_number"] for r in rows] == ["WS-1", "SB-1"], "the longest wait isn't at the top"
    assert rows[0]["days_waiting"] == 21
    assert rows[0]["value"] == 180.0
    assert rows[0]["vehicle_label"] == "R-OLD"
    assert rows[0]["vehicle"] == "2019 Honda Civic"
    assert rows[0]["ro_number"] == old_order["number"]


def test_a_line_ordered_before_the_date_existed_says_so(client, db_path):
    """Lines already on order when ordered_at shipped were never stamped.
    days_waiting has to come back None rather than 0 -- "we don't know" and
    "ordered today" are opposite answers, and a zero would put a part from
    last month at the bottom of the list wearing today's date."""
    _, order = order_with_parts(client)
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    set_ordered_at(db_path, order["id"], "")

    row = client.get("/api/parts/on-order").json()[0]
    assert row["ordered_at"] == ""
    assert row["days_waiting"] is None


def test_undated_lines_sort_below_dated_ones(client, db_path):
    _, dated = order_with_parts(client, "R-DATED", [part("Windshield", "WS-1", 180.0)])
    _, undated = order_with_parts(client, "R-UNDATED", [part("Belt", "SB-1", 14.0)])
    client.patch(f"/api/orders/{dated['id']}/estimate/order-parts")
    client.patch(f"/api/orders/{undated['id']}/estimate/order-parts")
    set_ordered_at(db_path, undated["id"], "")

    rows = client.get("/api/parts/on-order").json()
    assert [r["part_number"] for r in rows] == ["WS-1", "SB-1"], (
        "a line with no recorded date is leading a list sorted by how long things have waited"
    )


def test_on_order_covers_we_owe_and_retail_too(client):
    """Every ticket the shop is waiting on a part for, not just recon --
    "what am I chasing today" doesn't care which side of the shop it's on."""
    we_owe = make_we_owe(client)
    we_owe_order = client.post(
        "/api/orders", json={"concern": "Running boards", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, we_owe_order["id"], [part("Bracket kit", "RB-1", 95.0)])
    retail_order = make_retail_order(client)
    save_estimate(client, retail_order["id"], [part("AC compressor", "AC-1", 265.0)])
    for order_id in (we_owe_order["id"], retail_order["id"]):
        client.patch(f"/api/orders/{order_id}/estimate/order-parts")

    labels = {r["part_number"]: r["vehicle_label"] for r in client.get("/api/parts/on-order").json()}
    assert labels == {"RB-1": "We-Owe: Jordan Whitfield", "AC-1": "Retail: Retail Customer"}


def test_on_order_agrees_with_the_boards_waiting_on_parts_count(client):
    """The card and the list are the same question asked twice. A voided
    ticket, and a car archived to History, are out of both."""
    _, live = order_with_parts(client, "R-LIVE")
    voided_vehicle, voided_order = order_with_parts(client, "R-VOID")
    archived_vehicle, archived_order = order_with_parts(client, "R-ARCH")
    for order in (live, voided_order, archived_order):
        client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert client.post(f"/api/orders/{voided_order['id']}/void", json={}).status_code == 200
    assert client.post(f"/api/recon/vehicles/{archived_vehicle['id']}/archive").status_code == 200

    rows = client.get("/api/parts/on-order").json()
    board_pending = sum(r["parts_pending"] for r in client.get("/api/vehicles-board").json())
    assert len(rows) == board_pending, "the On Order list and the board's Waiting on Parts card disagree"
    assert {r["vehicle_label"] for r in rows} == {"R-LIVE"}
    assert voided_vehicle["id"] and archived_vehicle["id"]  # both were really created


def test_a_returned_part_is_no_longer_something_we_are_waiting_for(client):
    _, order = order_with_parts(client)
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    vendor = client.post("/api/vendors", json={"name": "Advance"}).json()
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/part-return", json={"returned": True})

    assert client.get("/api/parts/on-order").json() == []


def test_only_the_outstanding_quantity_is_reported(client, db_path):
    """A part line half delivered is only outstanding for the rest of it, and
    it's the rest of it somebody is still chasing."""
    _, order = order_with_parts(client, items=[part("Rotors", "RT-1", 60.0, quantity=4)])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]

    assert client.get("/api/parts/on-order").json()[0]["value"] == 240.0

    # Receiving through the API always takes the whole remaining quantity, so a
    # part-delivered line can only be arranged in the database directly.
    with connect(db_path) as db:
        db.execute("UPDATE estimate_items SET received_quantity=3 WHERE id=?", (item["id"],))
        db.commit()

    row = client.get("/api/parts/on-order").json()[0]
    assert row["id"] == item["id"]
    assert row["outstanding_quantity"] == 1
    assert row["value"] == 60.0
