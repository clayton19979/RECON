from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from . import backup as backup_module
from . import usb_backup
from .backup import backup_database, list_backups, most_recent_backup_age_hours, prune_backups, restore_database

BACKUP_RETENTION_COUNT = 14
AUTO_BACKUP_INTERVAL_HOURS = 24


def _entry(path: Path) -> dict:
    stat = path.stat()
    return {"name": path.name, "size_bytes": stat.st_size, "modified_at": stat.st_mtime}


def _resolve_existing(backups_dir: Path, name: str) -> Path:
    """Only ever matches a filename list_backups() itself produced -- the
    {name} path segment never gets turned into a path directly, so there's
    no "../" to escape backups_dir with."""
    match = next((p for p in list_backups(backups_dir) if p.name == name), None)
    if match is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    return match


def build_backup_router(db_path: Path, backups_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/backup")

    @router.get("")
    def list_all():
        return [_entry(p) for p in list_backups(backups_dir)]

    @router.get("/status")
    def status():
        """The truth behind the Backup page's health strip: whether anything
        is actually running the auto-backup loop in this process, how stale
        the newest backup is, and where the files live on disk (so they can
        be copied off-machine, which is what makes any of this real disaster
        protection)."""
        return {
            "auto_enabled": backup_module.AUTO_BACKUP_RUNNING,
            "interval_hours": AUTO_BACKUP_INTERVAL_HOURS,
            "retention": BACKUP_RETENTION_COUNT,
            "backups_dir": str(backups_dir),
            "last_age_hours": most_recent_backup_age_hours(backups_dir),
            # None until a removable drive has been chosen as a mirror target
            # and a backup has run since; otherwise the last attempt and
            # whether it landed, so "is the off-site copy actually happening"
            # is answerable without reading tray.log.
            "usb_mirror": usb_backup.last_mirror(),
        }

    @router.post("/run")
    def run_backup():
        try:
            destination = backup_database(db_path, backups_dir)
            prune_backups(backups_dir, keep=BACKUP_RETENTION_COUNT)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return _entry(destination)

    @router.get("/download/{name}")
    def download(name: str):
        target = _resolve_existing(backups_dir, name)
        return FileResponse(target, filename=target.name, media_type="application/octet-stream")

    @router.post("/restore/{name}")
    def restore_existing(name: str):
        target = _resolve_existing(backups_dir, name)
        try:
            restore_database(target, db_path)
        except (FileNotFoundError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"restored_from": target.name}

    @router.delete("/{name}")
    def delete_existing(name: str):
        target = _resolve_existing(backups_dir, name)
        target.unlink()
        return {"deleted": target.name}

    @router.post("/restore-upload")
    async def restore_upload(request: Request):
        """Restore straight from a file dropped into the browser -- what
        makes "upload the backup into a fresh install" possible from a
        normal web page, not just the tray icon on the original PC.
        restore_database() already snapshots whatever db_path held before
        overwriting it, so the upload itself is only ever a scratch copy --
        it's removed once the restore has run, succeeding or not."""
        raw_name = request.headers.get("x-backup-filename", "uploaded-backup.db")
        safe_name = Path(raw_name).name or "uploaded-backup.db"
        if not safe_name.lower().endswith(".db"):
            raise HTTPException(status_code=400, detail="Expected a .db backup file")
        backups_dir.mkdir(parents=True, exist_ok=True)
        scratch = backups_dir / f"_upload-{uuid.uuid4().hex}.db"
        scratch.write_bytes(await request.body())
        try:
            restore_database(scratch, db_path)
        except (FileNotFoundError, RuntimeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            scratch.unlink(missing_ok=True)
        return {"restored_from": safe_name}

    return router
