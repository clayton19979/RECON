"""A vendor's parts bill lands on the car it belongs to, even when the job is
already finished.

That is the normal shape of a parts purchase here, not an edge case. A used
alternator gets fetched from the yard, fitted, and the ticket is closed the
same afternoon; the vendor's invoice turns up days later. The app already
knows it -- the Missing Receipts desk exists to list exactly those parts, and
the board prints "Ready to go -- but 1 part never marked received" on the car.

Two screens can write that receipt, and they used to disagree about which
tickets would take one. The car's own screen (Receive Selected) allowed a
finished ticket. The A/P screen (Post a Vendor Invoice) refused every one of
them, on a status whitelist that let only estimate / pending approval / in
progress through -- so the invoice was held in the Control Log with no way to
release it, and the only route through was to reopen the ticket, post, and
close it again, which puts the car back on the board mid-morning for everyone
else looking at it.

The whitelist also caught the genuinely-blocked cases only by accident: a
voided ticket is stored as complete, so it fell out on status rather than on
being voided.

These tests pin down the one rule both screens now share
(`workflow.parts_bill_block_reason`), the three tickets that really cannot
take a parts bill, and the flag the A/P ticket picker reads so it can offer
finished tickets without offering ones the post would refuse.
"""

from __future__ import annotations

from app.db import connect
from app.workflow import parts_bill_block_reason
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    save_estimate,
)

PART = {
    "kind": "part",
    "description": "Alternator (used)",
    "part_number": "ALT-88",
    "quantity": 1,
    "unit_price": 120,
    "unit_cost": 120,
}


def vendor(client, name="NAPA Merrillville"):
    return client.post("/api/vendors", json={"name": name}).json()


def post_bill(client, order_id, invoice_number="INV-LATE-1", unit_cost=120.0, part_number="ALT-88"):
    """The A/P screen's Post a Vendor Invoice, with a ticket explicitly picked."""
    return client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "NAPA Merrillville",
            "invoice_number": invoice_number,
            "po_number": "",
            "order_id": order_id,
            "subtotal": unit_cost,
            "tax": 0,
            "total": unit_cost,
            "items": [
                {
                    "part_number": part_number,
                    "description": "Alternator (used)",
                    "quantity": 1,
                    "unit_cost": unit_cost,
                    "kind": "part",
                }
            ],
            "source": "ui",
        },
    )


def finished_recon_ticket(client, stock_number="R-7001", items=None):
    """Parts fitted, ticket closed, nobody receipted the lines."""
    car = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, car["id"])
    estimate = save_estimate(client, order["id"], items or [dict(PART)])
    assert client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"}).status_code == 200
    return car, order, estimate


def board_row(client, stock_number):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["stock_number"] == stock_number)


def order_flag(client, order_id):
    return next(o for o in client.get("/api/orders").json() if o["id"] == order_id)["accepts_parts_bill"]


# ---------------------------------------------------------------------------
# The bill that arrives after the job is done
# ---------------------------------------------------------------------------


def test_a_bill_posts_against_a_finished_ticket(client):
    """The whole point. Before this, the same post came back held for review
    with "has status 'complete' and cannot receive parts", and the money never
    reached the car."""
    vendor(client)
    _, order, _ = finished_recon_ticket(client, stock_number="R-7001")

    body = post_bill(client, order["id"]).json()

    assert body["status"] == "posted", body["issues"]
    assert body["order_id"] == order["id"]
    assert board_row(client, "R-7001")["actual_cost"] == 120


def test_the_late_bill_settles_the_part_the_car_was_warning_about(client):
    """The desk and the car's own row exist to point at this money. Posting
    the bill has to be what clears them, or the warning is decoration."""
    vendor(client)
    _, order, _ = finished_recon_ticket(client, stock_number="R-7002")
    assert board_row(client, "R-7002")["unreceived_closed_parts"] == 1
    assert len(client.get("/api/parts/missing-receipts").json()) == 1

    body = post_bill(client, order["id"], invoice_number="INV-LATE-2").json()
    assert body["status"] == "posted", body["issues"]

    row = board_row(client, "R-7002")
    assert row["unreceived_closed_parts"] == 0
    assert row["unreceived_closed_cost"] == 0
    assert row["actual_cost"] == 120
    assert client.get("/api/parts/missing-receipts").json() == []


def test_a_finished_ticket_stays_finished_after_the_bill_lands(client):
    """Receiving a part is not work on the car. The old workaround was to
    reopen the ticket to get the bill in, which put a sold car back on the
    board for everybody else; nothing here may do that by itself."""
    vendor(client)
    _, order, _ = finished_recon_ticket(client, stock_number="R-7003")

    post_bill(client, order["id"], invoice_number="INV-LATE-3")

    assert client.get(f"/api/orders/{order['id']}").json()["status"] == "complete"
    assert board_row(client, "R-7003")["status_bucket"] == "finished"


# ---------------------------------------------------------------------------
# The three tickets that genuinely cannot take one
# ---------------------------------------------------------------------------


def test_a_voided_ticket_is_refused_for_being_voided(client):
    """It used to be refused for being 'complete', which is only where a void
    happens to be stored. Widening the status rule without naming the real
    boundary would have let a bill post against a cancelled job."""
    vendor(client)
    _, order, _ = finished_recon_ticket(client, stock_number="R-7004")
    assert client.post(f"/api/orders/{order['id']}/void", json={"actor": "Clay"}).status_code == 200

    body = post_bill(client, order["id"], invoice_number="INV-LATE-4").json()

    assert body["status"] == "review_required"
    assert body["issues"] == [f"Repair order {order['number']} was voided, so nothing can be received against it"]
    assert order_flag(client, order["id"]) is False


