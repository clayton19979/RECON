"""The Customers screen has to know what the shop still owes people.

A we-owe promise is the shop's obligation to a customer, and it routinely
exists for weeks before anyone writes a repair order against it -- the
salesman promises a tie rod to close the deal, the car comes back later. The
customer list only ever counted repair orders, so the person the shop owed
work to read exactly like a stranger: no orders, never visited, "no repair
orders yet" under their car. That is the screen an advisor opens with the
customer on the phone asking about the promise.

These tests hold the two customer endpoints to answering that question.
"""

from __future__ import annotations

from tests.helpers import make_we_owe


def customer_row(client, customer_id: int) -> dict:
    rows = client.get("/api/customers").json()
    match = next((c for c in rows if c["id"] == customer_id), None)
    assert match is not None, f"customer {customer_id} missing from /api/customers"
    return match


def test_open_promise_shows_on_the_customer_list_without_a_ticket(client) -> None:
    """The case that was invisible: promised, no ticket written yet."""
    promise = make_we_owe(client, description="Replace worn tie rod")
    row = customer_row(client, promise["customer_id"])

    assert row["order_count"] == 0, "no ticket has been written, so the RO count is honestly zero"
    assert row["we_owe_open"] == 1, "the open promise has to be counted somewhere on this row"
    assert row["we_owe_count"] == 1


def test_a_settled_promise_stops_counting_as_owed(client) -> None:
    """Fulfilled and waived are both done -- the column is a hook list, not a
    history. The total stays, so "0 owed" and "never promised anything" read
    as the different answers they are."""
    promise = make_we_owe(client, description="Touch up the bumper")
    client.patch(f"/api/we-owe/{promise['id']}", json={"status": "fulfilled"})

    row = customer_row(client, promise["customer_id"])
    assert row["we_owe_open"] == 0
    assert row["we_owe_count"] == 1, "a kept promise still belongs to the customer's record"


def test_archiving_a_promise_takes_it_off_the_books(client) -> None:
    """History is not something still owed, and it isn't a settled promise
    sitting in the shop's record either -- both counts drop it."""
    promise = make_we_owe(client, description="Second key")
    client.post(f"/api/we-owe/{promise['id']}/archive")

    row = customer_row(client, promise["customer_id"])
    assert row["we_owe_open"] == 0
    assert row["we_owe_count"] == 0


def test_a_customer_with_no_promises_reads_as_zero_not_missing(client) -> None:
    """The screen renders these unconditionally; a missing key would print
    "undefined" in the We-Owe column of every ordinary customer."""
    customer = client.post("/api/customers", json={"name": "Walk-in Wanda"}).json()
    row = customer_row(client, customer["id"])
    assert row["we_owe_open"] == 0
    assert row["we_owe_count"] == 0


def test_customer_detail_hangs_promises_off_the_right_vehicle(client) -> None:
    """The expansion draws a chip per promise under the car it was made about,
    so a two-car household can't have one car's promise shown under the other."""
    promise = make_we_owe(client, description="Replace worn tie rod", target_date="2026-08-15")
    other = client.post(
        "/api/vehicles",
        json={"customer_id": promise["customer_id"], "year": 2012, "make": "Honda", "model": "Odyssey"},
    ).json()
    detail = client.get(f"/api/customers/{promise['customer_id']}").json()

    by_id = {v["id"]: v for v in detail["vehicles"]}
    owed = by_id[promise["vehicle_id"]]["we_owe"]
    assert len(owed) == 1, "the promised car carries the promise"
    assert owed[0]["description"] == "Replace worn tie rod"
    assert owed[0]["status"] == "open"
    assert owed[0]["target_date"] == "2026-08-15"
    assert owed[0]["order_count"] == 0, "nothing has been written against it yet"
    assert by_id[other["id"]]["we_owe"] == [], "the customer's other car is owed nothing"


def test_customer_detail_says_when_a_promise_already_has_a_ticket(client) -> None:
    """The "no ticket yet" nudge; once a ticket exists, saying it would be a lie."""
    promise = make_we_owe(client, description="Fix the clunk")
    started = client.post(
        "/api/orders", json={"concern": "Fix the clunk", "segment": "we_owe", "we_owe_id": promise["id"]}
    )
    assert started.status_code == 201, started.text

    detail = client.get(f"/api/customers/{promise['customer_id']}").json()
    owed = next(v for v in detail["vehicles"] if v["id"] == promise["vehicle_id"])["we_owe"]
    assert owed[0]["order_count"] == 1

    client.post(f"/api/orders/{started.json()['id']}/void", json={"reason": "wrong car"})
    detail = client.get(f"/api/customers/{promise['customer_id']}").json()
    owed = next(v for v in detail["vehicles"] if v["id"] == promise["vehicle_id"])["we_owe"]
    assert owed[0]["order_count"] == 0, "a voided ticket never happened -- the promise needs one again"


def test_archived_promises_stay_visible_in_the_detail(client) -> None:
    """Same contract the repair orders already have: History flags a record,
    it doesn't silently drop it."""
    promise = make_we_owe(client, description="Second key")
    client.post(f"/api/we-owe/{promise['id']}/archive")

    detail = client.get(f"/api/customers/{promise['customer_id']}").json()
    owed = next(v for v in detail["vehicles"] if v["id"] == promise["vehicle_id"])["we_owe"]
    assert len(owed) == 1, "an archived promise is still part of what was promised"
    assert owed[0]["archived_at"], "and it has to be flagged as archived, not shown as live"
