"""The same person must not end up on file twice.

Intake writes a customer down in exactly one place -- the New We-Owe dialog --
and that dialog's picker opens on "+ New customer...". So typing the name is
the path of least resistance, and on a shop with a few hundred people on file
it is genuinely easier than finding them in the list. The result was a second
record for somebody the shop already knew, with no hint on either that the
other existed.

That is not cosmetic. A we-owe promise hangs off a customer id, so the split
puts what the shop owes them on one record and the new promise on the other.
The Customers screen counts each half separately, and "what's still owed" --
the question that screen exists to answer with the person on the phone -- is
answered with half the truth.

The app already guards the same failure for cars (tests/test_recon.py covers
recon_match). These are the same rules for people.
"""

from __future__ import annotations


def add(client, name, phone="", **extra):
    return client.post("/api/customers", json={"name": name, "phone": phone, **extra})


def match(client, name="", phone=""):
    return client.get("/api/customers/match", params={"name": name, "phone": phone}).json()


def test_the_same_name_and_number_twice_is_refused(client):
    first = add(client, "Iris Chandler", "(313) 555-0304")
    assert first.status_code == 201

    again = add(client, "Iris Chandler", "(313) 555-0304")
    assert again.status_code == 409
    # The refusal has to name the person, or it sends the advisor looking down
    # a list of hundreds for somebody it already found.
    assert "Iris Chandler" in again.json()["detail"]

    assert [c["name"] for c in client.get("/api/customers").json()] == ["Iris Chandler"]


def test_the_refusal_survives_a_different_spelling(client):
    """The duplicate that actually happens is not a copy-paste -- it is the
    same person typed again on a different morning, in a different case, with
    the number punctuated differently."""
    assert add(client, "Iris Chandler", "(313) 555-0304").status_code == 201
    assert add(client, "  iris   chandler ", "313-555-0304").status_code == 409
    assert add(client, "IRIS CHANDLER", "13135550304").status_code == 409
    assert len(client.get("/api/customers").json()) == 1


def test_punctuation_in_a_name_is_not_a_second_person(client):
    assert add(client, "Sean O'Brien", "(219) 555-0111").status_code == 201
    assert add(client, "Sean OBrien", "(219) 555-0111").status_code == 409
    # The other way a name gets punctuated two ways, which wants the opposite
    # treatment -- see _customer_name_key for why both are handled by dropping.
    assert add(client, "Mary-Jane Kowalski", "(219) 555-0112").status_code == 201
    assert add(client, "Mary Jane Kowalski", "(219) 555-0112").status_code == 409


def test_two_real_people_can_still_both_be_added(client):
    """The guard has to stay out of the way of the cases that are real, or it
    becomes a dead end at the counter with a customer standing there.

    Two people share a name; a household shares a number. Neither is refused --
    both are only ever mentioned by the note under the field.
    """
    assert add(client, "John Smith", "(219) 555-0101").status_code == 201
    # Same name, different number: a different John Smith.
    assert add(client, "John Smith", "(219) 555-0202").status_code == 201
    # Same number, different name: a wife on the family landline.
    assert add(client, "Dana Smith", "(219) 555-0101").status_code == 201
    # Same name, no number on either -- unlikely, but the app cannot prove it
    # is the same person and refusing would leave nowhere to go.
    assert add(client, "Pat Nowak").status_code == 201
    assert add(client, "Pat Nowak").status_code == 201
    assert len(client.get("/api/customers").json()) == 5


def test_a_duplicate_cannot_hide_behind_a_duplicate(client):
    """The shop this guard is for already has people on file twice, and the
    second copy is usually the thinner one -- a name typed in a hurry with no
    number on it.

    Answering with only the newest record then hands back the copy that has no
    phone, the save finds no number to object to, and writes a third. The
    match has to prefer the record that agrees on both keys.
    """
    real = add(client, "Iris Chandler", "(313) 555-0304").json()
    thin = add(client, "iris chandler").json()  # same name, no number: allowed
    assert thin["id"] != real["id"]

    found = match(client, name="IRIS CHANDLER", phone="313.555.0304")["name"]
    assert found["customer_id"] == real["id"], "the match should be the record that has the number"
    assert add(client, "IRIS CHANDLER", "313.555.0304").status_code == 409
    assert len(client.get("/api/customers").json()) == 2


def test_a_match_is_found_by_name_and_by_number_separately(client):
    created = add(client, "Marcus Doyle", "(313) 555-0303").json()

    by_name = match(client, name="marcus doyle")
    assert by_name["name"]["customer_id"] == created["id"]
    assert by_name["phone"] is None

    by_phone = match(client, phone="3135550303")
    assert by_phone["phone"]["customer_id"] == created["id"]
    assert by_phone["name"] is None

    both = match(client, name="Marcus Doyle", phone="(313) 555-0303")
    assert both["name"]["customer_id"] == both["phone"]["customer_id"] == created["id"]


def test_a_stranger_matches_nothing(client):
    add(client, "Marcus Doyle", "(313) 555-0303")
    assert match(client, name="Nobody Here", phone="(219) 555-9999") == {"name": None, "phone": None}
    # An empty ask is not a match on everybody.
    assert match(client) == {"name": None, "phone": None}


def test_a_match_carries_what_makes_it_recognisable(client):
    """The note under the field has to say enough for the advisor to be sure
    it is the right person before clicking Use Them. A bare name is not
    enough on "John Smith"."""
    customer = add(client, "Renata Silva", "(313) 555-0302").json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2019, "make": "Honda", "model": "Civic", "mileage": 60000},
    ).json()
    client.post(
        "/api/we-owe",
        json={
            "customer_id": customer["id"],
            "vehicle_id": vehicle["id"],
            "description": "Replace missing passenger mirror",
            "category": "mirror",
        },
    )

    found = match(client, name="Renata Silva")["name"]
    assert found["name"] == "Renata Silva"
    assert found["phone"] == "(313) 555-0302"
    assert found["vehicle_count"] == 1
    assert found["open_promises"] == 1


def test_the_shop_owned_recon_customer_is_never_offered(client):
    """Recon inventory hangs off a shop-owned sentinel customer. It is hidden
    from the customer list and 404s from the detail route, and it must not
    surface here either -- it is not a person anyone is typing in."""
    from app.db import RECON_SHOP_CUSTOMER_ID

    sentinel = client.get(f"/api/customers/{RECON_SHOP_CUSTOMER_ID}")
    assert sentinel.status_code == 404
    name = client.get("/api/customers/match", params={"name": ""}).json()
    assert name == {"name": None, "phone": None}


def test_archived_promises_do_not_count_as_still_owed(client):
    """A promise filed to History is not something still owed, so the note
    must not offer it as a reason to think this is the person -- the Customers
    screen counts it the same way."""
    customer = add(client, "Tyrell Banks", "(219) 555-0150").json()
    vehicle = client.post(
        "/api/vehicles",
        json={"customer_id": customer["id"], "year": 2016, "make": "Ford", "model": "Fusion", "mileage": 90000},
    ).json()
    promise = client.post(
        "/api/we-owe",
        json={
            "customer_id": customer["id"],
            "vehicle_id": vehicle["id"],
            "description": "Tie rod",
            "category": "other",
        },
    ).json()
    assert match(client, name="Tyrell Banks")["name"]["open_promises"] == 1

    assert client.post(f"/api/we-owe/{promise['id']}/archive", json={}).status_code == 200
    assert match(client, name="Tyrell Banks")["name"]["open_promises"] == 0
