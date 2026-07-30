"""RECON's own window.

Previously the UI opened in Chrome or Edge with `--app=`, found by probing
hardcoded install paths. That worked until it didn't: no Chrome and no Edge at
the expected path meant falling back to a normal browser tab, address bar and
all. It also left a browser profile directory next to the database, and let
browser keybindings (F12, Ctrl+P, backspace-navigates) leak into what is
supposed to be a shop tool.

This uses WebView2 through pywebview instead -- the same rendering engine, but
in a window RECON owns. WebView2 ships with Windows 11 and arrives on Windows
10 with Edge; the installer bootstraps it on anything older.
"""

from __future__ import annotations

import logging
import urllib.request
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from app import paths

log = logging.getLogger("tray")

# How long to wait on the shop PC for the bytes behind a download. Backups are
# small (a few hundred KB) and the server is on the LAN, so anything past this
# means the server is wedged, not that the file is big.
DOWNLOAD_TIMEOUT_SECONDS = 60

MIN_WIDTH = 980
MIN_HEIGHT = 640
DEFAULT_WIDTH = 1400
DEFAULT_HEIGHT = 900


def set_app_user_model_id(app_id: str = "Recon.ShopTool") -> None:
    """Without this Windows groups the window under the generic Python host,
    so pinning it to the taskbar pins the wrong thing and the icon is wrong."""
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        log.debug("Could not set the AppUserModelID", exc_info=True)


OFFLINE_HTML = """<!doctype html>
<meta charset="utf-8">
<title>RECON</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    background: #0c1118; color: #e9eff7;
    font: 15px/1.55 "Segoe UI", system-ui, sans-serif;
  }
  .box { max-width: 30rem; padding: 0 2rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .6rem; font-weight: 600; }
  p { color: #a9b6c8; margin: 0 0 1.4rem; }
  code { color: #67a3e1; font-family: "Cascadia Mono", Consolas, monospace; }
  button {
    font: inherit; font-weight: 600; color: #fff; background: #3f8bd9;
    border: 0; border-radius: 8px; padding: .6rem 1.5rem; cursor: pointer;
  }
  button:hover { background: #67a3e1; }
  button:disabled { opacity: .55; cursor: default; }
  .note { margin-top: 1.4rem; font-size: 13px; color: #74839a; }
</style>
<div class="box">
  <h1>Can't reach the shop PC</h1>
  <p>
    This workstation keeps its records on the main shop PC, and that PC isn't
    answering right now. It's usually off, asleep, or off the network.
  </p>
  <button id="retry">Try again</button>
  <p class="note">
    If the shop PC is going to be down a while, you can take over from the
    RECON tray icon &mdash; <em>click to become master</em>. Records created
    that way have to be merged back by hand later.
  </p>
</div>
<script>
  const btn = document.getElementById('retry');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking...';
    const found = await window.pywebview.api.retry();
    if (found) { location.replace(found); return; }
    btn.disabled = false;
    btn.textContent = 'Try again';
  });
</script>
"""


class Api:
    """Exposed to the page as `window.pywebview.api`.

    `retry` is what the offline screen calls; `save_file` is what every
    download in the app routes through when RECON is running in its own
    window rather than a browser tab.
    """

    def __init__(self, on_retry: Callable[[], str | None], current_url: Callable[[], str | None]) -> None:
        self._on_retry = on_retry
        self._current_url = current_url
        self._window = None

    def bind(self, window) -> None:
        self._window = window

    def retry(self) -> str | None:
        try:
            return self._on_retry()
        except Exception:
            log.exception("Retry from the offline screen failed")
            return None

    def _absolute(self, path: str) -> str:
        """Turn an app-relative download path into a URL on the server this
        window is already talking to.

        Deliberately refuses anything that carries its own scheme or host: the
        page drives this method, so restricting it to the origin the window was
        opened with keeps it a download helper rather than a general-purpose
        "fetch any URL and write it to disk" primitive.
        """
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Only same-origin paths can be saved")
        base = self._current_url()
        if not base:
            raise ValueError("Not connected to the shop PC")
        parts = urlsplit(base)
        target = urlsplit(path)
        return urlunsplit((parts.scheme, parts.netloc, target.path, target.query, ""))

    def save_file(self, path: str, suggested_name: str) -> dict:
        """Fetch a download from the server and let the operator choose where
        it lands, with a real folder picker.

        WebView2 downloads are off by default in pywebview, which is why every
        `<a download>` in the app did nothing at all. Turning them on (see
        `start()`) makes them work, but drops the file in the machine's
        Downloads folder -- and the whole point of downloading a backup is to
        put it somewhere deliberate, usually a flash drive. So the app asks
        here instead, and only falls back to the browser's own handling when
        there is no pywebview to ask (a workstation using a browser tab).
        """
        import webview

        if self._window is None:
            return {"ok": False, "error": "No window to prompt from"}
        try:
            url = self._absolute(path)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        safe_name = Path(suggested_name or "").name or "recon-download"
        try:
            destination = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=str(Path.home() / "Downloads"),
                save_filename=safe_name,
            )
        except Exception:
            log.exception("Could not open the save dialog")
            return {"ok": False, "error": "Could not open the save dialog"}

        # Cancelled: older builds return an empty tuple, newer ones None.
        if not destination:
            return {"ok": False, "cancelled": True}
        chosen = Path(destination[0] if isinstance(destination, (list, tuple)) else destination)

        try:
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                payload = response.read()
        except Exception as exc:
            log.exception("Download failed: %s", url)
            return {"ok": False, "error": f"Could not download from the shop PC: {exc}"}

        try:
            chosen.write_bytes(payload)
        except OSError as exc:
            log.exception("Could not write %s", chosen)
            return {"ok": False, "error": f"Could not write that file: {exc}"}
        return {"ok": True, "path": str(chosen), "bytes": len(payload)}

    def install_update(self, path: str, filename: str) -> dict:
        """Fetch the installer the shop PC is offering and run it.

        Deliberately a separate method from `save_file` even though both
        download: this one hands the result to the operating system to
        execute, which is not something the generic "save a file somewhere"
        helper should ever be able to do. It only accepts a same-origin path
        (see `_absolute`), and only ever writes to a temp file it names
        itself, so the page cannot steer it at an arbitrary executable.

        The installer needs elevation, so Windows raises its own UAC prompt.
        Declining it leaves the running app untouched -- the update simply
        doesn't happen, which is the right failure.
        """
        import subprocess
        import tempfile

        try:
            url = self._absolute(path)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        safe_name = Path(filename or "").name
        if not safe_name.lower().endswith(".exe"):
            return {"ok": False, "error": "That update doesn't look like an installer"}

        target = Path(tempfile.gettempdir()) / "RECON-updates" / safe_name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                target.write_bytes(response.read())
        except Exception as exc:
            log.exception("Could not download the update from %s", url)
            return {"ok": False, "error": f"Could not download the update: {exc}"}

        try:
            # Inno Setup's own /SILENT would skip the prompts, but this shop
            # updates rarely and a visible installer is the clearer thing to
            # hand someone -- they see what is happening and can back out.
            subprocess.Popen([str(target)], close_fds=True)
        except OSError as exc:
            log.exception("Could not launch the installer at %s", target)
            return {"ok": False, "error": f"Could not start the installer: {exc}"}
        return {"ok": True, "path": str(target)}


