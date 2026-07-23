from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe


def test_create_and_list_tasks(client):
    res = client.post("/api/tasks", json={"title": "Call John back about his Civic", "assigned_to": ["Antonio"], "actor": "Clay"})
    assert res.status_code == 201
    body = res.json()
    assert body["title"] == "Call John back about his Civic"
    assert body["assigned_to"] == ["Antonio"]
    assert body["created_by"] == "Clay"
    assert body["done"] == 0

    tasks = client.get("/api/tasks").json()
    assert any(t["title"] == "Call John back about his Civic" for t in tasks)


def test_task_can_have_multiple_assignees(client):
    res = client.post("/api/tasks", json={"title": "Deep clean the shop", "assigned_to": ["Antonio", "Jamie", "Antonio"]})
    assert res.status_code == 201
    # deduped, order preserved
    assert res.json()["assigned_to"] == ["Antonio", "Jamie"]

    task_id = res.json()["id"]
    res = client.patch(f"/api/tasks/{task_id}", json={"assigned_to": ["Jamie", "Pat"]})
    assert res.json()["assigned_to"] == ["Jamie", "Pat"]

    res = client.patch(f"/api/tasks/{task_id}", json={"assigned_to": []})
    assert res.json()["assigned_to"] == []


def test_task_with_no_assignees_defaults_to_empty_list(client):
    res = client.post("/api/tasks", json={"title": "Order shop supplies"})
    assert res.json()["assigned_to"] == []


def test_task_done_sets_completed_at_and_clears_on_reopen(client):
    task = client.post("/api/tasks", json={"title": "Order brake pads"}).json()
    res = client.patch(f"/api/tasks/{task['id']}", json={"done": True})
    assert res.status_code == 200
    assert res.json()["done"] == 1
    assert res.json()["completed_at"]

    res = client.patch(f"/api/tasks/{task['id']}", json={"done": False})
    assert res.json()["done"] == 0
    assert res.json()["completed_at"] == ""


def test_task_ordering_open_before_done_urgent_first(client):
    a = client.post("/api/tasks", json={"title": "Normal task"}).json()
    b = client.post("/api/tasks", json={"title": "Urgent task", "urgent": True}).json()
    client.patch(f"/api/tasks/{a['id']}", json={"done": True})

    tasks = client.get("/api/tasks").json()
    ids_in_order = [t["id"] for t in tasks]
    # urgent+open task should come before the done task
    assert ids_in_order.index(b["id"]) < ids_in_order.index(a["id"])


def test_delete_task(client):
    task = client.post("/api/tasks", json={"title": "Temp"}).json()
    res = client.delete(f"/api/tasks/{task['id']}")
    assert res.status_code == 204
    assert not any(t["id"] == task["id"] for t in client.get("/api/tasks").json())


def test_update_task_not_found(client):
    res = client.patch("/api/tasks/99999", json={"done": True})
    assert res.status_code == 404


def test_task_links_to_recon_order_and_resolves_label(client):
    vehicle = make_recon_vehicle(client, stock_number="R-TASK-1")
    order = make_recon_order(client, vehicle["id"])

    task = client.post("/api/tasks", json={"title": "Chase down the title", "order_id": order["id"]}).json()
    assert task["order_id"] == order["id"]
    assert task["order_label"] == "R-TASK-1"
    assert task["order_recon_vehicle_id"] == vehicle["id"]
    assert task["order_segment"] == "recon"

    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    assert listed["order_label"] == "R-TASK-1"


def test_task_links_to_we_owe_order_with_customer_label(client):
    we_owe = make_we_owe(client, customer_name="Jamie Customer")
    order = client.post(
        "/api/orders", json={"concern": "Fix trim", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()

    task = client.post("/api/tasks", json={"title": "Call Jamie", "order_id": order["id"]}).json()
    assert task["order_label"] == "We-Owe: Jamie Customer"
    assert task["order_we_owe_id"] == we_owe["id"]
    assert task["order_segment"] == "we_owe"


def test_create_task_rejects_unknown_order(client):
    res = client.post("/api/tasks", json={"title": "Ghost order", "order_id": 99999})
    assert res.status_code == 404


def test_task_without_order_has_no_label(client):
    task = client.post("/api/tasks", json={"title": "Order shop supplies"}).json()
    assert task["order_id"] is None
    assert task["order_label"] is None


def test_patch_task_can_link_and_unlink_order(client):
    vehicle = make_recon_vehicle(client, stock_number="R-TASK-2")
    order = make_recon_order(client, vehicle["id"])
    task = client.post("/api/tasks", json={"title": "Follow up"}).json()

    res = client.patch(f"/api/tasks/{task['id']}", json={"order_id": order["id"]})
    assert res.json()["order_id"] == order["id"]
    assert res.json()["order_label"] == "R-TASK-2"

    res = client.patch(f"/api/tasks/{task['id']}", json={"order_id": -1})
    assert res.json()["order_id"] is None
    assert res.json()["order_label"] is None


def test_patch_task_rejects_unknown_order(client):
    task = client.post("/api/tasks", json={"title": "Follow up"}).json()
    res = client.patch(f"/api/tasks/{task['id']}", json={"order_id": 99999})
    assert res.status_code == 404


def test_create_and_resolve_suggestion(client):
    res = client.post("/api/suggestions", json={"text": "We should add a way to text customers", "author": "Antonio"})
    assert res.status_code == 201
    body = res.json()
    assert body["resolved"] == 0

    res = client.patch(f"/api/suggestions/{body['id']}", json={"resolved": True})
    assert res.status_code == 200
    assert res.json()["resolved"] == 1

    suggestions = client.get("/api/suggestions").json()
    assert any(s["id"] == body["id"] for s in suggestions)


def test_delete_suggestion(client):
    suggestion = client.post("/api/suggestions", json={"text": "Idea"}).json()
    res = client.delete(f"/api/suggestions/{suggestion['id']}")
    assert res.status_code == 204
    assert not any(s["id"] == suggestion["id"] for s in client.get("/api/suggestions").json())
