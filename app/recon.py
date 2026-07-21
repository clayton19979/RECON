from __future__ import annotations

import sqlite3
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID

RECON_STATUSES = {"acquired", "in_repair", "ready", "sold", "retained"}
WE_OWE_STATUSES = {"open", "fulfilled", "waived"}


class RecondVehicleIn(BaseModel):
    stock_number: str = Field(min_length=1, max_length=40)
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    mileage: int = Field(default=0, ge=0)
    trim: str = ""
    engine: str = ""
    color: str = ""
    acquisition_source: str = ""
    acquisition_date: str = ""
    purchase_price: float = Field(default=0, ge=0)
    notes: str = ""


class RecondVehiclePatch(BaseModel):
    status: Literal["acquired", "in_repair", "ready", "sold", "retained"] | None = None
    sale_price: float | None = Field(default=None, ge=0)
    sale_date: str | None = None
    sale_customer_id: int | None = None
    notes: str | None = None


class WeOweIn(BaseModel):
    customer_id: int
    vehicle_id: int
    description: str = Field(min_length=1)
    category: str = "other"
    target_date: str = ""
    sale_reference: str = ""
    lot_stock_number: str = ""


class WeOwePatch(BaseModel):
    status: Literal["open", "fulfilled", "waived"] | None = None


def cost_rollup(db: sqlite3.Connection, column: str, ref_id: int) -> dict:
    """Actual cost = what's really landed: labor/fees count in full the moment
    they're logged, but parts only count once received. quoted_cost (full
    quantity regardless of receipt) is returned alongside for comparison."""
    rows = db.execute(
        f"""SELECT o.id, o.number, o.status,
               coalesce(sum(CASE WHEN ei.kind='part'  THEN ei.received_quantity*ei.unit_cost ELSE 0 END),0) parts_cost,
               coalesce(sum(CASE WHEN ei.kind='labor' THEN ei.quantity*ei.unit_cost ELSE 0 END),0) labor_cost,
               coalesce(sum(CASE WHEN ei.kind='fee'   THEN ei.quantity*ei.unit_cost ELSE 0 END),0) fee_cost,
               coalesce(sum(ei.quantity*ei.unit_cost),0) quoted_cost
           FROM orders o
           LEFT JOIN estimates e ON e.order_id=o.id
           LEFT JOIN estimate_items ei ON ei.estimate_id=e.id
           WHERE o.{column}=?
           GROUP BY o.id
           ORDER BY o.id""",
        (ref_id,),
    ).fetchall()
    orders = []
    for row in rows:
        value = dict(row)
        value["total_cost"] = round(value["parts_cost"] + value["labor_cost"] + value["fee_cost"], 2)
        orders.append(value)
    return {
        "orders": orders,
        "total_cost": round(sum(o["total_cost"] for o in orders), 2),
        "quoted_cost": round(sum(o["quoted_cost"] for o in orders), 2),
    }


def technician_names(db: sqlite3.Connection, order_ids: list[int]) -> list[str]:
    if not order_ids:
        return []
    placeholders = ",".join("?" for _ in order_ids)
    rows = db.execute(
        f"""SELECT DISTINCT s.name FROM order_workflow w JOIN staff s ON s.id=w.technician_id
            WHERE w.order_id IN ({placeholders}) AND w.technician_id IS NOT NULL ORDER BY s.name""",
        order_ids,
    ).fetchall()
    return [row["name"] for row in rows]


