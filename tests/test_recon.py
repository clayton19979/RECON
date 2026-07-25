from __future__ import annotations

from app.recon import age_days
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def test_create_recon_vehicle(client):
    vehicle = make_recon_vehicle(client)
    assert vehicle["stock_number"] == "R-1001"
    assert vehicle["status"] == "acquired"
    assert vehicle["total_cost"] == 0
    assert vehicle["quoted_cost"] == 0


def test_duplicate_stock_number_rejected(client):
    make_recon_vehicle(client, stock_number="R-2001")
    res = client.post(
        "/api/recon/vehicles",
        json={"stock_number": "R-2001", "year": 2020, "make": "Toyota", "model": "Camry"},
    )
    assert res.status_code == 409


def test_recon_patch_status_and_sale(client):
    vehicle = make_recon_vehicle(client)
    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"status": "sold", "sale_price": 8000, "sale_date": "2026-03-01"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "sold"
    # profit = sale_price - purchase_price - total_cost = 8000 - 4000 - 0
    assert body["profit"] == 4000


def test_recon_patch_edits_core_vehicle_info(client):
    """Correcting a typo'd purchase price or VIN shouldn't require touching
    the database directly."""
    vehicle = make_recon_vehicle(client, stock_number="R-2101", purchase_price=4000, vin="OLDVIN")
    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"purchase_price": 4500, "vin": "1hgcm82633a004352", "make": "Honda", "model": "Accord", "year": 2021, "mileage": 12345},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["purchase_price"] == 4500
    assert body["vin"] == "1HGCM82633A004352"  # normalized uppercase like creation does
    assert body["make"] == "Honda"
    assert body["model"] == "Accord"
    assert body["year"] == 2021
    assert body["mileage"] == 12345


