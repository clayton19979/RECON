"""Receiving a part must move the ticket's own total on the lot's work.

Recon and we-owe are billed at the shop's cost -- a ticket's total IS what
the parts cost (CLAUDE.md). Every door that writes a line now keeps its price
and cost one number (see test_at_cost_money_doors.py), but receiving was
still split: posting the vendor's bill wrote the billed price onto unit_cost
-- feeding every rollup the board and the Lot Report read -- while unit_price
and line_total, which feed the ticket's own subtotal and the invoice the lot
is billed with at close, kept whatever the line was written down at. A used
alternator written at $100 and billed at $175 left the ticket saying $100
under a car whose cost said $175, and closing that ticket billed the lot
$100 for a part the shop had paid $175 for.

Now the receive doors move the ticket's money with the bill on recon and
we-owe. What the line was written down at is not lost -- surviving the bill
is quoted_unit_cost's whole job (see test_quote_vs_cost.py). Retail is
untouched: there the marked-up price is a real, distinct number that must
outlive receiving.

Rows split by receives from before this fix stay split until their ticket
happens to be re-saved through the grid, so init_db heals them once at
startup, reconciling the same way the doors do.
"""

from __future__ import annotations

import sqlite3

import pytest

from app.db import init_db
from tests.helpers import (
    make_recon_order,
    make_recon_vehicle,
    make_retail_order,
    make_we_owe,
    save_estimate,
)


def part(cost, description="Used alternator", part_number="ALT-1", price=None):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": 1,
        "unit_price": cost if price is None else price,
        "unit_cost": cost,
    }


def receive(client, order_id, item_ids, vendor_id, invoice_number, overrides=None):
    payload = {"item_ids": item_ids, "vendor_id": vendor_id, "invoice_number": invoice_number}
    if overrides:
        payload["cost_overrides"] = {str(item_id): cost for item_id, cost in overrides.items()}
    res = client.post(f"/api/orders/{order_id}/estimate/receive-parts", json=payload)
    assert res.status_code == 200, res.text
    return res.json()


def ticket_estimate(client, order_id):
    return client.get(f"/api/orders/{order_id}").json()["estimate"]


def recon_ticket(client, stock="R-RCV1", written=100.0):
    vendor = client.post("/api/vendors", json={"name": "Pull-A-Part"}).json()
    vehicle = make_recon_vehicle(client, stock_number=stock, purchase_price=0)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(client, order["id"], [part(written)])
    return vendor, vehicle, order, estimate["items"][0]["id"]


# ---------------------------------------------------------------------------
# The car's own Receive Selected button
# ---------------------------------------------------------------------------


def test_receiving_over_the_written_price_moves_the_ticket_total_too(client):
    """Written at $100, billed at $175: the ticket has to say $175, because
    on recon the ticket's total IS what the parts cost."""
    vendor, vehicle, order, item_id = recon_ticket(client)
    receive(client, order["id"], [item_id], vendor["id"], "INV-175", overrides={item_id: 175})

    estimate = ticket_estimate(client, order["id"])
    line = estimate["items"][0]
    assert line["unit_cost"] == pytest.approx(175.0)
    assert line["unit_price"] == pytest.approx(175.0), "the ticket's side of the line didn't follow the bill"
    assert line["line_total"] == pytest.approx(175.0)
    assert estimate["subtotal"] == pytest.approx(175.0)
    assert line["quoted_unit_cost"] == pytest.approx(100.0), "what it was written down at must survive the bill"

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["total_cost"] == pytest.approx(175.0)
    assert estimate["total"] == pytest.approx(detail["total_cost"]), "ticket and car must tell the same story"


def test_receiving_under_the_written_price_moves_the_ticket_total_down(client):
    """The junkyard half of the same coin -- coming in under the written
    price is at least as common here as going over."""
    vendor, _vehicle, order, item_id = recon_ticket(client, stock="R-RCV2")
    receive(client, order["id"], [item_id], vendor["id"], "INV-60", overrides={item_id: 60})

    estimate = ticket_estimate(client, order["id"])
    assert estimate["items"][0]["unit_price"] == pytest.approx(60.0)
    assert estimate["subtotal"] == pytest.approx(60.0)


