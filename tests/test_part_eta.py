"""When the vendor said the part would land, and what that changes.

The On Order desk could say how long a part had been coming and nothing at
all about when it was due. Those are different questions with different
answers: a windshield nine days out that the supplier promised for tomorrow is
fine, and a brake kit four days out that was promised on Monday is a broken
promise somebody should be ringing about this morning. Both rendered
identically, so the desk sorted the wrong one to the top and the right one
sat halfway down the list.

So a batch now carries the day it was promised for, and the desk carries how
far past it today is. The assertions here are mostly about honesty and about
the two figures never disagreeing:

  - "they didn't say" stays a first-class answer and is never printed as a
    number, the same refusal to guess an unstamped order date already gets;
  - a date nobody can read is refused at the door rather than stored and
    quietly ignored;
  - the promised day is compared against the shop's own calendar (see
    db.now()), because "they said Thursday" means Thursday in Merrillville;
  - a broken promise leads the list, and everything else keeps exactly the
    order it had before this existed.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

from app.db import connect
from tests.helpers import days_ago, make_recon_order, make_recon_vehicle, save_estimate


def part(description="Wheel bearing", part_number="WB-1", unit_cost=70.0, quantity=1):
    return {
        "kind": "part",
        "description": description,
        "part_number": part_number,
        "quantity": quantity,
        "unit_price": unit_cost,
        "unit_cost": unit_cost,
    }


def day(offset: int) -> str:
    """A shop-local calendar date `offset` days from today, as the UI sends it."""
    return (date.today() + timedelta(days=offset)).isoformat()


def ordered_car(client, stock_number="R-1001", items=None):
    """A recon car with its parts marked ordered -- which is what puts them on
    the desk and gives them a batch to hang a promised day on."""
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], items or [part()])
    client.patch(f"/api/orders/{order['id']}/estimate/order-parts")
    po = client.get(f"/api/orders/{order['id']}/purchase-orders").json()[0]
    return vehicle, order, po


def set_ordered_at(db_path, order_id: int, when: str) -> None:
    with connect(db_path) as db:
        db.execute(
            "UPDATE estimate_items SET ordered_at=? WHERE estimate_id=(SELECT id FROM estimates WHERE order_id=?)",
            (when, order_id),
        )
        db.commit()


def promise(client, order_id: int, po_id: int, when: str, **extra):
    res = client.patch(f"/api/orders/{order_id}/purchase-orders/{po_id}", json={"expected_at": when, **extra})
    return res


# ---------------------------------------------------------------------------
# Recording the answer
# ---------------------------------------------------------------------------


def test_a_promised_day_can_be_recorded_after_the_order_was_placed(client):
    """The number is pulled to *make* the call, so nobody knows the date at
    that moment. It has to be fillable in afterwards or it is never recorded."""
    _, order, po = ordered_car(client)
    assert po["expected_at"] == "", "a fresh batch claims a promised day nobody gave"

    res = promise(client, order["id"], po["id"], day(3))
    assert res.status_code == 200, res.text
    assert res.json()["expected_at"] == day(3)

    row = client.get("/api/parts/on-order").json()[0]
    assert row["expected_at"] == day(3)
    assert row["days_late"] == -3, "three days to go should read as three days to go"


def test_the_promised_day_can_be_moved_and_taken_back_off(client):
    """A vendor who said Tuesday rings back and says Thursday, and a date heard
    wrong has to be erasable -- "they didn't say" must stay sayable."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(2))
    promise(client, order["id"], po["id"], day(5))
    assert client.get("/api/parts/on-order").json()[0]["days_late"] == -5

    assert promise(client, order["id"], po["id"], "").status_code == 200
    row = client.get("/api/parts/on-order").json()[0]
    assert row["expected_at"] == ""
    assert row["days_late"] is None, "a cleared promise came back as a number"


def test_a_day_nobody_can_read_is_refused_rather_than_stored(client):
    """Stored and silently uncomparable is the worst outcome: the desk would
    show a promise that could never be broken."""
    _, order, po = ordered_car(client)
    for bad in ("next tuesday", "08/14/2026", "2026-13-40"):
        res = promise(client, order["id"], po["id"], bad)
        assert res.status_code in (400, 422), f"{bad!r} was accepted as a date"
    assert client.get("/api/parts/on-order").json()[0]["expected_at"] == ""


def test_one_answer_covers_every_part_on_that_call(client):
    """A batch is one phone call to one supplier, so the day they gave applies
    to everything that went out on it. Typing it four times is four chances to
    type it differently."""
    _, order, po = ordered_car(client, items=[part("Windshield", "WS-1", 180.0), part("Brake kit", "BR-1", 240.0)])
    promise(client, order["id"], po["id"], day(-1))

    rows = client.get("/api/parts/on-order").json()
    assert len(rows) == 2
    assert {r["days_late"] for r in rows} == {1}, "one answer didn't reach both parts on the call"


