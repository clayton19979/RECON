"""One vendor invoice, two cars -- and everything that used to go quiet.

Picking up parts for three cars on one counter ticket is the ordinary way this
shop buys, and the app already handled the money side: the invoice accumulates
and each car is costed from its own received lines. What it did not handle was
every *question asked afterwards*.

The moment an invoice covers a second ticket, `ap_invoices.order_id` is set to
null on purpose -- it no longer belongs to one ticket. But three screens were
still finding a part's vendor invoice by that column, so all three lost their
answer at the same instant, silently:

* Cores & Returns stopped naming the vendor, on the one screen whose entire job
  is to say where to take a part back.
* The Move-line dialog's "this also covers other parts" warning went to zero --
  on precisely the invoice most worth warning about.
* Accounts Payable printed "No ticket" against the bill, the same words it uses
  for a genuine shop-supplies invoice with no car behind it at all.

Nothing errored. The screens just answered "nothing" and looked right doing it.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def part(description: str, number: str, cost: float, core: float = 0.0) -> dict:
    return {
        "kind": "part",
        "description": description,
        "part_number": number,
        "quantity": 1,
        "unit_price": cost,
        "unit_cost": cost,
        "core_charge": core,
    }


def recon_car(client, stock: str, vin: str, items: list[dict]) -> tuple[int, list[int]]:
    vehicle = make_recon_vehicle(client, stock_number=stock, vin=vin, purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], items)
    return order["id"], [row["id"] for row in estimate["items"]]


def receive(client, order_id: int, item_ids: list[int], vendor_id: int, invoice: str):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor_id, "invoice_number": invoice, "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    return res.json()


def shared_invoice(client, invoice_number: str = "NAPA-4400"):
    """Two cars' parts received onto one real vendor invoice number."""
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    order_a, items_a = recon_car(client, "R-SH1", "1HGCM82633A000101", [part("Windshield", "WS-1", 180, core=0)])
    order_b, items_b = recon_car(client, "R-SH2", "1HGCM82633A000102", [part("Alternator", "ALT-9", 95, core=25)])
    receive(client, order_a, items_a, vendor["id"], invoice_number)
    receive(client, order_b, items_b, vendor["id"], invoice_number)
    return vendor, (order_a, items_a[0]), (order_b, items_b[0])


