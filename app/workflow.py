from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID
from .recon import assert_vehicle_editable


class StaffIn(BaseModel):
    name: str = Field(min_length=1)
    role: Literal["advisor", "technician", "manager"]


class StaffPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    role: Literal["advisor", "technician", "manager"] | None = None
    active: bool | None = None


class AssignmentIn(BaseModel):
    advisor_id: int | None = None
    technician_id: int | None = None
    date_in: str = ""
    odometer_in: int = Field(default=0, ge=0)
    promised_at: str = ""
    actor: str = "ui"


class NoteIn(BaseModel):
    visibility: Literal["internal", "customer"] = "internal"
    text: str = Field(min_length=1)
    actor: str = "ui"


class InspectionItemIn(BaseModel):
    category: str = Field(min_length=1)
    name: str = Field(min_length=1)
    condition: Literal["green", "yellow", "red", "not_checked"]
    measurement: str = ""
    notes: str = ""


class InspectionIn(BaseModel):
    status: Literal["draft", "completed"] = "draft"
    items: list[InspectionItemIn]
    actor: str = "ui"


class FindingItem(BaseModel):
    kind: Literal["part", "labor", "fee"]
    description: str = Field(min_length=1, max_length=300)
    quantity: float = Field(gt=0, le=1000)
    unit_price: float = Field(ge=0, le=1_000_000)
    part_number: str = Field(default="", max_length=100)
    unit_cost: float = Field(default=0, ge=0, le=1_000_000)


class FindingsIn(BaseModel):
    summary: str = Field(min_length=3, max_length=5000)
    actor: str = Field(default="technician", min_length=1, max_length=120)
    items: list[FindingItem] = Field(default_factory=list, max_length=100)


class AuthorizationIn(BaseModel):
    status: Literal["approved", "declined"]
    approved_by: str = Field(min_length=1)
    method: Literal["in_person", "phone", "sms", "email", "other"]
    note: str = ""
    actor: str = "ui"


class SegmentMoveIn(BaseModel):
    """Which side of the shop the ticket should belong to, and which record
    on that side it attaches to. Retail is deliberately not a destination:
    a retail ticket is a customer's own car with no lot record behind it, so
    there's nothing for the cost to move onto."""

    segment: Literal["recon", "we_owe"]
    recon_vehicle_id: int | None = None
    we_owe_id: int | None = None
    actor: str = "ui"


class ActorIn(BaseModel):
    actor: str = "ui"


class PaymentIn(BaseModel):
    amount: float = Field(gt=0)
    method: Literal["cash", "card", "check", "bank", "other"]
    reference: str = ""
    actor: str = "ui"


class StatusIn(BaseModel):
    status: Literal["estimate", "pending_approval", "in_progress", "complete"]
    actor: str = "ui"


class ConcernIn(BaseModel):
    concern: str = Field(min_length=3, max_length=2000)
    actor: str = "ui"


STATUS_LABEL = {
    "estimate": "Estimate",
    "pending_approval": "Pending Approval",
    "in_progress": "In Progress",
    "complete": "Complete",
}

SEGMENT_LABEL = {"recon": "recon", "we_owe": "we-owe", "retail": "retail"}


def cents(value: float | str | Decimal) -> int:
    return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def dollars(value: int) -> float:
    return float(Decimal(value) / 100)


CREDIT_KINDS = frozenset({"credit"})


def estimate_line_total(kind: str, quantity: float, unit_price: float) -> float:
    """What one estimate line contributes to the estimate's subtotal.

    A vendor credit -- a returned part, a refunded core -- is stored the way it
    reads on the vendor's own paperwork: positive quantity, positive cost, so
    "1 x $150.00" round-trips through the grid and prints legibly. The fact
    that it SUBTRACTS is therefore not visible in the row's numbers, and every
    place that summed quantity * unit_price got it backwards: a $150 credit
    raised the car's cost by $150.

    That sign lives here so there is one answer. Getting it wrong is silent --
    a credit that adds looks like an ordinary cost increase, and the lifetime
    profit the vehicle_units design exists to answer is simply wrong, with
    nothing on screen to notice.
    """
    total = round(quantity * unit_price, 2)
    return -total if kind in CREDIT_KINDS else total


