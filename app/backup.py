from __future__ import annotations

import argparse
import sqlite3
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
