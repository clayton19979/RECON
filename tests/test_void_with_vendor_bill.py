"""Voiding a ticket must not make a bill the shop actually owes disappear.

Voiding means the work never happened, so `cost_rollup` stops counting the
ticket's money toward the car (see `recon.live_orders`). That is right when a
ticket was started on the wrong car. It is wrong the moment a vendor has
billed for parts against it: the parts were bought, the invoice is posted in
Accounts Payable, and it stays owed whatever anybody does to the ticket.

Before this, voiding was allowed anyway, and the two screens then disagreed
without either of them saying so. The car went to $0.00 spent. The invoice sat
on the A/P list looking exactly like every other posted bill. Walt's "what did
we spend on this one" came back short by the whole amount, and nothing on any
screen pointed at the gap.

`void_order` already refused this on the *customer* side -- an invoiced retail
ticket can't be voided. But recon and we-owe tickets are never billed to a
customer (no markup, nothing charged out), so that guard has never once fired
on the work this app exists for. The vendor side is the side these tickets
have.
"""

from __future__ import annotations

from app.db import connect
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def void_in_place(db_path, order_id: int) -> None:
    """Void a ticket behind the API's back, the way one got voided before the
    guard existed. Same two columns `workflow.void_order` writes."""
    with connect(db_path) as db:
        db.execute("UPDATE orders SET status='complete', voided=1 WHERE id=?", (order_id,))
        db.commit()


def part(description: str, number: str, cost: float) -> dict:
    return {
        "kind": "part",
        "description": description,
        "part_number": number,
        "quantity": 1,
        "unit_price": cost,
        "unit_cost": cost,
    }


def receive(client, order_id: int, item_ids: list[int], vendor_id: int, invoice: str):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor_id, "invoice_number": invoice, "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    return res.json()


def billed_recon_car(client, stock="R-VB1", cost=420.0):
    """A recon car with one part received onto a real vendor invoice."""
    vendor = client.post("/api/vendors", json={"name": "Pull-A-Part"}).json()
    vehicle = make_recon_vehicle(client, stock_number=stock, purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part("Windshield", "WS-1", cost)])
    item_ids = [row["id"] for row in estimate["items"]]
    receive(client, order["id"], item_ids, vendor["id"], "PAP-9001")
    return vendor, vehicle, order, item_ids


def board_row(client, recon_id):
    return next(r for r in client.get("/api/vehicles-board").json() if r["recon_id"] == recon_id)


def test_voiding_a_ticket_with_a_vendor_bill_on_it_is_refused(client):
    """The whole point. $420 of parts really came in on a real invoice; the
    ticket cannot be un-happened out from under it."""
    _, vehicle, order, _ = billed_recon_car(client)
    assert board_row(client, vehicle["id"])["actual_cost"] == 420

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})

    assert res.status_code == 409, f"the void went through and took $420 off the car: {res.text}"
    detail = res.json()["detail"]
    # The refusal has to be actionable during a busy morning: which bill, how
    # much, and where to go if it really was posted by mistake.
    assert "$420.00" in detail, detail
    assert "Pull-A-Part PAP-9001" in detail, detail
    assert "Accounts Payable" in detail, detail

    # And the ticket is genuinely untouched -- not half-voided.
    assert board_row(client, vehicle["id"])["actual_cost"] == 420
    assert client.get(f"/api/orders/{order['id']}").json()["voided"] == 0


def test_voiding_the_bill_first_clears_the_way(client):
    """The way out, for the case where the bill really was a mistake. Voiding
    it in A/P puts the parts back on order and takes the cost off the car --
    after which nothing is stranded and the ticket voids normally."""
    _, vehicle, order, _ = billed_recon_car(client)
    invoice = client.get("/api/ap/invoices").json()[0]

    voided = client.patch(f"/api/ap/invoices/{invoice['id']}/void", json={"actor": "tester"})
    assert voided.status_code == 200, voided.text
    assert board_row(client, vehicle["id"])["actual_cost"] == 0

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, f"nothing is owed on this ticket any more: {res.text}"
    assert res.json()["voided"] is True


def test_a_ticket_with_nothing_received_still_voids(client):
    """The ordinary case, which is most of them: a ticket written on the wrong
    car, caught before anybody bought anything. This guard must not turn a
    one-click correction into a puzzle."""
    vehicle = make_recon_vehicle(client, stock_number="R-VB2", purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [part("Windshield", "WS-1", 180)])

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text


