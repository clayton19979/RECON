from __future__ import annotations

import sqlite3

from app.db import init_db
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
