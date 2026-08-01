"""The vehicle board has to stay the same speed as the lot fills up.

The board is the screen the shop lives on -- it reloads after every save, and
the Lot Status, spend and profit reports are all built on the same rows. Every
per-vehicle number it shows (cost, quoted, parts on order, technicians, idle
clock, customer deposits) used to be fetched one car at a time, so the work
grew with the number of cars and History and the all-time reports had no
ceiling at all.

Counting statements rather than timing anything: a stopwatch on a fast machine
proves nothing and fails on a slow one, but "asking about ten cars costs the
same number of questions as asking about three" is exactly the property that
has to hold, and it fails loudly the moment a per-car query creeps back in.
"""

from __future__ import annotations

from collections.abc import Callable

from app.db import connect
from app.recon import vehicle_board_rows
from app.reports import lot_rows, vehicle_profit_rows
from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def statements_for(db_path, work: Callable) -> int:
    """How many SQL statements `work` runs. Uses its own connection so the
    count is only what the report asks for, not the app's request plumbing."""
    with connect(db_path) as db:
        seen: list[str] = []
        db.set_trace_callback(seen.append)
        try:
            work(db)
        finally:
            db.set_trace_callback(None)
        return len(seen)


def add_cars(client, count: int, first: int) -> None:
    """`count` recon cars with a ticket, parts and a technician, plus one
    we-owe promise each -- i.e. cars that make the board do all of its work."""
    for offset in range(count):
        n = first + offset
        technician = client.post("/api/staff", json={"name": f"Tech {n}", "role": "technician"}).json()
        vehicle = make_recon_vehicle(client, stock_number=f"Q-{n:04d}", vin=f"QUERYVOLUME{n:05d}")
        order = make_recon_order(client, vehicle["id"])
        save_estimate(
            client,
            order["id"],
            [
                {"kind": "part", "description": "Pads", "quantity": 2, "unit_price": 0, "unit_cost": 30},
                {"kind": "labor", "description": "Fit", "quantity": 1.5, "unit_price": 0, "unit_cost": 0},
            ],
        )
        client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})
        make_we_owe(client, customer_name=f"Customer {n}", description=f"Promise {n}")


def test_the_board_asks_the_same_number_of_questions_for_ten_cars_as_for_three(client, db_path):
    add_cars(client, 3, first=1)
    small = statements_for(db_path, vehicle_board_rows)
    assert len(vehicle_board_rows(connect(db_path))) == 6

    add_cars(client, 7, first=4)
    large = statements_for(db_path, vehicle_board_rows)
    assert len(vehicle_board_rows(connect(db_path))) == 20

    assert large == small, (
        f"the board ran {large} statements for ten cars and {small} for three -- "
        "something is being fetched per car again"
    )


def test_the_lot_and_profit_reports_do_not_grow_a_query_per_car(client, db_path):
    add_cars(client, 3, first=1)
    small_lot = statements_for(db_path, lot_rows)
    small_profit = statements_for(db_path, lambda db: vehicle_profit_rows(db, None, None))

    add_cars(client, 7, first=4)
    large_lot = statements_for(db_path, lot_rows)
    large_profit = statements_for(db_path, lambda db: vehicle_profit_rows(db, None, None))

    assert large_lot == small_lot, f"Lot Status: {large_lot} statements for ten cars, {small_lot} for three"
    assert large_profit == small_profit, f"Profit: {large_profit} statements for ten cars, {small_profit} for three"


def test_every_car_keeps_its_own_numbers_when_the_whole_list_is_fetched_at_once(client):
    """The failure mode of answering for the whole list in one pass is one
    car wearing another car's money or another car's technician."""
    dana = client.post("/api/staff", json={"name": "Dana", "role": "technician"}).json()
    ray = client.post("/api/staff", json={"name": "Ray", "role": "technician"}).json()

    cheap = make_recon_vehicle(client, stock_number="Q-CHEAP", vin="QUERYVOLUMECHEAP")
    cheap_order = make_recon_order(client, cheap["id"])
    save_estimate(
        client,
        cheap_order["id"],
        [{"kind": "part", "description": "Bulb", "quantity": 1, "unit_price": 0, "unit_cost": 9}],
    )
    client.put(f"/api/orders/{cheap_order['id']}/assignment", json={"technician_id": dana["id"]})

    dear = make_recon_vehicle(client, stock_number="Q-DEAR", vin="QUERYVOLUMEDEAR")
    dear_order = make_recon_order(client, dear["id"])
    save_estimate(
        client,
        dear_order["id"],
        [
            {"kind": "part", "description": "Compressor", "quantity": 1, "unit_price": 0, "unit_cost": 400},
            {"kind": "part", "description": "Drier", "quantity": 1, "unit_price": 0, "unit_cost": 60},
        ],
    )
    client.put(f"/api/orders/{dear_order['id']}/assignment", json={"technician_id": ray["id"]})

    # A car with nothing on it at all has to survive the same pass.
    make_recon_vehicle(client, stock_number="Q-BARE", vin="QUERYVOLUMEBARE")

    rows = {row["stock_number"]: row for row in client.get("/api/vehicles-board").json()}
    assert rows["Q-CHEAP"]["quoted_cost"] == 9
    assert rows["Q-CHEAP"]["technicians"] == ["Dana"]
    assert rows["Q-DEAR"]["quoted_cost"] == 460
    assert rows["Q-DEAR"]["technicians"] == ["Ray"]
    assert rows["Q-BARE"]["quoted_cost"] == 0
    assert rows["Q-BARE"]["technicians"] == []
    assert rows["Q-BARE"]["order_id"] is None
