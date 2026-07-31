"""Where a part came from, and one vendor invoice covering several cars.

Two problems with one root. A received part line recorded only the invoice
*number* it was posted under, as loose text, and nothing anywhere tied a
billed line back to the part line it paid for. So the ticket could only ever
show a number -- never "WorldPac" -- and posting a second delivery against a
real invoice was rejected as a duplicate, which left inventing invoice numbers
the vendor never issued as the only way through. The invented numbers then
broke the one string the supplier could have been recovered from.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def part(description: str, number: str, cost: float = 120.0) -> dict:
    return {
        "kind": "part",
        "description": description,
        "part_number": number,
        "quantity": 1,
        "unit_price": cost,
        "unit_cost": cost,
    }


def car_with_parts(client, stock: str, vin: str, items: list[dict]) -> tuple[int, list[int]]:
    vehicle = make_recon_vehicle(client, stock_number=stock, vin=vin, purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], items)
    return order["id"], [row["id"] for row in estimate["items"]]


def receive(client, order_id: int, item_ids: list[int], vendor_id: int, invoice: str, tax: float = 0.0):
    return client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={
            "item_ids": item_ids,
            "vendor_id": vendor_id,
            "invoice_number": invoice,
            "tax": tax,
            "actor": "tester",
        },
    )


def items_of(client, order_id: int) -> list[dict]:
    """Read the lines back the way the ticket screen does."""
    return client.get(f"/api/orders/{order_id}").json()["estimate"]["items"]


def test_the_ticket_says_which_supplier_the_part_came_from(client):
    """The complaint that started this: holding a part in your hand, the
    ticket told you an invoice number and not who sold it to you."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = car_with_parts(client, "R-SRC", "1HGCM82633A000001", [part("Alternator", "ALT-1")])

    assert receive(client, order_id, item_ids, vendor["id"], "WP-55123").status_code == 200

    line = items_of(client, order_id)[0]
    assert line["received_vendor_id"] == vendor["id"]
    assert line["received_vendor_name"] == "WorldPac", "the ticket has no name to show"
    assert line["received_invoice_number"] == "WP-55123", "the paperwork reference is still kept"


def test_one_vendor_invoice_can_cover_parts_for_several_cars(client):
    """A single invoice covering several cars is routine. This used to come
    back 409 on the second car, and the only way through was to invent an
    invoice number the vendor never issued."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_a, items_a = car_with_parts(client, "R-A", "1HGCM82633A000002", [part("Axle", "AX-9", 200)])
    order_b, items_b = car_with_parts(client, "R-B", "1HGCM82633A000003", [part("Mirror", "MIR-3", 80)])

    first = receive(client, order_a, items_a, vendor["id"], "WP-77000")
    second = receive(client, order_b, items_b, vendor["id"], "WP-77000")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, f"the second car on the same invoice was refused: {second.text}"

    # One invoice, not two -- this is what "combine it into the same invoice"
    # has to mean for the vendor's paperwork to reconcile.
    invoices = [a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "WP-77000"]
    assert len(invoices) == 1, f"expected one invoice, found {len(invoices)}"
    assert invoices[0]["total"] == 280, f"the invoice total is not both deliveries: {invoices[0]['total']}"

    for order_id in (order_a, order_b):
        assert items_of(client, order_id)[0]["received_vendor_name"] == "WorldPac"


def test_an_invoice_spanning_cars_stops_claiming_to_belong_to_one(client):
    """While an invoice covers a single ticket it keeps pointing at it. Once
    it covers two, saying it belongs to either one is false -- the per-line
    links carry the truth from then on."""
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    order_a, items_a = car_with_parts(client, "R-C", "1HGCM82633A000004", [part("Rotor", "RT-1", 60)])
    order_b, items_b = car_with_parts(client, "R-D", "1HGCM82633A000005", [part("Pads", "PD-1", 40)])

    def invoice() -> dict:
        return next(a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "NAPA-1")

    receive(client, order_a, items_a, vendor["id"], "NAPA-1")
    one_ticket = invoice()
    assert one_ticket["ro_number"], "a single-ticket invoice should still name its ticket"

    receive(client, order_b, items_b, vendor["id"], "NAPA-1")
    spanning = invoice()
    assert not spanning["ro_number"], "an invoice covering two cars must not claim to belong to one"


def test_receiving_the_rest_of_a_delivery_later_adds_to_the_same_invoice(client):
    """Parts off one invoice arrive in more than one drop. The later drop
    belongs on the invoice that is already open, not on a new one."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = car_with_parts(
        client,
        "R-SPLIT",
        "1HGCM82633A000006",
        [part("Caliper", "CAL-1", 90), part("Hose", "HOSE-1", 25)],
    )

    assert receive(client, order_id, [item_ids[0]], vendor["id"], "WP-88000", tax=5).status_code == 200
    assert receive(client, order_id, [item_ids[1]], vendor["id"], "WP-88000", tax=2).status_code == 200

    invoices = [a for a in client.get("/api/ap/invoices").json() if a["invoice_number"] == "WP-88000"]
    assert len(invoices) == 1
    # 90 + 25 of parts, and both slices of tax.
    assert invoices[0]["total"] == 122, invoices[0]
    assert all(line["received_vendor_name"] == "WorldPac" for line in items_of(client, order_id))


def test_the_cars_own_cost_is_unaffected_by_sharing_an_invoice(client):
    """Cars are costed from their own received lines, never from an invoice
    total. If that ever changes, a shared invoice would put one car's parts
    into another car's cost -- so it is pinned here."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_a, items_a = car_with_parts(client, "R-E", "1HGCM82633A000007", [part("Axle", "AX-1", 200)])
    order_b, items_b = car_with_parts(client, "R-F", "1HGCM82633A000008", [part("Mirror", "MIR-1", 80)])

    receive(client, order_a, items_a, vendor["id"], "WP-99000")
    receive(client, order_b, items_b, vendor["id"], "WP-99000")

    board = {row["stock_number"]: row for row in client.get("/api/vehicles-board").json()}
    assert board["R-E"]["actual_cost"] == 200, "car E picked up car F's parts"
    assert board["R-F"]["actual_cost"] == 80, "car F picked up car E's parts"


def test_each_billed_line_records_the_part_it_paid_for(client, db_path):
    """The link that did not exist before: without it, an invoice covering
    three cars cannot say which of its lines belongs to which car."""
    from app.db import connect

    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = car_with_parts(client, "R-LINK", "1HGCM82633A000009", [part("Starter", "ST-1", 150)])
    receive(client, order_id, item_ids, vendor["id"], "WP-11111")

    with connect(db_path) as db:
        rows = db.execute("SELECT estimate_item_id FROM ap_invoice_items").fetchall()
    assert [r["estimate_item_id"] for r in rows] == item_ids


def test_a_second_delivery_still_cannot_receive_the_same_line_twice(client):
    """Letting an invoice grow must not become a way to bill a part twice."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order_id, item_ids = car_with_parts(client, "R-TWICE", "1HGCM82633A000010", [part("Pump", "PMP-1", 70)])

    assert receive(client, order_id, item_ids, vendor["id"], "WP-22222").status_code == 200
    again = receive(client, order_id, item_ids, vendor["id"], "WP-22222")
    assert again.status_code == 409, "the same line was received onto the invoice twice"
    assert "already been fully received" in again.text
