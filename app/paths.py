"""Where RECON's files live, frozen or from source.

Split out of main so tray_app and deployment can ask these questions without
importing the whole FastAPI app.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_NAME = "RECON"

# Where releases before the RECON rename kept their data, per Windows user.
_LEGACY_DATA_DIR = "DiscountAutoOps"


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path:
    """Where bundled read-only assets (static/) live. A PyInstaller onefile
    build extracts into a temp dir given by sys._MEIPASS; running from source
    uses the repo root."""
    if frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def data_root() -> Path:
    """Where the database, backups and settings live -- a stable writable
    place that survives restarts, never the PyInstaller extraction temp dir,
    which is deleted when the process exits.

    ProgramData rather than LocalAppData: the shop PC is shared, and per-user
    data would silently give the morning and evening shifts two different
    databases. The installer grants Users write access to this folder.
    """
    if frozen():
        base = os.getenv("PROGRAMDATA") or os.getenv("LOCALAPPDATA") or str(Path.home())
        return Path(base) / APP_NAME
    return Path(__file__).resolve().parent.parent


def legacy_data_root() -> Path | None:
    """The pre-rename per-user location, if it still holds a database."""
    if not frozen():
        return None
    base = os.getenv("LOCALAPPDATA")
    if not base:
        return None
    old = Path(base) / _LEGACY_DATA_DIR
    return old if (old / "data" / "shop.db").is_file() else None


def migrate_legacy_data(destination: Path) -> Path | None:
    """One-time copy from the old per-user folder into the shared one.

    Copies rather than moves: if anything about the new location is wrong,
    the original is still sitting there untouched. Only runs when the new
    location has no database yet, so it can never overwrite live records.
    """
    old = legacy_data_root()
    if old is None:
        return None
    if (destination / "data" / "shop.db").is_file():
        return None
    for sub in ("data", "backups"):
        src = old / sub
        if src.is_dir():
            shutil.copytree(src, destination / sub, dirs_exist_ok=True)
    for name in ("backup_destination.json", "network_mode.flag"):
        src = old / name
        if src.is_file():
            shutil.copy2(src, destination / name)
    return old
