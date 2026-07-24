from __future__ import annotations

import sqlite3

from app.backup import backup_database, list_backups, most_recent_backup_age_hours, prune_backups, restore_database
from app.db import init_db


def test_backup_database_creates_verified_copy(tmp_path):
    source = tmp_path / "shop.db"
    init_db(source)
    destination_dir = tmp_path / "backups"

    backup_path = backup_database(source, destination_dir)

    assert backup_path.is_file()
    db = sqlite3.connect(backup_path)
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert db.execute("SELECT count(*) FROM customers").fetchone()[0] == 1  # the shop-owned recon customer
    db.close()


def test_backup_database_missing_source_raises(tmp_path):
    try:
        backup_database(tmp_path / "does-not-exist.db", tmp_path / "backups")
        assert False, "expected FileNotFoundError"
    except FileNotFoundError:
        pass


def test_prune_backups_keeps_only_the_most_recent(tmp_path):
    # prune_backups sorts by filename (the timestamp is embedded in it), so
    # distinct fake filenames prove the logic without waiting on real clock
    # ticks between backups.
    destination_dir = tmp_path / "backups"
    destination_dir.mkdir()
    names = [f"discount-auto-ops-2026010{n}T000000Z.db" for n in range(1, 6)]
    for name in names:
        (destination_dir / name).write_text("fake")

    removed = prune_backups(destination_dir, keep=2)
    remaining = sorted(p.name for p in destination_dir.glob("discount-auto-ops-*.db"))
    assert remaining == names[-2:]
    assert len(removed) == 3


def test_prune_backups_empty_dir_is_a_no_op(tmp_path):
    assert prune_backups(tmp_path / "nonexistent", keep=5) == []


def test_most_recent_backup_age_hours_none_when_no_backups(tmp_path):
    assert most_recent_backup_age_hours(tmp_path / "nonexistent") is None


def test_most_recent_backup_age_hours_reports_recent(tmp_path):
    source = tmp_path / "shop.db"
    init_db(source)
    destination_dir = tmp_path / "backups"
    backup_database(source, destination_dir)

    age = most_recent_backup_age_hours(destination_dir)
    assert age is not None
    assert 0 <= age < 0.01


def test_list_backups_newest_first(tmp_path):
    destination_dir = tmp_path / "backups"
    destination_dir.mkdir()
    names = [f"discount-auto-ops-2026010{n}T000000Z.db" for n in range(1, 4)]
    for name in names:
        (destination_dir / name).write_text("fake")
    assert [p.name for p in list_backups(destination_dir)] == list(reversed(names))


def test_list_backups_empty_dir(tmp_path):
    assert list_backups(tmp_path / "nonexistent") == []


def test_restore_database_replaces_live_db_and_saves_current_aside(tmp_path):
    # sqlite3's context manager only commits/rolls back the transaction, it
    # doesn't close the connection -- Windows keeps the -wal file's handle
    # open until .close() is called, which would block the restore's own
    # sidecar cleanup, so every connection here is closed explicitly.
    live = tmp_path / "shop.db"
    init_db(live)
    db = sqlite3.connect(live)
    db.execute("INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES('Original','','',0,'2026-01-01')")
    db.commit()
    db.close()

    backups_dir = tmp_path / "backups"
    backup_path = backup_database(live, backups_dir)

    # Live db changes after the backup was taken.
    db = sqlite3.connect(live)
    db.execute("INSERT INTO customers(name,phone,email,is_shop_owned,created_at) VALUES('Added later','','',0,'2026-01-02')")
    db.commit()
    db.close()

    restore_database(backup_path, live)

    db = sqlite3.connect(live)
    names = {row[0] for row in db.execute("SELECT name FROM customers WHERE id!=-1")}
    db.close()
    assert names == {"Original"}  # restored to the backed-up state

    # The pre-restore state (with 'Added later') was saved aside, not lost.
    pre_restore_files = list(tmp_path.glob("shop-pre-restore-*.db"))
    assert len(pre_restore_files) == 1
    db = sqlite3.connect(pre_restore_files[0])
    names = {row[0] for row in db.execute("SELECT name FROM customers WHERE id!=-1")}
    db.close()
    assert names == {"Original", "Added later"}


def test_restore_database_missing_backup_raises(tmp_path):
    try:
        restore_database(tmp_path / "does-not-exist.db", tmp_path / "shop.db")
        assert False, "expected FileNotFoundError"
    except FileNotFoundError:
        pass


