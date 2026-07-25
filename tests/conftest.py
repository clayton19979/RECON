from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def db_path(tmp_path):
    """Where the `client` fixture's database lives. Exposed as its own fixture
    so a test that needs to arrange state the API can't express -- backdating a
    timestamp to simulate a car nobody has touched for a month, say -- can open
    the same file the app is using instead of faking the clock."""
    return tmp_path / "test.db"


@pytest.fixture
def client(db_path, tmp_path):
    app = create_app(db_path, backups_dir=tmp_path / "backups")
    return TestClient(app)
