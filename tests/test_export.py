from __future__ import annotations

import csv
import io
import re
from datetime import date
from pathlib import Path

from app.export import VEHICLE_STATUS_LABEL
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


def _rows(res):
    """The file's header and body, read the way a spreadsheet reads it.

    utf-8-sig, not utf-8: every export is written with a byte-order mark so
    Excel on Windows reads the em dashes and middle dots in it as text rather
    than as line noise (see export._excel_bytes). A reader that doesn't skip
    the mark finds it stuck to the front of the first column name.
    """
    text = res.content.decode("utf-8-sig")
    parsed = list(csv.reader(io.StringIO(text)))
    return parsed[0], parsed[1:]


def _cell(header, row, column):
    return row[header.index(column)]


def test_every_export_is_readable_by_excel(client):
    """These files are written to be double-clicked, and on Windows that opens
    Excel, which reads a mark-less .csv in the machine's ANSI code page. The
    sheets are full of em dashes and middle dots that aren't in it, so every one
    of them used to arrive as two or three characters of garbage."""
    # A car whose ticket closed with a part nobody receipted, because its
    # "Still Needs" sentence is one of the ones written with an em dash.
    vehicle = make_recon_vehicle(client, stock_number="R-8400")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Tires", "quantity": 1, "unit_price": 380, "unit_cost": 380}],
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    make_we_owe(client, description="Fix mirror")

    for path in (
        "/api/export/vehicles.csv",
        "/api/export/report/vehicle-spend.csv",
        "/api/export/report/lot.csv",
        "/api/export/report/vehicle-profit.csv",
        "/api/export/report/technicians.csv",
    ):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.content.startswith(b"\xef\xbb\xbf"), f"{path} has no byte-order mark"
        # ...exactly one of them: a reader that skips the mark must land on the
        # first column name, not on a second mark.
        assert not res.content.decode("utf-8-sig").startswith("﻿"), path

    # The characters this is all about, still intact in the file.
    header, body = _rows(client.get("/api/export/report/lot.csv"))
    needs = _cell(header, next(r for r in body if _cell(header, r, "Stock #") == "R-8400"), "Still Needs")
    assert "—" in needs, f"the lot sheet's sentences lost their dashes: {needs!r}"


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

    header, body = _rows(res)
    assert header == [
        "Stock #",
        "Customer",
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

    recon_row = next(r for r in body if _cell(header, r, "Stock #") == "R-7001")
    assert _cell(header, recon_row, "Segment") == "Recon"
    assert "INV-1" in _cell(header, recon_row, "Linked Vendor Invoices")
    assert "WorldPac" in _cell(header, recon_row, "Linked Vendor Invoices")

    assert any(_cell(header, r, "Segment") == "We-Owe" for r in body)


def test_a_we_owe_keeps_its_customer_out_of_the_stock_number_column(client):
    """A stock number and a customer's name are two different things, and the
    column a downloaded sheet gets sorted by is the stock number. Putting the
    customer in it interleaved people's names among the R-numbers, and left the
    name the screen shows on every we-owe row in no column at all."""
    make_recon_vehicle(client, stock_number="R-8500")
    make_we_owe(client, customer_name="Renata Silva", description="Tie rod")

    for path in ("/api/export/vehicles.csv", "/api/export/report/vehicle-spend.csv", "/api/export/report/lot.csv"):
        header, body = _rows(client.get(path))
        assert "Customer" in header, path
        we_owe = next(r for r in body if _cell(header, r, "Customer") == "Renata Silva")
        assert _cell(header, we_owe, "Stock #") == "", path

        recon = next(r for r in body if _cell(header, r, "Stock #") == "R-8500")
        # ...and the other way round: a lot car is nobody's, so its customer
        # cell stays blank rather than borrowing the shop's own record.
        assert _cell(header, recon, "Customer") == "", path


def test_a_car_with_no_ticket_gets_a_status_in_words(client):
    """A vehicle row's status is a ticket status on a car with a ticket and a
    board status on one without, and the file holds both in one column. The
    exports knew only the ticket half, so a lot sheet read "acquired", "sold"
    and "waived" in raw lower case beside "Complete" from the same column."""
    make_recon_vehicle(client, stock_number="R-8600")
    make_we_owe(client, description="Touch up paint")

    header, body = _rows(client.get("/api/export/report/lot.csv"))
    statuses = {_cell(header, r, "Status") for r in body}
    assert statuses == {"Acquired", "Open"}
    assert not any(word.islower() for word in statuses)


def test_the_browser_and_the_exports_say_the_same_status_words(client):
    """The screen has its own copy of this map, and the two drifting apart is
    exactly how the exports ended up printing raw column values: nothing held
    them together. state.js is the browser's copy."""
    source = (Path(__file__).resolve().parent.parent / "static/js/state.js").read_text(encoding="utf-8")
    body = re.search(r"export const STATUS_LABEL = \{(.*?)\n\};", source, re.DOTALL)
    assert body, "STATUS_LABEL is no longer declared the way this test reads it"
    on_screen = dict(re.findall(r"(\w+):\s*\"([^\"]+)\"", body.group(1)))
    assert on_screen == VEHICLE_STATUS_LABEL


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
            {"kind": "labor", "description": "Diag", "quantity": 2, "unit_price": 45, "unit_cost": 45},
            # Written up but never received, so Written Up and Cost have to
            # differ -- a file reporting one number for both would look right.
            # The labor lands the moment it is logged; the rotor never does.
            # (This used to force the gap with unit_price != unit_cost, which
            # save_estimate now refuses on recon -- that's a markup.)
            {"kind": "part", "description": "Rotor", "quantity": 1, "unit_price": 60, "unit_cost": 60},
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
        # The we-owe's customer, kept out of the column above so the file can
        # be sorted by stock number -- see the test of that name.
        "Customer",
        "Vehicle",
        "VIN",
        "Type",
        "Status",
        "Technicians",
        "Written Up",
        "Cost",
        # Money out the door on a finished ticket nobody marked received, so
        # it is in none of the figures beside it -- see test_unreceived_parts.
        "Never Marked Received",
        "Customer Paid",
        "Net to Shop",
        "Age (days)",
        # This report covers cars already filed to History, so the file has to
        # say which rows those are -- see test_spend_report_window.py.
        "Filed To History",
    ]
    assert len(body) == 2
    recon_row = next(r for r in body if _cell(header, r, "Stock #") == "R-8001")
    assert _cell(header, recon_row, "Type") == "Recon"
    # 2 x $45 labor + the $60 rotor, every line in full
    assert _cell(header, recon_row, "Written Up") == "150.00"
    assert _cell(header, recon_row, "Cost") == "90.00"  # only the labor has actually landed
    # Nothing yet: this ticket is still open, and an unreceived line on an open
    # ticket is work still ahead rather than a hole in what the car cost.
    assert _cell(header, recon_row, "Never Marked Received") == "0.00"

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


