from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .db import RECON_SHOP_CUSTOMER_ID, inserted_id, normalize_plate, normalize_stock_number, normalize_vin
from .db import now as db_now


def parse_stamp(value: str | None) -> datetime | None:
    """An ISO timestamp or plain date as shop-local naive time, or None if it
    isn't one.

    None rather than an exception because every caller here runs in a loop over
    the whole vehicle board: one malformed value (a hand-edited row, an old
    backup with a different format) must make one row look wrong, not take the
    entire list down with it.
    """
    try:
        parsed = datetime.fromisoformat(value or "")
    except (TypeError, ValueError):
        return None
    # Timestamps are shop-local and naive now (see db.now). Rows written before
    # that change carry a UTC offset, so convert those to local rather than
    # reading them five hours off.
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def age_days(created_at: str | None) -> int:
    """Whole days since created_at (an ISO timestamp) -- how long a car has
    actually been sitting, the natural companion to "what we have in it"."""
    created = parse_stamp(created_at)
    if created is None:
        return 0
    return (datetime.now() - created).days


def lot_age_days(acquisition_date: str | None, created_at: str | None) -> int:
    """How long the car has been on the lot -- counted from the day it arrived,
    not the day somebody got round to typing it into RECON.

    Those are the same day when the write-up happens at the drop-off, and they
    are not remotely the same day when three cars come off a Friday auction run
    and get written up on Monday. Counting from the record's created_at put
    every one of them on the board reading 0d while they sat, and "how long has
    this been here" is half of what the Age column is for -- it is the number
    Walt reads to ask why a car hasn't moved.

    Falls back to created_at when there's no acquisition date on file: it is an
    optional field on the write-up form, and every car written down before this
    existed has none. The answer then is exactly what it always was.

    An arrival date in the future is a typed year, not a car that hasn't shown
    up yet, so it floors at 0 -- a negative age on the board would be a number
    the app can't stand behind.
    """
    arrived = parse_stamp(acquisition_date)
    if arrived is None:
        return age_days(created_at)
    return max(0, (datetime.now() - arrived).days)


def last_activity(db: sqlite3.Connection, column: str, ref_id: int, fallback: str, segment: str | None = None) -> str:
    """When anything last actually happened to this vehicle.

    The newest last_activity_at across the vehicle's tickets (bumped by every
    mutating route -- see workflow.touch_order), falling back to when the
    vehicle landed on the lot for a car with no ticket started yet.

    Deliberately *not* the vehicle's updated_at, in either position. Patching
    the vehicle record is a data correction, not work on the car, so using it
    would let a VIN fix reset the idle clock and hide exactly the cars this
    column exists to surface -- and for a car with no ticket at all, updated_at
    is the *only* thing there is, which made every never-started car report as
    touched today. A car nobody has written a ticket for is the most idle thing
    in the shop, and now says so.

    Voided tickets are excluded for the same reason cost_rollup excludes them:
    voiding one means the work never happened."""
    return last_activity_map(db, column, [ref_id], segment).get(ref_id) or fallback


def idle_days(last_activity_at: str) -> int:
    """Whole days since anything happened. Same shape as age_days, and the same
    reason for tolerating garbage: one unparseable timestamp shouldn't take
    the board down."""
    return age_days(last_activity_at)


def days_on_lot(arrived_at: str | None, archived_at: str | None) -> int | None:
    """How long a car was here start to finish -- the day it arrived to the day
    it was filed to History.

    Deliberately only answerable once the car has gone. While it is still on
    the lot the clock is running and age_days is the honest number; a stay
    printed against a car that is on day four of who knows how many would read
    as a finished result and isn't one.

    None whenever either end is missing or unreadable -- History shows that as
    a dash rather than as a car that came and went the same day. Floors at 0
    for the same reason lot_age_days does: a typed arrival date later than the
    archive stamp is a typo, and a negative stay is a number the app can't
    stand behind.
    """
    arrived = parse_stamp(arrived_at)
    left = parse_stamp(archived_at)
    if arrived is None or left is None:
        return None
    return max(0, (left - arrived).days)


# Anything this or newer counts as stalled. Named here rather than written as a
# 7 at each call site because the board's card, the board's row colouring and
# the API all have to agree about which cars are stalled -- and it's the same
# boundary the "cold" idle bucket starts at in app.js.
STALLED_AFTER_DAYS = 7


def is_stalled(row: Mapping[str, Any]) -> bool:
    """Is this car sitting when it shouldn't be?

    Idle and stalled are not the same question, and conflating them is what
    this exists to stop. Idle is a plain measurement -- days since anything
    happened -- and every car has one. Stalled is a judgement: *this car still
    needs work and nobody has touched it in a week*. A car whose work is
    finished has no such problem, however long it has sat.

    That distinction matters more the longer the app runs. A fulfilled we-owe
    or a completed recon car never gets touched again, so its idle count climbs
    forever: counting those as stalled meant the board's red alarm only ever
    went up, until the number said "17 cars in trouble" on a lot where three
    were. An alarm that is always on is an alarm nobody reads.
    """
    if row.get("status_bucket") == "finished":
        return False
    return max(0, int(row.get("idle_days") or 0)) >= STALLED_AFTER_DAYS


def live_orders(orders: list[dict]) -> list[dict]:
    """The tickets that actually count, in the order cost_rollup returned them.

    Voiding a ticket writes `status='complete', voided=1` (see workflow.void_order):
    the flag is the meaning, the status is only how the row leaves the open-orders
    count. Reading the status without the flag therefore reports a mistake as
    finished work, so everything that judges what a car is doing filters here
    first -- the same rule cost_rollup applies to the money and last_activity
    applies to the clock.
    """
    return [o for o in orders if not o.get("voided")]


# The piles Walt sorts the lot into, and the only ones the app knows about.
# They live here rather than in reports.py because the Vehicles screen groups
# its columns by them and the Lot Report groups its sections by them -- and
# because vehicle_board_rows below stamps every row with its pile, which
# reports.py (an importer of this module) could not do without a cycle.
LOT_READY = "ready"
LOT_WORKING = "working"
LOT_WAITING = "waiting"
# The fourth pile, and the only one that is not about work: a car whose lot
# life is over. A sold recon car and a settled we-owe promise both used to
# land in "Ready to go", which is the one place they make the answer wrong --
# Walt asks that column how many cars he can sell, and it was counting cars
# already sold and promises settled weeks ago on customers' cars that drove
# away. Nothing ever takes those rows off the live board either, so the count
# only drifts further from the truth the longer the shop uses the app.
#
# They are not hidden, because the record still needs filing and a row that
# vanishes is a row nobody files. They get their own pile, last, where they
# read as housekeeping instead of inventory.
LOT_SETTLED = "settled"

# The display statuses that mean the car's lot life is over: sold on the recon
# side, fulfilled or waived on the we-owe side. Both are already settled
# facts by the time they reach a board row -- "sold" only survives
# recon_sold_and_settled (no ticket still open), and fulfilled/waived is the
# advisor's own word for a promise that is closed.
LOT_SETTLED_STATUSES = ("sold", "fulfilled", "waived")

# How each of those reads in a sentence on the sheet.
SETTLED_WORD = {"sold": "Sold", "fulfilled": "Fulfilled", "waived": "Waived"}

# The board statuses that are not repair-ticket statuses, in the words the
# screen shows them in: recon's "acquired" (no ticket written yet) and "sold",
# and a we-owe promise's own open/fulfilled/waived. A board row's status is one
# of these OR one of workflow.STATUS_LABEL's, depending on whether a ticket is
# driving it -- so anything rendering a board row needs both maps.
#
# The exports had only the ticket half and fell through to the raw column value
# for these five, so a downloaded lot sheet read "acquired", "sold", "waived"
# in lower case beside "Complete" and "In Progress" from the very same column.
# static/js/state.js::STATUS_LABEL is the browser's copy of the pair and
# tests/test_export.py holds the two to the same words.
BOARD_STATUS_LABEL = {
    "acquired": "Acquired",
    "sold": "Sold",
    "open": "Open",
    "fulfilled": "Fulfilled",
    "waived": "Waived",
}


def open_jobs_text(row: dict) -> str:
    """The repairs this car is still owed, by name.

    This is the part of "what does it still need" that money cannot answer.
    Every other clause on the row is a number -- dollars left, parts on order
    -- and none of them tells Walt whether what's outstanding is a windshield
    or an oil change. The job titles are what somebody actually typed about
    this car, so they're repeated verbatim rather than summarised.

    A car whose jobs are all ticked but whose ticket is still open is worth
    saying out loud too: the work is finished and only the paperwork is
    holding the car on the lot, which is a one-click fix rather than a job
    for a technician.
    """
    open_titles = [t.strip() for t in (row.get("jobs_open") or []) if t and t.strip()]
    total = row.get("jobs_total") or 0
    if not total:
        return ""
    if not open_titles:
        return f"all {total} job{'' if total == 1 else 's'} ticked off — close the ticket"
    named = ", ".join(open_titles[:NEEDS_JOB_LIMIT])
    hidden = len(open_titles) - NEEDS_JOB_LIMIT
    if hidden > 0:
        named += f" +{hidden} more"
    done = total - len(open_titles)
    return f"{named} ({done} of {total} done)" if done else named


def lot_needs_text(row: dict) -> str:
    """One plain sentence answering "what does this car still need?".

    Built on the server rather than in the browser so the screen, the printed
    sheet and the CSV cannot drift into three different phrasings of the same
    car -- Walt reads whichever one is in front of him and they have to agree.
    """
    # Money the car has spent but hasn't been charged: parts sitting on a
    # ticket that is already closed and were never marked received. The car
    # itself needs nothing, but the figure beside it on this sheet is short by
    # this much, and the sheet has to say so rather than let a car that took
    # $380 of tires read as free. See cost_rollup for why only closed tickets
    # count.
    missing = row.get("unreceived_closed_cost") or 0
    missing_parts = row.get("unreceived_closed_parts") or 0
    missing_text = (
        f"{missing_parts} part{'' if missing_parts == 1 else 's'} never marked received (${missing:,.2f} not in the cost)"
        if missing
        else ""
    )

    if row["lot_bucket"] == LOT_SETTLED:
        # This car's lot life is over; the one thing left is to file it away
        # -- unless it already has been, in which case History must not nudge
        # anyone toward a step that is done. The unreceipted-parts warning
        # still outranks either wording: the car's cost is wrong until that
        # part is received, settled or not.
        #
        # The word is the advisor's own -- Sold, Fulfilled, Waived -- because
        # "settled" is this file's shorthand and nobody in the shop says it.
        word = SETTLED_WORD.get(row.get("status") or "", "Finished")
        if missing_text:
            return f"{word} — but {missing_text}"
        return word if row.get("archived") else f"{word} — send to History"

    if row["lot_bucket"] == LOT_READY:
        if missing_text:
            return f"Ready to go — but {missing_text}"
        return "Nothing — ready to go"

    bits = []
    # First, because it outranks everything else on the row. A part on order or
    # a quote half spent is the shop's own business; a we-owe promise whose
    # date has gone by is a customer who was told a day and is still waiting.
    # None here means the question doesn't apply -- a recon car, a promise with
    # no date, or one already fulfilled or waived (see promise_days_late).
    late = row.get("promise_days_late")
    if late is not None and late >= 0:
        bits.append(
            "promised to the customer today"
            if late == 0
            else f"{late} day{'' if late == 1 else 's'} past the promised date"
        )

    if row["status"] == "pending_approval":
        bits.append("waiting on approval")
    if not row.get("order_id"):
        # "No ticket written yet" is true of the live tickets and reads as an
        # oversight to whoever remembers writing one. Naming the void instead
        # is the difference between a row that looks forgotten and a row with
        # an obvious next step -- and a voided ticket is exactly the case
        # where a car quietly stops being anyone's job.
        bits.append("ticket was voided — needs a new one" if row.get("voided_order_count") else "no ticket written yet")
    elif row["status"] == "estimate" and row["lot_bucket"] == LOT_WAITING:
        # Only true while nothing has actually been spent or ordered -- see
        # lot_bucket. Saying it about a car with parts in it reads as a
        # contradiction of the money on the same row.
        bits.append("written up, work not started")

    # The work itself goes ahead of the money: it is the answer to the
    # question, and the dollars are the follow-up.
    jobs = open_jobs_text(row)
    if jobs:
        bits.append(jobs)

    pending = row.get("parts_pending") or 0
    if pending:
        value = row.get("parts_pending_value") or 0
        amount = f" (${value:,.2f})" if value else ""
        bits.append(f"{pending} part{'' if pending == 1 else 's'} on order{amount}")

    if row["remaining_cost"]:
        bits.append(f"${row['remaining_cost']:,.2f} of work left")

    # Only worth saying once a car has actually gone quiet; every car is idle
    # for a day or two between visits and flagging that is just noise. Same
    # is_stalled the board's card uses, so the two screens can't disagree
    # about which cars have been forgotten.
    if is_stalled(row):
        bits.append(f"untouched {row['idle_days']} days")

    # A car can have an earlier ticket closed out with parts nobody receipted
    # and still be in the shop on a second one, so this belongs on every row,
    # not only the finished ones.
    if missing_text:
        bits.append(missing_text)

    if not bits:
        return "work under way"
    # Only the first character is touched. str.capitalize() would lowercase
    # everything after it, and the job titles in here are somebody's own words
    # -- "Front Brakes / AC" is not ours to rewrite as "front brakes / ac".
    sentence = " · ".join(bits)
    return sentence[:1].upper() + sentence[1:]


