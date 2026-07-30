from __future__ import annotations

import ast
from pathlib import Path

from tests.helpers import make_recon_vehicle, make_we_owe

APP = Path(__file__).resolve().parent.parent / "app"

# Every statement that bumps an edit_version counter. Listed explicitly so
# adding a new versioned table is a deliberate decision that lands here too,
# rather than quietly shipping a seventh unguarded write.
BUMP_SITES = 7


def test_every_edit_version_bump_carries_the_version_in_its_own_where_clause():
    """Reading edit_version, comparing it in Python, then writing it back is
    check-then-act, and check-then-act does not prevent lost updates: two
    advisors saving at the same moment both read the same version, both pass the
    comparison, and the second silently replaces the first one's work -- exactly
    the loss the counter exists to prevent. The version has to sit in the WHERE
    clause of the statement that bumps it, so it is evaluated against what is
    actually committed at write time, and rowcount has to be checked to find out
    whether this request won.

    This is a source-shape assertion, in the spirit of the ones in
    test_static_assets, because no black-box request can tell a real
    compare-and-set apart from a check-then-act that simply got lucky: both
    return the same 409 for a stale version when nothing is racing. The
    difference only shows under true concurrency, which is not something to
    reproduce reliably in a test suite -- so the invariant is asserted instead.
    """
    found = 0
    for source in sorted(APP.glob("*.py")):
        text = source.read_text(encoding="utf-8")
        if "edit_version=edit_version+1" not in text:
            continue
        tree = ast.parse(text)
        functions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
        for index, line in enumerate(text.splitlines(), start=1):
            if "edit_version=edit_version+1" not in line:
                continue
            found += 1
            where = f"{source.name}:{index}"
            # The innermost enclosing function, not a line window: the endpoints
            # sit next to each other, and a window wide enough to reach a
            # dynamic-field endpoint's execute() call would also reach its
            # neighbour's guard and pass on borrowed evidence.
            enclosing = [fn for fn in functions if fn.lineno <= index <= (fn.end_lineno or fn.lineno)]
            assert enclosing, f"{where} is not inside a function -- this test cannot vouch for it"
            innermost = min(enclosing, key=lambda fn: (fn.end_lineno or fn.lineno) - fn.lineno)
            body = ast.get_source_segment(text, innermost) or ""

            assert "{guard}" in body or "AND edit_version=?" in body, (
                f"{where} (in {innermost.name}) bumps edit_version without putting the expected version in "
                "the WHERE clause -- two concurrent saves can both pass a Python-side check and the second "
                "will clobber the first"
            )
            assert "assert_version_won" in body or "rowcount" in body, (
                f"{where} (in {innermost.name}) guards the UPDATE but never checks whether it applied -- a "
                "lost race would return 200 and report success while having written nothing"
            )
    assert found == BUMP_SITES, (
        f"expected {BUMP_SITES} edit_version bumps, found {found}. A new one needs the same "
        "compare-and-set treatment; update BUMP_SITES once it has it."
    )


def test_stale_version_leaves_the_shared_vehicle_row_untouched(client):
    """The recon and we-owe patches write the vehicles table before they reach
    the version-guarded UPDATE, so a lost race has to roll those writes back
    with it. They share one connection's transaction, which is what makes
    raising on rowcount==0 safe rather than half-applied."""
    vehicle = make_recon_vehicle(client, stock_number="R-9200")
    current = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()

    res = client.patch(
        f"/api/recon/vehicles/{vehicle['id']}",
        json={"make": "Toyota", "color": "Blue", "expected_version": current["edit_version"] + 5},
    )
    assert res.status_code == 409, res.text

    after = client.get(f"/api/recon/vehicles/{vehicle['id']}").json()
    assert after["make"] == "Honda", "the rejected patch still wrote to the vehicles table"
    assert after["color"] != "Blue"
    assert after["edit_version"] == current["edit_version"]


def test_stale_version_leaves_a_we_owe_items_vehicle_untouched(client):
    item = make_we_owe(client)
    current = client.get(f"/api/we-owe/{item['id']}").json()

    res = client.patch(
        f"/api/we-owe/{item['id']}",
        json={"make": "Hyundai", "description": "Rewritten", "expected_version": current["edit_version"] + 5},
    )
    assert res.status_code == 409, res.text

    after = client.get(f"/api/we-owe/{item['id']}").json()
    assert after["make"] == "Kia", "the rejected patch still wrote to the vehicles table"
    assert after["description"] == current["description"]
    assert after["edit_version"] == current["edit_version"]
