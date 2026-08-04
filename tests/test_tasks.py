from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, make_we_owe


def test_create_and_list_tasks(client):
    res = client.post(
        "/api/tasks", json={"title": "Call John back about his Civic", "assigned_to": ["Antonio"], "actor": "Clay"}
    )
    assert res.status_code == 201
    body = res.json()
    assert body["title"] == "Call John back about his Civic"
    assert body["assigned_to"] == ["Antonio"]
    assert body["created_by"] == "Clay"
    assert body["done"] == 0

    tasks = client.get("/api/tasks").json()
    assert any(t["title"] == "Call John back about his Civic" for t in tasks)


def test_task_can_have_multiple_assignees(client):
    res = client.post(
        "/api/tasks", json={"title": "Deep clean the shop", "assigned_to": ["Antonio", "Jamie", "Antonio"]}
    )
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
    assert task["recon_vehicle_id"] == vehicle["id"]
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
    assert task["we_owe_id"] == we_owe["id"]
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


# --- the vehicle picker ------------------------------------------------
#
# What the Tasks screen offers when you go to pin a follow-up to a car. It used
# to be the whole of /api/orders filtered by segment in the browser, which meant
# it offered voided tickets and cars sold months ago, and grew without limit.


def test_linkable_orders_labels_each_segment_the_way_the_advisor_says_it(client):
    recon = make_recon_order(client, make_recon_vehicle(client, stock_number="R-2200")["id"])
    we_owe = make_we_owe(client, customer_name="Jamie Customer")
    client.post("/api/orders", json={"concern": "Fix trim", "segment": "we_owe", "we_owe_id": we_owe["id"]})
    make_retail_order(client)

    rows = client.get("/api/tasks/linkable-orders").json()
    by_segment = {row["segment"]: row for row in rows}
    assert by_segment["recon"]["label"] == "R-2200 — 2019 Honda Civic"
    assert by_segment["we_owe"]["label"] == "We-Owe: Jamie Customer — 2020 Kia Soul"
    assert by_segment["retail"]["label"] == "Retail: Retail Customer — 2018 Ford Focus"
    # The heading each row sits under travels with it, so Recon/We-Owe/Retail
    # are named on the server and not a second time in the browser.
    assert [row["group"] for row in rows] == ["Recon", "We-Owe", "Retail"]
    assert by_segment["recon"]["id"] == recon["id"]


def test_linkable_orders_groups_recon_first_then_we_owe_then_retail(client):
    """Display order, not insertion order -- recon is the bulk of the work."""
    make_retail_order(client)
    we_owe = make_we_owe(client, customer_name="Second Customer")
    client.post("/api/orders", json={"concern": "Fix trim", "segment": "we_owe", "we_owe_id": we_owe["id"]})
    make_recon_order(client, make_recon_vehicle(client, stock_number="R-2201")["id"])

    assert [row["segment"] for row in client.get("/api/tasks/linkable-orders").json()] == [
        "recon",
        "we_owe",
        "retail",
    ]


def test_linkable_orders_leaves_out_voided_tickets(client):
    """Pinning a follow-up to a cancelled ticket buries it: nobody opens that
    car again, so the task is never seen and never done. The car is still
    offered -- as the car, with no ticket behind it -- because voiding the
    paperwork doesn't move the car off the lot."""
    vehicle = make_recon_vehicle(client, stock_number="R-2202")
    keep = make_recon_order(client, vehicle["id"])
    other = make_recon_vehicle(client, stock_number="R-2203", vin="1HGCM82633A004353")
    voided = make_recon_order(client, other["id"])
    assert client.post(f"/api/orders/{voided['id']}/void", json={"actor": "tester"}).status_code == 200

    rows = client.get("/api/tasks/linkable-orders").json()
    assert [row["order_id"] for row in rows] == [keep["id"], None]
    assert [row["value"] for row in rows] == [f"order:{keep['id']}", f"recon:{other['id']}"]