def lot_bucket(row: dict) -> str:
    """Which pile this car is in.

    Driven by the repair ticket, same as the board -- the recon record has a
    status field of its own but nobody maintains it, and a report that reads
    the field nobody updates is a report that quietly lies.

    Money already spent or parts already on order also count as started, no
    matter what the ticket still says. A ticket sits on "Estimate" until
    somebody thinks to move it, so grouping on status alone put cars with
    hundreds of dollars of parts in them under a heading that read "Not
    started" -- and the group's own subtotal then contradicted its title on
    the same line. What has actually happened to the car wins over what the
    ticket was last set to.
    """
    # Ahead of everything else, because it is not a question about work. A
    # sold car and a settled promise are finished in a way "Ready to go"
    # cannot describe: there is nothing to sell and nobody to hand it back
    # to. See LOT_SETTLED.
    if row["status"] in LOT_SETTLED_STATUSES:
        return LOT_SETTLED
    if row["status_bucket"] == "finished":
        return LOT_READY
    if row["status"] in ("in_progress", "pending_approval"):
        return LOT_WORKING
    # Parts nobody receipted on a ticket that is already closed count as money
    # spent too. They are not in actual_cost and (deliberately, see
    # _rollup_from_orders) not in parts_pending either, so without this a car
    # holding a finished ticket and a freshly written second one -- the "it
    # came back" case -- could read "Not started" with a closed repair and
    # real money already behind it.
    if (
        (row.get("actual_cost") or 0) > 0
        or (row.get("parts_pending") or 0) > 0
        or (row.get("unreceived_closed_cost") or 0) > 0
    ):
        return LOT_WORKING
    return LOT_WAITING


def add_lot_status(row: dict) -> dict:
    """Stamp a board row with its pile, what finishing it should still cost,
    and the plain sentence describing what it is waiting on.

    Applied to every vehicle-board row, not just the Lot Report's, because the
    Vehicles screen groups its columns by exactly these piles -- two
    screens reading one rule, so a car cannot be "In the shop" on one and "Not
    started" on the other.
    """
    row["lot_bucket"] = lot_bucket(row)
    # What is written up but has not landed yet (cost_rollup's open_cost), NOT
    # written-up minus spent. Those were the same number only while receiving a
    # part overwrote its price with the invoice; now that the ticket price
    # survives the bill, a part that came in cheaper would otherwise have left
    # the difference sitting here as work still to do on a finished job.
    #
    # Zero on a finished car, whatever is still open on its ticket -- nothing
    # more is going to be spent on it, and a car whose Needs cell reads
    # "Nothing -- ready to go" must not also claim money still to come.
    row["remaining_cost"] = 0.0 if row["lot_bucket"] in (LOT_READY, LOT_SETTLED) else max(row.get("open_cost") or 0, 0)
    row["needs"] = lot_needs_text(row)
    return row


def order_status_bucket(orders: list[dict]) -> str:
    """Finished or still in progress, judged by the repair tickets themselves.

    Recon records carry a status field of their own but nobody maintains it,
    so the ticket is what the answer has to come from: finished means every
    ticket that exists is closed, and at least one exists. A car with no
    ticket at all has not finished anything -- it has not started.

    Voided tickets are not tickets. A car whose only one had been voided read
    as finished here, which showed a green Complete pill on the board, filed
    the car under "Ready to go" on Walt's Lot Report, and -- because
    is_stalled deliberately never flags a finished car -- took it out of the
    Stalled count for good. One mis-click made a car invisible in the three
    places that exist to stop cars going missing.
    """
    live = live_orders(orders)
    active = next((o for o in reversed(live) if o["status"] != "complete"), None)
    has_closed = any(o["status"] == "complete" for o in live)
    return "finished" if (active is None and has_closed) else "in_progress"


def is_void_only(row: Mapping[str, Any]) -> bool:
    """Is this car's only paperwork a ticket somebody took back?

    Voiding is how a ticket written by mistake is undone, and the car left
    behind is a loose end rather than a job: nothing was done to it and there
    is no live ticket saying what should be. On one board with everything else
    it is indistinguishable from a car genuinely waiting to be started, which
    is why it gets a pile of its own.

    A car that also has a live ticket is not in here -- the live ticket is
    what the car is doing, and the voided one beside it is just history.

    Deliberately reads the already-computed row rather than the database: the
    board, the counts above it and this filter then cannot disagree about
    which cars are which. order_id is None exactly when no live ticket exists
    (see the row build, where it comes off live_orders).
    """
    return bool(row.get("voided_order_count")) and row.get("order_id") is None


def we_owe_status_bucket(status: str, orders: list[dict] | None = None) -> str:
    """A promise is done when the advisor says so, or when its work is done.

    Two signals, either of which is enough. fulfilled/waived is the advisor's
    own word for it, and it has to stand alone: waiving a promise closes it
    with no work done and often no ticket at all.

    The tickets are the other half, and leaving them out was a bug people hit
    every week. Finishing a we-owe is done on the ticket -- you close the
    repair order, the same as any other job -- and the promise's own status
    field sits at "open" until somebody separately remembers to mark it
    fulfilled. Nobody does that on a busy morning. So a car whose work was
    finished and ticket closed stayed in the "In the shop" column of the
    Vehicles board indefinitely, next to cars actually in a bay, while the
    status pill on the very same row already read Complete (display_status has
    always fallen through to the ticket). One row saying two things.

    Judged exactly the way recon's is -- see order_status_bucket: every live
    ticket closed and at least one existing. A promise with no ticket at all
    has not finished anything, and a voided ticket is not a ticket.
    """
    if status in ("fulfilled", "waived"):
        return "finished"
    return order_status_bucket(orders) if orders is not None else "in_progress"


def recon_sold_and_settled(vehicle_status: str | None, orders: list[dict]) -> bool:
    """Is this car's lot life over -- sold, with no work still owed on it?

    The recon status field is legacy and mostly unmaintained (see
    order_status_bucket), but "sold" is the one value in it that is definitive
    when it is there: records from before the ticket-driven board carry it,
    and the Profit report already reads the sale it describes as fact.
    Ignoring it here meant one screen said "sold July 15" while the board
    called the same car "not started, untouched 41 days" -- and the stalled
    alarm rang loudest for exactly the cars nobody should touch again.

    A still-open ticket outranks the flag: sold or not, work someone is in
    the middle of is what the board has to show, and the alarm has to keep
    working on it.
    """
    if vehicle_status != "sold":
        return False
    return all(o["status"] == "complete" for o in live_orders(orders))


def last_activity_detail(
    db: sqlite3.Connection, column: str, ref_id: int, fallback: str, segment: str | None = None
) -> dict:
    """When work last happened on this vehicle, and -- where we can honestly
    say -- what it was and who did it.

    Two sources, deliberately kept apart. `at` comes from orders.last_activity_at
    (see last_activity above); that's the authoritative clock, the one the
    board's Idle column reads, and it moves for *every* write. The attribution
    comes from the newest row in activity_events, which only exists for writes
    worth logging -- the estimate grid autosaves through touch_order without
    logging an event, on purpose, or the log would be nothing but noise.

    So the two can disagree, and when they do the event is not what last
    happened. Rather than captioning a fresh timestamp with a stale name, we
    only attribute when the newest event *is* the newest activity; otherwise
    action/actor come back empty and the UI says when without claiming who.
    A slightly thinner answer beats a confidently wrong one."""
    at = last_activity(db, column, ref_id, fallback, segment)
    row = db.execute(
        f"""SELECT e.action, e.actor, e.created_at
            FROM activity_events e JOIN orders o ON o.id=e.order_id
            WHERE o.{column}=? AND o.voided=0"""
        + (" AND o.segment=?" if segment else "")
        + " ORDER BY e.created_at DESC, e.id DESC LIMIT 1",
        (ref_id, segment) if segment else (ref_id,),
    ).fetchone()
    detail = {"at": at, "idle_days": idle_days(at), "action": "", "actor": ""}
    if row and row["created_at"] and row["created_at"] >= at:
        detail["action"] = row["action"] or ""
        detail["actor"] = row["actor"] or ""
    return detail


RECON_STATUSES = {"acquired", "in_repair", "ready", "sold", "retained"}
WE_OWE_STATUSES = {"open", "fulfilled", "waived"}


class RecondVehicleIn(BaseModel):
    stock_number: str = Field(min_length=1, max_length=40)
    year: int = Field(ge=1900, le=2100)
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    vin: str = ""
    mileage: int = Field(default=0, ge=0)
    odometer_broken: bool = False
    # The one identifier you can read from across the lot without opening a
    # door. The write-up form has always asked for it; until now the answer was
    # dropped on the floor, so no lot car had a plate on file and no lot car
    # could be looked up by one.
    plate: str = Field(default="", max_length=12)
    plate_state: str = Field(default="", max_length=2)
    trim: str = ""
    engine: str = ""
    color: str = ""
    acquisition_source: str = ""
    acquisition_date: str = ""
    purchase_price: float = Field(default=0, ge=0)
    notes: str = ""


class RecondVehiclePatch(BaseModel):
    # The lot's own number for the car, and one of the few things on a recon
    # record that gets written down before anybody checks it. It was write-once
    # at intake, so a mistyped stock number could only be fixed by deleting the
    # car and re-entering it -- which is impossible the moment it has a repair
    # order on it, and which is also how the same car ends up on the board
    # twice. Same uniqueness rules as intake; see update_recon_vehicle.
    stock_number: str | None = Field(default=None, min_length=1, max_length=40)
    status: Literal["acquired", "in_repair", "ready", "sold", "retained"] | None = None
    sale_price: float | None = Field(default=None, ge=0)
    sale_date: str | None = None
    sale_customer_id: int | None = None
    notes: str | None = None
    # Core vehicle info -- correcting a typo (wrong purchase price, VIN, etc.)
    # shouldn't require touching the database directly.
    purchase_price: float | None = Field(default=None, ge=0)
    # The day the car actually landed on the lot. It drives the board's Age
    # column and the lot sheet's Days On Lot, so a wrong one has to be
    # fixable -- until now it was write-once at the write-up and stuck.
    # "" is allowed and means "we don't know", which falls the age count back
    # to when the record was written down.
    acquisition_date: str | None = None
    vin: str | None = None
    year: int | None = Field(default=None, ge=1900, le=2100)
    make: str | None = Field(default=None, min_length=1)
    model: str | None = Field(default=None, min_length=1)
    trim: str | None = None
    engine: str | None = None
    color: str | None = None
    # Correctable like every other identifier here: a plate is misread off a
    # dirty car as often as a VIN is, and a lot car's plate changes outright
    # when the dealer tag comes off it.
    plate: str | None = Field(default=None, max_length=12)
    plate_state: str | None = Field(default=None, max_length=2)
    mileage: int | None = Field(default=None, ge=0)
    odometer_broken: bool | None = None
    expected_version: int | None = None


