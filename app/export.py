from __future__ import annotations

import csv
import io
import sqlite3
from collections.abc import Callable
from datetime import date
from typing import Literal

from fastapi import APIRouter, Response

from .db import normalize_vin
from .recon import vehicle_board_rows
from .reports import technician_productivity_rows, vehicle_profit_rows
from .workflow import STATUS_LABEL


def _csv_response(header: list[str], rows: list[list], slug: str) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    filename = f"discount-auto-ops-{slug}-{date.today():%Y-%m-%d}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _linked_invoices(db: sqlite3.Connection, order_ids: list[int]) -> str:
    if not order_ids:
        return ""
    placeholders = ",".join("?" for _ in order_ids)
    rows = db.execute(
        f"""SELECT a.invoice_number, a.total, v.name vendor_name
            FROM ap_invoices a JOIN vendors v ON v.id=a.vendor_id
            WHERE a.order_id IN ({placeholders}) ORDER BY a.id""",
        order_ids,
    ).fetchall()
    return "; ".join(f"{row['invoice_number']} ({row['vendor_name']}, ${row['total']:.2f})" for row in rows)


def build_export_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/export/vehicles.csv")
    def export_vehicles_csv():
        with connect() as db:
            rows = vehicle_board_rows(db)
            order_ids_by_row = []
            for row in rows:
                column = "recon_vehicle_id" if row["segment"] == "recon" else "we_owe_id"
                ref_id = row["recon_id"] if row["segment"] == "recon" else row["we_owe_id"]
                order_ids = [o["id"] for o in db.execute(f"SELECT id FROM orders WHERE {column}=?", (ref_id,))]
                order_ids_by_row.append(order_ids)

            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(
                [
                    "Stock #/Customer",
                    "Vehicle",
                    "VIN",
                    "Segment",
                    "Status",
                    "Age (days)",
                    "What's In It",
                    "Linked Vendor Invoices",
                    "Updated At",
                ]
            )
            for row, order_ids in zip(rows, order_ids_by_row):
                label = row["stock_number"] or row.get("customer_name", "")
                writer.writerow(
                    [
                        label,
                        row["vehicle"],
                        row.get("vin", ""),
                        "Recon" if row["segment"] == "recon" else "We-Owe",
                        STATUS_LABEL.get(row["status"], row["status"]),
                        row["age_days"],
                        f"{row['actual_cost']:.2f}",
                        _linked_invoices(db, order_ids),
                        row["updated_at"],
                    ]
                )

        filename = f"discount-auto-ops-export-{date.today():%Y-%m-%d}.csv"
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # The Reports screen's Download CSV. Deliberately the same query string
    # the report itself is fetched with, and built from the same row builders,
    # so the file can't disagree with what's on screen -- the alternative,
    # serialising the rows in the browser, drifts the moment either rollup
    # changes and can only ever export what happens to be loaded.
    @router.get("/export/report/vehicle-spend.csv")
    def export_vehicle_spend_csv(
        start: str | None = None,
        end: str | None = None,
        segment: Literal["recon", "we_owe"] | None = None,
    ):
        with connect() as db:
            rows = vehicle_board_rows(db, start, end, segment)
        return _csv_response(
            [
                "Stock #",
                "Vehicle",
                "VIN",
                "Type",
                "Status",
                "Technicians",
                "Quoted",
                "Cost",
                "Customer Paid",
                "Net to Shop",
                "Age (days)",
            ],
            [
                [
                    row["stock_number"] or row.get("customer_name", ""),
                    row["vehicle"],
                    row.get("vin", ""),
                    "Recon" if row["segment"] == "recon" else "We-Owe",
                    STATUS_LABEL.get(row["status"], row["status"]),
                    ", ".join(row.get("technicians") or []),
                    f"{row.get('quoted_cost') or 0:.2f}",
                    f"{row['actual_cost']:.2f}",
                    f"{row.get('customer_paid') or 0:.2f}",
                    f"{row.get('net_cost', row['actual_cost']):.2f}",
                    row["age_days"],
                ]
                for row in rows
            ],
            f"vehicle-spend-{segment}" if segment else "vehicle-spend",
        )

    @router.get("/export/report/vehicle-profit.csv")
    def export_vehicle_profit_csv(start: str | None = None, end: str | None = None, vin: str | None = None):
        """The bookkeeper's version of the profit report: one row per physical
        car, with the three costs kept as separate columns so the arithmetic
        behind the profit figure is auditable rather than a single number to
        be taken on faith."""
        with connect() as db:
            rows = vehicle_profit_rows(db, start, end, normalize_vin(vin))
        return _csv_response(
            [
                "Stock #",
                "Vehicle",
                "VIN",
                "Labor Hours",
                "Purchase Price",
                "Recon Cost",
                "We-Owe Cost",
                "Customer Paid",
                "Total Invested",
                "Sale Price",
                "Profit",
                "Margin %",
            ],
            [
                [
                    row["stock_number"],
                    row["vehicle"],
                    row["vin"],
                    f"{row['labor_hours']:.2f}",
                    f"{row['purchase_price']:.2f}",
                    f"{row['recon_cost']:.2f}",
                    f"{row['we_owe_cost']:.2f}",
                    f"{row['we_owe_customer_paid']:.2f}",
                    f"{row['total_invested']:.2f}",
                    "" if row["sale_price"] is None else f"{row['sale_price']:.2f}",
                    "" if row["profit"] is None else f"{row['profit']:.2f}",
                    "" if row["margin_pct"] is None else f"{row['margin_pct']:.1f}",
                ]
                for row in rows
            ],
            "vehicle-profit",
        )

    @router.get("/export/report/technicians.csv")
    def export_technicians_csv(start: str | None = None, end: str | None = None):
        with connect() as db:
            rows = technician_productivity_rows(db, start, end)
        return _csv_response(
            ["Technician", "Repair Orders", "Completed", "Labor Hours", "Labor Cost"],
            [
                [
                    row["technician"],
                    row["ro_count"],
                    row["completed_count"],
                    f"{row['labor_hours']:.2f}",
                    f"{row['labor_cost']:.2f}",
                ]
                for row in rows
            ],
            "technicians",
        )

    return router