def test_linkable_orders_leaves_out_cars_sent_to_history(client):
    """A sold car's ticket sits in this list forever otherwise, and the list is
    scrolled every time somebody writes a task."""
    sold = make_recon_vehicle(client, stock_number="R-2204")
    sold_order = make_recon_order(client, sold["id"])
    client.patch(f"/api/orders/{sold_order['id']}/status", json={"status": "complete"})
    assert client.post(f"/api/recon/vehicles/{sold['id']}/archive").status_code == 200

    promise = make_we_owe(client, customer_name="Archived Customer")
    promise_order = client.post(
        "/api/orders", json={"concern": "Fix trim", "segment": "we_owe", "we_owe_id": promise["id"]}
    ).json()
    client.patch(f"/api/orders/{promise_order['id']}/status", json={"status": "complete"})
    assert client.post(f"/api/we-owe/{promise['id']}/archive").status_code == 200

    live = make_recon_order(client, make_recon_vehicle(client, stock_number="R-2205", vin="1HGCM82633A004353")["id"])
    assert [row["id"] for row in client.get("/api/tasks/linkable-orders").json()] == [live["id"]]


def test_linkable_orders_disambiguates_two_live_tickets_on_one_car(client):
    """Two identical lines in a dropdown is a pick you can't check afterwards.
    Only the colliding pair earns the RO number -- putting it on every row
    would bury the stock number the label exists to show."""
    twice = make_recon_vehicle(client, stock_number="R-2206")
    first = make_recon_order(client, twice["id"], concern="Brakes")
    second = make_recon_order(client, twice["id"], concern="Front end")
    alone = make_recon_order(client, make_recon_vehicle(client, stock_number="R-2207", vin="1HGCM82633A004353")["id"])

    by_id = {row["id"]: row["label"] for row in client.get("/api/tasks/linkable-orders").json()}
    assert by_id[first["id"]].startswith("R-2206 — 2019 Honda Civic · RO-")
    assert by_id[second["id"]].startswith("R-2206 — 2019 Honda Civic · RO-")
    assert by_id[first["id"]] != by_id[second["id"]]
    assert by_id[alone["id"]] == "R-2207 — 2019 Honda Civic"


def test_linkable_orders_offers_a_car_with_no_ticket_written_yet(client):
    """The cars worth leaving a note about are frequently the ones nobody has
    written up -- "untouched 41 days" is exactly that car -- and the picker
    used to offer nothing at all until a ticket existed."""
    vehicle = make_recon_vehicle(client, stock_number="R-2208")
    rows = client.get("/api/tasks/linkable-orders").json()
    assert [row["value"] for row in rows] == [f"recon:{vehicle['id']}"]
    assert rows[0]["label"] == "R-2208 — 2019 Honda Civic"
    assert rows[0]["order_id"] is None
    assert rows[0]["recon_vehicle_id"] == vehicle["id"]
    assert rows[0]["group"] == "Recon"


def test_linkable_orders_offers_a_we_owe_promise_with_no_ticket(client):
    promise = make_we_owe(client, customer_name="Dee Waiting")
    rows = client.get("/api/tasks/linkable-orders").json()
    assert [row["value"] for row in rows] == [f"we_owe:{promise['id']}"]
    assert rows[0]["label"].startswith("We-Owe: Dee Waiting — ")
    assert rows[0]["we_owe_id"] == promise["id"]
    assert rows[0]["group"] == "We-Owe"


def test_linkable_orders_offers_a_car_once_not_twice(client):
    """A car with a live ticket is offered through that ticket and nowhere
    else -- two lines for one car is a pick nobody can check afterwards."""
    vehicle = make_recon_vehicle(client, stock_number="R-2209")
    order = make_recon_order(client, vehicle["id"])
    rows = client.get("/api/tasks/linkable-orders").json()
    assert [row["value"] for row in rows] == [f"order:{order['id']}"]
    assert rows[0]["recon_vehicle_id"] == vehicle["id"]


def test_linkable_orders_is_empty_on_an_empty_shop(client):
    assert client.get("/api/tasks/linkable-orders").json() == []


# --- a link that outlived its ticket ------------------------------------


