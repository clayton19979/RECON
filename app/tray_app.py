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

from app import discovery, usb_backup
from app.backup import backup_database, list_backups, most_recent_backup_age_hours, prune_backups, restore_database, set_auto_backup_running
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


def pick_backup_destination(initial_dir: Path) -> Path | None:
    """Native folder picker for where a backup should be written -- a USB
    stick, a share on another shop PC, anywhere off this machine's disk.
    Backups sitting next to the database survive a bad edit or a corrupted
    file; they don't survive the drive dying, which is what this is for."""
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        chosen = filedialog.askdirectory(
            parent=root,
            title="Choose where to save the RECON backup",
            initialdir=str(initial_dir),
            mustexist=True,
        )
    finally:
        root.destroy()
    return Path(chosen) if chosen else None

PORT = 8787
AUTO_BACKUP_INTERVAL_HOURS = 24
BACKUP_RETENTION_COUNT = 14
# Remembers the last "Backup To..." folder -- both so a USB stick doesn't
# have to be re-navigated every time, and so the automatic backups know
# where to mirror a copy once it's plugged in.
DESTINATION_FILE = DATA_ROOT / "backup_destination.json"

CHROME_CANDIDATES = [
    Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
]

EDGE_CANDIDATES = [
    Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
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


def open_app_window(url: str) -> None:
    """Opens the UI in a chromeless Chrome/Edge "app mode" window instead of
    a normal browser tab -- no address bar, no tabs, its own taskbar entry,
    so it looks and behaves like a standalone program. Reusing a fixed
    profile dir means clicking "Open RECON" again focuses the existing
    window instead of spawning a duplicate. Falls back to whatever the OS
    default handler resolves to if neither browser is installed."""
    browser_path = next((p for p in CHROME_CANDIDATES + EDGE_CANDIDATES if p.is_file()), None)
    if browser_path is not None:
        profile_dir = DATA_ROOT / "app-window-profile"
        subprocess.Popen([str(browser_path), f"--app={url}", f"--user-data-dir={profile_dir}"])
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
        self.mode: str = "master"
        self.master_ip: str | None = None
        self._responder_stop = threading.Event()
        self._responder_thread: threading.Thread | None = None

    def effective_url(self) -> str:
        if self.mode == "client" and self.master_ip:
            return f"http://{self.master_ip}:{PORT}"
        return local_url()

    def _start_responder(self) -> None:
        if self._responder_thread is not None and self._responder_thread.is_alive():
            return
        self._responder_stop.clear()
        self._responder_thread = threading.Thread(
            target=discovery.run_responder, args=(PORT, self._responder_stop.is_set), daemon=True
        )
        self._responder_thread.start()

    def _stop_responder(self) -> None:
        self._responder_stop.set()
        if self._responder_thread is not None:
            self._responder_thread.join(timeout=2)
        self._responder_thread = None

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

    def open_app(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        open_app_window(self.effective_url())

    def promote_to_master(self, icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        """Manual fallback for when the real master goes offline (closed,
        rebooted, unplugged from the network): lets this PC take over as
        master instead of being stuck pointed at a master that's gone."""
        if self.mode == "master":
            return
        log.info("Promoting this PC to master (was pointed at %s)", self.master_ip)
        self.mode = "master"
        self.master_ip = None
        if not NETWORK_FLAG.is_file():
            NETWORK_FLAG.write_text("enabled")
        ok = self.start_server()
        self._start_responder()
        threading.Thread(target=self._auto_backup_loop, daemon=True).start()
        if icon is not None:
            icon.icon = ICON_OK if ok else ICON_DOWN
            icon.notify("This PC is now the master. Other PCs can connect to it.", "RECON")

    def toggle_network_mode(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        if network_mode_enabled():
            NETWORK_FLAG.unlink(missing_ok=True)
            self._stop_responder()
            log.info("Network access disabled from tray")
        else:
            NETWORK_FLAG.write_text("enabled")
            self._start_responder()
            log.info("Network access enabled from tray")
        self.stop_server()
        ok = self.start_server()
        if self.icon is not None:
            self.icon.icon = ICON_OK if ok else ICON_DOWN
            if network_mode_enabled() and ok:
                self.icon.notify("Network access on. Other PCs on this network will find it automatically.", "RECON")
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
            return
        self._mirror_backup(destination, notify)

    def _mirror_backup(self, backup_path: Path, notify: bool) -> None:
        """Puts a copy of the backup just written onto the removable drive
        chosen with "Backup To...", whenever that drive is plugged in.

        An unplugged stick is the normal case, not a failure -- it gets a log
        line and nothing else, because a toast every hour saying "your USB
        isn't in" trains you to ignore the toasts that matter. A stick that
        *is* plugged in but rejects the copy is the opposite: that's the one
        case where the off-site copy silently isn't happening, so it's said
        out loud even during an automatic run."""
        record = usb_backup.load(DESTINATION_FILE)
        if record is None:
            return
        label = record.get("label")
        target = usb_backup.resolve(record)
        if target is None:
            log.info("Mirror target %s (%s) not attached -- skipped", record.get("path"), label)
            usb_backup.record_mirror(None, label, error="not attached")
            return
        try:
            copied = usb_backup.mirror_backup(backup_path, target)
        except Exception as exc:
            log.exception("Mirroring backup to %s failed", target)
            usb_backup.record_mirror(None, label, error=str(exc))
            if self.icon is not None:
                self.icon.notify(f"Backup copy to {label or target} failed: {exc}", "RECON")
            return
        log.info("Backup mirrored to %s", copied)
        usb_backup.record_mirror(copied, label)
        if notify and self.icon is not None:
            self.icon.notify(f"Also copied to {label or target}", "RECON")

    def backup_now(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        self._run_backup(notify=True)

    def _remembered_destination(self) -> Path:
        """Where the last "Backup To..." went, for the picker to open on.
        Falls back to the local backups folder when nothing has been chosen
        yet, or when that drive isn't plugged in right now."""
        return usb_backup.resolve(usb_backup.load(DESTINATION_FILE)) or DEFAULT_BACKUPS_DIR

    def backup_to_location(self, _icon: pystray.Icon, _item: pystray.MenuItem) -> None:
        """A one-off backup written wherever you point it, which also becomes
        the standing mirror target: every later backup, automatic ones
        included, lands here too whenever this drive is plugged in.

        Deliberately does not prune_backups() the way the local automatic
        ones do -- a USB stick is the archive, and the act of adding a copy
        to it must never be the thing that deletes older copies off it."""
        DEFAULT_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        chosen = pick_backup_destination(self._remembered_destination())
        if chosen is None:
            return
        try:
            destination = backup_database(DEFAULT_DB, chosen)
        except Exception as exc:
            log.exception("Backup to %s failed", chosen)
            if self.icon is not None:
                self.icon.notify(f"Backup failed: {exc}", "RECON")
            return
        try:
            record = usb_backup.save(DESTINATION_FILE, chosen)
        except OSError:
            log.warning("Could not remember backup destination %s", chosen)
            record = {"label": None}
        usb_backup.record_mirror(destination, record.get("label"))
        log.info("Backup written to %s (mirror target set)", destination)
        if self.icon is not None:
            name = record.get("label") or chosen
            self.icon.notify(f"Backup saved to {name}.\nFuture backups will copy here too.", "RECON")

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
        # The API serves in this same process (uvicorn runs on a thread), so
        # this flag is what /api/backup/status reports as auto_enabled.
        set_auto_backup_running(True)
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
        self._stop_responder()
        self.stop_server()
        icon.stop()

    def _on_ready(self, icon: pystray.Icon) -> None:
        icon.visible = True
        self.open_app(icon, None)

    def run(self) -> None:
        log.info("Looking for an existing master on the LAN...")
        master_ip = discovery.find_master(PORT)
        if master_ip:
            self.mode = "client"
            self.master_ip = master_ip
            icon_state = ICON_OK
            log.info("Found master at %s -- running as client", master_ip)
        else:
            self.mode = "master"
            ok = self.start_server()
            icon_state = ICON_OK if ok else ICON_DOWN
            if network_mode_enabled():
                self._start_responder()
            threading.Thread(target=self._auto_backup_loop, daemon=True).start()
            log.info("No master found -- this PC is the master")

        menu = pystray.Menu(
            pystray.MenuItem("Open RECON", self.open_app, default=True),
            pystray.MenuItem(
                "Allow other PCs on this network",
                self.toggle_network_mode,
                checked=lambda _item: network_mode_enabled(),
                visible=lambda _item: self.mode == "master",
            ),
            pystray.MenuItem(
                lambda _item: f"Connected to master at {self.master_ip} (click to become master)",
                self.promote_to_master,
                visible=lambda _item: self.mode == "client",
            ),
            pystray.MenuItem("Show Server Address", self.show_server_address, visible=lambda _item: self.mode == "master"),
            pystray.MenuItem(
                "Backup Now (entire database)", self.backup_now, visible=lambda _item: self.mode == "master"
            ),
            pystray.MenuItem(
                "Backup To USB or Folder...", self.backup_to_location, visible=lambda _item: self.mode == "master"
            ),
            pystray.MenuItem(
                "Restore Latest Backup", self.restore_latest_backup, visible=lambda _item: self.mode == "master"
            ),
            pystray.MenuItem(
                "Restore From File...", self.restore_from_file, visible=lambda _item: self.mode == "master"
            ),
            pystray.MenuItem(
                "Show Backups Folder", self.show_backups_folder, visible=lambda _item: self.mode == "master"
            ),
            pystray.MenuItem("Restart Server", self.restart, visible=lambda _item: self.mode == "master"),
            pystray.MenuItem("Exit", self.quit_app),
        )
        self.icon = pystray.Icon("discount-auto-ops", icon_state, "RECON", menu)
        self.icon.run(setup=self._on_ready)


def main() -> None:
    TrayApp().run()


if __name__ == "__main__":
    main()
