from __future__ import annotations


def test_create_and_list_tasks(client):
    res = client.post("/api/tasks", json={"title": "Call John back about his Civic", "assigned_to": "Antonio", "actor": "Clay"})
    assert res.status_code == 201
    body = res.json()
    assert body["title"] == "Call John back about his Civic"
    assert body["assigned_to"] == "Antonio"
    assert body["created_by"] == "Clay"
    assert body["done"] == 0

    tasks = client.get("/api/tasks").json()
    assert any(t["title"] == "Call John back about his Civic" for t in tasks)


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
