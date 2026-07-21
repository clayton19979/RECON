from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import pystray
import uvicorn
from PIL import Image, ImageDraw

from app.backup import backup_database, most_recent_backup_age_hours, prune_backups
from app.main import DATA_ROOT, DEFAULT_DB, create_app

HOST = "127.0.0.1"
PORT = 8787
URL = f"http://{HOST}:{PORT}"
AUTO_BACKUP_INTERVAL_HOURS = 24
BACKUP_RETENTION_COUNT = 14

CHROME_CANDIDATES = [
    Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
]


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
            # log_config=None: uvicorn's default formatter calls sys.stdout.isatty(),
            # which crashes under a --windowed PyInstaller build where stdout is None.
            config = uvicorn.Config(create_app(), host=HOST, port=PORT, log_level="warning", log_config=None, access_log=False)
            self.server = uvicorn.Server(config)
            self.thread = threading.Thread(target=self.server.run, daemon=True)
            self.thread.start()
            log.info("Server starting on %s", URL)
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
        open_in_chrome(URL)

    def _run_backup(self, notify: bool) -> None:
        backups_dir = DATA_ROOT / "backups"
        try:
            destination = backup_database(DEFAULT_DB, backups_dir)
            removed = prune_backups(backups_dir, keep=BACKUP_RETENTION_COUNT)
            log.info("Backup written to %s (pruned %d old backups)", destination, len(removed))
            if notify and self.icon is not None:
                self.icon.notify(f"Backup saved: {destination.name}", "Discount Auto Ops")
        except Exception as exc:
            log.exception("Backup failed")
            if notify and self.icon is not None:
                self.icon.notify(f"Backup failed: {exc}", "Discount Auto Ops")

    def backup_now(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        self._run_backup(notify=True)

    def _auto_backup_loop(self) -> None:
        """Runs for the life of the process: backs up automatically if the
        last backup is stale, then checks again once an hour. Protects
        against data loss without Clay having to remember to click
        Backup Now."""
        while True:
            try:
                age = most_recent_backup_age_hours(DATA_ROOT / "backups")
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
            pystray.MenuItem("Open Discount Auto Ops", self.open_browser, default=True),
            pystray.MenuItem("Backup Now", self.backup_now),
            pystray.MenuItem("Restart Server", self.restart),
            pystray.MenuItem("Exit", self.quit_app),
        )
        self.icon = pystray.Icon("discount-auto-ops", ICON_OK if ok else ICON_DOWN, "Discount Auto Ops", menu)
        self.icon.run()


def main() -> None:
    TrayApp().run()


if __name__ == "__main__":
    main()
