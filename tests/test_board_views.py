"""Separate piles on the Vehicles board, and a finished we-owe landing
in the right one.

Two problems, both of which put a car under a heading that contradicts it.

**A finished we-owe stayed "In the shop".** Closing a we-owe is done on the
ticket, the same as any other job; the promise's own status field only moves
when somebody separately remembers to mark it fulfilled, which nobody does on
a busy morning. The pile was read off that field alone, so a car whose work
was done and ticket closed sat next to cars actually in a bay -- while the
status pill on the same row already read Complete. One row saying two things.

**A voided ticket looked like a car nobody had started.** Voiding is how a
ticket written by mistake is taken back, and the car left behind has no live
ticket at all -- which is exactly what a car genuinely waiting to be started
looks like. On one list there was no telling them apart.

The API's own default is unchanged on purpose: `/api/vehicles-board` with no
`view` still returns every live car, void ones included, which is what
tests/test_voided_tickets.py depends on to prove a mis-voided car cannot go
missing from the Stalled count.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe


def board(client, **params):
    return client.get("/api/vehicles-board", params=params).json()


def we_owe_row(client, we_owe_id, **params):
    return next(r for r in board(client, **params) if r.get("we_owe_id") == we_owe_id)


def make_we_owe_order(client, we_owe_id, concern="Replace mirror"):
    res = client.post("/api/orders", json={"concern": concern, "segment": "we_owe", "we_owe_id": we_owe_id})
    assert res.status_code == 201, res.text
    return res.json()


def complete(client, order_id):
    res = client.patch(f"/api/orders/{order_id}/status", json={"status": "complete"})
    assert res.status_code == 200, res.text


def void(client, order_id):
    res = client.post(f"/api/orders/{order_id}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text


# --- a we-owe whose work is done ------------------------------------------


def test_closing_the_ticket_moves_a_we_owe_out_of_the_shop(client):
    """The reported bug. The advisor closed the ticket and the car stayed in
    the In The Shop column, because the promise's own status was never
    separately touched."""
    promise = make_we_owe(client, customer_name="Renata Silva", description="Replace mirror")
    order = make_we_owe_order(client, promise["id"])
    # The car actually goes into a bay first, which is what puts it in the
    # column it then got stuck in.
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    assert res.status_code == 200, res.text

    row = we_owe_row(client, promise["id"])
    assert row["lot_bucket"] == "working", "precondition: a ticket in progress means the car is being worked on"

    complete(client, order["id"])
    row = we_owe_row(client, promise["id"])
    assert row["status_bucket"] == "finished", "the ticket is closed and the promise still reads as in progress"
    assert row["lot_bucket"] == "ready", f"a finished we-owe is still filed under {row['lot_bucket']}"


def test_the_detail_page_agrees_with_the_board_about_a_finished_we_owe(client):
    """Two views of one promise; if they disagree, one of them is lying."""
    promise = make_we_owe(client, customer_name="Marcus Doyle", description="Tie rod")
    order = make_we_owe_order(client, promise["id"])
    complete(client, order["id"])

    detail = client.get(f"/api/we-owe/{promise['id']}").json()
    assert detail["status_bucket"] == we_owe_row(client, promise["id"])["status_bucket"] == "finished"


def test_an_unfinished_ticket_keeps_the_promise_in_the_shop(client):
    promise = make_we_owe(client, customer_name="Iris Chandler", description="Seat belt")
    make_we_owe_order(client, promise["id"])
    assert we_owe_row(client, promise["id"])["status_bucket"] == "in_progress"


def test_a_promise_with_no_ticket_has_not_finished_anything(client):
    """It has not started, which is not the same as being done -- exactly the
    rule recon already follows."""
    promise = make_we_owe(client, customer_name="Tyrell Banks", description="Mirror")
    assert we_owe_row(client, promise["id"])["status_bucket"] == "in_progress"


def test_waiving_still_closes_a_promise_with_no_ticket(client):
    """The advisor's own word for it has to keep standing alone: a waived
    promise is settled with no work done and often no ticket at all."""
    promise = make_we_owe(client, customer_name="Ashley Pratt", description="Waived thing")
    client.patch(f"/api/we-owe/{promise['id']}", json={"status": "waived"})
    assert we_owe_row(client, promise["id"])["status_bucket"] == "finished"


def test_a_voided_ticket_does_not_finish_a_promise(client):
    """Voiding a we-owe's only ticket is certainly not keeping the promise."""
    promise = make_we_owe(client, customer_name="Priscilla Wong", description="Clunk")
    order = make_we_owe_order(client, promise["id"])
    void(client, order["id"])
    assert we_owe_row(client, promise["id"])["status_bucket"] == "in_progress"


# --- the three views -------------------------------------------------------


def test_a_car_with_only_a_voided_ticket_is_off_the_active_board(client):
    recon = make_recon_vehicle(client, stock_number="R-VOIDVIEW")
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    active = [r["stock_number"] for r in board(client, view="active")]
    voided = [r["stock_number"] for r in board(client, view="void")]
    assert "R-VOIDVIEW" not in active, "a taken-back ticket is sitting in with the live work"
    assert "R-VOIDVIEW" in voided


