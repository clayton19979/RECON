"""What the shop spent fixing a car, and what a customer deposit is not.

Walt's fourth question is "how much did we spend on each vehicle". Four
screens answer it -- the Vehicles board, the Lot Status sheet, the car's own
page and the Profit report -- and three of them read the gross cost of the
parts that landed. The Profit report read a figure that had we-owe customer
deposits subtracted out of it.

That is not a rounding difference, it is a different question. A deposit is
money coming in; it does not mean the shop spent less. On the seeded lot a
we-owe promise with a $50 deposit and nothing received yet made the Profit
report's headline card read

    SPENT FIXING THEM   -$50.00
    recon + we-owe, at cost

for a shop that had spent nothing at all. Negative or not, it disagreed with
every other screen about the same car.

So `shop_spend` is the gross figure, it is worked out once on the server, and
the screen, the printed sheet and the CSV all read it. `total_invested` is the
one that nets the deposit out, because it feeds a profit calculation and money
the customer put in genuinely does reduce what the group has in the car.
"""

from __future__ import annotations

import csv
import io

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate

VIN = "1HGCM82633A004352"


def _we_owe_on_vin(client, vin, **overrides):
    customer = client.post("/api/customers", json={"name": "Renata Silva"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2019, "make": "Toyota", "model": "RAV4", "vin": vin},
    ).json()
    payload = {
        "customer_id": customer["id"],
        "vehicle_id": vehicle["id"],
        "description": "Touch up rear bumper",
    }
    payload.update(overrides)
    res = client.post("/api/we-owe", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _spend(client, order_id, amount, label="Bumper trim"):
    """A part written up AND received, which is the only way it becomes cost.

    Everything in this app counts a part once somebody marks it received; a
    part merely written up is money the shop has not spent yet.
    """
    estimate = save_estimate(
        client,
        order_id,
        [{"kind": "part", "description": label, "quantity": 1, "unit_price": amount, "unit_cost": amount}],
    )
    vendor = client.post("/api/vendors", json={"name": f"Vendor {label}"}).json()
    res = client.post(
        f"/api/orders/{order_id}/estimate/receive-parts",
        json={
            "item_ids": [estimate["items"][0]["id"]],
            "vendor_id": vendor["id"],
            "invoice_number": f"INV-{order_id}",
        },
    )
    assert res.status_code == 200, res.text


def _we_owe_order(client, we_owe_id):
    res = client.post("/api/orders", json={"concern": "We-owe", "segment": "we_owe", "we_owe_id": we_owe_id})
    assert res.status_code == 201, res.text
    return res.json()


def _profit_row(client, vin):
    rows = client.get("/api/reports/vehicle-profit", params={"vin": vin}).json()
    assert len(rows) == 1, rows
    return rows[0]


def test_a_deposit_taken_before_any_work_is_not_negative_spending(client):
    """The case that was on screen: a promise with a deposit and nothing done.

    The shop has spent nothing. Not minus fifty dollars.
    """
    we_owe = _we_owe_on_vin(client, VIN)
    client.post(f"/api/we-owe/{we_owe['id']}/payments", json={"amount": 50, "method": "cash"})

    lifetime = client.get(f"/api/we-owe/{we_owe['id']}").json()["lifetime"]
    assert lifetime["shop_spend"] == 0, "a customer deposit is money in, not spending that un-happened"
    assert lifetime["we_owe_customer_paid"] == 50, "the deposit itself still has to be reported"
    assert lifetime["we_owe_net_cost"] == -50, "the netted figure is still available for the profit math"

    assert _profit_row(client, VIN)["shop_spend"] == 0


def test_shop_spend_is_the_gross_cost_of_both_halves_of_a_cars_life(client):
    """Recon plus we-owe, at cost, with the deposit alongside rather than in it."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800, "Windshield")

    we_owe = _we_owe_on_vin(client, VIN)
    _spend(client, _we_owe_order(client, we_owe["id"])["id"], 600)
    client.post(f"/api/we-owe/{we_owe['id']}/payments", json={"amount": 250, "method": "cash"})

    row = _profit_row(client, VIN)
    assert row["recon_cost"] == 800
    assert row["we_owe_cost"] == 600
    assert row["shop_spend"] == 1400, "what the shop spent is the two costs, gross"
    assert row["we_owe_customer_paid"] == 250
    # The profit side is unchanged: money the customer put in really does come
    # off what the group has in the car, so total_invested keeps netting it.
    assert row["total_invested"] == 5000 + 800 + 350


def test_shop_spend_never_counts_what_the_lot_paid_for_the_car(client):
    """The purchase price is Walt's figure, not the shop's spending."""
    recon = make_recon_vehicle(client, vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800)

    row = _profit_row(client, VIN)
    assert row["shop_spend"] == 800
    assert row["total_invested"] == 5800


def test_a_part_bought_and_never_receipted_stays_out_of_the_spend(client):
    """Same rule as everywhere else: cost is what landed.

    The shortfall rides alongside so the screens can say it out loud; nothing
    folds it into the figure, here least of all.
    """
    recon = make_recon_vehicle(client, vin=VIN)
    order = make_recon_order(client, recon["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Tires", "quantity": 1, "unit_price": 380, "unit_cost": 380}],
    )
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})

    row = _profit_row(client, VIN)
    assert row["shop_spend"] == 0
    assert row["unreceived_closed_cost"] == 380


def test_the_profit_csv_carries_what_the_shop_spent(client):
    """The sheet gets emailed out as a file and read away from the app, so the
    column the screen leads with has to be in it -- and has to agree."""
    recon = make_recon_vehicle(client, stock_number="R-5501", vin=VIN, purchase_price=5000)
    _spend(client, make_recon_order(client, recon["id"])["id"], 800, "Windshield")
    we_owe = _we_owe_on_vin(client, VIN)
    _spend(client, _we_owe_order(client, we_owe["id"])["id"], 600)
    client.post(f"/api/we-owe/{we_owe['id']}/payments", json={"amount": 250, "method": "cash"})

    res = client.get("/api/export/report/vehicle-profit.csv")
    assert res.status_code == 200, res.text
    rows = list(csv.DictReader(io.StringIO(res.content.decode("utf-8-sig"))))
    row = next(r for r in rows if r["Stock #"] == "R-5501")

    assert row["Spent Fixing"] == "1400.00", "the CSV disagrees with the screen about what the shop spent"
    assert row["Recon Cost"] == "800.00"
    assert row["We-Owe Cost"] == "600.00"
    assert row["Customer Paid"] == "250.00"
    assert row["Total Invested"] == "6150.00"
