from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, save_estimate


def test_staff_crud(client):
    res = client.post("/api/staff", json={"name": "Jordan Smith", "role": "technician"})
    assert res.status_code == 201
    staff_id = res.json()["id"]

    active = client.get("/api/staff").json()
    assert any(s["id"] == staff_id for s in active)

    client.patch(f"/api/staff/{staff_id}", json={"active": False})
    active = client.get("/api/staff").json()
    assert not any(s["id"] == staff_id for s in active)

    everyone = client.get("/api/staff", params={"include_inactive": True}).json()
    assert any(s["id"] == staff_id and s["active"] == 0 for s in everyone)

    client.patch(f"/api/staff/{staff_id}", json={"name": "Jordan S.", "role": "manager"})
    updated = next(s for s in client.get("/api/staff", params={"include_inactive": True}).json() if s["id"] == staff_id)
    assert updated["name"] == "Jordan S."
    assert updated["role"] == "manager"


def test_staff_names_must_be_unique(client):
    """Assignment pickers, task owners and reports identify staff by name
    alone, so the API refuses a second person under the same name -- however
    it's capitalized -- on both the create and the rename path."""
    client.post("/api/staff", json={"name": "Ray Ortiz", "role": "technician"})
    dup = client.post("/api/staff", json={"name": "ray ortiz", "role": "advisor"})
    assert dup.status_code == 409

    other = client.post("/api/staff", json={"name": "Dana Wu", "role": "advisor"}).json()
    collide = client.patch(f"/api/staff/{other['id']}", json={"name": "RAY ORTIZ"})
    assert collide.status_code == 409
    assert next(s for s in client.get("/api/staff").json() if s["id"] == other["id"])["name"] == "Dana Wu"

    # Renaming yourself -- including a capitalization fix -- is not a
    # collision.
    fixed = client.patch(f"/api/staff/{other['id']}", json={"name": "dana wu"})
    assert fixed.status_code == 200
    assert fixed.json()["name"] == "dana wu"


def test_staff_rename_follows_through_to_task_assignments(client):
    """tasks.assigned_to is a JSON list of names, so a rename used to orphan
    every task the person owned: the old name stayed on the task where no
    picker or filter could reach it anymore. The rename must carry through --
    done tasks included, it's the same human -- while co-assignees, other
    people's tasks and the created_by audit field stay untouched."""
    ray = client.post("/api/staff", json={"name": "Ray Ortiz", "role": "technician"}).json()
    client.post("/api/staff", json={"name": "Dana Wu", "role": "advisor"})

    shared = client.post("/api/tasks", json={"title": "Shared detail", "assigned_to": ["Ray Ortiz", "Dana Wu"], "actor": "Ray Ortiz"}).json()
    done = client.post("/api/tasks", json={"title": "Old sublet", "assigned_to": ["Ray Ortiz"]}).json()
    client.patch(f"/api/tasks/{done['id']}", json={"done": True})
    danas = client.post("/api/tasks", json={"title": "Call customer", "assigned_to": ["Dana Wu"]}).json()

    res = client.patch(f"/api/staff/{ray['id']}", json={"name": "Raymond Ortiz"})
    assert res.status_code == 200
    # The response reports how many tasks followed the rename, so the UI can
    # say "2 tasks moved with them" -- Dana's task doesn't count.
    assert res.json()["tasks_moved"] == 2

    tasks = {t["id"]: t for t in client.get("/api/tasks").json()}
    assert tasks[shared["id"]]["assigned_to"] == ["Raymond Ortiz", "Dana Wu"]
    assert tasks[done["id"]]["assigned_to"] == ["Raymond Ortiz"]
    assert tasks[danas["id"]]["assigned_to"] == ["Dana Wu"]
    assert tasks[shared["id"]]["created_by"] == "Ray Ortiz"

    # A patch that doesn't rename reports zero moved, and a rename with no
    # tasks attached does too -- the field is always present, never null.
    res = client.patch(f"/api/staff/{ray['id']}", json={"role": "manager"})
    assert res.json()["tasks_moved"] == 0
    dana_less = client.post("/api/staff", json={"name": "Lee Park", "role": "technician"}).json()
    res = client.patch(f"/api/staff/{dana_less['id']}", json={"name": "Lee Parker"})
    assert res.json()["tasks_moved"] == 0


