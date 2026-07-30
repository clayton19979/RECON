from __future__ import annotations

import argparse
import shutil
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path


def backup_database(source: Path, destination_dir: Path) -> Path:
    if not source.is_file():
        raise FileNotFoundError(f"Database not found: {source}")
    destination_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
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
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
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


# How often the tray's loop takes a snapshot, and how long each resolution of
# history survives pruning.
#
# A flat "keep the newest N" cap and a short interval are actively dangerous
# together: at one snapshot every 5 minutes, keeping 14 files means the entire
# backup history is the last 70 minutes. Corrupt something at 9am, notice it at
# noon, and every surviving backup is already poisoned. So the interval got
# short *and* the retention got tiered -- recent snapshots stay dense, older
# ones thin out to hourly, then daily, then monthly. Roughly 110 files, about
# 20 MB at the current database size.
AUTO_BACKUP_INTERVAL_MINUTES = 5
KEEP_EVERY_SNAPSHOT_HOURS = 2
KEEP_HOURLY_HOURS = 48
KEEP_DAILY_DAYS = 30
KEEP_MONTHLY_MONTHS = 12

_STAMP_FORMAT = "%Y%m%dT%H%M%SZ"


def backup_timestamp(path: Path) -> datetime | None:
    """The moment a backup was taken, read from its own filename.

    File mtime would be wrong here: copying backups to a flash drive or
    restoring a folder rewrites mtimes, and retention decisions have to
    survive that. The name is the record.
    """
    stem = path.name[len("discount-auto-ops-") : -len(".db")] if path.name.endswith(".db") else ""
    try:
        return datetime.strptime(stem, _STAMP_FORMAT).replace(tzinfo=UTC)
    except ValueError:
        return None


def prune_backups_tiered(destination_dir: Path, now: datetime | None = None) -> list[Path]:
    """Thin out backup history by age instead of capping the count.

    Keeps every snapshot for the first couple of hours, then the newest of
    each hour, then the newest of each day, then the newest of each month.
    Anything that isn't the survivor of some bucket is deleted, and anything
    older than the last tier goes too.

    Files whose names don't parse as a timestamp are left strictly alone --
    an unrecognised name is far more likely to be someone's hand-kept copy
    than something safe to delete.
    """
    if not destination_dir.is_dir():
        return []
    now = now or datetime.now(UTC)

    dated: list[tuple[datetime, Path]] = []
    for path in destination_dir.glob("discount-auto-ops-*.db"):
        stamp = backup_timestamp(path)
        if stamp is not None:
            dated.append((stamp, path))
    dated.sort(key=lambda pair: pair[0], reverse=True)

    keep: set[Path] = set()
    seen_buckets: set[tuple[str, tuple]] = set()
    for stamp, path in dated:
        age = now - stamp
        hours, days = age.total_seconds() / 3600, age.days
        if hours <= KEEP_EVERY_SNAPSHOT_HOURS:
            keep.add(path)
            continue
        if hours <= KEEP_HOURLY_HOURS:
            bucket = ("hour", (stamp.year, stamp.month, stamp.day, stamp.hour))
        elif days <= KEEP_DAILY_DAYS:
            bucket = ("day", (stamp.year, stamp.month, stamp.day))
        elif days <= KEEP_MONTHLY_MONTHS * 31:
            bucket = ("month", (stamp.year, stamp.month))
        else:
            continue  # past every tier -- let it go
        # Sorted newest-first, so the first file to claim a bucket is the one
        # that represents it.
        if bucket not in seen_buckets:
            seen_buckets.add(bucket)
            keep.add(path)

    removed = []
    for _stamp, path in dated:
        if path not in keep:
            path.unlink(missing_ok=True)
            removed.append(path)
    return removed


def database_changed_since(db_path: Path, moment: datetime | None) -> bool:
    """Whether the live database has been touched since `moment`.

    At a 5-minute cadence a quiet Saturday would otherwise mint ~288 byte
    identical snapshots and push the genuinely different ones out of the
    dense tier. WAL mode means the interesting writes often land in the
    sidecar rather than the main file, so all three are consulted.
    """
    if moment is None:
        return True
    newest = 0.0
    for candidate in (db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")):
        try:
            newest = max(newest, candidate.stat().st_mtime)
        except OSError:
            continue
    return newest > moment.timestamp()


# Set by whichever process actually runs the 24-hour auto-backup loop
# (tray_app). The Backup page asks /api/backup/status so it can stop
# promising automatic backups when nothing is running them -- e.g. a bare
# uvicorn dev run, where the loop doesn't exist.
AUTO_BACKUP_RUNNING = False


def set_auto_backup_running(value: bool = True) -> None:
    global AUTO_BACKUP_RUNNING
    AUTO_BACKUP_RUNNING = bool(value)


def most_recent_backup_age_hours(destination_dir: Path) -> float | None:
    """Hours since the last backup, or None if there isn't one yet."""
    if not destination_dir.is_dir():
        return None
    backups = list(destination_dir.glob("discount-auto-ops-*.db"))
    if not backups:
        return None
    newest = max(backups, key=lambda p: p.stat().st_mtime)
    age_seconds = datetime.now(UTC).timestamp() - newest.stat().st_mtime
    return age_seconds / 3600


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a verified RECON SQLite backup")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(backup_database(args.source, args.destination))


if __name__ == "__main__":
    main()
