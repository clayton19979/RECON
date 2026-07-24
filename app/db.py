from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

RECON_SHOP_CUSTOMER_ID = -1
RECON_SHOP_CUSTOMER_NAME = "Discount Auto — Shop-Owned Recon Inventory"

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
  updated_at TEXT NOT NULL,
  edit_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT NOT NULL DEFAULT ''
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
  updated_at TEXT NOT NULL,
  edit_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS we_owe_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  we_owe_id INTEGER NOT NULL REFERENCES we_owe_items(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
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
  status TEXT NOT NULL DEFAULT 'estimate',
  voided INTEGER NOT NULL DEFAULT 0,
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
  created_at TEXT NOT NULL,
  edit_version INTEGER NOT NULL DEFAULT 1
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
  received_invoice_number TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  review_required INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  core_charge REAL NOT NULL DEFAULT 0,
  core_returned INTEGER NOT NULL DEFAULT 0,
  core_returned_at TEXT NOT NULL DEFAULT '',
  part_returned INTEGER NOT NULL DEFAULT 0,
  part_returned_at TEXT NOT NULL DEFAULT '',
  return_invoice_number TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS estimate_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  technician_id INTEGER REFERENCES staff(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
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
  date_in TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  urgent INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  order_id INTEGER REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _migrate(db: sqlite3.Connection) -> None:
    """Idempotent ALTER TABLE steps for databases created before a column
    existed -- CREATE TABLE IF NOT EXISTS skips tables that already exist,
    so new columns need to be added in place for live databases."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(estimate_items)")}
    if "received_invoice_number" not in columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN received_invoice_number TEXT NOT NULL DEFAULT ''")

    # The Gmail email-report and PartsTech integrations were removed --
    # neither ever had a working real integration behind it (PartsTech was
    # just a link-out button; partstech_username/api_key were dead columns
    # nothing ever read or wrote), and Gmail's app-password flow never
    # reliably connected. Dropped rather than left behind unused.
    db.execute("DROP TABLE IF EXISTS app_settings")
    db.execute("DROP TABLE IF EXISTS sent_reports")

    # order_workflow gets a version bump on every assignment save already;
    # recon_vehicles/we_owe_items/estimates need one too, so two people
    # editing the same record at once can be detected instead of one
    # silently overwriting the other's changes (the estimate is the highest
    # risk -- saving replaces the whole line-item set).
    for table in ("recon_vehicles", "we_owe_items", "estimates"):
        cols = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        if "edit_version" not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1")

    order_columns = {row[1] for row in db.execute("PRAGMA table_info(orders)")}
    if "voided" not in order_columns:
        db.execute("ALTER TABLE orders ADD COLUMN voided INTEGER NOT NULL DEFAULT 0")

    estimate_item_columns = {row[1] for row in db.execute("PRAGMA table_info(estimate_items)")}
    if "sort_order" not in estimate_item_columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE estimate_items SET sort_order = id")

    if "core_charge" not in estimate_item_columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN core_charge REAL NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE estimate_items ADD COLUMN core_returned INTEGER NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE estimate_items ADD COLUMN core_returned_at TEXT NOT NULL DEFAULT ''")

    if "part_returned" not in estimate_item_columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN part_returned INTEGER NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE estimate_items ADD COLUMN part_returned_at TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE estimate_items ADD COLUMN return_invoice_number TEXT NOT NULL DEFAULT ''")

    task_columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
    if "order_id" not in task_columns:
        db.execute("ALTER TABLE tasks ADD COLUMN order_id INTEGER REFERENCES orders(id)")

    for table in ("recon_vehicles", "we_owe_items"):
        cols = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        if "archived_at" not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''")

    if "job_id" not in estimate_item_columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN job_id INTEGER REFERENCES estimate_jobs(id)")

    # Status vocabulary simplified from 8 workflow states with gated
    # transitions down to 4 plain values (estimate/pending_approval/
    # in_progress/complete) with no gating -- old rows are migrated forward,
    # never dropped. Cancelled ROs become complete+voided so their cost still
    # never counts toward vehicle profit (see cost_rollup's `voided` filter),
    # matching the old cancelled-excludes-cost behavior exactly. These UPDATEs
    # are naturally idempotent: once no row matches the old values, each is a
    # no-op on every subsequent app start.
    db.execute("UPDATE orders SET status='estimate' WHERE status IN ('draft','inspection')")
    db.execute("UPDATE orders SET status='pending_approval' WHERE status='awaiting_approval'")
    db.execute("UPDATE orders SET status='in_progress' WHERE status='approved'")
    db.execute("UPDATE orders SET status='complete' WHERE status IN ('completed','closed')")
    db.execute("UPDATE orders SET status='complete', voided=1 WHERE status='cancelled'")

    # tasks.assigned_to moved from a single free-text name to a JSON array
    # so a task can have more than one assignee. Old rows hold a plain
    # string (or ''), which isn't valid JSON, so json.loads raises and we
    # wrap it into a one-name list (or an empty list); already-migrated
    # rows parse as a list and are left alone, making this idempotent.
    for task_id, assigned_to in db.execute("SELECT id, assigned_to FROM tasks").fetchall():
        raw = assigned_to or ""
        try:
            if isinstance(json.loads(raw), list):
                continue
        except (json.JSONDecodeError, TypeError):
            pass
        db.execute("UPDATE tasks SET assigned_to=? WHERE id=?", (json.dumps([raw] if raw else []), task_id))

    workflow_columns = {row[1] for row in db.execute("PRAGMA table_info(order_workflow)")}
    if "date_in" not in workflow_columns:
        db.execute("ALTER TABLE order_workflow ADD COLUMN date_in TEXT NOT NULL DEFAULT ''")
        # Backfill existing tickets from their own creation date rather than
        # leaving Date In blank on every RO that already existed -- it's the
        # same default a brand-new order gets, just applied retroactively.
        db.execute("""UPDATE order_workflow
                      SET date_in = (SELECT substr(o.created_at,1,10) FROM orders o WHERE o.id=order_workflow.order_id)
                      WHERE date_in = ''""")

    # "partstech" is no longer an accepted source (the integration was just
    # a link-out button, removed) -- any existing lines added through it
    # are relabeled "manual" so a future re-save of that estimate doesn't
    # fail validation on a value the API no longer accepts.
    db.execute("UPDATE estimate_items SET source='manual' WHERE source='partstech'")


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript(SCHEMA)
        _migrate(db)
        db.execute(
            "INSERT OR IGNORE INTO customers(id,name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,1,?)",
            (RECON_SHOP_CUSTOMER_ID, RECON_SHOP_CUSTOMER_NAME, "", "", now()),
        )


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db