def test_reset_db_moves_old_database_aside(tmp_path):
    """reset_db (split out of seed_mock_data so a clean database doesn't
    require importing the mock dataset) renames db + sidecars to backups and
    recreates an empty schema in place."""
    from app.db import connect, init_db, reset_db

    db_path = tmp_path / "shop.db"
    init_db(db_path)
    db = connect(db_path)
    db.execute("INSERT INTO staff(name,role,created_at) VALUES('Ray','technician','2026-01-01T00:00:00Z')")
    db.commit()
    # Flush the real WAL (if the schema runs in WAL mode) before planting a
    # fake sidecar -- overwriting a live WAL would eat the commit above.
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    (tmp_path / "shop.db-wal").write_bytes(b"wal")

    backup = reset_db(db_path, backup_suffix=".pre-test.bak")

    assert backup == tmp_path / "shop.db.pre-test.bak"
    assert backup.is_file()
    assert (tmp_path / "shop.db-wal.pre-test.bak").is_file()
    assert not (tmp_path / "shop.db-wal").is_file()
    with connect(db_path) as db:
        assert db.execute("SELECT COUNT(*) FROM staff WHERE name='Ray'").fetchone()[0] == 0
    with connect(backup) as db:
        assert db.execute("SELECT COUNT(*) FROM staff WHERE name='Ray'").fetchone()[0] == 1

    # Nothing to move: returns None and still leaves a fresh db behind.
    empty = tmp_path / "fresh.db"
    assert reset_db(empty) is None
    assert empty.is_file()


def test_assignment_requires_active_matching_role(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    advisor = client.post("/api/staff", json={"name": "Pat", "role": "advisor"}).json()

    # wrong role for technician slot
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": advisor["id"]})
    assert res.status_code == 400

    technician = client.post("/api/staff", json={"name": "Jordan", "role": "technician"}).json()
    res = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"advisor_id": advisor["id"], "technician_id": technician["id"], "odometer_in": 100},
    )
    assert res.status_code == 200
    assert res.json()["technician_name"] == "Jordan"


def test_date_in_defaults_to_order_creation_and_is_editable(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["assignment"]["date_in"] == order["created_at"][:10]

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"date_in": "2026-01-15"})
    assert res.status_code == 200
    assert res.json()["date_in"] == "2026-01-15"

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["assignment"]["date_in"] == "2026-01-15"


