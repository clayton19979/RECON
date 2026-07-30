from __future__ import annotations

from app.db import connect
from app.recon import age_days
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


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
        json={
            "purchase_price": 4500,
            "vin": "1hgcm82633a004352",
            "make": "Honda",
            "model": "Accord",
            "year": 2021,
            "mileage": 12345,
        },
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
        json={
            "vin": "1hgcm82633a004352",
            "year": 2021,
            "make": "Honda",
            "model": "Accord",
            "trim": "EX",
            "mileage": 42000,
        },
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
    order = client.post(
        "/api/orders", json={"concern": "AC repair", "segment": "we_owe", "we_owe_id": item["id"]}
    ).json()
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 200, "unit_cost": 200}],
    )

    res = client.post(
        f"/api/we-owe/{item['id']}/payments", json={"amount": 75, "method": "cash", "note": "Down payment"}
    )
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
    order = client.post(
        "/api/orders", json={"concern": "AC repair", "segment": "we_owe", "we_owe_id": item["id"]}
    ).json()

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
    res = client.patch(
        f"/api/we-owe/{item['id']}", json={"category": "seatbelt", "expected_version": item["edit_version"]}
    )
    assert res.status_code == 409


def test_voided_order_does_not_count_toward_vehicle_cost(client):
    """A voided RO (started by mistake) is kept in the vehicle's order
    history for traceability but its cost must never count toward the
    vehicle's actual/quoted totals -- that work was never actually done."""
    vehicle = make_recon_vehicle(client, stock_number="R-4501")
    live_order = make_recon_order(client, vehicle["id"], concern="Real work")
    save_estimate(
        client,
        live_order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}],
    )

    mistake_order = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(
        client,
        mistake_order["id"],
        [
            {
                "kind": "part",
                "description": "Wrong part",
                "part_number": "X-1",
                "quantity": 1,
                "unit_price": 300,
                "unit_cost": 300,
            }
        ],
    )
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
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 2,
                "unit_price": 10,
                "unit_cost": 10,
            },
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
            "items": [
                {"part_number": "BP-1", "description": "Brake pads", "quantity": 2, "unit_cost": 10, "kind": "part"}
            ],
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
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 2,
                "unit_price": 10,
                "unit_cost": 15,
            },
            {
                "kind": "part",
                "description": "Rotors",
                "part_number": "RT-1",
                "quantity": 1,
                "unit_price": 30,
                "unit_cost": 40,
            },
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
    assert (
        client.patch(
            f"/api/orders/{order['id']}/estimate/items/{labor['id']}/status", json={"status": "ordered"}
        ).status_code
        == 200
    )
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
    save_estimate(
        client,
        kept["id"],
        [
            {
                "kind": "part",
                "description": "Filter",
                "part_number": "F-1",
                "quantity": 1,
                "unit_price": 9,
                "unit_cost": 9,
            },
        ],
    )
    client.patch(f"/api/orders/{kept['id']}/estimate/order-parts")

    voided = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(
        client,
        voided["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 300,
                "unit_cost": 300,
            },
        ],
    )
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
    assert (
        client.post(
            f"/api/orders/{kept['id']}/estimate/receive-parts",
            json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-9"},
        ).status_code
        == 200
    )
    assert row()["parts_pending"] == 0, "a received part is not still pending"
    assert (
        client.patch(
            f"/api/orders/{kept['id']}/estimate/items/{item_id}/part-return",
            json={"returned": True, "actor": "tester"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/orders/{kept['id']}/estimate/items/{item_id}/status", json={"status": "ordered"}
        ).status_code
        == 200
    )
    assert row()["parts_pending"] == 0, "a returned part put back to 'ordered' counts as pending"


def test_we_owe_board_row_carries_parts_pending(client):
    """Both halves of the board are one list on screen, so a field that only
    exists on recon rows shows a blank column for every we-owe car."""
    item = make_we_owe(client, description="Replace mirror")
    order = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Mirror",
                "part_number": "M-1",
                "quantity": 1,
                "unit_price": 120,
                "unit_cost": 85,
            },
        ],
    )
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")

    board = client.get("/api/vehicles-board", params={"segment": "we_owe"}).json()
    row = next(r for r in board if r["we_owe_id"] == item["id"])
    assert row["parts_pending"] == 1
    assert row["parts_pending_value"] == 85


