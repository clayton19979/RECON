"""One RECON per login session.

Without this, launching the exe twice starts a second uvicorn -- which has
actually happened here: two servers racing for port 8000, one of them losing
the bind and sitting there useless. Worse on the master, where a second
process would open the same SQLite file from a second connection pool.

The guard is a named Windows mutex. The second launch does not just die
quietly -- it signals the first through a named event, so the running copy
brings its window to the front. That is what people expect when they
double-click an already-running app.

The namespace is `Local\\`, i.e. per login session rather than per machine.
Two different Windows users on the same PC each get their own instance,
which matches how every other desktop app behaves, and it avoids the
SeCreateGlobalPrivilege that `Global\\` objects need (standard users on a
shop PC will not have it). Machine-wide server collisions are a separate
concern, handled by the port bind in tray_app.
"""

from __future__ import annotations

import ctypes
import logging
import threading
from collections.abc import Callable
from ctypes import wintypes

log = logging.getLogger("tray")

ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
_kernel32.CreateMutexW.restype = wintypes.HANDLE
_kernel32.CreateEventW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
_kernel32.CreateEventW.restype = wintypes.HANDLE
_kernel32.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
_kernel32.OpenEventW.restype = wintypes.HANDLE
_kernel32.SetEvent.argtypes = [wintypes.HANDLE]
_kernel32.SetEvent.restype = wintypes.BOOL
_kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_kernel32.WaitForSingleObject.restype = wintypes.DWORD
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel32.CloseHandle.restype = wintypes.BOOL

EVENT_MODIFY_STATE = 0x0002


class SingleInstance:
    """Owns the mutex for as long as this process should be the only one."""

    def __init__(self, key: str = "RECON") -> None:
        self._mutex_name = f"Local\\{key}.mutex"
        self._event_name = f"Local\\{key}.show"
        self._mutex = _kernel32.CreateMutexW(None, False, self._mutex_name)
        self.already_running = ctypes.get_last_error() == ERROR_ALREADY_EXISTS
        self._event: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def signal_existing(self) -> bool:
        """Ask the copy that is already running to surface its window."""
        handle = _kernel32.OpenEventW(EVENT_MODIFY_STATE, False, self._event_name)
        if not handle:
            return False
        try:
            return bool(_kernel32.SetEvent(handle))
        finally:
            _kernel32.CloseHandle(handle)

    def listen(self, on_signal: Callable[[], None]) -> None:
        """Run `on_signal` whenever another launch asks us to show ourselves.

        Waits with a timeout rather than forever so the thread can notice
        `stop()` and let the process exit instead of hanging on shutdown.
        """
        # auto-reset, initially unset -- each SetEvent releases exactly one wait
        self._event = _kernel32.CreateEventW(None, False, False, self._event_name)
        if not self._event:
            log.warning("Could not create the show-window event; second launches will be ignored")
            return

        def pump() -> None:
            while not self._stop.is_set():
                if _kernel32.WaitForSingleObject(self._event, 500) == WAIT_OBJECT_0:
                    if self._stop.is_set():
                        return
                    log.info("Another launch asked us to show the window")
                    try:
                        on_signal()
                    except Exception:
                        log.exception("Failed to show the window on request")

        self._thread = threading.Thread(target=pump, name="single-instance", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._event:
            _kernel32.SetEvent(self._event)  # break the wait immediately
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        for handle in (self._event, self._mutex):
            if handle:
                _kernel32.CloseHandle(handle)
        self._event = None
        self._mutex = None