class WeOweIn(BaseModel):
    customer_id: int
    vehicle_id: int
    description: str = Field(min_length=1)
    category: str = "other"
    target_date: str = ""
    sale_reference: str = ""
    lot_stock_number: str = ""
    # A we-owe car was very often bought and recon'd before it was ever in
    # RECON -- the promise is the first time the shop writes it down. Without
    # somewhere to put what the car cost, its profit can never be worked out,
    # so the intake accepts it and it lands on the unit, not on the promise.
    purchase_price: float | None = Field(default=None, ge=0)
    sale_price: float | None = Field(default=None, ge=0)


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
    plate: str | None = Field(default=None, max_length=12)
    plate_state: str | None = Field(default=None, max_length=2)
    mileage: int | None = Field(default=None, ge=0)
    odometer_broken: bool | None = None
    purchase_price: float | None = Field(default=None, ge=0)
    sale_price: float | None = Field(default=None, ge=0)
    expected_version: int | None = None


class ArchiveIn(BaseModel):
    expected_version: int | None = None


class FileAwayItemIn(BaseModel):
    """One car the sheet was offering to file, and the version of it that was
    on screen.

    The version is required rather than optional, unlike ArchiveIn's. That one
    is sent from the car's own page, where a person is looking at the record
    they are about to change; this is sent from a list, in a batch, by somebody
    who was reading a row. A batch write with no version is exactly the
    check-then-act this app does not allow anywhere else.
    """

    id: int
    expected_version: int


class FileAwayIn(BaseModel):
    """The cars the Lot Status sheet was showing in its "Finished — file away"
    pile at the moment the button was pressed.

    Sent rather than left to the server to work out, so the action can only
    ever cover what the person could actually see. The other workstation is
    filing cars away too, and "file away everything that qualifies right now"
    would quietly take a car nobody on this screen had looked at.

    The server checks every one of them again anyway (see file_away_settled):
    the list says what was *offered*, never what is allowed.
    """

    recon: list[FileAwayItemIn] = Field(default_factory=list)
    we_owe: list[FileAwayItemIn] = Field(default_factory=list)


class WeOwePaymentIn(BaseModel):
    """Customers are sometimes talked into putting money down toward a
    we-owe repair -- tracked separately from shop cost so the net amount
    the shop is actually out of pocket is visible, not just gross spend."""

    amount: float = Field(gt=0)
    method: Literal["cash", "card", "check", "bank", "other"] = "cash"
    note: str = ""
    actor: str = ""


# SQLite's variable limit is 999; 400 ids per IN clause keeps every batched
# query well inside it while still collapsing a 60-car board into one round
# trip. Restored along with the helpers below -- see the note on cost_rollup.
_ID_CHUNK = 400


def _unique_ids(ref_ids: Iterable[int]) -> list[int]:
    """Input order, duplicates dropped -- dict preserves insertion order."""
    return list(dict.fromkeys(ref_ids))


def _chunked(values: Sequence[int], size: int = _ID_CHUNK) -> Iterable[Sequence[int]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


def cost_rollups(
    db: sqlite3.Connection, column: str, ref_ids: Sequence[int], segment: str | None = None
) -> dict[int, dict]:
    """Actual cost = what's really landed: labor/fees count in full the moment
    they're logged, but parts only count once received, and stop counting
    again once sent back to the vendor (part_returned). quoted_cost (full
    quantity regardless of receipt) is returned alongside it.

    quoted_cost is a historical field name and NOT an estimate: the shop does
    not quote recon work, it buys what the car needs. It means "the sum of
    every line written on the ticket", priced at quoted_unit_cost -- what the
    line was written down at -- not at unit_cost, which receiving overwrites
    with the price the vendor's invoice actually said. Rows from before that
    column existed carry NULL and fall back to unit_cost. Its only use is the
    "what hasn't landed yet" arithmetic below; nothing subtracts it from
    actual cost to report an over/under, and nothing should.

    open_cost is what finishing this car should still cost: part lines that
    have not landed yet, priced at what they were written at, plus the core
    deposits those lines will carry when they do land.

    A core deposit is money out of the shop's pocket that comes back only when
    the old unit does, so an outstanding one counts as part of what the car
    cost. It stops counting the moment the vendor's credit is recorded
    (core_return_invoice_number), which is the same "outstanding" line the
    Cores board draws. A returned part takes its deposit with it: there is no
    old unit owed to anyone once the new part goes back.

    unreceived_cost is the written-up money the car was never charged: line
    quantity that never landed, at the written price. Reported per closed
    ticket too (unreceived_closed_*), because only a finished ticket turns an
    unreceived part into a bookkeeping problem -- on an open one it is simply
    work still ahead.

    parts_pending counts part lines that have been ordered from a vendor but
    haven't shown up yet (status='ordered'; 'received' means it landed,
    'quoted' means nobody has actually ordered it). Returned parts are
    excluded: a line sent back to the vendor isn't something the shop is
    still waiting on, and neither is a line on a ticket already closed --
    see _rollup_from_orders for why the closed ones drop out here.

    Answers for many vehicles at once because the vehicle board and every
    report built on it need exactly this for every car on the list. Asking one
    car at a time turned a screen the shop opens all day into one query per
    car, which is fine on a lot of twelve and is not fine on two years of
    History. Every id passed in comes back, including cars with no ticket at
    all -- those get the same all-zero shape an empty query produced.
    """
    result = {ref_id: _rollup_from_orders([]) for ref_id in ref_ids}
    ids = _unique_ids(ref_ids)
    if not ids:
        return result

    # An outstanding deposit: charged per unit, so it scales with quantity the
    # same way the part's own cost does.
    core_owing = "ei.kind='part' AND ei.part_returned=0 AND ei.core_return_invoice_number='' AND ei.core_charge>0"
    # The price a line was written down at; receiving overwrites unit_cost
    # with the invoice's number, so this is the one that survives the bill.
    written = "coalesce(ei.quoted_unit_cost, ei.unit_cost)"
    per_ref: dict[int, list[dict]] = {ref_id: [] for ref_id in ids}
    for chunk in _chunked(ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT o.{column} ref_id, o.id, o.number, o.ro_number, o.status, o.voided,
               -- received_cost, not received_quantity*unit_cost: the money the
               -- vendor actually billed for the units that landed, added up
               -- bill by bill. The two only agree while a line arrives on one
               -- invoice at one price; when it doesn't, the product re-prices
               -- everything already received at the newest price and the car
               -- disagrees with A/P. See the column's comment in db.SCHEMA.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=0 THEN ei.received_cost ELSE 0 END),0)
                 + coalesce(sum(CASE WHEN {core_owing} THEN ei.received_quantity*ei.core_charge ELSE 0 END),0) parts_cost,
               coalesce(sum(CASE WHEN ei.kind='labor' THEN ei.quantity*ei.unit_cost ELSE 0 END),0) labor_cost,
               -- Hours in their own right, not just as an input to cost. On
               -- recon and we-owe the labor rate is always 0 (in-house time
               -- isn't money out the door), so labor_cost is permanently 0
               -- and the hours the techs flagged were invisible everywhere.
               coalesce(sum(CASE WHEN ei.kind='labor' THEN ei.quantity ELSE 0 END),0) labor_hours,
               coalesce(sum(CASE WHEN ei.kind='fee'   THEN ei.quantity*ei.unit_cost ELSE 0 END),0) fee_cost,
               -- A credit line (a returned part, a refunded core) is stored
               -- positive, the way the vendor prints it, so the sign has to be
               -- applied here: summing it raw made a $150 credit RAISE the
               -- car's written-up total by $150. Actual cost needs no matching
               -- term -- parts_cost above already drops a returned line via
               -- part_returned, and subtracting the credit as well would count
               -- the same money back twice. A part sent back to the vendor
               -- drops out entirely: it is not money the shop is going to
               -- spend. The two exclusions cannot double-subtract, because the
               -- credit line a vendor invoice writes is a line of its own and
               -- never sets part_returned on the line it refunds.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=1 THEN 0
                                 WHEN ei.kind='credit' THEN -ei.quantity*{written}
                                 ELSE ei.quantity*{written} END),0)
                 + coalesce(sum(CASE WHEN {core_owing} THEN ei.quantity*ei.core_charge ELSE 0 END),0) quoted_cost,
               -- Still to spend: every part line that has not landed yet, at
               -- the written price, plus the deposit it will carry. Labor and
               -- fees are never outstanding -- they count the moment they're
               -- logged -- and a returned line is nobody's problem any more.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=0
                                 THEN max(ei.quantity-ei.received_quantity,0)*{written}
                                 ELSE 0 END),0)
                 + coalesce(sum(CASE WHEN {core_owing}
                                 THEN max(ei.quantity-ei.received_quantity,0)*ei.core_charge
                                 ELSE 0 END),0) open_cost,
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.status='ordered' AND ei.part_returned=0 THEN 1 ELSE 0 END),0) parts_pending,
               -- Core deposits ride in here too: they land on the same vendor
               -- invoice as the part, so this is what that bill will say.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.status='ordered' AND ei.part_returned=0 THEN ei.quantity*ei.unit_cost ELSE 0 END),0)
                 + coalesce(sum(CASE WHEN {core_owing} AND ei.status='ordered' THEN ei.quantity*ei.core_charge ELSE 0 END),0) parts_pending_value,
               -- Written-up parts money that hasn't landed as actual cost.
               -- Whatever the line's status says, what counts here is the
               -- quantity: a line marked 'received' for two of the four
               -- ordered is still two parts' worth of money the car hasn't
               -- been charged.
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=0
                                 THEN max(ei.quantity - ei.received_quantity, 0)*{written} ELSE 0 END),0) unreceived_cost,
               coalesce(sum(CASE WHEN ei.kind='part' AND ei.part_returned=0 AND ei.received_quantity < ei.quantity
                                 THEN 1 ELSE 0 END),0) unreceived_parts
           FROM orders o
           LEFT JOIN estimates e ON e.order_id=o.id
           LEFT JOIN estimate_items ei ON ei.estimate_id=e.id
           WHERE o.{column} IN ({placeholders})"""
            + (" AND o.segment=?" if segment else "")
            + """
           GROUP BY o.id
           ORDER BY o.id""",
            (*chunk, segment) if segment else tuple(chunk),
        ).fetchall()
        for row in rows:
            value = dict(row)
            ref_id = value.pop("ref_id")
            value["total_cost"] = round(value["parts_cost"] + value["labor_cost"] + value["fee_cost"], 2)
            per_ref[ref_id].append(value)

    for ref_id, orders in per_ref.items():
        result[ref_id] = _rollup_from_orders(orders)
    return result


def _rollup_from_orders(orders: list[dict]) -> dict:
    """The per-vehicle totals, given that vehicle's already-summed tickets."""
    # Voided ROs (started by mistake) are kept in the order history
    # (traceability) but never count toward the vehicle's cost -- that work
    # was never actually done.
    countable = [o for o in orders if not o["voided"]]
    # Tickets the shop considers done. Only these turn an unreceived part into
    # a problem: on an open ticket the same line is simply work still ahead.
    closed = [o for o in countable if o["status"] == "complete"]
    # ...and the other side of that same line: only a ticket that is still
    # open can be waiting on a vendor. Closing a ticket is the shop saying the
    # work is finished, and from that moment the app already reads an
    # unreceived part line as money spent and never receipted (closed, above)
    # -- so counting it here as well put one part on the board twice with
    # opposite meanings. A finished car sat in "Ready to go" while the Waiting
    # on Parts card counted it and the On Order desk told somebody to ring the
    # vendor about a car that had already gone back on the lot. Same reason
    # add_lot_status zeroes remaining_cost on a finished car: nothing more is
    # coming, and a row that says so must not also claim otherwise.
    awaiting = [o for o in countable if o["status"] != "complete"]
    return {
        "orders": orders,
        "total_cost": round(sum(o["total_cost"] for o in countable), 2),
        "quoted_cost": round(sum(o["quoted_cost"] for o in countable), 2),
        # Only an open ticket can still cost anything. A part left unreceived
        # on a closed one is money that has already gone out of the door --
        # that is precisely what unreceived_closed_cost below says about it --
        # so counting it here as well put the same dollars on the same row
        # twice with opposite meanings: "$380.00 of work left" beside "$380.00
        # not in the cost". add_lot_status hid it on a car whose every ticket
        # was closed, by zeroing remaining_cost on a finished car; the moment
        # a second ticket was written -- the everyday "it came back" case --
        # the car left the finished pile and the old ticket's spent money
        # reappeared as a bill still to come.
        "open_cost": round(sum(o["open_cost"] for o in awaiting), 2),
        "labor_hours": round(sum(o["labor_hours"] for o in countable), 2),
        "parts_pending": int(sum(o["parts_pending"] for o in awaiting)),
        "parts_pending_value": round(sum(o["parts_pending_value"] for o in awaiting), 2),
        "unreceived_cost": round(sum(o["unreceived_cost"] for o in countable), 2),
        "unreceived_closed_cost": round(sum(o["unreceived_cost"] for o in closed), 2),
        "unreceived_closed_parts": int(sum(o["unreceived_parts"] for o in closed)),
    }


