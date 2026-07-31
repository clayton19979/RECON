from __future__ import annotations

from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    save_estimate,
)


def test_order_parts_flips_quoted_to_ordered(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            },
            {
                "kind": "part",
                "description": "Rotors",
                "part_number": "RT-1",
                "quantity": 1,
                "unit_price": 30,
                "unit_cost": 30,
            },
            {"kind": "labor", "description": "Install", "quantity": 1, "unit_price": 50, "unit_cost": 50},
        ],
    )
    assert all(i["status"] == "quoted" for i in estimate["items"])

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 200
    assert res.json()["updated"] == 2  # only the two part lines, not labor

    updated = client.get(f"/api/orders/{order['id']}").json()
    statuses = {i["part_number"]: i["status"] for i in updated["estimate"]["items"] if i["kind"] == "part"}
    assert statuses == {"BP-1": "ordered", "RT-1": "ordered"}

    # calling again is a no-op (nothing left in 'quoted')
    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.json()["updated"] == 0


def test_set_item_status_no_longer_accepts_received(client):
    """Parts are only ever marked received through /estimate/receive-parts,
    which posts a real A/P record -- the quick per-line status endpoint no
    longer accepts "received" for a part line, so there's exactly one
    receiving mechanism."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "received"})
    assert res.status_code == 422

    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})
    assert res.status_code == 200
    assert res.json() == {"id": item_id, "status": "ordered"}


def test_receive_parts_posts_single_ap_invoice_for_multiple_lines(client):
    """The real workflow bug this fixes: ordering 2 parts on one invoice used
    to require posting them separately with no resulting A/P entry. Selecting
    both and receiving them together must create exactly one ap_invoices row
    covering both lines, and it must show up in the A/P tab."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
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
                "unit_cost": 10,
            },
            {
                "kind": "part",
                "description": "Rotors",
                "part_number": "RT-1",
                "quantity": 1,
                "unit_price": 30,
                "unit_cost": 30,
            },
        ],
    )
    item_ids = [i["id"] for i in estimate["items"]]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["received_items"] == 2

    updated = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert all(i["status"] == "received" for i in updated)
    assert {i["received_invoice_number"] for i in updated} == {"INV-1"}

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 50  # 2*10 + 1*30, actually landed now

    invoices = client.get("/api/ap/invoices").json()
    matching = [i for i in invoices if i["invoice_number"] == "INV-1"]
    assert len(matching) == 1  # one AP invoice, not two
    assert matching[0]["order_id"] == order["id"]


def test_receiving_at_the_invoiced_price_moves_the_line_and_the_ap_bill_together(client):
    """The price on the vendor's invoice is rarely the price that was quoted --
    used and junkyard parts are the norm here and get priced when they're
    pulled. Receiving is the one moment the app writes both what the car cost
    and what the shop owes the vendor, so a corrected price has to land in
    both: the estimate line, the vehicle's actual cost, and the A/P invoice
    must all report the same number afterwards. Correcting the line by hand
    later only ever moves one of the three.
    """
    vendor = client.post("/api/vendors", json={"name": "Pull-A-Part"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3302")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Used tail light, right",
                "part_number": "TL-R",
                "quantity": 1,
                "unit_price": 60,
                "unit_cost": 60,
            },
            {
                "kind": "part",
                "description": "Wiper blades",
                "part_number": "WB-22",
                "quantity": 2,
                "unit_price": 14.5,
                "unit_cost": 14.5,
            },
        ],
    )
    tail_light, wipers = estimate["items"][0]["id"], estimate["items"][1]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={
            "item_ids": [tail_light, wipers],
            "vendor_id": vendor["id"],
            "invoice_number": "PAP-8812",
            "tax": 6.20,
            # The yard charged less for the tail light and more for the
            # wipers; only the lines that moved are sent.
            "cost_overrides": {str(tail_light): 45, str(wipers): 16.25},
        },
    )
    assert res.status_code == 200, res.text

    items = {i["id"]: i for i in client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]}
    assert items[tail_light]["unit_cost"] == 45
    assert items[wipers]["unit_cost"] == 16.25
    assert items[tail_light]["received_invoice_number"] == "PAP-8812"

    # 1 x 45 + 2 x 16.25 -- what the shop actually spent on this car.
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 77.5

    invoice = next(i for i in client.get("/api/ap/invoices").json() if i["invoice_number"] == "PAP-8812")
    assert invoice["subtotal"] == 77.5
    assert invoice["tax"] == 6.20
    assert invoice["total"] == 83.7


