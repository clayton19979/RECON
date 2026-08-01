"""The Lot Report: the lot as it stands right now.

This is the report Walt actually asks for. He wants four things about his
cars -- which are ready, which are being worked on, what each remaining one
still needs, and what the shop has spent on each. The spend report answers
only the last of those, and answers it inside a date window keyed on when a
car was *acquired*: a car bought in July and still sitting unfinished in
September drops out of the default "This Month" view, which is precisely the
car worth asking about. This report has no date range at all.
"""

from __future__ import annotations

from app.recon import is_stalled
from app.reports import LOT_GROUP_LABEL
from tests.helpers import (
    backdate_activity,
    days_ago,
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)

PART = {
    "kind": "part",
    "description": "Alternator",
    "part_number": "ALT-1",
    "quantity": 1,
    "unit_price": 300,
    "unit_cost": 300,
}


def lot(client) -> list[dict]:
    res = client.get("/api/reports/lot")
    assert res.status_code == 200, res.text
    return res.json()


def row_for(rows: list[dict], stock: str) -> dict:
    match = [r for r in rows if r["stock_number"] == stock]
    assert len(match) == 1, f"expected exactly one row for {stock}, got {len(match)}"
    return match[0]


def test_the_report_takes_no_date_range_at_all(client):
    """The whole point. If this ever grows start/end parameters, a car will go
    missing from Walt's sheet for being old rather than for being finished."""
    make_recon_vehicle(client, stock_number="R-LOT1", purchase_price=0)
    # Ranges that would exclude everything on any date-filtered report.
    for query in ("?start=1999-01-01&end=1999-12-31", "?start=2099-01-01&end=2099-12-31"):
        rows = client.get(f"/api/reports/lot{query}").json()
        assert any(r["stock_number"] == "R-LOT1" for r in rows), (
            f"the lot report honoured {query} -- it must ignore dates and always show the live lot"
        )


def test_cars_are_sorted_into_walts_three_piles(client):
    ready = make_recon_vehicle(client, stock_number="R-READY", vin="1HGCM82633A000001", purchase_price=0)
    working = make_recon_vehicle(client, stock_number="R-WORKING", vin="1HGCM82633A000002", purchase_price=0)
    make_recon_vehicle(client, stock_number="R-NOTHING", vin="1HGCM82633A000003", purchase_price=0)

    done = make_recon_order(client, ready["id"])
    client.patch(f"/api/orders/{done['id']}/status", json={"status": "complete", "actor": "tester"})
    started = make_recon_order(client, working["id"])
    client.patch(f"/api/orders/{started['id']}/status", json={"status": "in_progress", "actor": "tester"})

    rows = lot(client)
    assert row_for(rows, "R-READY")["lot_bucket"] == "ready"
    assert row_for(rows, "R-WORKING")["lot_bucket"] == "working"
    assert row_for(rows, "R-NOTHING")["lot_bucket"] == "waiting", "a car with no ticket has not been started"