# How many outstanding repairs the "still needs" sentence names before it
# gives up and counts the rest. Three fits a printed cell; a car with nine
# open jobs would otherwise take a whole line to itself and push everything
# else on the row out of sight.
NEEDS_JOB_LIMIT = 3


def job_progress_map(
    db: sqlite3.Connection, column: str, ref_ids: Sequence[int], segment: str | None = None
) -> dict[int, dict]:
    """Which repairs this car is still owed, and how far through them it is.

    A ticket's status is one flag for the whole car, so on its own it can only
    say "in progress" -- it cannot tell Walt that the brakes are finished and
    the windshield is not. Jobs already carve a ticket into the individual
    repairs; this reads how many of them have been ticked off, and keeps the
    titles of the ones that haven't so the answer can be given in words
    instead of in dollars.

    Voided tickets are excluded for the same reason cost_rollup excludes them
    -- that work was cancelled, so its jobs are not outstanding work -- and
    **closed tickets** are excluded for the reason right beside it: closing a
    ticket is the shop saying the work is done. Ticking each repair off is a
    habit not everybody has, so a closed ticket routinely carries repairs that
    were never ticked; left in, they were the car's answer to "what does it
    still need" forever. A car sitting in Ready to go drew "0 of 2 repairs
    finished" on its card, and a car that came back on a second ticket was
    listed as still needing the windshield it had already had.

    Counting them as *finished* instead of dropping them would be the same
    wrong answer wearing a different hat: it empties jobs_open while leaving
    jobs_total set, which is the exact shape open_jobs_text reads as "all 2
    jobs ticked off -- close the ticket", said about a ticket that is already
    closed. What is true is that a finished ticket is asking for nothing, so
    it contributes nothing here.

    One query for the whole board rather than one per car -- same contract as
    technician_names_map: every id passed in comes back, cars with no
    outstanding repairs getting the all-zero shape.
    """
    result = {ref_id: {"jobs_total": 0, "jobs_done": 0, "jobs_open": []} for ref_id in ref_ids}
    ids = _unique_ids(ref_ids)
    if not ids:
        return result
    for chunk in _chunked(ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT o.{column} ref_id, ej.title, ej.completed_at
                  FROM estimate_jobs ej
                  JOIN estimates e ON e.id=ej.estimate_id
                  JOIN orders o ON o.id=e.order_id
                 WHERE o.{column} IN ({placeholders}) AND o.voided=0 AND o.status!='complete'"""
            + (" AND o.segment=?" if segment else "")
            + " ORDER BY o.id, ej.sort_order, ej.id",
            (*chunk, segment) if segment else tuple(chunk),
        ).fetchall()
        for row in rows:
            entry = result[row["ref_id"]]
            entry["jobs_total"] += 1
            if row["completed_at"]:
                entry["jobs_done"] += 1
            else:
                entry["jobs_open"].append(row["title"])
    return result


def resolve_unit(db: sqlite3.Connection, vehicle_id: int, vin: str | None, ts: str) -> int:
    """Attach a vehicle row to the physical car it describes, found by VIN.

    This is the single point where the recon half and the we-owe half of one
    car's life meet. A car recon'd under the shop's own account and later sold
    and brought back on a we-owe is two `vehicles` rows by necessity (that
    table carries a NOT NULL customer_id), and matching their VINs here is what
    lets the money from both halves land on one ledger.

    A vehicle with no VIN still gets a unit, just a private one -- the app has
    to keep working for a car someone entered in a hurry.
    """
    key = normalize_vin(vin)
    if key:
        found = db.execute("SELECT id FROM vehicle_units WHERE vin_key=?", (key,)).fetchone()
        if found:
            db.execute("UPDATE vehicles SET unit_id=? WHERE id=?", (found["id"], vehicle_id))
            return found["id"]
    unit_id = inserted_id(
        db.execute("INSERT INTO vehicle_units(vin_key,created_at,updated_at) VALUES(?,?,?)", (key, ts, ts))
    )
    db.execute("UPDATE vehicles SET unit_id=? WHERE id=?", (unit_id, vehicle_id))
    return unit_id


def unit_id_for_vehicle(db: sqlite3.Connection, vehicle_id: int, ts: str) -> int:
    """The unit a vehicle belongs to, creating it if this row predates units."""
    row = db.execute("SELECT id, unit_id, vin FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Vehicle not found")
    if row["unit_id"]:
        return row["unit_id"]
    return resolve_unit(db, vehicle_id, row["vin"], ts)


def relink_unit(db: sqlite3.Connection, vehicle_id: int, new_vin: str | None, ts: str) -> int:
    """Re-point a vehicle at the right unit after its VIN was corrected.

    A VIN typed wrong at intake and fixed later is exactly the case where a
    car would otherwise stay stranded on a unit of its own forever, so the
    correction has to move it. Any economics already entered against the old
    private unit come along, rather than being silently abandoned -- but only
    into blanks, so a figure already recorded on the shared unit wins.
    """
    current = db.execute("SELECT unit_id FROM vehicles WHERE id=?", (vehicle_id,)).fetchone()
    old_unit_id = current["unit_id"] if current else None
    new_unit_id = resolve_unit(db, vehicle_id, new_vin, ts)
    if not old_unit_id or old_unit_id == new_unit_id:
        return new_unit_id

    old = db.execute("SELECT * FROM vehicle_units WHERE id=?", (old_unit_id,)).fetchone()
    new = db.execute("SELECT * FROM vehicle_units WHERE id=?", (new_unit_id,)).fetchone()
    if old and new:
        merged = {
            "purchase_price": new["purchase_price"] or old["purchase_price"],
            "purchase_source": new["purchase_source"] or old["purchase_source"],
            "purchase_date": new["purchase_date"] or old["purchase_date"],
            "sale_price": new["sale_price"] if new["sale_price"] is not None else old["sale_price"],
            "sale_date": new["sale_date"] or old["sale_date"],
        }
        db.execute(
            """UPDATE vehicle_units SET purchase_price=?,purchase_source=?,purchase_date=?,
                                        sale_price=?,sale_date=?,updated_at=? WHERE id=?""",
            (*merged.values(), ts, new_unit_id),
        )
    # Only drop the vacated unit if nothing else still points at it.
    still_used = db.execute("SELECT 1 FROM vehicles WHERE unit_id=? LIMIT 1", (old_unit_id,)).fetchone()
    if not still_used:
        db.execute("DELETE FROM vehicle_units WHERE id=?", (old_unit_id,))
    return new_unit_id


def _ids_by_unit(db: sqlite3.Connection, table: str, unit_ids: Sequence[int]) -> dict[int, list[int]]:
    """The recon episodes (or we-owe promises) hanging off each physical car."""
    result: dict[int, list[int]] = {unit_id: [] for unit_id in unit_ids}
    ids = _unique_ids(unit_ids)
    if not ids:
        return result
    for chunk in _chunked(ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT v.unit_id, t.id FROM {table} t JOIN vehicles v ON v.id=t.vehicle_id
                 WHERE v.unit_id IN ({placeholders}) ORDER BY t.id""",
            tuple(chunk),
        ).fetchall()
        for row in rows:
            result[row["unit_id"]].append(row["id"])
    return result


def unit_lifetimes(db: sqlite3.Connection, unit_ids: Sequence[int]) -> dict[int, dict]:
    """unit_lifetime for a whole list of cars, in a fixed number of queries.

    The profit report asks this about every car in the range at once, and one
    car's answer already spans several tables -- doing that per car meant the
    report got slower every month whether or not anything about it changed.
    Units that don't exist are simply absent from the result.
    """
    units = {}
    for chunk in _chunked(_unique_ids(unit_ids)):
        placeholders = ",".join("?" for _ in chunk)
        for row in db.execute(f"SELECT * FROM vehicle_units WHERE id IN ({placeholders})", tuple(chunk)):
            units[row["id"]] = row
    found = list(units)

    recon_ids_by_unit = _ids_by_unit(db, "recon_vehicles", found)
    we_owe_ids_by_unit = _ids_by_unit(db, "we_owe_items", found)
    recon_rollups = cost_rollups(db, "recon_vehicle_id", [i for ids in recon_ids_by_unit.values() for i in ids])
    we_owe_rollups = cost_rollups(db, "we_owe_id", [i for ids in we_owe_ids_by_unit.values() for i in ids])
    paid = we_owe_payment_totals(db, [i for ids in we_owe_ids_by_unit.values() for i in ids])

    return {
        unit_id: _unit_lifetime(
            unit_id,
            units[unit_id],
            [recon_rollups[i] for i in recon_ids_by_unit[unit_id]],
            [we_owe_rollups[i] for i in we_owe_ids_by_unit[unit_id]],
            sum(paid[i] for i in we_owe_ids_by_unit[unit_id]) if we_owe_ids_by_unit[unit_id] else 0.0,
        )
        for unit_id in found
    }


def unit_lifetime(db: sqlite3.Connection, unit_id: int) -> dict:
    """Everything one physical car cost and earned, across its whole life.

    This is the number the owner is actually after: not "what did recon cost"
    but "what is this car up to, counting the we-owe work that landed weeks
    after it was sold and quietly ate the margin". So it sums every ticket
    reachable from every recon episode AND every we-owe promise on this VIN,
    then nets out whatever the customer chipped in on the we-owe side.
    """
    lifetime = unit_lifetimes(db, [unit_id]).get(unit_id)
    if lifetime is None:
        raise HTTPException(404, "Vehicle unit not found")
    return lifetime


def _unit_lifetime(
    unit_id: int,
    unit: sqlite3.Row,
    recon_rollups: list[dict],
    we_owe_rollups: list[dict],
    customer_paid: float,
) -> dict:
    """The lifetime arithmetic, once its inputs have been gathered.

    profit is None when it cannot honestly be worked out, which is either of
    two cases. No sale price: an unsold car has a cost, not a profit, and
    showing 0 or a negative would read as a loss it hasn't taken. No purchase
    price: the lot's cost for the car is deliberately not tracked in this app
    (Walt keeps that figure -- see CLAUDE.md), and subtracting an absent
    purchase from a real sale price would report the whole sale as margin. A
    missing number has to stay missing rather than become a flattering one.
    Cars from when purchase price *was* entered still get a real profit.

    The costs here are what landed, exactly as everywhere else in the app: a
    part only counts once somebody marks it received. On recon that step is
    the one that gets skipped (see cost_rollups), so this car's cost -- and
    therefore its profit -- can be short by real money that already went out
    the door. The shortfall is carried alongside rather than folded in, for
    the same reason total_cost never folds it in: what landed is a fact, and
    what was bought and never receipted is a different fact the screens are
    expected to say out loud. Nothing here subtracts it, and nothing should.
    """
    all_rollups = recon_rollups + we_owe_rollups
    recon_cost = sum(r["total_cost"] for r in recon_rollups)
    we_owe_cost = sum(r["total_cost"] for r in we_owe_rollups)
    # Every hour any tech flagged on this car, across both halves of its life.
    # On recon and we-owe the rate is 0, so this is the only measure of the
    # work that actually went into it.
    labor_hours = round(sum(r["labor_hours"] for r in all_rollups), 2)
    # Both halves of the car's life, because the question the profit report
    # asks spans both -- a car whose we-owe tires were never receipted is
    # understated by exactly as much as if they had been recon tires.
    unreceived_closed_cost = round(sum(r["unreceived_closed_cost"] for r in all_rollups), 2)
    unreceived_closed_parts = int(sum(r["unreceived_closed_parts"] for r in all_rollups))

    purchase_price = unit["purchase_price"] or 0.0
    we_owe_net = round(we_owe_cost - customer_paid, 2)
    total_invested = round(purchase_price + recon_cost + we_owe_net, 2)
    sale_price = unit["sale_price"]
    profit = round(sale_price - total_invested, 2) if sale_price is not None and purchase_price > 0 else None
    return {
        "unit_id": unit_id,
        "vin": unit["vin_key"] or "",
        "purchase_price": round(purchase_price, 2),
        "purchase_source": unit["purchase_source"],
        "purchase_date": unit["purchase_date"],
        "recon_cost": round(recon_cost, 2),
        "we_owe_cost": round(we_owe_cost, 2),
        "labor_hours": labor_hours,
        "we_owe_customer_paid": round(customer_paid, 2),
        "we_owe_net_cost": we_owe_net,
        "total_invested": total_invested,
        # Money already spent on this car that none of the figures above
        # include. Same two field names the board row carries, so the Profit
        # report's warning and the Vehicles board's badge are one fact said
        # twice rather than two rules that can drift apart.
        "unreceived_closed_cost": unreceived_closed_cost,
        "unreceived_closed_parts": unreceived_closed_parts,
        "sale_price": sale_price,
        "sale_date": unit["sale_date"],
        "profit": profit,
        # Margin is against the sale price, which is how a lot talks about it
        # ("we made 12 points on that car"), not against what was put in.
        "margin_pct": round(profit / sale_price * 100, 1) if profit is not None and sale_price else None,
        "recon_count": len(recon_rollups),
        "we_owe_count": len(we_owe_rollups),
    }


