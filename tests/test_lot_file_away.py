"""Filing the whole finished pile away from the Lot Status sheet.

The sheet's last section is cars whose only remaining step is to be filed:
every row of it literally prints "send to History". Until now that step could
only be taken one car at a time, from inside each car's own page, so the pile
sat there -- and while it sits, every count above it describes a bigger lot
than the shop has. "1 ready of 8 on the lot" when four of the eight were sold
weeks ago is the number Walt reads.

The rules that make one button safe to point at a whole pile are what this
file is about: it can only ever file cars that are genuinely finished, it
re-checks that at the moment of writing rather than trusting the screen, and
it says out loud about anything it did not file.
"""

from __future__ import annotations

from tests.helpers import make_recon_order, make_recon_vehicle, make_we_owe, save_estimate

PART = {
    "kind": "part",
    "description": "Alternator",
    "part_number": "ALT-1",
    "quantity": 1,
    "unit_price": 0,
    "unit_cost": 300,
}


def lot(client) -> list[dict]:
    res = client.get("/api/reports/lot")
    assert res.status_code == 200, res.text
    return res.json()


def version_of(client, segment: str, ref_id: int) -> int:
    path = "recon/vehicles" if segment == "recon" else "we-owe"
    res = client.get(f"/api/{path}/{ref_id}")
    assert res.status_code == 200, res.text
    return res.json()["edit_version"]


def file_away(client, recon_ids=(), we_owe_ids=(), versions=None) -> dict:
    """Press the button on these cars, sending the version each one is on --
    which is what the sheet does, because every board row carries it.

    `versions` overrides one, to stand in for a car the other workstation
    changed after this sheet was drawn."""
    versions = versions or {}

    def entries(segment, ids):
        return [
            {"id": i, "expected_version": versions.get((segment, i), None) or version_of(client, segment, i)}
            for i in ids
        ]

    res = client.post(
        "/api/lot/file-away",
        json={"recon": entries("recon", recon_ids), "we_owe": entries("we_owe", we_owe_ids)},
    )
    assert res.status_code == 200, res.text
    return res.json()


def sell(client, recon_id: int) -> None:
    res = client.patch(
        f"/api/recon/vehicles/{recon_id}",
        json={"status": "sold", "sale_price": 6995, "sale_date": "2026-07-15"},
    )
    assert res.status_code == 200, res.text


def settle_promise(client, we_owe_id: int, status: str) -> None:
    res = client.patch(f"/api/we-owe/{we_owe_id}", json={"status": status})
    assert res.status_code == 200, res.text


def test_the_whole_finished_pile_goes_in_one_press(client):
    """Both halves of the pile, together: a sold lot car and a settled promise
    are the same chore and are filed by the same button."""
    sold = make_recon_vehicle(client, stock_number="R-SOLD", purchase_price=0)
    sell(client, sold["id"])
    kept = make_we_owe(client, customer_name="Marcus Doyle", description="Tie rod")
    settle_promise(client, kept["id"], "fulfilled")
    waived = make_we_owe(client, customer_name="Iris Chandler", description="Mirror")
    settle_promise(client, waived["id"], "waived")

    assert len([r for r in lot(client) if r["lot_bucket"] == "settled"]) == 3

    answer = file_away(client, recon_ids=[sold["id"]], we_owe_ids=[kept["id"], waived["id"]])
    assert len(answer["filed"]) == 3, answer
    assert answer["skipped"] == []
    assert [r for r in lot(client) if r["lot_bucket"] == "settled"] == []


def test_the_sheet_stops_counting_cars_that_have_gone(client):
    """The reason to do this at all. The headline counts describe "the lot",
    and an unfiled sold car is on them."""
    make_recon_vehicle(client, stock_number="R-HERE", purchase_price=0)
    sold = make_recon_vehicle(client, stock_number="R-GONE", vin="1HGCM82633A000002", purchase_price=0)
    sell(client, sold["id"])
    assert len(lot(client)) == 2

    file_away(client, recon_ids=[sold["id"]])
    rows = lot(client)
    assert [r["stock_number"] for r in rows] == ["R-HERE"]


