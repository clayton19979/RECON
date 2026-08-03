"""The one place RECON's version number is written.

It used to live in two files that had no idea about each other --
`version_info.txt` (what the exe's Properties dialog shows) and `RECON.iss`
(what the installer stamps on the install). Nothing checked they agreed, so
the obvious failure was shipping an installer labelled 1.1.0 that produced an
exe still calling itself 1.0.0 -- and once workstations start deciding whether
they are out of date by comparing version numbers, a stale one stops being
cosmetic and starts meaning "never updates" or "updates forever".

`tests/test_updates.py` asserts this file, `version_info.txt`,
`installers/RECON.iss` and `pyproject.toml` still agree. Note that
`installers/publish_update.ps1` checks only the first three before building --
pyproject is caught by the test suite, not by the publish script.

`uv.lock` carries the number too, but nothing needs to edit it by hand: the
next `uv sync` rewrites it from pyproject. It only shows up as a stray diff if
the version was bumped without one having been run since.
"""

from __future__ import annotations

VERSION = "1.4.0"


def parse(value: str | None) -> tuple[int, ...] | None:
    """A dotted version as comparable integers, or None if it isn't one.

    Tolerates the 4-part Windows form (1.0.0.0) alongside the 3-part one the
    installer uses, and ignores any trailing label, so "1.2.0-beta" still
    compares as 1.2.0 rather than being thrown away entirely.
    """
    if not value:
        return None
    head = str(value).strip().split("-", 1)[0].split("+", 1)[0]
    parts = head.split(".")
    if not parts or len(parts) > 4:
        return None
    try:
        numbers = tuple(int(p) for p in parts)
    except ValueError:
        return None
    # Pad so 1.1 and 1.1.0 compare equal rather than 1.1 sorting first.
    return numbers + (0,) * (4 - len(numbers))


def is_newer(candidate: str | None, current: str | None) -> bool:
    """Whether `candidate` is a version worth upgrading to.

    Unparseable input is never newer. That direction matters: a malformed
    filename in the updates folder should be ignored, not treated as an
    upgrade that every workstation then tries and fails to install.
    """
    left, right = parse(candidate), parse(current)
    if left is None or right is None:
        return False
    return left > right
