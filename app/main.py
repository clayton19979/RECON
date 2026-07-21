from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .accounting import build_accounting_router
from .db import RECON_SHOP_CUSTOMER_ID, connect as db_connect, init_db, now
from .parts import build_parts_router
from .recon import build_recon_router, vehicle_board_rows
from .reports import build_reports_router
from .workflow import (
    assert_estimate_editable,
    build_workflow_router,
    initialize_order_workflow,
    workflow_detail,
)


def _bundle_root() -> Path:
    """Where bundled read-only assets (static/) live. A PyInstaller onefile
    build extracts into a temp dir given by sys._MEIPASS; running from
    source uses the repo root."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent


def _data_root() -> Path:
    """Where the database/backups live -- must be a stable, writable
    location that survives restarts, never the PyInstaller extraction
    temp dir, which is deleted when the process exits."""
    if getattr(sys, "frozen", False):
        base = os.getenv("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "DiscountAutoOps"
    return Path(__file__).resolve().parent.parent


ROOT = _bundle_root()
DATA_ROOT = _data_root()
DEFAULT_DB = Path(os.getenv("DISCOUNT_AUTO_OPS_DB", DATA_ROOT / "data" / "shop.db"))
PARTSTECH_LOGIN_URL = os.getenv("PARTSTECH_LOGIN_URL", "https://app.partstech.com/login")


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str = ""
    email: str = ""


class VehicleIn(BaseModel):
    customer_id: int
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    mileage: int = Field(default=0, ge=0)
    plate: str = ""
    plate_state: str = ""
    trim: str = ""
    engine: str = ""
    color: str = ""


class PlateDecodeIn(BaseModel):
    plate: str = Field(min_length=2, max_length=12)
    state: str = Field(min_length=2, max_length=2)


class VinDecodeIn(BaseModel):
    vin: str = Field(min_length=5, max_length=17)


class PartsTechCredentialsIn(BaseModel):
    username: str = ""
    api_key: str = ""


class OrderIn(BaseModel):
    customer_id: int | None = None
    vehicle_id: int | None = None
    concern: str = Field(min_length=3)
    segment: Literal["retail", "recon", "we_owe"] = "recon"
    recon_vehicle_id: int | None = None
    we_owe_id: int | None = None


class EstimateItem(BaseModel):
    id: int | None = None
    kind: Literal["part", "labor", "fee"]
    description: str = Field(min_length=1)
    quantity: float = Field(gt=0)
    unit_price: float = Field(ge=0)
    part_number: str = ""
    unit_cost: float = Field(default=0, ge=0)
    source: Literal["manual", "partstech", "technician_finding"] = "manual"


class EstimateIn(BaseModel):
    labor_rate: float = Field(default=0, ge=0)
    tax_rate: float = Field(default=0, ge=0, le=1)
    actor: str = Field(default="ui", min_length=1, max_length=120)
    items: list[EstimateItem]
    expected_version: int | None = None


def rowdict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


NETWORK_FLAG = DATA_ROOT / "network_mode.flag"


def create_app(db_path: Path = DEFAULT_DB) -> FastAPI:
    init_db(db_path)
    app = FastAPI(title="Discount Auto Ops", version="0.1.0")
    # Single-PC mode only trusts localhost. Network mode (toggled from the
    # tray icon so other PCs can reach this one) needs to accept requests
    # addressed to this machine's LAN IP/hostname instead -- there's no way
    # to know that address in advance, so trust any Host header while it's
    # on. This machine is still only reachable from inside the LAN unless
    # the router is explicitly configured to forward the port.
    default_hosts = "*" if NETWORK_FLAG.is_file() else "127.0.0.1,localhost,testserver"
    allowed_hosts = [h.strip() for h in os.getenv("DISCOUNT_AUTO_OPS_ALLOWED_HOSTS", default_hosts).split(",") if h.strip()]
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        response.headers["Cache-Control"] = "no-store"
        return response

    def connect() -> sqlite3.Connection:
        return db_connect(db_path)

    app.include_router(build_accounting_router(connect, now))
    app.include_router(build_workflow_router(connect, now))
    app.include_router(build_recon_router(connect, now))
    app.include_router(build_parts_router(connect, now))
    app.include_router(build_reports_router(connect, now))

    @app.get("/api/health")
    def health():
        return {"app": "ok"}

    @app.get("/api/dashboard")
    def dashboard():
        with connect() as db:
            customers_count = db.execute("SELECT count(*) FROM customers WHERE is_shop_owned=0").fetchone()[0]
            vehicles_count = db.execute("SELECT count(*) FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE c.is_shop_owned=0").fetchone()[0]
            open_orders = db.execute("SELECT count(*) FROM orders WHERE status NOT IN ('completed','cancelled')").fetchone()[0]
            board = vehicle_board_rows(db)
            recon_open = [r for r in board if r["segment"] == "recon" and r["status_bucket"] == "in_progress"]
            we_owe_open = [r for r in board if r["segment"] == "we_owe" and r["status_bucket"] == "in_progress"]
            return {
                "open_orders": open_orders,
                "customers": customers_count,
                "vehicles": vehicles_count,
                "recon_open": len(recon_open),
                "recon_actual_open": round(sum(r["actual_cost"] for r in recon_open), 2),
                "recon_quoted_open": round(sum(r["quoted_cost"] for r in recon_open), 2),
                "we_owe_open": len(we_owe_open),
                "we_owe_actual_open": round(sum(r["actual_cost"] for r in we_owe_open), 2),
                "we_owe_quoted_open": round(sum(r["quoted_cost"] for r in we_owe_open), 2),
            }

    @app.get("/api/customers")
    def list_customers():
        with connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM customers WHERE is_shop_owned=0 ORDER BY id DESC")]

    @app.post("/api/customers", status_code=201)
    def create_customer(item: CustomerIn):
        with connect() as db:
            cur = db.execute("INSERT INTO customers(name,phone,email,created_at) VALUES(?,?,?,?)", (item.name.strip(), item.phone.strip(), item.email.strip(), now()))
            return rowdict(db.execute("SELECT * FROM customers WHERE id=?", (cur.lastrowid,)).fetchone())

    @app.get("/api/vehicles")
    def list_vehicles():
        with connect() as db:
            rows = db.execute("SELECT v.*, c.name customer_name FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE c.is_shop_owned=0 ORDER BY v.id DESC")
            return [dict(row) for row in rows]

    @app.post("/api/vehicles", status_code=201)
    def create_vehicle(item: VehicleIn):
        with connect() as db:
            if not db.execute("SELECT 1 FROM customers WHERE id=?", (item.customer_id,)).fetchone():
                raise HTTPException(404, "Customer not found")
            cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,plate,plate_state,trim,engine,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (item.customer_id, item.year, item.make.strip(), item.model.strip(), item.vin.strip().upper(), item.mileage, item.plate.replace(" ", "").upper(), item.plate_state.strip().upper(), item.trim.strip(), item.engine.strip(), item.color.strip(), now()),
            )
            return rowdict(db.execute("SELECT * FROM vehicles WHERE id=?", (cur.lastrowid,)).fetchone())

    @app.post("/api/vehicles/decode-plate")
    def decode_plate(item: PlateDecodeIn):
        api_key = os.getenv("PLATETOVIN_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(503, "Plate decoding requires PLATETOVIN_API_KEY")
        plate = "".join(item.plate.split()).upper()
        state = item.state.strip().upper()
        try:
            response = httpx.post(
                "https://platetovin.com/api/convert",
                headers={"Authorization": api_key, "Content-Type": "application/json", "Accept": "application/json"},
                json={"plate": plate, "state": state},
                timeout=20,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, "Plate lookup provider is unavailable") from exc
        data = response.json()
        vehicle = data.get("vin") if data.get("success") else None
        if not isinstance(vehicle, dict) or not vehicle.get("vin"):
            raise HTTPException(404, "No vehicle matched that plate and state")
        color = vehicle.get("color", "")
        return {
            "plate": plate, "state": state, "vin": str(vehicle["vin"]).upper(), "year": int(vehicle["year"]),
            "make": vehicle.get("make", ""), "model": vehicle.get("model", ""), "trim": vehicle.get("trim", ""),
            "engine": vehicle.get("engine", ""), "color": color.get("name", "") if isinstance(color, dict) else color,
        }

    @app.post("/api/vehicles/decode-vin")
    def decode_vin(item: VinDecodeIn):
        vin = "".join(item.vin.split()).upper()
        try:
            response = httpx.get(
                f"https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/{vin}",
                params={"format": "json"}, timeout=20,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, "VIN decode provider is unavailable") from exc
        results = (response.json().get("Results") or [{}])[0]
        year = (results.get("ModelYear") or "").strip()
        make = (results.get("Make") or "").strip()
        model = (results.get("Model") or "").strip()
        if not year or not make or not model:
            raise HTTPException(404, "No vehicle matched that VIN")
        displacement = (results.get("DisplacementL") or "").strip()
        try:
            displacement = f"{float(displacement):.1f}"
        except ValueError:
            pass
        cylinders = (results.get("EngineCylinders") or "").strip()
        engine = " ".join(filter(None, [f"{displacement}L" if displacement else "", f"{cylinders}-cyl" if cylinders else ""]))
        return {
            "vin": vin, "year": int(year), "make": make, "model": model,
            "trim": (results.get("Trim") or "").strip(), "engine": engine, "color": "",
        }

    @app.get("/api/orders")
    def list_orders(segment: str | None = None):
        query = """SELECT o.*, c.name customer_name, v.year, v.make, v.model, v.mileage,
                   e.total estimate_total, e.status estimate_status, rv.stock_number
                   FROM orders o JOIN customers c ON c.id=o.customer_id JOIN vehicles v ON v.id=o.vehicle_id
                   LEFT JOIN estimates e ON e.order_id=o.id
                   LEFT JOIN recon_vehicles rv ON rv.id=o.recon_vehicle_id
                   WHERE (:segment IS NULL OR o.segment=:segment)
                   ORDER BY o.id DESC"""
        with connect() as db:
            return [dict(row) for row in db.execute(query, {"segment": segment})]

    @app.get("/api/orders/{order_id}")
    def get_order(order_id: int):
        with connect() as db:
            order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
            if not order:
                raise HTTPException(404, "Repair order not found")
            customer = db.execute("SELECT * FROM customers WHERE id=?", (order["customer_id"],)).fetchone()
            vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (order["vehicle_id"],)).fetchone()
            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            detail = dict(order)
            detail["customer"] = dict(customer)
            detail["vehicle"] = dict(vehicle)
            detail["estimate"] = None
            if estimate:
                detail["estimate"] = dict(estimate)
                detail["estimate"]["items"] = [dict(row) for row in db.execute("SELECT * FROM estimate_items WHERE estimate_id=? ORDER BY id", (estimate["id"],))]
            detail.update(workflow_detail(db, order_id))
            recon_vehicle = db.execute("SELECT * FROM recon_vehicles WHERE id=?", (order["recon_vehicle_id"],)).fetchone() if order["recon_vehicle_id"] else None
            detail["recon_vehicle"] = dict(recon_vehicle) if recon_vehicle else None
            we_owe_item = db.execute("SELECT * FROM we_owe_items WHERE id=?", (order["we_owe_id"],)).fetchone() if order["we_owe_id"] else None
            detail["we_owe_item"] = dict(we_owe_item) if we_owe_item else None
            return detail

    @app.post("/api/orders", status_code=201)
    def create_order(item: OrderIn):
        with connect() as db:
            if item.segment == "recon":
                recon_vehicle = db.execute("SELECT vehicle_id FROM recon_vehicles WHERE id=?", (item.recon_vehicle_id,)).fetchone() if item.recon_vehicle_id else None
                if not recon_vehicle:
                    raise HTTPException(404, "Recon vehicle not found")
                customer_id, vehicle_id = RECON_SHOP_CUSTOMER_ID, recon_vehicle["vehicle_id"]
            elif item.segment == "we_owe":
                we_owe_item = db.execute("SELECT customer_id, vehicle_id FROM we_owe_items WHERE id=?", (item.we_owe_id,)).fetchone() if item.we_owe_id else None
                if not we_owe_item:
                    raise HTTPException(404, "We-owe item not found")
                customer_id, vehicle_id = we_owe_item["customer_id"], we_owe_item["vehicle_id"]
            else:
                if item.customer_id is None or item.vehicle_id is None:
                    raise HTTPException(422, "customer_id and vehicle_id are required for retail orders")
                vehicle = db.execute("SELECT * FROM vehicles WHERE id=? AND customer_id=?", (item.vehicle_id, item.customer_id)).fetchone()
                if not vehicle:
                    raise HTTPException(400, "Vehicle does not belong to customer")
                customer_id, vehicle_id = item.customer_id, item.vehicle_id
            sequence = db.execute("SELECT coalesce(max(id),0)+1 FROM orders").fetchone()[0]
            number = f"RO-{datetime.now():%y%m}-{sequence:04d}"
            cur = db.execute(
                "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,recon_vehicle_id,we_owe_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (number, customer_id, vehicle_id, item.concern.strip(), item.segment, item.recon_vehicle_id if item.segment == "recon" else None, item.we_owe_id if item.segment == "we_owe" else None, now()),
            )
            order_id = cur.lastrowid
            assert order_id is not None
            initialize_order_workflow(db, order_id, now)
            return rowdict(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    @app.post("/api/orders/{order_id}/estimate")
    def save_estimate(order_id: int, estimate: EstimateIn):
        subtotal = round(sum(i.quantity * i.unit_price for i in estimate.items), 2)
        taxable = sum(i.quantity * i.unit_price for i in estimate.items if i.kind == "part")
        tax = round(taxable * estimate.tax_rate, 2)
        total = round(subtotal + tax, 2)
        with connect() as db:
            if not db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
                raise HTTPException(404, "Repair order not found")
            assert_estimate_editable(db, order_id)
            old = db.execute("SELECT id, edit_version FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if old and estimate.expected_version is not None and old["edit_version"] != estimate.expected_version:
                raise HTTPException(409, "Someone else changed this estimate since you loaded it -- reload to see their update")
            if old:
                estimate_id = old["id"]
                db.execute(
                    "UPDATE estimates SET labor_rate=?,tax_rate=?,subtotal=?,tax=?,total=?,status='draft',edit_version=edit_version+1 WHERE id=?",
                    (estimate.labor_rate, estimate.tax_rate, subtotal, tax, total, estimate_id),
                )
            else:
                cur = db.execute("INSERT INTO estimates(order_id,labor_rate,tax_rate,subtotal,tax,total,created_at) VALUES(?,?,?,?,?,?,?)", (order_id, estimate.labor_rate, estimate.tax_rate, subtotal, tax, total, now()))
                estimate_id = cur.lastrowid
            retained_ids: set[int] = set()
            for item in estimate.items:
                existing = db.execute("SELECT id FROM estimate_items WHERE id=? AND estimate_id=?", (item.id, estimate_id)).fetchone() if item.id else None
                if existing:
                    retained_ids.add(int(existing["id"]))
                    db.execute(
                        "UPDATE estimate_items SET kind=?,description=?,part_number=?,quantity=?,unit_price=?,unit_cost=?,line_total=?,review_required=0,reviewed_by=?,reviewed_at=? WHERE id=?",
                        (item.kind, item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_price, item.unit_cost, round(item.quantity * item.unit_price, 2), estimate.actor, now(), item.id),
                    )
                else:
                    cur = db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,line_total,source,review_required,reviewed_by,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (estimate_id, item.kind, item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_price, item.unit_cost, round(item.quantity * item.unit_price, 2), item.source, 0, estimate.actor, now()),
                    )
                    if cur.lastrowid is not None:
                        retained_ids.add(int(cur.lastrowid))
            if old:
                if retained_ids:
                    placeholders = ",".join("?" for _ in retained_ids)
                    db.execute(f"DELETE FROM estimate_items WHERE estimate_id=? AND id NOT IN ({placeholders})", (estimate_id, *retained_ids))
                else:
                    db.execute("DELETE FROM estimate_items WHERE estimate_id=?", (estimate_id,))
            result = dict(db.execute("SELECT * FROM estimates WHERE id=?", (estimate_id,)).fetchone())
            result["items"] = [dict(row) for row in db.execute("SELECT * FROM estimate_items WHERE estimate_id=? ORDER BY id", (estimate_id,))]
            return result

    @app.get("/api/integrations/partstech")
    def partstech():
        with connect() as db:
            settings = db.execute("SELECT partstech_username, partstech_api_key FROM app_settings WHERE id=1").fetchone()
        return {
            "name": "PartsTech",
            "login_url": PARTSTECH_LOGIN_URL,
            "stores_password": False,
            "mode": "secure_external_login",
            "api_key_url": "https://app.partstech.com/profile/shop/api-options",
            "note": "Discount Auto Ops opens PartsTech directly for cost lookup; add the part here at your cost, no markup.",
            "credentials_configured": bool(settings["partstech_username"] and settings["partstech_api_key"]),
            "live_search_available": False,
            "live_search_note": (
                "PartsTech's parts-search API isn't publicly documented -- it's issued to approved "
                "partners directly (PartsTech-Partner-API@oeconnection.com). Your API key is stored and "
                "ready to use the moment real endpoint docs are available; until then, search PartsTech "
                "in its own tab and add what you find here at cost."
            ),
        }

    @app.get("/api/integrations/partstech/credentials")
    def get_partstech_credentials():
        with connect() as db:
            settings = db.execute("SELECT partstech_username, partstech_api_key FROM app_settings WHERE id=1").fetchone()
        return {
            "username": settings["partstech_username"],
            "configured": bool(settings["partstech_username"] and settings["partstech_api_key"]),
        }

    @app.put("/api/integrations/partstech/credentials")
    def save_partstech_credentials(item: PartsTechCredentialsIn):
        with connect() as db:
            db.execute(
                "UPDATE app_settings SET partstech_username=?,partstech_api_key=?,updated_at=? WHERE id=1",
                (item.username.strip(), item.api_key.strip(), now()),
            )
        return {"ok": True}

    static = ROOT / "static"
    app.mount("/assets", StaticFiles(directory=static), name="assets")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(static / "index.html")

    return app


app = create_app()