def test_a_car_still_in_the_shop_is_refused_not_filed(client):
    """The guarantee the single-vehicle archive route does not make. That one
    files whatever it is pointed at, which is right when a person is looking
    at that one car and wrong when a button is filing five: a car that went
    back into the shop between the sheet being drawn and the button being
    pressed must not be swept up with the finished ones."""
    working = make_recon_vehicle(client, stock_number="R-BUSY", purchase_price=0)
    order = make_recon_order(client, working["id"])
    save_estimate(client, order["id"], [PART])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "tester"})

    answer = file_away(client, recon_ids=[working["id"]])
    assert answer["filed"] == []
    assert len(answer["skipped"]) == 1
    skipped = answer["skipped"][0]
    assert skipped["reason"] == "it is back in the shop"
    assert skipped["label"] == "R-BUSY — 2019 Honda Civic", skipped
    assert [r["stock_number"] for r in lot(client)] == ["R-BUSY"], "it must still be on the lot"


def test_an_unfinished_promise_is_refused_too(client):
    """The we-owe half of the same guarantee: a promise still owed to a
    customer is not paperwork."""
    open_promise = make_we_owe(client, customer_name="Renata Silva", description="Brakes")

    answer = file_away(client, we_owe_ids=[open_promise["id"]])
    assert answer["filed"] == []
    assert answer["skipped"][0]["reason"] == "it is back in the shop"
    assert len([r for r in lot(client) if r["segment"] == "we_owe"]) == 1


def test_the_finished_ones_still_go_when_one_of_them_cannot(client):
    """A mixed press does as much as it honestly can. Refusing the whole batch
    over one row would mean the button stops working on a busy lot, and filing
    silently would mean the sheet looks like it lost a car."""
    sold = make_recon_vehicle(client, stock_number="R-OK", purchase_price=0)
    sell(client, sold["id"])
    busy = make_recon_vehicle(client, stock_number="R-BUSY", vin="1HGCM82633A000002", purchase_price=0)
    order = make_recon_order(client, busy["id"])
    client.patch(f"/api/orders/{order['id']}/status", json={"status": "in_progress", "actor": "tester"})

    answer = file_away(client, recon_ids=[sold["id"], busy["id"]])
    assert [f["label"] for f in answer["filed"]] == ["R-OK — 2019 Honda Civic"]
    assert [s["label"] for s in answer["skipped"]] == ["R-BUSY — 2019 Honda Civic"]
    assert [r["stock_number"] for r in lot(client)] == ["R-BUSY"]


def test_a_car_the_other_workstation_already_filed_says_so(client):
    """Two people press the button on the same pile a second apart. The second
    press must not report filing a car it did not file, and must not fail."""
    sold = make_recon_vehicle(client, stock_number="R-TWICE", purchase_price=0)
    sell(client, sold["id"])
    assert len(file_away(client, recon_ids=[sold["id"]])["filed"]) == 1

    answer = file_away(client, recon_ids=[sold["id"]])
    assert answer["filed"] == []
    assert answer["skipped"][0]["reason"] == "it is already in History"
    assert answer["skipped"][0]["label"] == "R-TWICE — 2019 Honda Civic"


def test_an_id_that_is_not_a_lot_car_is_reported_not_ignored(client):
    answer = file_away(
        client,
        recon_ids=[4242],
        we_owe_ids=[4242],
        versions={("recon", 4242): 1, ("we_owe", 4242): 1},
    )
    assert answer["filed"] == []
    assert [s["reason"] for s in answer["skipped"]] == ["it is no longer on the lot"] * 2