def test_delete_recon_vehicle_without_orders(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2201")
    res = client.delete(f"/api/recon/vehicles/{vehicle['id']}")
    assert res.status_code == 204
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").status_code == 404
    assert not any(row["stock_number"] == "R-2201" for row in client.get("/api/vehicles-board").json())


def test_delete_recon_vehicle_with_orders_blocked(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2301")
    make_recon_order(client, vehicle["id"])
    res = client.delete(f"/api/recon/vehicles/{vehicle['id']}")
    assert res.status_code == 409
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").status_code == 200


def test_we_owe_requires_vehicle_belongs_to_customer(client):
    customer = client.post("/api/customers", json={"name": "A"}).json()
    other_customer = client.post("/api/customers", json={"name": "B"}).json()
    vehicle = client.post(
        "/api/vehicles", json={"customer_id": other_customer["id"], "year": 2020, "make": "Kia", "model": "Soul"}
    ).json()
    res = client.post(
        "/api/we-owe",
        json={"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": "Fix mirror"},
    )
    assert res.status_code == 400


def test_we_owe_fulfilled_sets_timestamp(client):
    item = make_we_owe(client)
    assert item["status"] == "open"
    res = client.patch(f"/api/we-owe/{item['id']}", json={"status": "fulfilled"})
    body = res.json()
    assert body["status"] == "fulfilled"
    assert body["fulfilled_at"]


def test_we_owe_patch_edits_vehicle_info(client):
    """A we-owe vehicle is sometimes entered quickly with the VIN added
    later -- same "edit vehicle info after the fact" capability recon
    vehicles already have, mirrored onto the shared vehicles row."""
    item = make_we_owe(client, description="Fix mirror")
    assert item["vin"] == ""
    res = client.patch(
        f"/api/we-owe/{item['id']}",
        json={"vin": "1hgcm82633a004352", "year": 2021, "make": "Honda", "model": "Accord", "trim": "EX", "mileage": 42000},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["vin"] == "1HGCM82633A004352"
    assert body["year"] == 2021
    assert body["make"] == "Honda"
    assert body["model"] == "Accord"
    assert body["trim"] == "EX"
    assert body["mileage"] == 42000

    reloaded = client.get(f"/api/we-owe/{item['id']}").json()
    assert reloaded["vin"] == "1HGCM82633A004352"


def test_we_owe_detail_includes_customer_contact_fields(client):
    item = make_we_owe(client, customer_name="Jordan Whitfield")
    detail = client.get(f"/api/we-owe/{item['id']}").json()
    assert detail["customer_name"] == "Jordan Whitfield"
    assert "customer_phone" in detail
    assert "customer_email" in detail


def test_we_owe_patch_edits_description_and_category(client):
    item = make_we_owe(client, description="Fix mirror")
    res = client.patch(
        f"/api/we-owe/{item['id']}",
        json={"description": "Replace passenger mirror", "category": "mirror", "target_date": "2026-08-01"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["description"] == "Replace passenger mirror"
    assert body["category"] == "mirror"
    assert body["target_date"] == "2026-08-01"


def test_delete_we_owe_item_without_orders(client):
    item = make_we_owe(client)
    res = client.delete(f"/api/we-owe/{item['id']}")
    assert res.status_code == 204
    assert client.get(f"/api/we-owe/{item['id']}").status_code == 404


def test_delete_we_owe_item_with_orders_blocked(client):
    item = make_we_owe(client)
    client.post("/api/orders", json={"concern": "Fix it", "segment": "we_owe", "we_owe_id": item["id"]})
    res = client.delete(f"/api/we-owe/{item['id']}")
    assert res.status_code == 409
    assert client.get(f"/api/we-owe/{item['id']}").status_code == 200


def test_we_owe_customer_deposit_reduces_net_cost(client):
    """Customers are sometimes talked into putting money down toward a
    we-owe repair -- that must show up separately from shop spend, netting
    against it, not just get lost."""
    item = make_we_owe(client, description="Fix AC")
    order = client.post("/api/orders", json={"concern": "AC repair", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 200, "unit_cost": 200}])

    res = client.post(f"/api/we-owe/{item['id']}/payments", json={"amount": 75, "method": "cash", "note": "Down payment"})
    assert res.status_code == 201
    body = res.json()
    assert body["customer_paid"] == 75
    assert body["net_cost"] == 125  # 200 - 75
    assert len(body["payments"]) == 1

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["customer_paid"] == 75
    assert row["net_cost"] == 125

    payment_id = body["payments"][0]["id"]
    res = client.delete(f"/api/we-owe/{item['id']}/payments/{payment_id}")
    assert res.status_code == 204
    detail = client.get(f"/api/we-owe/{item['id']}").json()
    assert detail["customer_paid"] == 0
    assert detail["net_cost"] == 200


def test_we_owe_board_status_tracks_ticket_while_open(client):
    """The vehicle board must show the linked ticket's own workflow status
    (estimate/pending_approval/in_progress/complete) while the we-owe promise
    is still 'open', the same way recon rows already track their ticket --
    otherwise progressing the ticket never shows up on the board at all."""
    item = make_we_owe(client, description="Fix AC")
    order = client.post("/api/orders", json={"concern": "AC repair", "segment": "we_owe", "we_owe_id": item["id"]}).json()

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["status"] == "estimate"
    assert row["status_bucket"] == "in_progress"

    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["status"] == "in_progress"
    assert row["status_bucket"] == "in_progress"

    # Explicitly marking the promise fulfilled overrides the ticket status
    # and moves it to the finished bucket, regardless of the ticket's status.
    client.patch(f"/api/we-owe/{item['id']}", json={"status": "fulfilled"})
    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["status"] == "fulfilled"
    assert row["status_bucket"] == "finished"


def test_we_owe_board_status_before_any_ticket_is_open(client):
    item = make_we_owe(client, description="Fix AC")
    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["status"] == "open"


def test_we_owe_payment_requires_positive_amount(client):
    item = make_we_owe(client)
    res = client.post(f"/api/we-owe/{item['id']}/payments", json={"amount": 0})
    assert res.status_code == 422


def test_vehicle_board_rows_include_age_days(client):
    make_recon_vehicle(client, stock_number="R-6701")
    board = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert board[0]["age_days"] == 0  # created moments ago


def test_age_days_does_not_raise_on_malformed_timestamp(client):
    """age_days runs in a loop over every vehicle on the board -- one bad
    created_at (a hand-edited row, an old backup with a different format)
    must degrade to that one row looking wrong, never 500 the whole board."""
    assert age_days("not-a-timestamp") == 0
    assert age_days("") == 0
    assert age_days(None) == 0


def test_recon_patch_conflict_when_stale_version(client):
    """Two people editing the same car at once: the second save with a
    stale expected_version must be rejected, not silently overwrite."""
    vehicle = make_recon_vehicle(client, stock_number="R-6801")
    assert vehicle["edit_version"] == 1

    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"purchase_price": 5000, "expected_version": 1})
    assert res.status_code == 200
    assert res.json()["edit_version"] == 2

    # A second client still holding the old version=1 tries to save
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"purchase_price": 6000, "expected_version": 1})
    assert res.status_code == 409

    # Without expected_version, no conflict check is performed (backwards compatible)
    res = client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"notes": "no version check"})
    assert res.status_code == 200


