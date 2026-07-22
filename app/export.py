from __future__ import annotations

import csv
import io
import sqlite3
from datetime import date
from typing import Callable

from fastapi import APIRouter, Response

from .recon import vehicle_board_rows
from .workflow import STATUS_LABEL


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
            writer.writerow([
                "Stock #/Customer", "Vehicle", "VIN", "Segment", "Status", "Age (days)",
                "What's In It", "Linked Vendor Invoices", "Updated At",
            ])
            for row, order_ids in zip(rows, order_ids_by_row):
                label = row["stock_number"] or row.get("customer_name", "")
                writer.writerow([
                    label,
                    row["vehicle"],
                    row.get("vin", ""),
                    "Recon" if row["segment"] == "recon" else "We-Owe",
                    STATUS_LABEL.get(row["status"], row["status"]),
                    row["age_days"],
                    f"{row['actual_cost']:.2f}",
                    _linked_invoices(db, order_ids),
                    row["updated_at"],
                ])

        filename = f"discount-auto-ops-export-{date.today():%Y-%m-%d}.csv"
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return router
