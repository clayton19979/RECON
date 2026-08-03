from __future__ import annotations

import ctypes
import logging
import os
import socket
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, cast

import pystray
import uvicorn
from PIL import Image

if TYPE_CHECKING:
    # pystray assembles its public Icon/Menu/MenuItem per backend at import
    # time, so `pystray.Icon` is a variable, not a class, to a type checker.
    # The real classes every backend subclasses live in pystray._base.
    from pystray._base import Icon, MenuItem

from app import deployment, discovery, mark, online_updates, paths, updates, usb_backup
from app.backup import (
    AUTO_BACKUP_INTERVAL_MINUTES,
    backup_database,
    backup_timestamp,
    database_changed_since,
    list_backups,
    most_recent_backup_age_hours,
    prune_backups_tiered,
    restore_database,
    set_auto_backup_running,
)
from app.main import (
    DATA_ROOT,
    DEFAULT_BACKUPS_DIR,
    DEFAULT_DB,
    NETWORK_FLAG,
    create_app,
)
from app.single_instance import SingleInstance
from app.window import AppWindow


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
# Daily is the tempo updates actually happen at -- a build published from
# home tonight is on the shop PC before tomorrow's first ticket. The tray
# menu covers "I just published it, get it now".
ONLINE_UPDATE_CHECK_HOURS = 24
# Remembers the last "Backup To..." folder -- both so a USB stick doesn't
# have to be re-navigated every time, and so the automatic backups know
# where to mirror a copy once it's plugged in.
DESTINATION_FILE = DATA_ROOT / "backup_destination.json"


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


