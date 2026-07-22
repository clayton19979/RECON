from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.reports import _section
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def test_email_report_section_shows_one_number_not_two(client):
    """The old format showed 'actual $X (quoted $Y)' side by side, which
    reads as if the total were their sum -- exactly the confusion that led
    to a real support question. The email report must match the simplified
    single-number 'cost' language used everywhere else now."""
    vehicle = make_recon_vehicle(client, stock_number="R-9101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 60, "unit_cost": 60}])

    rows = client.get("/api/reports/vehicle-spend", params={"segment": "recon"}).json()
    body = _section(rows, "RECON VEHICLES")

    assert "R-9101" in body
    assert "cost: $60.00" in body
    assert "quoted" not in body.lower()
    assert "Total: $60.00" in body


def test_vehicle_spend_report(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 80, "unit_cost": 80}])
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
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 2, "unit_price": 40, "unit_cost": 40}])
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
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Brakes", "technician_id": job_tech["id"]}).json()
    save_estimate(client, order["id"], [
        {"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 40, "unit_cost": 40},
        {"kind": "labor", "description": "Brake job", "quantity": 3, "unit_price": 40, "unit_cost": 40, "job_id": job["id"]},
    ])

    rows = client.get("/api/reports/technicians").json()
    default_row = next(r for r in rows if r["technician"] == "Default Dana")
    job_row = next(r for r in rows if r["technician"] == "Job Jamie")
    assert default_row["labor_hours"] == 1  # only the ungrouped diag line
    assert job_row["labor_hours"] == 3  # the job's labor, not the ticket default's


def test_email_settings_roundtrip(client):
    res = client.get("/api/settings/email").json()
    assert res["configured"] is False

    client.put(
        "/api/settings/email",
        json={"gmail_address": "shop@gmail.com", "gmail_app_password": "abcd efgh ijkl mnop", "report_recipient": "walt@example.com"},
    )
    res = client.get("/api/settings/email").json()
    assert res["configured"] is True
    assert res["gmail_address"] == "shop@gmail.com"
    assert res["report_recipient"] == "walt@example.com"


def test_send_report_without_connection_fails(client):
    res = client.post("/api/reports/send", json={"report_type": "combined"})
    assert res.status_code == 400


def test_send_report_success_is_logged(client):
    client.put("/api/settings/email", json={"gmail_address": "shop@gmail.com", "gmail_app_password": "secret", "report_recipient": "walt@example.com"})
    with patch("app.reports.smtplib.SMTP_SSL") as mock_smtp:
        mock_smtp.return_value.__enter__.return_value = MagicMock()
        res = client.post("/api/reports/send", json={"report_type": "combined"})
    assert res.status_code == 200
    assert res.json()["status"] == "sent"

    sent = client.get("/api/reports/sent").json()
    assert sent[0]["status"] == "sent"


def test_send_report_failure_is_logged_not_swallowed(client):
    client.put("/api/settings/email", json={"gmail_address": "shop@gmail.com", "gmail_app_password": "secret", "report_recipient": "walt@example.com"})
    with patch("app.reports.smtplib.SMTP_SSL", side_effect=OSError("network down")):
        res = client.post("/api/reports/send", json={"report_type": "combined"})
    assert res.status_code == 502

    sent = client.get("/api/reports/sent").json()
    assert sent[0]["status"] == "failed"
    assert "network down" in sent[0]["error"]


def test_check_replies_without_connection_fails(client):
    res = client.get("/api/reports/replies")
    assert res.status_code == 400


def test_check_replies_success(client):
    client.put("/api/settings/email", json={"gmail_address": "shop@gmail.com", "gmail_app_password": "secret", "report_recipient": "walt@example.com"})
    mock_imap = MagicMock()
    mock_imap.search.return_value = ("OK", [b"1"])
    mock_imap.fetch.return_value = ("OK", [(b"1", b"Subject: RE: Report\r\nFrom: Walt <walt@example.com>\r\nDate: Mon\r\n\r\nLooks good.")])
    with patch("app.reports.imaplib.IMAP4_SSL") as mock_cls:
        mock_cls.return_value.__enter__.return_value = mock_imap
        res = client.get("/api/reports/replies")
    assert res.status_code == 200
    replies = res.json()
    assert replies[0]["subject"] == "RE: Report"
    assert "Looks good" in replies[0]["snippet"]