def test_ready_cars_come_first_and_the_longest_idle_lead_their_group(client):
    """Walt reads the top of the page. Ready first because that is his first
    question; within a group the quietest car first, because the car nobody
    has touched is the one he needs to be asked about."""
    for n in range(1, 4):
        make_recon_vehicle(client, stock_number=f"R-ORDER{n}", vin=f"1HGCM82633A0001{n:02d}", purchase_price=0)
    finished = make_recon_vehicle(client, stock_number="R-DONE", vin="1HGCM82633A000200", purchase_price=0)
    order = make_recon_order(client, finished["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    rows = lot(client)
    buckets = [r["lot_bucket"] for r in rows]
    assert buckets == sorted(buckets, key=lambda b: {"ready": 0, "working": 1, "waiting": 2}[b])
    for group in ("ready", "working", "waiting"):
        idle = [r["idle_days"] for r in rows if r["lot_bucket"] == group]
        assert idle == sorted(idle, reverse=True), f"{group} is not longest-idle first"


def test_money_already_spent_means_the_car_has_been_started(client):
    """A ticket sits on "Estimate" until someone thinks to move it, so status
    alone put cars with hundreds of dollars of parts in them under a heading
    reading "Not started" -- with the group's own subtotal contradicting its
    title on the same line. What actually happened to the car wins."""
    recon = make_recon_vehicle(client, stock_number="R-SPENT", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    row = row_for(lot(client), "R-SPENT")
    assert row["status"] == "estimate", "precondition: the ticket still says Estimate"
    assert row["lot_bucket"] == "working", "a car with parts on order is not 'not started'"
    assert "not started" not in row["needs"].lower(), row["needs"]


def test_a_finished_car_says_it_needs_nothing(client):
    recon = make_recon_vehicle(client, stock_number="R-FIN", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    needs = row_for(lot(client), "R-FIN")["needs"]
    assert "ready to go" in needs.lower(), needs


def test_needs_calls_out_parts_on_order_and_money_still_to_spend(client):
    recon = make_recon_vehicle(client, stock_number="R-PARTS", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    row = row_for(lot(client), "R-PARTS")
    assert row["parts_pending"] == 1
    assert "1 part on order" in row["needs"], row["needs"]
    # Quoted but not yet received, so it is money the car still needs spent.
    assert row["remaining_cost"] == 300
    assert "$300.00 of work left" in row["needs"], row["needs"]


def test_needs_says_so_when_no_ticket_has_been_written(client):
    make_recon_vehicle(client, stock_number="R-BARE", purchase_price=0)
    assert "no ticket written yet" in row_for(lot(client), "R-BARE")["needs"].lower()


def test_money_already_spent_is_not_counted_as_still_to_spend(client):
    """remaining_cost is what finishing the car should still cost. Going over
    the estimate is real, but it is money already in the Spent column -- it
    must never come back as a negative here or as work outstanding."""
    recon = make_recon_vehicle(client, stock_number="R-OVER", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    row = row_for(lot(client), "R-OVER")
    assert row["remaining_cost"] >= 0
    assert row["remaining_cost"] == max(row["quoted_cost"] - row["actual_cost"], 0)


def test_a_finished_car_has_nothing_still_to_spend(client):
    """A car that came in under its estimate was reporting the shortfall as
    work still outstanding -- on the same row whose Needs cell read "Nothing --
    ready to go", and into the lot's "still to do" total underneath.

    Nothing is open on a finished car, so nobody is going to spend that money.
    The under-quote fact is real and still lives on the board, in the Cost
    against Quote column; it is not a job waiting to be done.
    """
    recon = make_recon_vehicle(client, stock_number="R-UNDER", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    row = row_for(lot(client), "R-UNDER")
    assert row["lot_bucket"] == "ready", "precondition: the ticket is closed"
    assert row["quoted_cost"] == 300, "precondition: the car was quoted work it never had done"
    assert row["actual_cost"] == 0, "precondition: nothing was actually received"
    assert row["remaining_cost"] == 0, "a finished car is still reporting quoted-but-unspent money as work outstanding"
    assert "ready to go" in row["needs"].lower(), row["needs"]


def test_a_finished_car_is_never_called_untouched(client, db_path):
    """Nothing moves on a closed car, so its idle count climbs forever. Saying
    "untouched 40 days" about one reads as a reproach for work that is done,
    and it is the same rule the board's Stalled card follows -- one screen must
    not call a car neglected while the other calls it ready."""
    recon = make_recon_vehicle(client, stock_number="R-OLD", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    backdate_activity(db_path, order["id"], days_ago(40))
    row = row_for(lot(client), "R-OLD")
    assert row["idle_days"] >= 40, "precondition: the car really has been sitting"
    assert row["status_bucket"] == "finished"
    assert "untouched" not in row["needs"].lower(), row["needs"]
    assert not is_stalled(row), "a finished car is being counted as stalled"


def test_an_unfinished_car_left_alone_is_still_called_out(client, db_path):
    """The other side of the same rule: the flag has to keep working, or all
    that has happened is that the alarm was switched off."""
    recon = make_recon_vehicle(client, stock_number="R-QUIET", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "tester"})

    backdate_activity(db_path, order["id"], days_ago(40))
    row = row_for(lot(client), "R-QUIET")
    assert row["status_bucket"] == "in_progress"
    assert "untouched 40 days" in row["needs"].lower(), row["needs"]
    assert is_stalled(row)


def test_we_owe_promises_are_on_the_sheet_too(client):
    """A we-owe is work the shop owes on a car Walt already sold; it belongs
    on the same sheet, labelled, not hidden on another screen."""
    make_we_owe(client, customer_name="Dana Lot", description="Replace tie rod")
    rows = lot(client)
    we_owes = [r for r in rows if r["segment"] == "we_owe"]
    assert we_owes, "we-owe promises are missing from the lot report"
    assert all(r["lot_bucket"] in ("ready", "working", "waiting") for r in we_owes)


def test_archived_cars_are_off_the_lot(client):
    """Archiving is how a car leaves the lot. It must not keep showing up on
    a sheet titled 'what is on the lot right now'."""
    recon = make_recon_vehicle(client, stock_number="R-GONE", purchase_price=0)
    detail = client.get(f"/api/recon/vehicles/{recon['id']}").json()
    client.post(f"/api/recon/vehicles/{recon['id']}/archive", json={"expected_version": detail["edit_version"]})

    assert not [r for r in lot(client) if r["stock_number"] == "R-GONE"]


def test_csv_carries_the_same_groups_and_needs_as_the_screen(client):
    """Walt gets paper and files. The wording is built once on the server so
    the sheet and the spreadsheet cannot describe the same car differently."""
    recon = make_recon_vehicle(client, stock_number="R-CSV", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    res = client.get("/api/export/report/lot.csv")
    assert res.status_code == 200
    body = res.text
    assert "Group,Stock #,Vehicle" in body, body.splitlines()[0]
    row = row_for(lot(client), "R-CSV")
    assert LOT_GROUP_LABEL[row["lot_bucket"]] in body, "the CSV is missing the row's group label"
    assert row["needs"] in body, "the CSV's Needs column disagrees with the report's"


def board(client) -> list[dict]:
    res = client.get("/api/vehicles-board")
    assert res.status_code == 200, res.text
    return res.json()


def test_the_vehicles_board_is_grouped_by_the_same_three_piles(client):
    """The Vehicles screen can be read as three columns, and those columns are
    this report's groups.

    Which means the grouping has to come off the same computation, not off a
    second one written in the browser. A car under "In the shop" on screen and
    under "Not started" on the sheet in Walt's hand is the failure worth
    spending a test on: both are confidently wrong, and nobody can tell which.
    """
    ready = make_recon_vehicle(client, stock_number="B-READY", vin="1HGCM82633A000101", purchase_price=0)
    working = make_recon_vehicle(client, stock_number="B-WORKING", vin="1HGCM82633A000102", purchase_price=0)
    make_recon_vehicle(client, stock_number="B-WAITING", vin="1HGCM82633A000103", purchase_price=0)

    done = make_recon_order(client, ready["id"])
    client.patch(f"/api/orders/{done['id']}/status", json={"status": "complete", "actor": "tester"})
    started = make_recon_order(client, working["id"])
    client.patch(f"/api/orders/{started['id']}/status", json={"status": "in_progress", "actor": "tester"})

    rows = board(client)
    assert row_for(rows, "B-READY")["lot_bucket"] == "ready"
    assert row_for(rows, "B-WORKING")["lot_bucket"] == "working"
    assert row_for(rows, "B-WAITING")["lot_bucket"] == "waiting"

    # ...and every car agrees with the report, car by car, not just in aggregate.
    report = {r["stock_number"]: r for r in lot(client) if r["stock_number"]}
    for row in rows:
        if not row["stock_number"]:
            continue
        mirror = report[row["stock_number"]]
        assert row["lot_bucket"] == mirror["lot_bucket"], row["stock_number"]
        assert row["needs"] == mirror["needs"], row["stock_number"]
        assert row["remaining_cost"] == mirror["remaining_cost"], row["stock_number"]


def test_a_board_card_can_say_what_the_car_is_waiting_on(client):
    """The columns put the report's "what does this still need" sentence on
    each card, so the board carries it too rather than the browser inventing a
    second phrasing of the same facts."""
    recon = make_recon_vehicle(client, stock_number="B-NEEDS", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    row = row_for(board(client), "B-NEEDS")
    assert "1 part on order" in row["needs"], row["needs"]
    assert row["lot_bucket"] == "working", "a car with parts on order is not 'not started'"


def test_the_spend_report_carries_the_grouping_too(client):
    """vehicle-spend is the same rows over a date window, so a card built from
    either one describes the car the same way."""
    make_recon_vehicle(client, stock_number="B-SPEND", purchase_price=0)
    rows = client.get("/api/reports/vehicle-spend").json()
    row = row_for(rows, "B-SPEND")
    assert row["lot_bucket"] == "waiting"
    assert "no ticket written yet" in row["needs"].lower(), row["needs"]
