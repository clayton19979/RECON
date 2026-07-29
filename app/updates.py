"""Updating RECON from the shop PC.

Every workstation already talks to the shop PC over HTTP -- that server is
discovered automatically and is the one machine guaranteed to be reachable
from the floor. So it doubles as the update source: drop a new
`RECON-Setup-1.1.0.exe` into the shop PC's updates folder, and every
workstation sees it, offers it, and installs it. No internet, nothing hosted,
and one action instead of walking round the shop with a USB stick.

The shop PC serves the same file to itself, so the machine you carried the
build to updates through the identical path.

Deliberately no auto-install: an advisor is always mid-ticket somewhere, and
an app that restarts itself under them is how you lose a repair order. The
app says a version is available and waits to be asked.
"""
from __future__ import annotations

import re
from pathlib import Path

from .version import VERSION, is_newer, parse

# RECON-Setup-1.1.0.exe -- the name build_installer.ps1 already produces, so
# the file is dropped in exactly as it comes off the build with no renaming.
INSTALLER_PATTERN = re.compile(r"^RECON-Setup-(\d+(?:\.\d+){0,3})\.exe$", re.IGNORECASE)

UPDATES_DIR_NAME = "updates"


def updates_dir(data_root: Path) -> Path:
    return data_root / UPDATES_DIR_NAME


def installer_version(path: Path) -> str | None:
    match = INSTALLER_PATTERN.match(path.name)
    return match.group(1) if match else None


def find_installers(directory: Path) -> list[tuple[str, Path]]:
    """Every recognisable installer in the folder, newest first.

    Anything that doesn't match the naming pattern is ignored rather than
    guessed at -- a half-copied file or someone's renamed backup must never
    be offered to the whole shop as an upgrade.
    """
    if not directory.is_dir():
        return []
    found = []
    for path in directory.glob("*.exe"):
        version = installer_version(path)
        if version and parse(version):
            found.append((version, path))
    found.sort(key=lambda pair: parse(pair[0]) or (), reverse=True)
    return found


def latest_installer(directory: Path) -> tuple[str, Path] | None:
    installers = find_installers(directory)
    return installers[0] if installers else None


def available_update(directory: Path, current: str = VERSION) -> dict | None:
    """The update this server is offering, or None if it has nothing newer.

    Size rides along so the app can say how big the download is before a
    workstation on a slow link commits to it.
    """
    latest = latest_installer(directory)
    if not latest:
        return None
    version, path = latest
    if not is_newer(version, current):
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    return {"version": version, "filename": path.name, "size_bytes": size}