def test_restore_database_round_trips_every_kind_of_record(tmp_path):
    """Proves the "Backup Now"/"Restore" pair is a real full backup, not
    just the CSV export's narrow vehicle-board columns: seeds one row in
    each of the areas Clay cares about (a recon vehicle, an estimate with
    a line item, A/P, a task, and RO history), backs up, restores onto a
    brand-new init_db() database (standing in for a fresh install), and
    checks every row is still there."""
    source = tmp_path / "shop.db"
    init_db(source)
    db = sqlite3.connect(source)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute(
        "INSERT INTO customers(id,name,phone,email,is_shop_owned,created_at) VALUES(1,'Jane Doe','555-1234','jane@example.com',0,'2026-01-01')"
    )
    db.execute(
        "INSERT INTO vehicles(id,customer_id,year,make,model,vin,created_at) VALUES(1,1,2019,'Ford','F-150','1FTFW1E5XKFA00001','2026-01-01')"
    )
    db.execute(
        """INSERT INTO recon_vehicles(id,vehicle_id,stock_number,acquisition_source,acquisition_date,
           purchase_price,status,created_at,updated_at) VALUES(1,1,'R-1001','auction','2026-01-01',4500.0,'acquired','2026-01-01','2026-01-01')"""
    )
    db.execute(
        "INSERT INTO orders(id,number,customer_id,vehicle_id,segment,recon_vehicle_id,concern,status,created_at) VALUES(1,'RO-1',1,1,'recon',1,'Full recon','estimate','2026-01-01')"
    )
    db.execute(
        "INSERT INTO estimates(id,order_id,labor_rate,tax_rate,subtotal,tax,total,status,created_at) VALUES(1,1,120.0,0.07,500.0,35.0,535.0,'draft','2026-01-01')"
    )
    db.execute(
        """INSERT INTO estimate_items(estimate_id,kind,description,quantity,unit_price,line_total)
           VALUES(1,'part','Brake pads',1,150.0,150.0)"""
    )
    db.execute(
        "INSERT INTO vendors(id,name,normalized_name,created_at) VALUES(1,'ACME Parts','acme parts','2026-01-01')"
    )
    db.execute(
        """INSERT INTO ap_invoices(vendor_id,order_id,invoice_number,normalized_invoice_number,po_number,
           subtotal,tax,total,status,source,posted_at) VALUES(1,1,'INV-9001','inv-9001','',150.0,10.5,160.5,'posted','manual','2026-01-01')"""
    )
    db.execute(
        "INSERT INTO tasks(title,notes,assigned_to,created_by,created_at,updated_at,order_id) VALUES('Call Jane about pickup','','[]','Clay','2026-01-01','2026-01-01',1)"
    )
    db.execute(
        "INSERT INTO activity_events(order_id,action,actor,created_at) VALUES(1,'status_changed','Clay','2026-01-01')"
    )
    db.commit()
    db.close()

    backup_path = backup_database(source, tmp_path / "backups")

    fresh = tmp_path / "fresh-install" / "shop.db"
    init_db(fresh)  # stands in for a brand-new install's empty database
    restore_database(backup_path, fresh)

    restored = sqlite3.connect(fresh)
    restored.row_factory = sqlite3.Row
    assert restored.execute("SELECT name, vin FROM vehicles JOIN customers ON customers.id=vehicles.customer_id WHERE vehicles.id=1").fetchone()[:] == ("Jane Doe", "1FTFW1E5XKFA00001")
    assert restored.execute("SELECT stock_number, status FROM recon_vehicles WHERE id=1").fetchone()[:] == ("R-1001", "acquired")
    assert restored.execute("SELECT total FROM estimates WHERE id=1").fetchone()[0] == 535.0
    assert restored.execute("SELECT description FROM estimate_items WHERE estimate_id=1").fetchone()[0] == "Brake pads"
    assert restored.execute("SELECT invoice_number, total FROM ap_invoices WHERE order_id=1").fetchone()[:] == ("INV-9001", 160.5)
    assert restored.execute("SELECT title FROM tasks WHERE order_id=1").fetchone()[0] == "Call Jane about pickup"
    assert restored.execute("SELECT action, actor FROM activity_events WHERE order_id=1").fetchone()[:] == ("status_changed", "Clay")
    restored.close()


def test_restore_database_rejects_corrupt_backup(tmp_path):
    fake_backup = tmp_path / "corrupt.db"
    fake_backup.write_text("not a real sqlite file")
    live = tmp_path / "shop.db"
    init_db(live)

    try:
        restore_database(fake_backup, live)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
    # Live db is untouched -- the corrupt "backup" was never copied over.
    with sqlite3.connect(live) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
