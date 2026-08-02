from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe


def test_agent_search_normalized_stock_number_variants_find_one_recon(client):
    vehicle = make_recon_vehicle(client, stock_number="R-1042", make="Chevrolet", model="Malibu", year=2014)
    order = make_recon_order(client, vehicle["id"], concern="Recon inspection")

    for query in ("R-1042", "R1042", "r 1042"):
        body = client.get("/api/agent/search", params={"q": query}).json()
        matches = [row for row in body if row["kind"] == "recon" and row["id"] == vehicle["id"]]
        assert len(matches) == 1
        assert matches[0]["order_id"] == order["id"]
        assert matches[0]["label"] == "R-1042 — 2014 Chevrolet Malibu"
        assert matches[0]["status"] == "in_progress"


def test_agent_search_vin_last_six_matches_recon(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2042", vin="1HGCM82633A004352")

    body = client.get("/api/agent/search", params={"q": "004352"}).json()

    assert any(row["kind"] == "recon" and row["id"] == vehicle["id"] for row in body)


def test_agent_search_customer_name_finds_we_owe(client):
    item = make_we_owe(client, customer_name="Maria Alvarez", description="Replace missing key fob")

    body = client.get("/api/agent/search", params={"q": "maria alvarez"}).json()

    assert body[0]["kind"] == "we_owe"
    assert body[0]["id"] == item["id"]
    assert "Maria Alvarez" in body[0]["label"]


def test_agent_search_free_text_finds_retail_vehicle(client):
    customer = client.post("/api/customers", json={"name": "Tyrell Banks"}).json()
    vehicle = client.post(
        "/api/vehicles",
        json={
            "customer_id": customer["id"],
            "year": 2018,
            "make": "Ford",
            "model": "Focus",
            "color": "Silver",
            "plate": "ABC123",
        },
    ).json()

    body = client.get("/api/agent/search", params={"q": "silver focus"}).json()

    assert any(row["kind"] == "retail" and row["id"] == vehicle["id"] for row in body)
