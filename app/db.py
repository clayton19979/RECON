from __future__ import annotations

import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path

RECON_SHOP_CUSTOMER_ID = -1
RECON_SHOP_CUSTOMER_NAME = "Discount Auto — Shop-Owned Recon Inventory"


def normalize_vin(vin: str | None) -> str | None:
    """The key two records of the same car have to agree on.

    Upper-cased with separators and spaces stripped, because the same VIN gets
    typed off a dash plate one day and pasted from a title the next. Returns
    None for anything empty -- a blank VIN must never collide with another
    blank VIN, or two unrelated cars would share one unit.
    """
    cleaned = "".join((vin or "").split()).replace("-", "").upper()
    return cleaned or None


_VIN_TRANSLITERATION = {
    **{str(d): d for d in range(10)},
    "A": 1, "B": 2, "C": 3, "D": 4, "E": 5, "F": 6, "G": 7, "H": 8,
    "J": 1, "K": 2, "L": 3, "M": 4, "N": 5, "P": 7, "R": 9,
    "S": 2, "T": 3, "U": 4, "V": 5, "W": 6, "X": 7, "Y": 8, "Z": 9,
}  # fmt: skip
# Position 9 is the check digit itself, so it contributes nothing to its own sum.
_VIN_WEIGHTS = (8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2)


def vin_check_digit_ok(vin: str | None) -> bool:
    """Does this 17-character VIN pass its own ISO 3779 check digit?

    The one arithmetic defence against a misread VIN, and worth having because
    of what a misread VIN does here specifically: `vehicle_units` keys on
    `vin_key`, so one wrong character silently splits a car's history in two --
    or, worse, collides it with a different car that happens to match. Neither
    shows up as an error; both just quietly report the wrong money later.

    That matters more now that VINs arrive by photo. A human typing off a dash
    plate makes few errors and usually notices; OCR confidently returns an 8
    for a B. Roughly 90% of single-character errors fail this check, so it
    turns most of them into a question instead of a corrupted record.

    Returns False for anything that isn't a well-formed 17-character VIN --
    wrong length, or containing I/O/Q, which the standard excludes precisely
    because they look like 1/0. Callers that accept partial VINs (the decode
    endpoint takes as few as 5 characters) must only apply this to full ones;
    a short VIN is not invalid, it just cannot be checked this way.

    Pre-1981 VINs predate the standard and legitimately fail. Those cars are
    long out of scope for a lot that sells drivable used inventory, but the
    caller should be reporting "I could not verify this, please confirm"
    rather than "this is wrong".
    """
    cleaned = normalize_vin(vin)
    if cleaned is None or len(cleaned) != 17:
        return False
    if any(ch in "IOQ" for ch in cleaned):
        return False
    total = 0
    for position, char in enumerate(cleaned):
        value = _VIN_TRANSLITERATION.get(char)
        if value is None:
            return False
        total += value * _VIN_WEIGHTS[position]
    remainder = total % 11
    expected = "X" if remainder == 10 else str(remainder)
    return cleaned[8] == expected


def normalize_stock_number(stock_number: str | None) -> str | None:
    """The key two records of the same *stock number* have to agree on.

    Same idea as normalize_vin, and for the same reason: R-1042 off the lot's
    sheet, R1042 typed in a hurry and "r 1042" read off a windshield are one
    car with one stock number, and the shop only ever means one of them. Only
    the separators go -- letters and digits are kept exactly as typed, so
    R-1042 and R-1043 stay the two different cars they are.
    """
    cleaned = "".join(ch for ch in (stock_number or "") if ch.isalnum()).upper()
    return cleaned or None


# A vendor's word for "purchase order" written any of the ways they write it,
# but only when a reference actually follows -- the lookahead is what stops
# this eating the start of a stock number like ROB-4, which is not one.
_PO_WORD = re.compile(r"^(?:P\.?O\.?|R\.?O\.?)[#:\-]*(?=R?\d)")


def normalize_po_reference(value: str | None) -> str:
    """A PO or RO reference reduced to the form two spellings of it share.

    Deliberately NOT the same as `accounting.normalize`, and the difference is
    the whole point: that one strips every non-alphanumeric character, which
    turns PO R20-2 into "R202" -- indistinguishable from repair order 202. The
    hyphen in a PO number separates the ticket from the batch, so it carries
    meaning and has to survive.

    Spaces and a leading PO/RO word go, since "PO R20-2", "po r20-2" and
    "R20-2" are one reference written three ways on three vendors' paperwork.
    """
    cleaned = "".join((value or "").split()).upper()
    return _PO_WORD.sub("", cleaned)


