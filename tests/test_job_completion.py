"""Ticking a repair off a ticket.

A ticket's status is one flag for the whole car, so before this the app could
say a car was "in progress" and nothing more. Walt's third question -- what
does each remaining car still need -- could only be answered in money ("$420
of work left"), which does not tell him whether what's outstanding is
a windshield or an oil change, and a ticket with four repairs read exactly the
same whether three were finished or none were.

Jobs already carve a ticket into its individual repairs. These tests cover
giving each one a done state, and the two places that state has to show up:
the ticket itself and the Lot Report's "still needs" sentence.
"""

from __future__ import annotations

from app.db import connect
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    make_we_owe,
    save_estimate,
)

LABOR = {"kind": "labor", "description": "R&R", "quantity": 1, "unit_price": 0, "unit_cost": 0}


def add_job(client, order_id: int, title: str) -> dict:
    res = client.post(f"/api/orders/{order_id}/jobs", json={"title": title})
    assert res.status_code == 201, res.text
    return res.json()


def set_done(client, order_id: int, job_id: int, done: bool = True, actor: str = "Antonio"):
    return client.patch(f"/api/orders/{order_id}/jobs/{job_id}/done", json={"done": done, "actor": actor})


def jobs_on(client, order_id: int) -> list[dict]:
    return client.get(f"/api/orders/{order_id}").json()["estimate"]["jobs"]


def lot_row(client, stock: str) -> dict:
    rows = [r for r in client.get("/api/reports/lot").json() if r["stock_number"] == stock]
    assert len(rows) == 1, f"expected one lot row for {stock}, got {len(rows)}"
    return rows[0]


def board_row(client, stock: str) -> dict:
    rows = [r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == stock]
    assert len(rows) == 1, f"expected one board row for {stock}, got {len(rows)}"
    return rows[0]


def test_a_job_can_be_ticked_off_and_put_back(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB1")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Front brakes")
    assert job["completed_at"] == "", "a brand-new job is not already finished"

    res = set_done(client, order["id"], job["id"], True, actor="Antonio")
    assert res.status_code == 200, res.text
    assert res.json()["completed_at"], "ticking a job left no completion stamp"
    assert res.json()["completed_by"] == "Antonio"

    stored = jobs_on(client, order["id"])[0]
    assert stored["completed_at"], "the completion did not survive to the ticket"

    res = set_done(client, order["id"], job["id"], False)
    assert res.status_code == 200, res.text
    assert res.json()["completed_at"] == "", "reopening a job left its completion stamp behind"
    assert res.json()["completed_by"] == "", "reopening a job left the old finisher's name behind"


def test_ticking_the_same_job_twice_is_harmless(client):
    """The checkbox can be double-clicked, and two people can be looking at the
    same ticket. A second tick must not move the stamp or write a second event."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB2")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Windshield")

    first = set_done(client, order["id"], job["id"]).json()
    second = set_done(client, order["id"], job["id"]).json()
    assert second["completed_at"] == first["completed_at"], "a repeat tick moved the completion stamp"

    events = client.get(f"/api/orders/{order['id']}").json()["activity"]
    assert [e["action"] for e in events].count("job_completed") == 1


def test_finishing_a_repair_counts_as_touching_the_car(client, db_path):
    """The board's Idle column is what surfaces forgotten cars. Finishing a
    repair is exactly the moment a car should stop reading as forgotten -- and
    before this it was invisible unless somebody also changed the ticket's
    status."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB3")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Detail")
    with connect(db_path) as db:
        db.execute("UPDATE orders SET last_activity_at=? WHERE id=?", ("2020-01-01T08:00:00", order["id"]))
        db.commit()

    set_done(client, order["id"], job["id"])

    assert board_row(client, "R-JOB3")["idle_days"] == 0, "ticking a repair off did not reset the idle clock"
    actions = [e["action"] for e in client.get(f"/api/orders/{order['id']}").json()["activity"]]
    assert "job_completed" in actions, "finishing a repair was not written to the activity log"


