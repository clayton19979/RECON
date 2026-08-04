"""What a date range on the spend report is actually asking.

The range means *the car was on the lot during it*. It used to mean "the car's
record is stamped inside it", and the two came apart badly:

- A car written down in June and still in the shop in August fell out of every
  ranged report the moment August began. On the sample lot that left the spend
  report showing one car out of eight and totalling $0.00 -- while the Lot
  Status sheet one chip over, built from the same rows unfiltered, showed the
  money that was really in them.
- A car dropped off the report for good the day it was filed to History, so
  "what did we spend last quarter" was answered with whatever happened to still
  be sitting on the lot today -- which is precisely the wrong set of cars.

These are Walt's fourth question ("how much did we spend on each vehicle"), so
the answer has to survive both the calendar turning over and the car being
sold.
"""

from __future__ import annotations

from app.db import connect
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate

PART = {"kind": "part", "description": "Tie rod", "quantity": 1, "unit_price": 0, "unit_cost": 120}


def spend(client, **params) -> list[dict]:
    res = client.get("/api/reports/vehicle-spend", params=params)
    assert res.status_code == 200, res.text
    return res.json()


def stock_numbers(rows) -> set[str]:
    return {row["stock_number"] for row in rows if row["stock_number"]}


def backdate_arrival(db_path, stock_number: str, when: str) -> None:
    """Pretend the car was written into RECON earlier than this test ran.

    Same reason backdate_activity exists: every write moves these stamps to
    now, so a car that arrived two months ago can only be arranged by writing
    the column the app is reading.
    """
    with connect(db_path) as db:
        db.execute("UPDATE recon_vehicles SET created_at=? WHERE stock_number=?", (when, stock_number))
        db.commit()


def file_to_history(client, db_path, recon_id: int, stock_number: str, when: str | None = None) -> None:
    detail = client.get(f"/api/recon/vehicles/{recon_id}").json()
    res = client.post(f"/api/recon/vehicles/{recon_id}/archive", json={"expected_version": detail["edit_version"]})
    assert res.status_code == 200, res.text
    if when:
        with connect(db_path) as db:
            db.execute("UPDATE recon_vehicles SET archived_at=? WHERE stock_number=?", (when, stock_number))
            db.commit()


def car_with_spend(client, stock_number: str) -> dict:
    """A recon car with a part actually received on it, so it has real cost.

    Received rather than merely written up, because actual_cost is the number
    this report is read for and a part nobody has taken delivery of does not
    count towards it.
    """
    vendor = client.post("/api/vendors", json={"name": f"Vendor {stock_number}"}).json()
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [PART])
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={
            "item_ids": [estimate["items"][0]["id"]],
            "vendor_id": vendor["id"],
            "invoice_number": f"INV-{stock_number}",
        },
    )
    assert res.status_code == 200, res.text
    return vehicle


def test_a_car_still_on_the_lot_is_in_this_months_report_however_long_ago_it_arrived(client, db_path):
    """The one that made the report unusable: the Elantra case.

    A car written down in June, still in the shop, with money spent on it
    today. Asking about this month has to find it -- it is on the lot this
    month, whatever its record is stamped with.
    """
    car_with_spend(client, "R-JUNE")
    backdate_arrival(db_path, "R-JUNE", "2026-06-10T09:00:00")

    rows = spend(client, start="2026-08-01", end="2026-08-31")
    assert "R-JUNE" in stock_numbers(rows), "a car still on the lot fell out of this month's report"
    row = next(r for r in rows if r["stock_number"] == "R-JUNE")
    assert row["actual_cost"] == 120
    assert row["archived_at"] == "", "a car still on the lot must not be marked as filed away"


def test_a_sold_car_stays_on_the_report_for_the_window_it_was_here_for(client, db_path):
    """Filing a car to History is not the same as it never having cost
    anything. The money was spent; the report for that stretch has to say so."""
    vehicle = car_with_spend(client, "R-SOLD")
    backdate_arrival(db_path, "R-SOLD", "2026-06-10T09:00:00")
    file_to_history(client, db_path, vehicle["id"], "R-SOLD", when="2026-06-28T16:00:00")

    june = spend(client, start="2026-06-01", end="2026-06-30")
    assert "R-SOLD" in stock_numbers(june), "a sold car vanished from the report for the month it was here"
    row = next(r for r in june if r["stock_number"] == "R-SOLD")
    assert row["actual_cost"] == 120, "the money it cost went with it"
    assert row["archived_at"], "and the row has to say it is off the lot, not read as a car still waiting"

    assert "R-SOLD" in stock_numbers(spend(client)), "all-time left out a car the shop really did spend on"


