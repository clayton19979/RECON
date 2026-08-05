"""A part that arrives on more than one bill, at more than one price.

The everyday version: four rotors go on the ticket, the counter has two in
stock today and the other two come next week at a different number. Or a
windshield turns up cracked, goes back, and its replacement is billed at
thirty dollars more.

A car's cost used to be read as received_quantity * unit_cost, and receiving
overwrites unit_cost with the newest invoice's price -- so the second delivery
silently re-priced the first one. One windshield billed at 180 and its
replacement at 210 reported the car as having spent 420 while Accounts
Payable, holding both real bills, said 390. Two screens, thirty dollars apart,
neither able to explain the other.

These tests pin the car's cost to the sum of the bills the shop was actually
sent, through both doors that receive parts (the ticket's Receive Selected and
the A/P screen's Post a Vendor Invoice), and hold it there when a bill is
voided or a keyed-wrong price is corrected.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def part(description="Windshield", part_number="WS-1", quantity=1, unit_cost=180.0, **overrides):
    line = {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }
    line.update(overrides)
    return line


def vendor_id(client, name="NAPA Merrillville"):
    return client.post("/api/vendors", json={"name": name}).json()["id"]


def receive(client, order_id, item_ids, invoice_number, vendor, cost_overrides=None):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={
            "item_ids": item_ids,
            "vendor_id": vendor,
            "invoice_number": invoice_number,
            "cost_overrides": cost_overrides or {},
        },
    )
    assert res.status_code == 200, res.text
    return res.json()


def set_quantity(client, order_id, item_id, quantity, unit_cost):
    """Raise the quantity on a line that has already been part-received."""
    return save_estimate(
        client,
        order_id,
        [{"id": item_id, **part(quantity=quantity, unit_cost=unit_cost)}],
    )


def board_cost(client, stock_number):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["stock_number"] == stock_number)["actual_cost"]


def ap_total(client):
    """What the vendors' bills add up to -- the number the car has to match."""
    invoices = client.get("/api/ap/invoices").json()
    return round(sum(i["total"] for i in invoices if i["status"] != "voided"), 2)


def item_by_description(client, order_id, description):
    order = client.get(f"/api/orders/{order_id}").json()
    return next(i for i in order["estimate"]["items"] if i["description"] == description)


def setup_split(client, first_price=180.0, second_price=210.0, stock="R-2001"):
    """One part received at one price, then a second of the same part at
    another. Returns (order_id, item_id, stock_number)."""
    vehicle = make_recon_vehicle(client, stock_number=stock)
    order = make_recon_order(client, vehicle["id"])
    saved = save_estimate(client, order["id"], [part(unit_cost=first_price)])
    item_id = saved["items"][0]["id"]
    vendor = vendor_id(client)

    receive(client, order["id"], [item_id], "INV-1001", vendor)
    set_quantity(client, order["id"], item_id, quantity=2, unit_cost=first_price)
    receive(client, order["id"], [item_id], "INV-1002", vendor, {str(item_id): second_price})
    return order["id"], item_id, stock


def test_two_deliveries_at_two_prices_cost_what_the_bills_said(client):
    order_id, _item_id, stock = setup_split(client)

    # 180 + 210. Not 2 x 210, which is what re-pricing the first delivery at
    # the second invoice's number produced.
    assert ap_total(client) == 390.0
    assert board_cost(client, stock) == 390.0
    assert item_by_description(client, order_id, "Windshield")["received_cost"] == 390.0


def test_a_single_delivery_is_unchanged(client):
    """The common case has to keep reporting exactly what it always did."""
    vehicle = make_recon_vehicle(client, stock_number="R-2002")
    order = make_recon_order(client, vehicle["id"])
    saved = save_estimate(client, order["id"], [part(quantity=4, unit_cost=95.0)])
    item_id = saved["items"][0]["id"]

    receive(client, order["id"], [item_id], "INV-2001", vendor_id(client))

    assert board_cost(client, "R-2002") == 380.0
    assert ap_total(client) == 380.0


def test_correcting_the_cost_box_reprices_everything_received(client):
    """A keyed-wrong invoice price is fixed in the Cost box, and that has to
    still be what the car cost -- the one meaning that edit can have."""
    order_id, item_id, stock = setup_split(client)

    save_estimate(client, order_id, [{"id": item_id, **part(quantity=2, unit_cost=200.0)}])

    assert board_cost(client, stock) == 400.0


