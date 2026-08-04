"""The change counter behind "this screen is out of date".

Two people share one database from two PCs, and a screen only ever knew what
was true when it was opened. /api/pulse is what lets a browser find out that
somebody else has moved something -- so the thing worth testing is not the
endpoint's shape but its coverage: every ordinary shop action has to move the
number, or a screen that has gone stale will keep insisting it hasn't.
"""

from __future__ import annotations

import re
import sqlite3

from app.db import PULSE_TABLES, SCHEMA, connect, init_db, pulse_revision
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def revision(client) -> int:
    res = client.get("/api/pulse")
    assert res.status_code == 200, res.text
    return res.json()["revision"]


def test_every_table_in_the_schema_is_watched() -> None:
    """A table added later without a trigger is invisible to the freshness
    check, and the only symptom is a screen that quietly stops noticing that
    kind of change. Cheaper to fail here."""
    declared = set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", SCHEMA))
    # shop_pulse is the counter itself -- a trigger on it would recurse.
    missing = declared - set(PULSE_TABLES) - {"shop_pulse"}
    assert not missing, f"tables with no pulse trigger: {sorted(missing)}"
    stale = set(PULSE_TABLES) - declared
    assert not stale, f"pulse triggers naming tables that no longer exist: {sorted(stale)}"


def test_a_quiet_database_does_not_move(client) -> None:
    """Reading is not changing. If plain page loads moved the counter, every
    workstation would permanently be telling every other one to refresh."""
    before = revision(client)
    client.get("/api/vehicles")
    client.get("/api/orders")
    client.get("/api/tasks")
    assert revision(client) == before


def test_the_ordinary_days_work_moves_it(client) -> None:
    """One assertion per thing the two of them actually do to each other's
    screens. Each is checked on its own so a failure names the action."""
    steps = []

    def moved(label, action):
        before = revision(client)
        action()
        after = revision(client)
        steps.append((label, before, after))
        assert after > before, f"{label} did not move the change counter"

    vehicle = make_recon_vehicle(client, "R-2001")
    order = {}
    moved("writing a ticket", lambda: order.update(make_recon_order(client, vehicle["id"])))
    moved(
        "putting parts on the ticket",
        lambda: save_estimate(
            client,
            order["id"],
            [{"kind": "part", "description": "Wiper blades", "quantity": 2, "unit_price": 9, "unit_cost": 9}],
        ),
    )
    moved(
        "moving the ticket along",
        lambda: client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "antonio"}),
    )
    moved(
        "leaving a note",
        lambda: client.post(
            f"/api/orders/{order['id']}/notes", json={"text": "Customer called", "visibility": "internal"}
        ),
    )
    moved("leaving a task", lambda: client.post("/api/tasks", json={"title": "Call the customer back"}))
    moved("adding a we-owe promise", lambda: make_we_owe(client))

    assert len(steps) == 6


def test_a_refused_write_leaves_it_alone(client) -> None:
    """The bump rides in the same transaction as the write, so a rejected one
    takes it back with it. Otherwise a failed save would send every other
    screen chasing a change that never happened."""
    before = revision(client)
    res = client.post("/api/tasks", json={"title": ""})
    assert res.status_code >= 400, res.text
    assert revision(client) == before


def test_a_database_without_the_counter_answers_zero(tmp_path) -> None:
    """A backup taken before this existed can be restored over the live file.
    The freshness check going quiet is the right failure there; a screen full
    of errors is not."""
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY)")
    with connect(path) as db:
        assert pulse_revision(db) == 0


def test_restoring_a_backup_brings_the_schema_with_it(client, db_path, tmp_path) -> None:
    """Restoring puts an older database under a server that only migrates at
    startup. The restore now re-runs those steps, so the counter (and every
    other column added since the backup was taken) is there straight away
    rather than after somebody happens to restart RECON."""
    make_recon_vehicle(client, "R-3001")
    assert client.post("/api/backup/run").status_code == 200
    name = client.get("/api/backup").json()[0]["name"]

    # Stand in for a backup from before the counter existed.
    with connect(db_path) as db:
        for table in ("customers", "orders", "tasks"):
            db.execute(f"DROP TRIGGER IF EXISTS pulse_{table}_insert")
        db.execute("DROP TABLE shop_pulse")
        db.commit()
    assert revision(client) == 0

    assert client.post(f"/api/backup/restore/{name}").status_code == 200
    before = revision(client)
    client.post("/api/tasks", json={"title": "Still counting"})
    assert revision(client) > before


def test_init_db_is_idempotent_over_an_existing_database(db_path, client) -> None:
    """init_db runs at every boot and now also after a restore, so running it
    twice over a live database must change nothing -- including not resetting
    the counter, which would tell every workstation to refresh for nothing."""
    client.post("/api/tasks", json={"title": "Order the tyres"})
    before = revision(client)
    init_db(db_path)
    assert revision(client) == before
