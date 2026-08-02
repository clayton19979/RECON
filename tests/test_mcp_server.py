from __future__ import annotations

import ast
import asyncio
import pathlib
import re
import sqlite3

import httpx
from starlette.routing import Mount

from app import mcp_server
from app.main import create_app
from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def mcp_mount_of(app) -> mcp_server.ReconMCPHTTPApp:
    """The ReconMCPHTTPApp that `app` mounts at /mcp."""
    mount = next(route.app for route in app.routes if isinstance(route, Mount) and route.path == "/mcp")
    assert isinstance(mount, mcp_server.ReconMCPHTTPApp)
    return mount


def stock_numbers(db_path) -> list[str]:
    """Read the database file directly, so the assertion cannot be satisfied by
    the same app that might have been written to by mistake."""
    with sqlite3.connect(db_path) as db:
        return [row[0] for row in db.execute("SELECT stock_number FROM recon_vehicles ORDER BY stock_number")]


def test_recon_search_tool_uses_agent_search_endpoint(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    transport = httpx.ASGITransport(app=client.app)

    body = asyncio.run(mcp_server.recon_search("r1042", transport=transport))

    assert any(row["kind"] == "recon" and row["id"] == vehicle["id"] for row in body)


def test_recon_get_ticket_returns_chat_sized_summary(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1042", year=2014, make="Chevrolet", model="Malibu")
    order = make_recon_order(client, vehicle["id"], concern="Battery light on")
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Charging system test"}).json()
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Battery", "part_number": "BAT-650", "quantity": 1, "unit_price": 120, "unit_cost": 120}],
    )
    transport = httpx.ASGITransport(app=client.app)

    body = asyncio.run(mcp_server.recon_get_ticket(order["id"], transport=transport))

    assert body["number"] == order["number"]
    assert body["vehicle"] == "2014 Chevrolet Malibu"
    assert body["concern"] == "Battery light on"
    assert body["jobs"] == [{"id": job["id"], "title": "Charging system test", "done": False}]
    assert body["parts"] == [
        {"id": body["parts"][0]["id"], "description": "Battery", "part_number": "BAT-650", "status": "quoted", "cost": 120.0}
    ]
    assert body["total"] == 120.0
    assert "activity" not in body


def _requested_paths() -> list[str]:
    """Every API path this module asks _request() for, read from its own source.

    Read from the AST rather than from a hand-maintained table, because the
    hand-maintained table is exactly what failed: it listed sixteen tools while
    the module had twenty-two, so the guard below was passing against a
    description of a server that no longer existed. f-string paths collapse to
    a '{}' placeholder so f"/api/orders/{order_id}/estimate" is comparable to
    the literal route it would hit.
    """
    source = pathlib.Path(mcp_server.__file__).read_text(encoding="utf-8")
    paths: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_request"):
            continue
        if len(node.args) < 2:
            continue
        target = node.args[1]
        if isinstance(target, ast.Constant) and isinstance(target.value, str):
            paths.append(target.value)
        elif isinstance(target, ast.JoinedStr):
            paths.append(
                "".join(
                    part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "{}"
                    for part in target.values
                )
            )
    return paths


def test_no_tool_targets_the_estimate_replace_endpoint():
    """POST /api/orders/{id}/estimate replaces the whole line-item set: any
    line not in the payload that hasn't been received is deleted. An agent
    building that payload from a partial view silently destroys an advisor's
    work, and there is no safe way to expose it. Additive line writes go
    through POST /api/orders/{id}/estimate/items instead."""
    offenders = [path for path in _requested_paths() if re.fullmatch(r"/api/orders/\{\}/estimate/?", path)]

    assert offenders == [], f"MCP tool targets the destructive estimate-replace route: {offenders}"


def test_the_guard_above_can_actually_see_request_paths():
    """A guard that silently matched nothing would pass forever. This is what
    the previous stale-table version of it lacked."""
    paths = _requested_paths()

    assert "/api/agent/search" in paths
    assert "/api/orders/{}/estimate/items" in paths


def test_write_tools_are_absent_by_default(monkeypatch):
    monkeypatch.delenv("RECON_MCP_ENABLE_WRITES", raising=False)

    server = mcp_server.build_mcp()

    assert "recon_search" in server._tool_manager._tools
    assert "recon_create_ticket" not in server._tool_manager._tools


def test_write_tools_register_when_explicitly_enabled():
    server = mcp_server.build_mcp(enable_writes=True)

    assert "recon_create_ticket" in server._tool_manager._tools


def test_mounted_mcp_requires_api_key_when_configured(client, monkeypatch):
    monkeypatch.setenv("API_DISCOUNT_AUTO_OPS_KEY", "secret")

    response = client.get("/mcp/", headers={"accept": "text/event-stream"})

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing X-API-Key header"


def test_stale_expected_version_returns_clear_message(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    transport = httpx.ASGITransport(app=client.app)

    body = asyncio.run(
        mcp_server.recon_update_vehicle(vehicle["id"], mileage=12345, expected_version=0, transport=transport)
    )

    assert isinstance(body, str)
    assert "Someone else changed this vehicle" in body
    assert "Traceback" not in body


def test_add_jobs_reports_what_landed_when_one_fails(client, monkeypatch):
    """N separate POSTs means partial failure is reachable. Returning only the
    error hid the jobs already created, so the natural retry duplicated them."""
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    order = make_recon_order(client, vehicle["id"])
    transport = httpx.ASGITransport(app=client.app)

    real = mcp_server._request
    calls = {"n": 0}

    async def flaky(method, path, **kwargs):
        if path.endswith("/jobs"):
            calls["n"] += 1
            if calls["n"] == 2:
                return "RECON API error 500: boom"
        return await real(method, path, **kwargs)

    monkeypatch.setattr(mcp_server, "_request", flaky)
    body = asyncio.run(mcp_server.recon_add_jobs(order["id"], ["Front brakes", "Tie rod", "Oil change"], transport=transport))

    assert body["created"] == 2
    assert [job["title"] for job in body["failed"]] == ["Tie rod"]
    assert "Retry ONLY the failed" in body["warning"]


def test_add_lines_appends_without_replacing(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1042")
    order = make_recon_order(client, vehicle["id"])
    save_estimate(client, order["id"], [{"kind": "part", "description": "Rotors", "quantity": 2, "unit_price": 41.5, "unit_cost": 41.5}])
    transport = httpx.ASGITransport(app=client.app)

    body = asyncio.run(
        mcp_server.recon_add_lines(
            order["id"], [{"kind": "part", "description": "Pads", "quantity": 1, "unit_cost": 28.0, "unit_price": 28.0}], transport=transport
        )
    )

    assert body["total"] == 111.0
    items = client.get(f"/api/orders/{order['id']}").json()["estimate"]["items"]
    assert [item["description"] for item in items] == ["Rotors", "Pads"]


def test_decode_plate_explains_itself_when_no_provider_key_is_configured(client, monkeypatch):
    """A bare "RECON API error 503" tells the advisor nothing to act on -- they
    would re-send the same photo. Name the situation and the way around it."""
    monkeypatch.delenv("PLATETOVIN_API_KEY", raising=False)
    transport = httpx.ASGITransport(app=client.app)

    body = asyncio.run(mcp_server.recon_decode_plate("ABC1234", "IN", transport=transport))

    assert isinstance(body, str)
    assert "PLATETOVIN_API_KEY" in body
    assert "recon_decode_vin" in body


def test_read_tools_are_available_without_writes_enabled():
    server = mcp_server.build_mcp(enable_writes=False)
    names = set(server._tool_manager._tools)

    assert {"recon_search", "recon_lookup_vehicle", "recon_decode_plate"} <= names
    # Lookup is a read, but it is the duplicate check intake depends on -- it
    # has to be reachable before writes are ever turned on.
    assert not any(name in names for name in ("recon_intake", "recon_add_lines", "recon_set_status"))


def test_write_tools_appear_only_when_enabled():
    server = mcp_server.build_mcp(enable_writes=True)
    names = set(server._tool_manager._tools)

    assert {"recon_intake", "recon_add_lines", "recon_set_status", "recon_order_parts"} <= names


def test_mounted_tools_reach_their_own_app_not_recon_api_base(tmp_path, monkeypatch):
    """RECON_API_BASE is not consulted by a mounted server at all.

    It used to be, and its default was 127.0.0.1:8787 whoever was hosting the
    mount. Pointing it at a port nothing listens on proves the tool never goes
    near it: if the loopback path were still live this would come back as a
    "Could not reach RECON" string instead of a created vehicle.
    """
    monkeypatch.setenv("RECON_MCP_ENABLE_WRITES", "1")
    monkeypatch.setenv("RECON_API_BASE", "http://127.0.0.1:1")
    app = create_app(tmp_path / "own.db", backups_dir=tmp_path / "backups")

    asyncio.run(
        mcp_mount_of(app).server.call_tool(
            "recon_create_recon_vehicle",
            {"stock_number": "R-9001", "year": 2015, "make": "Ford", "model": "Fusion"},
        )
    )

    assert stock_numbers(tmp_path / "own.db") == ["R-9001"]


def test_a_second_instances_tools_do_not_write_to_the_first_ones_database(tmp_path, monkeypatch):
    """The bug this fixes, stated as the shop hit it.

    A dev server on port 8899 issued writes against production, because every
    mount's tools resolved to the same default base URL regardless of which app
    they belonged to. It did no damage only because production happened to be
    running a pre-MCP build that answered 404. Two apps in one process is the
    honest form of that: each mount must reach its own database and no other.
    """
    monkeypatch.setenv("RECON_MCP_ENABLE_WRITES", "1")
    production_db, dev_db = tmp_path / "production.db", tmp_path / "dev.db"
    production = create_app(production_db, backups_dir=tmp_path / "production-backups")
    dev = create_app(dev_db, backups_dir=tmp_path / "dev-backups")

    asyncio.run(
        mcp_mount_of(dev).server.call_tool(
            "recon_create_recon_vehicle",
            {"stock_number": "DEV-1", "year": 2015, "make": "Ford", "model": "Fusion"},
        )
    )
    asyncio.run(
        mcp_mount_of(production).server.call_tool(
            "recon_create_recon_vehicle",
            {"stock_number": "PROD-1", "year": 2016, "make": "Chevrolet", "model": "Malibu"},
        )
    )

    assert stock_numbers(dev_db) == ["DEV-1"]
    assert stock_numbers(production_db) == ["PROD-1"]


def test_api_base_is_read_per_call_rather_than_at_import(monkeypatch):
    """It was a module constant, so a launcher that set RECON_API_BASE after
    the first import of this module was silently ignored."""
    monkeypatch.setenv("RECON_API_BASE", "http://192.168.1.50:8787/")

    assert mcp_server._api_base() == "http://192.168.1.50:8787"


def test_a_standalone_server_still_falls_back_to_api_base(monkeypatch):
    """`python -m app.mcp_server` has no app to call, so the URL path has to
    keep working -- and has to name the address it could not reach."""
    monkeypatch.setenv("RECON_API_BASE", "http://127.0.0.1:1")

    body = asyncio.run(mcp_server.recon_search("anything"))

    assert isinstance(body, str)
    assert "Could not reach RECON at http://127.0.0.1:1" in body
