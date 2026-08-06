"""The A/P Control Log has to be a complete record of the vendor bills.

The Accounting screen shows a Control Log beside the invoice editor and its
empty state says, in those words, that posting or voiding a vendor invoice is
recorded there. It wasn't true. Only one of the three ways a bill reaches this
shop wrote to the log:

  * typed into the Accounting screen (or handed over by the agent) -- logged
  * created by pressing Receive Selected on a ticket -- not logged
  * voided -- never logged at all, by any path

Receiving parts on a ticket is how nearly every bill in this shop is posted,
so the log sat reading "No activity yet" on a day the shop had posted a
thousand dollars of parts. And a void -- the one event most worth being able
to point at weeks later, because it takes real money back off a car -- left no
trace on the screen that claims to keep the record.

These tests pin all three doors to the log, and pin the two facts that make an
entry findable afterwards: which vendor, and which car.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def part(description="Windshield", part_number="WS-1", quantity=1, unit_cost=180.0):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }


def vendor_id(client, name="NAPA Merrillville"):
    return client.post("/api/vendors", json={"name": name}).json()["id"]


def ticket_with_parts(client, stock_number="R-7001", lines=None):
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    saved = save_estimate(client, order["id"], lines or [part()])
    return order, [item["id"] for item in saved["items"]]


def receive(client, order_id, item_ids, invoice_number, vendor):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor, "invoice_number": invoice_number},
    )
    assert res.status_code == 200, res.text
    return res.json()


def log(client):
    return client.get("/api/accounting/audits").json()


def test_receiving_parts_on_a_ticket_shows_up_in_the_control_log(client):
    """The door nearly every bill in this shop comes through."""
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(client)

    assert log(client) == [], "nothing has happened yet"
    receive(client, order["id"], item_ids, "INV-4400", vendor)

    entries = log(client)
    assert len(entries) == 1, entries
    entry = entries[0]
    assert entry["invoice_number"] == "INV-4400"
    assert entry["status"] == "posted"
    assert entry["source"] == "ticket_receive"
    assert entry["issues"] == []


def test_the_log_says_which_vendor_and_which_car(client):
    """An invoice number on its own is not something anybody recognises."""
    vendor = vendor_id(client, "WorldPac")
    order, item_ids = ticket_with_parts(client, stock_number="R-7002")
    receive(client, order["id"], item_ids, "INV-4401", vendor)

    entry = log(client)[0]
    assert entry["vendor_name"] == "WorldPac"
    assert entry["vehicle_label"] == "R-7002"
    # Enough to click through to the car from the log, the same way the
    # invoice list does.
    assert entry["order_id"] == order["id"]


def test_a_second_delivery_is_logged_as_added_to_not_as_a_new_bill(client):
    """A vendor sending the rest of an order the next day extends the bill it
    already sent. Logging that as a fresh post would have the log claim two
    invoices where the vendor issued one."""
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(
        client,
        stock_number="R-7003",
        lines=[part(), part(description="Wiper blades", part_number="WB-2", unit_cost=25)],
    )
    receive(client, order["id"], item_ids[:1], "INV-4402", vendor)
    receive(client, order["id"], item_ids[1:], "INV-4402", vendor)

    entries = log(client)
    assert [e["status"] for e in entries] == ["extended", "posted"], entries
    assert {e["invoice_number"] for e in entries} == {"INV-4402"}
    # One invoice, both deliveries on it -- the log must not have invented a
    # second bill for the vendor.
    invoices = client.get("/api/ap/invoices").json()
    assert len(invoices) == 1, invoices


def test_voiding_a_bill_is_recorded_with_what_it_undid(client):
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(client, stock_number="R-7004")
    receive(client, order["id"], item_ids, "INV-4403", vendor)
    invoice = client.get("/api/ap/invoices").json()[0]

    res = client.patch(f"/api/ap/invoices/{invoice['id']}/void", json={"actor": "clayton"})
    assert res.status_code == 200, res.text

    entries = log(client)
    assert entries[0]["status"] == "voided"
    assert entries[0]["invoice_number"] == "INV-4403"
    assert entries[0]["vehicle_label"] == "R-7004"
    assert entries[0]["source"] == "clayton"
    # A void takes money back off a car. The log says how much work that was,
    # not just that somebody pressed the button.
    assert entries[0]["issues"] == ["1 part put back on order"]


def test_voiding_a_bill_with_no_ticket_behind_it_still_logs(client):
    """A shop-supplies bill belongs to no car, so the per-ticket activity log
    has nowhere to put its void. The Control Log is the only record there is."""
    client.post("/api/vendors", json={"name": "Fastenal"})
    posted = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "Fastenal",
            "invoice_number": "INV-4404",
            "po_number": "",
            "subtotal": 60,
            "tax": 0,
            "total": 60,
            "items": [{"part_number": "SUP-1", "description": "Shop towels", "quantity": 1, "unit_cost": 60}],
        },
    ).json()
    assert posted["status"] == "posted", posted

    invoice = client.get("/api/ap/invoices").json()[0]
    client.patch(f"/api/ap/invoices/{invoice['id']}/void", json={})

    entries = log(client)
    assert entries[0]["status"] == "voided"
    assert entries[0]["vehicle_label"] == "No ticket"
    assert entries[0]["issues"] == [], "no parts came back on order -- nothing was received"


def test_a_held_invoice_still_explains_itself_and_now_names_the_vendor(client):
    """The regression guard on the path that always worked: a bill the shop
    holds for review keeps its reasons, and gains the vendor as written on the
    paper -- which is the whole point when the vendor is what didn't match."""
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "Nobody's Auto Parts",
            "invoice_number": "INV-4405",
            "po_number": "",
            "subtotal": 10,
            "tax": 0,
            "total": 10,
            "items": [{"part_number": "X", "description": "Thing", "quantity": 1, "unit_cost": 10}],
        },
    )
    assert res.json()["status"] == "review_required", res.text

    entry = log(client)[0]
    assert entry["status"] == "review_required"
    assert entry["issues"], "a held invoice with no stated reason is unactionable"
    assert entry["vendor_name"] == "Nobody's Auto Parts"


