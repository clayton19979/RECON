"""A line's money must be one number on the lot's own work, whichever door it came through.

Recon and we-owe are billed at the shop's cost -- no markup, ever (CLAUDE.md).
The schema still carries unit_price and unit_cost separately because it is
shared with retail, and the two doors that don't go through the estimate grid
-- the agent's append door (POST /orders/{id}/estimate/items) and the
technician findings door (POST /orders/{id}/findings) -- accepted them as
independent fields, both defaulting to 0.

That split the money for any caller that filled in only one, which is the
natural thing for an AI told "add a used alternator, $85":

- unit_price feeds the ticket's subtotal, so the ticket read $85 while
  unit_cost fed every rollup the board, the Lot Report and the vehicle's own
  total are built on -- and those read $0. Walt's "how much have we spent on
  this car" was short by exactly the lines the agent wrote.
- The miss froze: quoted_unit_cost is copied from unit_cost at insert and is
  what "still to spend" prices a line at, so the car's open/unreceived money
  stayed $0 forever, even after the real vendor bill landed.
- The other way round (unit_cost only) put $0 on the ticket while the car's
  cost read $85 -- two screens about the same car, disagreeing.

The rule now: on recon and we-owe, give either field and the other takes the
same value; give both the same and nothing changes; give both *different* and
the whole request is refused -- that is a markup this shop never charges, and
guessing which number was meant would put a figure on a report the app can't
stand behind. Retail lines are untouched: there a marked-up price is a real,
distinct number.
"""

from __future__ import annotations

import pytest

from tests.helpers import make_recon_order, make_recon_vehicle, make_retail_order, make_we_owe, save_estimate

ALTERNATOR = {"kind": "part", "description": "Used alternator", "part_number": "ALT-85"}
DIAG = {"kind": "labor", "description": "Diag", "quantity": 1, "unit_price": 0, "unit_cost": 0}


def append_lines(client, order_id, items):
    return client.post(f"/api/orders/{order_id}/estimate/items", json={"items": items})


def ticket_items(client, order_id):
    estimate = client.get(f"/api/orders/{order_id}").json()["estimate"]
    return estimate["items"] if estimate else []


def recon_order(client, stock_number="R-COST1"):
    vehicle = make_recon_vehicle(client, stock_number=stock_number)
    return vehicle, make_recon_order(client, vehicle["id"])


# ---------------------------------------------------------------------------
# The append door (the agent's door)
# ---------------------------------------------------------------------------


def test_a_price_only_line_lands_in_the_cars_cost_too(client):
    """unit_price alone used to make the ticket read $85 and the car $0."""
    vehicle, order = recon_order(client)
    res = append_lines(client, order["id"], [ALTERNATOR | {"quantity": 1, "unit_price": 85.0}])
    assert res.status_code == 201, res.text
    assert res.json()["total"] == pytest.approx(85.0)

    line = ticket_items(client, order["id"])[0]
    assert line["unit_cost"] == pytest.approx(85.0)
    assert line["quoted_unit_cost"] == pytest.approx(85.0)

    detail = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert detail["quoted_cost"] == pytest.approx(85.0)
    assert detail["open_cost"] == pytest.approx(85.0)


def test_a_cost_only_line_lands_on_the_ticket_too(client):
    """unit_cost alone used to make the car read $85 and the ticket $0."""
    _vehicle, order = recon_order(client)
    res = append_lines(client, order["id"], [ALTERNATOR | {"quantity": 1, "unit_cost": 85.0}])
    assert res.status_code == 201, res.text
    assert res.json()["total"] == pytest.approx(85.0)
    assert ticket_items(client, order["id"])[0]["unit_price"] == pytest.approx(85.0)


def test_two_different_numbers_on_recon_are_refused_whole(client):
    """A differing price is a markup this shop never charges. Refused before
    anything lands, so a contradiction on line two can't leave line one behind."""
    _vehicle, order = recon_order(client)
    res = append_lines(
        client,
        order["id"],
        [
            ALTERNATOR | {"quantity": 1, "unit_cost": 85.0, "unit_price": 85.0},
            {"kind": "part", "description": "Serpentine belt", "quantity": 1, "unit_price": 30.0, "unit_cost": 14.0},
        ],
    )
    assert res.status_code == 422
    assert "no markup" in res.json()["detail"]
    assert ticket_items(client, order["id"]) == []


def test_matching_numbers_still_work_exactly_as_before(client):
    _vehicle, order = recon_order(client)
    res = append_lines(client, order["id"], [ALTERNATOR | {"quantity": 2, "unit_price": 40.0, "unit_cost": 40.0}])
    assert res.status_code == 201, res.text
    assert res.json()["total"] == pytest.approx(80.0)