def test_setting_the_day_is_written_into_the_cars_history(client):
    """A week later nobody remembers which call produced which answer."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(4), actor="clayton")

    activity = client.get(f"/api/orders/{order['id']}").json()["activity"]
    logged = [a for a in activity if a["action"] == "purchase_order_expected_set"]
    assert logged, "recording what the vendor promised leaves no trace on the ticket"
    assert logged[-1]["actor"] == "clayton"
    assert logged[-1]["details"]["expected_at"] == day(4)


def test_saying_the_same_day_again_is_not_a_second_answer(client, db_path):
    """Re-sending what is already on file is somebody at the ticket, not news
    about the car -- the same rule a repeated line-status save follows."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(4))
    before = len(client.get(f"/api/orders/{order['id']}").json()["activity"])

    promise(client, order["id"], po["id"], day(4))

    after = client.get(f"/api/orders/{order['id']}").json()["activity"]
    assert len(after) == before, "re-saying the same promised day logged it twice"


def test_the_supplier_and_the_day_can_be_recorded_in_one_go(client):
    """Both come off the same phone call, and both are worth their own line --
    "who did we order from" and "when did they say" are the two questions asked
    about a car that is sitting waiting."""
    _, order, po = ordered_car(client)
    res = client.patch(
        f"/api/orders/{order['id']}/purchase-orders/{po['id']}",
        json={"vendor_name": "NAPA Merrillville", "expected_at": day(2), "actor": "antonio"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["expected_at"] == day(2)

    actions = [a["action"] for a in client.get(f"/api/orders/{order['id']}").json()["activity"]]
    assert "purchase_order_vendor_set" in actions
    assert "purchase_order_expected_set" in actions, "the promised day was swallowed by the supplier change"

    row = client.get("/api/parts/on-order").json()[0]
    assert row["vendor_name"] == "NAPA Merrillville"
    assert row["days_late"] == -2


# ---------------------------------------------------------------------------
# What the desk does with it
# ---------------------------------------------------------------------------


def test_due_today_is_not_yet_a_broken_promise(client):
    """A part promised for today may well turn up this afternoon. Ringing at
    8am about it is the call that annoys a supplier for nothing."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(0))

    assert client.get("/api/parts/on-order").json()[0]["days_late"] == 0


def test_a_part_nobody_gave_a_day_for_says_so_rather_than_guessing(client):
    """Same refusal the Ordered column already makes about an unstamped line:
    "we don't know" and "due today" are opposite answers."""
    _, order, _ = ordered_car(client)
    assert order  # the batch exists; nobody was told a day
    row = client.get("/api/parts/on-order").json()[0]
    assert row["expected_at"] == ""
    assert row["days_late"] is None


def test_a_broken_promise_leads_the_list(client, db_path):
    """The desk exists to decide who to ring first. A supplier three days past
    what they said outranks a part that has simply been coming a long time --
    the second one may be due tomorrow, and only the first one is news."""
    _, slow, _ = ordered_car(client, "R-SLOW", [part("Windshield", "WS-1", 180.0)])
    _, broken, broken_po = ordered_car(client, "R-BROKEN", [part("Brake kit", "BR-1", 240.0)])
    set_ordered_at(db_path, slow["id"], days_ago(21))
    promise(client, broken["id"], broken_po["id"], day(-3))

    rows = client.get("/api/parts/on-order").json()
    assert [r["part_number"] for r in rows] == ["BR-1", "WS-1"], (
        "a promise broken three days ago is sitting below a part that is merely old"
    )
    assert rows[0]["days_late"] == 3


def test_the_worst_broken_promise_leads_the_broken_ones(client):
    _, mild, mild_po = ordered_car(client, "R-MILD", [part("Belt", "SB-1", 14.0)])
    _, bad, bad_po = ordered_car(client, "R-BAD", [part("Rotors", "RT-1", 60.0)])
    promise(client, mild["id"], mild_po["id"], day(-1))
    promise(client, bad["id"], bad_po["id"], day(-9))

    assert [r["part_number"] for r in client.get("/api/parts/on-order").json()] == ["RT-1", "SB-1"]


def test_a_promise_still_in_the_future_does_not_jump_the_queue(client, db_path):
    """Only broken promises are lifted. A part due next week has nothing to
    chase, so a genuinely old order still leads the list."""
    _, old, _ = ordered_car(client, "R-OLD", [part("Windshield", "WS-1", 180.0)])
    _, due, due_po = ordered_car(client, "R-DUE", [part("Belt", "SB-1", 14.0)])
    set_ordered_at(db_path, old["id"], days_ago(21))
    promise(client, due["id"], due_po["id"], day(6))

    assert [r["part_number"] for r in client.get("/api/parts/on-order").json()] == ["WS-1", "SB-1"]


def test_undated_lines_still_sort_last(client, db_path):
    """The existing order has to survive underneath the new one: a line with no
    recorded order date knows nothing about its own age and must not be lifted
    by simply having no promise to break."""
    ordered_car(client, "R-DATED", [part("Windshield", "WS-1", 180.0)])
    _, undated, _ = ordered_car(client, "R-UNDATED", [part("Belt", "SB-1", 14.0)])
    _, late, late_po = ordered_car(client, "R-LATE", [part("Rotors", "RT-1", 60.0)])
    set_ordered_at(db_path, undated["id"], "")
    promise(client, late["id"], late_po["id"], day(-2))

    assert [r["part_number"] for r in client.get("/api/parts/on-order").json()] == ["RT-1", "WS-1", "SB-1"]


def test_receiving_the_part_takes_the_promise_off_the_desk(client):
    """The promise is answered by the part turning up, not by anybody clearing
    it -- nothing on this desk should need tidying up by hand."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(-5))
    item = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"][0]
    vendor = client.post("/api/vendors", json={"name": "Advance"}).json()

    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item["id"]], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )

    assert client.get("/api/parts/on-order").json() == []
    # The record of what was promised survives on the batch, so "did they
    # actually deliver when they said" stays answerable after the fact.
    assert client.get(f"/api/orders/{order['id']}/purchase-orders").json()[0]["expected_at"] == day(-5)


