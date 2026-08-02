from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID, inserted_id, normalize_stock_number, normalize_vin, vin_check_digit_ok

# _already_here is private to recon.py but imported deliberately: intake has to
# refuse a duplicate car in exactly the words the intake *form* uses, or the
# same collision reads as two different problems depending on which door the
# advisor came through. One rule, one sentence, one place it is written.
from .recon import _already_here, recon_match, resolve_unit
from .workflow import get_or_create_estimate, initialize_order_workflow, record_activity


class IntakeJobIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class IntakeIn(BaseModel):
    """Everything needed to put a new lot car on the board with one call.

    Deliberately does NOT decode the VIN itself. Decoding is a network round
    trip to NHTSA, and doing it inside this request would hold a write
    transaction on the shop's only database open across it -- so the caller
    decodes first (POST /api/vehicles/decode-vin) and passes what came back.
    That also keeps the rule that the decoder, not the caller, is the authority
    on year/make/model: this endpoint records what it is given and never guesses.
    """

    stock_number: str = Field(min_length=1, max_length=40)
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    trim: str = ""
    engine: str = ""
    color: str = ""
    mileage: int = Field(default=0, ge=0)
    odometer_broken: bool = False
    acquisition_source: str = ""
    acquisition_date: str = ""
    notes: str = ""
    # Optional so intake can record a car that has arrived but has no work
    # written against it yet -- a real state on a lot, and forcing an invented
    # concern to get past validation is exactly the kind of made-up data this
    # app cannot afford.
    concern: str = ""
    jobs: list[IntakeJobIn] = Field(default_factory=list, max_length=50)
    actor: str = Field(default="ui", min_length=1, max_length=120)


def _compact(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isalnum()).upper()


def _text(value: str | None) -> str:
    return (value or "").strip().lower()


def _vehicle_label(row: dict[str, Any]) -> str:
    return " ".join(str(row.get(part) or "").strip() for part in ("year", "make", "model") if row.get(part)).strip()


def _status(row: dict[str, Any], archived_at: str = "") -> str:
    if archived_at:
        return "archived"
    if row.get("open_order_id"):
        return "in_progress"
    if row.get("latest_order_status"):
        return str(row["latest_order_status"])
    return str(row.get("status") or "")


def _score(row: dict[str, Any], query: str, normalized_stock: str | None, normalized_vin: str | None) -> int:
    score = 0
    stock = normalize_stock_number(row.get("stock_number"))
    vin = normalize_vin(row.get("vin")) or ""
    plate = _compact(row.get("plate"))
    q_compact = _compact(query)
    q_words = [word for word in re.split(r"\s+", query.lower().strip()) if word]

    if normalized_stock and stock == normalized_stock:
        score += 100
    if normalized_vin and (vin == normalized_vin or vin.endswith(normalized_vin)):
        score += 90
    if q_compact and (plate == q_compact or plate.endswith(q_compact)):
        score += 75

    haystack = " ".join(
        _text(str(row.get(field) or ""))
        for field in (
            "stock_number",
            "vin",
            "plate",
            "customer_name",
            "year",
            "make",
            "model",
            "color",
            "description",
        )
    )
    if query.lower().strip() and query.lower().strip() in haystack:
        score += 50
    if q_words and all(word in haystack for word in q_words):
        score += 40 + len(q_words)
    return score


def _candidate(row: sqlite3.Row, kind: str, id_field: str) -> dict[str, Any]:
    data = dict(row)
    car = _vehicle_label(data)
    if kind == "recon":
        head = data.get("stock_number") or f"Recon {data[id_field]}"
    elif kind == "we_owe":
        head = f"We-Owe: {data.get('customer_name') or data[id_field]}"
    else:
        head = f"Retail: {data.get('customer_name') or data[id_field]}"
    return {
        "kind": kind,
        "id": data[id_field],
        "order_id": data.get("open_order_id") or data.get("latest_order_id"),
        "label": f"{head} — {car}" if car else head,
        "stock_number": data.get("stock_number") or data.get("lot_stock_number") or "",
        "vin": data.get("vin") or "",
        "status": _status(data, data.get("archived_at") or ""),
        "plate": data.get("plate") or "",
        "customer_name": data.get("customer_name") or "",
        "year": data.get("year"),
        "make": data.get("make") or "",
        "model": data.get("model") or "",
        "color": data.get("color") or "",
    }