def vehicle_board_rows(db: sqlite3.Connection, start: str | None = None, end: str | None = None, segment: str | None = None) -> list[dict]:
    """The unified Vehicles list: recon + we-owe merged, one row per vehicle,
    with rolled-up cost and assigned technicians. This is the primary view
    of the app and also backs the date-range vehicle-spend report."""
    end_bound = f"{end}T23:59:59" if end else None
    result = []
    if segment in (None, "recon"):
        rows = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage FROM recon_vehicles rv
               JOIN vehicles v ON v.id=rv.vehicle_id
               WHERE (:start IS NULL OR rv.created_at>=:start) AND (:end IS NULL OR rv.created_at<=:end)
               ORDER BY rv.created_at DESC""",
            {"start": start, "end": end_bound},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "recon_vehicle_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            result.append({
                "segment": "recon",
                "recon_id": row["id"],
                "we_owe_id": None,
                "stock_number": row["stock_number"],
                "vehicle": f"{row['year']} {row['make']} {row['model']}",
                "vin": row["vin"],
                "status": row["status"],
                "status_bucket": "finished" if row["status"] in ("sold", "retained") else "in_progress",
                "purchase_price": row["purchase_price"],
                "sale_price": row["sale_price"],
                "actual_cost": rollup["total_cost"],
                "quoted_cost": rollup["quoted_cost"],
                "profit": round(row["sale_price"] - row["purchase_price"] - rollup["total_cost"], 2) if row["sale_price"] is not None else None,
                "technicians": technician_names(db, order_ids),
                "updated_at": row["updated_at"],
            })
    if segment in (None, "we_owe"):
        rows = db.execute(
            """SELECT w.*, c.name customer_name, v.year, v.make, v.model, v.vin FROM we_owe_items w
               JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               WHERE (:start IS NULL OR w.created_at>=:start) AND (:end IS NULL OR w.created_at<=:end)
               ORDER BY w.created_at DESC""",
            {"start": start, "end": end_bound},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "we_owe_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            result.append({
                "segment": "we_owe",
                "recon_id": None,
                "we_owe_id": row["id"],
                "stock_number": row["lot_stock_number"] or None,
                "vehicle": f"{row['year']} {row['make']} {row['model']}",
                "vin": row["vin"],
                "customer_name": row["customer_name"],
                "description": row["description"],
                "status": row["status"],
                "status_bucket": "finished" if row["status"] in ("fulfilled", "waived") else "in_progress",
                "actual_cost": rollup["total_cost"],
                "quoted_cost": rollup["quoted_cost"],
                "technicians": technician_names(db, order_ids),
                "updated_at": row["updated_at"],
            })
    return result


def build_recon_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def recon_row(db: sqlite3.Connection, recon_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage, v.trim, v.engine, v.color
               FROM recon_vehicles rv JOIN vehicles v ON v.id=rv.vehicle_id WHERE rv.id=?""",
            (recon_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Recon vehicle not found")
        return row

    def recon_detail(db: sqlite3.Connection, recon_id: int) -> dict:
        detail = dict(recon_row(db, recon_id))
        rollup = cost_rollup(db, "recon_vehicle_id", recon_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["profit"] = (
            round(detail["sale_price"] - detail["purchase_price"] - rollup["total_cost"], 2)
            if detail["sale_price"] is not None
            else None
        )
        return detail

    def we_owe_row(db: sqlite3.Connection, we_owe_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT w.*, c.name customer_name, v.year, v.make, v.model, v.vin
               FROM we_owe_items w JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               WHERE w.id=?""",
            (we_owe_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "We-owe item not found")
        return row

    def we_owe_detail(db: sqlite3.Connection, we_owe_id: int) -> dict:
        detail = dict(we_owe_row(db, we_owe_id))
        rollup = cost_rollup(db, "we_owe_id", we_owe_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        return detail

    @router.get("/vehicles-board")
    def vehicles_board(segment: Literal["recon", "we_owe"] | None = None):
        with connect() as db:
            return vehicle_board_rows(db, segment=segment)

    # --- Recon vehicles ---

    @router.post("/recon/vehicles", status_code=201)
    def create_recon_vehicle(item: RecondVehicleIn):
        stock_number = item.stock_number.strip().upper()
        with connect() as db:
            if db.execute("SELECT 1 FROM recon_vehicles WHERE stock_number=?", (stock_number,)).fetchone():
                raise HTTPException(409, "Stock number already in use")
            ts = now_fn()
            vehicle_cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,plate,plate_state,trim,engine,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (RECON_SHOP_CUSTOMER_ID, item.year, item.make.strip(), item.model.strip(), item.vin.strip().upper(), item.mileage, "", "", item.trim.strip(), item.engine.strip(), item.color.strip(), ts),
            )
            recon_cur = db.execute(
                "INSERT INTO recon_vehicles(vehicle_id,stock_number,acquisition_source,acquisition_date,purchase_price,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (vehicle_cur.lastrowid, stock_number, item.acquisition_source.strip(), item.acquisition_date.strip(), item.purchase_price, item.notes.strip(), ts, ts),
            )
            return recon_detail(db, recon_cur.lastrowid)

    @router.get("/recon/summary")
    def recon_summary():
        with connect() as db:
            rows = db.execute("SELECT * FROM recon_vehicles").fetchall()
            counts: dict[str, int] = {}
            total_purchase = total_cost = total_quoted = total_sale = 0.0
            for row in rows:
                counts[row["status"]] = counts.get(row["status"], 0) + 1
                total_purchase += row["purchase_price"] or 0
                rollup = cost_rollup(db, "recon_vehicle_id", row["id"])
                total_cost += rollup["total_cost"]
                total_quoted += rollup["quoted_cost"]
                if row["sale_price"] is not None:
                    total_sale += row["sale_price"]
            return {
                "counts": counts,
                "total_purchase_cost": round(total_purchase, 2),
                "total_repair_cost": round(total_cost, 2),
                "total_quoted_cost": round(total_quoted, 2),
                "total_sale_revenue": round(total_sale, 2),
                "net_profit": round(total_sale - total_purchase - total_cost, 2),
            }

    @router.get("/recon/vehicles/{recon_id}")
    def get_recon_vehicle(recon_id: int):
        with connect() as db:
            return recon_detail(db, recon_id)

    @router.patch("/recon/vehicles/{recon_id}")
    def update_recon_vehicle(recon_id: int, item: RecondVehiclePatch):
        with connect() as db:
            recon_row(db, recon_id)
            fields: list[str] = []
            params: list[object] = []
            if item.status is not None:
                fields.append("status=?")
                params.append(item.status)
            if item.sale_price is not None:
                fields.append("sale_price=?")
                params.append(item.sale_price)
            if item.sale_date is not None:
                fields.append("sale_date=?")
                params.append(item.sale_date.strip())
            if item.sale_customer_id is not None:
                if not db.execute("SELECT 1 FROM customers WHERE id=?", (item.sale_customer_id,)).fetchone():
                    raise HTTPException(404, "Sale customer not found")
                fields.append("sale_customer_id=?")
                params.append(item.sale_customer_id)
            if item.notes is not None:
                fields.append("notes=?")
                params.append(item.notes.strip())
            if fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                params.append(recon_id)
                db.execute(f"UPDATE recon_vehicles SET {','.join(fields)} WHERE id=?", params)
            return recon_detail(db, recon_id)

    # --- We-owe items ---

    @router.post("/we-owe", status_code=201)
    def create_we_owe_item(item: WeOweIn):
        with connect() as db:
            vehicle = db.execute("SELECT 1 FROM vehicles WHERE id=? AND customer_id=?", (item.vehicle_id, item.customer_id)).fetchone()
            if not vehicle:
                raise HTTPException(400, "Vehicle does not belong to customer")
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO we_owe_items(customer_id,vehicle_id,description,category,promised_at,target_date,sale_reference,lot_stock_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (item.customer_id, item.vehicle_id, item.description.strip(), item.category.strip() or "other", ts, item.target_date.strip(), item.sale_reference.strip(), item.lot_stock_number.strip().upper(), ts, ts),
            )
            return we_owe_detail(db, cur.lastrowid)

    @router.get("/we-owe/summary")
    def we_owe_summary():
        with connect() as db:
            rows = db.execute("SELECT * FROM we_owe_items").fetchall()
            rollups = [cost_rollup(db, "we_owe_id", row["id"]) for row in rows]
            return {
                "open_count": sum(1 for row in rows if row["status"] == "open"),
                "total_count": len(rows),
                "total_fulfillment_cost": round(sum(r["total_cost"] for r in rollups), 2),
                "total_quoted_cost": round(sum(r["quoted_cost"] for r in rollups), 2),
            }

    @router.get("/we-owe/{we_owe_id}")
    def get_we_owe_item(we_owe_id: int):
        with connect() as db:
            return we_owe_detail(db, we_owe_id)

    @router.patch("/we-owe/{we_owe_id}")
    def update_we_owe_item(we_owe_id: int, item: WeOwePatch):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            if item.status is not None:
                fulfilled_at = now_fn() if item.status == "fulfilled" else ""
                db.execute("UPDATE we_owe_items SET status=?,fulfilled_at=?,updated_at=? WHERE id=?", (item.status, fulfilled_at, now_fn(), we_owe_id))
            return we_owe_detail(db, we_owe_id)

    return router