def purchase_order_number(ro_number: int, sequence: int) -> str:
    """The printed form of a PO: repair order 20's second batch is "R20-2".

    The leading R is there to be read on a vendor's invoice: this shop runs
    RECON alongside Tekmetric, both send purchase orders to the same suppliers,
    and a bare "20-2" on a bill gives no clue which system it came from. One
    character at the front answers that from across the desk.

    One function so the number an advisor reads off the screen, the number
    stored on the row, and the number A/P matches an arriving invoice against
    are all built the same way.
    """
    return f"R{ro_number}-{sequence}"


def next_ro_number(db: sqlite3.Connection) -> int:
    """The next short repair order number, counted shop-wide.

    Every segment draws from this one counter, so a recon ticket and a we-owe
    ticket can never both be RO 20. The unique index on the column is what
    actually enforces that -- this is the ordinary path, not the guarantee.
    """
    return int(db.execute("SELECT coalesce(max(ro_number),0)+1 FROM orders").fetchone()[0])


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address_line1 TEXT NOT NULL DEFAULT '',
  address_line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  is_shop_owned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

/* One physical car, across every owner it ever has.
 *
 * `vehicles` cannot play this role: it carries a NOT NULL customer_id, so the
 * same car recon'd under the shop's own account and then sold and brought back
 * on a we-owe is necessarily TWO vehicles rows with the same VIN and no link
 * between them. That split is why lifetime profit was unanswerable -- the
 * purchase price sat on one half and the post-sale repair cost on the other.
 *
 * A unit is found by VIN, so both halves resolve to the same row and the money
 * follows the car rather than the paperwork. Cars with no VIN on file still get
 * a unit of their own (vin_key NULL, excluded from the unique index), so
 * nothing depends on a VIN being present to work at all.
 */
CREATE TABLE IF NOT EXISTS vehicle_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin_key TEXT,
  purchase_price REAL NOT NULL DEFAULT 0,
  purchase_source TEXT NOT NULL DEFAULT '',
  purchase_date TEXT NOT NULL DEFAULT '',
  sale_price REAL,
  sale_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_units_vin ON vehicle_units(vin_key) WHERE vin_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  unit_id INTEGER REFERENCES vehicle_units(id),
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  vin TEXT NOT NULL DEFAULT '',
  mileage INTEGER NOT NULL DEFAULT 0,
  odometer_broken INTEGER NOT NULL DEFAULT 0,
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
  /* The number the shop actually says out loud: 1, 2, 3... one sequence
   * across recon, we-owe and retail alike, so no two tickets anywhere ever
   * answer to the same number.
   *
   * `number` above (RO-2607-0012) stays exactly as it was and is still what
   * older records, exports and already-posted vendor invoices refer to. It is
   * a fine internal handle and an awful thing to read down a phone line, which
   * is the whole reason this column exists -- and it is also why the two are
   * kept side by side rather than one replacing the other: every invoice
   * already sitting in A/P carries the long form as its PO text, and rewriting
   * history to match a new scheme would break the match on the bills the shop
   * has not paid yet.
   *
   * 0 means "not numbered yet", which only ever exists for the instant between
   * ALTER TABLE and the backfill below it in _migrate.
   */
  ro_number INTEGER NOT NULL DEFAULT 0,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  segment TEXT NOT NULL DEFAULT 'retail',
  recon_vehicle_id INTEGER REFERENCES recon_vehicles(id),
  we_owe_id INTEGER REFERENCES we_owe_items(id),
  concern TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'estimate',
  voided INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL DEFAULT ''
);

