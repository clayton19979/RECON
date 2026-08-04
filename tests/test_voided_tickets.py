"""A voided ticket never happened -- including for the car's status.

Voiding is how a ticket started by mistake gets taken back. `void_order`
writes `status='complete', voided=1`: the complete is bookkeeping (the row has
to leave the open-orders count somehow), the voided flag is the meaning.

`cost_rollup` has always honoured that -- a voided ticket contributes no money
-- and so has `last_activity`, and so does every customer-facing count in
`main.py`. The vehicle board did not: it read the ticket's *status* to decide
what the car is doing, and a voided ticket's status is the word "complete".

So a car whose only ticket had been voided reported itself finished. On the
board it showed a green Complete pill; on Walt's Lot Report it sat under
"Ready to go" with "Nothing -- ready to go" beside it; and because
`is_stalled` deliberately never flags a finished car, it could sit on the lot
untouched forever without ever appearing in the Stalled count. A mistake that
takes one click to make made a car invisible in exactly the three places that
exist to stop cars going missing.
"""

from __future__ import annotations

from app.db import connect
from app.recon import is_stalled
from tests.helpers import (
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


def board_row(client, recon_id):
    return next(r for r in client.get("/api/vehicles-board").json() if r["recon_id"] == recon_id)


def lot_row(client, stock):
    match = [r for r in client.get("/api/reports/lot").json() if r["stock_number"] == stock]
    assert len(match) == 1, f"expected exactly one lot row for {stock}, got {len(match)}"
    return match[0]


def backdate_arrival(db_path, recon_id: int, when: str) -> None:
    """Pretend the car landed on the lot a while ago. There is no API for it
    -- intake stamps the moment it happens -- so this reaches for the same
    database file the app is using, the way tests/helpers.py does."""
    with connect(db_path) as db:
        db.execute("UPDATE recon_vehicles SET created_at=? WHERE id=?", (when, recon_id))
        db.commit()


def void(client, order_id):
    res = client.post(f"/api/orders/{order_id}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text
    return res.json()


def test_a_car_whose_only_ticket_was_voided_is_not_finished(client):
    """The headline case. Nothing was done to this car."""
    recon = make_recon_vehicle(client, stock_number="R-VOID1", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    row = board_row(client, recon["id"])
    assert row["status_bucket"] == "in_progress", "a voided ticket is reporting the car as finished"
    assert row["status"] != "complete", f"the board is showing the voided ticket's status: {row['status']}"


def test_the_detail_page_agrees_with_the_board_about_a_voided_ticket(client):
    """Two views of one car; if they disagree, one of them is lying."""
    recon = make_recon_vehicle(client, stock_number="R-VOID2", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    detail = client.get(f"/api/recon/vehicles/{recon['id']}").json()
    assert detail["status_bucket"] == board_row(client, recon["id"])["status_bucket"]
    assert detail["status_bucket"] == "in_progress"


def test_a_voided_ticket_does_not_put_a_car_under_ready_to_sell(client):
    """Walt reads the Lot Report on his own. "Ready to go" is an instruction
    to put the car back out, and this car has had nothing done to it."""
    recon = make_recon_vehicle(client, stock_number="R-VOID3", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    row = lot_row(client, "R-VOID3")
    assert row["lot_bucket"] != "ready", "a car with only a voided ticket is being called ready to go"
    assert "ready to go" not in row["needs"].lower(), row["needs"]


def test_the_lot_report_says_the_ticket_was_voided_rather_than_that_none_exists(client):
    """ "No ticket written yet" is true of the live tickets and confusing to
    read about a car somebody remembers writing one for. Naming the void is
    what makes the row actionable."""
    recon = make_recon_vehicle(client, stock_number="R-VOID4", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    needs = lot_row(client, "R-VOID4")["needs"].lower()
    assert "voided" in needs, needs


def test_a_car_with_only_a_voided_ticket_can_go_stalled(client, db_path):
    """The consequence that actually loses a car. A finished car is never
    stalled, on purpose -- so calling this one finished switched off the one
    alarm that would have surfaced it."""
    recon = make_recon_vehicle(client, stock_number="R-VOID5", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])
    # Backdating the ticket would do nothing: last_activity already ignores
    # voided tickets, so this car's clock falls back to when it landed on the
    # lot -- which is the honest answer and what has to be pushed back here.
    backdate_arrival(db_path, recon["id"], days_ago(40))

    row = board_row(client, recon["id"])
    assert row["idle_days"] >= 40, "precondition: the car really has been sitting"
    assert is_stalled(row), "a car left with nothing but a voided ticket is invisible to the Stalled count"


def test_a_live_ticket_alongside_a_voided_one_still_drives_the_car(client):
    """The everyday shape: write the ticket on the wrong car, void it, write
    the right one. The live ticket is the answer, not the newest row."""
    recon = make_recon_vehicle(client, stock_number="R-VOID6", purchase_price=0)
    mistake = make_recon_order(client, recon["id"])
    void(client, mistake["id"])
    real = make_recon_order(client, recon["id"], concern="Brakes")
    client.patch(f"/api/orders/{real['id']}/status", json={"status": "in_progress", "actor": "tester"})

    row = board_row(client, recon["id"])
    assert row["status"] == "in_progress"
    assert row["order_id"] == real["id"], "board actions would attach to the voided ticket"


def test_board_actions_never_point_at_a_voided_ticket(client):
    """order_id is what "+ Task" and the bulk task button hang a follow-up
    on. Pointing it at a voided ticket makes a task nobody can act on."""
    recon = make_recon_vehicle(client, stock_number="R-VOID7", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    assert board_row(client, recon["id"])["order_id"] is None


def test_a_voided_ticket_does_not_credit_a_technician_on_the_board(client):
    """Same rule as the money: the work never happened, so nobody did it."""
    tech = client.post("/api/staff", json={"name": "Antonio", "role": "technician"}).json()
    recon = make_recon_vehicle(client, stock_number="R-VOID8", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": tech["id"]})
    assert res.status_code == 200, res.text
    void(client, order["id"])

    assert board_row(client, recon["id"])["technicians"] == []


def test_a_finished_car_is_still_finished(client):
    """The other side of the rule -- a real closed ticket must keep reading as
    done, or all that has been achieved is breaking the Ready pile."""
    recon = make_recon_vehicle(client, stock_number="R-VOID9", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"})

    assert board_row(client, recon["id"])["status_bucket"] == "finished"
    assert lot_row(client, "R-VOID9")["lot_bucket"] == "ready"


def test_a_voided_ticket_does_not_make_a_finished_car_unfinished(client):
    """A car that was worked, closed, and then had a second ticket opened and
    voided by mistake is still a finished car."""
    recon = make_recon_vehicle(client, stock_number="R-VOID10", purchase_price=0)
    real = make_recon_order(client, recon["id"])
    client.patch(f"/api/orders/{real['id']}/status", json={"status": "complete", "actor": "tester"})
    mistake = make_recon_order(client, recon["id"], concern="Wrong car")
    void(client, mistake["id"])

    row = board_row(client, recon["id"])
    assert row["status_bucket"] == "finished"
    assert row["order_id"] == real["id"]


def test_a_voided_ticket_is_off_the_dashboards_open_count_but_the_car_is_on_it(client):
    """The dashboard counts cars with work outstanding. A car whose ticket was
    voided has work outstanding -- somebody still has to write it a real one."""
    recon = make_recon_vehicle(client, stock_number="R-VOID11", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    before = client.get("/api/dashboard").json()["recon_open"]
    void(client, order["id"])

    assert client.get("/api/dashboard").json()["recon_open"] == before, (
        "voiding a ticket dropped the car out of the open count entirely"
    )


def test_a_we_owe_promise_with_only_a_voided_ticket_is_still_open(client):
    """A we-owe's own fulfilled/waived flag is the authority on whether the
    promise is kept, and voiding a ticket is not keeping it."""
    item = make_we_owe(client, description="Replace tie rod")
    order = client.post("/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    void(client, order["id"])

    row = next(r for r in client.get("/api/vehicles-board").json() if r["we_owe_id"] == item["id"])
    assert row["status_bucket"] == "in_progress"
    assert row["status"] == "open", f"the board is showing the voided ticket's status: {row['status']}"
    assert row["order_id"] is None


def test_voided_money_stays_out_and_the_car_still_reads_as_unstarted(client):
    """The rollup already excluded the money. The status has to agree with it,
    or the row says "$0.00 spent" under a heading that says "Ready to go"."""
    recon = make_recon_vehicle(client, stock_number="R-VOID12", purchase_price=0)
    order = make_recon_order(client, recon["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    void(client, order["id"])

    row = lot_row(client, "R-VOID12")
    assert row["actual_cost"] == 0
    assert row["quoted_cost"] == 0
    assert row["parts_pending"] == 0, "a voided ticket is still reporting parts on order"
    assert row["lot_bucket"] == "waiting"
