from __future__ import annotations

import sqlite3

from app.backup import backup_database
from app.db import init_db
from app.usb_backup import load, mirror_backup, resolve, save


def test_resolve_prefers_the_recorded_path_when_it_still_exists(tmp_path):
    stick = tmp_path / "stick"
    stick.mkdir()
    record = {"path": str(stick), "label": "DiscAutoBackup", "relative": "stick"}

    assert resolve(record, drives=[], label_reader=lambda _root: None) == stick


def test_resolve_finds_the_stick_again_after_the_drive_letter_moves(tmp_path):
    # The stick was E:\RECON when it was chosen; today it came back as F:.
    # Only the label identifies it, which is the whole point of the record.
    old_letter = tmp_path / "E"
    new_letter = tmp_path / "F"
    (new_letter / "RECON").mkdir(parents=True)
    record = {"path": str(old_letter / "RECON"), "label": "DiscAutoBackup", "relative": "RECON"}

    labels = {new_letter: "DiscAutoBackup", tmp_path / "C": "Windows"}
    found = resolve(record, drives=[tmp_path / "C", new_letter], label_reader=labels.get)

    assert found == new_letter / "RECON"


def test_resolve_recreates_the_folder_when_the_matching_stick_lost_it(tmp_path):
    drive = tmp_path / "F"
    drive.mkdir()
    record = {"path": str(tmp_path / "E" / "RECON"), "label": "DiscAutoBackup", "relative": "RECON"}

    found = resolve(record, drives=[drive], label_reader=lambda _root: "DiscAutoBackup")

    assert found == drive / "RECON"
    assert found.is_dir()


def test_resolve_returns_none_when_the_stick_is_unplugged(tmp_path):
    record = {"path": str(tmp_path / "E" / "RECON"), "label": "DiscAutoBackup", "relative": "RECON"}

    assert resolve(record, drives=[tmp_path / "C"], label_reader=lambda _root: "Windows") is None


def test_resolve_without_a_record_or_label_is_none(tmp_path):
    assert resolve(None) is None
    assert resolve({}) is None
    assert resolve({"path": str(tmp_path / "gone"), "label": None, "relative": ""}) is None


def test_save_and_load_round_trip(tmp_path):
    record_file = tmp_path / "backup_destination.json"
    destination = tmp_path / "stick" / "RECON"
    destination.mkdir(parents=True)

    saved = save(record_file, destination)

    assert saved["path"] == str(destination)
    assert load(record_file) == saved


def test_load_tolerates_a_missing_or_corrupt_record(tmp_path):
    assert load(tmp_path / "never-written.json") is None
    junk = tmp_path / "junk.json"
    junk.write_text("{not json", encoding="utf-8")
    assert load(junk) is None


def test_mirror_backup_copies_under_the_same_name_and_verifies_it(tmp_path):
    source = tmp_path / "shop.db"
    init_db(source)
    backup_path = backup_database(source, tmp_path / "backups")
    stick = tmp_path / "stick"

    copied = mirror_backup(backup_path, stick)

    assert copied == stick / backup_path.name
    db = sqlite3.connect(copied)
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    db.close()


def test_mirror_backup_leaves_nothing_behind_when_the_copy_is_not_a_database(tmp_path):
    # A stick that writes back garbage must not leave a plausible-looking
    # .db sitting there for a future restore to trust.
    bogus = tmp_path / "discount-auto-ops-20260101T000000Z.db"
    bogus.write_text("not a database at all", encoding="utf-8")
    stick = tmp_path / "stick"

    try:
        mirror_backup(bogus, stick)
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass

    assert list(stick.iterdir()) == []


def test_mirror_backup_does_not_delete_older_copies_on_the_stick(tmp_path):
    source = tmp_path / "shop.db"
    init_db(source)
    stick = tmp_path / "stick"
    stick.mkdir()
    old = stick / "discount-auto-ops-20250101T000000Z.db"
    old.write_text("an older archive copy", encoding="utf-8")

    mirror_backup(backup_database(source, tmp_path / "backups"), stick)

    assert old.is_file(), "the stick is the archive -- mirroring must never prune it"
