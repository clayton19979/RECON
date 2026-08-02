from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Literal

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

API_BASE = os.getenv("RECON_API_BASE", "http://127.0.0.1:8787").rstrip("/")
ACTOR = "ai:hermes"

# There was a TOOL_SPECS table here mirroring every tool's endpoint, and one
# test asserted against it that no tool targets the estimate-replace route.
# It was removed because it was a second copy of the truth that nothing else
# read: six tools were added without it, so the guard was quietly passing by
# checking a list that no longer described the server. The real check now
# reads the actual _request() call sites out of this module's AST -- see
# tests/test_mcp_server.py::test_no_tool_targets_the_estimate_replace_endpoint.


def _headers() -> dict[str, str]:
    key = os.getenv("API_DISCOUNT_AUTO_OPS_KEY", "").strip()
    return {"X-API-Key": key} if key else {}


async def _request(
    method: str,
    path: str,
    *,
    params: Mapping[str, Any] | None = None,
    json: Mapping[str, Any] | list[Any] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    try:
        async with httpx.AsyncClient(base_url=API_BASE if transport is None else "http://testserver", transport=transport, timeout=20) as client:
            response = await client.request(method, path, params=params, json=json, headers=_headers())
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            suffix = ""
            if response.status_code == 409:
                suffix = " Next step: re-read the record, then retry with the current version or corrected identifier."
            elif response.status_code == 422:
                suffix = " Next step: check the required fields and value ranges in the tool arguments."
            elif response.status_code == 503 and "PLATETOVIN_API_KEY" in str(detail):
                suffix = " Next step: set PLATETOVIN_API_KEY or send/enter the VIN instead of a plate."
            return f"RECON API error {response.status_code}: {detail}{suffix}"
        if not response.content:
            return {"ok": True}
        return response.json()
    except httpx.HTTPError as exc:
        return f"Could not reach RECON at {API_BASE}: {exc}"


def _vehicle_path(kind: Literal["recon", "we_owe", "retail"], id: int) -> str:
    if kind == "recon":
        return f"/api/recon/vehicles/{id}"
    if kind == "we_owe":
        return f"/api/we-owe/{id}"
    if kind == "retail":
        return f"/api/retail/vehicles/{id}"
    raise ValueError(f"Unsupported vehicle kind: {kind}")


def _vehicle_line(ticket: Mapping[str, Any]) -> str:
    vehicle = ticket.get("vehicle") or {}
    if not isinstance(vehicle, Mapping):
        return ""
    return " ".join(str(vehicle.get(field) or "").strip() for field in ("year", "make", "model") if vehicle.get(field)).strip()


def _trim_ticket(ticket: Mapping[str, Any]) -> dict[str, Any]:
    estimate = ticket.get("estimate") if isinstance(ticket.get("estimate"), Mapping) else None
    jobs: list[dict[str, Any]] = []
    parts: list[dict[str, Any]] = []
    total = 0.0
    if estimate:
        total = float(estimate.get("total") or 0)
        for job in estimate.get("jobs") or []:
            jobs.append({"id": job.get("id"), "title": job.get("title", ""), "done": bool(job.get("completed_at"))})
        for item in estimate.get("items") or []:
            if item.get("kind") == "part":
                parts.append(
                    {
                        "id": item.get("id"),
                        "description": item.get("description", ""),
                        "part_number": item.get("part_number", ""),
                        "status": item.get("status", ""),
                        "cost": float(item.get("unit_cost") or 0),
                    }
                )
    return {
        "id": ticket.get("id"),
        "number": ticket.get("number"),
        "segment": ticket.get("segment"),
        "status": ticket.get("status"),
        "voided": bool(ticket.get("voided")),
        "concern": ticket.get("concern", ""),
        "vehicle": _vehicle_line(ticket),
        "jobs": jobs,
        "parts": parts,
        "total": total,
    }


async def recon_search(query: str, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("GET", "/api/agent/search", params={"q": query}, transport=transport)


async def recon_get_vehicle(kind: Literal["recon", "we_owe", "retail"], id: int, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("GET", _vehicle_path(kind, id), transport=transport)


async def recon_get_ticket(order_id: int, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    body = await _request("GET", f"/api/orders/{order_id}", transport=transport)
    return body if isinstance(body, str) else _trim_ticket(body)


async def recon_board(segment: Literal["recon", "we_owe"] | None = None, archived: bool = False, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    params: dict[str, Any] = {"archived": archived}
    if segment:
        params["segment"] = segment
    return await _request("GET", "/api/vehicles-board", params=params, transport=transport)


async def recon_parts_on_order(transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("GET", "/api/parts/on-order", transport=transport)


async def recon_tasks(transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("GET", "/api/tasks", transport=transport)


async def recon_dashboard(transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("GET", "/api/dashboard", transport=transport)


async def recon_decode_vin(vin: str, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("POST", "/api/vehicles/decode-vin", json={"vin": vin}, transport=transport)


async def recon_decode_plate(
    plate: str, state: str, transport: httpx.AsyncBaseTransport | None = None
) -> Any:
    body = await _request("POST", "/api/vehicles/decode-plate", json={"plate": plate, "state": state}, transport=transport)
    # The plate provider is a paid third party and this shop may simply not
    # have a key. That is a configuration fact, not a failure of the request,
    # and "RECON API error 503" tells the advisor nothing they can act on --
    # they would re-send the same photo and get the same wall. Name the real
    # situation and the way around it, which is the VIN they can photograph.
    if isinstance(body, str) and "503" in body:
        return (
            "Plate decoding isn't set up -- it needs a PLATETOVIN_API_KEY from platetovin.com. "
            "Ask for a photo of the VIN instead (door jamb or dash) and use recon_decode_vin."
        )
    return body


async def recon_lookup_vehicle(
    stock_number: str = "", vin: str = "", transport: httpx.AsyncBaseTransport | None = None
) -> Any:
    return await _request(
        "GET", "/api/recon/vehicles/lookup", params={"stock_number": stock_number, "vin": vin}, transport=transport
    )


async def recon_intake(payload: Mapping[str, Any], transport: httpx.AsyncBaseTransport | None = None) -> Any:
    data = dict(payload)
    data.setdefault("actor", ACTOR)
    return await _request("POST", "/api/agent/intake", json=data, transport=transport)


async def recon_add_lines(
    order_id: int, lines: list[dict[str, Any]], transport: httpx.AsyncBaseTransport | None = None
) -> Any:
    return await _request(
        "POST",
        f"/api/orders/{order_id}/estimate/items",
        json={"items": lines, "actor": ACTOR, "source": "ai"},
        transport=transport,
    )


async def recon_set_status(order_id: int, status: str, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request(
        "PATCH", f"/api/orders/{order_id}/status", json={"status": status, "actor": ACTOR}, transport=transport
    )


async def recon_order_parts(order_id: int, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request(
        "PATCH", f"/api/orders/{order_id}/estimate/order-parts", json={"actor": ACTOR}, transport=transport
    )


async def recon_create_recon_vehicle(
    stock_number: str,
    year: int,
    make: str,
    model: str,
    vin: str = "",
    mileage: int = 0,
    color: str = "",
    acquisition_source: str = "",
    acquisition_date: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    return await _request(
        "POST",
        "/api/recon/vehicles",
        json={
            "stock_number": stock_number,
            "year": year,
            "make": make,
            "model": model,
            "vin": vin,
            "mileage": mileage,
            "color": color,
            "acquisition_source": acquisition_source,
            "acquisition_date": acquisition_date,
        },
        transport=transport,
    )


async def recon_create_ticket(
    segment: Literal["recon", "we_owe"],
    concern: str,
    recon_vehicle_id: int | None = None,
    we_owe_id: int | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    payload: dict[str, Any] = {"segment": segment, "concern": concern}
    if recon_vehicle_id is not None:
        payload["recon_vehicle_id"] = recon_vehicle_id
    if we_owe_id is not None:
        payload["we_owe_id"] = we_owe_id
    return await _request("POST", "/api/orders", json=payload, transport=transport)


async def recon_add_jobs(order_id: int, titles: list[str], transport: httpx.AsyncBaseTransport | None = None) -> Any:
    """Add jobs one at a time, reporting what landed and what didn't.

    There is no bulk jobs endpoint, so this is N requests and a failure part
    way through is a real, reachable state. Returning only the error -- which
    is what this used to do -- hid the jobs that had already been created, so
    the obvious next move was to retry the whole list and end up with the first
    few duplicated on the ticket. Both halves come back instead, and the caller
    can retry precisely the ones that failed.
    """
    created: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for title in titles:
        body = await _request(
            "POST", f"/api/orders/{order_id}/jobs", json={"title": title, "actor": ACTOR}, transport=transport
        )
        if isinstance(body, str):
            failed.append({"title": title, "error": body})
        else:
            created.append(body)
    result: dict[str, Any] = {"created": len(created), "jobs": created}
    if failed:
        result["failed"] = failed
        result["warning"] = (
            f"{len(created)} of {len(titles)} jobs were created. Retry ONLY the failed titles -- "
            "re-sending the whole list would duplicate the ones that succeeded."
        )
    return result


async def recon_complete_job(order_id: int, job_id: int, done: bool = True, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request(
        "PATCH", f"/api/orders/{order_id}/jobs/{job_id}/done", json={"done": done, "actor": ACTOR}, transport=transport
    )


async def recon_add_note(order_id: int, text: str, transport: httpx.AsyncBaseTransport | None = None) -> Any:
    return await _request("POST", f"/api/orders/{order_id}/notes", json={"text": text, "actor": ACTOR}, transport=transport)


async def recon_create_task(
    title: str,
    order_id: int | None = None,
    assigned_to: list[str] | None = None,
    due_date: str = "",
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    return await _request(
        "POST",
        "/api/tasks",
        json={"title": title, "order_id": order_id, "assigned_to": assigned_to or [], "due_date": due_date, "actor": ACTOR},
        transport=transport,
    )


async def recon_update_vehicle(
    id: int,
    vin: str | None = None,
    mileage: int | None = None,
    color: str | None = None,
    expected_version: int | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Any:
    payload = {k: v for k, v in {"vin": vin, "mileage": mileage, "color": color, "expected_version": expected_version}.items() if v is not None}
    return await _request("PATCH", f"/api/recon/vehicles/{id}", json=payload, transport=transport)


async def recon_post_vendor_invoice(invoice: dict[str, Any], transport: httpx.AsyncBaseTransport | None = None) -> Any:
    invoice = dict(invoice)
    invoice.setdefault("source", ACTOR)
    return await _request("POST", "/api/agent/invoices/process", json=invoice, transport=transport)



def _writes_enabled() -> bool:
    return os.getenv("RECON_MCP_ENABLE_WRITES", "").strip() == "1"


def build_mcp(*, enable_writes: bool | None = None, streamable_http_path: str = "/mcp") -> FastMCP:
    """Build the RECON MCP tool registry.

    Write tools are absent unless RECON_MCP_ENABLE_WRITES=1, so a frozen app
    mounted on the LAN never advertises mutations by accident.
    """
    server = FastMCP(
        "RECON",
        streamable_http_path=streamable_http_path,
        # RECON's TrustedHostMiddleware owns host validation for the whole app.
        # The mounted MCP app has to accept the same LAN hostnames/IPs when the
        # tray's network mode is on, plus testserver in TestClient.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    include_writes = _writes_enabled() if enable_writes is None else enable_writes

    @server.tool(name="recon_search")
    async def _tool_recon_search(query: str) -> Any:
        """Search RECON by stock number, VIN, plate, customer, or vehicle text.

        Use this before asking for IDs. Returns compact candidates with kind,
        id, order_id, label, stock number/VIN/plate, status, and vehicle fields.
        """
        return await recon_search(query)

    @server.tool(name="recon_get_vehicle")
    async def _tool_recon_get_vehicle(kind: Literal["recon", "we_owe", "retail"], id: int) -> Any:
        """Get full detail for one vehicle/promise record by stable ID.

        kind is the RECON segment: recon lot car, we_owe promise, or retail
        vehicle. Use recon_search first when you do not already have the ID.
        """
        return await recon_get_vehicle(kind, id)

    @server.tool(name="recon_get_ticket")
    async def _tool_recon_get_ticket(order_id: int) -> Any:
        """Get a chat-sized repair order summary by order ID.

        Returns RO number, segment/status, concern, vehicle line, open jobs,
        parts, and total. Use recon_search/recon_board to find order_id first.
        """
        return await recon_get_ticket(order_id)

    @server.tool(name="recon_board")
    async def _tool_recon_board(segment: Literal["recon", "we_owe"] | None = None, archived: bool = False) -> Any:
        """List the current vehicle board.

        Optionally filter to recon or we_owe. Returns each unit's status, open
        jobs, parts pending, costs, idle/age, and what it still needs.
        """
        return await recon_board(segment, archived)

    @server.tool(name="recon_parts_on_order")
    async def _tool_recon_parts_on_order() -> Any:
        """List parts that are ordered/not fully received yet.

        Use for "what are we waiting on parts for" questions. Returns part,
        RO/vehicle context, quantity/cost, and receiving state.
        """
        return await recon_parts_on_order()

    @server.tool(name="recon_tasks")
    async def _tool_recon_tasks() -> Any:
        """List open RECON tasks and reminders."""
        return await recon_tasks()

    @server.tool(name="recon_dashboard")
    async def _tool_recon_dashboard() -> Any:
        """Return high-level open counts and cost totals for recon and we-owe."""
        return await recon_dashboard()

    @server.tool(name="recon_decode_vin")
    async def _tool_recon_decode_vin(vin: str) -> Any:
        """Decode a VIN into year, make, model, trim, engine, and color.

        Use this for VIN intake. Do not invent decoded fields; if decode fails,
        ask for a clearer VIN or have the user enter the fields manually.
        """
        return await recon_decode_vin(vin)

    @server.tool(name="recon_decode_plate")
    async def _tool_recon_decode_plate(plate: str, state: str) -> Any:
        """Decode a licence plate + 2-letter state into a VIN and vehicle.

        Needs a paid provider key, which may not be configured -- if it isn't,
        this says so and you should ask for a VIN photo instead. Never invent
        a VIN or vehicle from a plate.
        """
        return await recon_decode_plate(plate, state)

    @server.tool(name="recon_lookup_vehicle")
    async def _tool_recon_lookup_vehicle(stock_number: str = "", vin: str = "") -> Any:
        """Check whether a stock number or VIN is already on the board.

        Call this BEFORE creating a car. A live match means it is already here
        and you must stop and say which one. An ARCHIVED vin match is normal
        and does not block intake -- the lot buys cars back, and a second recon
        episode on one VIN is expected.
        """
        return await recon_lookup_vehicle(stock_number, vin)

    if include_writes:
        @server.tool(name="recon_intake")
        async def _tool_recon_intake(
            stock_number: str,
            year: int,
            make: str,
            model: str,
            vin: str = "",
            trim: str = "",
            engine: str = "",
            color: str = "",
            mileage: int = 0,
            concern: str = "",
            jobs: list[str] | None = None,
        ) -> Any:
            """Put a new lot car on the board: vehicle + repair order + jobs, atomically.

            The preferred way to handle "new car in". Everything succeeds or
            nothing does, so a failure never leaves a car with no ticket.

            Get year/make/model from recon_decode_vin first -- never guess them.
            stock_number is the real windshield/lot number and is required; if
            you do not have it, ask, never invent one. Omit concern to record a
            car that has arrived with no work written against it yet.

            Prices are not accepted here on purpose: recon is billed at shop
            cost and costs arrive with the vendor invoice.
            """
            payload: dict[str, Any] = {
                "stock_number": stock_number,
                "year": year,
                "make": make,
                "model": model,
                "vin": vin,
                "trim": trim,
                "engine": engine,
                "color": color,
                "mileage": mileage,
                "concern": concern,
                "jobs": [{"title": t} for t in (jobs or [])],
            }
            return await recon_intake(payload)

        @server.tool(name="recon_add_lines")
        async def _tool_recon_add_lines(order_id: int, lines: list[dict[str, Any]]) -> Any:
            """Add parts/labor/fee lines to an existing repair order.

            APPENDS -- it never removes or overwrites lines already on the
            ticket, so it is safe to call without knowing what is there.

            Each line: {"kind": "part"|"labor"|"fee", "description": str,
            "quantity": float, "unit_cost": float, "unit_price": float,
            "part_number": str, "job_id": int|null}.

            Recon and we-owe are billed at the shop's cost with NO markup and
            labor at zero. Never invent a price or a part number: leave them at
            0 and blank, and the real cost lands when the vendor invoice is
            received. A part with no number is normal here -- this shop runs on
            used and junkyard parts.
            """
            return await recon_add_lines(order_id, lines)

        @server.tool(name="recon_set_status")
        async def _tool_recon_set_status(
            order_id: int, status: Literal["estimate", "pending_approval", "in_progress", "complete"]
        ) -> Any:
            """Move a repair order to a new status. Use 'complete' when the car is done."""
            return await recon_set_status(order_id, status)

        @server.tool(name="recon_order_parts")
        async def _tool_recon_order_parts(order_id: int) -> Any:
            """Mark every quoted part on this RO as ordered, stamping the order date.

            This is what makes "how long have we been waiting on this part"
            answerable. Safe to re-run: parts already on order keep their
            original date.
            """
            return await recon_order_parts(order_id)

        @server.tool(name="recon_create_recon_vehicle")
        async def _tool_recon_create_recon_vehicle(
            stock_number: str, year: int, make: str, model: str, vin: str = "", mileage: int = 0, color: str = ""
        ) -> Any:
            """Create a new recon lot vehicle record.

            stock_number is the windshield/lot stock number and must be real;
            never invent one. Recon/we-owe are billed at shop cost only: never
            invent prices, part numbers, or labor charges.
            """
            return await recon_create_recon_vehicle(stock_number, year, make, model, vin, mileage, color)

        @server.tool(name="recon_create_ticket")
        async def _tool_recon_create_ticket(
            segment: Literal["recon", "we_owe"], concern: str, recon_vehicle_id: int | None = None, we_owe_id: int | None = None
        ) -> Any:
            """Create a repair order for an existing recon vehicle or we-owe.

            Use real IDs found by search/board. concern should be what the user
            said to check/fix; do not add invented work or prices.
            """
            return await recon_create_ticket(segment, concern, recon_vehicle_id, we_owe_id)

        @server.tool(name="recon_add_jobs")
        async def _tool_recon_add_jobs(order_id: int, titles: list[str]) -> Any:
            """Add job headings to an RO by title.

            Use only jobs the user requested or the shop documented. Do not add
            prices or parts here; recon/we-owe costs are parts-at-cost only.
            """
            return await recon_add_jobs(order_id, titles)

        @server.tool(name="recon_complete_job")
        async def _tool_recon_complete_job(order_id: int, job_id: int, done: bool = True) -> Any:
            """Mark an existing job done/undone on an RO. Use exact job IDs."""
            return await recon_complete_job(order_id, job_id, done)

        @server.tool(name="recon_add_note")
        async def _tool_recon_add_note(order_id: int, text: str) -> Any:
            """Add an internal note to an RO. Attribute is ai:hermes."""
            return await recon_add_note(order_id, text)

        @server.tool(name="recon_create_task")
        async def _tool_recon_create_task(title: str, order_id: int | None = None, assigned_to: list[str] | None = None, due_date: str = "") -> Any:
            """Create a reminder/task, optionally tied to an RO."""
            return await recon_create_task(title, order_id, assigned_to, due_date)

        @server.tool(name="recon_update_vehicle")
        async def _tool_recon_update_vehicle(
            id: int, vin: str | None = None, mileage: int | None = None, color: str | None = None, expected_version: int | None = None
        ) -> Any:
            """Patch editable recon vehicle facts with optimistic locking.

            Use expected_version from the latest vehicle detail when available.
            If stale, re-read before retrying. Never guess VIN/mileage/color.
            """
            return await recon_update_vehicle(id, vin, mileage, color, expected_version)

        @server.tool(name="recon_post_vendor_invoice")
        async def _tool_recon_post_vendor_invoice(invoice: dict[str, Any]) -> Any:
            """Post a vendor invoice through RECON's accounting API.

            Use only real invoice data. RECON checks duplicates and arithmetic;
            on review_required, report the issue instead of retrying blindly.
            """
            return await recon_post_vendor_invoice(invoice)

    return server


mcp = build_mcp()


class ApiKeyASGIWrapper:
    """Require X-API-Key for mounted MCP when API_DISCOUNT_AUTO_OPS_KEY is set."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        key = os.getenv("API_DISCOUNT_AUTO_OPS_KEY", "").strip()
        if key:
            headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope.get("headers", [])}
            provided = headers.get("x-api-key", "").strip()
            if not provided:
                await JSONResponse({"detail": "Missing X-API-Key header"}, status_code=401)(scope, receive, send)
                return
            if provided != key:
                await JSONResponse({"detail": "Invalid API key"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class ReconMCPHTTPApp:
    """Mounted ASGI app plus lifespan hook for FastMCP's session manager."""

    def __init__(self) -> None:
        self.server = build_mcp(streamable_http_path="/")
        self.asgi = ApiKeyASGIWrapper(self.server.streamable_http_app())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.asgi(scope, receive, send)

    def lifespan(self) -> Any:
        return self.server.session_manager.run()


def mcp_http_app() -> ReconMCPHTTPApp:
    """Return the mounted HTTP MCP ASGI app for RECON.exe."""
    # Mounted at /mcp in app.main; inside the mount, expose the MCP endpoint at /.
    return ReconMCPHTTPApp()


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