def test_task_says_when_its_ticket_was_voided(client):
    order = make_recon_order(client, make_recon_vehicle(client, stock_number="R-2210")["id"])
    task = client.post("/api/tasks", json={"title": "Chase the title", "order_id": order["id"]}).json()
    assert task["order_state"] == ""

    client.post(f"/api/orders/{order['id']}/void", json={"actor": "tester"})
    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    # The link is kept -- it is still the car that was meant -- but the row can
    # now say the ticket is dead instead of looking like live work.
    assert listed["order_id"] == order["id"]
    assert listed["order_label"] == "R-2210"
    assert listed["order_state"] == "voided"


def test_task_says_when_its_car_went_to_history(client):
    vehicle = make_recon_vehicle(client, stock_number="R-2211")
    order = make_recon_order(client, vehicle["id"])
    task = client.post("/api/tasks", json={"title": "Refund the core", "order_id": order["id"]}).json()

    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")
    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    assert listed["order_state"] == "archived"


def test_task_says_when_a_we_owe_car_went_to_history(client):
    we_owe = make_we_owe(client, customer_name="Gone Customer")
    order = client.post(
        "/api/orders", json={"concern": "Fix trim", "segment": "we_owe", "we_owe_id": we_owe["id"]}
    ).json()
    task = client.post("/api/tasks", json={"title": "Call them", "order_id": order["id"]}).json()

    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    client.post(f"/api/we-owe/{we_owe['id']}/archive")
    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    assert listed["order_state"] == "archived"


def test_task_with_no_vehicle_has_no_order_state(client):
    task = client.post("/api/tasks", json={"title": "Restock brake cleaner"}).json()
    assert task["order_state"] == ""


# --- a follow-up about a car, with or without a ticket -------------------
#
# A task used to reach its car only through a repair order, so the cars that
# most need a follow-up -- the ones sitting on the lot with nothing written up
# -- could not have one. These cover the car link standing on its own.


def test_task_can_name_a_recon_car_with_no_ticket(client):
    vehicle = make_recon_vehicle(client, stock_number="R-3301")
    task = client.post(
        "/api/tasks", json={"title": "Chase Walt for the title", "recon_vehicle_id": vehicle["id"]}
    ).json()
    assert task["order_id"] is None
    assert task["recon_vehicle_id"] == vehicle["id"]
    # The chip has to be able to open the car even though there is no ticket
    # for it to read a segment off.
    assert task["order_label"] == "R-3301"
    assert task["link_segment"] == "recon"
    assert task["link_ref_id"] == vehicle["id"]

    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    assert listed["order_label"] == "R-3301"
    assert listed["link_ref_id"] == vehicle["id"]


def test_task_can_name_a_we_owe_promise_with_no_ticket(client):
    promise = make_we_owe(client, customer_name="Nadia Waiting")
    task = client.post("/api/tasks", json={"title": "Order the tie rod", "we_owe_id": promise["id"]}).json()
    assert task["order_id"] is None
    assert task["order_label"] == "We-Owe: Nadia Waiting"
    assert task["link_segment"] == "we_owe"
    assert task["link_ref_id"] == promise["id"]


def test_a_ticket_decides_which_car_the_follow_up_is_about(client):
    """The car is taken off the ticket rather than trusted from the caller.
    Sending both independently is how a task ends up claiming to be about a
    car its own ticket isn't on, with nothing downstream able to say which
    half was right."""
    right = make_recon_vehicle(client, stock_number="R-3302")
    wrong = make_recon_vehicle(client, stock_number="R-3303", vin="1HGCM82633A004353")
    order = make_recon_order(client, right["id"])

    task = client.post(
        "/api/tasks",
        json={"title": "Follow up", "order_id": order["id"], "recon_vehicle_id": wrong["id"]},
    ).json()
    assert task["recon_vehicle_id"] == right["id"]
    assert task["order_label"] == "R-3302"