def test_receive_parts_rejects_negative_cost_override(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={
            "item_ids": [item_id],
            "vendor_id": vendor["id"],
            "invoice_number": "INV-1",
            "cost_overrides": {str(item_id): -5},
        },
    )
    assert res.status_code == 422


def test_parts_endpoints_respect_invoiced_estimate_lock(client):
    """save_estimate already refuses to edit an invoiced order's estimate --
    order-parts, the per-line status toggle, and receive-parts (which posts
    a real vendor A/P invoice) must refuse too, or the customer's already-
    fixed invoice total silently drifts from what the shop keeps spending."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order = make_retail_order(client)
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 50,
                "unit_cost": 40,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    res = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "t"})
    assert res.status_code == 201, res.text

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 409

    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})
    assert res.status_code == 409

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert res.status_code == 409


def test_receive_parts_requires_known_vendor(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": 999999, "invoice_number": "INV-1"},
    )
    assert res.status_code == 404


def test_receive_parts_requires_invoice_number(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": ""},
    )
    assert res.status_code == 422


def test_core_charge_is_saved_and_listed_in_cores(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Caliper",
                "part_number": "CAL-1",
                "quantity": 1,
                "unit_price": 80,
                "unit_cost": 80,
                "core_charge": 25,
            }
        ],
    )
    item = estimate["items"][0]
    assert item["core_charge"] == 25
    assert not item["core_returned"]

    cores = client.get("/api/cores").json()
    assert len(cores) == 1
    assert cores[0]["id"] == item["id"]
    assert cores[0]["core_charge"] == 25
    assert not cores[0]["core_returned"]
    assert cores[0]["vehicle_label"] == vehicle["stock_number"]

    # No paperwork needed to mark it returned -- the core physically goes
    # back first and the vendor's credit invoice arrives later.
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/core-return", json={"actor": "tester"})
    assert res.status_code == 200
    body = res.json()
    assert body["core_returned"] is True

    cores = client.get("/api/cores").json()
    assert cores[0]["core_returned"]
    assert cores[0]["core_returned_at"]
    assert cores[0]["core_return_invoice_number"] == ""

    # recording the credit is the separate, paperwork-bearing step
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item['id']}/core-credit",
        json={"invoice_number": "CR-9001", "actor": "tester"},
    )
    assert res.status_code == 200
    assert res.json()["core_return_invoice_number"] == "CR-9001"
    cores = client.get("/api/cores").json()
    assert cores[0]["core_return_invoice_number"] == "CR-9001"

    # can't record twice
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item['id']}/core-credit",
        json={"invoice_number": "CR-9002", "actor": "tester"},
    )
    assert res.status_code == 409

    # undo the return -- the credit number clears with it
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item['id']}/core-return", json={"returned": False})
    assert res.status_code == 200
    cores = client.get("/api/cores").json()
    assert not cores[0]["core_returned"]
    assert cores[0]["core_return_invoice_number"] == ""

    # and a credit can't be recorded against a core that isn't returned
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item['id']}/core-credit",
        json={"invoice_number": "CR-9003", "actor": "tester"},
    )
    assert res.status_code == 400


def test_core_return_rejects_line_with_no_core_charge(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={})
    assert res.status_code == 400


def test_part_return_toggles_flag_and_drops_from_actual_cost(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 10

    # No paperwork needed at this step -- the part goes back to the vendor
    # first; the credit invoice is recorded later via post-return-credit.
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert res.status_code == 200
    assert res.json() == {"id": item_id, "part_returned": True}

    updated = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert updated["part_returned"]
    assert updated["part_returned_at"]
    # still marked received (audit trail of what actually came in), but no
    # longer counted toward the vehicle's actual cost
    assert updated["status"] == "received"

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 0

    # undo
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"returned": False})
    assert res.status_code == 200
    assert res.json()["part_returned"] is False
    updated = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    assert not updated["part_returned"]
    assert not updated["part_returned_at"]
    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == 10


def test_returning_the_new_part_drops_its_pending_core(client):
    """A core deposit exists only because a new part was bought and the old
    unit is owed back. Send the new part back instead of fitting it and the
    whole line reverses -- there is no old unit to return, so the core must
    not sit on the board as a chore that will never happen."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
                "core_charge": 45,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert len(client.get("/api/cores").json()) == 1, "a received part with a core owes a core back"

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert client.get("/api/cores").json() == [], "the new part is going back, so there's no core to chase"
    assert len(client.get("/api/returns").json()) == 1, "it is a part return, though"

    # the core can't be marked returned either -- there is nothing to send
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"actor": "tester"})
    assert res.status_code == 400

    # filtered, not destroyed: undoing the part return brings the core back
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"returned": False})
    cores = client.get("/api/cores").json()
    assert len(cores) == 1 and cores[0]["core_charge"] == 45


