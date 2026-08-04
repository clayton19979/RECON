from __future__ import annotations

import sqlite3

from app.db import connect, init_db
from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def test_ap_order_link_migration_keeps_every_line_item(tmp_path):
    """ap_invoice_items references ap_invoices with ON DELETE CASCADE, and
    DROP TABLE fires cascades while foreign keys are on -- rebuilding the
    table the obvious way would silently delete every invoice line in the
    database. This is the regression test for that."""
    path = tmp_path / "legacy.db"
    init_db(path)

    # Put the table back into its pre-migration shape, with data behind it.
    con = sqlite3.connect(path)
    con.executescript("""
        PRAGMA foreign_keys=OFF;
        DROP TABLE ap_invoices;
        CREATE TABLE ap_invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vendor_id INTEGER NOT NULL REFERENCES vendors(id),
          order_id INTEGER NOT NULL REFERENCES orders(id),
          invoice_number TEXT NOT NULL, normalized_invoice_number TEXT NOT NULL,
          po_number TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL,
          total REAL NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
          posted_at TEXT NOT NULL, UNIQUE(vendor_id, normalized_invoice_number));
        INSERT INTO customers(id,name,phone,email,is_shop_owned,created_at) VALUES(9,'C','','',0,'t');
        INSERT INTO vehicles(id,customer_id,year,make,model,created_at) VALUES(9,9,2020,'Kia','Soul','t');
        INSERT INTO orders(id,number,customer_id,vehicle_id,concern,created_at) VALUES(9,'RO-9',9,9,'x','t');
        INSERT INTO vendors(id,name,normalized_name,aliases,created_at) VALUES(9,'V','v','[]','t');
        INSERT INTO ap_invoices VALUES(1,9,9,'INV-1','inv1','PO',10,0,10,'posted','ui','t');
        INSERT INTO ap_invoice_items(ap_invoice_id,part_number,description,quantity,unit_cost,line_total)
          VALUES(1,'P1','Part one',1,10,10),(1,'P2','Part two',2,5,10);
    """)
    con.commit()
    con.close()

    init_db(path)
    init_db(path)  # idempotent: a second start must not rebuild again

    con = sqlite3.connect(path)
    assert con.execute("SELECT count(*) FROM ap_invoice_items").fetchone()[0] == 2
    assert con.execute("SELECT count(*) FROM ap_invoices").fetchone()[0] == 1
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    order_id_notnull = {r[1]: r[3] for r in con.execute("PRAGMA table_info(ap_invoices)")}["order_id"]
    assert order_id_notnull == 0, "order_id must be nullable after the migration"


def post_invoice(client, **overrides):
    payload = {
        "vendor_name": "WorldPac",
        "invoice_number": "INV-100",
        "po_number": "RO-DOES-NOT-EXIST",
        "subtotal": 45,
        "tax": 0,
        "total": 45,
        "items": [
            {"part_number": "BP-100", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}
        ],
    }
    payload.update(overrides)
    return client.post("/api/agent/invoices/process", json=payload)


def test_vendor_crud_and_duplicate(client):
    res = client.post("/api/vendors", json={"name": "WorldPac", "aliases": ["World Pac"]})
    assert res.status_code == 201
    res = client.post("/api/vendors", json={"name": "WorldPac"})
    assert res.status_code == 409


