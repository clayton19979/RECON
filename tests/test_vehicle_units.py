"""One physical car, tracked across every owner it has.

The problem these cover: `vehicles` carries a NOT NULL customer_id, so a car
recon'd under the shop's own account and later sold and brought back on a
we-owe is necessarily two `vehicles` rows with the same VIN. Before units
there was nothing joining them, and "what did we actually make on that car"
had no answer -- the purchase price sat on one row and the post-sale repair
bill on the other.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, save_estimate

VIN = "1HGCM82633A004352"


def _we_owe_on_vin(client, vin, customer_name="Jordan Whitfield", **overrides):
    """A we-owe written up for a car identified only by its VIN -- the case
    where the buyer brings back something the shop sold months ago."""
    customer = client.post("/api/customers", json={"name": customer_name}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2019, "make": "Honda", "model": "Civic", "vin": vin},
    ).json()
    payload = {"customer_id": customer["id"], "vehicle_id": vehicle["id"], "description": "Promised A/C repair"}
    payload.update(overrides)
    res = client.post("/api/we-owe", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _spend(client, order_id, amount):
    save_estimate(
        client,
        order_id,
        [
            {"kind": "labor", "description": "Work", "quantity": 1, "unit_price": amount, "unit_cost": amount},
        ],
    )


def test_recon_and_we_owe_on_one_vin_share_a_unit(client):
    """The join that did not exist before: same car, two owners, one ledger."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    we_owe = _we_owe_on_vin(client, VIN)

    assert recon["lifetime"]["unit_id"] == we_owe["lifetime"]["unit_id"]
    # And the purchase price entered on the recon side is visible from the
    # we-owe side, which is the whole point.
    assert we_owe["lifetime"]["purchase_price"] == 5000


def test_we_owe_cost_eats_into_the_cars_profit(client):
    """Clayton's actual question: a car sold at a profit, brought back weeks
    later for we-owe work, and the margin quietly shrinking."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 8000})

    # Sold: 8000 - 5000 purchase - 800 recon = 2200.
    lifetime = client.get(f"/api/recon/vehicles/{recon['id']}").json()["lifetime"]
    assert lifetime["total_invested"] == 5800
    assert lifetime["profit"] == 2200

    # Weeks later it comes back on a we-owe that costs the shop 600.
    we_owe = _we_owe_on_vin(client, VIN)
    order = client.post(
        "/api/orders",
        json={
            "concern": "A/C",
            "segment": "we_owe",
            "we_owe_id": we_owe["id"],
        },
    ).json()
    _spend(client, order["id"], 600)

    lifetime = client.get(f"/api/recon/vehicles/{recon['id']}").json()["lifetime"]
    assert lifetime["we_owe_cost"] == 600
    assert lifetime["total_invested"] == 6400
    assert lifetime["profit"] == 1600, "the we-owe work has to come off the car's profit"


def test_customer_payment_offsets_the_we_owe_cost(client):
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 8000})
    we_owe = _we_owe_on_vin(client, VIN)
    order = client.post(
        "/api/orders",
        json={
            "concern": "A/C",
            "segment": "we_owe",
            "we_owe_id": we_owe["id"],
        },
    ).json()
    _spend(client, order["id"], 600)
    client.post(f"/api/we-owe/{we_owe['id']}/payments", json={"amount": 250, "method": "cash"})

    lifetime = client.get(f"/api/we-owe/{we_owe['id']}").json()["lifetime"]
    assert lifetime["we_owe_customer_paid"] == 250
    assert lifetime["we_owe_net_cost"] == 350
    assert lifetime["profit"] == 8000 - 5000 - 350


def test_purchase_price_can_be_entered_at_we_owe_intake(client):
    """The case that started this: the car was recon'd somewhere else and was
    never in RECON, so the we-owe write-up is the first chance to record what
    it cost."""
    we_owe = _we_owe_on_vin(client, "5NPE24AF1FH000111", purchase_price=3200, sale_price=6000)

    lifetime = we_owe["lifetime"]
    assert lifetime["purchase_price"] == 3200
    assert lifetime["sale_price"] == 6000
    assert lifetime["profit"] == 2800


def test_recon_purchase_price_wins_over_a_we_owe_guess(client):
    """A price already on file is the record; intake must not overwrite it."""
    make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    we_owe = _we_owe_on_vin(client, VIN, purchase_price=9999)

    assert we_owe["lifetime"]["purchase_price"] == 5000


def test_correcting_a_vin_joins_the_car_to_its_history(client):
    """A VIN typed wrong at intake and fixed later has to move the car onto
    the right unit -- otherwise it stays stranded forever."""
    make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    we_owe = _we_owe_on_vin(client, "WRONGVIN00000000")
    assert we_owe["lifetime"]["purchase_price"] == 0

    fixed = client.patch(f"/api/we-owe/{we_owe['id']}", json={"vin": VIN})
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["lifetime"]["purchase_price"] == 5000


def test_vin_matching_ignores_case_and_separators(client):
    make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    we_owe = _we_owe_on_vin(client, f"  {VIN.lower()}  ")
    assert we_owe["lifetime"]["purchase_price"] == 5000


def test_cars_without_a_vin_never_collide(client):
    """Two blank VINs are two unknown cars, not the same car."""
    a = make_recon_vehicle(client, stock_number="R-1", vin="", purchase_price=1000)
    b = make_recon_vehicle(client, stock_number="R-2", vin="", purchase_price=2000)

    assert a["lifetime"]["unit_id"] != b["lifetime"]["unit_id"]
    assert client.get(f"/api/recon/vehicles/{a['id']}").json()["lifetime"]["purchase_price"] == 1000
    assert client.get(f"/api/recon/vehicles/{b['id']}").json()["lifetime"]["purchase_price"] == 2000


def test_unsold_car_reports_no_profit_rather_than_a_loss(client):
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800)

    lifetime = client.get(f"/api/recon/vehicles/{recon['id']}").json()["lifetime"]
    assert lifetime["total_invested"] == 5800
    assert lifetime["profit"] is None, "an unsold car has a cost, not a loss"
    assert lifetime["margin_pct"] is None


def test_sold_car_with_no_purchase_price_reports_no_profit(client):
    """The lot's cost for a car isn't entered in this app -- Walt keeps that
    figure (see CLAUDE.md). So a sold car with no purchase price on file has no
    profit that can be worked out, and it must come back empty rather than
    subtracting nothing from the sale price and reporting the entire sale as
    margin. That number would go in front of the owner.

    The cost side is still fully answerable, which is the whole point of the
    app: total_invested is what the shop spent fixing the car.
    """
    # purchase_price=0 is what intake produces now that the field is gone from
    # the UI; the helper's default of 4000 predates that.
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=0)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 9000, "sale_date": "2026-07-20"})

    lifetime = client.get(f"/api/recon/vehicles/{recon['id']}").json()["lifetime"]
    assert lifetime["purchase_price"] == 0
    assert lifetime["total_invested"] == 800, "what we put into it is still the number the shop needs"
    assert lifetime["sale_price"] == 9000, "the sale itself is still recorded"
    assert lifetime["profit"] is None, "9000 - 800 is not this car's profit; the purchase price is unknown"
    assert lifetime["margin_pct"] is None


def test_profit_report_is_one_row_per_car_not_per_ticket(client):
    """A car with both a recon record and a we-owe appears twice on the
    vehicle board; the profit report must not double-count it."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 8000})
    _we_owe_on_vin(client, VIN)

    rows = client.get("/api/reports/vehicle-profit").json()
    on_vin = [r for r in rows if r["vin"] == VIN]
    assert len(on_vin) == 1
    assert on_vin[0]["recon_count"] == 1 and on_vin[0]["we_owe_count"] == 1