def test_reopening_is_logged_separately_from_finishing(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB4")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "AC")
    set_done(client, order["id"], job["id"], True)
    set_done(client, order["id"], job["id"], False)

    actions = [e["action"] for e in client.get(f"/api/orders/{order['id']}").json()["activity"]]
    assert "job_reopened" in actions


def test_the_board_carries_how_far_through_a_car_is(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB5")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [LABOR])
    brakes = add_job(client, order["id"], "Front brakes")
    add_job(client, order["id"], "Windshield")
    set_done(client, order["id"], brakes["id"])

    row = board_row(client, "R-JOB5")
    assert row["jobs_total"] == 2
    assert row["jobs_done"] == 1
    assert row["jobs_open"] == ["Windshield"], "the board did not name the outstanding repair"


def test_a_we_owe_carries_its_repairs_too(client):
    we_owe = make_we_owe(client)
    res = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": we_owe["id"]})
    assert res.status_code == 201, res.text
    order = res.json()
    add_job(client, order["id"], "Passenger mirror")

    row = next(r for r in client.get("/api/vehicles-board").json() if r["segment"] == "we_owe")
    assert row["jobs_total"] == 1
    assert row["jobs_open"] == ["Passenger mirror"]


def test_a_voided_tickets_repairs_are_not_outstanding_work(client):
    """Voiding a ticket means the work never happened, which is the same reason
    cost_rollup drops its money. Its jobs must not keep appearing on Walt's
    sheet as things the shop still owes the car."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB6")
    order = make_recon_order(client, vehicle["id"])
    add_job(client, order["id"], "Written up by mistake")
    assert client.post(f"/api/orders/{order['id']}/void", json={}).status_code == 200

    row = board_row(client, "R-JOB6")
    assert row["jobs_total"] == 0
    assert row["jobs_open"] == []


def test_the_lot_report_says_what_the_car_still_needs_by_name(client):
    """The point of the whole change. Before this the sentence could only be
    money and counts; Walt asking "what does the Elantra need?" got a dollar
    figure back."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB7")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [LABOR])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    brakes = add_job(client, order["id"], "Front brakes")
    add_job(client, order["id"], "Windshield")
    set_done(client, order["id"], brakes["id"])

    needs = lot_row(client, "R-JOB7")["needs"]
    assert "Windshield" in needs, f"the outstanding repair is not named: {needs!r}"
    assert "1 of 2 done" in needs, f"the sentence does not say how far through the car is: {needs!r}"


