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
from typing import Callable

from app import paths

log = logging.getLogger("tray")

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
    """Exposed to the offline page as `window.pywebview.api`."""

    def __init__(self, on_retry: Callable[[], str | None]) -> None:
        self._on_retry = on_retry

    def retry(self) -> str | None:
        try:
            return self._on_retry()
        except Exception:
            log.exception("Retry from the offline screen failed")
            return None


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

    def _create(self, url: str | None):
        import webview

        kwargs = dict(
            title="RECON",
            width=DEFAULT_WIDTH,
            height=DEFAULT_HEIGHT,
            min_size=(MIN_WIDTH, MIN_HEIGHT),
            background_color="#0c1118",
        )
        if url:
            window = webview.create_window(url=url, **kwargs)
        else:
            window = webview.create_window(html=OFFLINE_HTML, js_api=Api(self._on_retry), **kwargs)
        window.events.closing += self._handle_closing
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
        self._window = self._create(url)
        self._started = True
        icon = paths.bundle_root() / "static" / "favicon.ico"
        start_kwargs = {"private_mode": False, "storage_path": str(paths.data_root() / "webview")}
        if icon.is_file():
            start_kwargs["icon"] = str(icon)
        try:
            webview.start(on_ready or (lambda: None), self._window, **start_kwargs)
        except TypeError:
            # Older pywebview builds don't accept `icon`; the window still works.
            start_kwargs.pop("icon", None)
            webview.start(on_ready or (lambda: None), self._window, **start_kwargs)

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
            self._window.load_url(url)

    def destroy(self) -> None:
        if self._window is not None:
            try:
                self._window.destroy()
            except Exception:
                log.debug("Window already gone", exc_info=True)
            self._window = None