def touch_order(db: sqlite3.Connection, order_id: int, now_fn: Callable[[], str]) -> None:
    """Mark a ticket as having just been worked on.

    The board's Idle column answers "when did anything last happen to this
    car", which is a different question from age (time since acquisition,
    which grows whether anyone touches the car or not) and from the vehicle
    row's updated_at (which only moves when the vehicle record itself is
    patched -- correcting a VIN, not ordering a part).

    Every mutating route funnels through here. Almost all of them get it for
    free because record_activity() calls it, which is deliberate: an action
    worth writing to the activity log is by definition activity. The few
    writes that don't log an event -- notably saving the estimate grid, which
    autosaves and would bury the log in noise -- call this directly."""
    db.execute("UPDATE orders SET last_activity_at=? WHERE id=?", (now_fn(), order_id))


def record_activity(
    db: sqlite3.Connection, order_id: int, action: str, actor: str, details: dict, now_fn: Callable[[], str]
) -> None:
    db.execute(
        "INSERT INTO activity_events(order_id,action,actor,details,created_at) VALUES(?,?,?,?,?)",
        (order_id, action, actor.strip() or "unknown", json.dumps(details, sort_keys=True), now_fn()),
    )
    touch_order(db, order_id, now_fn)


def initialize_order_workflow(
    db: sqlite3.Connection, order_id: int, now_fn: Callable[[], str], actor: str = "ui"
) -> None:
    # Date In defaults to the moment the ticket itself was created -- the
    # advisor can still correct it (e.g. the car actually arrived a day
    # earlier than the ticket got typed up) via the Assigned card's save.
    db.execute("INSERT OR IGNORE INTO order_workflow(order_id, date_in) VALUES(?,?)", (order_id, now_fn()[:10]))
    record_activity(db, order_id, "order_created", actor, {}, now_fn)


def assert_estimate_editable(db: sqlite3.Connection, order_id: int) -> None:
    """Recon/we-owe work is internal at-cost tracking with no customer
    authorization step, so the advisor has full control to correct a line at
    any time -- approval status and received parts no longer lock editing.
    The one real boundary is a customer invoice that's already been billed
    out (retail only): once that exists, line items are frozen."""
    if db.execute("SELECT 1 FROM customer_invoices WHERE order_id=?", (order_id,)).fetchone():
        raise HTTPException(409, "Invoiced estimates are locked")


def get_or_create_estimate(db: sqlite3.Connection, order_id: int, now_fn: Callable[[], str]) -> sqlite3.Row:
    """Estimates are created lazily on first write (a line item or now a
    job) -- a ticket with no parts/labor yet has no estimates row at all."""
    row = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
    if row:
        return row
    db.execute(
        "INSERT INTO estimates(order_id,labor_rate,tax_rate,subtotal,tax,total,created_at) VALUES(?,0,0,0,0,0,?)",
        (order_id, now_fn()),
    )
    return db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()


def invoice_dict(db: sqlite3.Connection, row: sqlite3.Row | None) -> dict | None:
    if not row:
        return None
    result = dict(row)
    for name in ("subtotal", "tax", "total", "balance"):
        result[name] = dollars(result.pop(f"{name}_cents"))
    result["items"] = []
    for item in db.execute("SELECT * FROM customer_invoice_items WHERE invoice_id=? ORDER BY id", (row["id"],)):
        value = dict(item)
        value["unit_price"] = dollars(value.pop("unit_price_cents"))
        value["line_total"] = dollars(value.pop("line_total_cents"))
        result["items"].append(value)
    result["payments"] = []
    for payment in db.execute("SELECT * FROM payments WHERE invoice_id=? ORDER BY id", (row["id"],)):
        value = dict(payment)
        value["amount"] = dollars(value.pop("amount_cents"))
        result["payments"].append(value)
    return result