def test_a_core_already_sent_back_survives_a_later_part_return(client):
    """The reverse order is a record, not a chore: that core physically went
    to the vendor and may carry a credit, so it stays on the board."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order = make_retail_order(client)
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Caliper",
                "part_number": "CAL-9",
                "quantity": 1,
                "unit_price": 80,
                "unit_cost": 80,
                "core_charge": 25,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/core-return", json={"actor": "tester"})
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})

    cores = client.get("/api/cores").json()
    assert len(cores) == 1 and cores[0]["core_returned"], "a core that already went back stays on the board"


def test_part_pickup_tracks_whether_the_vendor_has_collected_it(client):
    """A returned part sits at the shop until the vendor's driver takes it --
    the three states the Returned Parts board shows are Pending (still here),
    Awaiting Credit (picked up), Credited."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    # can't be picked up before it's even flagged to go back
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-pickup", json={})
    assert res.status_code == 400

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert client.get("/api/returns").json()[0]["part_picked_up_at"] == "", "a fresh return is still at the shop"

    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-pickup", json={"actor": "tester"})
    assert res.status_code == 200
    assert client.get("/api/returns").json()[0]["part_picked_up_at"]

    # put it back on the shelf
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/part-pickup",
        json={"picked_up": False, "actor": "tester"},
    )
    assert res.status_code == 200
    assert client.get("/api/returns").json()[0]["part_picked_up_at"] == ""

    # undoing the return itself clears any pickup stamp with it
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-pickup", json={"actor": "tester"})
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"returned": False})
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert client.get("/api/returns").json()[0]["part_picked_up_at"] == ""


def test_posting_a_credit_stamps_pickup_on_a_part_still_marked_pending(client):
    """A credit in hand is proof the vendor took the part, so a line the shop
    never got round to marking picked up isn't left contradicting its own
    paperwork."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order = make_retail_order(client)
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Starter",
                "part_number": "ST-1",
                "quantity": 1,
                "unit_price": 90,
                "unit_cost": 90,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert client.get("/api/returns").json()[0]["part_picked_up_at"] == ""

    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "RMA-5", "actor": "tester"},
    )
    assert res.status_code == 200
    row = client.get("/api/returns").json()[0]
    assert row["return_invoice_number"] == "RMA-5"
    assert row["part_picked_up_at"], "a credited return can't still be sitting on the shelf"


def test_part_return_rejects_line_that_was_never_received(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={})
    assert res.status_code == 400


def test_part_return_allowed_after_estimate_is_invoiced(client):
    """Same reasoning as core-return: a part can go back to the vendor well
    after the ticket's estimate is locked, so this must not be blocked by
    assert_estimate_editable the way order-parts/receive-parts are."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order = make_retail_order(client)
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 50,
                "unit_cost": 40,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    client.post(
        f"/api/orders/{order['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    res = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "t"})
    assert res.status_code == 201, res.text

    res = client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})
    assert res.status_code == 200
    assert res.json()["part_returned"] is True


