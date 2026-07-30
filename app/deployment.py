"""Which PC this is: the one that holds the records, or a workstation.

Before this, the role was decided by a race -- whichever PC finished booting
first found no master, declared itself master, and started its own database.
Two PCs powering up together both won that race, and the shop ended up with
two divergent sets of records that nothing would ever reconcile.

So the role is now written once, at install time, and read here. UDP discovery
still exists, but its job shrank to the useful half: a workstation asking
"where is the shop PC?", not "is there one?".
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from app import paths

log = logging.getLogger("tray")

MASTER = "master"
CLIENT = "client"
CONFIG_NAME = "deployment.json"


def config_path(data_root: Path | None = None) -> Path:
    return (data_root or paths.data_root()) / CONFIG_NAME


def load(data_root: Path | None = None) -> dict:
    """The install's declared role. Missing or unreadable config falls back to
    master, which is the safe direction: a lone PC that mistakenly believes it
    is the master still works standalone, whereas one that mistakenly believes
    it is a workstation sits there hunting for a server that does not exist."""
    path = config_path(data_root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"role": MASTER, "master_host": None, "configured": False}
    except (OSError, ValueError):
        log.warning("Could not read %s -- assuming this PC is the master", path)
        return {"role": MASTER, "master_host": None, "configured": False}

    role = str(raw.get("role", MASTER)).strip().lower()
    if role not in (MASTER, CLIENT):
        log.warning("Unknown role %r in %s -- assuming master", role, path)
        role = MASTER
    host = raw.get("master_host") or None
    return {"role": role, "master_host": host, "configured": True}


def save(role: str, master_host: str | None = None, data_root: Path | None = None) -> Path:
    """Written by the installer, and by the tray's 'become the master' escape
    hatch when the real shop PC is off and work cannot stop for it."""
    if role not in (MASTER, CLIENT):
        raise ValueError(f"role must be {MASTER!r} or {CLIENT!r}, got {role!r}")
    path = config_path(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"role": role, "master_host": master_host}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def is_master(data_root: Path | None = None) -> bool:
    return load(data_root)["role"] == MASTER
