"""The Assigned / Timing card on a repair order, saved by two people.

The card carries five fields written by two separate Save buttons -- who is
on the ticket (advisor, technician) and when it happened (date in, odometer,
promised). The endpoint behind both buttons used to overwrite all five from
whatever the caller sent, defaults included, which cost the shop two things
every day:

* saving the Timing half wrote the *other* half too, so typing a mileage
  stamped the advisor the page had merely pre-selected onto a ticket nobody
  had assigned -- and that name then printed on the ticket;
* two workstations on one ticket silently overwrote each other, even though
  order_workflow.version was already being incremented on every save and had
  simply never been read.

These tests pin both: a save writes only the fields it sent, and a save from
a page that has gone stale is refused rather than winning.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle


def assignment_of(client, order_id: int) -> dict:
    return client.get(f"/api/orders/{order_id}").json()["assignment"]


def make_ticket(client) -> tuple[dict, dict, dict]:
    vehicle = make_recon_vehicle(client)
    order = make_recon_order(client, vehicle["id"])
    advisor = client.post("/api/staff", json={"name": "Dana Whitfield", "role": "advisor"}).json()
    technician = client.post("/api/staff", json={"name": "Ray Ortiz", "role": "technician"}).json()
    return order, advisor, technician


def test_saving_the_timing_half_leaves_who_is_on_the_ticket_alone(client):
    """The bug this whole change exists for.

    Ray is on the ticket. Somebody types the odometer reading and saves the
    Timing card. Ray must still be on the ticket afterwards -- and, just as
    important, nobody must have become the advisor as a side effect.
    """
    order, _advisor, technician = make_ticket(client)
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"odometer_in": 142300})
    assert res.status_code == 200

    after = assignment_of(client, order["id"])
    assert after["technician_id"] == technician["id"]
    assert after["technician_name"] == "Ray Ortiz"
    assert after["advisor_id"] is None
    assert after["odometer_in"] == 142300


def test_saving_who_is_on_the_ticket_leaves_the_dates_alone(client):
    """The same guarantee in the other direction -- assigning a technician
    must not blank the date the car came in."""
    order, advisor, technician = make_ticket(client)
    client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"date_in": "2026-01-15", "odometer_in": 98000, "promised_at": "2026-01-20"},
    )

    res = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"advisor_id": advisor["id"], "technician_id": technician["id"]},
    )
    assert res.status_code == 200

    after = assignment_of(client, order["id"])
    assert after["advisor_name"] == "Dana Whitfield"
    assert after["technician_name"] == "Ray Ortiz"
    assert after["date_in"] == "2026-01-15"
    assert after["odometer_in"] == 98000
    assert after["promised_at"] == "2026-01-20"


def test_unassigning_still_works(client):
    """Leave-it-alone and take-them-off have to stay tellable apart, so
    clearing a slot sends -1 rather than nothing at all."""
    order, advisor, technician = make_ticket(client)
    client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"advisor_id": advisor["id"], "technician_id": technician["id"]},
    )

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": -1})
    assert res.status_code == 200

    after = assignment_of(client, order["id"])
    assert after["technician_id"] is None
    # The advisor was not in the payload, so the advisor did not move.
    assert after["advisor_id"] == advisor["id"]


def test_a_stale_page_is_refused_instead_of_overwriting(client):
    """Two workstations, one ticket. Clayton puts Ray on it. Antonio's page
    was loaded before that, so it still shows nobody -- he saves a promised
    date. Antonio's save must be refused, and Ray must still be on the
    ticket."""
    order, _advisor, technician = make_ticket(client)
    loaded_version = assignment_of(client, order["id"])["version"]

    clayton = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"technician_id": technician["id"], "expected_version": loaded_version, "actor": "Clayton"},
    )
    assert clayton.status_code == 200
    assert clayton.json()["version"] == loaded_version + 1

    antonio = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"promised_at": "2026-08-05", "expected_version": loaded_version, "actor": "Antonio"},
    )
    assert antonio.status_code == 409
    assert "reload" in antonio.json()["detail"]

    after = assignment_of(client, order["id"])
    assert after["technician_id"] == technician["id"]
    assert after["promised_at"] == ""

    # And once he reloads, the same save goes through.
    retry = client.put(
        f"/api/orders/{order['id']}/assignment",
        json={"promised_at": "2026-08-05", "expected_version": after["version"], "actor": "Antonio"},
    )
    assert retry.status_code == 200
    assert retry.json()["promised_at"] == "2026-08-05"
    assert retry.json()["technician_id"] == technician["id"]


def test_a_save_that_changes_nothing_does_not_count_as_touching_the_car(client):
    """Opening the card and pressing Save without typing anything used to
    bump the version and log an activity event, which reset the board's Idle
    clock on a car nobody had actually worked on."""
    order, _advisor, _technician = make_ticket(client)
    before = assignment_of(client, order["id"])
    events_before = len(client.get(f"/api/orders/{order['id']}").json()["activity"])

    res = client.put(f"/api/orders/{order['id']}/assignment", json={"actor": "Clayton"})
    assert res.status_code == 200
    assert res.json()["version"] == before["version"]

    assert len(client.get(f"/api/orders/{order['id']}").json()["activity"]) == events_before


def test_the_activity_log_records_only_what_changed(client):
    """It used to print all five fields on every save, including the blanks
    the old full overwrite invented."""
    order, _advisor, technician = make_ticket(client)
    client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": technician["id"]})

    activity = client.get(f"/api/orders/{order['id']}").json()["activity"]
    logged = [a for a in activity if a["action"] == "assignment_updated"]
    assert logged and logged[-1]["details"] == {"technician_id": technician["id"]}


def test_a_bad_staff_id_is_still_refused(client):
    """The sentinel must not become a hole in the role check."""
    order, advisor, _technician = make_ticket(client)
    res = client.put(f"/api/orders/{order['id']}/assignment", json={"technician_id": advisor["id"]})
    assert res.status_code == 400
    assert assignment_of(client, order["id"])["technician_id"] is None
