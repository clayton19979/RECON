"""Repair order numbers the shop can say out loud, and the parts batches
hanging off them.

The problem behind all of this: the PO given to a vendor used to be the repair
order number, so four separate orders against one car all quoted the same PO
and a delivery could not be matched to the order that caused it.
"""

from __future__ import annotations

from app.db import connect, init_db, normalize_po_reference, purchase_order_number
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    make_we_owe,
    save_estimate,
)


def part(description, part_number, cost=10.0):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": 1,
        "unit_price": cost,
        "unit_cost": cost,
    }


# --- Repair order numbers ---


def test_ro_numbers_count_from_one_across_every_segment(client):
    """One sequence for the whole shop. A recon ticket and a we-owe ticket
    sharing a number would put two cars under one PO, which is the exact
    confusion purchase orders exist here to end."""
    first = make_recon_order(client, make_recon_vehicle(client, "R-1")["id"])
    we_owe = make_we_owe(client, "Dana Ruiz", "Fix mirror")
    second = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": we_owe["id"]})
    assert second.status_code == 201, second.text
    third = make_retail_order(client)

    numbers = [first["ro_number"], second.json()["ro_number"], third["ro_number"]]
    assert numbers == [1, 2, 3], "numbers run in one sequence regardless of what kind of work it is"
    assert len(set(numbers)) == 3


def test_ro_number_survives_alongside_the_long_form(client):
    """The long RO-2607-0012 form stays exactly as it was -- already-posted
    vendor invoices refer to it, so it cannot be rewritten underneath them."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    assert order["ro_number"] == 1
    assert order["number"].startswith("RO-")


def test_existing_tickets_are_numbered_oldest_first(client, db_path):
    """A shop upgrading to this has open tickets already. They get numbered by
    the day they were written, so the numbering matches the order the work
    actually happened in rather than whatever order the rows sit in."""
    with connect(db_path) as db:
        customer_id = db.execute(
            "INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES('Legacy','','',0,'2026-01-01')"
        ).lastrowid
        vehicle_id = db.execute(
            "INSERT INTO vehicles(customer_id,year,make,model,created_at) VALUES(?,2020,'Kia','Soul','2026-01-01')",
            (customer_id,),
        ).lastrowid
        # Deliberately inserted newest-first, so "oldest first" cannot pass by
        # accidentally agreeing with insertion order.
        for number, created in (("RO-OLD-3", "2026-03-01"), ("RO-OLD-1", "2026-01-01"), ("RO-OLD-2", "2026-02-01")):
            db.execute(
                "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,status,created_at)"
                " VALUES(?,?,?,'Legacy','retail','estimate',?)",
                (number, customer_id, vehicle_id, created),
            )
        db.commit()

    init_db(db_path)  # every app start runs the migration

    with connect(db_path) as db:
        numbered = {r["number"]: r["ro_number"] for r in db.execute("SELECT number, ro_number FROM orders")}
    assert numbered["RO-OLD-1"] == 1
    assert numbered["RO-OLD-2"] == 2
    assert numbered["RO-OLD-3"] == 3


def test_renumbering_is_idempotent_and_never_reissues(client, db_path):
    """Running the migration again must not renumber anything -- those numbers
    are on vendor paperwork by then. A ticket arriving unnumbered from an older
    backup gets the next free number, not one already in use."""
    make_recon_order(client, make_recon_vehicle(client, "R-77")["id"])
    with connect(db_path) as db:
        before = {r["number"]: r["ro_number"] for r in db.execute("SELECT number, ro_number FROM orders")}
        row = db.execute("SELECT customer_id, vehicle_id FROM orders LIMIT 1").fetchone()
        db.execute(
            "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,status,created_at)"
            " VALUES('RO-RESTORED',?,?,'From an old backup','retail','estimate','2020-01-01')",
            (row["customer_id"], row["vehicle_id"]),
        )
        db.commit()

    init_db(db_path)

    with connect(db_path) as db:
        after = {r["number"]: r["ro_number"] for r in db.execute("SELECT number, ro_number FROM orders")}
    for number, value in before.items():
        assert after[number] == value, f"{number} was renumbered -- vendor paperwork now points at the wrong ticket"
    # Backdated to 2020 but still numbered last: it continues the sequence
    # rather than taking a number somebody is already holding.
    assert after["RO-RESTORED"] == max(before.values()) + 1


# --- PO numbers ---


def test_po_number_is_the_ro_number_and_the_batch(client):
    assert purchase_order_number(20, 2) == "R20-2"


def test_batches_count_within_the_ticket(client):
    """RO 20's batches are R20-1, R20-2, R20-3 no matter what other cars are
    doing -- the sequence is per ticket, not shop-wide."""
    order = make_recon_order(client, make_recon_vehicle(client, "R-5")["id"])
    other = make_recon_order(client, make_recon_vehicle(client, "R-6")["id"])

    first = client.post(f"/api/orders/{order['id']}/purchase-orders").json()
    client.post(f"/api/orders/{other['id']}/purchase-orders")  # a different car in between
    second = client.post(f"/api/orders/{order['id']}/purchase-orders").json()

    assert first["number"] == f"R{order['ro_number']}-1"
    assert second["number"] == f"R{order['ro_number']}-2"


def test_the_r_prefix_marks_it_as_recon_not_tekmetric(client):
    """Both systems send POs to the same suppliers, so a bill has to say which
    one it came from without anybody having to look it up."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    created = client.post(f"/api/orders/{order['id']}/purchase-orders").json()
    assert created["number"].startswith("R")