def test_a_car_edited_at_the_other_desk_is_refused_not_written_over(client):
    """The compare-and-set every write in this app makes, done per car. A
    sheet left open while somebody at the other desk edits one of its cars
    must not file that car on the strength of what it was showing.

    A skip, not a 409 for the whole press: the other cars in the pile are
    separate records with nothing half-applied between them, and failing all
    five over one would mean the button stops working on a busy lot."""
    stale = make_recon_vehicle(client, stock_number="R-STALE", purchase_price=0)
    sell(client, stale["id"])
    fine = make_recon_vehicle(client, stock_number="R-FINE", vin="1HGCM82633A000002", purchase_price=0)
    sell(client, fine["id"])

    answer = file_away(
        client,
        recon_ids=[stale["id"], fine["id"]],
        versions={("recon", stale["id"]): 1},
    )
    assert [f["label"] for f in answer["filed"]] == ["R-FINE — 2019 Honda Civic"]
    assert [s["reason"] for s in answer["skipped"]] == ["somebody else changed it just now"]
    assert [r["stock_number"] for r in lot(client)] == ["R-STALE"], "the stale car was filed anyway"


def test_nothing_selected_files_nothing(client):
    sold = make_recon_vehicle(client, stock_number="R-LEFT", purchase_price=0)
    sell(client, sold["id"])

    assert file_away(client) == {"filed": [], "skipped": []}
    assert len([r for r in lot(client) if r["lot_bucket"] == "settled"]) == 1


def test_a_filed_car_is_in_history_and_can_be_reopened(client):
    """Filing is reversible and deletes nothing, which is the whole reason a
    bulk button is a question rather than a warning."""
    sold = make_recon_vehicle(client, stock_number="R-BACK", purchase_price=0)
    sell(client, sold["id"])
    file_away(client, recon_ids=[sold["id"]])

    history = client.get("/api/vehicles-board?archived=true").json()
    assert [r["stock_number"] for r in history] == ["R-BACK"]
    assert history[0]["archived_at"], "the day it left has to be recorded"

    assert client.post(f"/api/recon/vehicles/{sold['id']}/reopen").status_code == 200
    assert [r["stock_number"] for r in lot(client)] == ["R-BACK"]


def test_filing_bumps_the_version_so_a_stale_page_cannot_write_over_it(client):
    """Every other write on these records moves edit_version; this one has to
    as well, or a page loaded before the car was filed still holds a version
    the server would accept."""
    sold = make_recon_vehicle(client, stock_number="R-VER", purchase_price=0)
    sell(client, sold["id"])
    before = client.get(f"/api/recon/vehicles/{sold['id']}").json()["edit_version"]

    file_away(client, recon_ids=[sold["id"]])
    after = client.get(f"/api/recon/vehicles/{sold['id']}").json()["edit_version"]
    assert after > before, "filing a car away left its version untouched"


def test_a_board_row_knows_for_itself_whether_it_has_been_filed(client, db_path):
    """`archived` on a board row used to be the answer the *caller* asked for
    rather than a fact about the car. Asking for one side of History gave the
    right answer by accident; asking for both (which the spend report and this
    endpoint do) came back with every row -- filed or not -- claiming to be
    live. Anything reading the field had to know not to ask that way, and the
    "send to History" wording on a car already in History is what it looks
    like when something forgets.
    """
    from app.db import connect
    from app.recon import vehicle_board_rows

    here = make_recon_vehicle(client, stock_number="R-LIVE", purchase_price=0)
    gone = make_recon_vehicle(client, stock_number="R-FILED", vin="1HGCM82633A000002", purchase_price=0)
    sell(client, gone["id"])
    file_away(client, recon_ids=[gone["id"]])

    with connect(db_path) as db:
        both = {r["stock_number"]: r for r in vehicle_board_rows(db, archived=None)}
    assert both["R-LIVE"]["archived"] is False
    assert both["R-FILED"]["archived"] is True
    assert here["stock_number"] in both
    # And the sentence that reads it stops telling a filed car to be filed.
    assert "send to History" not in both["R-FILED"]["needs"], both["R-FILED"]["needs"]
    assert "send to History" in both["R-LIVE"]["needs"] or both["R-LIVE"]["lot_bucket"] != "settled"


def test_the_same_car_twice_in_one_press_is_filed_once(client):
    sold = make_recon_vehicle(client, stock_number="R-DUPE", purchase_price=0)
    sell(client, sold["id"])

    answer = file_away(client, recon_ids=[sold["id"], sold["id"]])
    assert len(answer["filed"]) == 1
    assert answer["skipped"] == []
