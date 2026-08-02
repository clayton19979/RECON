from __future__ import annotations

import ast
import asyncio
import pathlib
import re

import httpx

from app import mcp_server
from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


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