def test_ordering_parts_puts_them_all_on_one_batch(client):
    """The shop orders in batches -- one call, several parts -- so one click
    produces one PO number covering exactly the parts it moved."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1"), part("Rotors", "RT-1")])

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()
    assert res["updated"] == 2
    assert res["purchase_order"]["number"] == f"R{order['ro_number']}-1"

    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert {i["po_number"] for i in items if i["kind"] == "part"} == {f"R{order['ro_number']}-1"}


def test_a_second_order_on_the_same_ticket_gets_its_own_number(client):
    """The whole point: four orders against one car must not share a PO."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    first = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]

    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    save_estimate(
        client,
        order["id"],
        [{**part("Brake pads", "BP-1"), "id": items[0]["id"]}, part("Caliper", "CAL-9")],
    )
    second = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]

    assert first["number"] != second["number"]
    assert second["number"] == f"R{order['ro_number']}-2"


def test_a_number_pulled_before_the_call_is_the_one_the_parts_land_on(client):
    """The real sequence: pull a number, phone the vendor, then mark the parts
    ordered. Those parts have to end up on the number already quoted, not on a
    fresh one the vendor has never heard of."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])

    pulled = client.post(f"/api/orders/{order['id']}/purchase-orders").json()
    ordered = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()

    assert ordered["purchase_order"]["number"] == pulled["number"]
    assert len(client.get(f"/api/orders/{order['id']}/purchase-orders").json()) == 1, "no phantom second batch"


def test_ordering_nothing_does_not_burn_a_number(client):
    """A click that moves no parts must not litter the ticket with empty POs."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diagnose", "quantity": 1, "unit_price": 0}])

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()
    assert res["updated"] == 0
    assert res["purchase_order"] is None
    assert client.get(f"/api/orders/{order['id']}/purchase-orders").json() == []


def test_a_used_number_is_never_handed_out_twice(client):
    """A batch emptied by deleting its line is still a number a vendor holds.
    Reissuing it would put two deliveries under one PO -- the original bug, in
    a new costume."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    used = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]

    save_estimate(client, order["id"], [part("Caliper", "CAL-9")])  # the ordered line is dropped
    reordered = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]

    assert reordered["number"] != used["number"]


def test_an_unused_number_can_be_taken_back_but_a_used_one_cannot(client):
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    spare = client.post(f"/api/orders/{order['id']}/purchase-orders").json()
    assert client.delete(f"/api/orders/{order['id']}/purchase-orders/{spare['id']}").status_code == 204

    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    used = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]
    refused = client.delete(f"/api/orders/{order['id']}/purchase-orders/{used['id']}")
    assert refused.status_code == 409


def test_marking_one_line_ordered_joins_the_same_batch(client):
    """Ticking two parts individually and pressing the button once have to give
    the vendor the same number, or the two halves of one phone call end up on
    two POs."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1"), part("Rotors", "RT-1")])
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]

    for item in items:
        res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/status", json={"status": "ordered"})
        assert res.status_code == 200, res.text

    after = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert len({i["po_number"] for i in after}) == 1