def test_the_promised_day_reaches_the_ticket_screen_too(client):
    """The desk is where it gets typed, but the batch strip on the car's own
    ticket has to be able to show the same answer."""
    _, order, po = ordered_car(client)
    promise(client, order["id"], po["id"], day(1))

    batches = client.get(f"/api/orders/{order['id']}/purchase-orders").json()
    assert batches[0]["expected_at"] == day(1)
    assert client.get(f"/api/orders/{order['id']}").json()["purchase_orders"][0]["expected_at"] == day(1)


def test_an_unknown_batch_is_still_refused(client):
    _, order, _ = ordered_car(client)
    assert (
        client.patch(f"/api/orders/{order['id']}/purchase-orders/9999", json={"expected_at": day(1)}).status_code == 404
    )


# ---------------------------------------------------------------------------
# The database, and the screen
# ---------------------------------------------------------------------------


def test_a_database_from_before_this_existed_gains_the_column_blank(tmp_path):
    """Every batch already on file was placed before anyone could record an
    answer, so they all have to arrive blank -- which is exactly what was true
    of them, rather than a promised day nobody ever gave."""
    from app.db import init_db

    db_path = tmp_path / "legacy.db"
    init_db(db_path)
    with connect(db_path) as db:
        customer_id = db.execute(
            "INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,?)",
            ("Retail Customer", "", "", 0, "2026-01-01T00:00:00"),
        ).lastrowid
        vehicle_id = db.execute(
            "INSERT INTO vehicles(customer_id,year,make,model,created_at) VALUES(?,?,?,?,?)",
            (customer_id, 2020, "Kia", "Soul", "2026-01-01T00:00:00"),
        ).lastrowid
        order_id = db.execute(
            "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,status,created_at) VALUES(?,?,?,?,?,?,?)",
            ("RO-LEGACY-0001", customer_id, vehicle_id, "Legacy row", "retail", "estimate", "2026-01-01T00:00:00"),
        ).lastrowid
        db.execute(
            "INSERT INTO purchase_orders(order_id,sequence,number,created_at) VALUES(?,?,?,?)",
            (order_id, 1, "LEGACY-1", "2026-01-01T00:00:00"),
        )
        # Put the database back the way it looked before the column existed.
        db.execute("ALTER TABLE purchase_orders DROP COLUMN expected_at")
        db.commit()

    # Re-running init_db is what happens on every app start.
    init_db(db_path)

    with connect(db_path) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(purchase_orders)")}
        assert "expected_at" in columns, "an older database never gains the promised-day column"
        rows = db.execute("SELECT number, expected_at FROM purchase_orders").fetchall()
        assert [tuple(row) for row in rows] == [("LEGACY-1", "")], (
            "a batch that predates this gained a promised day nobody ever gave"
        )


def test_the_on_order_table_still_matches_its_column_count() -> None:
    """The header lives in index.html, the cells in a template literal in
    cores.js, and the empty state's width in ON_ORDER_COLUMNS. Nothing connects
    the three, so a column added to one shifts every cell in the others."""
    from pathlib import Path

    static = Path(__file__).resolve().parent.parent / "static"
    html = (static / "index.html").read_text(encoding="utf-8")
    js = (static / "js" / "cores.js").read_text(encoding="utf-8")
    skeletons = (static / "js" / "skeletons.js").read_text(encoding="utf-8")

    section = html[html.index('id="on-order-table"') - 4000 : html.index('id="on-order-table"')]
    thead = section[section.rindex("<thead") :]
    columns = len(re.findall(r"<th\b", thead))

    row = js[js.index('<tr class="clickable" data-id="${p.id}"') :]
    cells = len(re.findall(r"<td\b", row[: row.index("</tr>")]))

    declared = re.search(r"^export const ON_ORDER_COLUMNS = (\d+);", skeletons, re.MULTILINE)
    assert declared, "ON_ORDER_COLUMNS is gone -- the skeleton and empty state have no shared width"
    assert columns == cells, f"the On Order header has {columns} columns but the row emits {cells} cells"
    assert int(declared.group(1)) == columns, (
        f"ON_ORDER_COLUMNS is {declared.group(1)} but the On Order header has {columns} columns"
    )
