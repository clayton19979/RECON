"""Updating RECON from the shop PC.

Version numbers used to live in two files that never checked each other. That
was cosmetic while updating was manual; once a workstation decides whether it
is out of date by comparing them, a stale one means "never updates" or
"updates forever", so the agreement is now asserted.
"""
from __future__ import annotations

import re
from pathlib import Path

from app import updates
from app.version import VERSION, is_newer, parse

REPO = Path(__file__).resolve().parent.parent


def _installer(directory: Path, version: str, size: int = 1024) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"RECON-Setup-{version}.exe"
    path.write_bytes(b"x" * size)
    return path


# --- the three places a version is written must agree ---

def test_version_info_matches_version_module():
    text = (REPO / "version_info.txt").read_text(encoding="utf-8")
    match = re.search(r"StringStruct\('FileVersion',\s*'([\d.]+)'\)", text)
    assert match, "version_info.txt no longer declares a FileVersion"
    assert parse(match.group(1)) == parse(VERSION)


def test_installer_script_matches_version_module():
    text = (REPO / "installers" / "RECON.iss").read_text(encoding="utf-8")
    match = re.search(r'#define\s+AppVersion\s+"([\d.]+)"', text)
    assert match, "RECON.iss no longer defines AppVersion"
    assert parse(match.group(1)) == parse(VERSION)


# --- comparison ---

def test_padding_makes_short_and_long_forms_compare_equal():
    assert parse("1.1") == parse("1.1.0") == parse("1.1.0.0")
    assert not is_newer("1.1", "1.1.0")


def test_newer_versions_win_and_older_ones_do_not():
    assert is_newer("1.1.0", "1.0.0")
    assert is_newer("1.0.1", "1.0.0")
    assert is_newer("2.0.0", "1.9.9")
    assert not is_newer("1.0.0", "1.0.0")
    assert not is_newer("0.9.0", "1.0.0")


def test_unparseable_versions_are_never_newer():
    """A malformed name in the updates folder must be ignored, not treated as
    an upgrade every workstation then tries and fails to install."""
    for junk in ("", None, "latest", "v1.2", "1.2.3.4.5", "final-build"):
        assert not is_newer(junk, "1.0.0")


# --- what the shop PC offers ---

def test_offers_the_newest_installer_it_has(tmp_path):
    _installer(tmp_path, "1.0.1")
    _installer(tmp_path, "1.2.0")
    _installer(tmp_path, "1.1.0")

    update = updates.available_update(tmp_path, current="1.0.0")
    assert update["version"] == "1.2.0"
    assert update["filename"] == "RECON-Setup-1.2.0.exe"
    assert update["size_bytes"] == 1024


def test_offers_nothing_when_already_current(tmp_path):
    _installer(tmp_path, "1.0.0")
    assert updates.available_update(tmp_path, current="1.0.0") is None


def test_offers_nothing_when_the_only_build_is_older(tmp_path):
    _installer(tmp_path, "0.9.0")
    assert updates.available_update(tmp_path, current="1.0.0") is None


def test_missing_updates_folder_is_not_an_error(tmp_path):
    assert updates.available_update(tmp_path / "nope", current="1.0.0") is None


def test_unrecognised_files_are_never_offered(tmp_path):
    """A half-copied file or someone's renamed backup must not be handed to
    the whole shop as an upgrade."""
    (tmp_path).mkdir(parents=True, exist_ok=True)
    (tmp_path / "RECON-Setup-latest.exe").write_bytes(b"x")
    (tmp_path / "setup.exe").write_bytes(b"x")
    (tmp_path / "RECON-Setup-1.5.0.exe.partial").write_bytes(b"x")
    (tmp_path / "notes.txt").write_text("hi")

    assert updates.find_installers(tmp_path) == []
    assert updates.available_update(tmp_path, current="1.0.0") is None


# --- the API a workstation asks ---

def test_version_endpoint_reports_this_install(client):
    body = client.get("/api/version").json()
    assert body["version"] == VERSION
    assert body["role"] in ("master", "client")
    assert body["update"] is None


def test_version_endpoint_advertises_an_available_build(client, tmp_path):
    _installer(updates.updates_dir(tmp_path), "9.9.9", size=2048)

    body = client.get("/api/version").json()
    assert body["update"]["version"] == "9.9.9"
    assert body["update"]["size_bytes"] == 2048


def test_download_serves_the_installer(client, tmp_path):
    _installer(updates.updates_dir(tmp_path), "9.9.9", size=64)

    res = client.get("/api/update/download")
    assert res.status_code == 200
    assert res.content == b"x" * 64
    assert "RECON-Setup-9.9.9.exe" in res.headers.get("content-disposition", "")


def test_download_404s_when_there_is_nothing_to_serve(client):
    assert client.get("/api/update/download").status_code == 404
