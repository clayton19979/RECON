"""RECON on a phone.

A second front end over the same API, for the person standing next to the
car rather than sitting at the desk. See MOBILE-APP-PLAN.md for why this is
a web app and not a native one; the short version is that a build step was
never on the table and neither was an App Store review cycle for two users
on one wifi network.

Four routes, no state, no queries. Everything the phone shows it fetches
from the same `/api/...` the desktop uses, so the two can't drift.

The documents are read off disk per request. Same rule as the desktop
shell: edit a file, refresh the phone, see the change -- no build, nothing
to rebuild on the shop PC before opening.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

# Shown on the phone's task switcher and splash screen, and what iOS uses
# for the home-screen label. Kept short because iOS truncates hard.
MANIFEST = {
    "name": "RECON",
    "short_name": "RECON",
    "description": "The lot, in your pocket.",
    "start_url": "/m/",
    "scope": "/m/",
    "display": "standalone",
    "orientation": "portrait",
    # Matches --paper on the default `harbor` theme. The phone honours
    # whatever theme is saved in localStorage once the app boots; this is
    # only the colour of the splash screen before any of that has run.
    "background_color": "#0c1118",
    "theme_color": "#0c1118",
    "icons": [
        {"src": "/assets/m/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "/assets/m/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "/assets/m/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}


def lan_address() -> str:
    """This machine's address on the shop's network.

    A phone cannot use 127.0.0.1, and the shop PC has no fixed name a phone
    could resolve, so the Updates screen has to be able to print the actual
    number somebody types into a phone browser. Without it, setting the phone
    up means opening a Command Prompt and reading `ipconfig`, which is not
    something to ask of a mechanic before opening.

    Found by asking the OS which interface it would *use* to reach the wider
    network. Nothing is sent -- a UDP socket has no handshake, so connect()
    only picks the route -- and the address that comes back is this PC's LAN
    IP, which is what the phone needs. gethostbyname(gethostname()) is the
    obvious alternative and is wrong on any machine with more than one adapter
    (it happily returns a VPN or Hyper-V address that no phone can reach).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))  # TEST-NET-1: reserved, routed nowhere
        return str(sock.getsockname()[0])
    except OSError:
        # No network at all. Better to say so than to print a loopback address
        # that would send somebody typing it into a phone in circles.
        return ""
    finally:
        sock.close()


def build_mobile_router(static: Path, network_flag: Path | None = None) -> APIRouter:
    router = APIRouter()
    mobile_dir = static / "m"

    @router.get("/m", include_in_schema=False)
    def mobile_root():
        # The service worker's scope is "/m/", and a document at "/m" is not
        # inside it -- the app would install and then never be controlled.
        # Redirect rather than serve, so there is exactly one URL that works.
        return RedirectResponse("/m/", status_code=308)

    @router.get("/m/", include_in_schema=False)
    def mobile_index():
        shell = mobile_dir / "index.html"
        if not shell.is_file():
            raise HTTPException(status_code=404, detail="The phone app isn't installed on this server.")
        return HTMLResponse(shell.read_text(encoding="utf-8"))

    @router.get("/api/mobile/link")
    def mobile_link(request: Request):
        """What to type into a phone, and whether it will work yet.

        `sharing` is the network-mode flag the tray toggles. With it off the
        server is bound to loopback and no phone can reach it however correct
        the address is -- so the screen says that instead of handing out a URL
        that silently fails.
        """
        host = lan_address()
        port = request.url.port or 8787
        return {
            "url": f"http://{host}:{port}/m/" if host else "",
            "host": host,
            "port": port,
            "sharing": bool(network_flag and network_flag.is_file()),
        }

    @router.get("/m/manifest.webmanifest", include_in_schema=False)
    def mobile_manifest():
        # Served from a route rather than sat in static/ so the icon paths and
        # the start_url can't fall out of step with the routes above without a
        # test noticing.
        return Response(json.dumps(MANIFEST, indent=2), media_type="application/manifest+json")

    @router.get("/m/sw.js", include_in_schema=False)
    def mobile_service_worker():
        worker = mobile_dir / "sw.js"
        if not worker.is_file():
            raise HTTPException(status_code=404, detail="The phone app isn't installed on this server.")
        # Served from /m/ (not /assets/) so its default scope is /m/ and it
        # controls the app without needing Service-Worker-Allowed.
        return Response(worker.read_text(encoding="utf-8"), media_type="text/javascript")

    return router