# ---------------------------------------------------------------------------
# Idle time: how long since anything actually happened on a car.
#
# This is the number a manager reads the board for, and it is not age (which
# grows whether anyone touches the car or not) and not the vehicle row's
# updated_at (which only moves when the vehicle *record* is edited). It comes
# from orders.last_activity_at, bumped by every mutating route.
# ---------------------------------------------------------------------------


def board_row(client, recon_id):
    return next(r for r in client.get("/api/vehicles-board").json() if r["recon_id"] == recon_id)


def backdate_activity(db_path, order_id: int, when: str) -> None:
    """Push a ticket's last activity back in time. There's no API for "pretend
    nobody has touched this for a month" and freezing the clock would only
    prove the arithmetic, not that the column is wired to the right source."""
    with connect(db_path) as db:
        db.execute("UPDATE orders SET last_activity_at=? WHERE id=?", (when, order_id))
        db.commit()


def test_board_row_reports_idle_time_from_ticket_activity(client, db_path):
    """A car with no ticket falls back to its own timestamp; starting a ticket
    and then working on it is what moves the clock."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-1")
    row = board_row(client, vehicle["id"])
    assert row["last_activity_at"], "a vehicle with no ticket still needs a last-activity timestamp"
    assert row["idle_days"] == 0, "a vehicle created just now is not idle"

    order = make_recon_order(client, vehicle["id"])
    # Creating the ticket logs order_created, which is itself activity.
    assert board_row(client, vehicle["id"])["idle_days"] == 0

    # Backdate the ticket's activity to simulate a car nobody has touched.
    backdate_activity(db_path, order["id"], "2026-01-01T09:00:00")
    stale = board_row(client, vehicle["id"])
    assert stale["last_activity_at"] == "2026-01-01T09:00:00"
    assert stale["idle_days"] > 100, (
        f"a ticket last touched in January should read as long idle, got {stale['idle_days']}"
    )

    # ...and any real work on the ticket resets it. A status change is the
    # cheapest mutation that goes through record_activity.
    assert (
        client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "tester"}).status_code
        == 200
    )
    assert board_row(client, vehicle["id"])["idle_days"] == 0, "working the ticket didn't reset the idle clock"


def test_a_car_with_no_ticket_is_idle_since_it_landed_on_the_lot(client, db_path):
    """The worst case, and the one that used to report as freshly worked on: a
    car that's been sitting for weeks with no repair order ever written. Its
    only timestamps are its own, and updated_at moves on any record edit -- so
    reading that made every never-started car look touched today, hiding
    exactly the cars this column exists to surface."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-6")
    with connect(db_path) as db:
        db.execute(
            "UPDATE recon_vehicles SET created_at=? WHERE id=?",
            ("2026-06-01T09:00:00", vehicle["id"]),
        )
        db.commit()

    row = board_row(client, vehicle["id"])
    assert row["last_activity_at"] == "2026-06-01T09:00:00", (
        "a car with no ticket should be idle since it landed on the lot"
    )
    assert row["idle_days"] == row["age_days"], "with no ticket, idle time is the car's age"

    # ...and tidying up the record must not make it look worked on.
    assert client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"mileage": 71000}).status_code == 200
    assert board_row(client, vehicle["id"])["last_activity_at"] == "2026-06-01T09:00:00"


def test_patching_the_vehicle_record_does_not_reset_idle(client, db_path):
    """Fixing a VIN is a data correction, not work on the car. If it reset the
    clock, tidying up records would hide exactly the cars this column exists
    to surface."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-2", vin="OLDVIN")
    order = make_recon_order(client, vehicle["id"])
    backdate_activity(db_path, order["id"], "2026-02-01T09:00:00")
    before = board_row(client, vehicle["id"])["idle_days"]

    assert client.patch(f"/api/recon/vehicles/{vehicle['id']}", json={"vin": "1HGCM82633A004352"}).status_code == 200

    after = board_row(client, vehicle["id"])
    assert after["idle_days"] == before, "patching the vehicle record reset the idle clock"
    assert after["last_activity_at"] == "2026-02-01T09:00:00"


def test_saving_the_estimate_counts_as_activity(client, db_path):
    """Writing the parts/labor grid is the most common thing anyone does to a
    ticket and the one mutation that deliberately logs no activity event (it
    autosaves), so it has to bump the timestamp directly or a tech pricing a
    car out all morning would still show as idle."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-3")
    order = make_recon_order(client, vehicle["id"])
    backdate_activity(db_path, order["id"], "2026-03-01T09:00:00")
    assert board_row(client, vehicle["id"])["idle_days"] > 30

    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Diagnose", "quantity": 1, "unit_price": 120, "unit_cost": 60},
        ],
    )
    row = board_row(client, vehicle["id"])
    assert row["idle_days"] == 0, "saving the estimate grid didn't count as activity"
    assert row["last_activity_at"] > "2026-03-01T09:00:00"