def test_the_lot_csv_carries_the_money_that_is_not_in_spent_so_far(client):
    """Summing Spent So Far is the first thing anyone does with this file, and
    a total that is quietly short is worse in a spreadsheet than on a screen --
    there is nothing beside it to explain itself. A car whose ticket closed
    with parts nobody receipted gets its own column, so the sum can be
    completed rather than merely being wrong."""
    vehicle = make_recon_vehicle(client, stock_number="R-8301")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Tires (set of 4)",
                "part_number": "T-4",
                "quantity": 1,
                "unit_price": 380,
                "unit_cost": 380,
            }
        ],
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    header, body = _rows(client.get("/api/export/report/lot.csv"))
    assert "Never Marked Received" in header
    spent = header.index("Spent So Far")
    never = header.index("Never Marked Received")
    # Directly beside the figure it corrects, and before Still To Spend --
    # the two are different kinds of money and reading them in the wrong
    # order is how one gets added to the other.
    assert never == spent + 1
    assert header[never + 1] == "Still To Spend"

    row = next(r for r in body if r[header.index("Stock #")] == "R-8301")
    assert row[spent] == "0.00"
    assert row[never] == "380.00"


def test_a_fully_receipted_car_reports_nothing_missing_in_the_csv(client):
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-8302")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Battery",
                "part_number": "B-1",
                "quantity": 1,
                "unit_price": 140,
                "unit_cost": 140,
            }
        ],
    )
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [estimate["items"][0]["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-8302"},
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    header, body = _rows(client.get("/api/export/report/lot.csv"))
    row = next(r for r in body if r[header.index("Stock #")] == "R-8302")
    assert row[header.index("Spent So Far")] == "140.00"
    assert row[header.index("Never Marked Received")] == "0.00"


def test_export_technician_report_csv(client):
    technician = client.post("/api/staff", json={"name": "Wes", "role": "technician"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-8002")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Brakes", "quantity": 3, "unit_price": 50, "unit_cost": 50},
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
