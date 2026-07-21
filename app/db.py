from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

RECON_SHOP_CUSTOMER_ID = -1
RECON_SHOP_CUSTOMER_NAME = "Discount Auto — Shop-Owned Recon Inventory"
DEFAULT_REPORT_RECIPIENT = "walter4resultsnow@gmail.com"

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_shop_owned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  vin TEXT NOT NULL DEFAULT '',
  mileage INTEGER NOT NULL DEFAULT 0,
  plate TEXT NOT NULL DEFAULT '',
  plate_state TEXT NOT NULL DEFAULT '',
  trim TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recon_vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL UNIQUE REFERENCES vehicles(id) ON DELETE CASCADE,
  stock_number TEXT NOT NULL UNIQUE,
  acquisition_source TEXT NOT NULL DEFAULT '',
  acquisition_date TEXT NOT NULL DEFAULT '',
  purchase_price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'acquired',
  sale_price REAL,
  sale_date TEXT NOT NULL DEFAULT '',
  sale_customer_id INTEGER REFERENCES customers(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS we_owe_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  promised_at TEXT NOT NULL DEFAULT '',
  target_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  fulfilled_at TEXT NOT NULL DEFAULT '',
  sale_reference TEXT NOT NULL DEFAULT '',
  lot_stock_number TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  segment TEXT NOT NULL DEFAULT 'retail',
  recon_vehicle_id INTEGER REFERENCES recon_vehicles(id),
  we_owe_id INTEGER REFERENCES we_owe_items(id),
  concern TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  ai_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  labor_rate REAL NOT NULL,
  tax_rate REAL NOT NULL,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS estimate_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  part_number TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  received_quantity REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted',
  source TEXT NOT NULL DEFAULT 'manual',
  review_required INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_workflow (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  advisor_id INTEGER REFERENCES staff(id),
  technician_id INTEGER REFERENCES staff(id),
  odometer_in INTEGER NOT NULL DEFAULT 0,
  promised_at TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS order_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL,
  text TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  condition TEXT NOT NULL,
  measurement TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS estimate_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  estimate_id INTEGER NOT NULL REFERENCES estimates(id),
  status TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  method TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  number TEXT NOT NULL UNIQUE,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  part_number TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES customer_invoices(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS technician_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  account_number TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  invoice_number TEXT NOT NULL,
  normalized_invoice_number TEXT NOT NULL,
  po_number TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  UNIQUE(vendor_id, normalized_invoice_number)
);

CREATE TABLE IF NOT EXISTS ap_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ap_invoice_id INTEGER NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  vendor_text TEXT NOT NULL,
  po_number TEXT NOT NULL,
  status TEXT NOT NULL,
  issues TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  vendor_id INTEGER REFERENCES vendors(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  gmail_address TEXT NOT NULL DEFAULT '',
  gmail_app_password TEXT NOT NULL DEFAULT '',
  report_recipient TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sent_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        db.execute(
            "INSERT OR IGNORE INTO customers(id,name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,1,?)",
            (RECON_SHOP_CUSTOMER_ID, RECON_SHOP_CUSTOMER_NAME, "", "", now()),
        )
        db.execute(
            "INSERT OR IGNORE INTO app_settings(id,gmail_address,gmail_app_password,report_recipient,updated_at) VALUES(1,'','',?,?)",
            (DEFAULT_REPORT_RECIPIENT, now()),
        )


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db