def test_resaving_a_ticket_does_not_flatten_a_split_delivery(client):
    """The grid saves on edits all over the ticket. A save that leaves the
    Cost box alone must not re-price the earlier delivery at the later price."""
    order_id, item_id, stock = setup_split(client)

    # Same cost, different description -- the shape of any other edit.
    save_estimate(
        client,
        order_id,
        [{"id": item_id, **part(description="Windshield", quantity=2, unit_cost=210.0)}],
    )

    assert board_cost(client, stock) == 390.0


def test_voiding_the_second_bill_leaves_the_first_delivery_on_the_car(client):
    order_id, _item_id, stock = setup_split(client)
    second = next(i for i in client.get("/api/ap/invoices").json() if i["invoice_number"] == "INV-1002")

    res = client.patch(f"/api/ap/invoices/{second['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text

    # The 210 bill is gone; the 180 one still stands, and so does its part.
    assert ap_total(client) == 180.0
    assert board_cost(client, stock) == 180.0
    assert item_by_description(client, order_id, "Windshield")["received_quantity"] == 1


def test_voiding_a_bill_with_a_core_deposit_only_unreceives_what_it_paid_for(client):
    """A core deposit rides on the same bill and points at the same line.
    Counting it as a second delivery put twice the quantity back on order."""
    vehicle = make_recon_vehicle(client, stock_number="R-2003")
    order = make_recon_order(client, vehicle["id"])
    saved = save_estimate(
        client,
        order["id"],
        [part(description="Alternator", part_number="ALT-9", quantity=4, unit_cost=100.0, core_charge=25.0)],
    )
    item_id = saved["items"][0]["id"]
    vendor = vendor_id(client)

    receive(client, order["id"], [item_id], "INV-3001", vendor)
    # Two more of the same part, billed separately.
    save_estimate(
        client,
        order["id"],
        [
            {
                "id": item_id,
                **part(description="Alternator", part_number="ALT-9", quantity=6, unit_cost=100.0, core_charge=25.0),
            }
        ],
    )
    receive(client, order["id"], [item_id], "INV-3002", vendor)

    second = next(i for i in client.get("/api/ap/invoices").json() if i["invoice_number"] == "INV-3002")
    client.patch(f"/api/ap/invoices/{second['id']}/void", json={"actor": "tester"})

    line = item_by_description(client, order["id"], "Alternator")
    assert line["received_quantity"] == 4
    # 4 parts at 100 plus their four still-owed 25 deposits.
    assert board_cost(client, "R-2003") == 500.0


def test_ap_screen_posting_a_second_bill_adds_to_the_cost(client):
    """The other receiving door: the A/P screen's Post a Vendor Invoice, which
    matches on part number and is where a split delivery normally lands."""
    vehicle = make_recon_vehicle(client, stock_number="R-2004")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [part(description="Rotor", part_number="BR-7", quantity=4, unit_cost=60.0)])
    client.post("/api/vendors", json={"name": "WorldPac"})

    def post(invoice_number, quantity, unit_cost):
        res = client.post(
            "/api/agent/invoices/process",
            json={
                "vendor_name": "WorldPac",
                "po_number": order["number"],
                "invoice_number": invoice_number,
                "items": [
                    {
                        "part_number": "BR-7",
                        "description": "Rotor",
                        "quantity": quantity,
                        "unit_cost": unit_cost,
                        "kind": "part",
                    }
                ],
                "subtotal": round(quantity * unit_cost, 2),
                "tax": 0,
                "total": round(quantity * unit_cost, 2),
            },
        )
        assert res.status_code == 200, res.text
        assert res.json()["status"] == "posted", res.json()
        return res.json()

    post("AP-4001", 2, 60.0)
    post("AP-4002", 2, 72.0)

    # 2 x 60 + 2 x 72, not 4 x 72.
    assert ap_total(client) == 264.0
    assert board_cost(client, "R-2004") == 264.0


def test_existing_rows_keep_the_number_they_already_reported(db_path, client):
    """The upgrade adds a column to a live database. Whatever a car cost
    before the restart is what it has to cost after it."""
    from app.db import connect

    vehicle = make_recon_vehicle(client, stock_number="R-2005")
    order = make_recon_order(client, vehicle["id"])
    saved = save_estimate(client, order["id"], [part(quantity=3, unit_cost=140.0)])
    receive(client, order["id"], [saved["items"][0]["id"]], "INV-5001", vendor_id(client))
    before = board_cost(client, "R-2005")

    # A row as it looks on a database that predates the column: the money is
    # only recoverable from quantity x price, which is what the backfill does.
    with connect(db_path) as db:
        db.execute("UPDATE estimate_items SET received_cost=0")
        db.execute("UPDATE estimate_items SET received_cost=round(received_quantity*unit_cost,2)")
        db.commit()

    assert board_cost(client, "R-2005") == before == 420.0
