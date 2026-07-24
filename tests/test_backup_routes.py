from __future__ import annotations


def test_list_backups_empty_initially(client):
    assert client.get("/api/backup").json() == []


def test_run_backup_creates_and_lists_a_backup(client):
    created = client.post("/api/backup/run").json()
    assert created["name"].startswith("discount-auto-ops-")
    assert created["size_bytes"] > 0

    listed = client.get("/api/backup").json()
    assert [b["name"] for b in listed] == [created["name"]]


def test_download_backup_returns_the_file(client):
    created = client.post("/api/backup/run").json()
    res = client.get(f"/api/backup/download/{created['name']}")
    assert res.status_code == 200
    assert res.content[:16] == b"SQLite format 3\x00"


def test_download_unknown_backup_is_404(client):
    assert client.get("/api/backup/download/../../whatever.db").status_code == 404
    assert client.get("/api/backup/download/not-a-real-backup.db").status_code == 404


def test_restore_existing_backup_reverts_later_changes(client):
    client.post("/api/tasks", json={"title": "Original task"})
    backup = client.post("/api/backup/run").json()

    client.post("/api/tasks", json={"title": "Added after backup"})
    assert {t["title"] for t in client.get("/api/tasks").json()} == {"Original task", "Added after backup"}

    res = client.post(f"/api/backup/restore/{backup['name']}")
    assert res.status_code == 200
    assert res.json()["restored_from"] == backup["name"]

    assert {t["title"] for t in client.get("/api/tasks").json()} == {"Original task"}


def test_restore_unknown_backup_is_404(client):
    assert client.post("/api/backup/restore/not-a-real-backup.db").status_code == 404


def test_delete_backup_removes_it_from_the_list(client, tmp_path):
    keep = client.post("/api/backup/run").json()
    # A second real backup_database() call could collide on the same
    # second-resolution timestamp as `keep` -- planting a fake second
    # backup file directly (same trick the other backup tests use) keeps
    # this deterministic instead of racing the clock.
    doomed_name = "discount-auto-ops-20260101T000000Z.db"
    (tmp_path / "backups" / doomed_name).write_bytes(b"fake")

    res = client.delete(f"/api/backup/{doomed_name}")
    assert res.status_code == 200
    assert res.json()["deleted"] == doomed_name

    remaining = [b["name"] for b in client.get("/api/backup").json()]
    assert remaining == [keep["name"]]


def test_delete_unknown_backup_is_404(client):
    assert client.delete("/api/backup/not-a-real-backup.db").status_code == 404


def test_delete_backup_path_traversal_is_404(client):
    assert client.delete("/api/backup/../../whatever.db").status_code == 404


def test_restore_upload_reverts_to_the_uploaded_state(client):
    client.post("/api/tasks", json={"title": "Before the fresh install"})
    backup = client.post("/api/backup/run").json()
    uploaded_bytes = client.get(f"/api/backup/download/{backup['name']}").content

    client.post("/api/tasks", json={"title": "Only on this machine"})
    assert len(client.get("/api/tasks").json()) == 2

    res = client.post(
        "/api/backup/restore-upload",
        content=uploaded_bytes,
        headers={"x-backup-filename": "from-usb-stick.db"},
    )
    assert res.status_code == 200
    assert res.json()["restored_from"] == "from-usb-stick.db"

    tasks = client.get("/api/tasks").json()
    assert [t["title"] for t in tasks] == ["Before the fresh install"]


def test_restore_upload_rejects_non_db_filenames(client):
    res = client.post(
        "/api/backup/restore-upload",
        content=b"whatever",
        headers={"x-backup-filename": "not-a-backup.txt"},
    )
    assert res.status_code == 400


def test_restore_upload_rejects_corrupt_upload(client):
    res = client.post(
        "/api/backup/restore-upload",
        content=b"not a real sqlite file",
        headers={"x-backup-filename": "corrupt.db"},
    )
    assert res.status_code == 400
