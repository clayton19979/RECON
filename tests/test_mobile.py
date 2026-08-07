"""The phone app: its routes, and the promises it makes to the desktop one.

RECON on a phone is a second front end over the same API (see
MOBILE-APP-PLAN.md). The risk that comes with a second front end is drift --
two screens quietly disagreeing about what a car still needs, what it cost, or
which pile it is in. Most of what's below is about pinning the two together so
that drift is a failing test rather than an argument at the counter.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from tests.js_source import code_only

STATIC = Path(__file__).resolve().parent.parent / "static"
MOBILE = STATIC / "m"
MOBILE_JS = MOBILE / "js"
DESKTOP_JS = STATIC / "js"


# ---------------------------------------------------------------- the routes


def test_phone_app_is_served(client) -> None:
    res = client.get("/m/")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert "m-app" in res.text


def test_bare_m_redirects_into_the_service_workers_scope(client) -> None:
    """`/m` is outside a `/m/`-scoped service worker, so a phone that installed
    from it would never be controlled by the worker it just registered. One URL
    works and the other one sends you to it."""
    res = client.get("/m", follow_redirects=False)
    assert res.status_code == 308
    assert res.headers["location"] == "/m/"


def test_the_desktop_app_still_serves(client) -> None:
    """The phone is an addition, not a replacement."""
    res = client.get("/")
    assert res.status_code == 200
    assert 'id="view-vehicles"' in res.text


def test_manifest_describes_an_installable_app(client) -> None:
    res = client.get("/m/manifest.webmanifest")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/manifest+json")
    manifest = json.loads(res.text)
    # Without display+start_url+icons, "Add to Home Screen" produces a browser
    # bookmark rather than something that opens like an app.
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/m/"
    assert manifest["scope"] == "/m/"
    assert manifest["icons"], "an installable app needs at least one icon"


@pytest.mark.parametrize("size", [192, 512])
def test_manifest_icons_are_actually_on_disk(client, size: int) -> None:
    """A manifest pointing at a missing icon installs a blank square, and
    nothing anywhere reports it."""
    icon = MOBILE / f"icon-{size}.png"
    assert icon.is_file(), f"{icon.name} is missing"
    res = client.get(f"/assets/m/icon-{size}.png")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"


def test_manifest_only_promises_icons_it_has(client) -> None:
    manifest = json.loads(client.get("/m/manifest.webmanifest").text)
    for icon in manifest["icons"]:
        assert client.get(icon["src"]).status_code == 200, f"manifest points at a missing icon: {icon['src']}"


def test_the_shell_only_references_assets_that_exist(client) -> None:
    """The phone shell hardcodes /assets/... paths. static/ is mounted there,
    so a root-relative path (or a typo) 404s silently and the screen loads
    unstyled or dead."""
    html = client.get("/m/").text
    for ref in re.findall(r'(?:href|src)="(/assets/[^"]+)"', html):
        assert client.get(ref).status_code == 200, f"the phone shell references {ref}, which isn't served"


def test_the_shell_loads_the_desktops_tokens_and_its_own_layout(client) -> None:
    """The phone borrows styles.css for its theme tokens and fonts so Clayton's
    six themes can't drift between the two screens, then overrides layout in
    mobile.css. Order matters: mobile.css has to win."""
    html = client.get("/m/").text
    assert html.index("/assets/styles.css") < html.index("/assets/m/mobile.css")


# ------------------------------------------------- the address for the phone


def test_the_link_route_reports_a_reachable_address(client) -> None:
    """A phone can't use 127.0.0.1, and the shop PC has no name a phone could
    resolve, so the Updates screen prints the actual LAN address. Without it,
    setting a phone up means reading `ipconfig` in a Command Prompt."""
    body = client.get("/api/mobile/link").json()
    assert body["url"].endswith("/m/"), f"the link should open the phone app, got {body['url']!r}"
    assert not body["host"].startswith("127."), "a loopback address is no use to a phone"
    assert body["url"].startswith(f"http://{body['host']}:{body['port']}/")


def test_the_link_route_says_when_nothing_can_reach_this_pc(client) -> None:
    """With network mode off the server is bound to loopback, so the address is
    correct and still unreachable. The screen has to be able to say that --
    a URL that silently fails sends somebody hunting through their phone's
    Wi-Fi settings for a problem that is on this PC."""
    assert client.get("/api/mobile/link").json()["sharing"] is False


def test_sharing_follows_the_network_flag(tmp_path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.mobile import build_mobile_router

    flag = tmp_path / "network_mode.flag"
    app = FastAPI()
    app.include_router(build_mobile_router(STATIC, flag))
    with TestClient(app) as shared:
        assert shared.get("/api/mobile/link").json()["sharing"] is False
        flag.write_text("", encoding="utf-8")
        assert shared.get("/api/mobile/link").json()["sharing"] is True


def test_the_updates_screen_shows_the_phone_address(client) -> None:
    """The one place a non-technical user can find it. Held to index.html so a
    renamed id doesn't leave the card permanently showing a dash."""
    html = client.get("/").text
    assert 'id="updates-phone-url"' in html
    assert 'id="updates-phone-note"' in html
    page = (DESKTOP_JS / "updates-page.js").read_text(encoding="utf-8")
    assert "/api/mobile/link" in page, "the Updates screen should ask the server for the address"