def test_repointing_a_follow_up_at_a_car_drops_the_old_ticket(client):
    """Otherwise the row keeps a link to paperwork on a car it no longer
    claims to be about."""
    ticketed = make_recon_vehicle(client, stock_number="R-3304")
    order = make_recon_order(client, ticketed["id"])
    bare = make_recon_vehicle(client, stock_number="R-3305", vin="1HGCM82633A004353")

    task = client.post("/api/tasks", json={"title": "Follow up", "order_id": order["id"]}).json()
    moved = client.patch(f"/api/tasks/{task['id']}", json={"recon_vehicle_id": bare["id"]}).json()
    assert moved["order_id"] is None
    assert moved["recon_vehicle_id"] == bare["id"]
    assert moved["order_label"] == "R-3305"


def test_unlinking_a_follow_up_clears_the_car_as_well_as_the_ticket(client):
    vehicle = make_recon_vehicle(client, stock_number="R-3306")
    order = make_recon_order(client, vehicle["id"])
    task = client.post("/api/tasks", json={"title": "Follow up", "order_id": order["id"]}).json()

    cleared = client.patch(
        f"/api/tasks/{task['id']}", json={"order_id": -1, "recon_vehicle_id": -1, "we_owe_id": -1}
    ).json()
    assert cleared["order_id"] is None
    assert cleared["recon_vehicle_id"] is None
    assert cleared["we_owe_id"] is None
    assert cleared["order_label"] is None
    assert cleared["link_ref_id"] is None


def test_a_follow_up_points_at_one_car_not_two(client):
    vehicle = make_recon_vehicle(client, stock_number="R-3307")
    promise = make_we_owe(client)
    res = client.post(
        "/api/tasks",
        json={"title": "Follow up", "recon_vehicle_id": vehicle["id"], "we_owe_id": promise["id"]},
    )
    assert res.status_code == 422


def test_create_task_rejects_an_unknown_car(client):
    assert client.post("/api/tasks", json={"title": "Ghost car", "recon_vehicle_id": 99999}).status_code == 404
    assert client.post("/api/tasks", json={"title": "Ghost promise", "we_owe_id": 99999}).status_code == 404


def test_a_follow_up_on_an_archived_car_says_so_without_a_ticket(client):
    """The board's "Make Tasks" now links cars that have no ticket, so the
    archived warning has to come off the car and not only off the ticket."""
    vehicle = make_recon_vehicle(client, stock_number="R-3308")
    task = client.post("/api/tasks", json={"title": "Follow up", "recon_vehicle_id": vehicle["id"]}).json()
    assert task["order_state"] == ""

    client.post(f"/api/recon/vehicles/{vehicle['id']}/archive")
    listed = next(t for t in client.get("/api/tasks").json() if t["id"] == task["id"])
    assert listed["order_state"] == "archived"


def test_bulk_create_links_cars_that_have_no_ticket(client):
    """This is the board's "Make N Tasks" button. A stalled car with nothing
    written up is the most common row in that selection, and those tasks used
    to arrive linked to nothing at all."""
    bare = make_recon_vehicle(client, stock_number="R-3309")
    ticketed = make_recon_vehicle(client, stock_number="R-3310", vin="1HGCM82633A004353")
    order = make_recon_order(client, ticketed["id"])

    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [
                {"title": "Follow up: R-3309 — no work in 41 days", "recon_vehicle_id": bare["id"]},
                {"title": "Follow up: R-3310", "order_id": order["id"], "recon_vehicle_id": ticketed["id"]},
            ]
        },
    )
    assert res.status_code == 201
    tasks = res.json()["tasks"]
    assert [t["order_label"] for t in tasks] == ["R-3309", "R-3310"]
    assert [t["recon_vehicle_id"] for t in tasks] == [bare["id"], ticketed["id"]]
    assert [t["order_id"] for t in tasks] == [None, order["id"]]


def test_bulk_create_is_all_or_nothing_on_a_bad_car_link(client):
    good = make_recon_vehicle(client, stock_number="R-3311")
    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [
                {"title": "Fine", "recon_vehicle_id": good["id"]},
                {"title": "Ghost", "recon_vehicle_id": 99999},
            ]
        },
    )
    assert res.status_code == 404
    assert client.get("/api/tasks").json() == []


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
    ids = _mktasks(
        client,
        [
            {"title": "Has someone already", "assigned_to": ["Antonio"]},
            {"title": "Nobody on it", "assigned_to": []},
        ],
    )
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
    assert task["recon_vehicle_id"] == vehicle["id"]


