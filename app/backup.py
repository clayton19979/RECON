from __future__ import annotations

import argparse
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


def backup_database(source: Path, destination_dir: Path) -> Path:
    if not source.is_file():
        raise FileNotFoundError(f"Database not found: {source}")
    destination_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = destination_dir / f"discount-auto-ops-{stamp}.db"
    temporary = destination.with_suffix(".db.tmp")
    source_db = sqlite3.connect(source)
    backup_db = sqlite3.connect(temporary)
    try:
        source_db.backup(backup_db)
        if backup_db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Backup failed SQLite integrity check")
    finally:
        # sqlite3's context manager only commits/rolls back the transaction,
        # it does not close the connection -- on Windows the temp file's
        # handle would still be open here, and Path.replace() would fail.
        backup_db.close()
        source_db.close()
    temporary.replace(destination)
    return destination


def list_backups(destination_dir: Path) -> list[Path]:
    """Newest first -- the timestamp embedded in the filename sorts correctly
    as a plain string, same trick prune_backups already relies on."""
    if not destination_dir.is_dir():
        return []
    return sorted(destination_dir.glob("discount-auto-ops-*.db"), reverse=True)


def _delete_wal_sidecars(db_path: Path) -> None:
    """Best-effort cleanup of a WAL-mode database's foo.db-wal/foo.db-shm
    sidecars, tried after a restore so nothing from the old file's WAL
    lingers to be re-checkpointed later. Not load-bearing for correctness --
    SQLite stamps each WAL file with the main file's header salt and refuses
    to replay a WAL whose salt doesn't match, so a leftover sidecar from the
    pre-restore file is simply ignored the next time this path is opened.
    A brief Windows file-handle release delay after a connection's .close()
    is worth a couple of quick retries, but never worth failing the restore
    itself over."""
    for suffix in ("-wal", "-shm"):
        sidecar = db_path.with_name(db_path.name + suffix)
        for attempt in range(5):
            try:
                sidecar.unlink(missing_ok=True)
                break
            except PermissionError:
                if attempt == 4:
                    break
                time.sleep(0.1)


def restore_database(backup_path: Path, destination: Path) -> Path:
    """Restores a verified backup over the live database. A restore must
    never itself be the second way to lose data -- the current file (even if
    it's the reason a restore is needed at all) is saved aside first, so an
    accidental or wrong-backup restore can always be undone."""
    if not backup_path.is_file():
        raise FileNotFoundError(f"Backup not found: {backup_path}")
    check_db = sqlite3.connect(backup_path)
    try:
        try:
            status = check_db.execute("PRAGMA integrity_check").fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise RuntimeError(f"Backup is not a valid SQLite database, not restored: {backup_path}") from exc
        if status != "ok":
            raise RuntimeError(f"Backup failed SQLite integrity check, not restored: {backup_path}")
    finally:
        check_db.close()

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file():
        # Snapshotted through SQLite's own backup API (like backup_database
        # does), not a plain file copy -- a raw copy of a WAL-mode database
        # can miss committed rows still sitting in the -wal file.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        pre_restore = destination.with_name(f"{destination.stem}-pre-restore-{stamp}{destination.suffix}")
        live_db = sqlite3.connect(destination)
        snapshot_db = sqlite3.connect(pre_restore)
        try:
            # Checkpointing first merges every committed row sitting in
            # destination's -wal file back into the main file and truncates
            # the -wal to empty -- without this, the -wal survives the swap
            # below with the old data still in it and gets replayed the next
            # time anything opens destination, silently undoing the restore.
            live_db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            live_db.backup(snapshot_db)
        finally:
            snapshot_db.close()
            live_db.close()

    _delete_wal_sidecars(destination)
    shutil.copy2(backup_path, destination)
    _delete_wal_sidecars(destination)
    return destination


def prune_backups(destination_dir: Path, keep: int = 14) -> list[Path]:
    """Keep the most recent `keep` backups, delete the rest -- otherwise
    a daily auto-backup silently accumulates files forever."""
    if not destination_dir.is_dir():
        return []
    backups = sorted(destination_dir.glob("discount-auto-ops-*.db"), key=lambda p: p.name, reverse=True)
    removed = []
    for stale in backups[keep:]:
        stale.unlink(missing_ok=True)
        removed.append(stale)
    return removed


def most_recent_backup_age_hours(destination_dir: Path) -> float | None:
    """Hours since the last backup, or None if there isn't one yet."""
    if not destination_dir.is_dir():
        return None
    backups = list(destination_dir.glob("discount-auto-ops-*.db"))
    if not backups:
        return None
    newest = max(backups, key=lambda p: p.stat().st_mtime)
    age_seconds = datetime.now(timezone.utc).timestamp() - newest.stat().st_mtime
    return age_seconds / 3600


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a verified RECON SQLite backup")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(backup_database(args.source, args.destination))


if __name__ == "__main__":
    main()
