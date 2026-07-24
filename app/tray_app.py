from __future__ import annotations

import ctypes
import logging
import os
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import pystray
import uvicorn
from PIL import Image, ImageDraw

from app.backup import backup_database, list_backups, most_recent_backup_age_hours, prune_backups, restore_database
from app.main import DATA_ROOT, DEFAULT_BACKUPS_DIR, DEFAULT_DB, NETWORK_FLAG, create_app


def confirm(title: str, message: str) -> bool:
    """A native Windows Yes/No box -- pystray's own notify() is a toast with
    no buttons, and restoring a backup is destructive enough to need a real
    confirm step, not just a notification."""
    MB_YESNO = 0x04
    MB_ICONWARNING = 0x30
    IDYES = 6
    return ctypes.windll.user32.MessageBoxW(0, message, title, MB_YESNO | MB_ICONWARNING) == IDYES


def pick_backup_file(initial_dir: Path) -> Path | None:
    """Native "Open" file dialog for choosing a backup .db file from
    anywhere -- a USB stick, a synced folder, wherever it was stashed --
    not just the newest one already sitting in the default backups folder.
    This is what makes "restore onto a fresh install" possible."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        chosen = filedialog.askopenfilename(
            parent=root,
            title="Select a RECON backup to restore",
            initialdir=str(initial_dir),
            filetypes=[("RECON backups", "*.db"), ("All files", "*.*")],
        )
    finally:
        root.destroy()
    return Path(chosen) if chosen else None

PORT = 8787
AUTO_BACKUP_INTERVAL_HOURS = 24
BACKUP_RETENTION_COUNT = 14

CHROME_CANDIDATES = [
    Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
]


def network_mode_enabled() -> bool:
    return NETWORK_FLAG.is_file()


def local_lan_ip() -> str:
    """Best-effort LAN IP for this machine -- opens a UDP socket to a
    public address without sending anything, just to see which local
    interface the OS would route through."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def current_host() -> str:
    return "0.0.0.0" if network_mode_enabled() else "127.0.0.1"


def local_url() -> str:
    host = local_lan_ip() if network_mode_enabled() else "127.0.0.1"
    return f"http://{host}:{PORT}"


def open_in_chrome(url: str) -> None:
    """Launch Chrome directly rather than whatever the OS default handler
    resolves to (which can land on Explorer instead of a browser)."""
    chrome_path = next((p for p in CHROME_CANDIDATES if p.is_file()), None)
    if chrome_path is not None:
        subprocess.Popen([str(chrome_path), url])
        return
    webbrowser.open(url)

DATA_ROOT.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=DATA_ROOT / "tray.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("tray")


def make_icon(color: str) -> Image.Image:
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((2, 2, 62, 62), fill=color)
    draw.text((16, 18), "DA", fill="white")
    return image


ICON_OK = make_icon("#234a6b")
ICON_DOWN = make_icon("#a6392e")


