"""Naming the work on the "what does this car still need" line.

Walt's third question is what each remaining car still needs, and the sheet's
answer to it could only ever be as specific as the ticket had been split up.
A ticket carved into named jobs said "Windshield, Front + rear brakes (1 of 3
done)"; a ticket that was one concern and a few part lines -- which is most of
them -- said nothing at all about the work and fell back to money: "$95.00 of
work left · 1 part on order". Two cars needing completely different things
read identically.

Worse on the we-owe side, where the promise is written down the day the
salesman makes it and the repair order often follows days later. Until then
the row read "6 days past the promised date · no ticket written yet" about a
car whose entire reason for being here was one field away.

So the sentence now falls back to the shop's own wording: the ticket's
concern, or the promise behind a we-owe when no ticket has been written. See
app/recon.py::open_work_text.
"""

from __future__ import annotations

from app.recon import NEEDS_WORK_CHARS
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate

PART = {
    "kind": "part",
    "description": "Alternator",
    "part_number": "ALT-1",
    "quantity": 1,
    "unit_price": 120,
    "unit_cost": 120,
}


def lot(client) -> list[dict]:
    res = client.get("/api/reports/lot")
    assert res.status_code == 200, res.text
    return res.json()


def recon_row(client, stock: str) -> dict:
    match = [r for r in lot(client) if r["stock_number"] == stock]
    assert len(match) == 1, f"expected exactly one row for {stock}"
    return match[0]


def we_owe_row(client, we_owe_id: int) -> dict:
    match = [r for r in lot(client) if r["we_owe_id"] == we_owe_id]
    assert len(match) == 1, f"expected exactly one row for we-owe {we_owe_id}"
    return match[0]


def test_a_ticket_with_no_named_jobs_still_says_what_the_car_is_in_for(client):
    """The everyday recon ticket: one concern, a couple of part lines, nobody
    split it into jobs. Before this the row could only quote the money."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK1", purchase_price=0)
    order = make_recon_order(client, vehicle["id"], concern="Front end recon prep")
    save_estimate(client, order["id"], [PART])

    needs = recon_row(client, "R-WORK1")["needs"]
    assert "Front end recon prep" in needs, needs


def test_named_jobs_still_win_over_the_ticket_wording(client):
    """A ticket that has been carved into repairs knows which of them are
    still outstanding, which the concern cannot. Naming both would say the
    same thing twice in one cell."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK2", purchase_price=0)
    order = make_recon_order(client, vehicle["id"], concern="Front end recon prep")
    assert client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Windshield"}).status_code == 201
    save_estimate(client, order["id"], [PART])

    needs = recon_row(client, "R-WORK2")["needs"]
    assert "Windshield" in needs, needs
    assert "Front end recon prep" not in needs, needs


def test_a_promise_with_no_ticket_yet_still_names_itself(client):
    """The reason this exists. A promise is written down the day it is made;
    the repair order can be days behind it."""
    promise = make_we_owe(client, description="Touch up paint on rear bumper")

    needs = we_owe_row(client, promise["id"])["needs"]
    assert "Touch up paint on rear bumper" in needs, needs
    assert "no ticket written yet" in needs.lower(), needs


def test_a_promise_with_a_ticket_reads_the_ticket(client):
    """Once somebody writes the car up, the ticket is the more current
    account of the work -- the promise is what was said at the sale."""
    promise = make_we_owe(client, description="Customer says there is a clunk")
    res = client.post(
        "/api/orders",
        json={"concern": "Replace outer tie rod end", "segment": "we_owe", "we_owe_id": promise["id"]},
    )
    assert res.status_code == 201, res.text

    needs = we_owe_row(client, promise["id"])["needs"]
    assert "Replace outer tie rod end" in needs, needs
    assert "clunk" not in needs, needs


