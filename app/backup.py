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


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a verified Discount Auto Ops SQLite backup")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(backup_database(args.source, args.destination))


if __name__ == "__main__":
    main()
