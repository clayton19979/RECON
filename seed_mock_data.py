"""Seeds data/shop.db with a realistic mock dataset for local testing.

Any existing database (and its WAL/SHM sidecar files) is moved aside to
data/shop.db*.pre-mock-seed.bak rather than deleted, then every record is
created by driving the real API (FastAPI's TestClient) so it goes through
the same validation and business logic a real request would -- order
numbering, workflow initialization, cost rollups, etc.

Run with:
    uv run python seed_mock_data.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient

from app.db import init_db
from app.main import DEFAULT_DB, app


def reset_db() -> None:
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(DEFAULT_DB) + suffix)
        if src.is_file():
            shutil.move(str(src), str(src) + ".pre-mock-seed.bak")
    init_db(DEFAULT_DB)


def post(client: TestClient, path: str, json: dict, expect: int = 201) -> dict:
    res = client.post(path, json=json)
    assert res.status_code == expect, f"{path} -> {res.status_code}: {res.text}"
    return res.json()


def patch(client: TestClient, path: str, json: dict, expect: int = 200) -> dict:
    res = client.patch(path, json=json)
    assert res.status_code == expect, f"{path} -> {res.status_code}: {res.text}"
    return res.json()


def put(client: TestClient, path: str, json: dict, expect: int = 200) -> dict:
    res = client.put(path, json=json)
    assert res.status_code == expect, f"{path} -> {res.status_code}: {res.text}"
    return res.json()


def customer_and_vehicle(client: TestClient, name: str, phone: str, email: str, **vehicle) -> tuple[dict, dict]:
    customer = post(client, "/api/customers", {"name": name, "phone": phone, "email": email})
    vehicle_payload = {"customer_id": customer["id"], "plate": "", "plate_state": "", "trim": "", "engine": "", "color": ""}
    vehicle_payload.update(vehicle)
    vehicle_row = post(client, "/api/vehicles", vehicle_payload)
    return customer, vehicle_row


def retail_order(client: TestClient, customer: dict, vehicle: dict, concern: str) -> dict:
    return post(client, "/api/orders", {
        "customer_id": customer["id"], "vehicle_id": vehicle["id"], "concern": concern, "segment": "retail",
    })


def save_estimate(client: TestClient, order_id: int, items: list[dict], labor_rate=125.0, tax_rate=0.0825, actor="advisor") -> dict:
    return post(client, f"/api/orders/{order_id}/estimate", {
        "labor_rate": labor_rate, "tax_rate": tax_rate, "actor": actor, "items": items,
    }, expect=200)


def assign(client: TestClient, order_id: int, advisor_id: int | None, technician_id: int | None, date_in: str, odometer_in: int, promised_at: str = "") -> None:
    put(client, f"/api/orders/{order_id}/assignment", {
        "advisor_id": advisor_id, "technician_id": technician_id, "date_in": date_in,
        "odometer_in": odometer_in, "promised_at": promised_at, "actor": "advisor",
    })


def note(client: TestClient, order_id: int, text: str, visibility: str = "internal", actor: str = "advisor") -> None:
    post(client, f"/api/orders/{order_id}/notes", {"visibility": visibility, "text": text, "actor": actor})


def authorize(client: TestClient, order_id: int, status: str, approved_by: str, method: str = "phone") -> None:
    post(client, f"/api/orders/{order_id}/authorization", {
        "status": status, "approved_by": approved_by, "method": method, "actor": "advisor",
    })


def set_status(client: TestClient, order_id: int, status: str) -> None:
    patch(client, f"/api/orders/{order_id}/status", {"status": status, "actor": "advisor"})


def main() -> None:
    print(f"Resetting database at {DEFAULT_DB} ...")
    reset_db()
    client = TestClient(app)

    print("Creating staff ...")
    dana = post(client, "/api/staff", {"name": "Dana Whitfield", "role": "advisor"})
    marcus = post(client, "/api/staff", {"name": "Marcus Webb", "role": "advisor"})
    ray = post(client, "/api/staff", {"name": "Ray Ortiz", "role": "technician"})
    priya = post(client, "/api/staff", {"name": "Priya Nair", "role": "technician"})
    sam = post(client, "/api/staff", {"name": "Sam Klein", "role": "technician"})
    lou = post(client, "/api/staff", {"name": "Lou Grant", "role": "manager"})

    print("Building retail repair orders ...")

    # 1. Fresh estimate, nothing decided yet.
    cust, veh = customer_and_vehicle(client, "Maria Alvarez", "555-0101", "maria.alvarez@example.com",
                                      year=2017, make="Toyota", model="Camry", vin="4T1BF1FK5HU123456", mileage=78000)
    o1 = retail_order(client, cust, veh, "Check engine light, rough idle at stop")
    save_estimate(client, o1["id"], [
        {"kind": "part", "description": "Ignition coil", "quantity": 4, "unit_price": 62.0, "unit_cost": 38.0, "part_number": "UF-400"},
        {"kind": "labor", "description": "Diagnose + replace coils", "quantity": 1.5, "unit_price": 125.0},
    ])
    assign(client, o1["id"], dana["id"], ray["id"], "2026-07-20", 78000)
    note(client, o1["id"], "Customer waiting on a callback before approving.", actor="Dana Whitfield")

    # 2. Estimate sent, waiting on customer decision.
    cust, veh = customer_and_vehicle(client, "Tyrell Banks", "555-0102", "tyrell.banks@example.com",
                                      year=2020, make="Chevrolet", model="Equinox", vin="3GNAXKEV4LS123456", mileage=41250)
    o2 = retail_order(client, cust, veh, "Front brakes squealing")
    save_estimate(client, o2["id"], [
        {"kind": "part", "description": "Front brake pads", "quantity": 1, "unit_price": 89.0, "unit_cost": 52.0, "part_number": "BP-2201"},
        {"kind": "part", "description": "Front rotors (pair)", "quantity": 1, "unit_price": 145.0, "unit_cost": 96.0, "part_number": "RT-1188"},
        {"kind": "labor", "description": "Front brake service", "quantity": 1.2, "unit_price": 125.0},
    ])
    assign(client, o2["id"], marcus["id"], priya["id"], "2026-07-22", 41250, promised_at="2026-07-24")
    set_status(client, o2["id"], "pending_approval")

    # 3. Approved and in progress, parts already ordered.
    cust, veh = customer_and_vehicle(client, "Janelle Osei", "555-0103", "janelle.osei@example.com",
                                      year=2019, make="Honda", model="CR-V", vin="5J6RW2H86KL123456", mileage=55400)
    o3 = retail_order(client, cust, veh, "AC blows warm, whining noise from belt area")
    save_estimate(client, o3["id"], [
        {"kind": "part", "description": "AC compressor", "quantity": 1, "unit_price": 410.0, "unit_cost": 265.0, "part_number": "AC-7734", "core_charge": 75.0},
        {"kind": "part", "description": "Serpentine belt", "quantity": 1, "unit_price": 28.0, "unit_cost": 14.0, "part_number": "SB-118"},
        {"kind": "labor", "description": "Replace compressor + belt, evacuate/recharge system", "quantity": 3.0, "unit_price": 125.0},
    ])
    assign(client, o3["id"], dana["id"], ray["id"], "2026-07-21", 55400)
    authorize(client, o3["id"], "approved", approved_by="Janelle Osei", method="phone")
    set_status(client, o3["id"], "in_progress")
    patch(client, f"/api/orders/{o3['id']}/estimate/order-parts", {})
    note(client, o3["id"], "Compressor and belt on order, ETA tomorrow.", actor="Ray Ortiz")

    # 4. Complete and paid in full.
    cust, veh = customer_and_vehicle(client, "Devon Marsh", "555-0104", "devon.marsh@example.com",
                                      year=2016, make="Ford", model="F-150", vin="1FTEW1EG5GKE12345", mileage=112300)
    o4 = retail_order(client, cust, veh, "Oil change + tire rotation, 112k service")
    save_estimate(client, o4["id"], [
        {"kind": "part", "description": "Full synthetic oil (6 qt)", "quantity": 6, "unit_price": 9.5, "unit_cost": 5.75, "part_number": "OIL-5W30"},
        {"kind": "part", "description": "Oil filter", "quantity": 1, "unit_price": 12.0, "unit_cost": 6.0, "part_number": "OF-820"},
        {"kind": "labor", "description": "Oil change, tire rotation, multi-point inspection", "quantity": 0.8, "unit_price": 125.0},
    ])
    assign(client, o4["id"], marcus["id"], sam["id"], "2026-07-18", 112300)
    authorize(client, o4["id"], "approved", approved_by="Devon Marsh", method="in_person")
    set_status(client, o4["id"], "in_progress")
    set_status(client, o4["id"], "complete")
    invoice = post(client, f"/api/orders/{o4['id']}/invoice", {"actor": "advisor"})
    post(client, f"/api/invoices/{invoice['id']}/payments", {"amount": invoice["total"], "method": "card", "actor": "advisor"})

    # 5. Complete, invoiced, only partially paid.
    cust, veh = customer_and_vehicle(client, "Whitney Cole", "555-0105", "whitney.cole@example.com",
                                      year=2015, make="Subaru", model="Outback", vin="4S4BSANC5F3123456", mileage=98700)
    o5 = retail_order(client, cust, veh, "Head gasket replacement")
    save_estimate(client, o5["id"], [
        {"kind": "part", "description": "Head gasket set", "quantity": 1, "unit_price": 320.0, "unit_cost": 210.0, "part_number": "HG-3355"},
        {"kind": "labor", "description": "Remove/replace heads, gasket set, coolant flush", "quantity": 9.5, "unit_price": 125.0},
    ])
    assign(client, o5["id"], dana["id"], priya["id"], "2026-07-10", 98700)
    authorize(client, o5["id"], "approved", approved_by="Whitney Cole", method="email")
    set_status(client, o5["id"], "in_progress")
    set_status(client, o5["id"], "complete")
    invoice5 = post(client, f"/api/orders/{o5['id']}/invoice", {"actor": "advisor"})
    post(client, f"/api/invoices/{invoice5['id']}/payments", {"amount": round(invoice5["total"] / 2, 2), "method": "cash", "actor": "advisor"})

    # 6. Voided (customer backed out before any work started).
    cust, veh = customer_and_vehicle(client, "Ken Ibarra", "555-0106", "ken.ibarra@example.com",
                                      year=2012, make="Nissan", model="Altima", vin="1N4AL2AP7CN123456", mileage=143200)
    o6 = retail_order(client, cust, veh, "Transmission slipping")
    save_estimate(client, o6["id"], [
        {"kind": "labor", "description": "Transmission diagnostic", "quantity": 1.0, "unit_price": 125.0},
    ])
    post(client, f"/api/orders/{o6['id']}/void", {"actor": "advisor"}, expect=200)

    # 7. Technician found extra issues -- draft lines waiting on advisor review.
    cust, veh = customer_and_vehicle(client, "Priscilla Wong", "555-0107", "priscilla.wong@example.com",
                                      year=2021, make="Mazda", model="CX-5", vin="JM3KFBCM5M0123456", mileage=22100)
    o7 = retail_order(client, cust, veh, "Squeaking noise over bumps")
    save_estimate(client, o7["id"], [
        {"kind": "labor", "description": "Suspension inspection", "quantity": 0.5, "unit_price": 125.0},
    ])
    assign(client, o7["id"], marcus["id"], sam["id"], "2026-07-23", 22100)
    post(client, f"/api/orders/{o7['id']}/findings", {
        "summary": "Front sway bar end links worn on both sides, also noted a slow leak at the front-left strut.",
        "actor": "Sam Klein",
        "items": [
            {"kind": "part", "description": "Sway bar end links (pair)", "quantity": 1, "unit_price": 58.0, "unit_cost": 34.0, "part_number": "SB-EL-220"},
            {"kind": "part", "description": "Front-left strut assembly", "quantity": 1, "unit_price": 210.0, "unit_cost": 138.0, "part_number": "ST-9910"},
            {"kind": "labor", "description": "Replace end links + strut", "quantity": 1.8, "unit_price": 125.0},
        ],
    })

    print("Building recon vehicles ...")

    # Fresh acquisition, nothing started.
    r1 = post(client, "/api/recon/vehicles", {
        "stock_number": "R-1001", "year": 2018, "make": "Kia", "model": "Sorento", "vin": "5XYPGDA31JG123456",
        "mileage": 71200, "acquisition_source": "trade-in", "acquisition_date": "2026-07-22", "purchase_price": 5200,
        "notes": "Traded in on a new Sportage. Needs a full detail and PDI before it goes to recon.",
    })

    # In repair.
    r2 = post(client, "/api/recon/vehicles", {
        "stock_number": "R-1002", "year": 2017, "make": "Hyundai", "model": "Elantra", "vin": "5NPD84LF0HH123456",
        "mileage": 84500, "acquisition_source": "auction", "acquisition_date": "2026-07-10", "purchase_price": 3100,
        "notes": "Auction buy, needs brakes and a windshield.",
    })
    ro_r2 = post(client, "/api/orders", {"concern": "Recon prep: brakes, windshield, detail", "segment": "recon", "recon_vehicle_id": r2["id"]})
    save_estimate(client, ro_r2["id"], [
        {"kind": "part", "description": "Windshield", "quantity": 1, "unit_price": 0, "unit_cost": 180.0, "part_number": "WS-4471"},
        {"kind": "part", "description": "Brake pads + rotors, all 4", "quantity": 1, "unit_price": 0, "unit_cost": 240.0, "part_number": "BR-KIT-90"},
        {"kind": "labor", "description": "Install windshield, full brake job, detail", "quantity": 4.5, "unit_price": 0},
    ], labor_rate=0.0)
    # Parts are on order and haven't landed, which is why this car is still
    # sitting -- the board's Parts column and its "Waiting on parts" card
    # exist for exactly this state, and until now no lot vehicle in the seed
    # data was ever in it (the only ordered parts were on a retail ticket,
    # which has no recon or we-owe vehicle and so never reaches the board).
    patch(client, f"/api/orders/{ro_r2['id']}/estimate/order-parts", {})
    patch(client, f"/api/recon/vehicles/{r2['id']}", {"status": "in_repair"})
    assign(client, ro_r2["id"], dana["id"], ray["id"], "2026-07-11", 84500)

    # Ready for the lot.
    r3 = post(client, "/api/recon/vehicles", {
        "stock_number": "R-0997", "year": 2016, "make": "Ford", "model": "Fusion", "vin": "3FA6P0H70GR123456",
        "mileage": 92000, "acquisition_source": "auction", "acquisition_date": "2026-06-28", "purchase_price": 2800,
        "notes": "Recon complete, priced and ready to list.",
    })
    ro_r3 = post(client, "/api/orders", {"concern": "Recon prep: full service, tires", "segment": "recon", "recon_vehicle_id": r3["id"]})
    save_estimate(client, ro_r3["id"], [
        {"kind": "part", "description": "Tires (set of 4)", "quantity": 1, "unit_price": 0, "unit_cost": 380.0, "part_number": "TR-SET-16"},
        {"kind": "labor", "description": "Full service + tire install", "quantity": 3.0, "unit_price": 0},
    ], labor_rate=0.0)
    set_status(client, ro_r3["id"], "in_progress")
    set_status(client, ro_r3["id"], "complete")
    patch(client, f"/api/recon/vehicles/{r3['id']}", {"status": "ready"})

    # Sold.
    r4 = post(client, "/api/recon/vehicles", {
        "stock_number": "R-0981", "year": 2015, "make": "Chevrolet", "model": "Malibu", "vin": "1G11C5SL2FF123456",
        "mileage": 101500, "acquisition_source": "auction", "acquisition_date": "2026-06-05", "purchase_price": 2400,
        "notes": "Sold off the lot.",
    })
    buyer, _ = customer_and_vehicle(client, "Ashley Pratt", "555-0210", "ashley.pratt@example.com",
                                     year=2015, make="Chevrolet", model="Malibu")
    patch(client, f"/api/recon/vehicles/{r4['id']}", {
        "status": "sold", "sale_price": 6995.0, "sale_date": "2026-07-15", "sale_customer_id": buyer["id"],
    })

    # Older, archived to History.
    r5 = post(client, "/api/recon/vehicles", {
        "stock_number": "R-0940", "year": 2014, "make": "Jeep", "model": "Patriot", "vin": "1C4NJRFB8ED123456",
        "mileage": 118000, "acquisition_source": "trade-in", "acquisition_date": "2026-04-02", "purchase_price": 1900,
        "notes": "Sold and closed out weeks ago.",
    })
    patch(client, f"/api/recon/vehicles/{r5['id']}", {"status": "sold", "sale_price": 4500.0, "sale_date": "2026-04-20"})
    post(client, f"/api/recon/vehicles/{r5['id']}/archive", {}, expect=200)

    print("Building we-owe items ...")

    cust, veh = customer_and_vehicle(client, "Jordan Whitfield", "555-0301", "jordan.whitfield@example.com",
                                      year=2020, make="Kia", model="Soul", vin="KNDJP3A50L7123456", mileage=31000)
    we1 = post(client, "/api/we-owe", {
        "customer_id": cust["id"], "vehicle_id": veh["id"], "description": "Install aftermarket running boards (customer supplied)",
        "category": "accessory", "target_date": "2026-08-01",
    })
    # The only we-owe in the seed with a live ticket behind it, so the board's
    # we-owe half isn't uniformly $0 with an empty status. Its bracket kit is
    # on order and hasn't arrived -- the promise the customer is waiting on is
    # waiting on a vendor, which is the whole point of the Parts column.
    ro_we1 = post(client, "/api/orders", {
        "concern": "Install running boards (customer-supplied)", "segment": "we_owe", "we_owe_id": we1["id"],
    })
    save_estimate(client, ro_we1["id"], [
        {"kind": "part", "description": "Mounting bracket kit", "quantity": 1, "unit_price": 0, "unit_cost": 95.0, "part_number": "RB-BRK-20"},
        {"kind": "labor", "description": "Install running boards", "quantity": 1.5, "unit_price": 0},
    ], labor_rate=0.0)
    patch(client, f"/api/orders/{ro_we1['id']}/estimate/order-parts", {})
    set_status(client, ro_we1["id"], "in_progress")

    cust, veh = customer_and_vehicle(client, "Renata Silva", "555-0302", "renata.silva@example.com",
                                      year=2019, make="Toyota", model="RAV4", vin="2T3P1RFV0KW123456", mileage=48200)
    we2 = post(client, "/api/we-owe", {
        "customer_id": cust["id"], "vehicle_id": veh["id"], "description": "Touch up paint on rear bumper from sale prep",
        "category": "cosmetic", "target_date": "2026-07-30",
    })
    post(client, f"/api/we-owe/{we2['id']}/payments", {"amount": 50.0, "method": "cash", "note": "Deposit toward outside body shop cost", "actor": "advisor"})

    cust, veh = customer_and_vehicle(client, "Marcus Doyle", "555-0303", "marcus.doyle@example.com",
                                      year=2018, make="Honda", model="Accord", vin="1HGCV1F34JA123456", mileage=52300)
    we3 = post(client, "/api/we-owe", {
        "customer_id": cust["id"], "vehicle_id": veh["id"], "description": "Second key fob",
        "category": "accessory", "target_date": "2026-07-05",
    })
    patch(client, f"/api/we-owe/{we3['id']}", {"status": "fulfilled"})

    cust, veh = customer_and_vehicle(client, "Iris Chandler", "555-0304", "iris.chandler@example.com",
                                      year=2017, make="Jeep", model="Cherokee", vin="1C4PJLDB4HW123456", mileage=67800)
    we4 = post(client, "/api/we-owe", {
        "customer_id": cust["id"], "vehicle_id": veh["id"], "description": "Repair minor dent, customer decided not to pursue",
        "category": "cosmetic", "target_date": "2026-06-15",
    })
    patch(client, f"/api/we-owe/{we4['id']}", {"status": "waived"})

    print("Building tasks and suggestions ...")

    post(client, "/api/tasks", {
        "title": "Call Maria Alvarez about coil estimate", "notes": "Left a voicemail Tuesday, try again.",
        "assigned_to": ["Dana Whitfield"], "due_date": "2026-07-23", "urgent": True, "order_id": o1["id"], "actor": "ui",
    })
    post(client, "/api/tasks", {
        "title": "Follow up with parts vendor on AC compressor ETA", "assigned_to": ["Ray Ortiz"],
        "due_date": "2026-07-25", "urgent": False, "order_id": o3["id"], "actor": "ui",
    })
    done_task = post(client, "/api/tasks", {
        "title": "Order shop towels and gloves", "assigned_to": ["Lou Grant"], "urgent": False, "actor": "ui",
    })
    patch(client, f"/api/tasks/{done_task['id']}", {"done": True})
    post(client, "/api/tasks", {
        "title": "Restock brake cleaner", "assigned_to": [], "due_date": "2026-07-26", "urgent": False, "actor": "ui",
    })

    post(client, "/api/suggestions", {"text": "Add a text-message reminder the day before a promised pickup date.", "author": "Dana Whitfield"})
    resolved = post(client, "/api/suggestions", {"text": "Let us print a work order without pricing for the technician copy.", "author": "Ray Ortiz"})
    patch(client, f"/api/suggestions/{resolved['id']}", {"resolved": True})

    print("\nDone. Seeded:")
    print("  7 retail repair orders across every status (estimate, pending approval,")
    print("    in progress, complete + paid, complete + partial, voided, needs review)")
    print("  5 recon vehicles (acquired, in repair, ready, sold, archived/sold)")
    print("  4 we-owe items (open, open + deposit, fulfilled, waived)")
    print("  4 tasks (1 urgent, 1 done, 2 open) and 2 suggestions (1 resolved)")
    print("  6 staff members (2 advisors, 3 technicians, 1 manager)")
    print(f"\nOld database backed up alongside {DEFAULT_DB} as *.pre-mock-seed.bak")
    print("Start the app and open http://127.0.0.1:8000 to see it.")


if __name__ == "__main__":
    main()