def test_a_long_write_up_is_shortened_rather_than_filling_the_row(client):
    """This cell sits beside the money and the idle days on a printed sheet.
    A paragraph in it pushes both off the page."""
    long_concern = "Replace both front struts and mounts, align, then road test for the rattle over bumps"
    vehicle = make_recon_vehicle(client, stock_number="R-WORK3", purchase_price=0)
    make_recon_order(client, vehicle["id"], concern=long_concern)

    needs = recon_row(client, "R-WORK3")["needs"]
    assert "Replace both front struts" in needs, needs
    assert long_concern not in needs, "the whole paragraph landed on the row"
    assert "…" in needs, needs
    quoted = next(clause for clause in needs.split(" · ") if clause.startswith("Replace"))
    assert len(quoted) <= NEEDS_WORK_CHARS + 1, quoted
    assert long_concern.startswith(quoted.rstrip("…")), f"the shortened wording is not the ticket's: {quoted}"
    assert long_concern[len(quoted.rstrip("…"))] == " ", f"cut mid-word rather than on a word: {quoted}"


def test_a_write_up_typed_over_several_lines_stays_on_one(client):
    """The concern box takes newlines. A table cell does not want them."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK4", purchase_price=0)
    make_recon_order(client, vehicle["id"], concern="Oil change\nand  rotate tires")

    needs = recon_row(client, "R-WORK4")["needs"]
    assert "\n" not in needs, repr(needs)
    assert "Oil change and rotate tires" in needs, needs


def test_a_finished_car_is_not_told_what_it_came_in_for(client):
    """Nothing — ready to go is the whole answer. Repeating the work the shop
    has already done reads as work still owed."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK5", purchase_price=0)
    order = make_recon_order(client, vehicle["id"], concern="Front end recon prep")
    assert (
        client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete", "actor": "tester"}).status_code
        == 200
    )

    assert recon_row(client, "R-WORK5")["needs"] == "Nothing — ready to go"


def test_a_voided_ticket_does_not_speak_for_the_car(client):
    """Voiding says the work never happened. Its wording must go with it, or
    a car needing a fresh ticket reads as one already being worked."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK6", purchase_price=0)
    order = make_recon_order(client, vehicle["id"], concern="Front end recon prep")
    assert client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"}).status_code == 200

    needs = recon_row(client, "R-WORK6")["needs"]
    assert "Front end recon prep" not in needs, needs
    assert "voided" in needs.lower(), needs


def test_the_board_row_carries_the_ticket_wording(client):
    """The sentence is assembled from the finished board row, so the wording
    it falls back to has to reach the row -- and reaching the row means the
    Vehicles screen gets it too."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK7", purchase_price=0)
    make_recon_order(client, vehicle["id"], concern="Front end recon prep")

    rows = client.get("/api/vehicles-board?view=active").json()
    row = next(r for r in rows if r["stock_number"] == "R-WORK7")
    assert row["concern"] == "Front end recon prep", row["concern"]


def test_a_car_with_no_ticket_at_all_claims_no_work(client):
    """Nothing has been written down, so there is nothing to quote. The row
    must not invent one."""
    make_recon_vehicle(client, stock_number="R-WORK8", purchase_price=0)

    row = recon_row(client, "R-WORK8")
    assert row["concern"] == ""
    assert row["needs"].lower().startswith("no ticket written yet"), row["needs"]


def test_the_printed_sheet_and_the_csv_say_the_same_thing(client):
    """Three renderings of one sentence, built on the server for exactly this
    reason -- Walt reads whichever is in front of him."""
    vehicle = make_recon_vehicle(client, stock_number="R-WORK9", purchase_price=0)
    make_recon_order(client, vehicle["id"], concern="Front end recon prep")

    needs = recon_row(client, "R-WORK9")["needs"]
    csv = client.get("/api/export/report/lot.csv")
    assert csv.status_code == 200, csv.text
    line = next(row for row in csv.text.splitlines() if "R-WORK9" in row)
    assert needs in line, f"{needs!r} not in {line!r}"
