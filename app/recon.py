from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID


def age_days(created_at: str) -> int:
    """Whole days since created_at (an ISO timestamp) -- how long a car has
    actually been sitting, the natural companion to "what we have in it"."""
    created = datetime.fromisoformat(created_at)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - created).days

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
    # Core vehicle info -- correcting a typo (wrong purchase price, VIN, etc.)
    # shouldn't require touching the database directly.
    purchase_price: float | None = Field(default=None, ge=0)
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    expected_version: int | None = None


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
    description: str | None = Field(default=None, min_length=1)
    category: str | None = None
    target_date: str | None = None
    lot_stock_number: str | None = None
    # Core vehicle info -- a car is sometimes entered quickly with the VIN
    # added later, same as recon vehicles below.
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    mileage: int | None = Field(default=None, ge=0)
    expected_version: int | None = None


class WeOwePaymentIn(BaseModel):
    """Customers are sometimes talked into putting money down toward a
    we-owe repair -- tracked separately from shop cost so the net amount
    the shop is actually out of pocket is visible, not just gross spend."""
    amount: float = Field(gt=0)
    method: Literal["cash", "card", "check", "bank", "other"] = "cash"
    note: str = ""
    actor: str = ""


def cost_rollup(db: sqlite3.Connection, column: str, ref_id: int) -> dict:
    """Actual cost = what's really landed: labor/fees count in full the moment
    they're logged, but parts only count once received. quoted_cost (full
    quantity regardless of receipt) is returned alongside for comparison."""
    rows = db.execute(
        f"""SELECT o.id, o.number, o.status, o.voided,
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
    # Voided ROs (started by mistake) are kept in the order history
    # (traceability) but never count toward the vehicle's cost -- that work
    # was never actually done.
    countable = [o for o in orders if not o["voided"]]
    return {
        "orders": orders,
        "total_cost": round(sum(o["total_cost"] for o in countable), 2),
        "quoted_cost": round(sum(o["quoted_cost"] for o in countable), 2),
    }


def _assert_not_archived(row: sqlite3.Row) -> None:
    if row["archived_at"]:
        raise HTTPException(409, "This vehicle is archived to History -- reopen it to make changes")


def assert_vehicle_editable(db: sqlite3.Connection, order_row: sqlite3.Row) -> None:
    """Once a vehicle's ticket is archived to History it's fully frozen --
    reopening it is the only way back to an editable state. Retail orders
    have neither a recon_vehicle_id nor a we_owe_id, so this is always a
    no-op for them; archiving only applies to recon/we-owe vehicles."""
    if order_row["recon_vehicle_id"]:
        row = db.execute("SELECT archived_at FROM recon_vehicles WHERE id=?", (order_row["recon_vehicle_id"],)).fetchone()
        if row:
            _assert_not_archived(row)
    if order_row["we_owe_id"]:
        row = db.execute("SELECT archived_at FROM we_owe_items WHERE id=?", (order_row["we_owe_id"],)).fetchone()
        if row:
            _assert_not_archived(row)


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


def vehicle_board_rows(db: sqlite3.Connection, start: str | None = None, end: str | None = None, segment: str | None = None, archived: bool = False) -> list[dict]:
    """The unified Vehicles list: recon + we-owe merged, one row per vehicle,
    with rolled-up cost and assigned technicians. This is the primary view
    of the app and also backs the date-range vehicle-spend report.
    `archived` selects the History view instead of the live job board --
    reports/export always use the default (live board only)."""
    end_bound = f"{end}T23:59:59" if end else None
    archived_flag = 1 if archived else 0
    result = []
    if segment in (None, "recon"):
        rows = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage FROM recon_vehicles rv
               JOIN vehicles v ON v.id=rv.vehicle_id
               WHERE (:start IS NULL OR rv.created_at>=:start) AND (:end IS NULL OR rv.created_at<=:end)
                 AND (rv.archived_at != '') = :archived
               ORDER BY rv.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "recon_vehicle_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            # Recon status/sale tracking isn't used here -- the repair order's
            # own status is what the advisor actually maintains, so that's
            # what drives the displayed status and in-progress/finished bucket.
            active_order = next((o for o in reversed(rollup["orders"]) if o["status"] != "complete"), None)
            latest_order = rollup["orders"][-1] if rollup["orders"] else None
            has_closed_order = any(o["status"] == "complete" for o in rollup["orders"])
            display_status = (active_order or latest_order)["status"] if (active_order or latest_order) else "acquired"
            result.append({
                "segment": "recon",
                "recon_id": row["id"],
                "we_owe_id": None,
                "stock_number": row["stock_number"],
                "vehicle": f"{row['year']} {row['make']} {row['model']}",
                "vin": row["vin"],
                "status": display_status,
                "status_bucket": "finished" if (active_order is None and has_closed_order) else "in_progress",
                "purchase_price": row["purchase_price"],
                "actual_cost": rollup["total_cost"],
                "quoted_cost": rollup["quoted_cost"],
                "technicians": technician_names(db, order_ids),
                "updated_at": row["updated_at"],
                "age_days": age_days(row["created_at"]),
            })
    if segment in (None, "we_owe"):
        rows = db.execute(
            """SELECT w.*, c.name customer_name, v.year, v.make, v.model, v.vin FROM we_owe_items w
               JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               WHERE (:start IS NULL OR w.created_at>=:start) AND (:end IS NULL OR w.created_at<=:end)
                 AND (w.archived_at != '') = :archived
               ORDER BY w.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag},
        ).fetchall()
        for row in rows:
            rollup = cost_rollup(db, "we_owe_id", row["id"])
            order_ids = [o["id"] for o in rollup["orders"]]
            customer_paid = round(db.execute(
                "SELECT coalesce(sum(amount),0) FROM we_owe_payments WHERE we_owe_id=?", (row["id"],)
            ).fetchone()[0], 2)
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
                "customer_paid": customer_paid,
                "net_cost": round(rollup["total_cost"] - customer_paid, 2),
                "technicians": technician_names(db, order_ids),
                "updated_at": row["updated_at"],
                "age_days": age_days(row["created_at"]),
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
            """SELECT w.*, c.name customer_name, c.phone customer_phone, c.email customer_email,
                      v.year, v.make, v.model, v.vin, v.mileage, v.trim, v.engine, v.color
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
        payments = [dict(row) for row in db.execute(
            "SELECT * FROM we_owe_payments WHERE we_owe_id=? ORDER BY id DESC", (we_owe_id,)
        )]
        detail["payments"] = payments
        detail["customer_paid"] = round(sum(p["amount"] for p in payments), 2)
        detail["net_cost"] = round(detail["total_cost"] - detail["customer_paid"], 2)
        return detail

    @router.get("/vehicles-board")
    def vehicles_board(segment: Literal["recon", "we_owe"] | None = None, archived: bool = False):
        with connect() as db:
            return vehicle_board_rows(db, segment=segment, archived=archived)

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

    @router.post("/recon/vehicles/{recon_id}/archive")
    def archive_recon_vehicle(recon_id: int):
        with connect() as db:
            recon_row(db, recon_id)
            db.execute("UPDATE recon_vehicles SET archived_at=?,edit_version=edit_version+1 WHERE id=?", (now_fn(), recon_id))
            return recon_detail(db, recon_id)

    @router.post("/recon/vehicles/{recon_id}/reopen")
    def reopen_recon_vehicle(recon_id: int):
        with connect() as db:
            recon_row(db, recon_id)
            db.execute("UPDATE recon_vehicles SET archived_at='',edit_version=edit_version+1 WHERE id=?", (recon_id,))
            return recon_detail(db, recon_id)

    @router.patch("/recon/vehicles/{recon_id}")
    def update_recon_vehicle(recon_id: int, item: RecondVehiclePatch):
        with connect() as db:
            row = recon_row(db, recon_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(409, "Someone else changed this vehicle since you loaded it -- reload to see their update")
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
            if item.purchase_price is not None:
                fields.append("purchase_price=?")
                params.append(item.purchase_price)
            # Core vehicle info (VIN, make/model, etc.) lives on the shared
            # vehicles table, not recon_vehicles -- correcting a typo here
            # shouldn't require touching the database directly.
            vehicle_fields: list[str] = []
            vehicle_params: list[object] = []
            for name, value in (
                ("vin", item.vin.strip().upper() if item.vin is not None else None),
                ("year", item.year),
                ("make", item.make.strip() if item.make is not None else None),
                ("model", item.model.strip() if item.model is not None else None),
                ("trim", item.trim.strip() if item.trim is not None else None),
                ("engine", item.engine.strip() if item.engine is not None else None),
                ("color", item.color.strip() if item.color is not None else None),
                ("mileage", item.mileage),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                fields.append("edit_version=edit_version+1")
                params.append(recon_id)
                db.execute(f"UPDATE recon_vehicles SET {','.join(fields)} WHERE id=?", params)

            return recon_detail(db, recon_id)

    @router.delete("/recon/vehicles/{recon_id}", status_code=204)
    def delete_recon_vehicle(recon_id: int):
        with connect() as db:
            row = recon_row(db, recon_id)
            if db.execute("SELECT 1 FROM orders WHERE recon_vehicle_id=?", (recon_id,)).fetchone():
                raise HTTPException(409, "Can't delete a vehicle with repair order history -- cancel or close its orders instead")
            db.execute("DELETE FROM recon_vehicles WHERE id=?", (recon_id,))
            db.execute("DELETE FROM vehicles WHERE id=?", (row["vehicle_id"],))
        return None

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

    @router.post("/we-owe/{we_owe_id}/archive")
    def archive_we_owe_item(we_owe_id: int):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            db.execute("UPDATE we_owe_items SET archived_at=?,edit_version=edit_version+1 WHERE id=?", (now_fn(), we_owe_id))
            return we_owe_detail(db, we_owe_id)

    @router.post("/we-owe/{we_owe_id}/reopen")
    def reopen_we_owe_item(we_owe_id: int):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            db.execute("UPDATE we_owe_items SET archived_at='',edit_version=edit_version+1 WHERE id=?", (we_owe_id,))
            return we_owe_detail(db, we_owe_id)

    @router.patch("/we-owe/{we_owe_id}")
    def update_we_owe_item(we_owe_id: int, item: WeOwePatch):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(409, "Someone else changed this item since you loaded it -- reload to see their update")
            fields: list[str] = []
            params: list[object] = []
            if item.status is not None:
                fields.append("status=?")
                params.append(item.status)
                fields.append("fulfilled_at=?")
                params.append(now_fn() if item.status == "fulfilled" else "")
            if item.description is not None:
                fields.append("description=?")
                params.append(item.description.strip())
            if item.category is not None:
                fields.append("category=?")
                params.append(item.category.strip() or "other")
            if item.target_date is not None:
                fields.append("target_date=?")
                params.append(item.target_date.strip())
            if item.lot_stock_number is not None:
                fields.append("lot_stock_number=?")
                params.append(item.lot_stock_number.strip().upper())

            # Core vehicle info (VIN, make/model, etc.) lives on the shared
            # vehicles table, not we_owe_items -- same pattern as recon.
            vehicle_fields: list[str] = []
            vehicle_params: list[object] = []
            for name, value in (
                ("vin", item.vin.strip().upper() if item.vin is not None else None),
                ("year", item.year),
                ("make", item.make.strip() if item.make is not None else None),
                ("model", item.model.strip() if item.model is not None else None),
                ("trim", item.trim.strip() if item.trim is not None else None),
                ("engine", item.engine.strip() if item.engine is not None else None),
                ("color", item.color.strip() if item.color is not None else None),
                ("mileage", item.mileage),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(now_fn())
                fields.append("edit_version=edit_version+1")
                params.append(we_owe_id)
                db.execute(f"UPDATE we_owe_items SET {','.join(fields)} WHERE id=?", params)
            return we_owe_detail(db, we_owe_id)

    @router.delete("/we-owe/{we_owe_id}", status_code=204)
    def delete_we_owe_item(we_owe_id: int):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            if db.execute("SELECT 1 FROM orders WHERE we_owe_id=?", (we_owe_id,)).fetchone():
                raise HTTPException(409, "Can't delete a we-owe item with repair order history -- cancel or close its orders instead")
            db.execute("DELETE FROM we_owe_items WHERE id=?", (we_owe_id,))
        return None

    @router.post("/we-owe/{we_owe_id}/payments", status_code=201)
    def add_we_owe_payment(we_owe_id: int, item: WeOwePaymentIn):
        with connect() as db:
            _assert_not_archived(we_owe_row(db, we_owe_id))
            db.execute(
                "INSERT INTO we_owe_payments(we_owe_id,amount,method,note,actor,created_at) VALUES(?,?,?,?,?,?)",
                (we_owe_id, item.amount, item.method, item.note.strip(), item.actor.strip(), now_fn()),
            )
            return we_owe_detail(db, we_owe_id)

    @router.delete("/we-owe/{we_owe_id}/payments/{payment_id}", status_code=204)
    def delete_we_owe_payment(we_owe_id: int, payment_id: int):
        with connect() as db:
            _assert_not_archived(we_owe_row(db, we_owe_id))
            if not db.execute("SELECT 1 FROM we_owe_payments WHERE id=? AND we_owe_id=?", (payment_id, we_owe_id)).fetchone():
                raise HTTPException(404, "Payment not found")
            db.execute("DELETE FROM we_owe_payments WHERE id=?", (payment_id,))
        return None

    return router