def test_a_car_already_filed_away_is_not_in_a_later_window(client, db_path):
    """The other half of the same rule -- otherwise every car the shop has ever
    touched piles up on every report forever."""
    vehicle = car_with_spend(client, "R-GONE")
    backdate_arrival(db_path, "R-GONE", "2026-05-02T09:00:00")
    file_to_history(client, db_path, vehicle["id"], "R-GONE", when="2026-05-30T16:00:00")

    assert "R-GONE" not in stock_numbers(spend(client, start="2026-07-01", end="2026-07-31"))
    assert "R-GONE" in stock_numbers(spend(client, start="2026-05-01", end="2026-05-31"))


def test_a_car_that_arrives_after_the_window_is_not_in_it(client, db_path):
    """The end of the range still bites. A car bought in August is not part of
    what June cost."""
    car_with_spend(client, "R-LATER")
    backdate_arrival(db_path, "R-LATER", "2026-08-03T09:00:00")

    assert "R-LATER" not in stock_numbers(spend(client, start="2026-06-01", end="2026-06-30"))


def test_a_range_that_has_not_happened_yet_is_still_empty(client):
    """A live car has no end date, and "still here" must not be read as "here
    in 2099" -- that would put every car in the shop on a report about a year
    that hasn't started."""
    car_with_spend(client, "R-NOW")
    assert spend(client, start="2099-01-01") == []


def test_the_live_board_is_unchanged_by_any_of_this(client, db_path):
    """History is still History. The Vehicles screen and the Lot Status sheet
    read the same rows and must keep showing only what is actually on the lot."""
    here = car_with_spend(client, "R-HERE")
    gone = car_with_spend(client, "R-FILED")
    file_to_history(client, db_path, gone["id"], "R-FILED")
    assert here["id"] != gone["id"]

    board = stock_numbers(client.get("/api/vehicles-board").json())
    assert "R-HERE" in board and "R-FILED" not in board

    lot = stock_numbers(client.get("/api/reports/lot").json())
    assert "R-HERE" in lot and "R-FILED" not in lot, "a filed car came back onto the lot sheet"

    history = stock_numbers(client.get("/api/vehicles-board", params={"archived": True}).json())
    assert history == {"R-FILED"}


def test_we_owe_promises_follow_the_same_rule(client):
    """Both halves of the board are date-filtered by the same query, so a
    promise kept and filed away has to behave like a car sold and filed away."""
    promise = make_we_owe(client, customer_name="Renata Silva", description="Second key")
    detail = client.get(f"/api/we-owe/{promise['id']}").json()
    assert (
        client.post(
            f"/api/we-owe/{promise['id']}/archive", json={"expected_version": detail["edit_version"]}
        ).status_code
        == 200
    )

    rows = spend(client)
    kept = [r for r in rows if r["segment"] == "we_owe"]
    assert kept, "an archived we-owe promise is missing from the all-time spend report"
    assert kept[0]["archived_at"], "and it has to be marked as filed, not shown as an open promise"

    live = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    assert not live, "the archived promise came back onto the live board"


def test_the_csv_carries_the_same_rows_and_says_which_are_filed(client, db_path):
    """Walt gets the spreadsheet. It cannot quietly hold a different set of
    cars than the sheet it was downloaded from."""
    vehicle = car_with_spend(client, "R-CSV")
    backdate_arrival(db_path, "R-CSV", "2026-06-10T09:00:00")
    file_to_history(client, db_path, vehicle["id"], "R-CSV", when="2026-06-28T16:00:00")

    res = client.get("/api/export/report/vehicle-spend.csv", params={"start": "2026-06-01", "end": "2026-06-30"})
    assert res.status_code == 200
    lines = res.text.splitlines()
    header = lines[0].split(",")
    row = next(line for line in lines[1:] if line.startswith("R-CSV"))
    cells = row.split(",")
    assert cells[header.index("Cost")] == "120.00"
    assert cells[header.index("Filed To History")] == "2026-06-28"