def test_post_return_credit_posts_negative_ap_invoice_and_lists_in_returns(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    # not returned yet -- shows up nowhere in /returns
    assert client.get("/api/returns").json() == []

    client.patch(f"/api/orders/{order['id']}/estimate/items/{item_id}/part-return", json={"actor": "tester"})

    returns = client.get("/api/returns").json()
    assert len(returns) == 1
    assert returns[0]["id"] == item_id
    assert returns[0]["vendor_id"] == vendor["id"]
    assert returns[0]["vendor_name"] == "WorldPac"
    assert returns[0]["return_invoice_number"] == ""
    assert returns[0]["credit_total"] == -150

    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "RMA-1", "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["credit_total"] == -150
    credit_invoice_id = res.json()["ap_invoice_id"]

    invoices = client.get("/api/ap/invoices").json()
    matching = next(i for i in invoices if i["id"] == credit_invoice_id)
    assert matching["invoice_number"] == "RMA-1"
    assert matching["total"] == -150
    assert matching["order_id"] == order["id"]

    returns = client.get("/api/returns").json()
    assert returns[0]["return_invoice_number"] == "RMA-1"

    # already credited -- can't post it twice
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "RMA-2"},
    )
    assert res.status_code == 409


def test_post_return_credit_rejects_part_not_marked_returned(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    res = client.post(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/post-return-credit",
        json={"vendor_id": vendor["id"], "credit_number": "RMA-1"},
    )
    assert res.status_code == 400


def test_move_item_to_a_different_ticket_recomputes_both_totals(client):
    vehicle_a = make_recon_vehicle(client, stock_number="R-2001")
    order_a = make_recon_order(client, vehicle_a["id"])
    vehicle_b = make_recon_vehicle(client, stock_number="R-2002")
    order_b = make_recon_order(client, vehicle_b["id"])

    estimate_a = save_estimate(
        client,
        order_a["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
                "core_charge": 40,
            }
        ],
    )
    item_id = estimate_a["items"][0]["id"]

    res = client.patch(
        f"/api/orders/{order_a['id']}/estimate/items/{item_id}/move",
        json={"target_order_id": order_b["id"], "actor": "tester"},
    )
    assert res.status_code == 200, res.text

    order_a_after = client.get(f"/api/orders/{order_a['id']}").json()
    assert order_a_after["estimate"]["items"] == []
    assert order_a_after["estimate"]["total"] == 0

    order_b_after = client.get(f"/api/orders/{order_b['id']}").json()
    moved = order_b_after["estimate"]["items"][0]
    assert moved["id"] == item_id
    assert moved["description"] == "Alternator"
    assert moved["core_charge"] == 40
    assert order_b_after["estimate"]["total"] > 0

    # the moved item's core charge still shows up in /api/cores, now
    # attributed to vehicle B instead of vehicle A
    cores = client.get("/api/cores").json()
    assert cores[0]["vehicle_label"] == vehicle_b["stock_number"]


def test_move_item_rejects_same_order(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/move", json={"target_order_id": order["id"]}
    )
    assert res.status_code == 400


def test_move_item_blocked_once_either_side_is_invoiced(client):
    order_a = make_retail_order(client)
    estimate = save_estimate(
        client,
        order_a["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 50,
                "unit_cost": 40,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order_a['id']}/authorization",
        json={"status": "approved", "approved_by": "Jamie", "method": "in_person"},
    )
    res = client.post(f"/api/orders/{order_a['id']}/invoice", json={"actor": "t"})
    assert res.status_code == 201, res.text

    order_b = make_retail_order(client, concern="Different job")
    res = client.patch(
        f"/api/orders/{order_a['id']}/estimate/items/{item_id}/move", json={"target_order_id": order_b["id"]}
    )
    assert res.status_code == 409