def test_a_job_title_keeps_the_case_somebody_typed_it_in(client):
    """The sentence used to be built with str.capitalize(), which lowercases
    everything after the first letter. That is fine for machine-written
    clauses and wrong for a title somebody typed: "AC / Front Brakes" is not
    ours to rewrite as "ac / front brakes"."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB8")
    order = make_recon_order(client, vehicle["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    add_job(client, order["id"], "AC Compressor")

    assert "AC Compressor" in lot_row(client, "R-JOB8")["needs"]


def test_a_long_list_of_repairs_is_trimmed_rather_than_run_on(client):
    """Six open jobs would otherwise take a whole line to themselves and push
    the money on the same row off the printed page."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB9")
    order = make_recon_order(client, vehicle["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    for title in ("Brakes", "Windshield", "Detail", "Tires", "Alignment"):
        add_job(client, order["id"], title)

    needs = lot_row(client, "R-JOB9")["needs"]
    assert "+2 more" in needs, f"the list was not trimmed: {needs!r}"
    assert "Tires" not in needs and "Alignment" not in needs


def test_a_long_winded_job_title_cannot_hide_the_money(client):
    """A job title typed with a customer on the phone can be a sentence in its
    own right, and the board card gives the whole "still needs" line two lines
    before cutting it. One long title used to spend both, and the clauses
    behind it -- parts on order, dollars left -- were exactly the ones that
    vanished. The title is clipped on a word instead, and the money survives."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB16")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Control arm", "quantity": 1, "unit_price": 100, "unit_cost": 100}],
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    add_job(
        client,
        order["id"],
        "Front suspension rebuild — both lower control arms, sway bar links, alignment after",
    )

    needs = lot_row(client, "R-JOB16")["needs"]
    assert "Front suspension rebuild" in needs, f"the repair lost its name entirely: {needs!r}"
    assert "…" in needs, f"a title past the budget was not clipped: {needs!r}"
    assert "alignment after" not in needs, f"the title's tail is still spending the line: {needs!r}"
    assert "$100.00 of work left" in needs, f"the money the title used to push out of sight: {needs!r}"


def test_one_long_title_pushes_its_neighbours_into_the_count(client):
    """The budget is shared: when the first outstanding repair's title eats it,
    the other repairs are counted rather than named. Three short names still
    come through in full -- test_a_long_list_of_repairs_is_trimmed_rather_than_run_on
    holds that side."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB17")
    order = make_recon_order(client, vehicle["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    add_job(
        client,
        order["id"],
        "A/C blows warm — diagnose leak, replace condenser, evac and recharge next morning",
    )
    add_job(client, order["id"], "Windshield")
    add_job(client, order["id"], "Detail")

    needs = lot_row(client, "R-JOB17")["needs"]
    assert "+2 more" in needs, f"the repairs the budget squeezed out are not counted: {needs!r}"
    assert "Windshield" not in needs and "Detail" not in needs


def test_a_car_whose_work_is_all_ticked_says_the_ticket_needs_closing(client):
    """The most useful thing the report can say about this car: nothing is
    waiting on a technician, only on somebody clicking Complete."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB10")
    order = make_recon_order(client, vehicle["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    job = add_job(client, order["id"], "Brakes")
    set_done(client, order["id"], job["id"])

    needs = lot_row(client, "R-JOB10")["needs"]
    assert "close the ticket" in needs, f"expected a close-out nudge, got {needs!r}"


def test_a_finished_car_still_reads_as_ready_to_go(client):
    """A closed ticket short-circuits the sentence before any of this runs --
    the car is out, and a leftover open job must not put words back on it."""
    vehicle = make_recon_vehicle(client, stock_number="R-JOB11")
    order = make_recon_order(client, vehicle["id"])
    add_job(client, order["id"], "Brakes")
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    assert lot_row(client, "R-JOB11")["needs"] == "Nothing — ready to go"


def test_an_archived_vehicles_repairs_cannot_be_ticked(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB12")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Brakes")
    assert client.post(f"/api/recon/vehicles/{vehicle['id']}/archive", json={}).status_code == 200

    assert set_done(client, order["id"], job["id"]).status_code == 409


def test_a_voided_ticket_cannot_be_ticked(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB13")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Brakes")
    assert client.post(f"/api/orders/{order['id']}/void", json={}).status_code == 200

    assert set_done(client, order["id"], job["id"]).status_code == 409


def test_an_invoiced_ticket_can_still_have_its_work_ticked_off(client):
    """Billing a retail customer freezes the money on the ticket, deliberately.
    Whether the brake job is finished is not money -- locking it would leave a
    car in the bay with no way to record what has been done to it."""
    order = make_retail_order(client, concern="Brakes")
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Brake job", "quantity": 1, "unit_price": 120, "unit_cost": 60}],
    )
    job = add_job(client, order["id"], "Front brakes")
    assert (
        client.post(
            f"/api/orders/{order['id']}/authorization",
            json={"status": "approved", "approved_by": "Paying Customer", "method": "phone"},
        ).status_code
        == 201
    )
    assert client.post(f"/api/orders/{order['id']}/invoice", json={}).status_code == 201

    assert set_done(client, order["id"], job["id"]).status_code == 200


def test_a_job_on_another_ticket_is_not_reachable(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB14")
    first = make_recon_order(client, vehicle["id"])
    second = make_recon_order(client, vehicle["id"])
    job = add_job(client, first["id"], "Brakes")

    assert set_done(client, second["id"], job["id"]).status_code == 404


def test_an_older_database_gains_the_columns_without_losing_its_jobs(client, db_path):
    """Live shop databases predate these columns. The migration is additive --
    every job already on file comes back as not-yet-done, which is exactly what
    the app assumed before, so no existing record changes meaning and nothing
    has to be re-entered.

    Rolling the real database back to the old shape and starting the app on it
    again is the only version of this test worth having: a hand-built stub
    would only prove the ALTER statement parses."""
    from app.main import create_app

    vehicle = make_recon_vehicle(client, stock_number="R-JOB15")
    order = make_recon_order(client, vehicle["id"])
    job = add_job(client, order["id"], "Pre-existing brake job")
    set_done(client, order["id"], job["id"])

    with connect(db_path) as db:
        db.execute("ALTER TABLE estimate_jobs DROP COLUMN completed_at")
        db.execute("ALTER TABLE estimate_jobs DROP COLUMN completed_by")
        db.commit()

    create_app(db_path, backups_dir=db_path.parent / "backups")

    with connect(db_path) as db:
        row = db.execute("SELECT title, completed_at, completed_by FROM estimate_jobs").fetchone()
    assert row["title"] == "Pre-existing brake job", "the migration lost a job that was already on file"
    assert row["completed_at"] == ""
    assert row["completed_by"] == ""