def test_vendor_can_be_corrected(client):
    vendor = client.post("/api/vendors", json={"name": "Wrldpac Typo"}).json()
    res = client.patch(
        f"/api/vendors/{vendor['id']}", json={"name": "WorldPac", "aliases": ["World Pac"], "account_number": "ACCT-1"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "WorldPac"
    assert body["aliases"] == ["World Pac"]
    assert body["account_number"] == "ACCT-1"


def test_vendor_update_rejects_name_collision(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    other = client.post("/api/vendors", json={"name": "NAPA"}).json()
    res = client.patch(f"/api/vendors/{other['id']}", json={"name": "WorldPac"})
    assert res.status_code == 409


def test_vendor_update_unknown_404s(client):
    res = client.patch("/api/vendors/99999", json={"name": "Anything"})
    assert res.status_code == 404


def test_vendor_list_reports_when_each_was_last_bought_from(client):
    """The receive dialog has to guess a vendor, and guessing the one that
    sorts first alphabetically is how it guessed wrong every time. This is the
    field it guesses from: a vendor never bought from reports "", and the list
    itself stays sorted by name so the dropdown doesn't shuffle."""
    napa = client.post("/api/vendors", json={"name": "NAPA"}).json()
    client.post("/api/vendors", json={"name": "WorldPac"})
    _, order, item_ids = parts_ticket(client, "R-8100", [("Alternator", "ALT-1", 150)])
    receive(client, order["id"], item_ids, napa["id"], "NAPA-1")

    vendors = client.get("/api/vendors").json()
    assert [v["name"] for v in vendors] == ["NAPA", "WorldPac"], "the list must stay alphabetical"
    by_name = {v["name"]: v for v in vendors}
    assert by_name["NAPA"]["last_invoice_at"], "a vendor just bought from reports no purchase"
    assert by_name["WorldPac"]["last_invoice_at"] == "", "a vendor never bought from must report nothing"


def test_voided_invoice_does_not_keep_a_vendor_looking_current(client):
    """A bill taken back is a purchase that never happened -- everywhere else
    in the app a voided invoice counts for nothing, and it must not go on
    nominating a vendor as the one the shop most recently dealt with."""
    vendor = client.post("/api/vendors", json={"name": "NAPA"}).json()
    _, order, item_ids = parts_ticket(client, "R-8101", [("Alternator", "ALT-1", 150)])
    invoice_id = receive(client, order["id"], item_ids, vendor["id"], "NAPA-2")["ap_invoice_id"]
    assert client.get("/api/vendors").json()[0]["last_invoice_at"]

    client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})
    assert client.get("/api/vendors").json()[0]["last_invoice_at"] == ""


def test_process_invoice_unknown_vendor_is_still_held(client):
    res = post_invoice(client)
    body = res.json()
    assert body["status"] == "review_required"
    assert any("Vendor" in issue for issue in body["issues"])


def test_unmatched_po_no_longer_holds_an_invoice(client):
    """A PO reference that doesn't name a repair order used to send the whole
    invoice to review. Plenty of real vendor bills -- shop supplies, a bulk
    oil delivery, a tool purchase -- have no ticket behind them at all, so an
    unmatched reference posts as a general expense instead of being blocked."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    body = post_invoice(client, po_number="COUNTER-4471").json()

    assert body["status"] == "posted"
    assert body["order_id"] is None
    assert body["issues"] == []


def test_invoice_with_no_reference_at_all_posts(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    body = post_invoice(client, po_number="").json()
    assert body["status"] == "posted", body


def test_ticketless_invoice_shows_up_in_the_ap_list(client):
    """An inner join on orders used to hide these entirely -- money owed to a
    vendor that appeared nowhere on the A/P screen."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    post_invoice(client, po_number="SHOP-SUPPLIES")

    rows = client.get("/api/ap/invoices").json()
    assert len(rows) == 1
    assert rows[0]["order_id"] is None
    assert rows[0]["vehicle_label"] == "No ticket"
    assert rows[0]["total"] == 45


def test_ticketless_invoice_can_be_voided(client):
    """Voiding writes to the per-ticket activity log, which a ticketless
    invoice has no place in -- it must not blow up on the way through."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    posted = post_invoice(client, po_number="SHOP-SUPPLIES").json()

    res = client.patch(f"/api/ap/invoices/{posted['ap_invoice_id']}/void", json={"actor": "clay"})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "voided"


def test_explicit_order_id_beats_a_misleading_reference(client):
    """A chosen ticket is a statement of fact; a reference number that happens
    to look like another RO must not override it."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-6001")
    order = make_recon_order(client, vehicle["id"])

    body = post_invoice(client, order_id=order["id"], po_number="SOME-OTHER-REF").json()
    assert body["status"] == "posted", body
    assert body["order_id"] == order["id"]


