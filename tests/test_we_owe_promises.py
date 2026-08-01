"""A we-owe's promised date, from the field it's typed into to the board.

A we-owe is something a salesman told a customer they'd get to close a car
deal, and the date they were given is the only part of it with a deadline.
The app asked for that date at intake, stored it, and then showed it on no
screen anyone makes a decision on -- so the only way to find out a promise had
gone past its date was to already remember the car and open it.

These tests pin the two halves of fixing that: the arithmetic (which promises
count as late, and which deliberately never do), and the fact that the number
actually reaches the vehicle board and the lot sheet.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.recon import promise_days_late
from app.reports import lot_rows
from tests.helpers import make_recon_vehicle, make_we_owe


def day(offset: int) -> str:
    """A calendar date `offset` days from today, on the shop's own clock."""
    return (date.today() + timedelta(days=offset)).isoformat()


def board(client, **params):
    res = client.get("/api/vehicles-board", params=params)
    assert res.status_code == 200, res.text
    return res.json()


def we_owe_row(client, we_owe_id: int) -> dict:
    row = next(r for r in board(client) if r["we_owe_id"] == we_owe_id)
    return row


# --- the arithmetic ---------------------------------------------------------


def test_a_promise_past_its_date_counts_the_days() -> None:
    assert promise_days_late(day(-3), "in_progress") == 3


def test_a_promise_due_today_is_zero_not_late() -> None:
    """Zero has to be its own answer. Folding "due today" in with "late" puts
    a promise on the alarm list on the morning it's still fine to do."""
    assert promise_days_late(day(0), "in_progress") == 0


def test_a_promise_still_to_come_counts_down() -> None:
    assert promise_days_late(day(4), "in_progress") == -4


def test_a_promise_with_no_date_asks_nothing() -> None:
    assert promise_days_late("", "in_progress") is None
    assert promise_days_late(None, "in_progress") is None


def test_an_unreadable_date_does_not_blow_up_the_board() -> None:
    """Same tolerance age_days has: one hand-edited row must not take out the
    whole list, because every other vehicle's number is computed in the same
    loop."""
    assert promise_days_late("last tuesday", "in_progress") is None
    assert promise_days_late("2026-13-45", "in_progress") is None


def test_a_settled_promise_is_never_late() -> None:
    """The judgement is_stalled makes about finished cars, applied here. A
    fulfilled or waived promise is closed, its date never moves again, and
    counting it would give a number that only ever climbs."""
    assert promise_days_late(day(-400), "finished") is None


# --- reaching the board -----------------------------------------------------


def test_the_board_carries_the_promised_date(client) -> None:
    item = make_we_owe(client, description="Second key fob", target_date=day(-2))
    row = we_owe_row(client, item["id"])
    assert row["target_date"] == day(-2)
    assert row["promise_days_late"] == 2


def test_recon_vehicles_have_no_promise_to_be_late_on(client) -> None:
    """A lot car was never promised to anybody, so the field is absent rather
    than a zero the board would have to special-case as "on time"."""
    make_recon_vehicle(client)
    recon = next(r for r in board(client) if r["segment"] == "recon")
    assert "promise_days_late" not in recon


def test_fulfilling_a_promise_takes_it_off_the_late_list(client) -> None:
    """The number has to come down as work gets done. This is the whole
    difference between an alarm and a tally."""
    item = make_we_owe(client, description="Touch up bumper", target_date=day(-9))
    assert we_owe_row(client, item["id"])["promise_days_late"] == 9

    assert client.patch(f"/api/we-owe/{item['id']}", json={"status": "fulfilled"}).status_code == 200
    row = we_owe_row(client, item["id"])
    assert row["promise_days_late"] is None
    assert row["target_date"] == day(-9), "the date itself is history and stays readable"


def test_waiving_a_promise_also_clears_it(client) -> None:
    item = make_we_owe(client, description="Repair dent", target_date=day(-30))
    assert client.patch(f"/api/we-owe/{item['id']}", json={"status": "waived"}).status_code == 200
    assert we_owe_row(client, item["id"])["promise_days_late"] is None


def test_moving_the_promised_date_moves_the_count(client) -> None:
    """Re-promising a customer a later day is a normal thing to do at the
    counter, and the board has to follow it."""
    item = make_we_owe(client, description="Running boards", target_date=day(-5))
    assert we_owe_row(client, item["id"])["promise_days_late"] == 5

    assert client.patch(f"/api/we-owe/{item['id']}", json={"target_date": day(3)}).status_code == 200
    assert we_owe_row(client, item["id"])["promise_days_late"] == -3


# --- reaching the lot sheet -------------------------------------------------


def needs_for(db_path, we_owe_id: int) -> str:
    from app.db import connect

    with connect(db_path) as db:
        row = next(r for r in lot_rows(db) if r["we_owe_id"] == we_owe_id)
    return row["needs"]


def test_the_lot_sheet_leads_with_a_broken_promise(client, db_path) -> None:
    """Walt reads this sheet to find out what each car still needs. A part on
    order is the shop's own business; a date the customer was given and missed
    is a person waiting, so it goes first in the sentence."""
    item = make_we_owe(client, description="Second key fob", target_date=day(-1))
    needs = needs_for(db_path, item["id"])
    assert needs.startswith("1 day past the promised date"), needs


def test_the_lot_sheet_pluralises_the_days(client, db_path) -> None:
    item = make_we_owe(client, description="Second key fob", target_date=day(-4))
    assert needs_for(db_path, item["id"]).startswith("4 days past the promised date")


def test_the_lot_sheet_says_today_on_the_day(client, db_path) -> None:
    item = make_we_owe(client, description="Second key fob", target_date=day(0))
    assert needs_for(db_path, item["id"]).startswith("Promised to the customer today")


def test_the_lot_sheet_stays_quiet_about_a_promise_still_in_hand(client, db_path) -> None:
    """A date three days out is not news. Saying so on every row would bury
    the rows where the date has actually gone by."""
    item = make_we_owe(client, description="Second key fob", target_date=day(3))
    assert "promised" not in needs_for(db_path, item["id"]).lower()