/* One batch of parts ordered from a vendor, against one ticket.
 *
 * The shop orders in batches -- you get on the phone once and order the four
 * things the car needs from that supplier -- and every batch needs its own
 * reference or the vendor's paperwork cannot be told apart when it comes back.
 * Before this table the PO handed to a vendor was simply the repair order
 * number, so four separate orders against one car all quoted the same PO and
 * receiving a delivery meant reading part numbers to work out which order it
 * was. That is the problem this exists to solve.
 *
 * `sequence` counts within the ticket and `number` is the printed form of the
 * pair: RO 20's second batch is PO 20-2. Both are stored rather than the
 * number being derived on read, because the number is said to a vendor and
 * written on their paperwork -- once it has been quoted it must never change,
 * including if the ticket is renumbered underneath it.
 *
 * vendor_id is nullable on purpose. The number is very often pulled *before*
 * anyone knows who is getting the order -- that is the point of pulling it --
 * and demanding a vendor up front would put a dialog in front of the one
 * action that has to stay a single click.
 */
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER REFERENCES vendors(id),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  /* When ordering against this batch finished -- set once and never cleared.
   *
   * A batch is open from the moment its number is pulled until the order is
   * placed, and parts marked ordered while it is open join it. That is what
   * makes ticking three lines one at a time and pressing Mark Parts Ordered
   * once give the vendor the same number: they are one phone call.
   *
   * Closing is what starts the next batch, and it has to be a stamp rather
   * than "does it still have lines on it", because a line can be deleted off a
   * ticket afterwards. That would empty a batch whose number a vendor is
   * already holding, and the next order would be handed the very same number
   * -- putting two deliveries under one PO, which is the exact thing this
   * table exists to stop. A stamp that only ever goes one way cannot be undone
   * by anything that happens to the lines later.
   */
  closed_at TEXT NOT NULL DEFAULT '',
  UNIQUE(order_id, sequence)
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
  /* What this line was written down at, before any vendor invoice touched it.
   *
   * unit_cost is what the shop actually pays, and receiving a part overwrites
   * it with the price the invoice really said -- which is right, and which
   * also destroyed the only record of what we thought it would cost. Every
   * "cost against quote" figure in the app was then comparing a number to
   * itself: a part quoted at 100 and billed at 175 reported quoted 175,
   * actual 175, and the board's Over Quote card could never say anything but
   * zero. The quote lives here so it survives the bill.
   *
   * NULL means "no separate quote recorded" -- rows written before this
   * column existed -- and every reader falls back to unit_cost for those,
   * which is exactly the answer they gave before.
   */
  quoted_unit_cost REAL,
  received_quantity REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted',
  -- When this line was marked ordered. Kept after it's received, so how long
  -- a part took to turn up stays answerable; see the migration in _migrate.
  ordered_at TEXT NOT NULL DEFAULT '',
  -- Which batch this part went out on, and so which PO number the vendor's
  -- paperwork for it will quote. NULL for a line nobody has ordered yet, and
  -- for every line ordered before purchase orders existed -- deliberately not
  -- backfilled, because the batch a part actually went out in is not
  -- recoverable after the fact and a guess here would be read as fact at the
  -- receiving bench.
  purchase_order_id INTEGER REFERENCES purchase_orders(id),
  received_invoice_number TEXT NOT NULL DEFAULT '',
  -- Who the part actually came from. See the migration in _migrate for why
  -- the invoice number above is not enough on its own.
  received_vendor_id INTEGER REFERENCES vendors(id),
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
  return_invoice_number TEXT NOT NULL DEFAULT '',
  core_return_invoice_number TEXT NOT NULL DEFAULT '',
  part_return_reference TEXT NOT NULL DEFAULT '',
  part_picked_up_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS estimate_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  technician_id INTEGER REFERENCES staff(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- A job is one repair on the car ("front brakes", "windshield"). Ticking it
  -- off is the only per-repair progress the app has: without it a car with
  -- four jobs reads exactly the same whether three are finished or none are,
  -- and "what does this car still need" could only ever be answered in money.
  -- Empty string, not NULL, so every "is it done" test is the same string
  -- test the other *_at flags on estimate_items already use.
  completed_at TEXT NOT NULL DEFAULT '',
  completed_by TEXT NOT NULL DEFAULT ''
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
  /* Nullable: not every vendor invoice belongs to a repair order. Shop
     supplies, a bulk oil delivery, a tool bill -- these are real money owed
     to a real vendor with no ticket to hang them on, and requiring one meant
     either inventing a ticket or keeping them out of RECON entirely. An
     invoice with no order simply doesn't roll into any vehicle's cost. */
  order_id INTEGER REFERENCES orders(id),
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
  line_total REAL NOT NULL,
  -- What the vendor is billing for on this line: 'part', 'core_charge',
  -- 'credit', 'freight', 'shop_supplies', 'labor'. The Accounting screen has
  -- always offered that choice and it used to be thrown away on the way in.
  kind TEXT NOT NULL DEFAULT 'part',
  -- The part line this billed line paid for, when it came from receiving on
  -- a ticket. Null for invoices typed in whole on the Accounting screen.
  estimate_item_id INTEGER REFERENCES estimate_items(id)
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
    """Shop-local wall-clock time, deliberately naive.

    This used to stamp UTC, and that quietly broke the report the whole app
    exists to produce. Every date filter in the UI is a local calendar date --
    a date picker, or a "This Month" chip -- and Indiana runs five hours behind
    UTC. So a car written down at 8pm Tuesday was stamped Wednesday, fell
    outside Tuesday's range, and vanished from the day's numbers; a car added
    on the evening of the 31st landed in the next month's report. The shop
    works evenings, so this was the normal case, not an edge case.

    One clock, the one on the wall, for everything an advisor filters or reads.
    Backup filenames keep their own UTC stamps -- those are sortable
    identifiers nobody filters by date, and they are consistent among
    themselves.
    """
    return datetime.now().isoformat(timespec="seconds")


def _migrate(db: sqlite3.Connection) -> None:
    """Idempotent ALTER TABLE steps for databases created before a column
    existed -- CREATE TABLE IF NOT EXISTS skips tables that already exist,
    so new columns need to be added in place for live databases."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(estimate_items)")}
    if "received_invoice_number" not in columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN received_invoice_number TEXT NOT NULL DEFAULT ''")

    # Where the part came from, as a real reference rather than a guess.
    #
    # A received line used to record only the invoice *number* it was posted
    # under, as loose text. Answering "who supplied this?" meant taking that
    # string and hunting for an invoice on the same ticket that happened to
    # carry the same number -- so the ticket could only ever show a number,
    # and the answer disappeared entirely the moment an invoice was moved or
    # its number was typed differently.
    if "received_vendor_id" not in columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN received_vendor_id INTEGER REFERENCES vendors(id)")
        # Backfill by the same string match the app used to do at read time,
        # so history keeps whatever answer it already had.
        db.execute(
            """UPDATE estimate_items SET received_vendor_id = (
                   SELECT a.vendor_id FROM ap_invoices a
                     JOIN estimates e ON e.id = estimate_items.estimate_id
                    WHERE a.order_id = e.order_id
                      AND a.invoice_number = estimate_items.received_invoice_number
                      AND a.status != 'voided'
                    ORDER BY a.id DESC LIMIT 1)
                 WHERE received_invoice_number != '' AND received_vendor_id IS NULL"""
        )

    # Which part line a billed line paid for. Without it the two halves of a
    # part's life -- what we quoted and what the vendor charged -- are joined
    # by nothing, so one invoice covering three cars cannot say which line
    # belongs to which car.
    ap_item_columns = {row[1] for row in db.execute("PRAGMA table_info(ap_invoice_items)")}
    if "estimate_item_id" not in ap_item_columns:
        db.execute("ALTER TABLE ap_invoice_items ADD COLUMN estimate_item_id INTEGER REFERENCES estimate_items(id)")
    # What the vendor billed for on this line. Needed to tell a core deposit
    # apart from the part it came with: the deposit is real money out that
    # comes back only when the old unit does, and reversing it later means
    # being able to find it. Everything already posted was a part or a
    # straight credit, and 'part' is the harmless default for both.
    if "kind" not in ap_item_columns:
        db.execute("ALTER TABLE ap_invoice_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'part'")

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

    # "How long has this car been sitting doing nothing" needs a timestamp that
    # moves when *work* happens. The board previously only had age (time since
    # acquisition, which never stops growing) and the vehicle row's own
    # updated_at, which only moves when someone patches the vehicle record
    # itself -- so a car a tech ordered parts for this morning still reported
    # weeks of nothing. orders.last_activity_at is bumped by every mutation
    # that touches a ticket (see workflow.touch_order), and a vehicle's idle
    # time is the newest one across its tickets.
    if "last_activity_at" not in order_columns:
        db.execute("ALTER TABLE orders ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''")
    # Backfill, and keep backfilling: any row still blank (pre-existing tickets
    # on first upgrade, and rows restored from an older backup afterwards) gets
    # the newest thing we can honestly point at -- its last logged activity
    # event, else its own creation. Scoped to '' so it never overwrites a live
    # value, which makes it a no-op on every subsequent start.
    db.execute(
        """UPDATE orders SET last_activity_at = coalesce(
               (SELECT max(a.created_at) FROM activity_events a WHERE a.order_id=orders.id),
               created_at)
           WHERE last_activity_at = ''"""
    )

    # Short repair order numbers -- 1, 2, 3 -- alongside the long RO-2607-0012
    # form, which stays put. See the column's comment in SCHEMA.
    #
    # The backfill runs oldest ticket first across every segment at once, so
    # recon, we-owe and retail share one sequence and no two tickets in the
    # shop can ever be "RO 20". It continues from the highest number already
    # handed out rather than recounting from 1, which is what makes it safe to
    # run again: a database restored from an older backup, or a ticket that
    # somehow arrives unnumbered, gets the next free number instead of one
    # already sitting on somebody's vendor paperwork.
    if "ro_number" not in order_columns:
        db.execute("ALTER TABLE orders ADD COLUMN ro_number INTEGER NOT NULL DEFAULT 0")
    unnumbered = db.execute("SELECT id FROM orders WHERE ro_number=0 ORDER BY created_at ASC, id ASC").fetchall()
    if unnumbered:
        next_ro = (db.execute("SELECT coalesce(max(ro_number),0) FROM orders").fetchone()[0] or 0) + 1
        for (order_id,) in unnumbered:
            db.execute("UPDATE orders SET ro_number=? WHERE id=?", (next_ro, order_id))
            next_ro += 1
    # Partial, excluding 0, and that exclusion is load-bearing rather than
    # tidiness: 0 is "not numbered yet", and more than one ticket can honestly
    # be in that state at once -- every row on an existing database is, for the
    # moment between the ALTER TABLE above and the backfill under it, and so is
    # anything written by a path that predates this column. A plain unique
    # index would make the second such row an IntegrityError instead of a
    # ticket waiting to be numbered on the next start.
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS orders_ro_number ON orders(ro_number) WHERE ro_number != 0")

    estimate_item_columns = {row[1] for row in db.execute("PRAGMA table_info(estimate_items)")}
    if "sort_order" not in estimate_item_columns:
        db.execute("ALTER TABLE estimate_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE estimate_items SET sort_order = id")

    # Guarded per column, not per feature-block: a database restored from a
    # backup can sit at ANY point in this file's history, including one where
    # a block's guard column exists but a column added to that same block
    # later does not -- a grouped guard then skips the missing column and the
    # first query that names it 500s.
    for column, ddl in (
        ("core_charge", "core_charge REAL NOT NULL DEFAULT 0"),
        ("core_returned", "core_returned INTEGER NOT NULL DEFAULT 0"),
        ("core_returned_at", "core_returned_at TEXT NOT NULL DEFAULT ''"),
        ("part_returned", "part_returned INTEGER NOT NULL DEFAULT 0"),
        ("part_returned_at", "part_returned_at TEXT NOT NULL DEFAULT ''"),
        ("return_invoice_number", "return_invoice_number TEXT NOT NULL DEFAULT ''"),
        # The vendor's credit paperwork for a returned core, recorded when it
        # arrives (a non-empty value is what marks the core Credited).
        ("core_return_invoice_number", "core_return_invoice_number TEXT NOT NULL DEFAULT ''"),
        ("part_return_reference", "part_return_reference TEXT NOT NULL DEFAULT ''"),
        # When the vendor actually collected the part. Empty means it's still
        # sitting at the shop waiting to go back -- the difference between
        # "I still have this" and "it's gone, waiting on their credit".
        ("part_picked_up_at", "part_picked_up_at TEXT NOT NULL DEFAULT ''"),
        # What the line was written down at, kept apart from what the vendor
        # eventually billed. Deliberately nullable with no backfill: on an
        # existing database every row arrives NULL, readers coalesce to
        # unit_cost, and the numbers on screen are unchanged until somebody
        # writes a new line. Backfilling would have to invent a written price
        # for parts already received at a price nobody can now compare to.
        # (This entry was silently dropped in the 2026-07-31 merge wave while
        # the CREATE TABLE kept the column -- fresh databases worked, every
        # existing one 500'd on the first board load. Tests build fresh
        # databases, which is exactly why they never caught it.)
        ("quoted_unit_cost", "quoted_unit_cost REAL"),
        # When a part line was marked ordered. Without it, a part ordered this
        # morning and one ordered three weeks ago were indistinguishable
        # everywhere in the app -- and a part nobody chases is the most common
        # reason a car sits on the lot doing nothing.
        #
        # Deliberately NOT backfilled. Lines already sitting on 'ordered' when
        # this shipped were never stamped, and there is nothing honest to
        # stamp them with: the action logs no event and the ticket's own dates
        # answer a different question. They report the date as unrecorded and
        # say so on screen, rather than wearing a plausible invention.
        ("ordered_at", "ordered_at TEXT NOT NULL DEFAULT ''"),
        # Which batch this part was ordered on. Not backfilled -- see the
        # column's comment in SCHEMA for why inventing one would be worse
        # than leaving it blank.
        ("purchase_order_id", "purchase_order_id INTEGER REFERENCES purchase_orders(id)"),
    ):
        if column not in estimate_item_columns:
            db.execute(f"ALTER TABLE estimate_items ADD COLUMN {ddl}")

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

    # Per-repair progress on a ticket. Purely additive: every job in an
    # existing database comes back as not-yet-done, which is exactly what the
    # app assumed before this column existed, so no live record changes
    # meaning and nothing has to be re-entered.
    job_columns = {row[1] for row in db.execute("PRAGMA table_info(estimate_jobs)")}
    for column in ("completed_at", "completed_by"):
        if column not in job_columns:
            db.execute(f"ALTER TABLE estimate_jobs ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")

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

    # A we-owe customer is a real person with a mailing address, not just a
    # name and phone -- these columns were added after the first releases, so
    # live databases need them backfilled in place with empty defaults.
    customer_columns = {row[1] for row in db.execute("PRAGMA table_info(customers)")}
    for column in ("address_line1", "address_line2", "city", "state", "postal_code"):
        if column not in customer_columns:
            db.execute(f"ALTER TABLE customers ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")

    vehicle_columns = {row[1] for row in db.execute("PRAGMA table_info(vehicles)")}
    if "unit_id" not in vehicle_columns:
        db.execute("ALTER TABLE vehicles ADD COLUMN unit_id INTEGER REFERENCES vehicle_units(id)")
    # Mileage of 0 used to mean two different things -- "the odometer is
    # broken" and "nobody was asked" -- which made every zero unreadable after
    # the fact. The flag makes an unknown reading a deliberate, recorded state.
    if "odometer_broken" not in vehicle_columns:
        db.execute("ALTER TABLE vehicles ADD COLUMN odometer_broken INTEGER NOT NULL DEFAULT 0")

    # Give every vehicle row a unit, matching on VIN so the recon-side and
    # we-owe-side rows for one physical car land on the same one. Scoped to
    # unit_id IS NULL, so this is a no-op on every start after the first and
    # picks up exactly the rows a restored older backup brings with it.
    ts = now()
    for vehicle_id, vin in db.execute("SELECT id, vin FROM vehicles WHERE unit_id IS NULL").fetchall():
        key = normalize_vin(vin)
        existing = db.execute("SELECT id FROM vehicle_units WHERE vin_key=?", (key,)).fetchone() if key else None
        if existing:
            unit_id = existing[0]
        else:
            unit_id = db.execute(
                "INSERT INTO vehicle_units(vin_key,created_at,updated_at) VALUES(?,?,?)", (key, ts, ts)
            ).lastrowid
        db.execute("UPDATE vehicles SET unit_id=? WHERE id=?", (unit_id, vehicle_id))

    # Move the recon record's economics onto the unit that now owns them.
    # Guarded on the unit still being blank, so a purchase price entered
    # through the new path is never overwritten by the old column it replaced.
    for unit_id, price, source, date, sale_price, sale_date in db.execute(
        """SELECT u.id, rv.purchase_price, rv.acquisition_source, rv.acquisition_date, rv.sale_price, rv.sale_date
           FROM recon_vehicles rv
           JOIN vehicles v ON v.id = rv.vehicle_id
           JOIN vehicle_units u ON u.id = v.unit_id
           WHERE u.purchase_price = 0 AND u.sale_price IS NULL AND u.purchase_date = '' AND u.sale_date = ''"""
    ).fetchall():
        db.execute(
            """UPDATE vehicle_units SET purchase_price=?, purchase_source=?, purchase_date=?,
                                        sale_price=?, sale_date=?, updated_at=? WHERE id=?""",
            (price, source, date, sale_price, sale_date, ts, unit_id),
        )


def _relax_ap_invoice_order_link(path: Path) -> None:
    """Let a vendor invoice exist without a repair order behind it.

    `ap_invoices.order_id` shipped as NOT NULL, so every invoice had to belong
    to a ticket -- there was no way to record a bill for shop supplies, a bulk
    oil delivery or a tool purchase without inventing a repair order to hang
    it on. SQLite can't relax a column constraint in place, so the table is
    rebuilt once, on databases still carrying the old shape.

    This runs on its OWN connection with foreign keys off, and that is
    load-bearing: `ap_invoice_items` references `ap_invoices` with ON DELETE
    CASCADE, and DROP TABLE fires cascades when foreign keys are enabled --
    dropping the old table mid-rebuild would silently take every invoice line
    item in the database with it.
    """
    with closing(sqlite3.connect(path)) as db:
        columns = {row[1]: row[3] for row in db.execute("PRAGMA table_info(ap_invoices)")}
        if columns.get("order_id") != 1:
            return  # already nullable, or the table doesn't exist yet
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("BEGIN")
        try:
            db.execute("""CREATE TABLE ap_invoices_rebuilt (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
                  order_id INTEGER REFERENCES orders(id),
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
                )""")
            db.execute("""INSERT INTO ap_invoices_rebuilt
                          SELECT id,vendor_id,order_id,invoice_number,normalized_invoice_number,
                                 po_number,subtotal,tax,total,status,source,posted_at
                          FROM ap_invoices""")
            db.execute("DROP TABLE ap_invoices")
            db.execute("ALTER TABLE ap_invoices_rebuilt RENAME TO ap_invoices")
            violations = db.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(f"A/P invoice migration would orphan rows: {violations[:3]}")
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
        finally:
            db.execute("PRAGMA foreign_keys=ON")


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # `closing` is doing real work here: sqlite3.Connection.__exit__ commits or
    # rolls back but leaves the handle OPEN. Windows then refuses to rename or
    # unlink the file -- which is exactly how reset_db used to die with
    # "WinError 32: being used by another process". The trailing `, db` keeps
    # the commit-on-success transaction the plain `with` gave us.
    # Before _migrate: it needs its own connection with foreign keys off, and
    # SCHEMA's CREATE TABLE IF NOT EXISTS won't reshape a table that already
    # exists, so an upgraded database still arrives here with the old one.
    _relax_ap_invoice_order_link(path)
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript(SCHEMA)
        _migrate(db)
        db.execute(
            "INSERT OR IGNORE INTO customers(id,name,phone,email,is_shop_owned,created_at) VALUES(?,?,?,?,1,?)",
            (RECON_SHOP_CUSTOMER_ID, RECON_SHOP_CUSTOMER_NAME, "", "", now()),
        )


class _ClosingConnection(sqlite3.Connection):
    """A connection that actually closes when its `with` block ends.

    Stock sqlite3.Connection.__exit__ commits or rolls back and then leaves the
    handle open, so the database file stays locked until the object happens to
    be collected -- the trap that made init_db's rename fail on Windows. Every
    caller here is `with connect() as db:` and reads its rows inside the block,
    so closing at the end of it is what the code already assumed was happening.
    """

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def inserted_id(cur: sqlite3.Cursor) -> int:
    """lastrowid immediately after an INSERT. sqlite3 types it Optional
    because it is None after other statement kinds; after an INSERT it is
    always set, and every caller wants a plain int for the new row."""
    rowid = cur.lastrowid
    assert rowid is not None
    return rowid


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path, factory=_ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def reset_db(path: Path, backup_suffix: str = ".pre-reset.bak") -> Path | None:
    """Move an existing database (and its WAL/SHM sidecars) aside, then
    recreate it empty.

    Nothing is ever deleted: each file is renamed to <file><backup_suffix>,
    clobbering only a previous backup with the same suffix. Returns the
    backup path of the main db file, or None if there was nothing to move.

    Lives here rather than in seed_mock_data so "give me a clean database"
    is available without dragging in the mock dataset (or the TestClient
    import chain it rides on).
    """
    import shutil

    moved = None
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(path) + suffix)
        if src.is_file():
            dest = Path(str(src) + backup_suffix)
            shutil.move(str(src), str(dest))
            if suffix == "":
                moved = dest
    init_db(path)
    return moved