# --- bulk create -------------------------------------------------------
#
# Same button, the other end of it: the board used to fan out one POST per
# selected vehicle and count settled promises, so a batch could half-land and
# the only report the user got was "6 created, 2 failed" with no way to learn
# which two. One request, one outcome.


def test_bulk_create_makes_one_task_per_item(client):
    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [{"title": "Follow up: R-0981"}, {"title": "Follow up: R-0977"}, {"title": "Follow up: R-0954"}],
            "actor": "Clay",
        },
    )
    assert res.status_code == 201
    body = res.json()
    assert body["created"] == 3
    assert [t["title"] for t in body["tasks"]] == ["Follow up: R-0981", "Follow up: R-0977", "Follow up: R-0954"]
    assert all(t["created_by"] == "Clay" and t["done"] == 0 for t in body["tasks"])
    assert len(client.get("/api/tasks").json()) == 3


def test_bulk_create_applies_the_shared_fields_to_every_row(client):
    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [{"title": "One"}, {"title": "Two"}],
            "assigned_to": ["Antonio", "Dana", "Antonio"],
            "due_date": "2026-08-01",
            "urgent": True,
        },
    )
    tasks = res.json()["tasks"]
    assert all(t["assigned_to"] == ["Antonio", "Dana"] for t in tasks)
    assert all(t["due_date"] == "2026-08-01" and t["urgent"] == 1 for t in tasks)


def test_bulk_create_defaults_to_unassigned_and_undated(client):
    """What the board sends, and what the Tasks screen is built to fix up."""
    body = client.post("/api/tasks/bulk-create", json={"items": [{"title": "Follow up"}]}).json()
    task = body["tasks"][0]
    assert task["assigned_to"] == [] and task["due_date"] == "" and task["urgent"] == 0


def test_bulk_create_keeps_per_item_order_links_and_labels(client):
    """Each row carries its own vehicle, and the response has to come back
    through the same join the listing uses or the jump-to-vehicle chip is
    missing on every task the board just made."""
    first = make_recon_vehicle(client, stock_number="R-0981")
    second = make_recon_vehicle(client, stock_number="R-0977", vin="1HGCM82633A004353")
    orders = [make_recon_order(client, first["id"]), make_recon_order(client, second["id"])]
    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [
                {"title": "Follow up: R-0981", "order_id": orders[0]["id"]},
                {"title": "Follow up: R-0977", "order_id": orders[1]["id"], "notes": "41 days idle"},
            ]
        },
    )
    tasks = res.json()["tasks"]
    assert [t["order_label"] for t in tasks] == ["R-0981", "R-0977"]
    assert [t["recon_vehicle_id"] for t in tasks] == [first["id"], second["id"]]
    assert tasks[1]["notes"] == "41 days idle"


def test_bulk_create_is_all_or_nothing_on_a_bad_order_link(client):
    """A partial create is the worst outcome for this caller: the user would
    have to work out which cars didn't take and re-select exactly those."""
    order = make_recon_order(client, make_recon_vehicle(client)["id"])
    res = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [
                {"title": "Fine", "order_id": order["id"]},
                {"title": "Bad link", "order_id": 99999},
            ]
        },
    )
    assert res.status_code == 404
    assert client.get("/api/tasks").json() == []


def test_bulk_create_rejects_an_empty_batch_and_a_blank_title(client):
    assert client.post("/api/tasks/bulk-create", json={"items": []}).status_code == 422
    assert client.post("/api/tasks/bulk-create", json={"items": [{"title": ""}]}).status_code == 422
    assert client.get("/api/tasks").json() == []


def test_bulk_create_allows_duplicate_titles(client):
    """Two cars can genuinely need the same follow-up; deduping here would
    silently drop one of them."""
    body = client.post(
        "/api/tasks/bulk-create",
        json={
            "items": [{"title": "Chase the paint shop"}, {"title": "Chase the paint shop"}],
        },
    ).json()
    assert body["created"] == 2
    assert len({t["id"] for t in body["tasks"]}) == 2


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
