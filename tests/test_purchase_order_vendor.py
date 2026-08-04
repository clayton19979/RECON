"""Who the parts were ordered from.

RECON handed out a PO number to say to a vendor and then never asked which
vendor it was said to. The column existed on the batch; nothing wrote it and
nothing read it. So the one screen whose whole job is chasing parts that
haven't turned up -- Parts & Cores, On Order -- could tell you a windshield had
been coming for nine days and could not tell you who to ring about it.

These cover the two halves of closing that: recording the supplier on a batch,
and it reaching the chase desk.
"""

from __future__ import annotations

from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_we_owe,
    save_estimate,
)


def part(description="Windshield", part_number="WS-1", unit_cost=180.0):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": 1,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }


def ordered_order(client, stock_number="R-1001", items=None):
    """A ticket with its parts marked ordered -- which is what puts them on a
    batch and onto the chase desk."""
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], items or [part()])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    return vehicle, order


def only_batch(client, order_id: int) -> dict:
    batches = client.get(f"/api/orders/{order_id}/purchase-orders").json()
    assert len(batches) == 1, batches
    return batches[0]


# ---------------------------------------------------------------------------
# Recording the supplier
# ---------------------------------------------------------------------------


def test_supplier_typed_after_the_call_sticks_to_the_batch(client):
    """The whole point. The number is pulled *before* the call, so the only
    moment the supplier can be recorded is afterwards."""
    _, order = ordered_order(client)
    batch = only_batch(client, order["id"])
    assert batch["vendor_id"] is None, "a fresh batch starts with nobody against it"

    saved = client.patch(
        f"/api/orders/{order['id']}/purchase-orders/{batch['id']}",
        json={"vendor_name": "Cal's Auto Salvage", "actor": "clayton"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["vendor_name"] == "Cal's Auto Salvage"
    assert only_batch(client, order["id"])["vendor_name"] == "Cal's Auto Salvage"


def test_a_supplier_nobody_configured_becomes_a_real_vendor(client):
    """A shop ringing round junkyards for the cheapest strut is not going to
    stop and set up a vendor record first. Typing the name has to be enough --
    and it has to make the same kind of vendor the accounting screen uses, or
    the bill that follows can't be posted against it."""
    _, order = ordered_order(client)
    batch = only_batch(client, order["id"])
    assert client.get("/api/vendors").json() == []

    client.patch(
        f"/api/orders/{order['id']}/purchase-orders/{batch['id']}",
        json={"vendor_name": "Northside Salvage"},
    )

    vendors = client.get("/api/vendors").json()
    assert [v["name"] for v in vendors] == ["Northside Salvage"]
    assert only_batch(client, order["id"])["vendor_id"] == vendors[0]["id"]


def test_the_same_supplier_spelled_differently_is_one_vendor(client):
    """ "O'Reilly", "oreilly" and "O Reilly" are one supplier said three ways.
    Two vendor rows here would mean the supplier recorded at the parts bench
    and the supplier on the invoice never reconcile."""
    _, first = ordered_order(client, stock_number="R-1")
    _, second = ordered_order(client, stock_number="R-2")

    client.patch(
        f"/api/orders/{first['id']}/purchase-orders/{only_batch(client, first['id'])['id']}",
        json={"vendor_name": "O'Reilly Auto Parts"},
    )
    client.patch(
        f"/api/orders/{second['id']}/purchase-orders/{only_batch(client, second['id'])['id']}",
        json={"vendor_name": "oreilly auto parts"},
    )

    vendors = client.get("/api/vendors").json()
    assert len(vendors) == 1, f"the same supplier got two vendor records: {vendors}"
    assert only_batch(client, first["id"])["vendor_id"] == only_batch(client, second["id"])["vendor_id"]


def test_a_supplier_matched_by_alias_reuses_the_configured_vendor(client):
    """The accounting screen keeps aliases for exactly this -- the name on the
    paperwork isn't always the name the shop says out loud."""
    vendor = client.post("/api/vendors", json={"name": "O'Reilly Auto Parts", "aliases": ["ORLY"]}).json()
    _, order = ordered_order(client)

    client.patch(
        f"/api/orders/{order['id']}/purchase-orders/{only_batch(client, order['id'])['id']}",
        json={"vendor_name": "orly"},
    )

    assert only_batch(client, order["id"])["vendor_id"] == vendor["id"]
    assert len(client.get("/api/vendors").json()) == 1, "an alias spawned a duplicate vendor"


def test_a_wrong_supplier_can_be_taken_back_off(client):
    """ "We don't know" has to stay sayable, or a slip becomes permanent."""
    _, order = ordered_order(client)
    batch_id = only_batch(client, order["id"])["id"]
    client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"vendor_name": "Wrong Yard"})

    client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"vendor_name": ""})

    assert only_batch(client, order["id"])["vendor_id"] is None
    assert only_batch(client, order["id"])["vendor_name"] is None


