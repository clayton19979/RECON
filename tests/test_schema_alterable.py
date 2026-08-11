"""The schema a fresh database stores must stay ALTER-able.

SQLite's ALTER TABLE DROP COLUMN works by editing the CREATE TABLE text kept
in sqlite_master, and that edit is not comment-aware: dropping a table's last
column scans backwards for the separating comma and will take one found inside
a comment, leaving schema text that ends mid-comment ("incomplete input").
SCHEMA in app/db.py is full of prose comments -- deliberately, they carry the
why of every odd column -- so init_db strips them from what it executes and
the file keeps them for people.

This matters because the migration tests simulate an older database the only
honest way: build a fresh one, DROP the new columns, and start the app on it
again. Before the stripping, six tables had columns that could never be
dropped, so that whole style of test was quietly impossible to write for them.
"""

from __future__ import annotations

import sqlite3

from app.db import SCHEMA, connect, init_db, strip_sql_comments


def test_stored_schema_carries_no_comments(tmp_path):
    """Nothing in sqlite_master should have anything left to strip."""
    db_path = tmp_path / "fresh.db"
    init_db(db_path)
    with connect(db_path) as db:
        for name, sql in db.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL"):
            assert strip_sql_comments(sql) == sql, f"{name} stored a comment"


def test_every_table_survives_dropping_columns_from_the_end(tmp_path):
    """Peel columns off the end of every table the way an old-database
    simulation would, and demand SQLite either does it or refuses for a real
    reason (the column is UNIQUE, indexed, or a trigger reads it). The one
    outcome that must never appear is "incomplete input" -- the corrupted
    rewrite that comments used to cause."""
    db_path = tmp_path / "fresh.db"
    init_db(db_path)
    with connect(db_path) as db:
        tables = [
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        ]
    assert tables

    for table in tables:
        # A fresh file per table: each one gets peeled from the full schema.
        peel_path = tmp_path / f"peel_{table}.db"
        init_db(peel_path)
        with connect(peel_path) as db:
            while True:
                columns = [row[1] for row in db.execute(f"PRAGMA table_info({table})")]
                if len(columns) <= 1:
                    break
                last = columns[-1]
                try:
                    db.execute(f'ALTER TABLE {table} DROP COLUMN "{last}"')
                except sqlite3.OperationalError as err:
                    assert "incomplete input" not in str(err), (
                        f"dropping {table}.{last} corrupted the schema rewrite: {err}"
                    )
                    break


def test_strip_sql_comments_removes_comments_only():
    stripped = strip_sql_comments(
        "CREATE TABLE t (\n"
        "  a TEXT NOT NULL, -- first, with a comma\n"
        "  /* block, also with a comma */\n"
        "  b TEXT NOT NULL DEFAULT ''\n"
        ")"
    )
    assert "comma" not in stripped
    assert "--" not in stripped and "/*" not in stripped
    sqlite3.connect(":memory:").execute(stripped)


def test_strip_sql_comments_leaves_string_literals_alone():
    # Comment markers inside literals are data, not comments, and a doubled
    # quote is SQL's escape -- the literal keeps going.
    sql = "SELECT '--not a comment', '/*nor this*/', 'it''s -- quoted', \"a--b\""
    assert strip_sql_comments(sql) == sql


def test_the_live_schema_actually_needed_stripping():
    """If SCHEMA ever stops containing comments this whole arrangement is
    dead code, and whoever removed them should hear about it from a test
    rather than leave the stripper looking load-bearing."""
    assert strip_sql_comments(SCHEMA) != SCHEMA