def test_large_invoice_no_longer_needs_approval(client):
    """The $500 ceiling used to push any larger invoice to review_required
    instead of posting it. Removed at the shop's request."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-6002")
    order = make_recon_order(client, vehicle["id"])

    body = post_invoice(
        client,
        order_id=order["id"],
        subtotal=1750,
        total=1750,
        items=[
            {"part_number": "TRANS-1", "description": "Transmission", "quantity": 1, "unit_cost": 1750, "kind": "part"}
        ],
    ).json()
    assert body["status"] == "posted", body
    assert body["issues"] == []


def test_process_invoice_keeps_part_and_labor_separate_when_codes_collide(client):
    """merged_items used to collapse repeated line items keyed only by
    normalized part number -- a part and a labor line sharing the same code
    (e.g. a generic 'MISC' catch-all) got merged into one row of whichever
    kind was seen first, with quantities summed across two unrelated things."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-5010")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Misc part",
                "part_number": "MISC",
                "quantity": 1,
                "unit_price": 20,
                "unit_cost": 20,
            }
        ],
    )

    res = post_invoice(
        client,
        po_number=order["number"],
        subtotal=65,
        total=65,
        items=[
            {"part_number": "MISC", "description": "Misc part", "quantity": 1, "unit_cost": 20, "kind": "part"},
            {"part_number": "MISC", "description": "Shop labor", "quantity": 1.5, "unit_cost": 30, "kind": "labor"},
        ],
    )
    assert res.json()["status"] == "posted", res.json()

    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    by_kind = {i["kind"]: i for i in items}
    assert set(by_kind) == {"part", "labor"}  # two distinct lines, not merged into one
    assert by_kind["part"]["received_quantity"] == 1
    assert by_kind["labor"]["quantity"] == 1.5


