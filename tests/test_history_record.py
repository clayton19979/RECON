"""What a car's row says once the car has gone.

History is not a lot, it is a record of cars that are finished with, and the
one fact it has that the live board doesn't is the day the car left. Until
these fields existed that day appeared on no screen in the app -- the board
sent the same row for an archived car as for a live one, so History could only
re-say live-lot things about cars nobody can act on any more: which pile it is
in, how long nobody has touched it, how long ago it arrived (a number that
goes on climbing after the car has been sold).

`days_on_lot` is the pair to that date and the reason it is worth computing
here rather than in the browser: it is the answer to "how long does a car take
to get ready", which is a question about the shop rather than about any one
car, and the arithmetic has to match what the Lot Report would say.
"""

from __future__ import annotations

from app.recon import days_on_lot
from tests.helpers import make_recon_vehicle, make_we_owe


def history_row(client, stock_number):
    rows = client.get("/api/vehicles-board", params={"archived": True}).json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def test_a_live_car_has_no_archive_date_and_no_finished_stay(client):
    """The stay is deliberately unanswerable while the clock is still running.

    A car on day four of who knows how many would otherwise print "4 days" in
    the same column a finished car prints its whole stay in, which reads as a
    result and isn't one. age_days is the honest number until the car goes.
    """
    make_recon_vehicle(client, stock_number="R-LIVE")
    row = next(r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == "R-LIVE")
    assert row["archived_at"] == ""
    assert row["days_on_lot"] is None


def test_an_archived_recon_car_carries_the_day_it_left_and_how_long_it_was_here(client):
    vehicle = make_recon_vehicle(client, stock_number="R-GONE", acquisition_date="2026-01-01")
    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")

    row = history_row(client, "R-GONE")
    assert row["archived_at"], "an archived car came back with no date on it"
    # Counted from the day the car arrived on the lot, not the day somebody
    # typed it into RECON -- the same start the Age column uses.
    assert row["days_on_lot"] == days_on_lot("2026-01-01", row["archived_at"])
    assert row["days_on_lot"] > 0


def test_a_car_with_no_arrival_date_falls_back_to_when_it_was_written_up(client):
    """Arrival date is optional on the write-up form, and every car written
    down before it existed has none. The stay is still answerable -- it just
    counts from the record instead, exactly as lot_age_days already does."""
    vehicle = make_recon_vehicle(client, stock_number="R-NODATE", acquisition_date="")
    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")

    row = history_row(client, "R-NODATE")
    assert row["acquired_at"] == ""
    assert row["days_on_lot"] == 0, "a car written up and filed away today did not stay 0 days"


def test_an_archived_we_owe_counts_from_the_day_the_promise_was_made(client):
    """A we-owe has no arrival date and wants none: the car was sold weeks
    before the shop saw it. Its clock starts at the promise."""
    owed = make_we_owe(client, customer_name="Renata Silva", description="Tie rod")
    client.post(f"/api/we-owe/{owed['id']}/archive")

    rows = client.get("/api/vehicles-board", params={"archived": True}).json()
    row = next(r for r in rows if r["segment"] == "we_owe")
    assert row["archived_at"]
    assert row["days_on_lot"] == 0


def test_reopening_a_car_takes_its_archive_date_back_off(client):
    """Reopening is how a car filed away by mistake comes back, and it has to
    come back as a live car -- carrying a "left on the 4th" date onto the
    board would put a finished stay in the Age column of a car in the shop."""
    vehicle = make_recon_vehicle(client, stock_number="R-BACK")
    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")
    assert history_row(client, "R-BACK")["archived_at"]

    client.post(f"/api/recon/vehicles/{vehicle['id']}/reopen")
    row = next(r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == "R-BACK")
    assert row["archived_at"] == ""
    assert row["days_on_lot"] is None


def test_days_on_lot_refuses_to_answer_rather_than_guess():
    """None, not nought. A missing date at either end is "we don't know", and
    History shows that as a dash; a 0 would read as a car that came and went
    the same day, which is a thing that actually happens."""
    assert days_on_lot("2026-01-01", "2026-03-02T09:00:00") == 60
    assert days_on_lot("", "2026-03-02T09:00:00") is None
    assert days_on_lot("2026-01-01", "") is None
    assert days_on_lot("not a date", "2026-03-02T09:00:00") is None
    # An arrival date later than the archive stamp is a typed year, not a car
    # that left before it arrived. Floors at 0, the same way lot_age_days does.
    assert days_on_lot("2027-01-01", "2026-03-02T09:00:00") == 0
