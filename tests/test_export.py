from __future__ import annotations

import csv
import io
from datetime import date

from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


def test_export_vehicles_csv(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-7001", purchase_price=9999)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    make_we_owe(client, description="Fix mirror")

    res = client.get("/api/export/vehicles.csv")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    assert "attachment" in res.headers["content-disposition"]

    rows = list(csv.reader(io.StringIO(res.text)))
    header, body = rows[0], rows[1:]
    assert header == [
        "Stock #/Customer",
        "Vehicle",
        "VIN",
        "Segment",
        "Status",
        "Age (days)",
        "What's In It",
        "Linked Vendor Invoices",
        "Updated At",
    ]
    assert "Purchase Price" not in header
    assert not any("9999" in cell for row in body for cell in row)  # purchase price never leaks into the export

    recon_row = next(r for r in body if r[0] == "R-7001")
    assert recon_row[3] == "Recon"
    assert "INV-1" in recon_row[7]
    assert "WorldPac" in recon_row[7]

    assert any(r[3] == "We-Owe" for r in body)


def _rows(res):
    parsed = list(csv.reader(io.StringIO(res.text)))
    return parsed[0], parsed[1:]


def test_export_vehicle_spend_report_csv(client):
    """The Reports screen's Download CSV. It takes the same start/end/segment
    the report itself does and is built from the same row builder, so the
    file can't quietly disagree with what's on screen."""
    vehicle = make_recon_vehicle(client, stock_number="R-8001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Diag", "quantity": 2, "unit_price": 60, "unit_cost": 45},
            # Quoted but never received, so Quoted and Cost have to differ -- a
            # file that reported one number for both would look right otherwise.
            {"kind": "part", "description": "Rotor", "quantity": 1, "unit_price": 90, "unit_cost": 60},
        ],
    )
    make_we_owe(client, description="Touch up paint")

    res = client.get("/api/export/report/vehicle-spend.csv")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    assert "vehicle-spend" in res.headers["content-disposition"]

    header, body = _rows(res)
    assert header == [
        "Stock #",
        "Vehicle",
        "VIN",
        "Type",
        "Status",
        "Technicians",
        "Quoted",
        "Cost",
        "Customer Paid",
        "Net to Shop",
        "Age (days)",
    ]
    assert len(body) == 2
    recon_row = next(r for r in body if r[0] == "R-8001")
    assert recon_row[3] == "Recon"
    assert recon_row[6] == "150.00"  # 2 x $45 labor + the $60 rotor, quoted in full
    assert recon_row[7] == "90.00"  # only the labor has actually landed

    # The segment filter has to reach the file, or "Recon only" on screen
    # downloads every vehicle in the shop.
    _, recon_only = _rows(client.get("/api/export/report/vehicle-spend.csv", params={"segment": "recon"}))
    assert [r[0] for r in recon_only] == ["R-8001"]

    # ...and so does the date range.
    _, future = _rows(client.get("/api/export/report/vehicle-spend.csv", params={"start": "2099-01-01"}))
    assert future == []


def _filename(res):
    disposition = res.headers["content-disposition"]
    return disposition.split('filename="', 1)[1].rstrip('"')


def test_a_ranged_report_csv_is_named_for_the_window_it_covers(client):
    """Downloaded reports get saved and emailed on, and the range is the one
    thing about a CSV that isn't inside the file. Stamping every one with the
    day it was made put This Month and This Year in the same folder under names
    that differed by nothing."""
    make_recon_vehicle(client, stock_number="R-8100")

    both = _filename(
        client.get("/api/export/report/vehicle-spend.csv", params={"start": "2026-07-01", "end": "2026-07-31"})
    )
    assert both == "discount-auto-ops-vehicle-spend-2026-07-01-to-2026-07-31.csv"

    # A half-open window still says which half it's open on.
    assert "-from-2026-07-01.csv" in _filename(
        client.get("/api/export/report/vehicle-spend.csv", params={"start": "2026-07-01"})
    )
    assert "-through-2026-07-31.csv" in _filename(
        client.get("/api/export/report/vehicle-spend.csv", params={"end": "2026-07-31"})
    )

    # The segment stays in the name too -- Recon and We-Owe over the same
    # window are two different files and have to be told apart.
    recon = _filename(
        client.get(
            "/api/export/report/vehicle-spend.csv",
            params={"segment": "recon", "start": "2026-07-01", "end": "2026-07-31"},
        )
    )
    assert recon == "discount-auto-ops-vehicle-spend-recon-2026-07-01-to-2026-07-31.csv"

    # No range at all is all-time, and says so rather than borrowing the
    # day's date and reading like a one-day report.
    assert "-all-time-" in _filename(client.get("/api/export/report/vehicle-spend.csv"))

    # Same rule on the other two ranged reports.
    assert "2026-07-01-to-2026-07-31" in _filename(
        client.get("/api/export/report/technicians.csv", params={"start": "2026-07-01", "end": "2026-07-31"})
    )
    assert "2026-07-01-to-2026-07-31" in _filename(
        client.get("/api/export/report/vehicle-profit.csv", params={"start": "2026-07-01", "end": "2026-07-31"})
    )


def test_the_lot_csv_is_still_stamped_with_the_day_it_was_taken(client):
    """The lot report is a snapshot, not a window: the day it was run IS what
    it covers, so it must not pick up an all-time label."""
    make_recon_vehicle(client, stock_number="R-8101")
    name = _filename(client.get("/api/export/report/lot.csv"))
    assert name.startswith("discount-auto-ops-lot-status-")
    assert "all-time" not in name
    assert name == f"discount-auto-ops-lot-status-{date.today():%Y-%m-%d}.csv"


def test_export_technician_report_csv(client):
    technician = client.post("/api/staff", json={"name": "Wes", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-8002")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Brakes", "quantity": 3, "unit_price": 80, "unit_cost": 50},
        ],
    )
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})

    res = client.get("/api/export/report/technicians.csv")
    assert res.status_code == 200
    header, body = _rows(res)
    assert header == ["Technician", "Repair Orders", "Completed", "Still Open", "Longest Sitting (days)", "Labor Hours"]
    wes = next(r for r in body if r[0] == "Wes")
    assert wes[1] == "1" and wes[2] == "0"
    assert wes[3] == "1" and wes[4] == "0", "one open ticket, touched today"
    assert wes[5] == "3.00"
    # No money column at all -- recon and we-owe labor is never charged out.
    assert not any("Cost" in column or "Rate" in column for column in header)


def test_report_csv_rejects_an_unknown_segment(client):
    """The segment is a closed set on the report endpoint; the export has to
    agree, or a typo'd link silently returns the whole lot instead."""
    assert client.get("/api/export/report/vehicle-spend.csv", params={"segment": "wholesale"}).status_code == 422
