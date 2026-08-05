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

import csv
import io

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


# ---------------------------------------------------------------------------
# The reports.
#
# The board and the Lot Status sheet have said this for a while. The two
# reports that report the same money -- Vehicle Spend and Profit -- did not,
# and Profit is the worse of the two: a shortfall in what a car cost comes out
# the other end as profit the lot never made. These pin the figure onto both,
# and onto the spreadsheet versions, which is where a short total does the
# most damage -- summing the cost column is the first thing anyone does with
# the file, and there is no screen beside it to explain itself.
# ---------------------------------------------------------------------------


def spend_row(client, stock_number):
    rows = client.get("/api/reports/vehicle-spend").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def profit_row(client, stock_number):
    rows = client.get("/api/reports/vehicle-profit").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def csv_rows(client, path):
    res = client.get(path)
    assert res.status_code == 200, res.text
    return list(csv.reader(io.StringIO(res.text)))


def test_the_spend_report_carries_the_shortfall_it_is_short_by(client):
    """The spend report is where a month's spending gets read off. Its rows
    come from the same board query, so the figure is already there -- this
    pins it, because a row that quietly drops it reads as a car that cost
    nothing."""
    closed_ticket_with_unreceived_part(client, stock_number="R-9101")
    row = spend_row(client, "R-9101")

    assert row["actual_cost"] == 0
    assert row["unreceived_closed_cost"] == 380
    assert row["unreceived_closed_parts"] == 1


def test_the_profit_report_says_what_the_profit_is_overstated_by(client):
    """The one number on any screen that is not merely incomplete but wrong in
    a flattering direction. $380 of tires that nobody receipted is $380 the
    car did not cost -- and therefore $380 of margin it did not make."""
    vehicle, _, _ = closed_ticket_with_unreceived_part(client, stock_number="R-9102")
    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"status": "sold", "sale_price": 6000, "sale_date": "2026-07-15"},
    )
    assert res.status_code == 200, res.text

    row = profit_row(client, "R-9102")
    # make_recon_vehicle buys the car for $4,000, so the profit on the books
    # is 6000 - 4000 - 0 = 2000 with the tires missing, and 1620 with them.
    assert row["recon_cost"] == 0
    assert row["total_invested"] == 4000
    assert row["profit"] == 2000
    # The correction, carried beside it rather than folded in: what landed is
    # still what landed. See _unit_lifetime.
    assert row["unreceived_closed_cost"] == 380
    assert row["unreceived_closed_parts"] == 1


def test_receiving_the_parts_settles_the_profit_report_too(client):
    vehicle, order, estimate = closed_ticket_with_unreceived_part(client, stock_number="R-9103")
    client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"status": "sold", "sale_price": 6000, "sale_date": "2026-07-15"},
    )
    receive(client, order["id"], [estimate["items"][0]["id"]])

    row = profit_row(client, "R-9103")
    assert row["recon_cost"] == 380, "the money landed where it belongs"
    assert row["profit"] == 1620, "and came straight off the margin"
    assert row["unreceived_closed_cost"] == 0, "nothing left to warn about"


def test_a_we_owe_receipt_gap_counts_against_the_same_car(client):
    """The profit report is keyed on the physical car, not on the record --
    a promise kept months after the sale is the same car's money. An
    unreceipted part on that half has to reach this figure the same way."""
    we_owe = make_we_owe(client)
    order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, order["id"], [part(description="Tie rod end", unit_cost=64)])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    row = next(r for r in client.get("/api/reports/vehicle-profit").json() if r["we_owe_count"])
    assert row["we_owe_cost"] == 0
    assert row["unreceived_closed_cost"] == 64
    assert row["unreceived_closed_parts"] == 1


def test_a_car_with_nothing_missing_reports_a_clean_zero(client):
    """Every row carries the field, so the sheets can total it without
    checking whether it is there. Absent and zero must not be two answers."""
    _, order, estimate = closed_ticket_with_unreceived_part(client, stock_number="R-9104")
    receive(client, order["id"], [estimate["items"][0]["id"]])

    assert spend_row(client, "R-9104")["unreceived_closed_cost"] == 0
    assert profit_row(client, "R-9104")["unreceived_closed_cost"] == 0


def test_the_spend_spreadsheet_has_a_column_for_it(client):
    closed_ticket_with_unreceived_part(client, stock_number="R-9105")
    rows = csv_rows(client, "/api/export/report/vehicle-spend.csv")
    header, body = rows[0], rows[1:]

    assert "Never Marked Received" in header
    cost = header.index("Cost")
    missing = header.index("Never Marked Received")
    assert missing == cost + 1, "beside the column it corrects, not at the far end"

    row = next(r for r in body if r[0] == "R-9105")
    assert row[cost] == "0.00"
    assert row[missing] == "380.00"


def test_the_profit_spreadsheet_has_a_column_for_it(client):
    vehicle, _, _ = closed_ticket_with_unreceived_part(client, stock_number="R-9106")
    client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"status": "sold", "sale_price": 6000, "sale_date": "2026-07-15"},
    )
    rows = csv_rows(client, "/api/export/report/vehicle-profit.csv")
    header, body = rows[0], rows[1:]

    assert "Never Marked Received" in header
    invested = header.index("Total Invested")
    missing = header.index("Never Marked Received")
    assert missing == invested + 1

    row = next(r for r in body if r[0] == "R-9106")
    assert row[header.index("Recon Cost")] == "0.00"
    assert row[header.index("Profit")] == "2000.00"
    assert row[missing] == "380.00", "the sheet the profit is read off says what it is over by"