def test_concern_is_returned_and_editable(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"], concern="Front end recon prep")
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["concern"] == "Front end recon prep"

    res = client.patch(f"/api/orders/{order['id']}/concern", json={"concern": "Replace missing passenger mirror"})
    assert res.status_code == 200
    assert res.json()["concern"] == "Replace missing passenger mirror"

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["concern"] == "Replace missing passenger mirror"


def test_concern_rejects_too_short_value(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    res = client.patch(f"/api/orders/{order['id']}/concern", json={"concern": "hi"})
    assert res.status_code == 422


def test_concern_update_unknown_order_404s(client):
    res = client.patch("/api/orders/99999/concern", json={"concern": "Whatever"})
    assert res.status_code == 404


def test_status_transitions(client):
    """Statuses are a plain, ungated picker now -- any of the 4 values is
    settable from any other, with no transition graph or approval/invoice
    gating (matches the shop's real workflow: estimate / pending approval /
    in progress / complete, nothing more)."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    assert res.status_code == 200

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "estimate"})
    assert res.status_code == 200

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "pending_approval"})
    assert res.status_code == 200

    # invalid value still rejected
    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "bogus"})
    assert res.status_code == 422


def test_void_order(client):
    vehicle = make_recon_vehicle(client, stock_number="R-4501")
    live_order = make_recon_order(client, vehicle["id"], concern="Real work")
    save_estimate(client, live_order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])

    mistake_order = make_recon_order(client, vehicle["id"], concern="Started by mistake")
    save_estimate(client, mistake_order["id"], [{"kind": "part", "description": "Wrong part", "part_number": "X-1", "quantity": 1, "unit_price": 300, "unit_cost": 300}])
    res = client.post(f"/api/orders/{mistake_order['id']}/void", json={"actor": "Clay"})
    assert res.status_code == 200
    assert res.json() == {"id": mistake_order["id"], "status": "complete", "voided": True}

    order_after = client.get(f"/api/orders/{mistake_order['id']}").json()
    assert order_after["status"] == "complete"
    assert order_after["voided"] == 1

    # voiding twice is rejected
    res = client.post(f"/api/orders/{mistake_order['id']}/void", json={"actor": "Clay"})
    assert res.status_code == 409


def test_voided_order_is_frozen_from_further_edits(client):
    """Voiding used to only flip status/voided -- every other endpoint that
    mutates an order (status, concern, estimate, parts ordering/receiving)
    only checked the vehicle's archived state, never the order's own voided
    flag, so a voided ticket could still gain new estimate lines, flip
    back to in_progress, and even post a real vendor A/P invoice."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-4502")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 40, "unit_cost": 40}])
    item_id = estimate["items"][0]["id"]
    client.post(f"/api/orders/{order['id']}/void", json={"actor": "Clay"})

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})
    assert res.status_code == 409

    res = client.patch(f"/api/orders/{order['id']}/concern", json={"concern": "Different work"})
    assert res.status_code == 409

    res = client.post(f"/api/orders/{order['id']}/estimate", json={"actor": "t", "items": [{"id": item_id, "kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 5, "unit_price": 40, "unit_cost": 40}]})
    assert res.status_code == 409

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 409

    res = client.post(f"/api/orders/{order['id']}/estimate/receive-parts", json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"})
    assert res.status_code == 409


def test_void_order_blocked_once_customer_invoiced(client):
    """Voiding an already-invoiced order would zero its cost out of the
    vehicle's rollup while the customer invoice/payment records still say
    it was billed -- the two would permanently disagree."""
    order = make_retail_order(client)
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Jamie", "method": "in_person"})
    res = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"})
    assert res.status_code == 201, res.text

    res = client.post(f"/api/orders/{order['id']}/void", json={"actor": "Clay"})
    assert res.status_code == 409


def test_authorization_flow(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])

    res = client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    assert res.status_code == 201


def test_estimate_stays_editable_after_approval_for_recon(client):
    """Recon/we-owe work is internal at-cost tracking with no customer
    authorization requirement -- the advisor keeps full control to add or
    correct a line at any point in the RO's life, even after approval."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})

    res = client.post(
        f"/api/orders/{order['id']}/estimate",
        json={"actor": "Clay", "items": [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 45, "unit_cost": 45}]},
    )
    assert res.status_code == 200
    assert len(res.json()["items"]) == 1


def test_findings_require_part_number(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}])
    res = client.post(
        f"/api/orders/{order['id']}/findings",
        json={"summary": "Found worn pads", "items": [{"kind": "part", "description": "Pads", "quantity": 1, "unit_price": 10}]},
    )
    assert res.status_code == 422


def test_retail_invoice_and_payment(client):
    """Invoicing/payment gating on order status was removed along with the
    old approved/closed status values -- an order can be marked complete
    freely, independent of whether its customer invoice is paid."""
    order = make_retail_order(client)
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress"})

    res = client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    assert res.status_code == 200

    invoice = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"}).json()
    assert invoice["total"] == 100
    assert invoice["balance"] == 100

    # overpayment rejected
    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 200, "method": "cash"})
    assert res.status_code == 409

    res = client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 100, "method": "cash"})
    assert res.status_code == 201
    assert res.json()["invoice"]["status"] == "paid"


def test_concurrent_payments_cannot_overdraw_invoice(client):
    """record_payment used to read balance_cents, check it, then write it
    back as three separate steps -- two payments landing at nearly the same
    moment could both read the same starting balance, both pass the "does
    this exceed it" check, and together overdraw the invoice. The fix makes
    the check-and-decrement one atomic UPDATE, so of two $80 payments
    against a $100 balance (each individually fine, together too much),
    exactly one must be accepted."""
    from concurrent.futures import ThreadPoolExecutor

    order = make_retail_order(client)
    save_estimate(client, order["id"], [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 100, "unit_cost": 100}])
    client.post(f"/api/orders/{order['id']}/authorization", json={"status": "approved", "approved_by": "Clay", "method": "in_person"})
    invoice = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"}).json()

    def pay():
        return client.post(f"/api/invoices/{invoice['id']}/payments", json={"amount": 80, "method": "cash"})

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: pay(), range(2)))

    statuses = sorted(r.status_code for r in results)
    assert statuses == [201, 409]  # exactly one accepted, one rejected

    final = client.get(f"/api/orders/{order['id']}").json()
    assert final["invoice"]["balance"] == 20  # 100 - 80, never went negative