def test_a_part_received_then_fully_credited_back_voids_fine(client):
    """Credits post as negative invoice rows against the same ticket, so a
    part that went back for full credit leaves the ticket owing nothing. The
    guard nets them rather than counting the original bill twice over -- a
    refusal here would be an alarm about money that is already back."""
    vendor, _vehicle, order, item_ids = billed_recon_car(client, stock="R-VB3", cost=300.0)

    returned = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/part-return",
        json={"returned": True, "actor": "tester"},
    )
    assert returned.status_code == 200, returned.text
    credited = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "RMA-77", "actor": "tester"},
    )
    assert credited.status_code == 200, credited.text

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, f"the vendor already gave the money back: {res.text}"


def test_a_bill_shared_across_cars_still_blocks_the_car_it_touched(client):
    """One counter run pays for parts on two cars, which is how this shop
    actually buys. A shared invoice carries no single order_id at all, so a
    guard reading only that column would have let exactly the biggest bills
    through -- and the block has to name only this car's share of it."""
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    first = make_recon_vehicle(client, stock_number="R-VB4", purchase_price=0)
    second = make_recon_vehicle(client, stock_number="R-VB5", purchase_price=0)
    order_a = make_recon_order(client, first["id"])
    order_b = make_recon_order(client, second["id"])
    items_a = [r["id"] for r in save_estimate(client, order_a["id"], [part("Windshield", "WS-1", 180)])["items"]]
    items_b = [r["id"] for r in save_estimate(client, order_b["id"], [part("Alternator", "ALT-9", 95)])["items"]]
    receive(client, order_a["id"], items_a, vendor["id"], "NAPA-4400")
    receive(client, order_b["id"], items_b, vendor["id"], "NAPA-4400")

    res = client.post(f"/api/orders/{order_a['id']}/void", json={"actor": "tester"})
    assert res.status_code == 409, f"a shared bill slipped past the guard: {res.text}"
    detail = res.json()["detail"]
    assert "$180.00" in detail, f"named the whole bill instead of this car's share: {detail}"
    assert "$275.00" not in detail, f"charged this car with the other car's parts too: {detail}"


def test_a_we_owe_ticket_is_covered_too(client):
    """We-owe work is billed at cost with no customer invoice either, so it
    had exactly the same hole."""
    vendor = client.post("/api/vendors", json={"name": "Pull-A-Part"}).json()
    promise = make_we_owe(client)
    order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": promise["id"]}
    ).json()
    items = [r["id"] for r in save_estimate(client, order["id"], [part("Tie rod end", "TR-4", 62)])["items"]]
    receive(client, order["id"], items, vendor["id"], "PAP-7788")

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 409, f"we-owe tickets can still lose a real bill: {res.text}"


def test_a_bill_typed_in_on_the_accounts_payable_screen_blocks_too(client):
    """The other door money comes in through. A bill typed straight into A/P
    against a ticket carries no per-line links back to the estimate, so the
    guard has to fall back to the invoice's own subtotal -- otherwise the
    hand-typed half of the shop's bills would all slip past."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-VB7", purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    posted = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": vendor["name"],
            "invoice_number": "WP-3312",
            "order_id": order["id"],
            "subtotal": 88,
            "tax": 0,
            "total": 88,
            "items": [{"part_number": "IC-3", "description": "Coil pack", "quantity": 1, "unit_cost": 88}],
        },
    )
    assert posted.json()["status"] == "posted", posted.text

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    assert res.status_code == 409, f"a typed-in bill slipped through: {res.text}"
    assert "$88.00" in res.json()["detail"], res.json()["detail"]


def test_accounts_payable_marks_a_bill_whose_ticket_was_voided(client, db_path):
    """For the ones already in the books. The guard cannot reach backwards, so
    a shop that voided a billed ticket before it existed still has money in
    the A/P total that no car is carrying. A/P is where somebody holding a
    vendor statement looks, so A/P is where it has to say so.

    The void is written straight to the database because the API now refuses
    it -- which is the whole point -- and that is exactly the shape of record
    the old behaviour left behind."""
    _, vehicle, order, _ = billed_recon_car(client, stock="R-VB6")

    before = client.get("/api/ap/invoices").json()[0]
    assert before["stranded_total"] == 0, "a live ticket's bill is on the car, not stranded"
    assert before["coverage"][0]["ticket_voided"] is False

    void_in_place(db_path, order["id"])

    after = client.get("/api/ap/invoices").json()[0]
    assert after["stranded_total"] == 420, f"the A/P screen still shows nothing wrong: {after['stranded_total']}"
    assert after["coverage"][0]["ticket_voided"] is True
    assert board_row(client, vehicle["id"])["actual_cost"] == 0, "the car really is carrying none of it"
