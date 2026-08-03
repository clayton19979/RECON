"""What this install is running, and what the shop PC has to offer it."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import deployment, online_updates, updates
from .version import VERSION


def build_update_router(data_root: Path) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _updates_dir() -> Path:
        return updates.updates_dir(data_root)

    @router.get("/version")
    def version():
        """Answers both halves of "am I out of date": what this process is
        running, and what's sitting in the shop PC's updates folder.

        A workstation asks its *master* this -- the app it loaded came from
        there -- so `update` describes what that machine can hand out. On the
        shop PC itself the same answer drives the same banner, which is what
        makes the build you carried in on a USB stick installable by clicking
        rather than by hunting for the exe.
        """
        return {
            "version": VERSION,
            "role": deployment.load(data_root)["role"],
            "updates_dir": str(_updates_dir()),
            "update": updates.available_update(_updates_dir(), VERSION),
        }

    @router.post("/update/check-online")
    def check_online():
        """The Updates screen's "Check for Updates" button -- the same call the
        tray menu and the daily loop make, so nobody has to go hunting through
        a tray icon to get a new build down.

        Fetches only. `check_and_fetch` puts the installer in the updates
        folder and stops there; installing stays the deliberate click it has
        always been, because somebody is always mid-ticket.

        It runs wherever the request lands, which is the master -- a
        workstation asks its master, and the master is the PC with a release
        source configured. It can spend 30 seconds pulling 40 MB, so it is a
        sync def on purpose: FastAPI runs those on a worker thread rather than
        blocking the event loop that is still serving the app.

        Never raises (see check_and_fetch), so the page always gets a status
        to speak from rather than an error banner it can't explain.
        """
        result = online_updates.check_and_fetch(data_root)
        # The "off" status means no update_source.json; the page says where it
        # would go rather than making someone look the path up.
        return result | {"config_path": str(online_updates.config_path(data_root))}

    @router.get("/update/download")
    def download_update():
        latest = updates.latest_installer(_updates_dir())
        if not latest:
            raise HTTPException(404, "No update is available from this PC")
        _version, path = latest
        # Named exactly as it sits on disk: the client saves it under that
        # name and Inno Setup's own version check reads it back.
        return FileResponse(path, filename=path.name, media_type="application/octet-stream")

    return router
