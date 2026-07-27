"""The role config is what stops two PCs from each starting their own
database, so its failure modes matter more than its happy path."""
from __future__ import annotations

import json

import pytest

from app import deployment


def test_missing_config_defaults_to_master(tmp_path):
    """A lone PC with no config must still work standalone. Defaulting to
    client would leave it hunting for a server that does not exist."""
    loaded = deployment.load(tmp_path)
    assert loaded["role"] == deployment.MASTER
    assert loaded["configured"] is False


def test_saved_role_round_trips(tmp_path):
    deployment.save(deployment.CLIENT, master_host="192.168.1.50", data_root=tmp_path)
    loaded = deployment.load(tmp_path)
    assert loaded == {"role": deployment.CLIENT, "master_host": "192.168.1.50", "configured": True}


def test_client_without_a_pinned_host_is_allowed(tmp_path):
    """Discovery finds it at runtime; the installer need not know the IP."""
    deployment.save(deployment.CLIENT, data_root=tmp_path)
    loaded = deployment.load(tmp_path)
    assert loaded["role"] == deployment.CLIENT
    assert loaded["master_host"] is None


def test_corrupt_config_falls_back_to_master_instead_of_crashing(tmp_path):
    deployment.config_path(tmp_path).write_text("{not json", encoding="utf-8")
    loaded = deployment.load(tmp_path)
    assert loaded["role"] == deployment.MASTER
    assert loaded["configured"] is False


def test_unknown_role_falls_back_to_master(tmp_path):
    deployment.config_path(tmp_path).write_text(json.dumps({"role": "peer"}), encoding="utf-8")
    assert deployment.load(tmp_path)["role"] == deployment.MASTER


def test_role_is_case_and_space_insensitive(tmp_path):
    """The installer writes this file; be forgiving about what it writes."""
    deployment.config_path(tmp_path).write_text(json.dumps({"role": "  Client "}), encoding="utf-8")
    assert deployment.load(tmp_path)["role"] == deployment.CLIENT


def test_save_rejects_a_role_that_is_neither(tmp_path):
    with pytest.raises(ValueError):
        deployment.save("both", data_root=tmp_path)


def test_save_creates_the_directory(tmp_path):
    nested = tmp_path / "does" / "not" / "exist"
    deployment.save(deployment.MASTER, data_root=nested)
    assert deployment.config_path(nested).is_file()


def test_is_master_helper(tmp_path):
    deployment.save(deployment.MASTER, data_root=tmp_path)
    assert deployment.is_master(tmp_path) is True
    deployment.save(deployment.CLIENT, data_root=tmp_path)
    assert deployment.is_master(tmp_path) is False
