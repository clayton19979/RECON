"""Filling the updates folder from a published release.

The LAN half (test_updates.py) trusts whatever sits in the updates folder and
offers it to the whole shop. These tests cover how that folder gets filled
over the internet -- and, mostly, the ways a fetch must refuse to leave
anything half-trusted behind for that machinery to find.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from app import online_updates, updates


def _write_source(root: Path, repo: str = "clay/recon", token: str | None = None) -> None:
    payload: dict = {"repo": repo}
    if token:
        payload["token"] = token
    (root / online_updates.CONFIG_NAME).write_text(json.dumps(payload), encoding="utf-8")


BODY = b"exe-bytes"


def _asset(version: str, size: int = len(BODY)) -> dict:
    return {
        "name": f"RECON-Setup-{version}.exe",
        "url": f"https://api.github.invalid/assets/{version}",
        "size": size,
    }


def _transport(release: dict | None, requests: list | None = None, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        if request.url.path.endswith("/releases/latest"):
            return httpx.Response(status, json=release or {})
        return httpx.Response(200, content=BODY)

    return httpx.MockTransport(handler)


# --- when nothing is configured, nothing happens ---

def test_no_config_file_means_off_and_no_network(tmp_path):
    def explode(_request):
        raise AssertionError("an unconfigured install must never touch the network")

    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=httpx.MockTransport(explode))
    assert result == {"status": "off"}


def test_unreadable_or_incomplete_config_means_off(tmp_path):
    (tmp_path / online_updates.CONFIG_NAME).write_text("{not json", encoding="utf-8")
    assert online_updates.check_and_fetch(tmp_path, "1.0.0")["status"] == "off"
    (tmp_path / online_updates.CONFIG_NAME).write_text(json.dumps({"repo": "no-slash"}), encoding="utf-8")
    assert online_updates.check_and_fetch(tmp_path, "1.0.0")["status"] == "off"


# --- the happy path ---

def test_newer_release_lands_whole_in_the_updates_folder(tmp_path):
    _write_source(tmp_path)
    release = {"assets": [_asset("1.1.0")]}
    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release))
    assert result["status"] == "downloaded"
    assert result["version"] == "1.1.0"
    folder = updates.updates_dir(tmp_path)
    assert (folder / "RECON-Setup-1.1.0.exe").read_bytes() == BODY
    # Nothing partial left over for the offer machinery to trip on.
    assert list(folder.glob("*.part")) == []
    # ...and the LAN side now offers exactly this build.
    assert updates.available_update(folder, "1.0.0")["version"] == "1.1.0"


def test_installer_is_picked_out_from_among_other_assets(tmp_path):
    _write_source(tmp_path)
    release = {
        "assets": [
            {"name": "checksums.txt", "url": "https://x.invalid/1", "size": 3},
            {"name": "RECON-Setup-latest.exe", "url": "https://x.invalid/2", "size": 3},
            _asset("1.2.0"),
        ]
    }
    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release))
    assert result["status"] == "downloaded"
    assert result["filename"] == "RECON-Setup-1.2.0.exe"


# --- refusing to fetch what nobody needs ---

def test_same_or_older_release_is_not_downloaded(tmp_path):
    _write_source(tmp_path)
    for published in ("1.0.0", "0.9.0"):
        release = {"assets": [_asset(published)]}
        result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release))
        assert result["status"] == "current"
    assert not updates.updates_dir(tmp_path).exists()


def test_already_downloaded_build_is_not_fetched_again(tmp_path):
    """The daily check must not pull the same 40 MB down every day while the
    shop hasn't gotten round to clicking install yet."""
    _write_source(tmp_path)
    folder = updates.updates_dir(tmp_path)
    folder.mkdir(parents=True)
    (folder / "RECON-Setup-1.1.0.exe").write_bytes(BODY)
    seen: list = []
    release = {"assets": [_asset("1.1.0")]}
    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release, seen))
    assert result["status"] == "already"
    assert result["version"] == "1.1.0"
    assert [r for r in seen if "releases/latest" not in str(r.url)] == []


def test_release_404_reads_as_nothing_to_offer(tmp_path):
    """A repo with no releases yet is the day-one state, not a failure."""
    _write_source(tmp_path)
    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(None, status=404))
    assert result["status"] == "current"


# --- failure must leave nothing behind ---

def test_short_download_is_discarded_not_offered(tmp_path):
    """A size mismatch is a truncated or tampered file; leaving it under its
    real name would hand a broken installer to every PC in the shop."""
    _write_source(tmp_path)
    release = {"assets": [_asset("1.1.0", size=len(BODY) + 100)]}
    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release))
    assert result["status"] == "error"
    assert list(updates.updates_dir(tmp_path).glob("*")) == []


def test_network_failure_reports_instead_of_raising(tmp_path):
    _write_source(tmp_path)

    def down(_request):
        raise httpx.ConnectError("shop internet is out")

    result = online_updates.check_and_fetch(tmp_path, "1.0.0", transport=httpx.MockTransport(down))
    assert result["status"] == "error"
    assert "internet" in result["detail"]


# --- talking to a private repository ---

def test_token_rides_along_and_asset_asks_for_bytes(tmp_path):
    _write_source(tmp_path, token="github_pat_test")
    seen: list = []
    release = {"assets": [_asset("1.1.0")]}
    online_updates.check_and_fetch(tmp_path, "1.0.0", transport=_transport(release, seen))
    api, asset = seen[0], seen[-1]
    assert api.headers["Authorization"] == "Bearer github_pat_test"
    assert asset.headers["Authorization"] == "Bearer github_pat_test"
    # The asset's API url only yields the file itself under this Accept.
    assert asset.headers["Accept"] == "application/octet-stream"