def test_a_car_filed_to_history_is_refused_and_told_how_to_fix_it(client):
    vendor(client)
    car, order, _ = finished_recon_ticket(client, stock_number="R-7005")
    assert client.post(f"/api/recon/vehicles/{car['id']}/archive", json={}).status_code == 200

    body = post_bill(client, order["id"], invoice_number="INV-LATE-5").json()

    assert body["status"] == "review_required"
    assert "History" in body["issues"][0] and "reopen" in body["issues"][0]
    assert order_flag(client, order["id"]) is False

    # Reopening is the documented way back, and it has to actually work.
    assert client.post(f"/api/recon/vehicles/{car['id']}/reopen", json={}).status_code == 200
    assert order_flag(client, order["id"]) is True
    assert post_bill(client, order["id"], invoice_number="INV-LATE-5B").json()["status"] == "posted"


def test_a_ticket_already_billed_to_the_customer_is_refused(client):
    """Retail only, and deliberate: receiving overwrites the line's cost, and
    those lines are what the customer's invoice was totalled from."""
    vendor(client)
    order = make_retail_order(client)
    save_estimate(client, order["id"], [dict(PART)])
    client.post(
        f"/api/orders/{order['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    assert client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "t"}).status_code == 201

    body = post_bill(client, order["id"], invoice_number="INV-LATE-6").json()

    assert body["status"] == "review_required"
    assert "billed to the customer" in body["issues"][0]
    assert order_flag(client, order["id"]) is False


# ---------------------------------------------------------------------------
# One rule, read two ways
# ---------------------------------------------------------------------------


def test_the_car_screen_and_the_ap_screen_refuse_the_same_tickets(client, db_path):
    """Receive Selected and Post a Vendor Invoice are two doors into the same
    act. This is the test that stops them drifting apart again: whatever the
    A/P screen holds an invoice for, the car's screen must refuse with the
    same sentence, and vice versa."""
    supplier = vendor(client)
    cases = {}

    _, open_order, open_estimate = finished_recon_ticket(client, stock_number="R-7010")
    client.patch(f"/api/orders/{open_order['id']}/status", json={"status": "in_progress"})
    cases["open"] = (open_order, open_estimate)

    _, done_order, done_estimate = finished_recon_ticket(client, stock_number="R-7011")
    cases["finished"] = (done_order, done_estimate)

    _, void_order, void_estimate = finished_recon_ticket(client, stock_number="R-7012")
    client.post(f"/api/orders/{void_order['id']}/void", json={"actor": "Clay"})
    cases["voided"] = (void_order, void_estimate)

    filed_car, filed_order, filed_estimate = finished_recon_ticket(client, stock_number="R-7013")
    client.post(f"/api/recon/vehicles/{filed_car['id']}/archive", json={})
    cases["history"] = (filed_order, filed_estimate)

    billed_order = make_retail_order(client)
    billed_estimate = save_estimate(client, billed_order["id"], [dict(PART)])
    client.post(
        f"/api/orders/{billed_order['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    client.post(f"/api/orders/{billed_order['id']}/invoice", json={"actor": "t"})
    cases["billed out"] = (billed_order, billed_estimate)

    for label, (order, estimate) in cases.items():
        with connect(db_path) as db:
            row = db.execute("SELECT * FROM orders WHERE id=?", (order["id"],)).fetchone()
            reason = parts_bill_block_reason(db, row)

        # A part number the ticket has never seen, so the A/P post lands as a
        # line of its own and cannot fully receive the line the car screen is
        # about to ask for -- the two doors have to be measured independently.
        ap = post_bill(
            client, order["id"], invoice_number=f"INV-PAIR-{order['id']}", part_number=f"LATE-{order['id']}"
        ).json()
        car_screen = client.post(
            f"/api/orders/{order['id']}/estimate/receive-parts",
            json={
                "item_ids": [estimate["items"][0]["id"]],
                "vendor_id": supplier["id"],
                "invoice_number": f"INV-CAR-{order['id']}",
            },
        )

        if reason is None:
            assert ap["status"] == "posted", f"{label}: A/P held a bill the rule allows -- {ap['issues']}"
            assert car_screen.status_code == 200, f"{label}: the car screen refused one the rule allows"
        else:
            assert ap["status"] == "review_required", f"{label}: A/P posted a bill the rule blocks"
            assert ap["issues"] == [reason], f"{label}: A/P gave a different reason -- {ap['issues']}"
            assert car_screen.status_code == 409, f"{label}: the car screen took one the rule blocks"
            assert car_screen.json()["detail"] == reason, f"{label}: the car screen gave a different reason"

        # And the flag the ticket picker reads has to say the same thing.
        assert order_flag(client, order["id"]) is (reason is None), f"{label}: the picker flag disagrees"


def test_the_missing_receipts_desk_marks_a_line_that_can_never_be_received(client):
    """A billed-out retail ticket is frozen, so its unreceipted part is money
    that will stay uncounted. It belongs on the desk -- the money is real --
    but the row has to say why rather than inviting a click that comes back
    with a refusal."""
    order = make_retail_order(client)
    save_estimate(client, order["id"], [dict(PART)])
    client.post(
        f"/api/orders/{order['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "t"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    rows = client.get("/api/parts/missing-receipts").json()
    assert len(rows) == 1
    assert rows[0]["billed_out"] is True

    # A finished recon ticket, which can be receipted, is not marked.
    vendor(client)
    finished_recon_ticket(client, stock_number="R-7020")
    recon_row = next(r for r in client.get("/api/parts/missing-receipts").json() if r["stock_number"] == "R-7020")
    assert recon_row["billed_out"] is False