def test_process_invoice_posts_and_receives_parts(client):
    client.post("/api/vendors", json={"name": "WorldPac", "aliases": ["World Pac"]})
    vehicle = make_recon_vehicle(client, stock_number="R-5001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-100",
                "quantity": 2,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    res = post_invoice(
        client,
        vendor_name="World Pac",  # alias match
        po_number=order["number"],
        subtotal=90,
        total=90,
        items=[{"part_number": "bp-100", "description": "Brake pads", "quantity": 2, "unit_cost": 45, "kind": "part"}],
    )
    body = res.json()
    assert body["status"] == "posted", body

    updated = client.get(f"/api/orders/{order['id']}").json()
    part = updated["estimate"]["items"][0]
    assert part["received_quantity"] == 2
    assert part["status"] == "received"

    invoices = client.get("/api/ap/invoices").json()
    posted = next(i for i in invoices if i["invoice_number"] == "INV-100")
    assert posted["po_number"] == order["number"]
    assert posted["vehicle_label"] == "R-5001"  # PO# -> RO# -> stock# traceability
    assert posted["recon_vehicle_id"] == vehicle["id"]  # lets the UI click through to the vehicle


def test_void_ap_invoice_and_repost_under_same_number(client):
    """Voiding a mis-posted invoice (wrong vendor match, duplicate, etc.)
    must free up its invoice number -- otherwise a corrected re-post of the
    same real vendor invoice is permanently blocked as a 'duplicate'. Posted
    against a second, unrelated order so the retry isn't also tripped up by
    the (correct, separate) exceeds-ordered-quantity guard from receiving
    the first order's part twice."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-5002")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    res = post_invoice(
        client,
        vendor_name="WorldPac",
        po_number=order["number"],
        subtotal=45,
        total=45,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )
    invoice_id = client.get("/api/ap/invoices").json()[0]["id"]
    assert res.json()["status"] == "posted"

    res = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})
    assert res.status_code == 200
    assert res.json()["status"] == "voided"

    invoices = client.get("/api/ap/invoices").json()
    assert next(i for i in invoices if i["id"] == invoice_id)["status"] == "voided"

    vehicle2 = make_recon_vehicle(client, stock_number="R-5002B")
    order2 = make_recon_order(client, vehicle2["id"])
    save_estimate(
        client,
        order2["id"],
        [
            {
                "kind": "part",
                "description": "Rotors",
                "part_number": "RT-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )

    # Re-posting the exact same invoice number now succeeds instead of
    # being rejected as a duplicate of the voided one.
    res = post_invoice(
        client,
        vendor_name="WorldPac",
        po_number=order2["number"],
        subtotal=45,
        total=45,
        items=[{"part_number": "RT-1", "description": "Rotors", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )
    assert res.json()["status"] == "posted"


def test_void_ap_invoice_twice_rejected(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-5003")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    post_invoice(
        client,
        vendor_name="WorldPac",
        po_number=order["number"],
        subtotal=45,
        total=45,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )
    invoice_id = client.get("/api/ap/invoices").json()[0]["id"]

    client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})
    res = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})
    assert res.status_code == 409


def test_void_ap_invoice_unknown_404s(client):
    res = client.patch("/api/ap/invoices/99999/void", json={"actor": "Clay"})
    assert res.status_code == 404


def receive(client, order_id, item_ids, vendor_id, invoice_number, **extra):
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor_id, "invoice_number": invoice_number, **extra},
    )
    assert res.status_code == 200, res.text
    return res.json()


def parts_ticket(client, stock_number, items):
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": description,
                "part_number": part_number,
                "quantity": 1,
                "unit_price": cost,
                "unit_cost": cost,
            }
            for description, part_number, cost in items
        ],
    )
    return vehicle, order, [i["id"] for i in estimate["items"]]


def test_voiding_a_receipt_takes_its_cost_back_off_the_vehicle(client):
    """A vendor invoice is how a part's cost lands on a car, so voiding one
    has to take that cost back off. It used to void the bill and leave the
    receipt: A/P dropped by $420 and the car's spend didn't move, with nothing
    on either screen to explain the gap -- and "what did we spend on this car"
    is the question the app exists to answer."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle, order, item_ids = parts_ticket(client, "R-7001", [("Windshield", "WS-1", 180), ("Rotors", "RT-1", 240)])
    invoice_id = receive(client, order["id"], item_ids, vendor["id"], "WP-9911")["ap_invoice_id"]
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["total_cost"] == 420

    res = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["unreceived_items"] == 2
    assert body["unreceived_value"] == 420

    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["total_cost"] == 0
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert [i["status"] for i in items] == ["ordered", "ordered"], "still outstanding, not back to a fresh quote"
    assert all(i["received_quantity"] == 0 for i in items)
    assert all(i["received_invoice_number"] == "" for i in items), "a voided number must not stay cited on the line"


def test_voiding_a_receipt_lets_the_corrected_invoice_be_posted(client):
    """The reason voiding had to undo the receipt. Receiving takes the whole
    outstanding quantity, so a line already marked received refuses a second
    receipt -- an advisor who voided a mistyped invoice could not then post
    the right one, and the only way out was to delete the line and retype it."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    _, order, item_ids = parts_ticket(client, "R-7002", [("Windshield", "WS-1", 180)])
    invoice_id = receive(client, order["id"], item_ids, vendor["id"], "WP-TYPO")["ap_invoice_id"]

    client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"})

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": "WP-9911"},
    )
    assert res.status_code == 200, res.text
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert items[0]["received_invoice_number"] == "WP-9911"


def test_voiding_an_invoice_that_covers_two_cars_clears_both(client):
    """One vendor invoice routinely covers parts for several cars. The whole
    bill is what was declared unreal, so every car it touched gets its money
    back -- including the ones it was extended onto after the first delivery,
    which is when the invoice stops naming any single ticket of its own."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    first_vehicle, first_order, first_items = parts_ticket(client, "R-7003", [("Axle", "AX-1", 200)])
    second_vehicle, second_order, second_items = parts_ticket(client, "R-7004", [("Mirror", "MR-1", 90)])

    invoice_id = receive(client, first_order["id"], first_items, vendor["id"], "WP-SHARED")["ap_invoice_id"]
    receive(client, second_order["id"], second_items, vendor["id"], "WP-SHARED")
    assert client.get("/api/ap/invoices").json()[0]["order_id"] is None, "a shared invoice names no single ticket"

    body = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"}).json()
    assert body["unreceived_items"] == 2
    assert client.get(f"/api/recon/vehicles/{first_vehicle['id']}").json()["total_cost"] == 0
    assert client.get(f"/api/recon/vehicles/{second_vehicle['id']}").json()["total_cost"] == 0
    for order in (first_order, second_order):
        actions = [e["action"] for e in client.get(f"/api/orders/{order['id']}").json()["activity"]]
        assert "ap_invoice_voided" in actions, "the ticket whose money moved has to say why"


def test_voiding_an_invoice_with_no_per_line_links_still_reverses(client):
    """ap_invoice_items only started recording which estimate line each billed
    line paid for once receiving on a ticket existed. Invoices posted through
    the agent endpoint -- and every invoice already in the shop's database
    from before that column -- carry no links, so the reversal falls back to
    the invoice number the receipt itself recorded."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle, order, _ = parts_ticket(client, "R-7005", [("Brake pads", "BP-100", 45)])
    post_invoice(client, po_number=order["number"])
    invoice_id = client.get("/api/ap/invoices").json()[0]["id"]
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["total_cost"] == 45

    body = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"}).json()
    assert body["unreceived_items"] == 1
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["total_cost"] == 0


def test_voiding_leaves_a_receipt_posted_under_another_invoice_alone(client, db_path):
    """Voiding undoes what *this* bill did, and nothing else. A line whose
    receipt now cites a different invoice belongs to that one, and stripping
    it would take real money off a car on the strength of a stale link.

    Receiving always takes the whole outstanding quantity, so the API cannot
    line this up on its own -- the receipt is repointed directly, the way a
    corrected re-post leaves it."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle, order, item_ids = parts_ticket(client, "R-7006", [("Windshield", "WS-1", 180)])
    invoice_id = receive(client, order["id"], item_ids, vendor["id"], "WP-TYPO")["ap_invoice_id"]
    with connect(db_path) as db:
        db.execute("UPDATE estimate_items SET received_invoice_number='WP-9911' WHERE id=?", (item_ids[0],))
        db.commit()

    body = client.patch(f"/api/ap/invoices/{invoice_id}/void", json={"actor": "Clay"}).json()
    assert body["unreceived_items"] == 0
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["total_cost"] == 180


def test_voiding_a_return_credit_puts_the_part_back_in_the_credit_queue(client):
    """The credit for a returned part is an A/P row like any other. Voiding it
    says the vendor never issued it, so the return goes back to Awaiting
    Credit where the real one can be posted against it."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    _, order, item_ids = parts_ticket(client, "R-7007", [("Alternator", "ALT-1", 150)])
    receive(client, order["id"], item_ids, vendor["id"], "WP-9911")
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/part-return", json={"actor": "Clay"})
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "CM-TYPO", "actor": "Clay"},
    )
    assert res.status_code == 200, res.text
    credit_id = res.json()["ap_invoice_id"]
    assert client.get("/api/returns").json()[0]["return_invoice_number"] == "CM-TYPO"

    body = client.patch(f"/api/ap/invoices/{credit_id}/void", json={"actor": "Clay"}).json()
    assert body["credits_cleared"] == 1
    assert client.get("/api/returns").json()[0]["return_invoice_number"] == ""

    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "CM-4402", "actor": "Clay"},
    )
    assert res.status_code == 200, res.text


def test_process_invoice_matches_po_by_stock_number(client):
    """Shops naturally give vendors the stock number as the PO reference
    (it's what's on the car) rather than the internal RO-2607-0012 format
    -- an invoice referencing the stock number must resolve to that
    vehicle's repair order just as well as the formal RO number would."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-9201")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    res = post_invoice(
        client,
        po_number="r-9201",  # lowercase, exactly what a vendor might scrawl on an invoice
        subtotal=45,
        total=45,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )
    assert res.json()["status"] == "posted", res.text
    assert res.json()["order_id"] == order["id"]