def test_the_invoice_at_close_bills_what_the_shop_paid(client):
    """The money rule end to end: recon is billed at the shop's cost, so the
    invoice cut at close must carry the billed number, not the written one."""
    vendor, _vehicle, order, item_id = recon_ticket(client, stock="R-RCV3")
    receive(client, order["id"], [item_id], vendor["id"], "INV-CLOSE", overrides={item_id: 175})
    client.post(
        f"/api/orders/{order['id']}/authorization",
        json={"status": "approved", "approved_by": "Clay", "method": "in_person"},
    )
    res = client.post(f"/api/orders/{order['id']}/invoice", json={"actor": "Clay"})
    assert res.status_code == 201, res.text
    invoice = res.json()
    assert invoice["subtotal"] == pytest.approx(175.0)
    assert invoice["items"][0]["unit_price"] == pytest.approx(175.0)


def test_we_owe_receiving_follows_the_same_rule(client):
    owed = make_we_owe(client)
    order = client.post(
        "/api/orders", json={"concern": "Owed tie rod", "segment": "we_owe", "we_owe_id": owed["id"]}
    ).json()
    vendor = client.post("/api/vendors", json={"name": "NAPA Merrillville"}).json()
    estimate = save_estimate(client, order["id"], [part(40, description="Tie rod end", part_number="TR-1")])
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"], "INV-WO", overrides={item_id: 55})

    estimate = ticket_estimate(client, order["id"])
    assert estimate["items"][0]["unit_price"] == pytest.approx(55.0)
    assert estimate["subtotal"] == pytest.approx(55.0)


def test_retail_markup_survives_receiving(client):
    """On retail the marked-up price is a real, distinct number. Receiving at
    a different cost must move only the cost side."""
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    order = make_retail_order(client)
    estimate = save_estimate(client, order["id"], [part(80, part_number="BP-1", price=120)])
    item_id = estimate["items"][0]["id"]
    receive(client, order["id"], [item_id], vendor["id"], "INV-RET", overrides={item_id: 95})

    estimate = ticket_estimate(client, order["id"])
    line = estimate["items"][0]
    assert line["unit_cost"] == pytest.approx(95.0)
    assert line["unit_price"] == pytest.approx(120.0), "receiving must never touch a retail selling price"
    assert line["line_total"] == pytest.approx(120.0)
    assert estimate["subtotal"] == pytest.approx(120.0)


# ---------------------------------------------------------------------------
# The A/P door (Post a Vendor Invoice / the invoice agent)
# ---------------------------------------------------------------------------