# --------------------------------------------------------- the service worker


def test_the_service_worker_caches_nothing(client) -> None:
    """It exists so Android will offer to install the app, and for no other
    reason. A cache would leave a phone running last week's RECON against this
    week's database -- a bug nobody would think to look for, and one you'd have
    to talk somebody through Safari's settings to clear.

    `caches.delete` is allowed (it throws away anything an earlier version
    left behind); anything that *writes* a cache is not.
    """
    res = client.get("/m/sw.js")
    assert res.status_code == 200
    source = code_only(res.text)
    for writer in ("caches.open", "cache.put", "cache.add", "addAll", "cacheName"):
        assert writer not in source, f"the phone's service worker must not cache: found {writer}"
    assert "caches.delete" in source, "it should still clear anything an earlier version cached"


def test_the_service_worker_is_served_from_its_scope(client) -> None:
    """A worker under /assets/ could only ever control /assets/. Served from
    /m/ its default scope is /m/, which is the app."""
    assert client.get("/m/sw.js").status_code == 200
    assert "/m/sw.js" in (MOBILE_JS / "main.js").read_text(encoding="utf-8")


# ------------------------------------------------- pinned to the desktop app


def _function_source(text: str, name: str) -> str:
    """The text of a top-level `export function name(...) {...}`, braces
    balanced. Good enough because both files declare these the same way."""
    start = text.index(f"export function {name}(")
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise AssertionError(f"unbalanced braces reading {name}")


@pytest.mark.parametrize("name", ["money", "esc", "fmtDay", "relativeTime"])
def test_the_phone_formats_exactly_like_the_desk(name: str) -> None:
    """These four are copied into static/m/js/format.js rather than imported,
    because shortcuts.js drags in state.js and the whole dialog machinery and
    the phone shouldn't load that to print a dollar sign. Copies drift, so
    this compares the two texts.

    fmtDay is the one that really matters: it pulls a bare YYYY-MM-DD apart by
    hand instead of handing it to Date, because `new Date("2026-07-30")` is UTC
    midnight -- 7pm on the 29th in Indiana. A phone that lost that would print
    every promised date a day early.
    """
    desk = _function_source((DESKTOP_JS / "shortcuts.js").read_text(encoding="utf-8"), name)
    phone = _function_source((MOBILE_JS / "format.js").read_text(encoding="utf-8"), name)
    assert phone == desk, f"{name}() has drifted from the desktop's copy in shortcuts.js"


def test_the_phone_names_the_piles_the_way_the_board_does() -> None:
    """The four piles are the shop's shared vocabulary. If the phone says
    "Done" where the board says "Ready to go", two people looking at the same
    car describe it differently."""
    board = (DESKTOP_JS / "vehicles-board.js").read_text(encoding="utf-8")
    phone = (MOBILE_JS / "format.js").read_text(encoding="utf-8")
    for key, label, blank in [
        ("waiting", "Not started", "Nothing waiting to be started."),
        ("working", "In the shop", "Nothing in the shop right now."),
        ("ready", "Ready to go", "Nothing finished yet."),
        ("settled", "Finished — file away", "Nothing waiting to be filed."),
    ]:
        assert f'label: "{label}"' in board, f"the board no longer says {label!r} -- update the phone too"
        assert f'key: "{key}", label: "{label}", blank: "{blank}"' in phone, (
            f"the phone's {key} pile has drifted from the board's wording"
        )