def test_setting_a_supplier_does_not_wipe_the_batch_note(client):
    """The supplier box sends only the supplier. It must be able to say "set
    this" without silently clearing everything it didn't mention."""
    _, order = ordered_order(client)
    batch_id = only_batch(client, order["id"])["id"]
    client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"note": "rear glass too"})

    client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"vendor_name": "Cal's"})

    assert only_batch(client, order["id"])["note"] == "rear glass too"


def test_the_pulled_number_can_carry_its_supplier_from_the_start(client):
    """Optional, never required -- but when it *is* known, one call should do
    it rather than a second edit a moment later."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    created = client.post(f"/api/orders/{order['id']}/purchase-orders", json={"vendor_name": "Cal's Auto Salvage"})
    assert created.status_code == 201, created.text
    assert only_batch(client, order["id"])["vendor_name"] == "Cal's Auto Salvage"


def test_pulling_a_number_still_needs_nothing_at_all(client):
    """Guarded because it's the rule the whole design rests on: the number is
    reached for *in order to* make the call, so demanding a supplier up front
    would put a dialog in front of a one-click action."""
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])

    assert client.post(f"/api/orders/{order['id']}/purchase-orders").status_code == 201
    assert only_batch(client, order["id"])["vendor_id"] is None


def test_recording_a_supplier_is_logged_against_the_ticket(client):
    _, order = ordered_order(client)
    batch = only_batch(client, order["id"])

    client.patch(
        f"/api/orders/{order['id']}/purchase-orders/{batch['id']}",
        json={"vendor_name": "Cal's Auto Salvage", "actor": "antonio"},
    )

    activity = client.get(f"/api/orders/{order['id']}").json()["activity"]
    logged = [a for a in activity if a["action"] == "purchase_order_vendor_set"]
    assert logged, "who we ordered from changed and the ticket's history says nothing"
    assert logged[-1]["actor"] == "antonio"
    assert logged[-1]["details"] == {"number": batch["number"], "vendor": "Cal's Auto Salvage"}


def test_a_batch_on_another_ticket_is_not_reachable(client):
    """The PO id alone must not be enough -- the ticket in the path has to own
    it, or a mistyped URL edits some other car's order."""
    _, mine = ordered_order(client, stock_number="R-1")
    _, theirs = ordered_order(client, stock_number="R-2")
    other_batch = only_batch(client, theirs["id"])

    refused = client.patch(
        f"/api/orders/{mine['id']}/purchase-orders/{other_batch['id']}", json={"vendor_name": "Cal's"}
    )
    assert refused.status_code == 404
    assert only_batch(client, theirs["id"])["vendor_id"] is None


def test_a_supplier_name_of_pure_punctuation_is_refused(client):
    """Normalising "---" leaves nothing to match on, so it would create a
    vendor no future spelling could ever find again."""
    _, order = ordered_order(client)
    batch_id = only_batch(client, order["id"])["id"]

    refused = client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"vendor_name": "-- --"})
    assert refused.status_code == 422
    assert client.get("/api/vendors").json() == []


