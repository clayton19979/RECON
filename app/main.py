from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import paths
from .accounting import build_accounting_router
from .backup_routes import build_backup_router
from .update_routes import build_update_router
from .db import RECON_SHOP_CUSTOMER_ID, connect as db_connect, init_db, now
from .export import build_export_router
from .jobs import build_jobs_router
from .parts import build_parts_router
from .recon import assert_vehicle_editable, build_recon_router, cost_rollup, last_activity_detail, resolve_unit, vehicle_board_rows
from .reports import build_reports_router
from .tasks import build_tasks_router
from .workflow import (
    assert_estimate_editable,
    build_workflow_router,
    get_or_create_estimate,
    initialize_order_workflow,
    touch_order,
    workflow_detail,
)


ROOT = paths.bundle_root()
DATA_ROOT = paths.data_root()
DEFAULT_DB = Path(os.getenv("DISCOUNT_AUTO_OPS_DB", DATA_ROOT / "data" / "shop.db"))
DEFAULT_BACKUPS_DIR = Path(os.getenv("DISCOUNT_AUTO_OPS_BACKUPS_DIR", DATA_ROOT / "backups"))


_US_STATE_ABBREV = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
    "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}


def _normalize_phone(raw: str) -> str:
    """Store phones one way: (313) 555-0142.

    The UI masks input to that shape already, but the API is also driven by
    the seed script, tests, and anything else that speaks HTTP -- so the
    canonical form is enforced here. A 10-digit number (with or without
    punctuation, with or without a leading +1) is reformatted; anything else
    is kept as typed rather than rejected, because old records and oddball
    entries (a shop's 4-digit extension, say) shouldn't start failing saves.
    """
    raw = raw.strip()
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return raw


def _state_abbrev(state: str) -> str:
    """Geocoders return the full state name ('Indiana'); the form field holds
    the two-letter code. Pass through anything already short (a code, or a
    name we don't recognize) unchanged."""
    if not state:
        return ""
    if len(state) == 2:
        return state.upper()
    return _US_STATE_ABBREV.get(state.strip().lower(), state)


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str = ""
    email: str = ""
    address_line1: str = ""
    address_line2: str = ""
    city: str = ""
    state: str = ""
    postal_code: str = ""


class CustomerPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = None
    email: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None


class VehicleIn(BaseModel):
    customer_id: int
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    mileage: int = Field(default=0, ge=0)
    # A broken odometer is a real, recordable state. Without it, a mileage of
    # 0 means both "the clock is dead" and "nobody was asked", and after the
    # fact there is no telling which -- so every zero becomes unreadable.
    odometer_broken: bool = False
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


class OrderIn(BaseModel):
    customer_id: int | None = None
    vehicle_id: int | None = None
    concern: str = Field(min_length=3)
    segment: Literal["retail", "recon", "we_owe"] = "recon"
    recon_vehicle_id: int | None = None
    we_owe_id: int | None = None


class RetailVehiclePatch(BaseModel):
    # Core vehicle info only -- who owns the car is edited through the
    # customer endpoints, and there's no purchase price: the shop never
    # bought this vehicle, it drove in.
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    plate: str | None = None
    plate_state: str | None = None
    # Accepted for call-site symmetry with recon/we-owe, but not enforced:
    # the vehicles table carries no edit_version counter of its own.
    expected_version: int | None = None


class EstimateItem(BaseModel):
    id: int | None = None
    kind: Literal["part", "labor", "fee"]
    description: str = Field(min_length=1)
    quantity: float = Field(gt=0)
    unit_price: float = Field(ge=0)
    part_number: str = ""
    unit_cost: float = Field(default=0, ge=0)
    source: Literal["manual", "technician_finding"] = "manual"
    job_id: int | None = None
    # A vendor's core deposit for this specific part (calipers, alternators,
    # engines) -- tracked per line, not as a free-floating invoice line item,
    # so it's traceable back to exactly which part it's owed against.
    core_charge: float = Field(default=0, ge=0)


class EstimateIn(BaseModel):
    labor_rate: float = Field(default=0, ge=0)
    tax_rate: float = Field(default=0, ge=0, le=1)
    actor: str = Field(default="ui", min_length=1, max_length=120)
    # Capped well under SQLite's ~999-host-parameter limit -- the delete
    # step below builds one "?" per retained id in a single statement, so an
    # unbounded list could raise an uncaught sqlite3.OperationalError (a bare
    # 500) instead of a clean validation error.
    items: list[EstimateItem] = Field(max_length=300)
    expected_version: int | None = None


