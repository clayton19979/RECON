"""The idle clock has to move when work happens.

`orders.last_activity_at` is what the board's Idle column, its Stalled card and
the Lot Report's "untouched N days" all read. A write that changes a ticket
without moving it doesn't just miss a log line -- it makes a car that is being
actively worked on look abandoned, and puts a red number in front of Walt that
is simply false.

Three writes were missing it, and they were not obscure ones: marking parts
ordered (both the per-line dropdown and the ticket's Order Parts button) and a
vendor invoice posting onto a ticket. Ordering parts is the single most common
thing that happens to a recon car after it is quoted.

So this file does two things. It proves the three now move the clock -- and it
holds a structural guard, `test_every_ticket_write_moves_the_clock`, over the
whole route table, so the next endpoint someone adds under /orders/{order_id}
cannot quietly reintroduce the same hole.
"""

from __future__ import annotations

import ast
from pathlib import Path

from tests.helpers import (
    backdate_activity,
    days_ago,
    make_recon_order,
    make_recon_vehicle,
    save_estimate,
)

PART = {"kind": "part", "description": "Windshield", "part_number": "WS-1", "quantity": 1, "unit_price": 180}


def board_row(client, recon_id):
    rows = client.get("/api/vehicles-board").json()
    return next(r for r in rows if r["recon_id"] == recon_id)


def activity(client, order_id):
    return client.get(f"/api/orders/{order_id}").json()["activity"]


def actions(client, order_id):
    return [event["action"] for event in activity(client, order_id)]


def quoted_ticket(client, db_path, stock_number, idle_days=30):
    """A recon car with one quoted part on it that nobody has touched in a
    month -- the exact car the board is meant to be shouting about."""
    recon = make_recon_vehicle(client, stock_number=stock_number, purchase_price=0)
    order = make_recon_order(client, recon["id"])
    estimate = save_estimate(client, order["id"], [PART])
    backdate_activity(db_path, order["id"], days_ago(idle_days))
    assert board_row(client, recon["id"])["idle_days"] >= idle_days, "precondition: the car really has gone quiet"
    return recon, order, estimate


def test_ordering_all_parts_moves_the_clock(client, db_path):
    """The Order Parts button. Before this, ordering a car's parts left it
    reading as untouched for however long it had been sitting -- so the board
    kept it on the Stalled list and the Lot Report kept saying nobody had
    looked at it, on the morning somebody had."""
    recon, order, _ = quoted_ticket(client, db_path, "R-ORDER")

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts", json={"actor": "Antonio"})
    assert res.status_code == 200, res.text
    assert res.json()["updated"] == 1

    row = board_row(client, recon["id"])
    assert row["idle_days"] == 0, f"ordering the parts left the car reading as idle {row['idle_days']} days"
    assert "parts_ordered" in actions(client, order["id"]), "ordering parts left nothing in the ticket's history"


def test_ordering_nothing_does_not_move_the_clock(client, db_path):
    """The other half of the rule. A clock that any no-op resets is worse than
    one that never moves: pressing Order Parts on a ticket with nothing left to
    order would clear the Stalled flag off a car nobody had touched."""
    recon, order, _ = quoted_ticket(client, db_path, "R-NOOP")
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts", json={"actor": "Antonio"})
    before = board_row(client, recon["id"])["last_activity_at"]

    res = client.patch(f"/api/orders/{order['id']}/estimate/order-parts", json={"actor": "Antonio"})
    assert res.json()["updated"] == 0
    assert board_row(client, recon["id"])["last_activity_at"] == before


def test_ordering_one_line_moves_the_clock(client, db_path):
    """The per-line status dropdown is the same event as the button and has to
    move the same clock -- otherwise which control you happened to use decides
    whether the car looks abandoned."""
    recon, order, estimate = quoted_ticket(client, db_path, "R-LINE")
    item_id = estimate["items"][0]["id"]

    res = client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/status",
        json={"status": "ordered", "actor": "Antonio"},
    )
    assert res.status_code == 200, res.text
    assert board_row(client, recon["id"])["idle_days"] == 0
    assert "parts_ordered" in actions(client, order["id"])


def test_reselecting_the_same_status_is_not_activity(client, db_path):
    recon, order, estimate = quoted_ticket(client, db_path, "R-SAME")
    item_id = estimate["items"][0]["id"]
    before = board_row(client, recon["id"])["last_activity_at"]

    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/status",
        json={"status": "quoted", "actor": "Antonio"},
    )
    assert board_row(client, recon["id"])["last_activity_at"] == before


def test_putting_a_line_back_to_quoted_is_logged_as_its_own_thing(client, db_path):
    """Undoing an order is real activity too, but it is not "parts ordered" --
    the log has to be able to tell someone reading it back which way it went."""
    recon, order, estimate = quoted_ticket(client, db_path, "R-UNDO")
    item_id = estimate["items"][0]["id"]
    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/status",
        json={"status": "ordered", "actor": "Antonio"},
    )
    client.patch(
        f"/api/orders/{order['id']}/estimate/items/{item_id}/status",
        json={"status": "quoted", "actor": "Antonio"},
    )
    assert actions(client, order["id"])[-1] == "part_order_undone"
    assert board_row(client, recon["id"])["idle_days"] == 0