def test_voided_tickets_do_not_keep_a_car_looking_active(client, db_path):
    """Voiding means the work never happened, which is the same reason a
    voided RO's cost never counts. A car whose only recent 'activity' was
    cancelling its ticket is idle."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-4")
    stale_order = make_recon_order(client, vehicle["id"], concern="Real work")
    voided = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    backdate_activity(db_path, stale_order["id"], "2026-04-01T09:00:00")

    # Voiding is itself an activity event, so the voided ticket now has the
    # newest timestamp of the two -- and must be ignored anyway.
    assert client.post(f"/api/orders/{voided['id']}/void", json={"actor": "tester"}).status_code == 200

    row = board_row(client, vehicle["id"])
    assert row["last_activity_at"] == "2026-04-01T09:00:00", (
        "a voided ticket's activity is keeping the car off the idle list"
    )


def test_we_owe_rows_carry_idle_time_too(client, db_path):
    """Both halves of the board are one list on screen, so a field only recon
    rows had would leave a blank column down every we-owe car."""
    item = make_we_owe(client, description="Replace mirror")
    order = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    backdate_activity(db_path, order["id"], "2026-05-01T09:00:00")

    row = next(r for r in client.get("/api/vehicles-board").json() if r["we_owe_id"] == item["id"])
    assert row["last_activity_at"] == "2026-05-01T09:00:00"
    assert row["idle_days"] > 30


def test_idle_days_survives_a_garbage_timestamp(client, db_path):
    """One hand-edited row or a restore from an older format must not 500 the
    whole board -- every other car's idle time is computed in the same loop."""
    vehicle = make_recon_vehicle(client, stock_number="R-IDLE-5")
    order = make_recon_order(client, vehicle["id"])
    backdate_activity(db_path, order["id"], "not-a-date")

    res = client.get("/api/vehicles-board")
    assert res.status_code == 200, res.text
    row = next(r for r in res.json() if r["recon_id"] == vehicle["id"])
    assert row["idle_days"] == 0


# ---------------------------------------------------------------------------
# "Last worked on, by whom" -- the vehicle-detail end of the board's Idle
# column, and the order_id the board hands to actions taken on a row.
# ---------------------------------------------------------------------------


def test_detail_names_who_last_worked_on_the_car(client):
    """The board says a car has been sitting; opening it should say what the
    last thing that happened to it actually was, not just when."""
    vehicle = make_recon_vehicle(client, stock_number="R-LW-1")
    order = make_recon_order(client, vehicle["id"])
    assert (
        client.patch(
            f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "Dana Ruiz"}
        ).status_code
        == 200
    )

    la = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["last_activity"]
    assert la["action"] == "status_changed"
    assert la["actor"] == "Dana Ruiz"
    assert la["idle_days"] == 0
    assert la["at"], "a vehicle with a ticket must carry a last-activity timestamp"


def test_detail_declines_to_attribute_an_unlogged_write(client, db_path):
    """Saving the estimate grid bumps the activity clock but deliberately logs
    no event (it autosaves; logging it would bury the log in noise). So the
    newest event can be older than the newest activity -- and captioning a
    fresh timestamp with a stale name would be a confident lie about who last
    touched the car. Better to say when and stop."""
    vehicle = make_recon_vehicle(client, stock_number="R-LW-2")
    order = make_recon_order(client, vehicle["id"])
    assert (
        client.patch(
            f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "Dana Ruiz"}
        ).status_code
        == 200
    )
    # Push every logged event into the past, then do an unlogged write.
    with connect(db_path) as db:
        db.execute("UPDATE activity_events SET created_at=? WHERE order_id=?", ("2026-01-01T09:00:00", order["id"]))
        db.commit()
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Diagnose", "quantity": 1, "unit_price": 120, "unit_cost": 60},
        ],
    )

    la = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["last_activity"]
    assert la["idle_days"] == 0, "the estimate save should still have moved the clock"
    assert la["action"] == "" and la["actor"] == "", (
        "an unlogged write was attributed to whoever happened to log the last event"
    )


