from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    db_path = tmp_path / "test.db"
    app = create_app(db_path, backups_dir=tmp_path / "backups")
    return TestClient(app)
