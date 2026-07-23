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
    assert db.execute("SELECT count(*) FROM app_settings").fetchone()[0] == 1
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