def recon_match(db: sqlite3.Connection, stock_number: str | None, vin: str | None) -> dict:
    """Is this car already on the board?

    Intake is the one place a physical car becomes a record, and it is the one
    place the app can still tell the difference. Once the same car is written
    down twice, every question the owner asks about it splits in half: the lot
    count is one too high, "what did we spend on this car" is answered twice
    with two partial numbers, and neither row knows the other exists.

    Two ways in, both seen in the wild:

    * the stock number typed with the dash one day and without it the next --
      the exact-match check this replaces let R-1042 and R1042 both through;
    * a car re-entered under a fresh stock number, which the stock check could
      never have caught because the stock number really is new.

    Returns whichever recon record already exists for either key, live records
    preferred over archived ones -- a car sitting on the lot right now is a
    more useful thing to be told about than one retired months ago. Both are
    reported, because they mean different things to the caller: a live match
    is a mistake, an archived one is usually a car coming back.
    """
    stock_key = normalize_stock_number(stock_number)
    vin_key = normalize_vin(vin)
    if not stock_key and not vin_key:
        return {"stock_number": None, "vin": None}

    rows = db.execute(
        """SELECT rv.id, rv.stock_number, rv.archived_at, v.vin,
                  v.year || ' ' || v.make || ' ' || v.model description
             FROM recon_vehicles rv JOIN vehicles v ON v.id = rv.vehicle_id
            ORDER BY rv.id"""
    ).fetchall()

    def described(row: sqlite3.Row) -> dict:
        return {
            "recon_id": row["id"],
            "stock_number": row["stock_number"],
            "vehicle": row["description"],
            "vin": row["vin"],
            "archived": bool(row["archived_at"]),
        }

    def best(matches: list[sqlite3.Row]) -> dict | None:
        # Live before archived, and within each the most recent record -- the
        # one somebody would actually be looking for.
        live = [row for row in matches if not row["archived_at"]]
        chosen = (live or matches)[-1] if matches else None
        return described(chosen) if chosen else None

    return {
        "stock_number": best([r for r in rows if normalize_stock_number(r["stock_number"]) == stock_key])
        if stock_key
        else None,
        "vin": best([r for r in rows if normalize_vin(r["vin"]) == vin_key]) if vin_key else None,
    }


def _already_here(subject: str, match: dict) -> str:
    """The refusal, written so the next move is obvious.

    "Stock number already in use" was true and useless -- it named neither the
    car holding the number nor what to do about it, and if that car had been
    archived to History the advisor could look down the whole board without
    ever finding it.
    """
    car = f"{match['stock_number']} — {match['vehicle']}".strip(" —")
    if match["archived"]:
        return f"{subject} belongs to {car}, which is in History. Reopen that vehicle instead of adding it again"
    return f"{subject} belongs to {car}, which is already on the board"


def _assert_not_archived(row: sqlite3.Row) -> None:
    if row["archived_at"]:
        raise HTTPException(409, "This vehicle is archived to History -- reopen it to make changes")


def order_vehicle_archived(db: sqlite3.Connection, order_row: sqlite3.Row) -> bool:
    """Is this ticket's vehicle filed away to History?

    The question assert_vehicle_editable asks, without the exception -- some
    callers need to *report* that a ticket is frozen rather than refuse a
    request outright (see workflow.parts_bill_block_reason, and the ticket
    picker on the A/P screen that reads the same fact off /api/orders).
    Retail orders have neither a recon_vehicle_id nor a we_owe_id, so they
    are never archived.
    """
    for column, table in (("recon_vehicle_id", "recon_vehicles"), ("we_owe_id", "we_owe_items")):
        ref_id = order_row[column]
        if not ref_id:
            continue
        # Table name is one of two literals chosen right here, never user text.
        row = db.execute(f"SELECT archived_at FROM {table} WHERE id=?", (ref_id,)).fetchone()
        if row and row["archived_at"]:
            return True
    return False


def assert_vehicle_editable(db: sqlite3.Connection, order_row: sqlite3.Row) -> None:
    """Once a vehicle's ticket is archived to History it's fully frozen --
    reopening it is the only way back to an editable state. Retail orders
    have neither a recon_vehicle_id nor a we_owe_id, so this is always a
    no-op for them; archiving only applies to recon/we-owe vehicles.

    Also blocks any further edit to an order that's been voided -- voiding
    means "this never happened, don't count it," which every single caller
    of this function (status, concern, notes, assignment, estimate, jobs,
    ordering/receiving parts, invoicing) would otherwise silently let keep
    changing, including posting a real vendor A/P invoice against a
    cancelled job."""
    if order_row["voided"]:
        raise HTTPException(409, "This repair order has been voided and can no longer be edited")
    if order_vehicle_archived(db, order_row):
        raise HTTPException(409, "This vehicle is archived to History -- reopen it to make changes")


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