def test_a_vendor_invoice_landing_on_a_ticket_moves_the_clock(client, db_path):
    """Posting a vendor bill against a ticket receives its parts and puts real
    money on the car. It was leaving no mark on the ticket at all: nothing in
    the history, and the car still reading as untouched for a month."""
    recon, order, _ = quoted_ticket(client, db_path, "R-INV")
    client.post("/api/vendors", json={"name": "WorldPac"})

    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "WorldPac",
            "invoice_number": "INV-880",
            "order_id": order["id"],
            "subtotal": 180,
            "tax": 0,
            "total": 180,
            "items": [
                {"part_number": "WS-1", "description": "Windshield", "quantity": 1, "unit_cost": 180, "kind": "part"}
            ],
            "source": "invoice-agent",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "posted", res.json()

    row = board_row(client, recon["id"])
    assert row["idle_days"] == 0, f"the parts arrived, and the car still reads as idle {row['idle_days']} days"
    assert row["actual_cost"] == 180, "precondition: the money really did land on the car"
    posted = [event for event in activity(client, order["id"]) if event["action"] == "ap_invoice_posted"]
    assert posted, "a vendor invoice posted against this ticket left no trace on it"
    assert posted[-1]["actor"] == "invoice-agent", "the log should say where the bill came from"
    assert posted[-1]["details"]["invoice_number"] == "INV-880"


def test_an_invoice_with_no_ticket_still_posts(client):
    """The guard on the fix: only an invoice that actually lands on a ticket
    logs to that ticket. A bill for shop supplies belongs to no car and must
    still post cleanly rather than blowing up looking for one."""
    client.post("/api/vendors", json={"name": "WorldPac"})
    res = client.post(
        "/api/agent/invoices/process",
        json={
            "vendor_name": "WorldPac",
            "invoice_number": "SUPPLIES-1",
            "po_number": "",
            "subtotal": 40,
            "tax": 0,
            "total": 40,
            "items": [{"part_number": "RAG-1", "description": "Shop rags", "quantity": 1, "unit_cost": 40}],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "posted"
    assert res.json()["order_id"] is None


def test_a_car_whose_parts_were_ordered_today_is_not_stalled(client, db_path):
    """What all of this is actually for. The Lot Report is the sheet Walt
    reads, and it was telling him a car had been untouched for a month on the
    morning its parts went on order."""
    _, order, _ = quoted_ticket(client, db_path, "R-LOT")
    before = next(r for r in client.get("/api/reports/lot").json() if r["stock_number"] == "R-LOT")
    assert "untouched" in before["needs"].lower(), f"precondition: {before['needs']}"

    client.patch(f"/api/orders/{order['id']}/estimate/order-parts", json={"actor": "Antonio"})

    after = next(r for r in client.get("/api/reports/lot").json() if r["stock_number"] == "R-LOT")
    assert "untouched" not in after["needs"].lower(), after["needs"]
    assert "1 part on order" in after["needs"], after["needs"]


# --------------------------------------------------------------------------
# The structural guard
# --------------------------------------------------------------------------

# Every write that reaches a ticket has to move that ticket's clock, and the
# only reliable way to do it is record_activity (which calls touch_order) or,
# for the writes that deliberately don't log an event, touch_order directly --
# see app/workflow.py. Checking the source rather than exercising every route
# is on purpose: driving twenty-odd endpoints would need twenty-odd valid
# bodies and would still only cover the ones somebody remembered to add. This
# catches a new endpoint the day it is written, with nothing to remember.
TOUCHERS = ("record_activity(", "touch_order(")

WRITE_DECORATORS = {"post", "patch", "put", "delete"}

APP_DIR = Path(__file__).resolve().parent.parent / "app"


def ticket_write_routes():
    """Every route handler in app/ that writes to a ticket.

    Read out of the source rather than off the running app's route table: the
    framework keeps an included router as an opaque wrapper, so walking
    app.routes finds only the handful of endpoints declared on the app object
    itself and silently misses the twenty-odd that live in routers -- a scan
    that quietly checks nothing is worse than no scan. The decorator is right
    there in the file, so read it from there.
    """
    found = []
    for module in sorted(APP_DIR.glob("*.py")):
        source = module.read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.FunctionDef):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                method = decorator.func.attr
                path = decorator.args[0].value if decorator.args and isinstance(decorator.args[0], ast.Constant) else ""
                if method in WRITE_DECORATORS and isinstance(path, str) and "{order_id}" in path:
                    body = ast.get_source_segment(source, node) or ""
                    found.append((method.upper(), path, module.name, body))
    return found


def test_every_ticket_write_moves_the_clock():
    routes = ticket_write_routes()
    assert len(routes) > 15, f"only found {len(routes)} ticket write routes -- the scan is broken"

    silent = [
        f"{method} {path} ({module})"
        for method, path, module, body in routes
        if not any(token in body for token in TOUCHERS)
    ]
    assert not silent, (
        "these writes change a ticket without moving its idle clock, so the board and the Lot Report "
        "will call the car untouched while somebody is working on it -- call record_activity (or "
        "touch_order, if the action genuinely isn't worth a log entry): " + ", ".join(silent)
    )
