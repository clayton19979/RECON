"""Fetching new builds from the internet, so a release published from home
reaches the shop without anyone driving it there.

The LAN half already exists (app/updates.py): anything sitting in the shop
PC's updates folder gets offered to every workstation, and to the shop PC
itself. This module fills that folder from a GitHub release instead of a USB
stick -- publish RECON-Setup-1.1.0.exe as a release from the home PC
(installers/publish_update.ps1), and the shop PC pulls it down on its daily
check, or immediately from the tray menu.

Only fetches, never installs: the existing rule that an update waits to be
asked (see app/updates.py) applies to downloaded builds exactly as it does to
carried-in ones.

Where to look lives in update_source.json next to the database:

    {"repo": "owner/name", "token": "github_pat_..."}

`token` is a fine-grained read-only PAT and is only needed while the
repository is private; drop the key if it ever goes public. No config file at
all means online checking is off -- which is the state of every install that
predates this feature, so old installs keep working untouched.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx

from . import updates
from .version import VERSION, is_newer, parse

log = logging.getLogger("tray")

CONFIG_NAME = "update_source.json"

API_ROOT = "https://api.github.com"

# Downloads land under this suffix and are renamed only once complete, so a
# dropped connection can never leave a half-file that matches the installer
# pattern and gets offered to the whole shop.
PARTIAL_SUFFIX = ".part"


def config_path(data_root: Path) -> Path:
    return data_root / CONFIG_NAME


def load_source(data_root: Path) -> dict | None:
    """The configured release source, or None if online checking is off.

    A file that exists but can't be parsed is reported as off rather than
    raised: the tray's daily loop must never die because someone hand-edited
    a JSON file, but it does deserve a log line saying why nothing happens.
    """
    path = config_path(data_root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log.warning("Could not read %s -- online update checking is off", path)
        return None
    repo = str(raw.get("repo") or "").strip()
    if not repo or repo.count("/") != 1:
        log.warning('%s has no usable "repo" (owner/name) -- online update checking is off', path)
        return None
    token = str(raw.get("token") or "").strip() or None
    return {"repo": repo, "token": token}


def _headers(token: str | None) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        # GitHub rejects requests without a User-Agent outright.
        "User-Agent": "RECON-updater",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def pick_installer_asset(release: dict) -> tuple[str, dict] | None:
    """The newest installer among a release's assets, or None.

    A release can carry other files (checksums, the WebView2 bootstrapper);
    only names matching the same pattern the updates folder trusts are
    considered, for the same reason: nothing unrecognisable gets offered to
    the shop as an upgrade.
    """
    found = []
    for asset in release.get("assets") or []:
        version = updates.installer_version(Path(str(asset.get("name") or "")))
        if version and parse(version):
            found.append((version, asset))
    found.sort(key=lambda pair: parse(pair[0]) or (), reverse=True)
    return found[0] if found else None


def check_and_fetch(
    data_root: Path,
    current: str = VERSION,
    transport: httpx.BaseTransport | None = None,
) -> dict:
    """One full check: ask GitHub for the latest release and, if it's newer
    than both this install and anything already downloaded, pull it into the
    updates folder. Returns a status dict for the tray to speak from:

      {"status": "off" | "current" | "already" | "downloaded" | "error", ...}

    Never raises -- this runs unattended on a daily loop, and the shop being
    offline for the evening is routine, not a crash.
    """
    source = load_source(data_root)
    if source is None:
        return {"status": "off"}

    updates_dir = updates.updates_dir(data_root)
    try:
        with httpx.Client(
            headers=_headers(source["token"]), timeout=30, follow_redirects=True, transport=transport
        ) as client:
            response = client.get(f"{API_ROOT}/repos/{source['repo']}/releases/latest")
            if response.status_code == 404:
                # Repo exists but has no releases yet (or the token can't see
                # it) -- nothing to offer is a normal answer, not an error.
                return {"status": "current", "version": current}
            response.raise_for_status()
            picked = pick_installer_asset(response.json())
            if picked is None:
                return {"status": "current", "version": current}
            version, asset = picked

            if not is_newer(version, current):
                return {"status": "current", "version": current}
            already = updates.latest_installer(updates_dir)
            if already and not is_newer(version, already[0]):
                # Downloaded on a previous check and still waiting to be
                # installed -- redownloading 40 MB daily helps no one.
                return {"status": "already", "version": already[0]}

            return _download(client, asset, version, updates_dir)
    except (httpx.HTTPError, OSError) as exc:
        log.warning("Online update check failed: %s", exc)
        return {"status": "error", "detail": str(exc)}


def _download(client: httpx.Client, asset: dict, version: str, updates_dir: Path) -> dict:
    """Stream the asset into the updates folder, appearing under its real
    name only once whole. The asset's API url (not browser_download_url) is
    what a token grants access to on a private repository."""
    updates_dir.mkdir(parents=True, exist_ok=True)
    final = updates_dir / str(asset["name"])
    partial = final.with_name(final.name + PARTIAL_SUFFIX)
    expected = int(asset.get("size") or 0)

    with client.stream("GET", str(asset["url"]), headers={"Accept": "application/octet-stream"}) as response:
        response.raise_for_status()
        with open(partial, "wb") as handle:
            handle.writelines(response.iter_bytes())

    written = partial.stat().st_size
    if expected and written != expected:
        partial.unlink(missing_ok=True)
        return {
            "status": "error",
            "detail": f"download was {written} bytes, expected {expected}",
        }
    partial.replace(final)
    log.info("Downloaded update %s to %s", version, final)
    return {"status": "downloaded", "version": version, "filename": final.name}