def test_profit_report_lists_only_the_lots_own_cars(client):
    """A retail customer's car is not the lot's car.

    Writing a retail ticket gives that car a unit like any other, and the
    report was listing every unit -- so each retail job left a permanent
    all-zero row behind. The shop writes retail tickets daily, so within weeks
    they outnumber the handful of rows the report is read for.
    """
    make_recon_vehicle(client, stock_number="R-1", vin=VIN, purchase_price=5000)
    make_retail_order(client)

    rows = client.get("/api/reports/vehicle-profit").json()
    assert [r["stock_number"] for r in rows] == ["R-1"], (
        f"expected only the lot's car, got {[(r['stock_number'], r['vehicle']) for r in rows]}"
    )


def test_profit_report_still_counts_we_owe_cars(client):
    """A we-owe car isn't the lot's stock, but the shop spends real money on
    it and that spend belongs in the report."""
    we_owe_vin = "5NPE24AF1FH000111"
    _we_owe_on_vin(client, we_owe_vin)
    make_retail_order(client)

    rows = client.get("/api/reports/vehicle-profit").json()
    assert [r["vin"] for r in rows] == [we_owe_vin]
    assert rows[0]["we_owe_count"] == 1 and rows[0]["recon_count"] == 0


def test_profit_report_vin_lookup_still_finds_a_retail_only_car(client):
    """We-owe intake asks this endpoint "do we already know this VIN?" before
    the promise is written -- at which point the car has no we-owe record and
    may only ever have been here as a retail customer's. Answering "never seen
    it" is how a second, conflicting record for the same car gets typed."""
    retail_vin = "1FTEW1EG5GKE12345"
    customer = client.post("/api/customers", json={"name": "Devon Marsh"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2016, "make": "Ford", "model": "F-150", "vin": retail_vin},
    ).json()
    client.post(
        "/api/orders",
        json={
            "concern": "Brakes",
            "segment": "retail",
            "customer_id": customer["id"],
            "vehicle_id": vehicle["id"],
        },
    )

    assert client.get("/api/reports/vehicle-profit").json() == [], "retail cars don't belong in the listing"
    matched = client.get(f"/api/reports/vehicle-profit?vin={retail_vin.lower()}").json()
    assert [r["vin"] for r in matched] == [retail_vin], "a VIN lookup has to find a car we've seen before"