def test_money_coming_back_off_a_car_is_logged_too(client):
    """A returned part's credit note is a vendor document that changes what a
    car cost. The log's job is every movement on a vendor's account, not only
    the ones that add money."""
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(client, stock_number="R-7006")
    receive(client, order["id"], item_ids, "INV-4407", vendor)
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/part-return", json={"actor": "tester"})
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/post-return-credit",
        json={"vendor_id": vendor, "credit_number": "CR-9100", "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    entry = log(client)[0]
    assert entry["invoice_number"] == "CR-9100"
    assert entry["source"] == "part_return"
    assert entry["vehicle_label"] == "R-7006"
    assert entry["issues"] == ["part returned — $180.00 back off the car"]


def test_a_core_deposit_coming_back_is_logged_too(client):
    """The other half of the same idea: the deposit charged when the part came
    in, refunded when the old unit went back."""
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(
        client,
        stock_number="R-7007",
        lines=[{**part(description="Alternator", part_number="ALT-9", unit_cost=180.0), "core_charge": 45}],
    )
    receive(client, order["id"], item_ids, "INV-4408", vendor)
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/core-return", json={"actor": "tester"})
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/core-credit",
        json={"invoice_number": "CR-9200", "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    entry = log(client)[0]
    assert entry["invoice_number"] == "CR-9200"
    assert entry["source"] == "core_return"
    assert entry["issues"] == ["core deposit refunded — $45.00 back off the car"]


def test_a_repost_after_a_void_reads_as_one_bill_replacing_another(client):
    """Voiding frees the invoice number so the corrected bill can go on under
    the number the vendor actually issued. Both events belong in the log, in
    order, or the second post looks like a duplicate nobody caught."""
    vendor = vendor_id(client)
    order, item_ids = ticket_with_parts(client, stock_number="R-7005")
    receive(client, order["id"], item_ids, "INV-4406", vendor)
    invoice = client.get("/api/ap/invoices").json()[0]
    client.patch(f"/api/ap/invoices/{invoice['id']}/void", json={})
    receive(client, order["id"], item_ids, "INV-4406", vendor)

    entries = log(client)
    assert [e["status"] for e in entries] == ["posted", "voided", "posted"], entries
    assert {e["invoice_number"] for e in entries} == {"INV-4406"}