def workflow_detail(db: sqlite3.Connection, order_id: int) -> dict:
    assignment = db.execute(
        """SELECT w.*, a.name advisor_name, t.name technician_name
           FROM order_workflow w LEFT JOIN staff a ON a.id=w.advisor_id LEFT JOIN staff t ON t.id=w.technician_id
           WHERE w.order_id=?""",
        (order_id,),
    ).fetchone()
    inspection = db.execute("SELECT * FROM inspections WHERE order_id=?", (order_id,)).fetchone()
    inspection_value = dict(inspection) if inspection else None
    if inspection_value:
        inspection_value["items"] = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY id", (inspection["id"],)
            )
        ]
    authorization = db.execute(
        "SELECT * FROM estimate_authorizations WHERE order_id=? ORDER BY id DESC LIMIT 1", (order_id,)
    ).fetchone()
    invoice = db.execute("SELECT * FROM customer_invoices WHERE order_id=?", (order_id,)).fetchone()
    findings = [
        dict(row)
        for row in db.execute("SELECT * FROM technician_findings WHERE order_id=? ORDER BY id DESC", (order_id,))
    ]
    activity = []
    for row in db.execute("SELECT * FROM activity_events WHERE order_id=? ORDER BY id", (order_id,)):
        value = dict(row)
        value["details"] = json.loads(value["details"])
        activity.append(value)
    return {
        "assignment": dict(assignment) if assignment else None,
        "inspection": inspection_value,
        "notes": [
            dict(row) for row in db.execute("SELECT * FROM order_notes WHERE order_id=? ORDER BY id DESC", (order_id,))
        ],
        "authorization": dict(authorization) if authorization else None,
        "invoice": invoice_dict(db, invoice),
        "findings": findings,
        "activity": activity,
    }