def test_an_archived_car_is_frozen(client):
    """A car sent to History is somebody else's now; its ticket stops taking
    edits, and this is one."""
    vehicle, order = ordered_order(client)
    batch_id = only_batch(client, order["id"])["id"]
    assert client.post(f"/api/recon/vehicles/{vehicle['id']}/archive").status_code == 200

    refused = client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch_id}", json={"vendor_name": "Cal's"})
    assert refused.status_code == 409


# ---------------------------------------------------------------------------
# Reaching the chase desk
# ---------------------------------------------------------------------------


def test_the_chase_desk_says_who_to_ring_and_what_to_quote(client):
    """The point of all of it: a part that hasn't turned up now names both
    ends of the phone call it's asking somebody to make."""
    _, order = ordered_order(client)
    batch = only_batch(client, order["id"])
    client.patch(f"/api/orders/{order['id']}/purchase-orders/{batch['id']}", json={"vendor_name": "Cal's Auto Salvage"})

    row = client.get("/api/parts/on-order").json()[0]
    assert row["vendor_name"] == "Cal's Auto Salvage"
    assert row["po_number"] == batch["number"]
    assert row["po_id"] == batch["id"]


def test_an_unrecorded_supplier_is_blank_not_missing(client):
    """The keys are always there. A row rendering `undefined` where a supplier
    goes is worse than one that says nobody wrote it down."""
    _, order = ordered_order(client)

    row = client.get("/api/parts/on-order").json()[0]
    assert row["vendor_name"] == ""
    assert row["vendor_id"] is None
    assert row["po_number"] == only_batch(client, order["id"])["number"]


def test_parts_from_one_phone_call_say_so(client):
    """Two lines on one batch is one call, not two. Chasing them separately is
    how the same vendor gets rung twice about the same order."""
    ordered_order(client, items=[part("Windshield", "WS-1"), part("Brake kit", "BR-1")])

    rows = client.get("/api/parts/on-order").json()
    assert len(rows) == 2
    assert {r["po_outstanding"] for r in rows} == {2}


def test_the_count_is_of_parts_still_missing_not_of_the_batch(client):
    """A batch of two whose other line turned up is one call about one part.
    Counting the batch would send somebody chasing a part on the shelf."""
    _, order = ordered_order(client, items=[part("Windshield", "WS-1"), part("Brake kit", "BR-1")])
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    vendor = client.post("/api/vendors", json={"name": "Cal's Auto Salvage"}).json()
    received = client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={
            "item_ids": [items[0]["id"]],
            "vendor_id": vendor["id"],
            "invoice_number": "INV-1",
        },
    )
    assert received.status_code in (200, 201), received.text

    rows = client.get("/api/parts/on-order").json()
    assert len(rows) == 1
    assert rows[0]["po_outstanding"] == 1, "a part already on the shelf is still being counted as chaseable"


def test_a_line_never_marked_ordered_carries_no_batch(client):
    """Parts received without ever going through ordering, and every line from
    before purchase orders existed, have no batch -- and must say so rather
    than borrowing somebody else's number."""
    we_owe = make_we_owe(client, "Renata Silva", "Replace tie rod")
    order = client.post(
        "/api/orders", json={"concern": "Tie rod", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    save_estimate(client, order["id"], [part("Tie rod", "TR-1")])
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{items[0]['id']}/status",
        json={"status": "ordered"},
    )

    row = next(r for r in client.get("/api/parts/on-order").json() if r["description"] == "Tie rod")
    assert row["po_number"] is not None, "single-line ordering should still open a batch"

    with_no_batch = [r for r in client.get("/api/parts/on-order").json() if r["po_id"] is None]
    assert all(r["po_outstanding"] == 0 for r in with_no_batch)