def test_the_phone_prices_parts_with_the_shared_money_rules() -> None:
    """Recon work carries no markup, so `unit_cost` is the only price this app
    has and `unit_price` is a shared-schema leftover that is always 0. A phone
    reading unit_price shows every outstanding part as free. The rules live in
    estimate-money.js and the phone must import them rather than re-filter."""
    raw = (MOBILE_JS / "car.js").read_text(encoding="utf-8")
    # The import path is a string literal, which code_only() blanks -- so this
    # half is read raw and only the logic below goes through the stripper.
    assert "estimate-money.js" in raw, "the phone should use the shared money rules, not its own"
    car = code_only(raw)
    assert "unreceivedPartLines" in car, "which parts are still outstanding is estimate-money.js's answer"
    assert "unit_price" not in car, "unit_price is always 0 on recon work -- unit_cost is the price"


def test_the_phone_reuses_the_desktops_fetch_helper() -> None:
    """core.js attaches the actor to every write, so no call site can forget to
    record who did it. A phone with its own fetch would log work against "ui"."""
    for name in ("car.js", "lot.js", "tasks.js", "search.js", "shell.js"):
        source = code_only((MOBILE_JS / name).read_text(encoding="utf-8"))
        if "fetch(" in source:
            raise AssertionError(f"{name} calls fetch directly instead of going through core.js")
    assert "setActorSource" in (MOBILE_JS / "shell.js").read_text(encoding="utf-8"), (
        "the phone must tell core.js who is holding it"
    )


# --------------------------------------------------- the phone's own modules


def _mobile_module_paths() -> list[Path]:
    main = (MOBILE_JS / "main.js").read_text(encoding="utf-8")
    names = re.findall(r'"\./([-\w]+\.js)"', main)
    assert names, "the phone's main.js imports nothing -- has the entry point moved?"
    return [MOBILE_JS / name for name in names] + [MOBILE_JS / "main.js"]


def test_every_phone_module_is_reachable_from_its_entry_point() -> None:
    """Same rule static/js/ lives by: a module nobody imports is dead code that
    still looks live on disk. format.js is reached through the screens rather
    than from main.js, so it is named here explicitly."""
    listed = {p.name for p in _mobile_module_paths()} | {"format.js"}
    on_disk = {p.name for p in MOBILE_JS.glob("*.js")}
    assert on_disk - listed == set(), f"phone modules nothing imports: {sorted(on_disk - listed)}"
    assert listed - on_disk == set(), f"the phone imports files that don't exist: {sorted(listed - on_disk)}"


def test_every_listener_is_registered_from_a_wire_function() -> None:
    """The house rule the desktop follows: module bodies only *declare*, and
    every addEventListener lives in a wire* function that main.js calls. It is
    what makes "is this screen actually wired up?" answerable by reading one
    file -- a screen that quietly does nothing is otherwise indistinguishable
    from a screen with nothing to do.

    A listener registered at the top level of a module body sits at column 0,
    so that is what this looks for.
    """
    offenders = []
    for path in MOBILE_JS.glob("*.js"):
        if path.name == "main.js":
            continue
        source = code_only(path.read_text(encoding="utf-8"))
        wires = set(re.findall(r"export function (wire\w+)", source))
        for line in source.splitlines():
            if "addEventListener" in line and not line.startswith((" ", "\t")):
                offenders.append(f"{path.name}: {line.strip()}")
        if "addEventListener" in source and not wires:
            offenders.append(f"{path.name} registers listeners but exports no wire* function")
    assert not offenders, "listeners must be registered from a wire* function:\n" + "\n".join(offenders)


def test_main_calls_every_wire_function_the_screens_export() -> None:
    """A wire* nobody calls is a dead screen that still looks alive on disk."""
    main = code_only((MOBILE_JS / "main.js").read_text(encoding="utf-8"))
    missing = []
    for path in MOBILE_JS.glob("*.js"):
        if path.name == "main.js":
            continue
        source = code_only(path.read_text(encoding="utf-8"))
        for wire in re.findall(r"export function (wire\w+)", source):
            if f"{wire}()" not in main:
                missing.append(f"{path.name}::{wire}")
    assert not missing, f"main.js never calls: {sorted(missing)}"
