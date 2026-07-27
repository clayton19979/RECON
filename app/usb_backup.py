"""Mirroring backups onto a removable drive, addressed by volume label.

Backups written next to the database survive a bad edit or a corrupted
file. They do not survive the drive dying, the PC being stolen, or the shop
flooding -- only a copy that physically leaves the building does that. This
module is the "leaves the building" half: it remembers which drive was
chosen, finds that same drive again tomorrow, and puts a verified copy on
it whenever it happens to be plugged in.

Drive letters are assigned by plug order, so E: today is genuinely F:
tomorrow if something else is plugged in first. Every lookup here is by
volume label ("DiscAutoBackup") with the drive letter as a first guess
only -- a remembered path is a hint, never the identity of the stick.
"""

from __future__ import annotations

import contextlib
import ctypes
import json
import os
import shutil
import sqlite3
import string
from datetime import datetime, timezone
from pathlib import Path

_MAX_LABEL_LEN = 261
_SEM_FAILCRITICALERRORS = 0x0001


@contextlib.contextmanager
def _quiet_device_errors():
    """Windows pops a modal "There is no disk in the drive" dialog when you
    probe an empty card reader slot. Enumerating drives must never hang the
    tray on a dialog box nobody is sitting in front of."""
    try:
        kernel32 = ctypes.windll.kernel32
        previous = kernel32.SetErrorMode(_SEM_FAILCRITICALERRORS)
    except (AttributeError, OSError):
        yield
        return
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            kernel32.SetErrorMode(previous)


def volume_label(drive_root: Path | str) -> str | None:
    """The volume label of a drive root ("DiscAutoBackup"), or None if it
    can't be read -- an empty slot, a drive with no label, or a platform
    without the Win32 API at all."""
    drive, _ = os.path.splitdrive(str(drive_root))
    if not drive:
        return None
    root = drive + os.sep
    buffer = ctypes.create_unicode_buffer(_MAX_LABEL_LEN)
    try:
        with _quiet_device_errors():
            ok = ctypes.windll.kernel32.GetVolumeInformationW(
                ctypes.c_wchar_p(root), buffer, _MAX_LABEL_LEN, None, None, None, None, 0
            )
    except (AttributeError, OSError):
        return None
    return buffer.value or None if ok else None


def present_drive_roots() -> list[Path]:
    """Every drive letter currently mounted. Read from a bitmask rather than
    by touching each root, so an empty optical or card slot costs nothing."""
    try:
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    except (AttributeError, OSError):
        return []
    return [Path(f"{letter}:{os.sep}") for index, letter in enumerate(string.ascii_uppercase) if bitmask >> index & 1]


def describe(destination: Path) -> dict:
    """Turns a chosen folder into a record that can find it again after the
    drive letter has moved: the label identifies the physical stick, the
    relative part is the folder within it."""
    drive, rest = os.path.splitdrive(str(destination))
    return {
        "path": str(destination),
        "label": volume_label(drive) if drive else None,
        "relative": rest.strip("\\/"),
    }


def resolve(record: dict | None, drives: list[Path] | None = None, label_reader=volume_label) -> Path | None:
    """Where the remembered destination lives *right now*, or None if that
    drive isn't plugged in. The recorded path is tried first because it's
    right almost every time; the label scan is what rescues it the day the
    stick comes back as a different letter."""
    if not record:
        return None
    recorded = record.get("path")
    if recorded and Path(recorded).is_dir():
        return Path(recorded)

    label = record.get("label")
    if not label:
        return None
    relative = (record.get("relative") or "").strip("\\/")
    for root in present_drive_roots() if drives is None else drives:
        if label_reader(root) != label:
            continue
        candidate = root / relative if relative else root
        # The label matched, so this is the intended stick even if the
        # folder on it was deleted or renamed away -- recreate it rather
        # than silently skipping the mirror from here on.
        with contextlib.suppress(OSError):
            candidate.mkdir(parents=True, exist_ok=True)
        if candidate.is_dir():
            return candidate
    return None


def load(record_file: Path) -> dict | None:
    try:
        record = json.loads(record_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and record.get("path") else None


def save(record_file: Path, destination: Path) -> dict:
    record = describe(destination)
    record_file.parent.mkdir(parents=True, exist_ok=True)
    record_file.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def mirror_backup(source_backup: Path, target_dir: Path) -> Path:
    """Copies an already-verified backup onto the removable drive under the
    same filename, then re-checks it there. The copy is what gets carried
    home, and a USB stick is exactly the kind of medium that writes a file
    which reads back wrong -- a copy nobody verified is a copy nobody can
    rely on. A failed check deletes the bad file rather than leaving it to
    be picked up later as if it were good."""
    if not source_backup.is_file():
        raise FileNotFoundError(f"Backup not found: {source_backup}")
    target_dir.mkdir(parents=True, exist_ok=True)
    destination = target_dir / source_backup.name
    temporary = destination.with_suffix(".db.tmp")
    shutil.copy2(source_backup, temporary)
    try:
        check = sqlite3.connect(temporary)
        try:
            status = check.execute("PRAGMA integrity_check").fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise RuntimeError(f"Copy on {target_dir} is not a readable database") from exc
        finally:
            check.close()
        if status != "ok":
            raise RuntimeError(f"Copy on {target_dir} failed its integrity check")
    except Exception:
        # A copy that didn't verify must not be left behind under any name a
        # later restore could pick up and trust.
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise
    temporary.replace(destination)
    return destination


# Set by the tray process each time a mirror runs, so /api/backup/status can
# tell the Backup page whether the off-site copy is actually happening --
# the same reason AUTO_BACKUP_RUNNING exists next door in backup.py.
LAST_MIRROR: dict | None = None


def record_mirror(destination: Path | None, label: str | None, error: str | None = None) -> None:
    global LAST_MIRROR
    LAST_MIRROR = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": label,
        "path": str(destination) if destination else None,
        "error": error,
    }


def last_mirror() -> dict | None:
    return LAST_MIRROR