def test_we_owe_patch_conflict_when_stale_version(client):
    item = make_we_owe(client)
    client.patch(f"/api/we-owe/{item['id']}", json={"category": "mirror", "expected_version": item["edit_version"]})
    res = client.patch(f"/api/we-owe/{item['id']}", json={"category": "seatbelt", "expected_version": item["edit_version"]})
    assert res.status_code == 409


def test_voided_order_does_not_count_toward_vehicle_cost(client):
    """A voided RO (started by mistake) is kept in the vehicle's order
    history for traceability but its cost must never count toward the
    vehicle's actual/quoted totals -- that work was never actually done."""
    vehicle = make_recon_vehicle(client, stock_number="R-4501")
    live_order = make_recon_order(client, vehicle["id"], concern="Real work")
    save_estimate(client, live_order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])

    mistake_order = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(client, mistake_order["id"], [{"kind": "part", "description": "Wrong part", "part_number": "X-1", "quantity": 1, "unit_price": 300, "unit_cost": 300}])
    client.post(f"/api/orders/{mistake_order['id']}/void", json={"actor": "Clay"})

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 100
    assert detail["quoted_cost"] == 100
    assert len(detail["orders"]) == 2  # still visible in history
    assert any(o["voided"] for o in detail["orders"])


def test_vehicles_board_merges_segments(client):
    make_recon_vehicle(client, stock_number="R-3001")
    make_we_owe(client)
    board = client.get("/api/vehicles-board").json()
    segments = {row["segment"] for row in board}
    assert segments == {"recon", "we_owe"}

    recon_only = client.get("/api/vehicles-board", params={"segment": "recon"}).json()
    assert all(row["segment"] == "recon" for row in recon_only)


def test_cost_rollup_actual_vs_quoted(client):
    """Core business rule: labor counts in full immediately; parts only
    count once received. quoted_cost always reflects the full estimate."""
    vehicle = make_recon_vehicle(client, stock_number="R-4001")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 2, "unit_price": 10, "unit_cost": 10},
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 50, "unit_cost": 50},
        ],
    )
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    # No parts received yet: actual = labor only = 50; quoted = full estimate = 2*10 + 50 = 70
    assert detail["total_cost"] == 50
    assert detail["quoted_cost"] == 70

    # Receive the part via a vendor invoice (the only way received_quantity changes)
    client.post("/api/vendors", json={"name": "PartsCo"})
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "PartsCo",
            "invoice_number": "INV-1",
            "po_number": order["number"],
            "subtotal": 20,
            "tax": 0,
            "total": 20,
            "items": [{"part_number": "BP-1", "description": "Brake pads", "quantity": 2, "unit_cost": 10, "kind": "part"}],
        },
    )
    assert res.json()["status"] == "posted", res.text

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 70  # now fully landed
    assert detail["quoted_cost"] == 70