DATA_ROOT.mkdir(parents=True, exist_ok=True)
paths.migrate_legacy_data(DATA_ROOT)
logging.basicConfig(
    filename=DATA_ROOT / "tray.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("tray")


def make_icon(top, bottom) -> Image.Image:
    """The RECON mark at tray size, tinted to carry the up/down signal. Same
    geometry as the favicon and the exe icon -- see app/mark.py."""
    return mark.render(64, body_top=top, body_bottom=bottom, supersample=4)


ICON_OK = make_icon(mark.AZURE_LT, mark.AZURE)
ICON_DOWN = make_icon(mark.CRIT_LT, mark.CRIT)


def _dynamic(predicate) -> bool:
    """pystray re-evaluates a callable MenuItem `visible` every time the menu
    opens, but its unannotated signature (default True) reads as plain bool to
    a type checker. Funnel the documented callable form through one cast."""
    return cast(bool, predicate)


class TrayApp:
    def __init__(self, guard: SingleInstance | None = None) -> None:
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.icon: Icon | None = None
        self.mode: str = deployment.MASTER
        self.master_ip: str | None = None
        self._responder_stop = threading.Event()
        self._responder_thread: threading.Thread | None = None
        self._guard = guard
        self._quitting = False
        # on_quit is the update path's way out. Installing has to stop this
        # process entirely -- Setup cannot replace a RECON.exe this very
        # process is holding open -- and closing the window is not enough,
        # because on the shop PC that hides to the tray by design.
        self.window = AppWindow(
            on_retry=self._retry_from_window,
            on_closing=self._on_window_closing,
            on_quit=self._quit_for_update,
        )

    def _retry_from_window(self) -> str | None:
        """Offline screen's Retry: returns the URL to navigate to, or None so
        the page can put its button back and let them try again."""
        return self.effective_url() if self.retry_master() else None

    def effective_url(self) -> str:
        if self.mode == deployment.CLIENT and self.master_ip:
            return f"http://{self.master_ip}:{PORT}"
        return local_url()

    def locate_master(self, configured_host: str | None = None) -> str | None:
        """Where the shop PC is. A host pinned by the installer wins -- it
        survives the shop PC being off at the moment this workstation boots,
        which a broadcast does not. Otherwise ask the LAN."""
        if configured_host:
            log.info("Using master host %s from config", configured_host)
            return configured_host
        log.info("Looking for the shop PC on the network...")
        found = discovery.find_master(PORT)
        log.info("Shop PC %s", f"answered from {found}" if found else "did not answer")
        return found

    def master_reachable(self, host: str | None = None) -> bool:
        """Can we actually open a socket to it right now? Discovery answering
        once at boot says nothing about the shop PC still being on."""
        target = host or self.master_ip
        if not target:
            return False
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1.5)
        try:
            return sock.connect_ex((target, PORT)) == 0
        except OSError:
            return False
        finally:
            sock.close()

    def retry_master(self) -> str | None:
        """Behind the Retry button on the workstation's offline screen."""
        self.master_ip = self.locate_master(deployment.load().get("master_host"))
        if self.master_ip and not self.master_reachable():
            self.master_ip = None
        if self.icon is not None:
            self.icon.icon = ICON_OK if self.master_ip else ICON_DOWN
        return self.master_ip

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
            config = uvicorn.Config(
                create_app(), host=host, port=PORT, log_level="warning", log_config=None, access_log=False
            )
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

    def restart(self, _icon: Icon, _item: MenuItem) -> None:
        log.info("Restart requested from tray")
        self.stop_server()
        ok = self.start_server()
        if self.icon is not None:
            self.icon.icon = ICON_OK if ok else ICON_DOWN

    def open_app(self, _icon: Icon | None = None, _item: MenuItem | None = None) -> None:
        """'Open RECON' from the tray -- surfaces the existing window rather
        than spawning anything new."""
        if self.mode == deployment.CLIENT and not self.master_reachable():
            self.retry_master()
        self.window.show()

    def promote_to_master(self, icon: Icon, _item: MenuItem) -> None:
        """Escape hatch for when the shop PC is off and work cannot wait for
        it. Deliberately manual: an automatic takeover is exactly what caused
        two PCs to each start their own database.

        The new role is persisted, so a PC promoted at 8am is still the master
        after lunch. Whoever promoted it owns merging the records back."""
        if self.mode == deployment.MASTER:
            return
        log.warning("Promoting this PC to master (was pointed at %s)", self.master_ip)
        self.mode = deployment.MASTER
        self.master_ip = None
        try:
            deployment.save(deployment.MASTER)
        except OSError:
            log.exception("Promoted, but could not persist the role -- it will revert on restart")
        if not NETWORK_FLAG.is_file():
            NETWORK_FLAG.write_text("enabled")
        ok = self.start_server()
        self._start_responder()
        threading.Thread(target=self._auto_backup_loop, daemon=True).start()
        threading.Thread(target=self._online_update_loop, daemon=True).start()
        if icon is not None:
            icon.icon = ICON_OK if ok else ICON_DOWN
            icon.notify("This PC is now the master. Other PCs can connect to it.", "RECON")

    def toggle_network_mode(self, _icon: Icon, _item: MenuItem) -> None:
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

    def show_server_address(self, _icon: Icon, _item: MenuItem) -> None:
        if self.icon is None:
            return
        if network_mode_enabled():
            self.icon.notify(f"Other PCs go to: {local_url()}", "RECON")
        else:
            self.icon.notify("Network access is off -- enable it first to share with other PCs.", "RECON")

    def _run_backup(self, notify: bool) -> None:
        try:
            destination = backup_database(DEFAULT_DB, DEFAULT_BACKUPS_DIR)
            removed = prune_backups_tiered(DEFAULT_BACKUPS_DIR)
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

    def backup_now(self, _icon: Icon, _item: MenuItem) -> None:
        self._run_backup(notify=True)

    def _remembered_destination(self) -> Path:
        """Where the last "Backup To..." went, for the picker to open on.
        Falls back to the local backups folder when nothing has been chosen
        yet, or when that drive isn't plugged in right now."""
        return usb_backup.resolve(usb_backup.load(DESTINATION_FILE)) or DEFAULT_BACKUPS_DIR

    def backup_to_location(self, _icon: Icon, _item: MenuItem) -> None:
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

    def restore_latest_backup(self, _icon: Icon, _item: MenuItem) -> None:
        backups = list_backups(DEFAULT_BACKUPS_DIR)
        if not backups:
            if self.icon is not None:
                self.icon.notify("No backups found to restore.", "RECON")
            return
        self._restore_from_path(backups[0])

    def restore_from_file(self, _icon: Icon, _item: MenuItem) -> None:
        """For moving to a fresh install/new PC: the backup being restored
        won't be sitting in the default backups folder under a name
        "Restore Latest Backup" would recognize, so this lets you point at
        any .db file directly."""
        DEFAULT_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        chosen = pick_backup_file(DEFAULT_BACKUPS_DIR)
        if chosen is None:
            return
        self._restore_from_path(chosen)

    def show_backups_folder(self, _icon: Icon, _item: MenuItem) -> None:
        DEFAULT_BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(DEFAULT_BACKUPS_DIR)

    def show_updates_folder(self, _icon: Icon, _item: MenuItem) -> None:
        """Opens the folder a new build gets dropped into.

        This is the whole update workflow on the shop PC's side: copy
        RECON-Setup-x.y.z.exe in here off the USB stick, and every workstation
        (and this PC) starts offering it. Creating the folder on demand means
        there's somewhere to drop the file the first time it's ever needed,
        rather than an error about a path that doesn't exist yet."""
        updates_dir = updates.updates_dir(DATA_ROOT)
        updates_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(updates_dir)

    def check_online_updates(self, _icon: Icon, _item: MenuItem) -> None:
        """Tray click: ask the release source right now instead of waiting for
        the daily check. On a thread because a 40 MB download must not hold
        the tray menu hostage."""
        threading.Thread(target=self._check_online, args=(True,), daemon=True).start()

    def _check_online(self, manual: bool) -> None:
        result = online_updates.check_and_fetch(DATA_ROOT)
        status = result.get("status")
        if status == "downloaded":
            # Worth a toast even on the automatic check -- but it only ever
            # announces; installing stays a deliberate click in the app.
            log.info("Online check downloaded %s", result.get("filename"))
            if self.icon is not None:
                self.icon.notify(
                    f"RECON {result.get('version')} downloaded. The app will offer to install it.",
                    "RECON",
                )
            return
        if not manual or self.icon is None:
            return
        if status == "off":
            self.icon.notify(
                f"Online updates aren't set up on this PC.\nCreate {online_updates.config_path(DATA_ROOT)} first.",
                "RECON",
            )
        elif status == "already":
            self.icon.notify(
                f"Version {result.get('version')} is already downloaded and waiting to be installed.",
                "RECON",
            )
        elif status == "error":
            self.icon.notify(f"Couldn't check for updates: {result.get('detail')}", "RECON")
        else:
            self.icon.notify("You're on the newest version.", "RECON")

    def _online_update_loop(self) -> None:
        """Runs for the life of the process on the master: once a day, sees
        whether a new build has been published and pulls it into the updates
        folder, where the existing offer-and-install flow takes over.

        The first check waits a couple of minutes so a shop PC switched on at
        opening time has its network up before anything asks the internet.
        Unconfigured installs pass through check_and_fetch as a no-op, so the
        loop costs nothing until update_source.json exists."""
        time.sleep(120)
        while True:
            try:
                self._check_online(manual=False)
            except Exception:
                log.exception("Online update check failed")
            time.sleep(ONLINE_UPDATE_CHECK_HOURS * 3600)

    def _auto_backup_loop(self) -> None:
        """Runs for the life of the process: snapshots the database whenever
        the last one has gone stale, then checks again shortly after. Protects
        against data loss without Clay having to remember to click Backup Now.

        Skips the snapshot when nothing has been written since the last one --
        at a five-minute cadence an idle weekend would otherwise mint hundreds
        of identical files and push the ones that actually differ out of the
        dense retention tier."""
        # The API serves in this same process (uvicorn runs on a thread), so
        # this flag is what /api/backup/status reports as auto_enabled.
        set_auto_backup_running(True)
        interval_hours = AUTO_BACKUP_INTERVAL_MINUTES / 60
        while True:
            try:
                age = most_recent_backup_age_hours(DEFAULT_BACKUPS_DIR)
                if age is None or age >= interval_hours:
                    # Unparseable names have no timestamp to compare against;
                    # ignoring them here just means "back up anyway".
                    stamps = [s for s in map(backup_timestamp, list_backups(DEFAULT_BACKUPS_DIR)) if s]
                    if database_changed_since(DEFAULT_DB, max(stamps) if stamps else None):
                        self._run_backup(notify=False)
            except Exception:
                log.exception("Auto-backup check failed")
            time.sleep(AUTO_BACKUP_INTERVAL_MINUTES * 60)

    def quit_app(self, icon: Icon | None = None, _item: MenuItem | None = None) -> None:
        log.info("Exit requested")
        self._quitting = True
        self._stop_responder()
        self.stop_server()
        if self._guard is not None:
            self._guard.stop()
        if icon is not None:
            icon.stop()
        elif self.icon is not None:
            self.icon.stop()
        # Tears down the GUI loop, which releases main() and ends the process.
        self.window.destroy()

    def _quit_for_update(self) -> None:
        """Stand down so the installer can replace the exe.

        The same shutdown the tray's Exit does, and it has to be that rather
        than a window close: the point is to release every handle on
        RECON.exe and free the port, which only a full exit does. Called from a
        timer thread inside window.Api, so it is deliberately just the ordinary
        quit path with nothing thread-specific about it.
        """
        log.info("Shutting down so the update can install")
        self.quit_app()

    def _on_window_closing(self) -> bool:
        """The X button. On the shop PC this must not stop the server -- every
        workstation is talking to it -- so the window hides to the tray and the
        process stays up. A workstation has nothing to keep alive, so it exits.
        """
        if self._quitting:
            return True
        if self.mode == deployment.MASTER:
            log.info("Window closed -- staying resident so workstations keep working")
            if self.icon is not None:
                self.icon.notify("RECON is still running so other PCs can reach it.", "RECON")
            self.window.hide()
            return False
        self.quit_app()
        return True

    def _on_ready(self, icon: Icon) -> None:
        icon.visible = True

    def run(self) -> None:
        config = deployment.load()
        self.mode = config["role"]
        if not config["configured"]:
            log.info("No %s found -- running standalone as master", deployment.CONFIG_NAME)

        if self.mode == deployment.CLIENT:
            # A workstation never starts a server. It finds the shop PC, or it
            # says so plainly; it does not quietly start a second database.
            self.master_ip = self.locate_master(config.get("master_host"))
            icon_state = ICON_OK if self.master_ip else ICON_DOWN
        else:
            ok = self.start_server()
            icon_state = ICON_OK if ok else ICON_DOWN
            if network_mode_enabled():
                self._start_responder()
            threading.Thread(target=self._auto_backup_loop, daemon=True).start()
            threading.Thread(target=self._online_update_loop, daemon=True).start()
            log.info("This PC is the master (role fixed at install)")

        menu = pystray.Menu(
            pystray.MenuItem("Open RECON", self.open_app, default=True),
            pystray.MenuItem(
                "Allow other PCs on this network",
                self.toggle_network_mode,
                checked=lambda _item: network_mode_enabled(),
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                lambda _item: f"Connected to master at {self.master_ip} (click to become master)",
                self.promote_to_master,
                visible=_dynamic(lambda _item: self.mode == deployment.CLIENT),
            ),
            pystray.MenuItem(
                "Show Server Address",
                self.show_server_address,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Backup Now (entire database)",
                self.backup_now,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Backup To USB or Folder...",
                self.backup_to_location,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Restore Latest Backup",
                self.restore_latest_backup,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Restore From File...",
                self.restore_from_file,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Show Backups Folder",
                self.show_backups_folder,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            # Master only: this PC is what hands updates to the workstations,
            # so it's the only one where dropping a build in achieves anything.
            pystray.MenuItem(
                "Install Update From File...",
                self.show_updates_folder,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Check Online for Updates",
                self.check_online_updates,
                visible=_dynamic(lambda _item: self.mode == deployment.MASTER),
            ),
            pystray.MenuItem(
                "Restart Server", self.restart, visible=_dynamic(lambda _item: self.mode == deployment.MASTER)
            ),
            pystray.MenuItem("Exit", self.quit_app),
        )
        icon = pystray.Icon("recon", icon_state, "RECON", menu)
        self.icon = icon
        # Detached, because pywebview must own the main thread on Windows.
        icon.run_detached(setup=self._on_ready)

        if self._guard is not None:
            self._guard.listen(self.window.show)

        # A workstation that can't see the shop PC opens on the offline screen
        # rather than a connection error; the Retry button lives there.
        url = self.effective_url() if self.mode == deployment.MASTER or self.master_ip else None
        if url and self.mode == deployment.CLIENT and not self.master_reachable():
            log.warning("Shop PC did not answer on %s -- opening the offline screen", self.master_ip)
            url = None

        self.window.start(url, on_ready=lambda: log.info("Window ready (%s)", self.mode))
        # webview.start() returned, so the window is really gone: shut down.
        if not self._quitting:
            self.quit_app()


def main() -> None:
    guard = SingleInstance("RECON")
    if guard.already_running:
        # Don't start a second server -- surface the copy already running.
        guard.signal_existing()
        log.info("Another copy is already running; asked it to show its window")
        return
    TrayApp(guard).run()


if __name__ == "__main__":
    main()