def test_a_live_ticket_alongside_a_voided_one_stays_active(client):
    """The live ticket is what the car is doing; the voided one beside it is
    just history, and must not pull the car off the board."""
    recon = make_recon_vehicle(client, stock_number="R-BOTH")
    mistake = make_recon_order(client, recon["id"])
    void(client, mistake["id"])
    make_recon_order(client, recon["id"], concern="The real one")

    assert "R-BOTH" in [r["stock_number"] for r in board(client, view="active")]
    assert "R-BOTH" not in [r["stock_number"] for r in board(client, view="void")]


def test_a_car_with_no_ticket_at_all_is_active_not_void(client):
    """Nothing has been taken back here -- this car simply has not been
    written up yet, and it is the live board's job to say so."""
    make_recon_vehicle(client, stock_number="R-FRESH")
    assert "R-FRESH" in [r["stock_number"] for r in board(client, view="active")]
    assert "R-FRESH" not in [r["stock_number"] for r in board(client, view="void")]


def test_history_is_its_own_view_and_holds_only_archived_cars(client):
    live = make_recon_vehicle(client, stock_number="R-LIVE2")
    gone = make_recon_vehicle(client, stock_number="R-GONE")
    client.post(f"/api/recon/vehicles/{gone['id']}/archive")

    history = [r["stock_number"] for r in board(client, view="history")]
    assert history == ["R-GONE"]
    assert "R-LIVE2" in [r["stock_number"] for r in board(client, view="active")]
    assert live["id"]


def test_the_void_view_does_not_reach_into_history(client):
    """A car that was filed away is in History, whatever its tickets say --
    otherwise the same car is in two piles at once."""
    recon = make_recon_vehicle(client, stock_number="R-VOIDGONE")
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])
    client.post(f"/api/recon/vehicles/{recon['id']}/archive")

    assert "R-VOIDGONE" not in [r["stock_number"] for r in board(client, view="void")]
    assert "R-VOIDGONE" in [r["stock_number"] for r in board(client, view="history")]


def test_asking_for_no_view_still_returns_every_live_car(client):
    """The default is deliberately unchanged. test_voided_tickets.py proves a
    mis-voided car still reads as unstarted and still trips the Stalled count,
    and it asks this endpoint the plain way to do it -- so the plain way has
    to keep answering with the whole live board."""
    recon = make_recon_vehicle(client, stock_number="R-DEFAULT")
    order = make_recon_order(client, recon["id"])
    void(client, order["id"])

    assert "R-DEFAULT" in [r["stock_number"] for r in board(client)]
    assert "R-DEFAULT" in [r["stock_number"] for r in board(client, view="all")]


def test_the_segment_chips_still_work_inside_a_view(client):
    """Which kind of work and which pile are two different questions, and the
    screen asks both at once."""
    make_recon_vehicle(client, stock_number="R-SEG")
    make_we_owe(client, customer_name="Jordan Whitfield", description="Mirror")

    recon_only = board(client, view="active", segment="recon")
    assert {r["segment"] for r in recon_only} == {"recon"}
    we_owe_only = board(client, view="active", segment="we_owe")
    assert {r["segment"] for r in we_owe_only} == {"we_owe"}


def test_a_settled_promise_gets_its_own_pile_on_the_board(client):
    """The board and the Lot Report read one rule (app/recon.py::lot_bucket),
    so a promise the advisor has marked fulfilled has to be out of the "Ready
    to go" column here too -- otherwise the column Clayton looks at all day
    and the sheet Walt is handed give different answers about the same car."""
    promise = make_we_owe(client, customer_name="Marcus Doyle", description="Tie rod")
    assert we_owe_row(client, promise["id"])["lot_bucket"] == "waiting"

    res = client.patch(f"/api/we-owe/{promise['id']}", json={"status": "fulfilled"})
    assert res.status_code == 200, res.text

    row = we_owe_row(client, promise["id"])
    assert row["status_bucket"] == "finished"
    assert row["lot_bucket"] == "settled", f"a settled promise is filed under {row['lot_bucket']}"
    assert row["needs"] == "Fulfilled — send to History", row["needs"]


# --- the colour on file rides the board row -------------------------------


def test_board_rows_carry_the_color_on_file(client):
    """The colour is how a car is pointed at across the lot ("the white
    Sorento"), so the board row has to carry it -- the card's identity line
    and the search box both read it off the row."""
    recon = make_recon_vehicle(client, color="Pearl White")
    row = next(r for r in board(client) if r.get("recon_id") == recon["id"])
    assert row["color"] == "Pearl White"


def test_a_we_owe_row_carries_its_vehicles_color(client):
    customer = client.post("/api/customers", json={"name": "Renata Silva"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2019, "make": "Toyota", "model": "RAV4", "color": "Blue"},
    ).json()
    res = client.post(
        "/api/we-owe",
        json={"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": "Touch up paint"},
    )
    assert res.status_code == 201, res.text
    assert we_owe_row(client, res.json()["id"])["color"] == "Blue"


def test_a_car_with_no_color_on_file_carries_an_empty_one(client):
    """Empty, not null -- the frontend joins identity fragments with
    filter(Boolean), and a None would read "None" on the card."""
    recon = make_recon_vehicle(client)
    row = next(r for r in board(client) if r.get("recon_id") == recon["id"])
    assert row["color"] == ""