def build_agent_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    _ = now_fn
    router = APIRouter(prefix="/api/agent")

    @router.get("/search")
    def search(q: str) -> list[dict[str, Any]]:
        query = q.strip()
        if not query:
            return []
        normalized_stock = normalize_stock_number(query)
        normalized_vin = normalize_vin(query)
        results: list[tuple[int, int, dict[str, Any]]] = []
        segment_rank = {"recon": 0, "we_owe": 1, "retail": 2}
        with connect() as db:
            rows = db.execute(
                """SELECT rv.id recon_id, rv.stock_number, rv.status, rv.archived_at,
                          v.year, v.make, v.model, v.vin, v.plate, v.color,
                          '' customer_name, '' description,
                          (SELECT o.id FROM orders o WHERE o.recon_vehicle_id=rv.id AND o.voided=0 AND o.status!='complete' ORDER BY o.id DESC LIMIT 1) open_order_id,
                          (SELECT o.id FROM orders o WHERE o.recon_vehicle_id=rv.id AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_id,
                          (SELECT o.status FROM orders o WHERE o.recon_vehicle_id=rv.id AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_status
                   FROM recon_vehicles rv JOIN vehicles v ON v.id=rv.vehicle_id"""
            ).fetchall()
            for row in rows:
                candidate = _candidate(row, "recon", "recon_id")
                score = _score(dict(row), query, normalized_stock, normalized_vin)
                if score:
                    results.append((score, segment_rank["recon"], candidate))

            rows = db.execute(
                """SELECT wi.id we_owe_id, wi.status, wi.archived_at, wi.description, wi.lot_stock_number,
                          v.year, v.make, v.model, v.vin, v.plate, v.color, c.name customer_name,
                          (SELECT o.id FROM orders o WHERE o.we_owe_id=wi.id AND o.voided=0 AND o.status!='complete' ORDER BY o.id DESC LIMIT 1) open_order_id,
                          (SELECT o.id FROM orders o WHERE o.we_owe_id=wi.id AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_id,
                          (SELECT o.status FROM orders o WHERE o.we_owe_id=wi.id AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_status
                   FROM we_owe_items wi JOIN vehicles v ON v.id=wi.vehicle_id JOIN customers c ON c.id=wi.customer_id"""
            ).fetchall()
            for row in rows:
                data = dict(row)
                data["stock_number"] = data.get("lot_stock_number") or ""
                candidate = _candidate(sqlite3.Row if False else row, "we_owe", "we_owe_id")
                score = _score(data, query, normalized_stock, normalized_vin)
                if score:
                    results.append((score, segment_rank["we_owe"], candidate))

            rows = db.execute(
                """SELECT v.id vehicle_id, v.year, v.make, v.model, v.vin, v.plate, v.color,
                          c.name customer_name, '' stock_number, '' status, '' archived_at,
                          (SELECT o.id FROM orders o WHERE o.vehicle_id=v.id AND o.segment='retail' AND o.voided=0 AND o.status!='complete' ORDER BY o.id DESC LIMIT 1) open_order_id,
                          (SELECT o.id FROM orders o WHERE o.vehicle_id=v.id AND o.segment='retail' AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_id,
                          (SELECT o.status FROM orders o WHERE o.vehicle_id=v.id AND o.segment='retail' AND o.voided=0 ORDER BY o.id DESC LIMIT 1) latest_order_status
                   FROM vehicles v JOIN customers c ON c.id=v.customer_id
                   WHERE c.is_shop_owned=0
                     AND NOT EXISTS (SELECT 1 FROM we_owe_items wi WHERE wi.vehicle_id=v.id)"""
            ).fetchall()
            for row in rows:
                candidate = _candidate(row, "retail", "vehicle_id")
                score = _score(dict(row), query, normalized_stock, normalized_vin)
                if score:
                    results.append((score, segment_rank["retail"], candidate))

        deduped: dict[tuple[str, int], tuple[int, int, dict[str, Any]]] = {}
        for score, rank, candidate in results:
            key = (candidate["kind"], int(candidate["id"]))
            if key not in deduped or score > deduped[key][0]:
                deduped[key] = (score, rank, candidate)
        ordered = sorted(deduped.values(), key=lambda item: (-item[0], item[1], str(item[2]["label"])))
        return [candidate for _, _, candidate in ordered[:10]]

    @router.post("/intake", status_code=201)
    def intake(payload: IntakeIn):
        """Put a new lot car on the board -- vehicle, ticket and jobs -- at once.

        Doing this as one call is the whole point. The same result assembled
        from POST /recon/vehicles, POST /orders and POST /orders/{id}/jobs is
        three independent transactions, and a failure at the second one leaves
        a car on the lot with no ticket: an orphan nobody is looking for,
        created by a tool that reported an error and moved on. Here every write
        shares this connection's transaction, so a refusal anywhere leaves the
        board exactly as it was.

        Ordering matters as much as atomicity. The duplicate check runs before
        anything is written, because the failure it prevents -- one physical car
        recorded twice -- is the one this app cannot detect after the fact.
        """
        stock_number = payload.stock_number.strip().upper()
        vin = "".join(payload.vin.split()).upper()
        # Checked here and not only at decode time: a caller can reach this
        # endpoint with a VIN it never decoded, and a bad VIN written into
        # vehicle_units.vin_key is the one mistake with no honest repair later.
        if len(vin) == 17 and not vin_check_digit_ok(vin):
            raise HTTPException(400, "That VIN fails its check digit -- one character is probably misread")
        with connect() as db:
            match = recon_match(db, stock_number, vin)
            if match["stock_number"]:
                raise HTTPException(409, _already_here("Stock number", match["stock_number"]))
            # A VIN on a car still on the board is the same car written twice.
            # A VIN last seen on an archived car is not: Walt buys cars back,
            # and a second recon episode on one VIN is what unit_lifetime is
            # for. Same asymmetry the intake form applies.
            if match["vin"] and not match["vin"]["archived"]:
                raise HTTPException(409, _already_here("That VIN", match["vin"]))

            ts = now_fn()
            vehicle_cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,odometer_broken,plate,plate_state,trim,engine,color,created_at)"
                " VALUES(?,?,?,?,?,?,?,'','',?,?,?,?)",
                (
                    RECON_SHOP_CUSTOMER_ID,
                    payload.year,
                    payload.make.strip(),
                    payload.model.strip(),
                    vin,
                    payload.mileage,
                    int(payload.odometer_broken),
                    payload.trim.strip(),
                    payload.engine.strip(),
                    payload.color.strip(),
                    ts,
                ),
            )
            vehicle_id = inserted_id(vehicle_cur)
            recon_cur = db.execute(
                "INSERT INTO recon_vehicles(vehicle_id,stock_number,acquisition_source,acquisition_date,purchase_price,notes,created_at,updated_at)"
                " VALUES(?,?,?,?,0,?,?,?)",
                (
                    vehicle_id,
                    stock_number,
                    payload.acquisition_source.strip(),
                    payload.acquisition_date.strip(),
                    payload.notes.strip(),
                    ts,
                    ts,
                ),
            )
            recon_vehicle_id = inserted_id(recon_cur)
            # Purchase price is deliberately not accepted or written: Walt keeps
            # that number and does that math himself (see CLAUDE.md). The unit
            # still has to exist so this car finds its own history if the same
            # VIN comes back later on a we-owe.
            resolve_unit(db, vehicle_id, vin, ts)

            order_id: int | None = None
            number: str | None = None
            created_jobs: list[dict[str, Any]] = []
            if payload.concern.strip():
                sequence = db.execute("SELECT coalesce(max(id),0)+1 FROM orders").fetchone()[0]
                number = f"RO-{datetime.now():%y%m}-{sequence:04d}"
                order_cur = db.execute(
                    "INSERT INTO orders(number,customer_id,vehicle_id,concern,segment,recon_vehicle_id,we_owe_id,status,voided,created_at)"
                    " VALUES(?,?,?,?,'recon',?,NULL,'estimate',0,?)",
                    (number, RECON_SHOP_CUSTOMER_ID, vehicle_id, payload.concern.strip(), recon_vehicle_id, ts),
                )
                order_id = inserted_id(order_cur)
                initialize_order_workflow(db, order_id, now_fn, payload.actor)
                if payload.jobs:
                    estimate_id = get_or_create_estimate(db, order_id, now_fn)["id"]
                    for position, job in enumerate(payload.jobs):
                        job_cur = db.execute(
                            "INSERT INTO estimate_jobs(estimate_id,title,technician_id,sort_order,created_at) VALUES(?,?,NULL,?,?)",
                            (estimate_id, job.title.strip(), position, ts),
                        )
                        created_jobs.append({"id": inserted_id(job_cur), "title": job.title.strip()})
                    record_activity(
                        db,
                        order_id,
                        "jobs_created",
                        payload.actor,
                        {"count": len(created_jobs), "titles": [j["title"] for j in created_jobs]},
                        now_fn,
                    )
            return {
                "recon_vehicle_id": recon_vehicle_id,
                "vehicle_id": vehicle_id,
                "stock_number": stock_number,
                "vin": vin,
                "vehicle": " ".join(str(p) for p in (payload.year, payload.make.strip(), payload.model.strip()) if p),
                "order_id": order_id,
                "number": number,
                "jobs": created_jobs,
            }

    return router