def test_process_invoice_duplicate_rejected(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-6001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    kwargs = {
        "po_number": order["number"],
        "items": [{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    }
    first = post_invoice(client, **kwargs)
    assert first.json()["status"] == "posted"
    second = post_invoice(client, **kwargs)
    assert second.json()["status"] == "duplicate"


def test_process_invoice_over_receipt_blocked(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-7001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    res = post_invoice(
        client,
        po_number=order["number"],
        subtotal=90,
        total=90,
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 2, "unit_cost": 45, "kind": "part"}],
    )
    body = res.json()
    assert body["status"] == "review_required"
    assert any("exceeds" in issue for issue in body["issues"])


def test_ap_invoices_filterable_by_date(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-8101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    post_invoice(
        client,
        po_number=order["number"],
        items=[{"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 45, "kind": "part"}],
    )

    all_invoices = client.get("/api/ap/invoices").json()
    assert any(i["invoice_number"] == "INV-100" for i in all_invoices)

    future_only = client.get("/api/ap/invoices", params={"start": "2099-01-01"}).json()
    assert future_only == []

    past_to_now = client.get("/api/ap/invoices", params={"start": "2000-01-01", "end": "2099-12-31"}).json()
    assert any(i["invoice_number"] == "INV-100" for i in past_to_now)


def test_process_invoice_totals_mismatch(client):
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-8001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 45,
                "unit_cost": 45,
            }
        ],
    )
    res = post_invoice(client, po_number=order["number"], subtotal=999, total=999)
    body = res.json()
    assert body["status"] == "review_required"
    assert any("subtotal" in issue.lower() for issue in body["issues"])


def test_vendor_credit_subtracts_from_the_cars_cost_instead_of_adding(client):
    """A credit is stored the way the vendor prints it -- positive quantity,
    positive unit cost -- so nothing in the row's own numbers says it subtracts.
    It used to add: a $150 credit raised the car's recon cost by $150, and the
    lifetime profit the vehicle_units design exists to answer was simply wrong,
    with nothing on screen to notice."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-9100")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 500,
                "unit_cost": 500,
            }
        ],
    )
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["quoted_cost"] == 500

    # The ordinary mixed invoice: the replacement part billed, the one it
    # replaced credited back. 500 - 150 = 350 is the vendor's own subtotal.
    body = post_invoice(
        client,
        invoice_number="INV-CR-1",
        order_id=order["id"],
        subtotal=350,
        tax=0,
        total=350,
        items=[
            {"part_number": "ALT-2", "description": "Alternator (replacement)", "quantity": 1, "unit_cost": 500},
            {
                "part_number": "ALT-1",
                "description": "Returned alternator",
                "quantity": 1,
                "unit_cost": 150,
                "kind": "credit",
            },
        ],
    ).json()
    # The arithmetic check has to agree the invoice adds up, or an everyday
    # mixed invoice gets held for review over a credit it accounted for.
    assert body["status"] == "posted", body

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    # 500 quoted + 500 replacement - 150 credit
    assert detail["quoted_cost"] == 850

    estimate = client.get(f"/api/orders/{order['id']}").json()["estimate"]
    credit = next(i for i in estimate["items"] if i["kind"] == "credit")
    assert credit["line_total"] == -150, "a credit that stores positive is a credit that adds"
    assert estimate["subtotal"] == 850


def test_an_estimate_carrying_a_credit_line_can_still_be_saved(client):
    """The grid resends every row it is showing on each autosave, credits
    included. 'credit' was not an accepted kind, so one credit on a ticket made
    the whole estimate unsaveable -- a 422 naming a field the advisor never
    touched -- and the credit's sign had to survive the round-trip too."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    vehicle = make_recon_vehicle(client, stock_number="R-9101")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 500,
                "unit_cost": 500,
            }
        ],
    )
    post_invoice(
        client,
        invoice_number="INV-CR-2",
        order_id=order["id"],
        subtotal=350,
        tax=0,
        total=350,
        items=[
            {"part_number": "ALT-2", "description": "Replacement", "quantity": 1, "unit_cost": 500},
            {"part_number": "ALT-1", "description": "Returned", "quantity": 1, "unit_cost": 150, "kind": "credit"},
        ],
    )
    estimate = client.get(f"/api/orders/{order['id']}").json()["estimate"]

    # Resend exactly what the grid would be holding, the credit row included.
    resent = [
        {
            "id": i["id"],
            "kind": i["kind"],
            "description": i["description"],
            "part_number": i["part_number"],
            "quantity": i["quantity"],
            "unit_price": i["unit_price"],
            "unit_cost": i["unit_cost"],
        }
        for i in estimate["items"]
    ]
    res = client.post(f"/api/orders/{order['id']}/estimate", json={"actor": "tester", "items": resent})
    assert res.status_code == 200, res.text

    saved = res.json()
    credit = next(i for i in saved["items"] if i["kind"] == "credit")
    assert credit["line_total"] == -150, "re-saving must not flip the credit back to positive"
    assert saved["subtotal"] == 850
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["quoted_cost"] == 850