class TrayApp:
    def __init__(self) -> None:
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.icon: pystray.Icon | None = None

    def start_server(self) -> bool:
        try:
            host = current_host()
            # log_config=None: uvicorn's default formatter calls sys.stdout.isatty(),
            # which crashes under a --windowed PyInstaller build where stdout is None.
            config = uvicorn.Config(create_app(), host=host, port=PORT, log_level="warning", log_config=None, access_log=False)
            self.server = uvicorn.Server(config)
            self.thread = threading.Thread(target=self.server.run, daemon=True)
            self.thread.start()
            log.info("Server starting on %s:%s (network mode: %s)", host, PORT, network_mode_enabled())
            return True
        except Exception:
            log.exception("Server failed to start")
            return False

    def stop_server(self) -> None:
        if self.server is not None:
            self.server.should_exit = True
        if self.thread is not None:
            self.thread.join(timeout=10)
        self.server = None
        self.thread = None

    def restart(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        log.info("Restart requested from tray")
        self.stop_server()
        ok = self.start_server()
        if self.icon is not None:
            self.icon.icon = ICON_OK if ok else ICON_DOWN

    def open_browser(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        open_in_chrome(local_url())

    def toggle_network_mode(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        if network_mode_enabled():
            NETWORK_FLAG.unlink(missing_ok=True)
            log.info("Network access disabled from tray")
        else:
            NETWORK_FLAG.write_text("enabled")
            log.info("Network access enabled from tray")
        self.stop_server()
        ok = self.start_server()
        if self.icon is not None:
            self.icon.icon = ICON_OK if ok else ICON_DOWN
            if network_mode_enabled() and ok:
                self.icon.notify(f"Network access on. Other PCs go to: {local_url()}", "RECON")
            elif ok:
                self.icon.notify("Network access off -- only this PC can reach it now.", "RECON")

    def show_server_address(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        if network_mode_enabled():
            self.icon.notify(f"Other PCs go to: {local_url()}", "RECON")
        else:
            self.icon.notify("Network access is off -- enable it first to share with other PCs.", "RECON")

    def _run_backup(self, notify: bool) -> None:
        try:
            destination = backup_database(DEFAULT_DB, DEFAULT_BACKUPS_DIR)
            removed = prune_backups(DEFAULT_BACKUPS_DIR, keep=BACKUP_RETENTION_COUNT)
            log.info("Backup written to %s (pruned %d old backups)", destination, len(removed))
            if notify and self.icon is not None:
                self.icon.notify(f"Backup saved: {destination.name}", "RECON")
        except Exception as exc:
            log.exception("Backup failed")
            if notify and self.icon is not None:
                self.icon.notify(f"Backup failed: {exc}", "RECON")

    def backup_now(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        self._run_backup(notify=True)

    def _restore_from_path(self, backup_path: Path) -> None:
        if not confirm(
            "Restore Backup?",
            f"This replaces the current database with:\n\n{backup_path}\n\n"
            "The current database is saved aside first, so this can be undone. "
            "The server restarts once the restore finishes.\n\nContinue?",
        ):
            return
        log.info("Restoring from backup %s", backup_path)
        self.stop_server()
        try:
            restore_database(backup_path, DEFAULT_DB)
        except Exception as exc:
            log.exception("Restore failed")
            if self.icon is not None:
                self.icon.notify(f"Restore failed: {exc}", "RECON")
            self.start_server()
            return
        ok = self.start_server()
        if self.icon is not None:
            self.icon.icon = ICON_OK if ok else ICON_DOWN
            self.icon.notify(f"Restored from {backup_path.name}. Server restarted.", "RECON")

    def restore_latest_backup(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        backups = list_backups(DEFAULT_BACKUPS_DIR)
        if not backups:
            if self.icon is not None:
                self.icon.notify("No backups found to restore.", "RECON")
            return
        self._restore_from_path(backups[0])

    def restore_from_file(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        """For moving to a fresh install/new PC: the backup being restored
        won't be sitting in the default backups folder under a name
        "Restore Latest Backup" would recognize, so this lets you point at
        any .db file directly."""
        DEFAULT_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        chosen = pick_backup_file(DEFAULT_BACKUPS_DIR)
        if chosen is None:
            return
        self._restore_from_path(chosen)

    def show_backups_folder(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        DEFAULT_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(DEFAULT_BACKUPS_DIR)

    def _auto_backup_loop(self) -> None:
        """Runs for the life of the process: backs up automatically if the
        last backup is stale, then checks again once an hour. Protects
        against data loss without Clay having to remember to click
        Backup Now."""
        while True:
            try:
                age = most_recent_backup_age_hours(DEFAULT_BACKUPS_DIR)
                if age is None or age >= AUTO_BACKUP_INTERVAL_HOURS:
                    self._run_backup(notify=False)
            except Exception:
                log.exception("Auto-backup check failed")
            time.sleep(3600)

    def quit_app(self, icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        log.info("Exit requested from tray")
        self.stop_server()
        icon.stop()

    def run(self) -> None:
        ok = self.start_server()
        threading.Thread(target=self._auto_backup_loop, daemon=True).start()
        menu = pystray.Menu(
            pystray.MenuItem("Open RECON", self.open_browser, default=True),
            pystray.MenuItem(
                "Allow other PCs on this network",
                self.toggle_network_mode,
                checked=lambda _item: network_mode_enabled(),
            ),
            pystray.MenuItem("Show Server Address", self.show_server_address),
            pystray.MenuItem("Backup Now (entire database)", self.backup_now),
            pystray.MenuItem("Restore Latest Backup", self.restore_latest_backup),
            pystray.MenuItem("Restore From File...", self.restore_from_file),
            pystray.MenuItem("Show Backups Folder", self.show_backups_folder),
            pystray.MenuItem("Restart Server", self.restart),
            pystray.MenuItem("Exit", self.quit_app),
        )
        self.icon = pystray.Icon("discount-auto-ops", ICON_OK if ok else ICON_DOWN, "RECON", menu)
        self.icon.run()


def main() -> None:
    TrayApp().run()


if __name__ == "__main__":
    main()
