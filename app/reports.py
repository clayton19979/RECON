from __future__ import annotations

import email as email_lib
import imaplib
import smtplib
import sqlite3
from datetime import datetime
from email.header import decode_header
from email.message import EmailMessage, Message
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import DEFAULT_REPORT_RECIPIENT
from .recon import cost_rollup, vehicle_board_rows


class EmailSettingsIn(BaseModel):
    gmail_address: str = ""
    gmail_app_password: str = ""
    report_recipient: str = Field(default=DEFAULT_REPORT_RECIPIENT)


class SendReportIn(BaseModel):
    report_type: Literal["recon", "we_owe", "combined"] = "combined"


def _settings(db: sqlite3.Connection) -> sqlite3.Row:
    return db.execute("SELECT * FROM app_settings WHERE id=1").fetchone()


def _decode_header_value(value: str) -> str:
    parts = decode_header(value or "")
    return "".join(part.decode(enc or "utf-8", errors="replace") if isinstance(part, bytes) else part for part, enc in parts)


def _extract_text(msg: Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        return ""
    payload = msg.get_payload(decode=True)
    return payload.decode(msg.get_content_charset() or "utf-8", errors="replace") if payload else ""


def fetch_replies(address: str, app_password: str, from_address: str, limit: int = 15) -> list[dict]:
    replies: list[dict] = []
    with imaplib.IMAP4_SSL("imap.gmail.com") as imap:
        imap.login(address, app_password)
        imap.select("INBOX", readonly=True)
        _typ, data = imap.search(None, f'(FROM "{from_address}")')
        ids = data[0].split()
        for msg_id in reversed(ids[-limit:]):
            _typ, msg_data = imap.fetch(msg_id, "(RFC822)")
            raw = msg_data[0][1]
            msg = email_lib.message_from_bytes(raw)
            replies.append({
                "subject": _decode_header_value(msg.get("Subject", "")),
                "from": _decode_header_value(msg.get("From", "")),
                "date": msg.get("Date", ""),
                "snippet": _extract_text(msg)[:500].strip(),
            })
    return replies


def technician_productivity_rows(db: sqlite3.Connection, start: str | None, end: str | None) -> list[dict]:
    end_bound = f"{end}T23:59:59" if end else None
    technicians = db.execute("SELECT * FROM staff WHERE role='technician' ORDER BY name").fetchall()
    result = []
    for tech in technicians:
        orders = db.execute(
            """SELECT o.id, o.status FROM orders o JOIN order_workflow w ON w.order_id=o.id
               WHERE w.technician_id=:tech_id AND (:start IS NULL OR o.created_at>=:start) AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchall()
        # Labor is attributed to whichever technician actually owns it: a
        # job's own technician if the line is grouped under one, else the
        # ticket's default assignee -- so per-job reassignment (e.g. another
        # tech picks up just the brake job) shows up here instead of every
        # labor line on the RO being credited to whoever the ticket default is.
        totals = db.execute(
            """SELECT coalesce(sum(ei.quantity),0), coalesce(sum(ei.quantity*ei.unit_cost),0)
               FROM estimate_items ei
               JOIN estimates e ON e.id=ei.estimate_id
               JOIN orders o ON o.id=e.order_id
               LEFT JOIN estimate_jobs ej ON ej.id=ei.job_id
               LEFT JOIN order_workflow w ON w.order_id=o.id
               WHERE ei.kind='labor' AND coalesce(ej.technician_id, w.technician_id)=:tech_id
                 AND (:start IS NULL OR o.created_at>=:start) AND (:end IS NULL OR o.created_at<=:end)""",
            {"tech_id": tech["id"], "start": start, "end": end_bound},
        ).fetchone()
        labor_hours, labor_cost = totals[0], totals[1]
        result.append({
            "technician": tech["name"],
            "ro_count": len(orders),
            "completed_count": sum(1 for row in orders if row["status"] == "complete"),
            "labor_hours": round(labor_hours, 2),
            "labor_cost": round(labor_cost, 2),
        })
    return result


def _section(rows: list[dict], title: str) -> str:
    """One number per vehicle -- what's actually been spent. Showing a
    second 'quoted' figure alongside it reads as if the total were their
    sum, which is exactly the confusion this format used to cause. We-owe
    rows get a customer-deposit note when one exists, since that reduces
    what the shop is actually out of pocket."""
    lines = [f"{title} ({len(rows)} total)", "-" * 40]
    total_cost = total_paid = 0.0
    for row in rows:
        total_cost += row["actual_cost"]
        label = row["stock_number"] or row.get("customer_name", "")
        deposit_note = ""
        if row.get("customer_paid"):
            total_paid += row["customer_paid"]
            deposit_note = f", customer paid ${row['customer_paid']:.2f} (net to shop: ${row['net_cost']:.2f})"
        lines.append(f"  {label} - {row['vehicle']} [{row['status']}] cost: ${row['actual_cost']:.2f}{deposit_note}")
    lines.append("")
    if total_paid:
        lines.append(f"  Total: ${total_cost:.2f}  |  Customer deposits: ${total_paid:.2f}  |  Net to shop: ${total_cost - total_paid:.2f}")
    else:
        lines.append(f"  Total: ${total_cost:.2f}")
    return "\n".join(lines)


def build_report_body(db: sqlite3.Connection, report_type: str) -> tuple[str, str]:
    date_str = datetime.now().strftime("%B %d, %Y")
    sections = []
    if report_type in ("recon", "combined"):
        sections.append(_section(vehicle_board_rows(db, segment="recon"), "RECON VEHICLES"))
    if report_type in ("we_owe", "combined"):
        sections.append(_section(vehicle_board_rows(db, segment="we_owe"), "WE-OWE PROMISES"))
    subject = f"RECON — {report_type.replace('_', ' ').title()} Report — {date_str}"
    body = f"RECON report — {date_str}\n\n" + "\n\n".join(sections)
    return subject, body


def build_reports_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/reports/vehicle-spend")
    def vehicle_spend(start: str | None = None, end: str | None = None, segment: Literal["recon", "we_owe"] | None = None):
        with connect() as db:
            return vehicle_board_rows(db, start, end, segment)

    @router.get("/reports/technicians")
    def technician_productivity(start: str | None = None, end: str | None = None):
        with connect() as db:
            return technician_productivity_rows(db, start, end)

    @router.get("/settings/email")
    def get_email_settings():
        with connect() as db:
            settings = _settings(db)
        return {
            "gmail_address": settings["gmail_address"],
            "configured": bool(settings["gmail_address"] and settings["gmail_app_password"]),
            "report_recipient": settings["report_recipient"],
        }

    @router.put("/settings/email")
    def save_email_settings(item: EmailSettingsIn):
        with connect() as db:
            db.execute(
                "UPDATE app_settings SET gmail_address=?,gmail_app_password=?,report_recipient=?,updated_at=? WHERE id=1",
                (item.gmail_address.strip(), item.gmail_app_password.strip(), item.report_recipient.strip() or DEFAULT_REPORT_RECIPIENT, now_fn()),
            )
        return {"ok": True}

    @router.post("/reports/send")
    def send_report(item: SendReportIn):
        with connect() as db:
            settings = _settings(db)
            if not settings["gmail_address"] or not settings["gmail_app_password"]:
                raise HTTPException(400, "Connect a Gmail account under Settings first")
            subject, body = build_report_body(db, item.report_type)
            message = EmailMessage()
            message["Subject"] = subject
            message["From"] = settings["gmail_address"]
            message["To"] = settings["report_recipient"]
            message.set_content(body)
            status, error = "sent", ""
            try:
                with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
                    smtp.login(settings["gmail_address"], settings["gmail_app_password"])
                    smtp.send_message(message)
            except Exception as exc:  # noqa: BLE001 -- surfaced to the user, not swallowed
                status, error = "failed", str(exc)
            db.execute(
                "INSERT INTO sent_reports(report_type,recipient,subject,body,status,error,sent_at) VALUES(?,?,?,?,?,?,?)",
                (item.report_type, settings["report_recipient"], subject, body, status, error, now_fn()),
            )
            recipient = settings["report_recipient"]
        # Raised outside the `with` block: sqlite3's context manager rolls back
        # on any exception, which would discard the failure log above otherwise.
        if status == "failed":
            raise HTTPException(502, f"Could not send email: {error}")
        return {"status": status, "subject": subject, "recipient": recipient}

    @router.get("/reports/sent")
    def list_sent_reports():
        with connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT id,report_type,recipient,subject,status,error,sent_at FROM sent_reports ORDER BY id DESC LIMIT 50"
            )]

    @router.get("/reports/replies")
    def check_replies():
        with connect() as db:
            settings = _settings(db)
        if not settings["gmail_address"] or not settings["gmail_app_password"]:
            raise HTTPException(400, "Connect a Gmail account under Settings first")
        try:
            return fetch_replies(settings["gmail_address"], settings["gmail_app_password"], settings["report_recipient"])
        except Exception as exc:  # noqa: BLE001 -- surfaced to the user, not swallowed
            raise HTTPException(502, f"Could not check for replies: {exc}") from exc

    return router
