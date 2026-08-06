from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, save_estimate


def test_create_job_and_list_on_order_detail(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    save_estimate(
        client,
        order["id"],
        [{"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 50, "unit_cost": 50}],
    )

    res = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Front Brakes"})
    assert res.status_code == 201
    body = res.json()
    assert body["title"] == "Front Brakes"
    assert body["technician_id"] is None

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert len(detail["estimate"]["jobs"]) == 1
    assert detail["estimate"]["jobs"][0]["title"] == "Front Brakes"


def test_create_job_lazily_creates_estimate(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    assert client.get(f"/api/orders/{order['id']}").json()["estimate"] is None

    res = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "AC Recharge"})
    assert res.status_code == 201

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["estimate"] is not None
    assert detail["estimate"]["jobs"][0]["title"] == "AC Recharge"


def test_job_requires_active_matching_technician_role(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    advisor = client.post("/api/staff", json={"name": "Pat", "role": "advisor"}).json()

    res = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job", "technician_id": advisor["id"]})
    assert res.status_code == 400

    technician = client.post("/api/staff", json={"name": "Antonio", "role": "technician"}).json()
    res = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job", "technician_id": technician["id"]})
    assert res.status_code == 201
    assert res.json()["technician_name"] == "Antonio"


def test_rename_and_reassign_job(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    technician = client.post("/api/staff", json={"name": "Antonio", "role": "technician"}).json()
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job"}).json()

    res = client.put(
        f"/api/orders/{order['id']}/jobs/{job['id']}", json={"title": "Front Brakes", "technician_id": technician["id"]}
    )
    assert res.status_code == 200
    assert res.json()["title"] == "Front Brakes"
    assert res.json()["technician_id"] == technician["id"]

    # clearing the technician (back to "use ticket default") works via PUT full-replace
    res = client.put(f"/api/orders/{order['id']}/jobs/{job['id']}", json={"title": "Front Brakes"})
    assert res.json()["technician_id"] is None


def test_delete_job_nulls_item_job_id_without_deleting_items(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Front Brakes"}).json()
    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
                "job_id": job["id"],
            }
        ],
    )
    item_id = estimate["items"][0]["id"]
    assert estimate["items"][0]["job_id"] == job["id"]

    res = client.delete(f"/api/orders/{order['id']}/jobs/{job['id']}")
    assert res.status_code == 204

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["estimate"]["jobs"] == []
    remaining = next(i for i in detail["estimate"]["items"] if i["id"] == item_id)
    assert remaining["job_id"] is None


def test_save_estimate_round_trips_job_id(client):
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    job_a = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job A"}).json()
    job_b = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job B"}).json()

    estimate = save_estimate(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
                "job_id": job_a["id"],
            }
        ],
    )
    item = estimate["items"][0]
    assert item["job_id"] == job_a["id"]

    moved = save_estimate(
        client,
        order["id"],
        [
            {
                "id": item["id"],
                "kind": "part",
                "description": "Pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
                "job_id": job_b["id"],
            }
        ],
    )
    assert moved["items"][0]["job_id"] == job_b["id"]

    cleared = save_estimate(
        client,
        order["id"],
        [
            {
                "id": item["id"],
                "kind": "part",
                "description": "Pads",
                "part_number": "BP-1",
                "quantity": 1,
                "unit_price": 10,
                "unit_cost": 10,
                "job_id": None,
            }
        ],
    )
    assert cleared["items"][0]["job_id"] is None


def test_save_estimate_rejects_job_id_from_other_estimate(client):
    vehicle_a = make_recon_vehicle(client, stock_number="R-JOB-A")
    order_a = make_recon_order(client, vehicle_a["id"])
    vehicle_b = make_recon_vehicle(client, stock_number="R-JOB-B")
    order_b = make_recon_order(client, vehicle_b["id"])
    job_b = client.post(f"/api/orders/{order_b['id']}/jobs", json={"title": "Job B"}).json()

    res = client.post(
        f"/api/orders/{order_a['id']}/estimate",
        json={
            "actor": "tester",
            "items": [
                {
                    "kind": "part",
                    "description": "Pads",
                    "part_number": "BP-1",
                    "quantity": 1,
                    "unit_price": 10,
                    "unit_cost": 10,
                    "job_id": job_b["id"],
                }
            ],
        },
    )
    assert res.status_code == 422


def test_usual_titles_come_from_the_shops_own_tickets(client):
    """The Add Job dialog's one-click chips: most-written first, spellings
    deduped case-insensitively, and the spelling shown is the latest one."""
    assert client.get("/api/jobs/usual-titles").json() == []

    vehicle = make_recon_vehicle(client, stock_number="R-USL-A")
    order = make_recon_order(client, vehicle["id"])
    other_vehicle = make_recon_vehicle(client, stock_number="R-USL-B")
    other_order = make_recon_order(client, other_vehicle["id"])

    client.post(f"/api/orders/{order['id']}/jobs", json={"title": "front brakes"})
    client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Windshield"})
    client.post(f"/api/orders/{other_order['id']}/jobs", json={"title": "Front Brakes"})

    titles = client.get("/api/jobs/usual-titles").json()
    assert titles == ["Front Brakes", "Windshield"]

    # The limit is respected, and the most-written name survives the cut.
    assert client.get("/api/jobs/usual-titles?limit=1").json() == ["Front Brakes"]


def test_job_mutations_blocked_when_vehicle_archived(client):
    vehicle = make_recon_vehicle(client, stock_number="R-JOB-ARCH")
    order = make_recon_order(client, vehicle["id"])
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Job"}).json()
    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")

    res = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "New Job"})
    assert res.status_code == 409
    res = client.put(f"/api/orders/{order['id']}/jobs/{job['id']}", json={"title": "Renamed"})
    assert res.status_code == 409
    res = client.delete(f"/api/orders/{order['id']}/jobs/{job['id']}")
    assert res.status_code == 409