def test_a_line_with_no_money_yet_is_still_a_normal_state(client):
    """Cost arrives with the vendor's invoice; writing the line first is how
    this shop works and must stay legal."""
    _vehicle, order = recon_order(client)
    res = append_lines(client, order["id"], [ALTERNATOR | {"quantity": 1}])
    assert res.status_code == 201, res.text
    line = ticket_items(client, order["id"])[0]
    assert line["unit_price"] == 0
    assert line["unit_cost"] == 0


def test_we_owe_lines_follow_the_same_at_cost_rule(client):
    owed = make_we_owe(client)
    order = client.post(
        "/api/orders", json={"concern": "Owed tie rod", "segment": "we_owe", "we_owe_id": owed["id"]}
    ).json()
    res = append_lines(
        client, order["id"], [{"kind": "part", "description": "Tie rod", "quantity": 1, "unit_price": 34.0}]
    )
    assert res.status_code == 201, res.text
    assert ticket_items(client, order["id"])[0]["unit_cost"] == pytest.approx(34.0)

    refused = append_lines(
        client,
        order["id"],
        [{"kind": "part", "description": "Tie rod end", "quantity": 1, "unit_price": 50.0, "unit_cost": 20.0}],
    )
    assert refused.status_code == 422


def test_retail_lines_keep_their_markup(client):
    """On retail a marked-up price is a real, distinct number -- the at-cost
    rule must not touch it, in either the mirror or the refusal direction."""
    order = make_retail_order(client)
    res = append_lines(
        client,
        order["id"],
        [{"kind": "part", "description": "Brake pads", "quantity": 1, "unit_price": 89.0, "unit_cost": 52.0}],
    )
    assert res.status_code == 201, res.text
    line = ticket_items(client, order["id"])[0]
    assert line["unit_price"] == pytest.approx(89.0)
    assert line["unit_cost"] == pytest.approx(52.0)

    # And price-only stays price-only: the cost genuinely isn't known yet,
    # and inventing one equal to the retail price would overstate the spend.
    res = append_lines(
        client, order["id"], [{"kind": "part", "description": "Wiper blades", "quantity": 1, "unit_price": 24.0}]
    )
    assert res.status_code == 201, res.text
    assert ticket_items(client, order["id"])[1]["unit_cost"] == 0


# ---------------------------------------------------------------------------
# The findings door (the technician's door)
# ---------------------------------------------------------------------------


def findings(client, order_id, items):
    return client.post(
        f"/api/orders/{order_id}/findings",
        json={"summary": "Test drive: alternator whine under load.", "items": items},
    )


def test_a_technicians_priced_finding_reaches_the_cars_cost(client):
    """FindingItem only requires unit_price, so every priced finding used to
    land with unit_cost 0 -- on the car Walt reads, the proposal was free."""
    vehicle, order = recon_order(client)
    save_estimate(client, order["id"], [DIAG])
    res = findings(client, order["id"], [ALTERNATOR | {"quantity": 1, "unit_price": 85.0}])
    assert res.status_code == 201, res.text

    line = ticket_items(client, order["id"])[-1]
    assert line["unit_cost"] == pytest.approx(85.0)
    assert line["quoted_unit_cost"] == pytest.approx(85.0)
    assert client.get(f"/api/recon/vehicles/{vehicle['id']}").json()["quoted_cost"] == pytest.approx(85.0)


def test_a_contradictory_finding_is_refused_with_the_finding_itself(client):
    """Nothing half-lands: no draft lines, and no orphaned finding summary."""
    _vehicle, order = recon_order(client)
    save_estimate(client, order["id"], [DIAG])
    res = findings(client, order["id"], [ALTERNATOR | {"quantity": 1, "unit_price": 120.0, "unit_cost": 85.0}])
    assert res.status_code == 422
    assert "no markup" in res.json()["detail"]
    assert [line["description"] for line in ticket_items(client, order["id"])] == ["Diag"]
    assert client.get(f"/api/orders/{order['id']}").json()["findings"] == []


def test_retail_findings_keep_price_and_cost_apart(client):
    order = make_retail_order(client)
    save_estimate(client, order["id"], [DIAG])
    res = findings(
        client,
        order["id"],
        [
            {
                "kind": "part",
                "description": "Coil",
                "part_number": "IC-1",
                "quantity": 1,
                "unit_price": 62.0,
                "unit_cost": 38.0,
            }
        ],
    )
    assert res.status_code == 201, res.text
    line = ticket_items(client, order["id"])[-1]
    assert line["unit_price"] == pytest.approx(62.0)
    assert line["unit_cost"] == pytest.approx(38.0)