def test_putting_a_line_back_to_quoted_takes_it_off_the_batch(client):
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    item_id = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]["id"]
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "quoted"})
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert item["po_number"] is None


# --- Receiving and A/P ---


def test_the_vendor_invoice_carries_the_batch_number(client):
    """The number on our bill has to be the number on theirs, or the two
    documents cannot be made to agree."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    batch = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    item_id = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "WP-1"},
    )
    assert res.status_code == 200, res.text

    invoices = client.get("/api/ap/invoices").json()
    posted = next(i for i in invoices if i["invoice_number"] == "WP-1")
    assert posted["po_number"] == batch["number"]


def test_parts_received_without_a_batch_still_reference_the_ticket(client):
    """Lines that predate purchase orders, and parts received without ever
    having been marked ordered, keep the reference this column always held."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    item_id = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]["id"]

    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "NP-1"},
    )
    posted = next(i for i in client.get("/api/ap/invoices").json() if i["invoice_number"] == "NP-1")
    assert posted["po_number"] == order["number"]


def test_an_invoice_quoting_a_po_number_finds_its_ticket(client):
    """What the whole feature is for at the A/P end: the bill comes back
    naming R20-2 and lands on the right car by itself."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    save_estimate(client, order["id"], [part("Brake pads", "BP-1")])
    batch = client.patch(f"/api/orders/{order['id']}/estimate/order-parts").json()["purchase_order"]

    res = client.post(
        "/api/agent/invoices/process",
        json={
            "invoice_number": "WP-9001",
            "vendor_name": "WorldPac",
            "po_number": batch["number"],
            "subtotal": 10,
            "tax": 0,
            "total": 10,
            "items": [
                {"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 10, "kind": "part"}
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["order_id"] == order["id"]


def test_a_po_number_is_not_confused_with_a_repair_order_number(client):
    """The hyphen in R20-2 separates the ticket from the batch. Strip it, as
    the general-purpose normaliser does, and R20-2 becomes R202 -- which is
    repair order 202 wearing a disguise."""
    assert normalize_po_reference("R20-2") == "R20-2"
    assert normalize_po_reference("PO R20-2") == "R20-2"
    assert normalize_po_reference("po r20-2") == "R20-2"
    assert normalize_po_reference("R20-2") != normalize_po_reference("R202")
    # A stock number that merely starts with those letters is left alone.
    assert normalize_po_reference("ROB-4") == "ROB-4"


# --- Stock numbers ---


def test_a_mistyped_stock_number_can_be_corrected(client):
    """It used to be write-once, so the only fix was deleting the car -- which
    is impossible once it has a repair order, and is how the same car ends up
    on the board twice."""
    vehicle = make_recon_vehicle(client, "R-1O42")  # letter O, typed for a zero
    make_recon_order(client, vehicle["id"])

    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"stock_number": "R-1042"})
    assert res.status_code == 200, res.text
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["stock_number"] == "R-1042"


def test_a_stock_number_cannot_be_moved_onto_another_car(client):
    taken = make_recon_vehicle(client, "R-2001")
    other = make_recon_vehicle(client, "R-2002")

    res = client.patch(f"/api/recon/vehicles/{other['id']}", json={"stock_number": "R-2001"})
    assert res.status_code == 409
    assert taken["stock_number"] in res.json()["detail"]


def test_respelling_a_stock_number_is_not_a_clash_with_itself(client):
    """R-1042 and R1042 are one number written two ways, so tidying the
    punctuation must not read as a collision with the car's own record."""
    vehicle = make_recon_vehicle(client, "R-3001")
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"stock_number": "R3001"})
    assert res.status_code == 200, res.text


def test_a_stock_number_cannot_be_blanked(client):
    """It is how the board, the reports and the lot sheet all find this car."""
    vehicle = make_recon_vehicle(client, "R-4001")
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"stock_number": "   "})
    assert res.status_code == 422
