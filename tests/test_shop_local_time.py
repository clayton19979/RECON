"""Records are stamped on the shop's clock, so the shop's reports find them.

Every date filter in the UI is a local calendar date -- a date picker, or a
"This Month" chip. Timestamps used to be stored in UTC, and Indiana runs five
hours behind, so anything written down in the evening was stamped with the next
day's date: a car added at 8pm Tuesday was missing from Tuesday's numbers, and
a car added the evening of the 31st landed in the following month's report.
The shop works evenings, so that was the normal case.

These tests fail if anyone switches the stamp back to UTC. They are written
against the boundary that actually broke rather than against a fixed clock,
because a test that only checks the format would have passed the whole time.
"""

from __future__ import annotations

from datetime import datetime

from app.db import now
from app.recon import age_days
from tests.helpers import make_recon_vehicle


def test_now_is_the_shops_wall_clock():
    """The date on a new record has to match the date on the wall, because
    that is the date the advisor will filter by."""
    stamped = now()
    today = datetime.now().date().isoformat()
    assert stamped.startswith(today), f"a record stamped {stamped} on {today} is on the wrong clock"
    assert "+" not in stamped and not stamped.endswith("Z"), f"{stamped} carries an offset; filters are local dates"


def test_a_car_added_now_falls_inside_todays_report_range(client):
    """The regression itself, at the API level: create a car, then ask for the
    report the way the UI does -- start and end both today's local date."""
    today = datetime.now().date().isoformat()
    recon = make_recon_vehicle(client, stock_number="R-TODAY", purchase_price=0)
    assert recon["created_at"].startswith(today), recon["created_at"]

    rows = client.get(f"/api/reports/vehicle-profit?start={today}&end={today}").json()
    assert any(r["stock_number"] == "R-TODAY" for r in rows), (
        f"a car added today is missing from today's report ({len(rows)} rows) -- "
        "this is the UTC-stamp bug: after 7pm local the stamp reads tomorrow"
    )


def test_a_car_added_now_is_zero_days_old(client):
    """age_days drives the board's Age column and the stalled-car logic. A car
    entered this evening must not read as a day old."""
    recon = make_recon_vehicle(client, stock_number="R-AGE", purchase_price=0)
    assert age_days(recon["created_at"]) == 0, f"a car created at {recon['created_at']} is not a day old yet"


def test_age_days_still_reads_legacy_utc_rows_correctly():
    """Rows written before the switch carry a +00:00 offset. Treating one as
    local would age it by the offset -- five hours, which crosses a day
    boundary often enough to matter on the Age column."""
    utc_stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    assert "+" in utc_stamp or "-" in utc_stamp[10:], "expected an offset-carrying stamp for this test"
    assert age_days(utc_stamp) == 0, f"an offset-carrying stamp for right now aged to {age_days(utc_stamp)} days"