def test_a_returned_part_still_knows_which_vendor_to_take_it_back_to(client):
    """The sharpest edge of it. A part comes off the car and goes back on the
    shelf by the door; the Returns list is what says who to hand it to. Once
    its invoice also covered another car, that column went blank."""
    vendor, (order_a, item_a), _ = shared_invoice(client)

    res = client.patch(
        f"/api/orders/{order_a}/estimate/items/{item_a}/part-return",
        json={"returned": True, "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    row = next(r for r in client.get("/api/returns").json() if r["id"] == item_a)
    assert row["vendor_name"] == "NAPA", f"no vendor to take it back to: {row['vendor_name']!r}"
    assert row["vendor_id"] == vendor["id"], "the Post Credit dialog has no vendor to default to"


def test_a_core_on_a_shared_invoice_still_names_its_vendor(client):
    """Same failure, same cause, on the money the shop is owed rather than
    the money it spent -- a core deposit is only refundable by the vendor who
    charged it."""
    vendor, _, (_, item_b) = shared_invoice(client)

    row = next(r for r in client.get("/api/cores").json() if r["id"] == item_b)
    assert row["vendor_name"] == "NAPA", f"the core deposit names no vendor: {row['vendor_name']!r}"
    assert row["vendor_id"] == vendor["id"]


def test_the_move_dialog_warns_that_the_invoice_reaches_another_car(client):
    """Ticking "also reassign the vendor invoice" moves the whole invoice.
    When it covers another car that is exactly what the advisor needs told --
    and it was the one case the warning stayed silent about."""
    _, (order_a, item_a), _ = shared_invoice(client)

    detail = client.get(f"/api/orders/{order_a}/estimate/items/{item_a}/received-invoice").json()
    assert detail is not None, "the invoice behind a received part could not be found at all"
    assert detail["invoice_number"] == "NAPA-4400"
    assert detail["vendor_name"] == "NAPA"
    assert detail["other_item_count"] == 1, "the warning claims this invoice covers nothing else"
    assert detail["other_order_count"] == 1, "the warning doesn't mention the other vehicle"


def test_a_single_ticket_invoice_reports_no_other_reach(client):
    """The counterpart: the warning must stay off when there is nothing else
    on the invoice, or it becomes noise the advisor learns to click past."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = recon_car(client, "R-SOLO", "1HGCM82633A000103", [part("Pump", "PMP-1", 70)])
    receive(client, order_id, item_ids, vendor["id"], "WP-1")

    detail = client.get(f"/api/orders/{order_id}/estimate/items/{item_ids[0]}/received-invoice").json()
    assert detail["other_item_count"] == 0
    assert detail["other_order_count"] == 0


def test_two_parts_for_one_car_on_one_invoice_is_not_another_vehicle(client):
    """Buying two parts for the same car on one invoice is not the invoice
    reaching another vehicle. The ticket being looked at must not count itself,
    or the warning cries wolf on the most ordinary invoice there is."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = recon_car(
        client,
        "R-PAIR",
        "1HGCM82633A000106",
        [part("Caliper", "CAL-1", 90), part("Hose", "HOSE-1", 25)],
    )
    receive(client, order_id, item_ids, vendor["id"], "WP-2")

    detail = client.get(f"/api/orders/{order_id}/estimate/items/{item_ids[0]}/received-invoice").json()
    assert detail["other_item_count"] == 1, "the second part on the same ticket should still be counted"
    assert detail["other_order_count"] == 0, "a one-car invoice claims to reach another vehicle"


def test_accounts_payable_says_which_cars_a_shared_invoice_paid_for(client):
    """What Clayton has in his hand is the vendor's statement. The screen has
    to answer "where did this $300 go" without opening tickets one at a time."""
    shared_invoice(client)

    invoice = next(a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "NAPA-4400")
    # 180 windshield + 95 alternator + $25 core deposit: the vendor's bill
    # carries the deposit (see test_core_deposits), so A/P has to say 300 or
    # it never matches the paper in Clayton's hand.
    assert invoice["total"] == 300, invoice["total"]
    assert invoice["vehicle_label"] != "No ticket", "a bill covering two cars reads as belonging to none"

    coverage = {c["vehicle_label"]: c["amount"] for c in invoice["coverage"]}
    # The alternator's car carries its core deposit too -- the coverage rows
    # have to sum to the bill's own 300, or the answer doesn't add up.
    assert coverage == {"R-SH1": 180.0, "R-SH2": 120.0}, coverage
    # Largest share first: the car someone scanning the row is looking for.
    assert invoice["coverage"][0]["vehicle_label"] == "R-SH1"
    assert invoice["vehicle_label"] == "R-SH1 +1 more", invoice["vehicle_label"]


def test_a_we_owe_car_is_named_by_its_customer_on_a_shared_invoice(client):
    """A we-owe has no stock number, so it has to be named the way every other
    money screen names it -- by whose car it is."""
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    order_a, items_a = recon_car(client, "R-MIX", "1HGCM82633A000104", [part("Rotor", "RT-1", 60)])
    we_owe = make_we_owe(client, customer_name="Jordan Whitfield", description="Tie rod")
    order_b = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    estimate_b = save_estimate(client, order_b["id"], [part("Tie rod", "TR-1", 40)])

    receive(client, order_a, items_a, vendor["id"], "NAPA-9")
    receive(client, order_b["id"], [estimate_b["items"][0]["id"]], vendor["id"], "NAPA-9")

    invoice = next(a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "NAPA-9")
    labels = [c["vehicle_label"] for c in invoice["coverage"]]
    assert labels == ["R-MIX", "We-Owe: Jordan Whitfield"], labels


def test_an_invoice_with_no_ticket_behind_it_still_says_so(client):
    """Shop supplies, a bulk oil delivery -- real money owed to a real vendor
    with no car behind it. "No ticket" is the true answer there and has to
    survive the change that stopped it being the answer to everything."""
    client.post("/api/vendors", json={"name": "NAPA"})
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "NAPA",
            "invoice_number": "SUPPLIES-1",
            "po_number": "",
            "order_id": None,
            "subtotal": 60.0,
            "tax": 0.0,
            "total": 60.0,
            "items": [{"part_number": "TOWEL", "description": "Shop towels", "quantity": 1, "unit_cost": 60.0}],
        },
    )
    assert res.status_code == 200, res.text

    invoice = next(a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "SUPPLIES-1")
    assert invoice["coverage"] == []
    assert invoice["vehicle_label"] == "No ticket"


def test_an_invoice_typed_against_one_ticket_still_names_that_car(client):
    """Typed in on the Accounting screen rather than received on a ticket: no
    per-line links exist, so the invoice's own ticket is the answer and must
    keep being used."""
    client.post("/api/vendors", json={"name": "NAPA"})
    order_id, _ = recon_car(client, "R-TYPED", "1HGCM82633A000105", [part("Belt", "BLT-1", 30)])
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "NAPA",
            "invoice_number": "TYPED-1",
            "po_number": "R-TYPED",
            "order_id": order_id,
            "subtotal": 30.0,
            "tax": 0.0,
            "total": 30.0,
            "items": [{"part_number": "BLT-1", "description": "Belt", "quantity": 1, "unit_cost": 30.0}],
        },
    )
    assert res.status_code == 200, res.text

    invoice = next(a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "TYPED-1")
    assert invoice["vehicle_label"] == "R-TYPED", invoice["vehicle_label"]
    assert [c["vehicle_label"] for c in invoice["coverage"]] == ["R-TYPED"]