def build_workflow_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def order(db: sqlite3.Connection, order_id: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Repair order not found")
        return row

    @router.get("/staff")
    def list_staff(include_inactive: bool = False):
        with connect() as db:
            query = (
                "SELECT * FROM staff ORDER BY name"
                if include_inactive
                else "SELECT * FROM staff WHERE active=1 ORDER BY name"
            )
            return [dict(row) for row in db.execute(query)]

    def _assert_name_free(db, name: str, exclude_id: int | None = None) -> None:
        # Assignment pickers, task owners and reports all identify staff by
        # name alone, so two "Ray Ortiz" rows would be indistinguishable
        # everywhere forever. The front end refuses duplicates too, but the
        # API is the last line -- and the only line for bulk imports.
        row = db.execute(
            "SELECT id FROM staff WHERE lower(name)=lower(?)" + (" AND id!=?" if exclude_id is not None else ""),
            (name, exclude_id) if exclude_id is not None else (name,),
        ).fetchone()
        if row:
            raise HTTPException(409, "Someone with that name is already on staff")

    @router.post("/staff", status_code=201)
    def create_staff(item: StaffIn):
        with connect() as db:
            _assert_name_free(db, item.name.strip())
            cur = db.execute(
                "INSERT INTO staff(name,role,created_at) VALUES(?,?,?)", (item.name.strip(), item.role, now_fn())
            )
            return dict(db.execute("SELECT * FROM staff WHERE id=?", (cur.lastrowid,)).fetchone())

    @router.patch("/staff/{staff_id}")
    def update_staff(staff_id: int, item: StaffPatch):
        with connect() as db:
            row = db.execute("SELECT name FROM staff WHERE id=?", (staff_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Staff member not found")
            old_name = row["name"]
            fields: list[str] = []
            params: list[object] = []
            if item.name is not None:
                _assert_name_free(db, item.name.strip(), exclude_id=staff_id)
                fields.append("name=?")
                params.append(item.name.strip())
            if item.role is not None:
                fields.append("role=?")
                params.append(item.role)
            if item.active is not None:
                fields.append("active=?")
                params.append(1 if item.active else 0)
            if fields:
                params.append(staff_id)
                db.execute(f"UPDATE staff SET {','.join(fields)} WHERE id=?", params)
            # Task assignment is name-keyed (tasks.assigned_to is a JSON list
            # of names), so a rename used to orphan every task the person was
            # assigned to -- the tasks kept the old name, which no filter or
            # picker could reach anymore. Follow the rename through, done
            # tasks included: it's the same human, history stays attributed
            # to them under the name they go by now. created_by is left
            # alone on purpose -- it records who typed the task, as typed.
            new_name = item.name.strip() if item.name is not None else old_name
            tasks_moved = 0
            if new_name != old_name:
                for task in db.execute(
                    "SELECT id, assigned_to FROM tasks WHERE assigned_to LIKE '%' || ? || '%'", (old_name,)
                ):
                    names = json.loads(task["assigned_to"]) if task["assigned_to"] else []
                    if old_name in names:
                        db.execute(
                            "UPDATE tasks SET assigned_to=? WHERE id=?",
                            (json.dumps([new_name if n == old_name else n for n in names]), task["id"]),
                        )
                        tasks_moved += 1
            # tasks_moved rides along so the UI can say "3 tasks moved with
            # them" instead of the rename looking like it touched nothing.
            # It's response metadata, not a staff column.
            return dict(db.execute("SELECT * FROM staff WHERE id=?", (staff_id,)).fetchone()) | {
                "tasks_moved": tasks_moved
            }

    @router.put("/orders/{order_id}/assignment")
    def save_assignment(order_id: int, item: AssignmentIn):
        with connect() as db:
            assert_vehicle_editable(db, order(db, order_id))
            for staff_id, roles, label in (
                (item.advisor_id, {"advisor", "manager"}, "Advisor"),
                (item.technician_id, {"technician"}, "Technician"),
            ):
                if staff_id is None:
                    continue
                staff = db.execute("SELECT role,active FROM staff WHERE id=?", (staff_id,)).fetchone()
                if not staff or not staff["active"] or staff["role"] not in roles:
                    raise HTTPException(400, f"{label} is not an active {label.lower()}")
            db.execute("INSERT OR IGNORE INTO order_workflow(order_id) VALUES(?)", (order_id,))
            db.execute(
                "UPDATE order_workflow SET advisor_id=?,technician_id=?,date_in=?,odometer_in=?,promised_at=?,version=version+1 WHERE order_id=?",
                (item.advisor_id, item.technician_id, item.date_in, item.odometer_in, item.promised_at, order_id),
            )
            record_activity(db, order_id, "assignment_updated", item.actor, item.model_dump(exclude={"actor"}), now_fn)
            return workflow_detail(db, order_id)["assignment"]

    @router.post("/orders/{order_id}/notes", status_code=201)
    def add_note(order_id: int, item: NoteIn):
        with connect() as db:
            assert_vehicle_editable(db, order(db, order_id))
            cur = db.execute(
                "INSERT INTO order_notes(order_id,visibility,text,actor,created_at) VALUES(?,?,?,?,?)",
                (order_id, item.visibility, item.text.strip(), item.actor, now_fn()),
            )
            record_activity(
                db,
                order_id,
                "note_added",
                item.actor,
                {"note_id": cur.lastrowid, "visibility": item.visibility},
                now_fn,
            )
            return dict(db.execute("SELECT * FROM order_notes WHERE id=?", (cur.lastrowid,)).fetchone())

    @router.put("/orders/{order_id}/inspection")
    def save_inspection(order_id: int, item: InspectionIn):
        with connect() as db:
            assert_vehicle_editable(db, order(db, order_id))
            existing = db.execute("SELECT id FROM inspections WHERE order_id=?", (order_id,)).fetchone()
            if existing:
                inspection_id = existing["id"]
                db.execute(
                    "UPDATE inspections SET status=?,updated_at=? WHERE id=?", (item.status, now_fn(), inspection_id)
                )
                db.execute("DELETE FROM inspection_items WHERE inspection_id=?", (inspection_id,))
            else:
                cur = db.execute(
                    "INSERT INTO inspections(order_id,status,created_at,updated_at) VALUES(?,?,?,?)",
                    (order_id, item.status, now_fn(), now_fn()),
                )
                inspection_id = cur.lastrowid
            for value in item.items:
                db.execute(
                    "INSERT INTO inspection_items(inspection_id,category,name,condition,measurement,notes) VALUES(?,?,?,?,?,?)",
                    (
                        inspection_id,
                        value.category.strip(),
                        value.name.strip(),
                        value.condition,
                        value.measurement.strip(),
                        value.notes.strip(),
                    ),
                )
            record_activity(
                db,
                order_id,
                "inspection_saved",
                item.actor,
                {"status": item.status, "item_count": len(item.items)},
                now_fn,
            )
            return workflow_detail(db, order_id)["inspection"]

    @router.post("/orders/{order_id}/findings", status_code=201)
    def add_findings(order_id: int, item: FindingsIn):
        for line in item.items:
            if line.kind == "part" and not line.part_number.strip():
                raise HTTPException(422, "Every proposed part requires a traceable part number")
        with connect() as db:
            assert_vehicle_editable(db, order(db, order_id))
            assert_estimate_editable(db, order_id)
            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if not estimate:
                raise HTTPException(409, "Create an estimate before adding repair recommendations")
            finding_cur = db.execute(
                "INSERT INTO technician_findings(order_id,summary,actor,created_at) VALUES(?,?,?,?)",
                (order_id, item.summary.strip(), item.actor.strip(), now_fn()),
            )
            for line in item.items:
                db.execute(
                    "INSERT INTO estimate_items(estimate_id,kind,description,part_number,quantity,unit_price,unit_cost,received_quantity,line_total,source,review_required) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        estimate["id"],
                        line.kind,
                        line.description.strip(),
                        line.part_number.strip().upper(),
                        line.quantity,
                        line.unit_price,
                        line.unit_cost,
                        0,
                        round(line.quantity * line.unit_price, 2),
                        "technician_finding",
                        1,
                    ),
                )
            subtotal, taxable = db.execute(
                "SELECT coalesce(sum(line_total),0),coalesce(sum(CASE WHEN kind='part' THEN line_total ELSE 0 END),0) FROM estimate_items WHERE estimate_id=?",
                (estimate["id"],),
            ).fetchone()
            tax = round(float(taxable) * float(estimate["tax_rate"]), 2)
            db.execute(
                "UPDATE estimates SET subtotal=?,tax=?,total=?,status='draft' WHERE id=?",
                (round(float(subtotal), 2), tax, round(float(subtotal) + tax, 2), estimate["id"]),
            )
            record_activity(
                db,
                order_id,
                "technician_findings_recorded",
                item.actor,
                {"finding_id": finding_cur.lastrowid, "draft_lines_added": len(item.items)},
                now_fn,
            )
            return {
                "id": finding_cur.lastrowid,
                "order_id": order_id,
                "draft_lines_added": len(item.items),
                "review_required": True,
            }

    @router.patch("/orders/{order_id}/status")
    def update_status(order_id: int, item: StatusIn):
        with connect() as db:
            current_row = order(db, order_id)
            assert_vehicle_editable(db, current_row)
            current = current_row["status"]
            if current == item.status:
                return {"id": order_id, "status": current}
            db.execute("UPDATE orders SET status=? WHERE id=?", (item.status, order_id))
            record_activity(db, order_id, "status_changed", item.actor, {"from": current, "to": item.status}, now_fn)
            return {"id": order_id, "status": item.status}

    @router.patch("/orders/{order_id}/concern")
    def update_concern(order_id: int, item: ConcernIn):
        with connect() as db:
            current_row = order(db, order_id)
            assert_vehicle_editable(db, current_row)
            concern = item.concern.strip()
            db.execute("UPDATE orders SET concern=? WHERE id=?", (concern, order_id))
            record_activity(
                db, order_id, "concern_updated", item.actor, {"from": current_row["concern"], "to": concern}, now_fn
            )
            return {"id": order_id, "concern": concern}

    @router.patch("/orders/{order_id}/segment")
    def move_order_segment(order_id: int, item: SegmentMoveIn):
        """Move a ticket to the other side of the shop.

        A car gets written up as recon and turns out to be a we-owe the lot
        already sold, or the reverse. Before this the only way out was to
        delete the ticket and start again, which threw away its estimate, its
        history and any vendor invoice already posted against it -- so in
        practice people kept the wrong one and the cost landed on the wrong
        vehicle.

        Moving it re-points the ticket at the other record and takes its cost
        with it: `cost_rollup` walks from `recon_vehicle_id`/`we_owe_id`, so
        the money leaves the old vehicle's total and joins the new one the
        moment this returns. The estimate, the parts, the A/P invoices and the
        activity log all reference the order itself and simply follow it.
        """
        with connect() as db:
            current_row = order(db, order_id)
            assert_vehicle_editable(db, current_row)
            if current_row["segment"] == item.segment:
                raise HTTPException(409, f"This ticket is already a {SEGMENT_LABEL[item.segment]} ticket")

            if item.segment == "recon":
                if item.recon_vehicle_id is None:
                    raise HTTPException(422, "recon_vehicle_id is required to move a ticket to recon")
                target = db.execute(
                    "SELECT vehicle_id, archived_at FROM recon_vehicles WHERE id=?", (item.recon_vehicle_id,)
                ).fetchone()
                if not target:
                    raise HTTPException(404, "Recon vehicle not found")
                customer_id, vehicle_id = RECON_SHOP_CUSTOMER_ID, target["vehicle_id"]
                recon_vehicle_id, we_owe_id = item.recon_vehicle_id, None
            else:
                if item.we_owe_id is None:
                    raise HTTPException(422, "we_owe_id is required to move a ticket to we-owe")
                target = db.execute(
                    "SELECT customer_id, vehicle_id, archived_at FROM we_owe_items WHERE id=?", (item.we_owe_id,)
                ).fetchone()
                if not target:
                    raise HTTPException(404, "We-owe item not found")
                customer_id, vehicle_id = target["customer_id"], target["vehicle_id"]
                recon_vehicle_id, we_owe_id = None, item.we_owe_id
            if target["archived_at"]:
                raise HTTPException(
                    409, "That vehicle is archived to History -- reopen it before moving a ticket onto it"
                )

            db.execute(
                "UPDATE orders SET segment=?,recon_vehicle_id=?,we_owe_id=?,customer_id=?,vehicle_id=? WHERE id=?",
                (item.segment, recon_vehicle_id, we_owe_id, customer_id, vehicle_id, order_id),
            )
            record_activity(
                db,
                order_id,
                "segment_changed",
                item.actor,
                {"from": current_row["segment"], "to": item.segment},
                now_fn,
            )
            return dict(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    @router.post("/orders/{order_id}/void")
    def void_order(order_id: int, item: ActorIn):
        with connect() as db:
            current_row = order(db, order_id)
            # assert_vehicle_editable already blocks a second void (it
            # rejects any edit to an order that's already voided).
            assert_vehicle_editable(db, current_row)
            if db.execute("SELECT 1 FROM customer_invoices WHERE order_id=?", (order_id,)).fetchone():
                raise HTTPException(
                    409,
                    "This order has already been invoiced to the customer -- voiding would leave its cost excluded while the invoice still shows it as billed",
                )
            db.execute("UPDATE orders SET status='complete', voided=1 WHERE id=?", (order_id,))
            record_activity(db, order_id, "order_voided", item.actor, {"from": current_row["status"]}, now_fn)
            return {"id": order_id, "status": "complete", "voided": True}

    @router.post("/orders/{order_id}/authorization", status_code=201)
    def authorize(order_id: int, item: AuthorizationIn):
        with connect() as db:
            assert_vehicle_editable(db, order(db, order_id))
            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if not estimate:
                raise HTTPException(409, "Repair order has no estimate to authorize")
            if (
                item.status == "approved"
                and db.execute(
                    "SELECT 1 FROM estimate_items WHERE estimate_id=? AND review_required=1 LIMIT 1", (estimate["id"],)
                ).fetchone()
            ):
                raise HTTPException(
                    409, "AI and technician draft lines require advisor review before customer authorization"
                )
            cur = db.execute(
                "INSERT INTO estimate_authorizations(order_id,estimate_id,status,approved_by,method,note,actor,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    order_id,
                    estimate["id"],
                    item.status,
                    item.approved_by.strip(),
                    item.method,
                    item.note.strip(),
                    item.actor,
                    now_fn(),
                ),
            )
            db.execute("UPDATE estimates SET status=? WHERE id=?", (item.status, estimate["id"]))
            record_activity(
                db,
                order_id,
                f"estimate_{item.status}",
                item.actor,
                {"authorization_id": cur.lastrowid, "approved_by": item.approved_by, "method": item.method},
                now_fn,
            )
            return dict(db.execute("SELECT * FROM estimate_authorizations WHERE id=?", (cur.lastrowid,)).fetchone())

    @router.post("/orders/{order_id}/invoice", status_code=201)
    def create_invoice(order_id: int, item: ActorIn):
        with connect() as db:
            current = order(db, order_id)
            assert_vehicle_editable(db, current)
            if db.execute("SELECT 1 FROM customer_invoices WHERE order_id=?", (order_id,)).fetchone():
                raise HTTPException(409, "Customer invoice already exists")
            estimate = db.execute("SELECT * FROM estimates WHERE order_id=?", (order_id,)).fetchone()
            if not estimate or estimate["status"] != "approved":
                raise HTTPException(409, "An approved estimate is required before invoicing")
            subtotal_value, tax_value, total_value = (
                cents(estimate["subtotal"]),
                cents(estimate["tax"]),
                cents(estimate["total"]),
            )
            cur = db.execute(
                "INSERT INTO customer_invoices(order_id,number,subtotal_cents,tax_cents,total_cents,balance_cents,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    order_id,
                    f"INV-{current['number']}",
                    subtotal_value,
                    tax_value,
                    total_value,
                    total_value,
                    "open",
                    now_fn(),
                ),
            )
            invoice_id = cur.lastrowid
            for line in db.execute(
                "SELECT * FROM estimate_items WHERE estimate_id=? ORDER BY sort_order, id", (estimate["id"],)
            ):
                db.execute(
                    "INSERT INTO customer_invoice_items(invoice_id,kind,description,part_number,quantity,unit_price_cents,line_total_cents) VALUES(?,?,?,?,?,?,?)",
                    (
                        invoice_id,
                        line["kind"],
                        line["description"],
                        line["part_number"],
                        line["quantity"],
                        cents(line["unit_price"]),
                        cents(line["line_total"]),
                    ),
                )
            record_activity(
                db,
                order_id,
                "invoice_created",
                item.actor,
                {"invoice_id": invoice_id, "total": dollars(total_value)},
                now_fn,
            )
            return invoice_dict(db, db.execute("SELECT * FROM customer_invoices WHERE id=?", (invoice_id,)).fetchone())

    @router.post("/invoices/{invoice_id}/payments", status_code=201)
    def record_payment(invoice_id: int, item: PaymentIn):
        with connect() as db:
            invoice = db.execute("SELECT * FROM customer_invoices WHERE id=?", (invoice_id,)).fetchone()
            if not invoice:
                raise HTTPException(404, "Customer invoice not found")
            amount = cents(item.amount)
            # Atomic compare-and-set: reading balance_cents, checking it, and
            # writing it back as three separate steps let two nearly-
            # simultaneous payments both read the same starting balance and
            # both pass the "does this exceed it" check, overdrawing the
            # invoice. The WHERE clause here is evaluated against whatever's
            # actually committed at UPDATE time, not what was read moments
            # earlier, so only one of two racing payments can ever succeed.
            cur = db.execute(
                """UPDATE customer_invoices
                   SET balance_cents=balance_cents-:amount,
                       status=(CASE WHEN balance_cents-:amount=0 THEN 'paid' ELSE 'partial' END)
                   WHERE id=:id AND balance_cents>=:amount""",
                {"amount": amount, "id": invoice_id},
            )
            if cur.rowcount == 0:
                raise HTTPException(409, "Payment exceeds the invoice balance")
            payment_cur = db.execute(
                "INSERT INTO payments(invoice_id,amount_cents,method,reference,actor,created_at) VALUES(?,?,?,?,?,?)",
                (invoice_id, amount, item.method, item.reference.strip(), item.actor, now_fn()),
            )
            record_activity(
                db,
                invoice["order_id"],
                "payment_recorded",
                item.actor,
                {"payment_id": payment_cur.lastrowid, "amount": dollars(amount), "method": item.method},
                now_fn,
            )
            payment = dict(db.execute("SELECT * FROM payments WHERE id=?", (payment_cur.lastrowid,)).fetchone())
            payment["amount"] = dollars(payment.pop("amount_cents"))
            updated = db.execute("SELECT * FROM customer_invoices WHERE id=?", (invoice_id,)).fetchone()
            return {"payment": payment, "invoice": invoice_dict(db, updated)}

    return router
