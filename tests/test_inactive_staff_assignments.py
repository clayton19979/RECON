"""Somebody leaving the shop must not lock up the cars they were working on.

Deactivating is the only way RECON has of saying "he doesn't work here
anymore" -- there is no delete, on purpose, so that the tickets and repairs he
finished keep his name on them. The Staff screen promises exactly that when it
asks. It was not true: the moment a technician was deactivated, every save that
carried his id back was refused as "Technician is not an active technician",
which meant renaming a repair, changing the advisor or typing a promised date
on any of his open tickets. A ticket became uneditable because a technician
left, and the message blamed a field nobody had touched.

The rule these lock in: what somebody already holds stays theirs and stays
editable; new work still cannot be handed to somebody who has gone.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle


def add_tech(client, name="Ray Ortiz"):
    res = client.post("/api/staff", json={"name": name, "role": "technician"})
    assert res.status_code == 201, res.text
    return res.json()


def add_advisor(client, name="Dana Whitfield"):
    res = client.post("/api/staff", json={"name": name, "role": "advisor"})
    assert res.status_code == 201, res.text
    return res.json()


def deactivate(client, staff_id):
    res = client.patch(f"/api/staff/{staff_id}", json={"active": False})
    assert res.status_code == 200, res.text
    return res.json()


def ticket_with_tech(client, stock_number="R-2001"):
    tech = add_tech(client)
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    order = make_recon_order(client, vehicle["id"])
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": tech["id"]})
    assert res.status_code == 200, res.text
    return order, tech


def test_renaming_a_repair_still_works_after_its_technician_leaves(client):
    order, tech = ticket_with_tech(client)
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Front brakes"}).json()
    client.put(
        f"/api/orders/{order['id']}/jobs/{job['id']}", json={"title": "Front brakes", "technician_id": tech["id"]}
    )
    deactivate(client, tech["id"])

    res = client.put(
        f"/api/orders/{order['id']}/jobs/{job['id']}",
        json={"title": "Front + rear brakes", "technician_id": tech["id"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["title"] == "Front + rear brakes"
    # And he is still on it -- the point of deactivating rather than deleting.
    assert res.json()["technician_id"] == tech["id"]
    assert res.json()["technician_name"] == "Ray Ortiz"


def test_a_ticket_stays_editable_after_its_technician_leaves(client):
    order, tech = ticket_with_tech(client)
    deactivate(client, tech["id"])

    # The assignment popover posts every field it holds at once, so typing a
    # promised date carries the technician back with it.
    res = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"technician_id": tech["id"], "promised_at": "2026-09-01"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["promised_at"] == "2026-09-01"
    assert res.json()["technician_id"] == tech["id"]


def test_an_advisor_can_be_added_to_a_ticket_whose_technician_left(client):
    order, tech = ticket_with_tech(client)
    advisor = add_advisor(client)
    deactivate(client, tech["id"])

    res = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"technician_id": tech["id"], "advisor_id": advisor["id"]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["advisor_id"] == advisor["id"]
    assert res.json()["technician_name"] == "Ray Ortiz"


def test_the_car_still_says_who_is_on_it(client):
    """The board is where "who is working on this" is read, and deactivating
    somebody must not quietly empty that column."""
    order, tech = ticket_with_tech(client)
    deactivate(client, tech["id"])

    row = next(r for r in client.get("/api/vehicles-board").json() if r["stock_number"] == "R-2001")
    assert row["technicians"] == ["Ray Ortiz"]
    assert client.get(f"/api/orders/{order['id']}").json()["assignment"]["technician_name"] == "Ray Ortiz"


def test_new_work_still_cannot_be_handed_to_somebody_who_left(client):
    order, tech = ticket_with_tech(client)
    other = make_recon_vehicle(client, stock_number="R-2002")
    other_order = make_recon_order(client, other["id"])
    deactivate(client, tech["id"])

    assert (
        client.put(f"/api/orders/{other_order['id']}/assignment", json={"technician_id": tech["id"]}).status_code == 400
    )
    assert (
        client.post(
            f"/api/orders/{other_order['id']}/jobs", json={"title": "Tires", "technician_id": tech["id"]}
        ).status_code
        == 400
    )
    # And a repair that was somebody else's cannot be moved onto him either.
    job = client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Tires"}).json()
    moved = client.put(
        f"/api/orders/{order['id']}/jobs/{job['id']}", json={"title": "Tires", "technician_id": tech["id"]}
    )
    assert moved.status_code == 400
    assert "not an active technician" in moved.json()["detail"]


def test_a_ticket_can_still_be_taken_off_somebody_who_left(client):
    """Reassigning away from a departed technician is the whole reason the
    picker has to keep working -- clearing the slot must not be refused."""
    order, tech = ticket_with_tech(client)
    replacement = add_tech(client, name="Sam Klein")
    deactivate(client, tech["id"])

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": replacement["id"]})
    assert res.status_code == 200, res.text
    assert res.json()["technician_name"] == "Sam Klein"


def test_the_staff_list_says_how_many_cars_each_person_is_still_on(client):
    """Asked before anybody is deactivated, so the confirm can say what is
    about to be left behind."""
    order, _tech = ticket_with_tech(client)
    advisor = add_advisor(client)
    client.put(f"/api/orders/{order['id']}/assignment", json={"advisor_id": advisor["id"]})

    people = {row["name"]: row for row in client.get("/api/staff").json()}
    assert people["Ray Ortiz"]["open_orders"] == 1
    assert people["Dana Whitfield"]["open_orders"] == 1

    # A ticket that is finished is not work anybody is still holding.
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "complete"})
    people = {row["name"]: row for row in client.get("/api/staff").json()}
    assert people["Ray Ortiz"]["open_orders"] == 0


def test_a_voided_ticket_is_not_work_anybody_is_holding(client):
    order, _tech = ticket_with_tech(client)
    client.post(f"/api/orders/{order['id']}/void", json={"reason": "wrong car"})

    people = {row["name"]: row for row in client.get("/api/staff").json()}
    assert people["Ray Ortiz"]["open_orders"] == 0


def test_owning_only_a_repair_on_the_ticket_counts(client):
    """Same attribution the technician report uses -- a tech pulled in for one
    brake job is on that car even if the ticket's default is somebody else."""
    order, _tech = ticket_with_tech(client)
    helper = add_tech(client, name="Priya Nair")
    client.post(f"/api/orders/{order['id']}/jobs", json={"title": "Brakes", "technician_id": helper["id"]})

    people = {row["name"]: row for row in client.get("/api/staff").json()}
    assert people["Priya Nair"]["open_orders"] == 1
    # Being both the assignee and a job owner is still one car, not two.
    assert people["Ray Ortiz"]["open_orders"] == 1