def test_board_reports_parts_ordered_but_not_received(client):
    """The board's Parts column and its "Waiting on parts" card both come
    from parts_pending, which counts part lines a vendor owes the shop:
    'ordered' and nothing else. A quoted line nobody has actually ordered
    isn't something anyone is waiting on, labor is never pending, and a
    received line has landed -- counting any of those would light up the
    whole board and make the column mean nothing."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-7100")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 2, "unit_price": 10, "unit_cost": 15},
            {"kind": "part", "description": "Rotors", "part_number": "RT-1", "quantity": 1, "unit_price": 30, "unit_cost": 40},
            {"kind": "labor", "description": "Install", "quantity": 3, "unit_price": 50, "unit_cost": 50},
        ],
    )

    def row():
        board = client.get("/api/vehicles-board").json()
        return next(r for r in board if r["recon_id"] == vehicle["id"])

    # Quoted, not ordered: nobody is waiting on anything yet.
    assert row()["parts_pending"] == 0
    assert row()["parts_pending_value"] == 0

    # Ordered: both part lines are outstanding, labor is not.
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert row()["parts_pending"] == 2
    # 2 * 15 + 1 * 40 -- full ordered quantity at cost, not the received one
    assert row()["parts_pending_value"] == 70

    # order-parts only ever touches part lines, so labor never reaches
    # 'ordered' by that route -- but the per-line status endpoint takes any
    # line and doesn't look at its kind, so a labor line can carry the status.
    # It's still not something a vendor owes the shop: without the kind='part'
    # filter this would read 3 pending worth $220.
    labor = next(i for i in estimate["items"] if i["kind"] == "labor")
    assert client.patch(
        f"/api/orders/{order['id']}/estimate/items/{labor['id']}/status", json={"status": "ordered"}
    ).status_code == 200
    assert row()["parts_pending"] == 2, "a labor line marked 'ordered' counted as a part on order"
    assert row()["parts_pending_value"] == 70

    # Receiving one line drops it out of the count.
    pads = next(i for i in estimate["items"] if i["part_number"] == "BP-1")
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [pads["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-77"},
    )
    assert res.status_code == 200, res.text
    assert row()["parts_pending"] == 1
    assert row()["parts_pending_value"] == 40


def test_board_parts_pending_ignores_returned_and_voided(client):
    """A line sent back to the vendor isn't something the shop is still
    waiting on, and a voided RO's lines were never really ordered -- both
    already drop out of cost, and both have to drop out of the count for the
    same reason."""
    vehicle = make_recon_vehicle(client, stock_number="R-7200")
    kept = make_recon_order(client, vehicle["id"])
    save_estimate(client, kept["id"], [
        {"kind": "part", "description": "Filter", "part_number": "F-1", "quantity": 1, "unit_price": 9, "unit_cost": 9},
    ])
    client.patch(f"/api/orders/{kept['id']}/estimate/order-parts")

    voided = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    estimate = save_estimate(client, voided["id"], [
        {"kind": "part", "description": "Alternator", "part_number": "ALT-1", "quantity": 1, "unit_price": 300, "unit_cost": 300},
    ])
    client.patch(f"/api/orders/{voided['id']}/estimate/order-parts")

    def row():
        board = client.get("/api/vehicles-board").json()
        return next(r for r in board if r["recon_id"] == vehicle["id"])

    assert row()["parts_pending"] == 2, "both ordered lines should count before anything is voided"

    res = client.post(f"/api/orders/{voided['id']}/void", json={"actor": "tester"})
    assert res.status_code == 200, res.text
    assert row()["parts_pending"] == 1, "a voided RO's ordered parts still count as pending"
    assert row()["parts_pending_value"] == 9

    # A returned line put back to 'ordered'. Only a *received* part can be
    # returned, so this is the one route by which a returned line carries the
    # ordered status: receive it, send it back to the vendor, then re-order a
    # replacement against the same line. Without the part_returned guard the
    # board would say the shop is waiting on a part it decided not to keep.
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    item_id = client.get(f"/api/orders/{kept['id']}").json()["estimate"]["items"][0]["id"]
    assert client.post(
        f"/api/orders/{kept['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-9"},
    ).status_code == 200
    assert row()["parts_pending"] == 0, "a received part is not still pending"
    assert client.patch(
        f"/api/orders/{kept['id']}/estimate/items/{item_id}/part-return",
        json={"returned": True, "actor": "tester"},
    ).status_code == 200
    assert client.patch(
        f"/api/orders/{kept['id']}/estimate/items/{item_id}/status", json={"status": "ordered"}
    ).status_code == 200
    assert row()["parts_pending"] == 0, "a returned part put back to 'ordered' counts as pending"


def test_we_owe_board_row_carries_parts_pending(client):
    """Both halves of the board are one list on screen, so a field that only
    exists on recon rows shows a blank column for every we-owe car."""
    item = make_we_owe(client, description="Replace mirror")
    order = client.post(
        "/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": item["id"]}
    ).json()
    save_estimate(client, order["id"], [
        {"kind": "part", "description": "Mirror", "part_number": "M-1", "quantity": 1, "unit_price": 120, "unit_cost": 85},
    ])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["parts_pending"] == 1
    assert row["parts_pending_value"] == 85