def test_move_item_can_reassign_its_vendor_invoice(client):
    """The whole point of the checkbox: a part received on the wrong ticket
    should be able to take its vendor invoice/PO with it, not just the
    estimate line, or the A/P books still show it against the wrong RO."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle_a = make_recon_vehicle(client, stock_number="R-3001")
    order_a = make_recon_order(client, vehicle_a["id"])
    vehicle_b = make_recon_vehicle(client, stock_number="R-3002")
    order_b = make_recon_order(client, vehicle_b["id"])

    estimate = save_estimate(
        client,
        order_a["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{order_a['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-500"},
    )
    assert res.status_code == 200, res.text
    invoice_id = res.json()["ap_invoice_id"]

    related = client.get(f"/api/orders/{order_a['id']}/estimate/items/{item_id}/received-invoice").json()
    assert related["invoice_number"] == "INV-500"
    assert related["vendor_name"] == "WorldPac"
    assert related["other_item_count"] == 0

    res = client.patch(
        f"/api/orders/{order_a['id']}/estimate/items/{item_id}/move",
        json={"target_order_id": order_b["id"], "reassign_invoice": True, "actor": "tester"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["reassigned_invoice_id"] == invoice_id

    invoice = client.get("/api/ap/invoices").json()[0]
    assert invoice["id"] == invoice_id
    assert invoice["order_id"] == order_b["id"]
    assert invoice["po_number"] == order_b["number"]


def test_move_item_without_reassign_leaves_invoice_on_original_order(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle_a = make_recon_vehicle(client, stock_number="R-3101")
    order_a = make_recon_order(client, vehicle_a["id"])
    vehicle_b = make_recon_vehicle(client, stock_number="R-3102")
    order_b = make_recon_order(client, vehicle_b["id"])

    estimate = save_estimate(
        client,
        order_a["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order_a['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-501"},
    )

    res = client.patch(
        f"/api/orders/{order_a['id']}/estimate/items/{item_id}/move",
        json={"target_order_id": order_b["id"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["reassigned_invoice_id"] is None

    invoice = client.get("/api/ap/invoices").json()[0]
    assert invoice["order_id"] == order_a["id"]


def test_related_invoice_warns_when_it_covers_other_items_still_on_the_ticket(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Alternator",
                "part_number": "ALT-1",
                "quantity": 1,
                "unit_price": 150,
                "unit_cost": 150,
            },
            {
                "kind": "part",
                "description": "Belt",
                "part_number": "BLT-1",
                "quantity": 1,
                "unit_price": 20,
                "unit_cost": 20,
            },
        ],
    )
    item_ids = [i["id"] for i in estimate["items"]]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": item_ids, "vendor_id": vendor["id"], "invoice_number": "INV-502"},
    )

    related = client.get(f"/api/orders/{order['id']}/estimate/items/{item_ids[0]}/received-invoice").json()
    assert related["other_item_count"] == 1


def test_receive_parts_wrong_order_404(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    other_order = make_recon_order(client, make_recon_vehicle(client, stock_number="R-9999")["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.post(
        f"/api/orders/{other_order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    assert res.status_code == 404


def test_receive_parts_duplicate_invoice_number_shared_with_agent_path(client):
    """The uniqueness constraint (vendor_id, normalized_invoice_number) must
    be shared between the ticket-side receive flow and the agent/A-P-tab
    invoice flow -- posting the same vendor+invoice number through either
    path blocks the other."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-3302")
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]

    res = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-DUP"},
    )
    assert res.status_code == 200

    # Same vendor + invoice number via the agent path is rejected as a duplicate
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "WorldPac",
            "invoice_number": "INV-DUP",
            "po_number": order["number"],
            "subtotal": 10,
            "tax": 0,
            "total": 10,
            "items": [
                {"part_number": "BP-1", "description": "Brake pads", "quantity": 1, "unit_cost": 10, "kind": "part"}
            ],
        },
    )
    assert res.json()["status"] == "duplicate"


def test_set_item_status_wrong_order_404(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    other_order = make_recon_order(client, make_recon_vehicle(client, stock_number="R-9999")["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Brake pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    res = client.patch(f"/api/orders/{other_order['id']}/estimate/items/{item_id}/status", json={"status": "ordered"})
    assert res.status_code == 404


def test_order_parts_no_estimate_404(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    assert res.status_code == 404
