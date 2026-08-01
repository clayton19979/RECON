"""A core deposit is real money, and every screen that counts money has to say so.

The shop buys reman and used parts as a matter of course (CLAUDE.md), so a
deposit rides on a large share of the parts that come through the door. It used
to be tracked only on the Cores board:

  * the vendor invoice RECON posted was short by every deposit on it, so the
    A/P total never matched the paper invoice and there was no way to make it;
  * the car's cost never included a deposit, so a core that never went back
    made the car look permanently cheaper than it was;
  * recording the vendor's credit moved a pill on a board and nothing else.

These cover the money now moving in one direction at a time: onto the invoice
and onto the car when the part lands, back off both when the vendor credits it.
"""

from __future__ import annotations

from app.db import connect

from .helpers import make_recon_order, make_recon_vehicle, save_estimate


def alternator(core_charge: float = 45.0, quantity: float = 1, unit_cost: float = 180.0) -> dict:
    return {
        "kind": "part",
        "description": "Alternator (reman)",
        "part_number": "ALT-9",
        "quantity": quantity,
        "unit_price": 0,
        "unit_cost": unit_cost,
        "core_charge": core_charge,
    }


def receive(client, order_id, item_ids, vendor_id, invoice_number="INV-1", tax=0.0):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={
            "item_ids": item_ids,
            "vendor_id": vendor_id,
            "invoice_number": invoice_number,
            "tax": tax,
            "actor": "tester",
        },
    )
    assert res.status_code == 200, res.text
    return res.json()


def board_row(client, stock_number):
    return next(r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == stock_number)


def test_the_deposit_is_on_the_vendor_invoice_and_on_the_car(client):
    """The whole point: what RECON posts equals what the vendor billed, and
    what the car carries equals what left the shop's pocket."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3001")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [alternator()])
    item_id = estimate["items"][0]["id"]

    # Quoted before anything lands: the deposit is money the car is going to
    # need, so it is in the quote -- otherwise the day the part arrives the
    # car reads as $45 over its own estimate for no reason anyone did.
    assert board_row(client, "R-3001")["quoted_cost"] == 225.0
    assert board_row(client, "R-3001")["actual_cost"] == 0.0

    receive(client, order["id"], [item_id], vendor["id"])

    invoice = client.get("/api/ap/invoices").json()[0]
    assert invoice["total"] == 225.0, "the vendor's bill is the part plus the deposit"

    row = board_row(client, "R-3001")
    assert row["actual_cost"] == 225.0
    assert row["quoted_cost"] == 225.0, "a deposit must never read as over quote"


def test_recording_the_credit_takes_the_deposit_back_off_both_sides(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3002")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"actor": "tester"})
    assert board_row(client, "R-3002")["actual_cost"] == 225.0, "handing over the old unit is not the money coming back"

    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/core-credit",
        json={"invoice_number": "CR-9001", "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["credit_total"] == -45.0

    row = board_row(client, "R-3002")
    assert row["actual_cost"] == 180.0, "the deposit is back, so the car only cost the part"
    assert row["quoted_cost"] == 180.0

    credits = [i for i in client.get("/api/ap/invoices").json() if i["invoice_number"] == "CR-9001"]
    assert len(credits) == 1 and credits[0]["total"] == -45.0
    assert credits[0]["vendor_id"] == vendor["id"], "the credit goes back to whoever charged the deposit"


def test_two_of_a_part_owe_two_deposits(client):
    """Calipers come in pairs. The deposit is per unit everywhere -- on the
    invoice, on the car, and on the Cores board's own total."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3003")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Caliper",
                "part_number": "CAL-1",
                "quantity": 2,
                "unit_price": 0,
                "unit_cost": 80,
                "core_charge": 25,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])

    assert client.get("/api/ap/invoices").json()[0]["total"] == 210.0
    assert board_row(client, "R-3003")["actual_cost"] == 210.0

    core = client.get("/api/cores").json()[0]
    assert core["core_charge"] == 25 and core["quantity"] == 2
    assert core["core_total"] == 50, "the board used to show one deposit for a pair of calipers"


def test_sending_the_new_part_back_takes_its_deposit_with_it(client):
    """There is no old unit owed to anyone once the new part goes back, so the
    deposit stops being the car's money at the same moment the part does."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3004")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])
    assert board_row(client, "R-3004")["actual_cost"] == 225.0

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert board_row(client, "R-3004")["actual_cost"] == 0.0
    # The returned part drops out of the written-up total, and its deposit
    # goes with it. The grid, the printed ticket and estimate-money.js all
    # render a returned line as $0.00, so the server has to agree or the
    # ticket card and the Vehicle Total card show two different numbers for
    # the same ticket. The deposit stopped existing rather than being sent
    # back, which is the same reason the Cores board drops it off entirely.
    assert board_row(client, "R-3004")["quoted_cost"] == 0.0
    assert client.get("/api/cores").json() == []


def test_a_credit_that_is_posted_to_ap_blocks_undoing_the_core_return(client):
    """Undoing puts the deposit back onto the car. Doing that while the vendor
    credit still sits in A/P would have the same $45 counted as spent and as
    refunded at once."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3005")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"actor": "tester"})
    credit = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/core-credit",
        json={"invoice_number": "CR-9001", "actor": "tester"},
    ).json()

    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"returned": False, "actor": "tester"}
    )
    assert res.status_code == 400
    assert "Accounts Payable" in res.json()["detail"]

    # Void the credit on the A/P screen and the way out opens up again.
    client.patch(f"/api/ap/invoices/{credit['ap_invoice_id']}/void", json={"actor": "tester"})
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"returned": False, "actor": "tester"}
    )
    assert res.status_code == 200
    assert board_row(client, "R-3005")["actual_cost"] == 225.0, "the deposit is owed again"


def test_a_core_whose_deposit_was_never_billed_still_closes_out(client):
    """Cores recorded before deposits went onto invoices -- and cores whose
    invoice was voided -- have nothing in A/P to reverse. Recording the credit
    still has to work; it just posts nothing."""
    vehicle = make_recon_vehicle(client, "R-3006")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"actor": "tester"})
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/core-credit",
        json={"invoice_number": "CR-9002", "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["ap_invoice_id"] is None
    assert res.json()["credit_total"] == 0.0
    assert client.get("/api/ap/invoices").json() == []
    assert client.get("/api/cores").json()[0]["core_return_invoice_number"] == "CR-9002"


def test_the_invoice_line_records_what_kind_of_charge_it_was(client, db_path):
    """The deposit has to be findable on the invoice later to be reversed, and
    the Accounting screen's own Type dropdown was being thrown away on the way
    in -- every line was stored as if it were a part."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3007")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])

    with connect(db_path) as db:
        rows = db.execute("SELECT kind, line_total, estimate_item_id FROM ap_invoice_items ORDER BY id").fetchall()
    assert [(r["kind"], r["line_total"]) for r in rows] == [("part", 180.0), ("core_charge", 45.0)]
    assert {r["estimate_item_id"] for r in rows} == {item_id}, "both lines paid for the same part line"


def test_the_lot_report_counts_an_outstanding_deposit_as_money_in_the_car(client):
    """Walt's question is what we spent on each car; the lot sheet is where he
    reads the answer."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, "R-3008")
    order = make_recon_order(client, vehicle["id"])
    item_id = save_estimate(client, order["id"], [alternator()])["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"])

    row = next(r for r in client.get("/api/reports/lot").json() if r["stock_number"] == "R-3008")
    assert row["actual_cost"] == 225.0
    assert row["remaining_cost"] == 0.0, "nothing left to spend -- the deposit is already out the door"
