from __future__ import annotations

from tests.helpers import (
    backdate_activity,
    days_ago,
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


def test_vehicle_spend_report(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 80, "unit_cost": 80}],
    )
    make_we_owe(client)

    rows = client.get("/api/reports/vehicle-spend").json()
    assert len(rows) == 2

    recon_rows = client.get("/api/reports/vehicle-spend", params={"segment": "recon"}).json()
    assert len(recon_rows) == 1
    assert recon_rows[0]["stock_number"] == "R-1101"
    assert recon_rows[0]["actual_cost"] == 80


def test_vehicle_spend_report_date_filter(client):
    make_recon_vehicle(client, stock_number="R-1102")
    future_only = client.get("/api/reports/vehicle-spend", params={"start": "2099-01-01"}).json()
    assert future_only == []


def test_technician_productivity(client):
    technician = client.post("/api/staff", json={"name": "Jordan", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-1103")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 2, "unit_price": 40, "unit_cost": 40}],
    )
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})

    rows = client.get("/api/reports/technicians").json()
    row = next(r for r in rows if r["technician"] == "Jordan")
    assert row["ro_count"] == 1
    assert row["labor_hours"] == 2
    # The ticket is still open, so it counts against what Jordan is holding.
    assert row["open_count"] == 1
    assert row["completed_count"] == 0
    # No money on this report: labor on recon and we-owe is never charged out,
    # so a labor-cost figure here is a column of zeros pretending to be a result.
    assert "labor_cost" not in row


def test_technician_report_reports_no_money(client):
    """CLAUDE.md's money rule, enforced where it kept getting broken.

    Recon and we-owe labor is billed at nothing, so any dollar figure on a
    per-technician report is either zero or invented. The report should carry
    none at all rather than a zero somebody might one day try to "fix"."""
    client.post("/api/staff", json={"name": "Moneyless Mo", "role": "technician"})
    rows = client.get("/api/reports/technicians").json()
    assert rows
    for row in rows:
        assert not [key for key in row if "cost" in key or "price" in key or "rate" in key], row


def test_technician_ro_count_includes_tickets_they_only_own_a_job_on(client):
    """A specialist pulled in for one job owns that job's hours -- so the
    ticket has to count as theirs too. Counting hours one way and repair
    orders another read as "3 hours across 0 repair orders"."""
    default_tech = client.post("/api/staff", json={"name": "Ticket Tess", "role": "technician"}).json()
    job_tech = client.post("/api/staff", json={"name": "Specialist Sal", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-1106")
    order = make_recon_order(client, vehicle["id"])
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": default_tech["id"]})
    job = client.post(
        f"/api/orders/{order['id']}/jobs", json={"title": "Brakes", "technician_id": job_tech["id"]}
    ).json()
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "labor",
                "description": "Brake job",
                "quantity": 3,
                "unit_price": 0,
                "unit_cost": 0,
                "job_id": job["id"],
            }
        ],
    )

    rows = client.get("/api/reports/technicians").json()
    job_row = next(r for r in rows if r["technician"] == "Specialist Sal")
    assert job_row["labor_hours"] == 3
    assert job_row["ro_count"] == 1, "the job's technician should own the ticket their hours are on"
    # The ticket's own assignee still owns it, even with no hours of their own.
    assert next(r for r in rows if r["technician"] == "Ticket Tess")["ro_count"] == 1
    # One ticket, counted once for each -- not once per labor line on it.
    assert job_row["open_count"] == 1


def test_technician_report_shows_how_long_their_open_work_has_sat(client, db_path):
    """The number Clayton acts on in the morning: which tech is holding
    something nobody has touched. Measured off last activity, the same clock
    the vehicle board's Idle column reads."""
    technician = client.post("/api/staff", json={"name": "Quiet Quinn", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-1107")
    stale = make_recon_order(client, vehicle["id"], concern="Forgotten")
    fresh = make_recon_order(client, vehicle["id"], concern="Touched today")
    for order in (stale, fresh):
        client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})
    backdate_activity(db_path, stale["id"], days_ago(11))

    row = next(r for r in client.get("/api/reports/technicians").json() if r["technician"] == "Quiet Quinn")
    assert row["open_count"] == 2
    assert row["worst_idle_days"] == 11, "should report the quietest open ticket, not the average or the newest"

    # Finishing the forgotten one takes it out of what they're holding.
    client.patch(f"/api/orders/{stale['id']}/status", json={"status": "complete", "actor": "Clay"})
    after = next(r for r in client.get("/api/reports/technicians").json() if r["technician"] == "Quiet Quinn")
    assert after["open_count"] == 1
    assert after["completed_count"] == 1
    assert after["worst_idle_days"] == 0


def test_technician_with_nothing_open_reports_no_sitting_days(client):
    """Zero has to mean "nothing sitting", not "sitting since today" -- the
    screen prints a dash for it, and a stray number would put a tech holding
    nothing on the same footing as one holding a car touched this morning."""
    client.post("/api/staff", json={"name": "Idle Ida", "role": "technician"})
    row = next(r for r in client.get("/api/reports/technicians").json() if r["technician"] == "Idle Ida")
    assert row["open_count"] == 0
    assert row["worst_idle_days"] == 0


def test_technician_productivity_ignores_voided_tickets(client):
    """A ticket taken back is work that never happened -- the money already
    knew that (cost_rollup skips voided orders) and so does the vehicle board.
    Leaving it in here credited a technician with an RO and with the hours
    flagged on it before the mistake was spotted."""
    technician = client.post("/api/staff", json={"name": "Robin", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-1105")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 2, "unit_price": 40, "unit_cost": 40}],
    )
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})

    before = next(r for r in client.get("/api/reports/technicians").json() if r["technician"] == "Robin")
    assert before["ro_count"] == 1 and before["labor_hours"] == 2, "precondition: the work was counted"

    assert client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"}).status_code == 200
    after = next(r for r in client.get("/api/reports/technicians").json() if r["technician"] == "Robin")
    assert after["ro_count"] == 0
    assert after["completed_count"] == 0, "voiding sets the ticket to complete -- it is not a completed job"
    assert after["labor_hours"] == 0
    # No labor_cost assertion: the report deliberately carries no money at all
    # (see test_technician_report_reports_no_money above).


def test_technician_productivity_uses_job_technician_over_ticket_default(client):
    """A job's own technician should own that job's labor even when a
    different tech is the RO's ticket-level default -- e.g. the ticket
    default did the diagnosis but a specialist was pulled in for one job."""
    default_tech = client.post("/api/staff", json={"name": "Default Dana", "role": "technician"}).json()
    job_tech = client.post("/api/staff", json={"name": "Job Jamie", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-1104")
    order = make_recon_order(client, vehicle["id"])
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": default_tech["id"]})
    job = client.post(
        f"/api/orders/{order['id']}/jobs", json={"title": "Brakes", "technician_id": job_tech["id"]}
    ).json()
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 40, "unit_cost": 40},
            {
                "kind": "labor",
                "description": "Brake job",
                "quantity": 3,
                "unit_price": 40,
                "unit_cost": 40,
                "job_id": job["id"],
            },
        ],
    )

    rows = client.get("/api/reports/technicians").json()
    default_row = next(r for r in rows if r["technician"] == "Default Dana")
    job_row = next(r for r in rows if r["technician"] == "Job Jamie")
    assert default_row["labor_hours"] == 1  # only the ungrouped diag line
    assert job_row["labor_hours"] == 3  # the job's labor, not the ticket default's
