from __future__ import annotations

from tests.helpers import (
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
    assert row["labor_cost"] == 80


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