class AppWindow:
    """Owns the single RECON window.

    pywebview must run its loop on the main thread on Windows, so the tray
    icon runs detached and this takes over the main thread in `start()`.
    """

    def __init__(self, *, on_retry: Callable[[], str | None], on_closing: Callable[[], bool]) -> None:
        self._on_retry = on_retry
        self._on_closing = on_closing
        self._window = None
        self._started = False
        self._url: str | None = None
        self._api = Api(self._on_retry, lambda: self._url)

    def _create(self, url: str | None):
        import webview

        kwargs = {
            "title": "RECON",
            "width": DEFAULT_WIDTH,
            "height": DEFAULT_HEIGHT,
            "min_size": (MIN_WIDTH, MIN_HEIGHT),
            "background_color": "#0c1118",
            # Both windows get the api: the offline screen needs `retry`, and
            # the app itself needs `save_file` for every download link.
            "js_api": self._api,
        }
        self._url = url
        if url:
            window = webview.create_window(url=url, **kwargs)
        else:
            window = webview.create_window(html=OFFLINE_HTML, **kwargs)
        assert window is not None  # typed Optional, but create_window never returns None
        window.events.closing += self._handle_closing
        self._api.bind(window)
        return window

    def _handle_closing(self) -> bool:
        """Returning False cancels the close. On the shop PC that is the whole
        point: closing the window must not stop the server every workstation
        is talking to, so it hides to the tray instead."""
        try:
            return self._on_closing()
        except Exception:
            log.exception("Close handler failed -- letting the window close")
            return True

    def start(self, url: str | None, on_ready: Callable[[], None] | None = None) -> None:
        """Blocks on the GUI loop until the window is really closed."""
        import webview

        set_app_user_model_id()
        # Off by default in pywebview, which silently swallowed every
        # `<a download>` in the app -- backup downloads, the vehicles CSV and
        # the report CSV all appeared to do nothing at all. The app routes
        # downloads through `Api.save_file` so the operator gets a folder
        # picker, but this stays on as the fallback for anything that reaches
        # the webview directly.
        webview.settings["ALLOW_DOWNLOADS"] = True
        self._window = self._create(url)
        self._started = True
        icon = paths.bundle_root() / "static" / "favicon.ico"
        start_kwargs = {"private_mode": False, "storage_path": str(paths.data_root() / "webview")}
        if icon.is_file():
            start_kwargs["icon"] = str(icon)
        # No `args` for on_ready: pywebview would splat whatever is passed
        # there into the callback, and every on_ready in this app takes zero
        # arguments. (Passing the window here used to make the callback die
        # with a TypeError in pywebview's thread -- silently, because stderr
        # goes nowhere in a windowed exe.)
        try:
            webview.start(on_ready or (lambda: None), **start_kwargs)
        except TypeError:
            # Older pywebview builds don't accept `icon`; the window still works.
            start_kwargs.pop("icon", None)
            webview.start(on_ready or (lambda: None), **start_kwargs)

    def show(self) -> None:
        """Bring the window back after a close-to-tray, or surface it when a
        second launch asks us to."""
        if self._window is None:
            return
        try:
            self._window.show()
            self._window.on_top = True
            self._window.on_top = False
        except Exception:
            log.exception("Could not surface the window")

    def hide(self) -> None:
        if self._window is not None:
            try:
                self._window.hide()
            except Exception:
                log.exception("Could not hide the window")

    def load(self, url: str) -> None:
        if self._window is not None:
            self._url = url
            self._window.load_url(url)

    def destroy(self) -> None:
        if self._window is not None:
            try:
                self._window.destroy()
            except Exception:
                log.debug("Window already gone", exc_info=True)
            self._window = None