def test_profit_report_csv_leaves_out_retail_cars(client):
    """Screen and spreadsheet read the same rows, so the bookkeeper's copy
    can't carry padding the screen doesn't show."""
    make_recon_vehicle(client, stock_number="R-1", vin=VIN, purchase_price=5000)
    make_retail_order(client)

    res = client.get("/api/export/report/vehicle-profit.csv")
    assert res.status_code == 200, res.text
    assert len(res.text.strip().splitlines()) == 2, res.text  # header + the one lot car
    assert "Focus" not in res.text


def test_profit_report_can_be_pulled_by_vin(client):
    make_recon_vehicle(client, stock_number="R-1", vin=VIN, purchase_price=5000)
    make_recon_vehicle(client, stock_number="R-2", vin="5NPE24AF1FH000111", purchase_price=3000)

    rows = client.get(f"/api/reports/vehicle-profit?vin={VIN.lower()}").json()
    assert [r["vin"] for r in rows] == [VIN]
    assert rows[0]["margin_pct"] is None  # not sold yet


def test_profit_report_csv_breaks_out_every_cost(client):
    """The bookkeeper has to be able to check the arithmetic, not just read
    the answer."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 8000})
    we_owe = _we_owe_on_vin(client, VIN)
    order = client.post(
        "/api/orders",
        json={
            "concern": "A/C",
            "segment": "we_owe",
            "we_owe_id": we_owe["id"],
        },
    ).json()
    _spend(client, order["id"], 600)

    res = client.get("/api/export/report/vehicle-profit.csv")
    assert res.status_code == 200, res.text
    header, row = res.text.splitlines()[0], res.text.splitlines()[1]
    assert "Recon Cost" in header and "We-Owe Cost" in header and "Margin %" in header
    cells = row.split(",")
    assert "5000.00" in cells and "800.00" in cells and "600.00" in cells
    assert "1600.00" in cells, "profit must survive into the export"


def test_odometer_broken_is_recorded_not_just_a_zero(client):
    customer = client.post("/api/customers", json={"name": "Pat Nguyen"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={
            "customer_id": customer["id"],
            "year": 2016,
            "make": "Ford",
            "model": "Fusion",
            "vin": "3FA6P0H73GR000222",
            "mileage": 0,
            "odometer_broken": True,
        },
    ).json()
    assert vehicle["odometer_broken"] == 1

    we_owe = client.post(
        "/api/we-owe",
        json={
            "customer_id": customer["id"],
            "vehicle_id": vehicle["id"],
            "description": "Promised tires",
        },
    ).json()
    assert we_owe["odometer_broken"] == 1, "a broken odometer has to survive to the ticket"


def test_labor_hours_are_tracked_even_at_a_zero_rate(client):
    """On recon and we-owe the labor rate is always 0, so labor cost is
    permanently 0 and the hours the techs flagged were invisible. Hours have
    to be counted in their own right, not inferred from money."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    save_estimate(
        client,
        make_recon_order(client, recon["id"])["id"],
        [
            {"kind": "labor", "description": "Brakes", "quantity": 3.5, "unit_price": 0, "unit_cost": 0},
            {"kind": "labor", "description": "Detail", "quantity": 2, "unit_price": 0, "unit_cost": 0},
            {"kind": "part", "description": "Pads", "quantity": 1, "unit_price": 60, "unit_cost": 60},
        ],
    )

    detail = client.get(f"/api/recon/vehicles/{recon['id']}").json()
    assert detail["total_cost"] == 0, "nothing received yet, and labor is free"
    assert detail["labor_hours"] == 5.5, "hours must survive a zero rate"

    row = client.get(f"/api/reports/vehicle-profit?vin={VIN}").json()[0]
    assert row["labor_hours"] == 5.5


def test_lifetime_hours_span_recon_and_we_owe(client):
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    save_estimate(
        client,
        make_recon_order(client, recon["id"])["id"],
        [
            {"kind": "labor", "description": "Recon labor", "quantity": 4, "unit_price": 0, "unit_cost": 0},
        ],
    )
    we_owe = _we_owe_on_vin(client, VIN)
    order = client.post(
        "/api/orders",
        json={
            "concern": "A/C",
            "segment": "we_owe",
            "we_owe_id": we_owe["id"],
        },
    ).json()
    save_estimate(
        client,
        order["id"],
        [
            {"kind": "labor", "description": "Comeback labor", "quantity": 2.5, "unit_price": 0, "unit_cost": 0},
        ],
    )

    assert client.get(f"/api/reports/vehicle-profit?vin={VIN}").json()[0]["labor_hours"] == 6.5


def test_profit_report_reports_margin_against_sale_price(client):
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 1000)
    client.patch(f"/api/recon/vehicles/{recon['id']}", json={"sale_price": 10000})

    row = client.get(f"/api/reports/vehicle-profit?vin={VIN}").json()[0]
    assert row["profit"] == 4000
    assert row["margin_pct"] == 40.0
