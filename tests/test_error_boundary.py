"""What the app is allowed to shout about.

The global handler turns anything reaching window.onerror into a red toast.
That is right for a real fault and wrong for browser housekeeping, and it was
doing both -- the shop got "Something went wrong: ResizeObserver loop
completed with undelivered notifications" for something that is neither wrong
nor theirs. A warning that cries wolf is worse than none, because the next one
is the one that gets ignored.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BOUNDARY = (REPO / "static" / "js" / "error-boundary.js").read_text(encoding="utf-8")


def test_resize_observer_notices_are_not_shown_as_faults():
    assert "BENIGN_ERRORS" in BOUNDARY, "the global error handler no longer filters anything"
    patterns = re.search(r"const BENIGN_ERRORS = \[(.*?)\];", BOUNDARY, re.DOTALL)
    assert patterns, "BENIGN_ERRORS is no longer a list of patterns"
    assert "ResizeObserver" in patterns.group(1)

    report = re.search(r"const report = \((.*?)\n  \};", BOUNDARY, re.DOTALL)
    assert report, "the report helper is gone"
    assert "BENIGN_ERRORS.some" in report.group(1), "the filter exists but nothing consults it"


def test_the_filter_runs_before_anything_is_shown_or_logged():
    """Returning after the toast, or after console.error, would leave the noise
    on screen or in the log it was meant to stay out of."""
    report = re.search(r"const report = \((.*?)\n  \};", BOUNDARY, re.DOTALL).group(1)
    guard = report.index("BENIGN_ERRORS.some")
    assert guard < report.index("console.error"), "the notice is logged before being filtered"
    assert guard < report.index("toast("), "the notice is toasted before being filtered"


def test_the_concern_box_resizes_outside_the_observer_callback():
    """The cause, not just the symptom: measuring and setting a height inside
    the resize callback is what makes the browser emit the loop notice at all."""
    detail = (REPO / "static" / "js" / "vehicle-detail.js").read_text(encoding="utf-8")
    observer = re.search(r"new ResizeObserver\((.*?)\)\.observe\(concernStrip\);", detail, re.DOTALL)
    assert observer, "the concern strip's ResizeObserver is gone"
    body = observer.group(1)
    assert "requestAnimationFrame" in body, "sizeConcernBox still runs inside the observer callback"
    assert re.search(r"requestAnimationFrame\(\(\) => \{[^}]*sizeConcernBox\(\);", body), (
        "the resize is not the thing deferred to the next frame"
    )