def test_detail_last_activity_falls_back_to_acquisition(client, db_path):
    """A car with no ticket has no events at all -- the page still has to say
    something, and the honest answer is how long it's been on the lot."""
    vehicle = make_recon_vehicle(client, stock_number="R-LW-3")
    with connect(db_path) as db:
        db.execute("UPDATE recon_vehicles SET created_at=? WHERE id=?", ("2026-06-01T09:00:00", vehicle["id"]))
        db.commit()

    la = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["last_activity"]
    assert la["at"] == "2026-06-01T09:00:00"
    assert la["action"] == "" and la["actor"] == ""
    assert la["idle_days"] > 30


def test_detail_last_activity_ignores_voided_tickets(client, db_path):
    """Same rule the board follows: voiding a ticket means the work never
    happened, so it can't be the last thing that happened to the car."""
    vehicle = make_recon_vehicle(client, stock_number="R-LW-4")
    real = make_recon_order(client, vehicle["id"], concern="Real work")
    mistake = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    backdate_activity(db_path, real["id"], "2026-04-01T09:00:00")
    with connect(db_path) as db:
        db.execute("UPDATE activity_events SET created_at=? WHERE order_id=?", ("2026-04-01T09:00:00", real["id"]))
        db.commit()
    assert client.post(f"/api/orders/{mistake['id']}/void", json={"actor": "tester"}).status_code == 200

    la = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["last_activity"]
    assert la["at"] == "2026-04-01T09:00:00", "a voided ticket's activity is being read as the car's"
    assert la["actor"] != "tester", "the voided ticket's actor is being credited with the last work"


def test_we_owe_detail_carries_last_activity_too(client):
    """Both segments open the same detail page, so a field only recon had
    would leave the header line blank down every we-owe promise."""
    item = make_we_owe(client, description="Replace mirror")
    order = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    assert (
        client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "Chris"}).status_code
        == 200
    )

    la = client.get(f"/api/we-owe/{item['id']}").json()["last_activity"]
    assert la["actor"] == "Chris" and la["action"] == "status_changed"


def test_board_rows_carry_the_ticket_an_action_should_attach_to(client):
    """Actions taken on a board row (creating a follow-up task, say) link
    through this. The open ticket wins over a finished one, so a follow-up
    lands on the work in progress rather than on last month's closed RO."""
    vehicle = make_recon_vehicle(client, stock_number="R-OID-1")
    assert board_row(client, vehicle["id"])["order_id"] is None, "a car with no ticket should offer nothing to link to"

    done = make_recon_order(client, vehicle["id"], concern="Finished job")
    assert (
        client.patch(f"/api/orders/{done['id']}/status", json={"status": "complete", "actor": "tester"}).status_code
        == 200
    )
    assert board_row(client, vehicle["id"])["order_id"] == done["id"], (
        "with only a closed ticket, that's still the one to link to"
    )

    # The open ticket is deliberately the *older* of the two here: picking the
    # most recent row would pass a fixture where the open one happens to be
    # newest, and quietly attach every follow-up to a ticket that's already
    # been closed out.
    live = make_recon_order(client, vehicle["id"], concern="Open job")
    newer_done = make_recon_order(client, vehicle["id"], concern="Later, already finished")
    assert (
        client.patch(
            f"/api/orders/{newer_done['id']}/status", json={"status": "complete", "actor": "tester"}
        ).status_code
        == 200
    )
    assert board_row(client, vehicle["id"])["order_id"] == live["id"], (
        "an open ticket should win over a completed one, even a newer completed one"
    )


def test_we_owe_board_rows_carry_an_order_id(client):
    item = make_we_owe(client, description="Replace mirror")
    row = next(r for r in client.get("/api/vehicles-board").json() if r["we_owe_id"] == item["id"])
    assert row["order_id"] is None

    order = client.post("/api/orders", json={"concern": "Mirror", "segment": "we_owe", "we_owe_id": item["id"]}).json()
    row = next(r for r in client.get("/api/vehicles-board").json() if r["we_owe_id"] == item["id"])
    assert row["order_id"] == order["id"]
