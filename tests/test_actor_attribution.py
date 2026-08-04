"""Who did it, on the server side.

One shop PC and two people, so "who received these parts" and "who ticked
this repair off" are questions the ticket history is expected to answer. It
answers them out of the `actor` each write carries.

Two things are pinned here, both of which the front end depends on:

* what a request sends is what the log records -- including on the writes that
  never used to send anything (opening a ticket, adding and ticking off a job,
  the estimate autosave), which is what made the history read "Ticket opened
  by ui" on a car two people had worked on;
* an empty actor is a validation error on the endpoints whose field carries a
  minimum length. That is why static/js/core.js omits the field entirely when
  nobody has picked a name rather than sending "". Sending "" would 422 the
  estimate autosave -- attribution nobody asked for, breaking the save
  everybody needs.
"""

from __future__ import annotations

import pytest

from tests.helpers import recon_vin

WORKER = "Antonio Reyes"


def make_ticket(client) -> tuple[int, int]:
    """A recon car with a ticket open on it. Returns (recon_id, order_id)."""
    recon = client.post(
        "/api/recon/vehicles",
        json={
            "stock_number": "R-4100",
            "vin": recon_vin("R-4100"),
            "year": 2016,
            "make": "Ford",
            "model": "Fusion",
        },
    ).json()
    order = client.post(
        "/api/orders",
        json={"segment": "recon", "recon_vehicle_id": recon["id"], "concern": "Recon prep", "actor": WORKER},
    ).json()
    return recon["id"], order["id"]


def actors_for(client, order_id: int, action: str) -> list[str]:
    activity = client.get(f"/api/orders/{order_id}").json()["activity"]
    return [row["actor"] for row in activity if row["action"] == action]


def test_the_name_on_the_request_is_the_name_in_the_log(client) -> None:
    """Every step of a morning's work, each naming who did it."""
    _, order_id = make_ticket(client)

    assert actors_for(client, order_id, "order_created") == [WORKER]

    job = client.post(
        f"/api/orders/{order_id}/jobs", json={"title": "Front brakes", "actor": WORKER}
    ).json()
    assert actors_for(client, order_id, "job_created") == [WORKER]

    client.patch(f"/api/orders/{order_id}/jobs/{job['id']}/done", json={"done": True, "actor": WORKER})
    assert actors_for(client, order_id, "job_completed") == [WORKER]
    # The person who finished it is kept on the repair itself, not only in the
    # log -- that's what the tick's tooltip reads back.
    jobs = client.get(f"/api/orders/{order_id}").json()["estimate"]["jobs"]
    assert [j["completed_by"] for j in jobs] == [WORKER]

    client.patch(f"/api/orders/{order_id}/status", json={"status": "in_progress", "actor": WORKER})
    assert actors_for(client, order_id, "status_changed") == [WORKER]

    client.post(f"/api/orders/{order_id}/notes", json={"text": "Second key in the drawer", "actor": WORKER})
    assert client.get(f"/api/orders/{order_id}").json()["notes"][0]["actor"] == WORKER


def test_a_request_that_names_nobody_is_not_attributed_to_a_person(client) -> None:
    """The server's placeholder is "ui" -- the request's origin, not a name.

    The front end is what turns that back into silence on screen (actorLabel
    in static/js/shortcuts.js). What matters here is that the server never
    invents a person: a placeholder can be recognised and hidden, a plausible
    name cannot.
    """
    _, order_id = make_ticket(client)
    client.post(f"/api/orders/{order_id}/jobs", json={"title": "Windshield"})

    recorded = actors_for(client, order_id, "job_created")
    assert recorded == ["ui"]
    assert not any(actor.strip().count(" ") for actor in recorded), "the placeholder should not read as a person's name"


def test_an_empty_actor_is_refused_rather_than_stored(client) -> None:
    """Why core.js omits the field instead of sending "".

    The estimate autosave runs on every keystroke-settled edit to a ticket's
    lines. Sending an empty actor with it -- which is what "always send the
    picker's value" would do before anyone picks a name -- fails validation,
    and the save is the part of that trade nobody would agree to lose.
    """
    _, order_id = make_ticket(client)
    body = {"labor_rate": 0, "tax_rate": 0, "items": [], "expected_version": None}

    assert client.post(f"/api/orders/{order_id}/estimate", json={**body, "actor": ""}).status_code == 422
    # Omitted entirely is fine, and so is a real name.
    assert client.post(f"/api/orders/{order_id}/estimate", json=body).status_code == 200
    fresh = client.get(f"/api/orders/{order_id}").json()["estimate"]["edit_version"]
    assert client.post(
        f"/api/orders/{order_id}/estimate",
        json={**body, "expected_version": fresh, "actor": WORKER},
    ).status_code == 200


@pytest.mark.parametrize("actor", ["", "   "])
def test_a_blank_actor_on_a_job_tick_falls_back_to_the_placeholder(client, actor: str) -> None:
    """Whitespace is not an attribution.

    This endpoint's field has no minimum length, so a blank does arrive. It
    must not be stored as the person who finished the repair -- "Finished by
    <nothing>" is a caption the tooltip would print in full.
    """
    _, order_id = make_ticket(client)
    job = client.post(f"/api/orders/{order_id}/jobs", json={"title": "Detail", "actor": WORKER}).json()

    client.patch(f"/api/orders/{order_id}/jobs/{job['id']}/done", json={"done": True, "actor": actor})
    jobs = client.get(f"/api/orders/{order_id}").json()["estimate"]["jobs"]
    assert jobs[0]["completed_by"] == "ui"


def test_deleting_a_job_records_who_deleted_it(client) -> None:
    """A DELETE has no body, so the name travels in the query string -- the one
    place the front end still has to say it out loud (withActorParam)."""
    _, order_id = make_ticket(client)
    job = client.post(f"/api/orders/{order_id}/jobs", json={"title": "Detail", "actor": WORKER}).json()

    client.delete(f"/api/orders/{order_id}/jobs/{job['id']}", params={"actor": WORKER})
    assert actors_for(client, order_id, "job_deleted") == [WORKER]
