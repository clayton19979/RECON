from __future__ import annotations

import socket
import time
from typing import Callable

DISCOVERY_PORT = 47823
DISCOVER_MSG = b"DISCOUNT_AUTO_OPS_DISCOVER"
HERE_PREFIX = b"DISCOUNT_AUTO_OPS_HERE:"


def find_master(port: int, timeout: float = 1.5) -> str | None:
    """Broadcasts a discovery request on the LAN and returns the IP of the
    first master that answers, or None if nobody responds in time -- the
    signal that this machine should become the master itself."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.sendto(DISCOVER_MSG, ("255.255.255.255", DISCOVERY_PORT))
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(256)
            except socket.timeout:
                return None
            if data.startswith(HERE_PREFIX):
                return addr[0]
    except OSError:
        return None
    finally:
        sock.close()


def run_responder(port: int, should_stop: Callable[[], bool]) -> None:
    """Runs on the master for as long as `should_stop()` returns False:
    answers discovery broadcasts from client PCs so they can find this
    machine on their own, without anyone having to read an IP off the tray
    menu and type it in elsewhere."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", DISCOVERY_PORT))
    except OSError:
        return
    sock.settimeout(1.0)
    try:
        while not should_stop():
            try:
                data, addr = sock.recvfrom(256)
            except socket.timeout:
                continue
            if data == DISCOVER_MSG:
                sock.sendto(HERE_PREFIX + str(port).encode(), addr)
    finally:
        sock.close()
