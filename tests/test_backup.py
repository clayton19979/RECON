from __future__ import annotations

import sqlite3

from app.backup import backup_database, most_recent_backup_age_hours, prune_backups
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
