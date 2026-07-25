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


# --- bulk edit ---------------------------------------------------------
#
# The Vehicles board turns a selection of stalled cars into one follow-up task
# each, deliberately unassigned and undated -- who and when are decisions you
# make once you're looking at the list. These endpoints are how those decisions
# get recorded without opening every row.


def _mktasks(client, specs):
    """specs: list of dicts passed straight to POST /api/tasks. Returns ids."""
    return [client.post("/api/tasks", json=spec).json()["id"] for spec in specs]


def test_bulk_sets_due_date_and_urgency_on_every_id(client):
    ids = _mktasks(client, [{"title": "Follow up: R-0981"}, {"title": "Follow up: R-0977"}, {"title": "Untouched"}])
    res = client.post("/api/tasks/bulk", json={"ids": ids[:2], "due_date": "2026-08-01", "urgent": True})
    assert res.status_code == 200
    body = res.json()
    assert body["updated"] == 2
    assert {t["id"] for t in body["tasks"]} == set(ids[:2])
    assert all(t["due_date"] == "2026-08-01" and t["urgent"] == 1 for t in body["tasks"])

    # The id that wasn't named must be untouched -- a bulk edit that leaks onto
    # neighbouring rows is far worse than one that does nothing.
    others = {t["id"]: t for t in client.get("/api/tasks").json()}
    assert others[ids[2]]["due_date"] == ""
    assert others[ids[2]]["urgent"] == 0


def test_bulk_assign_add_keeps_existing_assignees(client):
    """The reason assignment is three-valued rather than a plain overwrite.
    A replace would silently drop Antonio from the first task -- the kind of
    data loss nobody notices until the person dropped doesn't turn up."""
    ids = _mktasks(client, [
        {"title": "Has someone already", "assigned_to": ["Antonio"]},
        {"title": "Nobody on it", "assigned_to": []},
    ])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Dana"], "assign_mode": "add"})
    assert res.status_code == 200
    by_id = {t["id"]: t for t in res.json()["tasks"]}
    assert by_id[ids[0]]["assigned_to"] == ["Antonio", "Dana"]
    assert by_id[ids[1]]["assigned_to"] == ["Dana"]


def test_bulk_assign_add_does_not_duplicate(client):
    ids = _mktasks(client, [{"title": "Already hers", "assigned_to": ["Dana"]}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Dana"], "assign_mode": "add"})
    assert res.json()["tasks"][0]["assigned_to"] == ["Dana"]


def test_bulk_assign_remove_takes_only_the_named_person(client):
    ids = _mktasks(client, [{"title": "Two on it", "assigned_to": ["Antonio", "Dana"]}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Antonio"], "assign_mode": "remove"})
    assert res.json()["tasks"][0]["assigned_to"] == ["Dana"]


def test_bulk_assign_replace_overwrites(client):
    ids = _mktasks(client, [{"title": "Reassign outright", "assigned_to": ["Antonio"]}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Dana"], "assign_mode": "replace"})
    assert res.json()["tasks"][0]["assigned_to"] == ["Dana"]


def test_bulk_assign_defaults_to_replace(client):
    ids = _mktasks(client, [{"title": "No mode given", "assigned_to": ["Antonio"]}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Dana"]})
    assert res.json()["tasks"][0]["assigned_to"] == ["Dana"]


def test_bulk_rejects_unknown_assign_mode(client):
    ids = _mktasks(client, [{"title": "Bad mode"}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "assigned_to": ["Dana"], "assign_mode": "sideways"})
    assert res.status_code == 422


def test_bulk_done_stamps_completed_at_and_reopen_clears_it(client):
    ids = _mktasks(client, [{"title": "One"}, {"title": "Two"}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "done": True})
    assert all(t["done"] == 1 and t["completed_at"] for t in res.json()["tasks"])

    res = client.post("/api/tasks/bulk", json={"ids": ids, "done": False})
    assert all(t["done"] == 0 and t["completed_at"] == "" for t in res.json()["tasks"])


def test_bulk_is_all_or_nothing_on_a_missing_id(client):
    """Skipping the rows it couldn't find would leave the UI reporting a count
    it never verified -- '6 updated' over five rows that actually changed."""
    ids = _mktasks(client, [{"title": "Real"}])
    res = client.post("/api/tasks/bulk", json={"ids": ids + [99999], "urgent": True})
    assert res.status_code == 404
    assert "99999" in res.json()["detail"]
    # and the valid one in the batch is untouched
    assert client.get("/api/tasks").json()[0]["urgent"] == 0


def test_bulk_dedupes_repeated_ids(client):
    """A double-click on select-all, or two overlapping shift-ranges, can put
    the same id in the list twice. The count has to be rows, not entries."""
    ids = _mktasks(client, [{"title": "Once"}])
    res = client.post("/api/tasks/bulk", json={"ids": ids * 3, "urgent": True})
    assert res.json()["updated"] == 1
    assert len(res.json()["tasks"]) == 1

    # The error path is where the deduping is actually visible: SQL's IN
    # collapses duplicates by itself for rows that exist, but the "not found"
    # list is built from the request, so without it the message stutters
    # ("Task not found: 99999, 99999, 99999").
    res = client.post("/api/tasks/bulk", json={"ids": [99999, 99999, 99999], "urgent": True})
    assert res.status_code == 404
    assert res.json()["detail"] == "Task not found: 99999"


def test_bulk_with_no_edits_changes_nothing(client):
    ids = _mktasks(client, [{"title": "Untouched", "assigned_to": ["Dana"]}])
    before = client.get("/api/tasks").json()[0]
    res = client.post("/api/tasks/bulk", json={"ids": ids})
    assert res.status_code == 200
    after = res.json()["tasks"][0]
    assert after["assigned_to"] == ["Dana"]
    assert after["updated_at"] == before["updated_at"]


def test_bulk_requires_at_least_one_id(client):
    assert client.post("/api/tasks/bulk", json={"ids": [], "urgent": True}).status_code == 422
    assert client.post("/api/tasks/bulk-delete", json={"ids": []}).status_code == 422


def test_bulk_delete_removes_only_the_named_tasks(client):
    ids = _mktasks(client, [{"title": "Go"}, {"title": "Go too"}, {"title": "Stay"}])
    res = client.post("/api/tasks/bulk-delete", json={"ids": ids[:2]})
    assert res.status_code == 200
    assert res.json()["deleted"] == 2
    remaining = client.get("/api/tasks").json()
    assert [t["title"] for t in remaining] == ["Stay"]


def test_bulk_delete_is_all_or_nothing(client):
    ids = _mktasks(client, [{"title": "Should survive"}])
    res = client.post("/api/tasks/bulk-delete", json={"ids": ids + [99999]})
    assert res.status_code == 404
    assert len(client.get("/api/tasks").json()) == 1


def test_bulk_keeps_the_order_link_and_its_label(client):
    """The response feeds the list straight back into the UI, so it has to come
    back through the same join the plain listing uses -- otherwise the vehicle
    chip vanishes off every row you just bulk-edited."""
    vehicle = make_recon_vehicle(client, stock_number="R-0981")
    order = make_recon_order(client, vehicle["id"])
    ids = _mktasks(client, [{"title": "Follow up", "order_id": order["id"]}])
    res = client.post("/api/tasks/bulk", json={"ids": ids, "urgent": True})
    task = res.json()["tasks"][0]
    assert task["order_id"] == order["id"]
    assert task["order_label"] == "R-0981"
    assert task["order_recon_vehicle_id"] == vehicle["id"]


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