def test_vendor_invoice_door_moves_the_ticket_total_too(client):
    _vendor, _vehicle, order, _item_id = recon_ticket(client, stock="R-RCV4")
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "Pull-A-Part",
            "invoice_number": "PAP-4411",
            "po_number": order["number"],
            "subtotal": 175,
            "tax": 0,
            "total": 175,
            "items": [
                {
                    "part_number": "ALT-1",
                    "description": "Used alternator",
                    "quantity": 1,
                    "unit_cost": 175,
                    "kind": "part",
                }
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "posted", res.text

    estimate = ticket_estimate(client, order["id"])
    line = estimate["items"][0]
    assert line["unit_price"] == pytest.approx(175.0)
    assert line["line_total"] == pytest.approx(175.0)
    assert estimate["subtotal"] == pytest.approx(175.0)


# ---------------------------------------------------------------------------
# Healing databases written before the fix
# ---------------------------------------------------------------------------


def split_line_directly(db_path, item_id, **columns):
    """Reshape a line the way an old build left it -- straight SQL, because
    the doors that used to write these shapes are closed now."""
    with sqlite3.connect(db_path) as db:
        sets = ",".join(f"{name}=?" for name in columns)
        db.execute(f"UPDATE estimate_items SET {sets} WHERE id=?", (*columns.values(), item_id))


def line_row(db_path, item_id):
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        return dict(db.execute("SELECT * FROM estimate_items WHERE id=?", (item_id,)).fetchone())


def estimate_totals(db_path, order_id):
    with sqlite3.connect(db_path) as db:
        return db.execute("SELECT subtotal, total FROM estimates WHERE order_id=?", (order_id,)).fetchone()


def test_startup_heals_a_line_an_old_receive_split(client, db_path):
    """A pre-fix receive moved only unit_cost. The billed number is the
    vendor's paper and wins; the written-down price it replaces is preserved
    as the quote when none was recorded."""
    _vendor, _vehicle, order, item_id = recon_ticket(client, stock="R-HEAL1")
    split_line_directly(db_path, item_id, unit_cost=175, received_quantity=1, received_cost=175, quoted_unit_cost=None)

    init_db(db_path)

    line = line_row(db_path, item_id)
    assert line["unit_price"] == pytest.approx(175.0)
    assert line["unit_cost"] == pytest.approx(175.0)
    assert line["line_total"] == pytest.approx(175.0)
    assert line["quoted_unit_cost"] == pytest.approx(100.0), "the written-down price must land in the quote column"
    subtotal, total = estimate_totals(db_path, order["id"])
    assert subtotal == pytest.approx(175.0)
    assert total == pytest.approx(175.0)


def test_startup_heals_a_price_only_agent_line(client, db_path):
    """The pre-#129 agent shape: money on the ticket, none on the car, and
    the miss frozen into a $0 quote. NULL is the honest quote -- 'none
    recorded' -- and every reader then falls back to the real number."""
    _vendor, _vehicle, order, item_id = recon_ticket(client, stock="R-HEAL2")
    split_line_directly(db_path, item_id, unit_price=85, unit_cost=0, quoted_unit_cost=0, line_total=85)

    init_db(db_path)

    line = line_row(db_path, item_id)
    assert line["unit_cost"] == pytest.approx(85.0)
    assert line["unit_price"] == pytest.approx(85.0)
    assert line["quoted_unit_cost"] is None
    subtotal, _total = estimate_totals(db_path, order["id"])
    assert subtotal == pytest.approx(85.0)


def test_startup_heals_a_cost_only_agent_line(client, db_path):
    """The other pre-#129 shape: money on the car, $0 on the ticket."""
    _vendor, _vehicle, order, item_id = recon_ticket(client, stock="R-HEAL3")
    split_line_directly(db_path, item_id, unit_price=0, unit_cost=85, line_total=0)

    init_db(db_path)

    line = line_row(db_path, item_id)
    assert line["unit_price"] == pytest.approx(85.0)
    assert line["line_total"] == pytest.approx(85.0)
    assert line["quoted_unit_cost"] == pytest.approx(100.0), "a real recorded quote is not the heal's to rewrite"
    subtotal, _total = estimate_totals(db_path, order["id"])
    assert subtotal == pytest.approx(85.0)


def test_startup_leaves_retail_lines_alone(client, db_path):
    """A split price on retail is a margin, not a wound."""
    order = make_retail_order(client)
    estimate = save_estimate(client, order["id"], [part(80, part_number="BP-1", price=120)])
    item_id = estimate["items"][0]["id"]

    init_db(db_path)

    line = line_row(db_path, item_id)
    assert line["unit_price"] == pytest.approx(120.0)
    assert line["unit_cost"] == pytest.approx(80.0)


def test_the_heal_is_idempotent(client, db_path):
    _vendor, _vehicle, _order, item_id = recon_ticket(client, stock="R-HEAL4")
    split_line_directly(db_path, item_id, unit_cost=175, quoted_unit_cost=None)

    init_db(db_path)
    first = line_row(db_path, item_id)
    init_db(db_path)
    assert line_row(db_path, item_id) == first