def rowdict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def estimate_jobs_list(db: sqlite3.Connection, estimate_id: int) -> list[dict]:
    return [dict(row) for row in db.execute(
        """SELECT ej.*, s.name technician_name FROM estimate_jobs ej
           LEFT JOIN staff s ON s.id=ej.technician_id
           WHERE ej.estimate_id=? ORDER BY ej.sort_order, ej.id""",
        (estimate_id,),
    )]


NETWORK_FLAG = DATA_ROOT / "network_mode.flag"


def create_app(db_path: Path = DEFAULT_DB, backups_dir: Path = DEFAULT_BACKUPS_DIR) -> FastAPI:
    init_db(db_path)
    app = FastAPI(title="RECON", version="0.1.0")
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
    app.include_router(build_reports_router(connect))
    app.include_router(build_export_router(connect, now))
    app.include_router(build_tasks_router(connect, now))
    app.include_router(build_jobs_router(connect, now))
    app.include_router(build_backup_router(db_path, backups_dir))
    # backups_dir is data_root/backups, so its parent is where deployment.json
    # and the updates folder live -- derived rather than re-resolved, so the
    # tests' tmp_path data root is honoured the same as the real one.
    app.include_router(build_update_router(backups_dir.parent))

    @app.get("/api/health")
    def health():
        return {"app": "ok"}

    @app.get("/api/dashboard")
    def dashboard():
        with connect() as db:
            customers_count = db.execute("SELECT count(*) FROM customers WHERE is_shop_owned=0").fetchone()[0]
            vehicles_count = db.execute("SELECT count(*) FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE c.is_shop_owned=0").fetchone()[0]
            open_orders = db.execute("SELECT count(*) FROM orders WHERE status != 'complete'").fetchone()[0]
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
        # Enriched for the Customers screen: how many vehicles and (unvoided)
        # repair orders each person has, how many of those ROs are still open,
        # and when the shop last wrote them a ticket. Correlated subqueries
        # rather than JOIN+GROUP BY so a customer with two vehicles and three
        # orders doesn't multiply into six rows to aggregate back down.
        with connect() as db:
            rows = db.execute(
                """SELECT c.*,
                       (SELECT count(*) FROM vehicles v WHERE v.customer_id=c.id) vehicle_count,
                       (SELECT count(*) FROM orders o WHERE o.customer_id=c.id AND o.voided=0) order_count,
                       (SELECT count(*) FROM orders o WHERE o.customer_id=c.id AND o.voided=0 AND o.status!='complete') open_orders,
                       (SELECT max(o.created_at) FROM orders o WHERE o.customer_id=c.id AND o.voided=0) last_visit_at
                   FROM customers c WHERE c.is_shop_owned=0 ORDER BY c.id DESC"""
            )
            return [dict(row) for row in rows]

    @app.get("/api/customers/{customer_id}")
    def get_customer(customer_id: int):
        """One customer with their vehicles, each vehicle with its repair
        orders (voided included, flagged -- history shouldn't silently lose
        tickets). The shop-owned recon sentinel 404s here like it's absent
        from the list: it isn't a customer."""
        with connect() as db:
            row = db.execute("SELECT * FROM customers WHERE id=? AND is_shop_owned=0", (customer_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Customer not found")
            detail = dict(row)
            vehicles = [dict(v) for v in db.execute("SELECT * FROM vehicles WHERE customer_id=? ORDER BY id DESC", (customer_id,))]
            orders = db.execute(
                """SELECT id, number, vehicle_id, segment, status, voided, created_at,
                          recon_vehicle_id, we_owe_id, concern
                   FROM orders WHERE customer_id=? ORDER BY id DESC""",
                (customer_id,),
            )
            by_vehicle: dict[int, list[dict]] = {}
            for o in orders:
                by_vehicle.setdefault(o["vehicle_id"], []).append(dict(o))
            for v in vehicles:
                v["orders"] = by_vehicle.get(v["id"], [])
            detail["vehicles"] = vehicles
            return detail

    @app.post("/api/customers", status_code=201)
    def create_customer(item: CustomerIn):
        with connect() as db:
            cur = db.execute(
                "INSERT INTO customers(name,phone,email,address_line1,address_line2,city,state,postal_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (item.name.strip(), _normalize_phone(item.phone), item.email.strip(),
                 item.address_line1.strip(), item.address_line2.strip(), item.city.strip(),
                 item.state.strip(), item.postal_code.strip(), now()),
            )
            return rowdict(db.execute("SELECT * FROM customers WHERE id=?", (cur.lastrowid,)).fetchone())

    @app.patch("/api/customers/{customer_id}")
    def update_customer(customer_id: int, item: CustomerPatch):
        with connect() as db:
            row = db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Customer not found")
            if row["is_shop_owned"]:
                raise HTTPException(409, "Shop-owned recon inventory customer can't be edited")
            fields: list[str] = []
            params: list[object] = []
            if item.name is not None:
                fields.append("name=?")
                params.append(item.name.strip())
            if item.phone is not None:
                fields.append("phone=?")
                params.append(_normalize_phone(item.phone))
            if item.email is not None:
                fields.append("email=?")
                params.append(item.email.strip())
            for column, value in (
                ("address_line1", item.address_line1),
                ("address_line2", item.address_line2),
                ("city", item.city),
                ("state", item.state),
                ("postal_code", item.postal_code),
            ):
                if value is not None:
                    fields.append(f"{column}=?")
                    params.append(value.strip())
            if fields:
                params.append(customer_id)
                db.execute(f"UPDATE customers SET {','.join(fields)} WHERE id=?", params)
            return rowdict(db.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone())

    @app.get("/api/address-suggest")
    def address_suggest(q: str = ""):
        """As-you-type address autocomplete for the customer editor.

        Proxied server-side (rather than called from the browser) so no API
        key is ever exposed and there's no CORS to fight. Photon is a free,
        keyless typeahead geocoder over OpenStreetMap data -- swap the URL/
        parser here for Google Places or the Census geocoder if desired.

        Results are biased toward the shop's area (Merrillville, IN) and
        filtered to US addresses. Anything that isn't a clean win -- no
        internet, a slow provider, a bad response -- degrades to an empty
        list so the structured fields keep working as plain manual entry."""
        query = q.strip()
        if len(query) < 3:
            return []
        try:
            resp = httpx.get(
                "https://photon.komoot.io/api/",
                params={"q": query, "limit": 5, "lang": "en", "lat": 41.4931, "lon": -87.3328},
                headers={"User-Agent": "DiscountAutoOps/0.1 (shop management app)"},
                timeout=3.0,
            )
            resp.raise_for_status()
            features = resp.json().get("features", [])
        except Exception:
            # Deliberately bare. This endpoint's entire contract is "a nice-to-
            # have that never gets in the way", and the narrower
            # (httpx.HTTPError, ValueError) still let a 500 through: on a
            # machine behind a SOCKS proxy httpx raises ImportError for a
            # missing optional extra, which is neither. Anything that reaches
            # here means we have no suggestions to offer, and the caller's
            # answer to "no suggestions" is the same however we got there --
            # hide the dropdown and let them type the address themselves.
            return []
        suggestions = []
        for feature in features:
            p = feature.get("properties", {})
            if p.get("countrycode") not in (None, "US"):
                continue
            line1 = " ".join(part for part in (p.get("housenumber"), p.get("street") or p.get("name")) if part).strip()
            city = p.get("city") or p.get("town") or p.get("village") or p.get("county") or ""
            state = p.get("state") or ""
            postal = p.get("postcode") or ""
            if not line1 and not city:
                continue
            # The label is abbreviated too, not just the field it fills. A row
            # reading "...Washington, District of Columbia 20500" that drops
            # "DC" into the box looks like it picked something else, and the
            # full name pushes the ZIP out of a narrow dropdown besides.
            abbrev = _state_abbrev(state)
            label = ", ".join(part for part in (line1, city, " ".join(x for x in (abbrev, postal) if x)) if part)
            suggestions.append({
                "label": label,
                "line1": line1,
                "city": city,
                "state": abbrev,
                "postal_code": postal,
            })
        return suggestions

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
            ts = now()
            cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,odometer_broken,plate,plate_state,trim,engine,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (item.customer_id, item.year, item.make.strip(), item.model.strip(), item.vin.strip().upper(), item.mileage, int(item.odometer_broken), item.plate.replace(" ", "").upper(), item.plate_state.strip().upper(), item.trim.strip(), item.engine.strip(), item.color.strip(), ts),
            )
            # Attach it to the physical car straight away, so a VIN that's
            # already been through the shop finds its own history immediately
            # rather than only once someone edits the record.
            resolve_unit(db, cur.lastrowid, item.vin, ts)
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
        # NHTSA reports the payload/cab designation (1500/2500/3500 etc.)
        # separately from Model -- e.g. Model="Silverado", Series="1500" --
        # so a Model on its own doesn't say which Silverado/F-150/Sierra this
        # is. Folded in here rather than added as its own field so every
        # place that already displays "year make model" picks it up for free.
        for series_field in ("Series", "Series2"):
            series = (results.get(series_field) or "").strip()
            if series and series.lower() not in model.lower():
                model = f"{model} {series}".strip()
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

    # --- Retail vehicles ---
    # A customer's own car, on the vehicle-detail page. There is no container
    # row like recon_vehicles/we_owe_items: the vehicle itself is the entity,
    # keyed by its vehicles.id, and only its *retail* tickets roll up here --
    # the same physical car can also carry we-owe promises, which have their
    # own page and their own totals.

    def retail_vehicle_row(db: sqlite3.Connection, vehicle_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT v.id, v.customer_id, v.year, v.make, v.model, v.vin, v.mileage,
                      v.plate, v.plate_state, v.trim, v.engine, v.color, v.created_at,
                      c.name customer_name, c.phone customer_phone, c.email customer_email,
                      c.address_line1 customer_address_line1, c.address_line2 customer_address_line2,
                      c.city customer_city, c.state customer_state, c.postal_code customer_postal_code
               FROM vehicles v JOIN customers c ON c.id=v.customer_id
               WHERE v.id=? AND c.is_shop_owned=0""",
            (vehicle_id,),
        ).fetchone()
        if not row:
            # Shop-owned recon inventory 404s here on purpose: those cars have
            # a recon page, and pretending they're retail would double-count.
            raise HTTPException(404, "Vehicle not found")
        return row

    def retail_vehicle_detail(db: sqlite3.Connection, vehicle_id: int) -> dict:
        detail = dict(retail_vehicle_row(db, vehicle_id))
        detail["vehicle_id"] = vehicle_id
        rollup = cost_rollup(db, "vehicle_id", vehicle_id, segment="retail")
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["last_activity"] = last_activity_detail(db, "vehicle_id", vehicle_id, detail["created_at"], segment="retail")
        # Retail vehicles never archive -- the RO's own status is the whole
        # lifecycle -- and the vehicles table has no optimistic-lock counter.
        # Both keys exist so the detail page can treat all three segments
        # uniformly (falsy = not archived, version ignored on save).
        detail["archived_at"] = ""
        detail["edit_version"] = 0
        # The same customer's other cars, so a household's vehicles are one
        # click apart on the page instead of a detour back through Customers.
        # Counts are unvoided ROs of *any* segment -- "does this car have
        # history / is something open on it" -- because that's the hop-or-not
        # question; the money rollup above stays retail-only.
        detail["other_vehicles"] = [
            dict(v) for v in db.execute(
                """SELECT v.id, v.year, v.make, v.model, v.vin, v.plate, v.plate_state,
                          (SELECT count(*) FROM orders o WHERE o.vehicle_id=v.id AND o.voided=0) order_count,
                          (SELECT count(*) FROM orders o WHERE o.vehicle_id=v.id AND o.voided=0 AND o.status!='complete') open_orders
                   FROM vehicles v WHERE v.customer_id=? AND v.id!=? ORDER BY v.id DESC""",
                (detail["customer_id"], vehicle_id),
            )
        ]
        return detail

    @app.get("/api/retail/vehicles/{vehicle_id}")
    def get_retail_vehicle(vehicle_id: int):
        with connect() as db:
            return retail_vehicle_detail(db, vehicle_id)

    @app.patch("/api/retail/vehicles/{vehicle_id}")
    def update_retail_vehicle(vehicle_id: int, item: RetailVehiclePatch):
        with connect() as db:
            retail_vehicle_row(db, vehicle_id)
            fields: list[str] = []
            params: list[object] = []
            for name, value in (
                ("vin", item.vin.strip().upper() if item.vin is not None else None),
                ("year", item.year),
                ("make", item.make.strip() if item.make is not None else None),
                ("model", item.model.strip() if item.model is not None else None),
                ("trim", item.trim.strip() if item.trim is not None else None),
                ("engine", item.engine.strip() if item.engine is not None else None),
                ("color", item.color.strip() if item.color is not None else None),
                ("mileage", item.mileage),
                ("plate", item.plate.strip().upper() if item.plate is not None else None),
                ("plate_state", item.plate_state.strip().upper() if item.plate_state is not None else None),
            ):
                if value is not None:
                    fields.append(f"{name}=?")
                    params.append(value)
            if fields:
                params.append(vehicle_id)
                db.execute(f"UPDATE vehicles SET {','.join(fields)} WHERE id=?", params)
            return retail_vehicle_detail(db, vehicle_id)

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
                detail["estimate"]["items"] = [dict(row) for row in db.execute("SELECT * FROM estimate_items WHERE estimate_id=? ORDER BY sort_order, id", (estimate["id"],))]
                detail["estimate"]["jobs"] = estimate_jobs_list(db, estimate["id"])
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
                recon_vehicle = db.execute("SELECT vehicle_id, archived_at FROM recon_vehicles WHERE id=?", (item.recon_vehicle_id,)).fetchone() if item.recon_vehicle_id else None
                if not recon_vehicle:
                    raise HTTPException(404, "Recon vehicle not found")
                if recon_vehicle["archived_at"]:
                    raise HTTPException(409, "This vehicle is archived to History -- reopen it to start a new repair order")
                customer_id, vehicle_id = RECON_SHOP_CUSTOMER_ID, recon_vehicle["vehicle_id"]
            elif item.segment == "we_owe":
                we_owe_item = db.execute("SELECT customer_id, vehicle_id, archived_at FROM we_owe_items WHERE id=?", (item.we_owe_id,)).fetchone() if item.we_owe_id else None
                if not we_owe_item:
                    raise HTTPException(404, "We-owe item not found")
                if we_owe_item["archived_at"]:
                    raise HTTPException(409, "This vehicle is archived to History -- reopen it to start a new repair order")
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
                "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,recon_vehicle_id,we_owe_id,status,voided,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (number, customer_id, vehicle_id, item.concern.strip(), item.segment, item.recon_vehicle_id if item.segment == "recon" else None, item.we_owe_id if item.segment == "we_owe" else None, "estimate", 0, now()),
            )
            order_id = cur.lastrowid
            assert order_id is not None
            initialize_order_workflow(db, order_id, now)
            return rowdict(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    @app.post("/api/orders/{order_id}/estimate")
    def save_estimate(order_id: int, estimate: EstimateIn):
        with connect() as db:
            current_order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
            if not current_order:
                raise HTTPException(404, "Repair order not found")
            assert_vehicle_editable(db, current_order)
            assert_estimate_editable(db, order_id)
            old = db.execute("SELECT id, edit_version FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if old and estimate.expected_version is not None and old["edit_version"] != estimate.expected_version:
                raise HTTPException(409, "Someone else changed this estimate since you loaded it -- reload to see their update")
            estimate_id = get_or_create_estimate(db, order_id, now)["id"]
            if old:
                db.execute(
                    "UPDATE estimates SET labor_rate=?,tax_rate=?,status='draft',edit_version=edit_version+1 WHERE id=?",
                    (estimate.labor_rate, estimate.tax_rate, estimate_id),
                )
            else:
                # A job may have already lazily created this estimate row with
                # placeholder zeros -- fill in the real requested values now,
                # without bumping edit_version (this is still the first save).
                db.execute(
                    "UPDATE estimates SET labor_rate=?,tax_rate=? WHERE id=?",
                    (estimate.labor_rate, estimate.tax_rate, estimate_id),
                )
            valid_job_ids = {row[0] for row in db.execute("SELECT id FROM estimate_jobs WHERE estimate_id=?", (estimate_id,))}
            retained_ids: set[int] = set()
            for position, item in enumerate(estimate.items):
                if item.job_id is not None and item.job_id not in valid_job_ids:
                    raise HTTPException(422, "Job does not belong to this repair order's estimate")
                existing = db.execute("SELECT id FROM estimate_items WHERE id=? AND estimate_id=?", (item.id, estimate_id)).fetchone() if item.id else None
                if existing:
                    retained_ids.add(int(existing["id"]))
                    db.execute(
                        "UPDATE estimate_items SET kind=?,description=?,part_number=?,quantity=?,unit_price=?,unit_cost=?,line_total=?,review_required=0,reviewed_by=?,reviewed_at=?,sort_order=?,job_id=?,core_charge=? WHERE id=?",
                        (item.kind, item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_price, item.unit_cost, round(item.quantity * item.unit_price, 2), estimate.actor, now(), position, item.job_id, item.core_charge, item.id),
                    )
                else:
                    cur = db.execute(
                        "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,line_total,source,review_required,reviewed_by,reviewed_at,sort_order,job_id,core_charge) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (estimate_id, item.kind, item.description.strip(), item.part_number.strip().upper(), item.quantity, item.unit_price, item.unit_cost, round(item.quantity * item.unit_price, 2), item.source, 0, estimate.actor, now(), position, item.job_id, item.core_charge),
                    )
                    if cur.lastrowid is not None:
                        retained_ids.add(int(cur.lastrowid))
            if old:
                # A line already marked received represents money the shop
                # actually spent (it's what an AP invoice was posted against) --
                # it must never disappear just because a save's payload didn't
                # happen to include it (a stale tab, a slow response landing
                # late, a future bug in what the browser collects). Only
                # never-received lines are ever deleted this way.
                if retained_ids:
                    placeholders = ",".join("?" for _ in retained_ids)
                    db.execute(f"DELETE FROM estimate_items WHERE estimate_id=? AND id NOT IN ({placeholders}) AND status!='received'", (estimate_id, *retained_ids))
                else:
                    db.execute("DELETE FROM estimate_items WHERE estimate_id=? AND status!='received'", (estimate_id,))
            # Computed from the rows that actually survived, not from the
            # request payload -- a received line kept alive above despite
            # being left out of the payload would otherwise never be counted
            # into subtotal/tax/total, understating the estimate's real total.
            final_rows = db.execute("SELECT quantity, unit_price, kind FROM estimate_items WHERE estimate_id=?", (estimate_id,)).fetchall()
            subtotal = round(sum(r["quantity"] * r["unit_price"] for r in final_rows), 2)
            taxable = sum(r["quantity"] * r["unit_price"] for r in final_rows if r["kind"] == "part")
            tax = round(taxable * estimate.tax_rate, 2)
            total = round(subtotal + tax, 2)
            db.execute("UPDATE estimates SET subtotal=?,tax=?,total=? WHERE id=?", (subtotal, tax, total, estimate_id))
            # Writing the estimate grid is the single most common thing anyone
            # does to a ticket, and it's the one mutation that deliberately
            # doesn't log an activity event (it autosaves; the log would be
            # nothing but estimate saves). Without this the board would call a
            # car idle for a week while a tech was pricing it out all morning.
            touch_order(db, order_id, now)
            result = dict(db.execute("SELECT * FROM estimates WHERE id=?", (estimate_id,)).fetchone())
            result["items"] = [dict(row) for row in db.execute("SELECT * FROM estimate_items WHERE estimate_id=? ORDER BY sort_order, id", (estimate_id,))]
            result["jobs"] = estimate_jobs_list(db, estimate_id)
            return result

    static = ROOT / "static"
    app.mount("/assets", StaticFiles(directory=static), name="assets")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(static / "index.html")

    return app


def __getattr__(name: str):
    """The module-level `app` is built on first access, not at import time.

    `app = create_app()` at import meant that *any* import from this module
    -- seed_mock_data pulling in DEFAULT_DB, say -- init_db()'d the default
    database as a side effect. That's how `seed_mock_data --reset-only` on a
    box with no database ended up printing "Previous database moved aside":
    the import created a fresh empty db a moment before reset_db looked.

    `uvicorn app.main:app` still works -- resolving the import string
    triggers this hook. The instance is cached by assignment, so later
    lookups find the real attribute and never come back here.
    """
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