def technician_names_map(
    db: sqlite3.Connection, column: str, ref_ids: Sequence[int], segment: str | None = None
) -> dict[int, list[str]]:
    """Every technician assigned to any of a vehicle's tickets, per vehicle.

    Keyed on the vehicle rather than on a list of ticket ids so the board can
    ask once for the whole list. Names come back sorted, and a vehicle with no
    technician assigned yet gets an empty list rather than being missing.
    """
    result: dict[int, list[str]] = {ref_id: [] for ref_id in ref_ids}
    ids = _unique_ids(ref_ids)
    if not ids:
        return result
    for chunk in _chunked(ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT DISTINCT o.{column} ref_id, s.name
                  FROM orders o
                  JOIN order_workflow w ON w.order_id=o.id
                  JOIN staff s ON s.id=w.technician_id
                 WHERE o.{column} IN ({placeholders}) AND w.technician_id IS NOT NULL AND o.voided=0"""
            + (" AND o.segment=?" if segment else "")
            + " ORDER BY s.name",
            (*chunk, segment) if segment else tuple(chunk),
        ).fetchall()
        for row in rows:
            result[row["ref_id"]].append(row["name"])
    return result


def vehicle_board_rows(
    db: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
    segment: str | None = None,
    archived: bool | None = False,
) -> list[dict]:
    """The unified Vehicles list: recon + we-owe merged, one row per vehicle,
    with rolled-up cost and assigned technicians. This is the primary view
    of the app and also backs the date-range vehicle-spend report.

    `archived` picks which side of History to read: False is the live job
    board, True is History, and None is both -- which is what the spend report
    asks for, because a car that was sold last month is exactly the car
    "what did we spend in July" is about.

    A date range here means *the car was on the lot during it*, not "its record
    happens to be stamped inside it". Those are not the same question and the
    difference was not a small one: a car written down in June and still in the
    shop in August fell out of every ranged report the moment August began, so
    the spend report showed one car out of eight and totalled $0.00 on a lot
    that had real money in it -- while the Lot Status sheet one chip over, built
    from these same rows unfiltered, showed the money. Two screens, one shop,
    opposite answers.

    So the window is an overlap test against the span the car was actually
    here: it arrived by the end of the range, and it had not already been filed
    to History before the range began. A car still on the lot has no end date
    yet, so `now` stands in for one -- which also keeps a range that hasn't
    happened yet empty, rather than matching every live car forever.

    Every per-vehicle number here is fetched for the whole list at once rather
    than car by car. This screen reloads after every save, and History and the
    all-time reports have no upper bound on how many cars they cover, so a
    handful of queries per car is a screen that gets slower every month the
    shop uses the app."""
    end_bound = f"{end}T23:59:59" if end else None
    archived_flag = None if archived is None else (1 if archived else 0)
    # The open end of a live car's stay. Shop-local, like every stamp the range
    # is compared against -- see db.now().
    still_here = db_now()
    result = []
    if segment in (None, "recon"):
        rows = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage, v.plate, v.plate_state, v.unit_id,
                      u.purchase_price unit_purchase_price, u.sale_price unit_sale_price
               FROM recon_vehicles rv
               JOIN vehicles v ON v.id=rv.vehicle_id
               LEFT JOIN vehicle_units u ON u.id=v.unit_id
               WHERE (:end IS NULL OR rv.created_at<=:end)
                 AND (:start IS NULL OR coalesce(nullif(rv.archived_at,''), :still_here)>=:start)
                 AND (:archived IS NULL OR (rv.archived_at != '') = :archived)
               ORDER BY rv.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag, "still_here": still_here},
        ).fetchall()
        recon_ids = [row["id"] for row in rows]
        rollups = cost_rollups(db, "recon_vehicle_id", recon_ids)
        activity = last_activity_map(db, "recon_vehicle_id", recon_ids)
        techs = technician_names_map(db, "recon_vehicle_id", recon_ids)
        jobs = job_progress_map(db, "recon_vehicle_id", recon_ids)
        for row in rows:
            rollup = rollups[row["id"]]
            # Voided tickets are excluded from everything the row says the car
            # is doing, the same way they're already excluded from what it
            # cost -- see live_orders.
            live = live_orders(rollup["orders"])
            voided_count = len(rollup["orders"]) - len(live)
            # The repair order's own status is what the advisor actually
            # maintains, so that's what drives the displayed status and
            # in-progress/finished bucket -- except a settled sale, the one
            # recon-status fact that outranks the tickets. See
            # recon_sold_and_settled.
            active_order = next((o for o in reversed(live) if o["status"] != "complete"), None)
            latest_order = live[-1] if live else None
            current_order = active_order or latest_order
            sold = recon_sold_and_settled(row["status"], rollup["orders"])
            display_status = "sold" if sold else (current_order["status"] if current_order else "acquired")
            activity_at = activity.get(row["id"]) or row["created_at"]
            result.append(
                {
                    "segment": "recon",
                    "recon_id": row["id"],
                    "we_owe_id": None,
                    # Which side of the live-board/History divide this car is
                    # on -- the needs sentence reads it, so a sold car already
                    # in History isn't told to be sent there.
                    #
                    # Read off the row, not off the `archived` argument. They
                    # agree whenever the caller asked for one side or the
                    # other, and they cannot when it asked for both: archived
                    # is None there, so every row -- filed or not -- came back
                    # claiming to be live, and anything reading this field had
                    # to know not to ask that way.
                    "archived": bool(row["archived_at"]),
                    "stock_number": row["stock_number"],
                    "vehicle": f"{row['year']} {row['make']} {row['model']}",
                    "vin": row["vin"],
                    # Carried on every board row because the search bar filters
                    # this list in the browser -- a plate the row doesn't hold
                    # is a plate nobody can find the car by.
                    "plate": row["plate"],
                    "plate_state": row["plate_state"],
                    "status": display_status,
                    "status_bucket": "finished" if sold else order_status_bucket(rollup["orders"]),
                    # From the unit, not recon_vehicles' legacy column of the same
                    # name -- one car, one purchase price, whichever half of its
                    # life you happen to be looking at.
                    "purchase_price": row["unit_purchase_price"] or 0,
                    "sale_price": row["unit_sale_price"],
                    "unit_id": row["unit_id"],
                    "actual_cost": rollup["total_cost"],
                    "quoted_cost": rollup["quoted_cost"],
                    "open_cost": rollup["open_cost"],
                    "labor_hours": rollup["labor_hours"],
                    "parts_pending": rollup["parts_pending"],
                    "parts_pending_value": rollup["parts_pending_value"],
                    "unreceived_cost": rollup["unreceived_cost"],
                    "unreceived_closed_cost": rollup["unreceived_closed_cost"],
                    "unreceived_closed_parts": rollup["unreceived_closed_parts"],
                    "technicians": techs[row["id"]],
                    **jobs[row["id"]],
                    # The ticket a board-level action should attach itself to:
                    # the open one if there is one, else the most recent, else
                    # nothing (a car with no ticket yet). Tasks created off the
                    # board link through this, so "follow up on that stalled car"
                    # lands on the RO rather than floating unattached.
                    "order_id": current_order["id"] if current_order else None,
                    # The short number written on the paper ticket and said
                    # down the phone. On the board so it can be searched for:
                    # an advisor holding an RO had no way to get from it to
                    # the car except by opening tickets until one matched.
                    "ro_number": current_order["ro_number"] if current_order else 0,
                    "order_number": current_order["number"] if current_order else "",
                    # How many tickets on this car were taken back. Only used
                    # to tell "nobody has written one" apart from "the one
                    # somebody wrote was voided" -- two rows that otherwise
                    # read identically and need different things done to them.
                    "voided_order_count": voided_count,
                    "updated_at": row["updated_at"],
                    # The counter a board-level action has to send back to prove it
                    # is acting on the row it was shown -- see file_away_settled.
                    # Every per-record write in the app is a compare-and-set on it
                    # (tests/test_optimistic_locking.py), and an action offered from
                    # a list rather than from the record's own page has no other way
                    # to reach one.
                    "edit_version": row["edit_version"],
                    # Carried alongside the count so the board can say what it
                    # is counting from -- "34d" is worth arguing with, "on the
                    # lot since June 27" is worth acting on.
                    "acquired_at": row["acquisition_date"] or "",
                    "age_days": lot_age_days(row["acquisition_date"], row["created_at"]),
                    # The day the car left, empty on everything still on the
                    # lot. Two things need it and both need it non-null: the
                    # reports can be asked for both sides of History at once,
                    # where a sold car with no mark on it reads as one still
                    # sitting on the lot; and History itself, where the day it
                    # left is the one fact that screen exists to record -- see
                    # days_on_lot.
                    "archived_at": row["archived_at"] or "",
                    "days_on_lot": days_on_lot(row["acquisition_date"] or row["created_at"], row["archived_at"]),
                    "last_activity_at": activity_at,
                    "idle_days": idle_days(activity_at),
                }
            )
    if segment in (None, "we_owe"):
        rows = db.execute(
            """SELECT w.*, c.name customer_name, v.year, v.make, v.model, v.vin,
                      v.plate, v.plate_state, v.unit_id,
                      u.purchase_price unit_purchase_price, u.sale_price unit_sale_price
               FROM we_owe_items w
               JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               LEFT JOIN vehicle_units u ON u.id=v.unit_id
               WHERE (:end IS NULL OR w.created_at<=:end)
                 AND (:start IS NULL OR coalesce(nullif(w.archived_at,''), :still_here)>=:start)
                 AND (:archived IS NULL OR (w.archived_at != '') = :archived)
               ORDER BY w.created_at DESC""",
            {"start": start, "end": end_bound, "archived": archived_flag, "still_here": still_here},
        ).fetchall()
        we_owe_ids = [row["id"] for row in rows]
        rollups = cost_rollups(db, "we_owe_id", we_owe_ids)
        activity = last_activity_map(db, "we_owe_id", we_owe_ids)
        techs = technician_names_map(db, "we_owe_id", we_owe_ids)
        jobs = job_progress_map(db, "we_owe_id", we_owe_ids)
        paid = we_owe_payment_totals(db, we_owe_ids)
        for row in rows:
            rollup = rollups[row["id"]]
            # Same rule as recon above: a voided ticket says nothing about the
            # promise, and voiding one is certainly not keeping it.
            live = live_orders(rollup["orders"])
            voided_count = len(rollup["orders"]) - len(live)
            active_order = next((o for o in reversed(live) if o["status"] != "complete"), None)
            latest_order = live[-1] if live else None
            current_order = active_order or latest_order
            # fulfilled/waived is the authoritative "is this promise resolved"
            # signal (set explicitly by the advisor, separate from any
            # ticket) -- but while it's still open, what's actually changing
            # day to day is the linked ticket's own workflow status, so that's
            # what the board shows, same as recon already does.
            display_status = (
                row["status"] if row["status"] != "open" else (current_order["status"] if current_order else "open")
            )
            customer_paid = round(paid[row["id"]], 2)
            activity_at = activity.get(row["id"]) or row["created_at"]
            status_bucket = we_owe_status_bucket(row["status"], rollup["orders"])
            result.append(
                {
                    "segment": "we_owe",
                    "recon_id": None,
                    "we_owe_id": row["id"],
                    # Same reason as the recon rows, and read off the row for
                    # the same reason: the needs wording is allowed to differ
                    # between the live board and History.
                    "archived": bool(row["archived_at"]),
                    "stock_number": row["lot_stock_number"] or None,
                    "vehicle": f"{row['year']} {row['make']} {row['model']}",
                    "vin": row["vin"],
                    "plate": row["plate"],
                    "plate_state": row["plate_state"],
                    "customer_name": row["customer_name"],
                    "description": row["description"],
                    "status": display_status,
                    "status_bucket": status_bucket,
                    # What the salesman told the customer they'd get their car
                    # back by. It was captured at intake and then shown nowhere
                    # anybody makes decisions -- the board, the summary cards
                    # and the lot sheet all read these two fields now, so a
                    # promise going past due is visible without opening the car.
                    "target_date": row["target_date"],
                    "promise_days_late": promise_days_late(row["target_date"], status_bucket),
                    # A we-owe car has a purchase price too -- it's just usually
                    # entered here, because the shop bought and recon'd it long
                    # before RECON ever saw it.
                    "purchase_price": row["unit_purchase_price"] or 0,
                    "sale_price": row["unit_sale_price"],
                    "unit_id": row["unit_id"],
                    "actual_cost": rollup["total_cost"],
                    "quoted_cost": rollup["quoted_cost"],
                    "open_cost": rollup["open_cost"],
                    "labor_hours": rollup["labor_hours"],
                    "parts_pending": rollup["parts_pending"],
                    "parts_pending_value": rollup["parts_pending_value"],
                    "unreceived_cost": rollup["unreceived_cost"],
                    "unreceived_closed_cost": rollup["unreceived_closed_cost"],
                    "unreceived_closed_parts": rollup["unreceived_closed_parts"],
                    "customer_paid": customer_paid,
                    "net_cost": round(rollup["total_cost"] - customer_paid, 2),
                    "technicians": techs[row["id"]],
                    **jobs[row["id"]],
                    # The ticket a board-level action should attach itself to:
                    # the open one if there is one, else the most recent, else
                    # nothing (a car with no ticket yet). Tasks created off the
                    # board link through this, so "follow up on that stalled car"
                    # lands on the RO rather than floating unattached.
                    "order_id": current_order["id"] if current_order else None,
                    # Same as recon above -- see there.
                    "ro_number": current_order["ro_number"] if current_order else 0,
                    "order_number": current_order["number"] if current_order else "",
                    "voided_order_count": voided_count,
                    "updated_at": row["updated_at"],
                    # The counter a board-level action has to send back to prove it
                    # is acting on the row it was shown -- see file_away_settled.
                    # Every per-record write in the app is a compare-and-set on it
                    # (tests/test_optimistic_locking.py), and an action offered from
                    # a list rather than from the record's own page has no other way
                    # to reach one.
                    "edit_version": row["edit_version"],
                    # No arrival date on this side, and none wanted: a we-owe's
                    # clock starts when the promise was made, which is what
                    # created_at already is. The car itself was sold weeks ago.
                    "acquired_at": "",
                    "age_days": age_days(row["created_at"]),
                    # Same as recon above: which side of History this one is
                    # on, counted from the day the promise was made -- that is
                    # when this side's clock starts.
                    "archived_at": row["archived_at"] or "",
                    "days_on_lot": days_on_lot(row["created_at"], row["archived_at"]),
                    "last_activity_at": activity_at,
                    "idle_days": idle_days(activity_at),
                }
            )
    # Every board row carries its pile and its "what's it waiting on" sentence.
    # Computed once here so the Vehicles screen's columns, the Lot Report's
    # sections, the printed sheet and the CSV are all reading the same answer.
    return [add_lot_status(row) for row in result]


def build_recon_router(connect: Callable[[], sqlite3.Connection], now_fn: Callable[[], str]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def assert_current_version(row: sqlite3.Row, expected_version: int | None) -> None:
        """Fail fast, with a clear message, before doing any work.

        This is a courtesy check, not the guarantee -- see version_guard. On its
        own it is check-then-act: two saves can both read the same version and
        both pass here before either writes.
        """
        if expected_version is not None and expected_version != row["edit_version"]:
            raise HTTPException(409, "Someone else changed this since you loaded it -- reload to see their update")

    def version_guard(expected_version: int | None) -> tuple[str, tuple[object, ...]]:
        """SQL fragment making an UPDATE apply only if the row is still at the
        version the client loaded.

        Appended to the UPDATE that bumps edit_version, so the comparison
        happens against what is actually committed at write time rather than
        what was read moments earlier. Callers must treat rowcount == 0 as a
        409: the row is known to exist (the *_row helpers already 404), so the
        only way to match nothing is that someone else got there first.
        """
        if expected_version is None:
            return "", ()
        return " AND edit_version=?", (expected_version,)

    def assert_version_won(cur: sqlite3.Cursor, message: str) -> None:
        if cur.rowcount == 0:
            raise HTTPException(409, message)

    def recon_row(db: sqlite3.Connection, recon_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT rv.*, v.year, v.make, v.model, v.vin, v.mileage, v.odometer_broken,
                      v.trim, v.engine, v.color, v.plate, v.plate_state, v.unit_id
               FROM recon_vehicles rv JOIN vehicles v ON v.id=rv.vehicle_id WHERE rv.id=?""",
            (recon_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Recon vehicle not found")
        return row

    def recon_detail(db: sqlite3.Connection, recon_id: int) -> dict:
        row = recon_row(db, recon_id)
        detail = dict(row)
        rollup = cost_rollup(db, "recon_vehicle_id", recon_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["open_cost"] = rollup["open_cost"]
        detail["labor_hours"] = rollup["labor_hours"]
        # The same finished/in-progress answer the board gives, so the detail
        # page can tell a car that has gone quiet from one that is simply done
        # -- see is_stalled. Without it the page had no way to know, and put a
        # "Stalled 41 days -- make a task" nudge on finished work. A settled
        # sale counts as done here for the same reason it does on the board.
        detail["status_bucket"] = (
            "finished"
            if recon_sold_and_settled(row["status"], rollup["orders"])
            else order_status_bucket(rollup["orders"])
        )
        # Purchase and sale price come off the unit, which is what makes them
        # survive the car being sold and coming back on a we-owe. The legacy
        # recon_vehicles columns of the same name are no longer authoritative.
        unit_id = unit_id_for_vehicle(db, row["vehicle_id"], now_fn())
        lifetime = unit_lifetime(db, unit_id)
        detail["purchase_price"] = lifetime["purchase_price"]
        detail["sale_price"] = lifetime["sale_price"]
        detail["sale_date"] = lifetime["sale_date"] or detail["sale_date"]
        detail["lifetime"] = lifetime
        # This vehicle's own profit still counts only its own recon spend, so
        # the recon screen keeps meaning what it always did; `lifetime` is
        # where the whole-car picture (we-owe work included) lives.
        # Same rule as unit_lifetime(): no purchase price on file means no
        # honest profit, not a profit that's really just the sale price.
        detail["profit"] = (
            round(lifetime["sale_price"] - lifetime["purchase_price"] - rollup["total_cost"], 2)
            if lifetime["sale_price"] is not None and lifetime["purchase_price"] > 0
            else None
        )
        detail["last_activity"] = last_activity_detail(db, "recon_vehicle_id", recon_id, detail["created_at"])
        return detail

    def we_owe_row(db: sqlite3.Connection, we_owe_id: int) -> sqlite3.Row:
        row = db.execute(
            """SELECT w.*, c.name customer_name, c.phone customer_phone, c.email customer_email,
                      c.address_line1 customer_address_line1, c.address_line2 customer_address_line2,
                      c.city customer_city, c.state customer_state, c.postal_code customer_postal_code,
                      v.year, v.make, v.model, v.vin, v.mileage, v.odometer_broken,
                      v.trim, v.engine, v.color, v.plate, v.plate_state, v.unit_id
               FROM we_owe_items w JOIN customers c ON c.id=w.customer_id JOIN vehicles v ON v.id=w.vehicle_id
               WHERE w.id=?""",
            (we_owe_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "We-owe item not found")
        return row

    def we_owe_detail(db: sqlite3.Connection, we_owe_id: int) -> dict:
        row = we_owe_row(db, we_owe_id)
        detail = dict(row)
        rollup = cost_rollup(db, "we_owe_id", we_owe_id)
        detail["orders"] = rollup["orders"]
        detail["total_cost"] = rollup["total_cost"]
        detail["quoted_cost"] = rollup["quoted_cost"]
        detail["open_cost"] = rollup["open_cost"]
        detail["labor_hours"] = rollup["labor_hours"]
        # Same reason as recon_detail: a waived promise is closed, not stalled.
        # The tickets go in too, so this page and the board cannot disagree
        # about whether the work is done -- see we_owe_status_bucket.
        detail["status_bucket"] = we_owe_status_bucket(row["status"], rollup["orders"])
        payments = [
            dict(p)
            for p in db.execute("SELECT * FROM we_owe_payments WHERE we_owe_id=? ORDER BY id DESC", (we_owe_id,))
        ]
        detail["payments"] = payments
        detail["customer_paid"] = round(sum(p["amount"] for p in payments), 2)
        detail["net_cost"] = round(detail["total_cost"] - detail["customer_paid"], 2)
        # The whole-car picture. On a we-owe this is the point: the promise
        # itself is a cost, and what it does to the car's profit is only
        # visible once the purchase price and the recon spend are alongside it.
        detail["lifetime"] = unit_lifetime(db, unit_id_for_vehicle(db, row["vehicle_id"], now_fn()))
        detail["last_activity"] = last_activity_detail(db, "we_owe_id", we_owe_id, detail["created_at"])
        return detail

    @router.get("/vehicles-board")
    def vehicles_board(
        segment: Literal["recon", "we_owe"] | None = None,
        archived: bool = False,
        view: Literal["active", "history", "void", "all"] | None = None,
    ):
        """The board, read as one of three separate piles of work.

        `view` is what the Vehicles screen sends, and it is the record's state
        rather than the kind of work -- which the segment chips already answer.
        Those two were one control before, so "History" sat in a row of chips
        next to "Recon" and "We-Owe" as if it were a third kind of work, and
        there was nowhere at all to put a third state.

            active   the live board: cars there is something to do about
            history  cars filed away, which is a record and not a lot
            void     cars whose only ticket was taken back

        A voided ticket is a mistake being undone, not work. Left in with the
        live cars it reads as a car nobody has started -- indistinguishable
        from one genuinely waiting -- so it is its own pile now.

        `archived` is kept because the reports call this function directly and
        ask for both sides of History at once; `view` wins when both are sent.
        """
        with connect() as db:
            if view in (None, "all"):
                return vehicle_board_rows(db, segment=segment, archived=archived)
            rows = vehicle_board_rows(db, segment=segment, archived=view == "history")
            if view == "active":
                return [row for row in rows if not is_void_only(row)]
            if view == "void":
                return [row for row in rows if is_void_only(row)]
            return rows

    # --- Recon vehicles ---

    @router.get("/recon/vehicles/lookup")
    def lookup_recon_vehicle(stock_number: str = "", vin: str = ""):
        """What the intake form asks before anybody fills the rest of it in.

        Same matcher the save uses, so the dialog cannot say a car is clear
        and then be refused a moment later. Read-only and cheap: the point is
        to answer while the advisor's cursor is still in the field, not after
        ten more keystrokes have been spent on a car that is already here.
        """
        with connect() as db:
            return recon_match(db, stock_number, vin)

    @router.post("/recon/vehicles", status_code=201)
    def create_recon_vehicle(item: RecondVehicleIn):
        stock_number = item.stock_number.strip().upper()
        with connect() as db:
            match = recon_match(db, stock_number, item.vin)
            if match["stock_number"]:
                raise HTTPException(409, _already_here("Stock number", match["stock_number"]))
            # A VIN that belongs to a car already on the lot is the same car
            # written down twice. A VIN last seen on an archived car is not:
            # Walt buys cars back, and a second recon episode on one VIN is
            # exactly what unit_lifetime exists to add up. So this blocks the
            # live case only, and the intake form says the rest out loud.
            if match["vin"] and not match["vin"]["archived"]:
                raise HTTPException(409, _already_here("That VIN", match["vin"]))
            ts = now_fn()
            vehicle_cur = db.execute(
                "INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,odometer_broken,plate,plate_state,trim,engine,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    RECON_SHOP_CUSTOMER_ID,
                    item.year,
                    item.make.strip(),
                    item.model.strip(),
                    item.vin.strip().upper(),
                    item.mileage,
                    int(item.odometer_broken),
                    normalize_plate(item.plate),
                    item.plate_state.strip().upper(),
                    item.trim.strip(),
                    item.engine.strip(),
                    item.color.strip(),
                    ts,
                ),
            )
            recon_cur = db.execute(
                "INSERT INTO recon_vehicles(vehicle_id,stock_number,acquisition_source,acquisition_date,purchase_price,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    vehicle_cur.lastrowid,
                    stock_number,
                    item.acquisition_source.strip(),
                    item.acquisition_date.strip(),
                    item.purchase_price,
                    item.notes.strip(),
                    ts,
                    ts,
                ),
            )
            # What the car cost belongs to the car, not to this recon episode:
            # the same VIN coming back on a we-owe months later has to find
            # this number waiting for it.
            unit_id = resolve_unit(db, inserted_id(vehicle_cur), item.vin, ts)
            db.execute(
                "UPDATE vehicle_units SET purchase_price=?,purchase_source=?,purchase_date=?,updated_at=? WHERE id=?",
                (item.purchase_price, item.acquisition_source.strip(), item.acquisition_date.strip(), ts, unit_id),
            )
            return recon_detail(db, inserted_id(recon_cur))

    @router.get("/recon/vehicles/{recon_id}")
    def get_recon_vehicle(recon_id: int):
        with connect() as db:
            return recon_detail(db, recon_id)

    @router.post("/recon/vehicles/{recon_id}/archive")
    def archive_recon_vehicle(recon_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = recon_row(db, recon_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE recon_vehicles SET archived_at=?,edit_version=edit_version+1 WHERE id=?{guard}",
                (now_fn(), recon_id, *guard_params),
            )
            assert_version_won(
                cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
            )
            return recon_detail(db, recon_id)

    @router.post("/recon/vehicles/{recon_id}/reopen")
    def reopen_recon_vehicle(recon_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = recon_row(db, recon_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE recon_vehicles SET archived_at='',edit_version=edit_version+1 WHERE id=?{guard}",
                (recon_id, *guard_params),
            )
            assert_version_won(
                cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
            )
            return recon_detail(db, recon_id)

    @router.patch("/recon/vehicles/{recon_id}")
    def update_recon_vehicle(recon_id: int, item: RecondVehiclePatch):
        with connect() as db:
            row = recon_row(db, recon_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(
                    409, "Someone else changed this vehicle since you loaded it -- reload to see their update"
                )
            fields: list[str] = []
            params: list[object] = []
            if item.stock_number is not None:
                stock_number = item.stock_number.strip().upper()
                if not stock_number:
                    raise HTTPException(422, "Stock number can't be blank")
                # Only worth checking when the number actually changes: a save
                # that leaves it alone must not trip over the car's own record,
                # and re-typing R-1042 as "r 1042" is the same number rather
                # than a clash with itself.
                if normalize_stock_number(stock_number) != normalize_stock_number(row["stock_number"]):
                    match = recon_match(db, stock_number, None)["stock_number"]
                    if match and match["recon_id"] != recon_id:
                        raise HTTPException(409, _already_here("Stock number", match))
                fields.append("stock_number=?")
                params.append(stock_number)
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
            acquisition_date = item.acquisition_date.strip() if item.acquisition_date is not None else None
            if acquisition_date is not None:
                # This one is read as a date, not just displayed, so a value
                # that isn't one has to be refused here rather than quietly
                # falling back and leaving the board reporting an age nobody
                # can account for.
                if acquisition_date and parse_stamp(acquisition_date) is None:
                    raise HTTPException(400, "Acquired date must be a calendar date, e.g. 2026-07-31")
                fields.append("acquisition_date=?")
                params.append(acquisition_date)
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
                # Stored the way the search looks for it -- see normalize_plate.
                ("plate", normalize_plate(item.plate) if item.plate is not None else None),
                ("plate_state", item.plate_state.strip().upper() if item.plate_state is not None else None),
                ("mileage", item.mileage),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            ts = now_fn()
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            # A corrected VIN can mean this car is the same one already on file
            # from the other side of its life, so the unit has to be re-resolved
            # rather than left pointing where the typo put it.
            if item.vin is not None:
                unit_id = relink_unit(db, row["vehicle_id"], item.vin, ts)
            else:
                unit_id = unit_id_for_vehicle(db, row["vehicle_id"], ts)

            unit_fields, unit_params = [], []
            for name, value in (
                ("purchase_price", item.purchase_price),
                ("sale_price", item.sale_price),
                ("sale_date", item.sale_date.strip() if item.sale_date is not None else None),
                # Creating the car writes the arrival date to both places;
                # correcting it has to do the same, or the unit ledger keeps
                # the wrong one for the rest of the car's life.
                ("purchase_date", acquisition_date),
            ):
                if value is not None:
                    unit_fields.append(f"{name}=?")
                    unit_params.append(value)
            if unit_fields:
                unit_params += [ts, unit_id]
                db.execute(f"UPDATE vehicle_units SET {','.join(unit_fields)},updated_at=? WHERE id=?", unit_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(ts)
                fields.append("edit_version=edit_version+1")
                params.append(recon_id)
                guard, guard_params = version_guard(item.expected_version)
                params.extend(guard_params)
                cur = db.execute(f"UPDATE recon_vehicles SET {','.join(fields)} WHERE id=?{guard}", params)
                # Raising here rolls back the vehicles/vehicle_units writes
                # above too -- they share this connection's transaction -- so a
                # lost race leaves nothing half-applied.
                assert_version_won(
                    cur, "Someone else changed this vehicle since you loaded it -- reload to see their update"
                )

            return recon_detail(db, recon_id)

    @router.delete("/recon/vehicles/{recon_id}", status_code=204)
    def delete_recon_vehicle(recon_id: int):
        with connect() as db:
            row = recon_row(db, recon_id)
            if db.execute("SELECT 1 FROM orders WHERE recon_vehicle_id=?", (recon_id,)).fetchone():
                raise HTTPException(
                    409, "Can't delete a vehicle with repair order history -- cancel or close its orders instead"
                )
            db.execute("DELETE FROM recon_vehicles WHERE id=?", (recon_id,))
            db.execute("DELETE FROM vehicles WHERE id=?", (row["vehicle_id"],))

    # --- We-owe items ---

    @router.post("/we-owe", status_code=201)
    def create_we_owe_item(item: WeOweIn):
        with connect() as db:
            vehicle = db.execute(
                "SELECT 1 FROM vehicles WHERE id=? AND customer_id=?", (item.vehicle_id, item.customer_id)
            ).fetchone()
            if not vehicle:
                raise HTTPException(400, "Vehicle does not belong to customer")
            ts = now_fn()
            cur = db.execute(
                "INSERT INTO we_owe_items(customer_id,vehicle_id,description,category,promised_at,target_date,sale_reference,lot_stock_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    item.customer_id,
                    item.vehicle_id,
                    item.description.strip(),
                    item.category.strip() or "other",
                    ts,
                    item.target_date.strip(),
                    item.sale_reference.strip(),
                    item.lot_stock_number.strip().upper(),
                    ts,
                    ts,
                ),
            )
            # A we-owe is very often the first time a car is written down at
            # all -- bought and recon'd before RECON ever saw it. Recording
            # what it cost here is what makes its profit answerable later.
            # Only fills blanks: if this VIN already has a purchase price from
            # its recon life, that one is the record and stands.
            unit_id = unit_id_for_vehicle(db, item.vehicle_id, ts)
            if item.purchase_price is not None:
                db.execute(
                    "UPDATE vehicle_units SET purchase_price=?,updated_at=? WHERE id=? AND purchase_price=0",
                    (item.purchase_price, ts, unit_id),
                )
            if item.sale_price is not None:
                db.execute(
                    "UPDATE vehicle_units SET sale_price=?,updated_at=? WHERE id=? AND sale_price IS NULL",
                    (item.sale_price, ts, unit_id),
                )
            return we_owe_detail(db, inserted_id(cur))

    @router.get("/we-owe/{we_owe_id}")
    def get_we_owe_item(we_owe_id: int):
        with connect() as db:
            return we_owe_detail(db, we_owe_id)

    @router.post("/we-owe/{we_owe_id}/archive")
    def archive_we_owe_item(we_owe_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE we_owe_items SET archived_at=?,edit_version=edit_version+1 WHERE id=?{guard}",
                (now_fn(), we_owe_id, *guard_params),
            )
            assert_version_won(cur, "Someone else changed this item since you loaded it -- reload to see their update")
            return we_owe_detail(db, we_owe_id)

    @router.post("/we-owe/{we_owe_id}/reopen")
    def reopen_we_owe_item(we_owe_id: int, item: ArchiveIn = ArchiveIn()):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            assert_current_version(row, item.expected_version)
            guard, guard_params = version_guard(item.expected_version)
            cur = db.execute(
                f"UPDATE we_owe_items SET archived_at='',edit_version=edit_version+1 WHERE id=?{guard}",
                (we_owe_id, *guard_params),
            )
            assert_version_won(cur, "Someone else changed this item since you loaded it -- reload to see their update")
            return we_owe_detail(db, we_owe_id)

    @router.patch("/we-owe/{we_owe_id}")
    def update_we_owe_item(we_owe_id: int, item: WeOwePatch):
        with connect() as db:
            row = we_owe_row(db, we_owe_id)
            _assert_not_archived(row)
            if item.expected_version is not None and item.expected_version != row["edit_version"]:
                raise HTTPException(
                    409, "Someone else changed this item since you loaded it -- reload to see their update"
                )
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
                ("plate", normalize_plate(item.plate) if item.plate is not None else None),
                ("plate_state", item.plate_state.strip().upper() if item.plate_state is not None else None),
                ("mileage", item.mileage),
                ("odometer_broken", int(item.odometer_broken) if item.odometer_broken is not None else None),
            ):
                if value is not None:
                    vehicle_fields.append(f"{name}=?")
                    vehicle_params.append(value)
            ts = now_fn()
            if vehicle_fields:
                vehicle_params.append(row["vehicle_id"])
                db.execute(f"UPDATE vehicles SET {','.join(vehicle_fields)} WHERE id=?", vehicle_params)

            # A VIN filled in after the fact is how a we-owe car finds the
            # recon record it already had -- so the unit is re-resolved and
            # the two halves of the car's life join up from that moment on.
            if item.vin is not None:
                unit_id = relink_unit(db, row["vehicle_id"], item.vin, ts)
            else:
                unit_id = unit_id_for_vehicle(db, row["vehicle_id"], ts)

            unit_fields, unit_params = [], []
            for name, value in (("purchase_price", item.purchase_price), ("sale_price", item.sale_price)):
                if value is not None:
                    unit_fields.append(f"{name}=?")
                    unit_params.append(value)
            if unit_fields:
                unit_params += [ts, unit_id]
                db.execute(f"UPDATE vehicle_units SET {','.join(unit_fields)},updated_at=? WHERE id=?", unit_params)

            if fields or vehicle_fields:
                fields.append("updated_at=?")
                params.append(ts)
                fields.append("edit_version=edit_version+1")
                params.append(we_owe_id)
                guard, guard_params = version_guard(item.expected_version)
                params.extend(guard_params)
                cur = db.execute(f"UPDATE we_owe_items SET {','.join(fields)} WHERE id=?{guard}", params)
                # Rolls back the vehicles/vehicle_units writes above with it --
                # same transaction, so a lost race applies nothing.
                assert_version_won(
                    cur, "Someone else changed this item since you loaded it -- reload to see their update"
                )
            return we_owe_detail(db, we_owe_id)

    @router.delete("/we-owe/{we_owe_id}", status_code=204)
    def delete_we_owe_item(we_owe_id: int):
        with connect() as db:
            we_owe_row(db, we_owe_id)
            if db.execute("SELECT 1 FROM orders WHERE we_owe_id=?", (we_owe_id,)).fetchone():
                raise HTTPException(
                    409, "Can't delete a we-owe item with repair order history -- cancel or close its orders instead"
                )
            db.execute("DELETE FROM we_owe_items WHERE id=?", (we_owe_id,))

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
            if not db.execute(
                "SELECT 1 FROM we_owe_payments WHERE id=? AND we_owe_id=?", (payment_id, we_owe_id)
            ).fetchone():
                raise HTTPException(404, "Payment not found")
            db.execute("DELETE FROM we_owe_payments WHERE id=?", (payment_id,))

    @router.post("/lot/file-away")
    def file_away_settled(item: FileAwayIn):
        """File a whole pile of finished cars to History in one go.

        The Lot Status sheet already ends with a pile of cars whose only
        remaining step is this one -- it prints "Sold — send to History" on
        every row of it. Doing that meant opening each car, finding the button
        and confirming, one car at a time, and the pile is the part of the
        sheet nobody is in a hurry about. So it grows, and while it does, every
        count above it is describing a lot that is bigger than the real one:
        "1 ready of 8 on the lot" when four of the eight left weeks ago.

        Two guarantees make a bulk button safe enough to offer here, and
        neither of them exists on the single-vehicle archive route:

        * **Only genuinely finished cars are filed.** Every id is re-checked
          against the same lot_bucket the sheet grouped it by, read inside this
          transaction. A car that went back into the shop between the sheet
          being drawn and the button being pressed is refused, not filed. The
          per-vehicle route will archive anything it is pointed at, which is
          fine when a person is looking at that one car and wrong when a
          button is filing five.
        * **Nothing is silently swallowed.** Every car the caller sent comes
          back either filed or skipped with the reason, so the screen can say
          "4 filed, 1 left -- it is back in the shop" instead of quietly
          filing four and looking like it filed five.

        A stale version is a skip here rather than the 409 the single-vehicle
        routes raise. Failing the whole batch over one car another workstation
        touched a second ago would mean the button stops working on exactly
        the busy lot it exists for -- and every car in the batch is an
        independent record, so there is nothing half-applied to protect. The
        write is still a real compare-and-set (see
        tests/test_optimistic_locking.py): the version sits in the WHERE
        clause and a row that did not win is reported, never assumed.

        Filing is reversible (see reopen_recon_vehicle) and deletes nothing,
        which is what makes the confirm on the other side a question rather
        than a warning.
        """
        with connect() as db:
            # Both sides of History, so a car another workstation already filed
            # can be told apart from one that has left the lot entirely.
            rows = {
                (row["segment"], row["recon_id"] if row["segment"] == "recon" else row["we_owe_id"]): row
                for row in vehicle_board_rows(db, archived=None)
            }
            requested = [("recon", entry) for entry in item.recon] + [("we_owe", entry) for entry in item.we_owe]
            seen: set[tuple[str, int]] = set()
            filed: list[dict] = []
            skipped: list[dict] = []
            stamp = now_fn()
            for segment, asked in requested:
                if (segment, asked.id) in seen:
                    continue
                seen.add((segment, asked.id))
                row = rows.get((segment, asked.id))
                if row is None:
                    skipped.append(
                        {"segment": segment, "id": asked.id, "label": "", "reason": "it is no longer on the lot"}
                    )
                    continue
                result = {"segment": segment, "id": asked.id, "label": lot_row_label(row)}
                if row["archived"]:
                    skipped.append({**result, "reason": "it is already in History"})
                    continue
                if row["lot_bucket"] != LOT_SETTLED:
                    # The pile it is in now, not the pile the sheet drew it in.
                    skipped.append({**result, "reason": "it is back in the shop"})
                    continue
                table = "recon_vehicles" if segment == "recon" else "we_owe_items"
                cur = db.execute(
                    f"UPDATE {table} SET archived_at=?,edit_version=edit_version+1 WHERE id=? AND edit_version=?",
                    (stamp, asked.id, asked.expected_version),
                )
                if cur.rowcount:
                    filed.append(result)
                else:
                    skipped.append({**result, "reason": "somebody else changed it just now"})
            return {"filed": filed, "skipped": skipped}

    return router


def lot_row_label(row: Mapping[str, Any]) -> str:
    """How one lot row is named back to a person -- the same handle the sheet
    shows, so a message about a car can be matched to the line it came from.

    A recon car is known by its stock number and a we-owe promise by whose car
    it is; neither is guaranteed to be there, so the year/make/model is always
    included rather than being dropped when a better name exists.
    """
    vehicle = row.get("vehicle") or ""
    if row.get("segment") == "recon":
        stock = row.get("stock_number") or ""
        return f"{stock} — {vehicle}".strip(" —") if stock else vehicle
    customer = row.get("customer_name") or ""
    return f"{vehicle} — {customer}".strip(" —") if customer else vehicle


def cost_rollup(db: sqlite3.Connection, column: str, ref_id: int, segment: str | None = None) -> dict:
    """One vehicle's cost rollup. See cost_rollups, which does the work."""
    return cost_rollups(db, column, [ref_id], segment)[ref_id]


def last_activity_map(
    db: sqlite3.Connection, column: str, ref_ids: Sequence[int], segment: str | None = None
) -> dict[int, str]:
    """last_activity for a whole list of vehicles in one query per chunk.

    Only vehicles that actually have a qualifying ticket appear in the result;
    a vehicle with none is absent, which is the caller's cue to fall back to
    when the car landed (see last_activity).
    """
    found: dict[int, str] = {}
    for chunk in _chunked(_unique_ids(ref_ids)):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT {column} ref_id, max(last_activity_at) at FROM orders
                 WHERE {column} IN ({placeholders}) AND voided=0 AND last_activity_at!=''"""
            + (" AND segment=?" if segment else "")
            + f" GROUP BY {column}",
            (*chunk, segment) if segment else tuple(chunk),
        ).fetchall()
        for row in rows:
            if row["at"]:
                found[row["ref_id"]] = row["at"]
    return found


def we_owe_payment_totals(db: sqlite3.Connection, we_owe_ids: Sequence[int]) -> dict[int, float]:
    """What the customer has chipped in on each promise. Zero when nothing
    has been taken, so every id asked about has an answer."""
    result: dict[int, float] = dict.fromkeys(we_owe_ids, 0)
    ids = _unique_ids(we_owe_ids)
    if not ids:
        return result
    for chunk in _chunked(ids):
        placeholders = ",".join("?" for _ in chunk)
        rows = db.execute(
            f"""SELECT we_owe_id, coalesce(sum(amount),0) paid FROM we_owe_payments
                 WHERE we_owe_id IN ({placeholders}) GROUP BY we_owe_id""",
            tuple(chunk),
        ).fetchall()
        for row in rows:
            result[row["we_owe_id"]] = row["paid"]
    return result


def promise_days_late(target_date: str | None, status_bucket: str) -> int | None:
    """How many days past its promised date a we-owe promise is.

    Negative counts days still to go and 0 means it is due today, so one
    number answers both "have we broken this promise" and "how long have I
    got". None means the question does not apply: no date was written down,
    the stored value is not a date anyone can read, or the promise is already
    settled.

    Settled promises are excluded for the same reason is_stalled excludes
    finished cars. A fulfilled or waived we-owe cannot still be late, and the
    dates on old promises never move -- counting them would give a number that
    only ever climbs, which is an alarm nobody reads by the end of the month.

    The comparison is against the shop's own calendar date (see db.now), not
    UTC: "promised Thursday" means Thursday in Merrillville, and the shop
    works evenings.
    """
    if status_bucket == "finished":
        return None
    try:
        target = date.fromisoformat((target_date or "").strip())
    except ValueError:
        return None
    return (datetime.now().date() - target).days
