from __future__ import annotations

import csv
import io

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate


def test_export_vehicles_csv(client):
    vendor = client.post("/api/vendors", json={"name": "WorldPac"}).json()
    vehicle = make_recon_vehicle(client, stock_number="R-7001", purchase_price=9999)
    order = make_recon_order(client, vehicle["id"])
    estimate = save_estimate(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "part_number": "BP-1", "quantity": 1, "unit_price": 10, "unit_cost": 10}],
    )
    item_id = estimate["items"][0]["id"]
    client.post(
        f"/api/orders/{order['id']}/estimate/receive-parts",
        json={"item_ids": [item_id], "vendor_id": vendor["id"], "invoice_number": "INV-1"},
    )
    make_we_owe(client, description="Fix mirror")

    res = client.get("/api/export/vehicles.csv")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    assert "attachment" in res.headers["content-disposition"]

    rows = list(csv.reader(io.StringIO(res.text)))
    header, body = rows[0], rows[1:]
    assert header == [
        "Stock #/Customer", "Vehicle", "VIN", "Segment", "Status", "Age (days)",
        "What's In It", "Linked Vendor Invoices", "Updated At",
    ]
    assert "Purchase Price" not in header
    assert not any("9999" in cell for row in body for cell in row)  # purchase price never leaks into the export

    recon_row = next(r for r in body if r[0] == "R-7001")
    assert recon_row[3] == "Recon"
    assert "INV-1" in recon_row[7]
    assert "WorldPac" in recon_row[7]

    assert any(r[3] == "We-Owe" for r in body)
