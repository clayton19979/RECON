"""Installing an update without anybody having to rescue it.

Updating used to fail in the middle and need a person: RECON kept running
while Setup tried to replace the exe it was holding open, Setup gave up, and
the only way through was ending the tasks by hand and starting again. When it
did get installed, nothing started RECON back up.

These are the properties that stop that happening, asserted where they can be
-- the install itself can only really be proved on a shop PC.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ISS = (REPO / "installers" / "RECON.iss").read_text(encoding="utf-8")


def _setup_section() -> str:
    """Just [Setup] -- a directive means nothing in the wrong section."""
    match = re.search(r"^\[Setup\](.*?)^\[", ISS, re.MULTILINE | re.DOTALL)
    assert match, "RECON.iss no longer has a [Setup] section"
    return match.group(1)


def test_setup_closes_whatever_is_holding_the_exe():
    """The default is to ask the Restart Manager politely, and RECON refuses:
    closing its window hides to the tray so workstations keep working. Setup
    then cannot replace RECON.exe and stops dead."""
    assert re.search(r"^CloseApplications\s*=\s*force", _setup_section(), re.MULTILINE), (
        "without CloseApplications=force, updating over a running RECON needs Task Manager"
    )


def test_setup_does_not_restart_the_app_itself():
    """Restart Manager would bring RECON back with Setup's own elevated token,
    leaving the shop tool running as administrator all day."""
    assert re.search(r"^RestartApplications\s*=\s*no", _setup_section(), re.MULTILINE)


def test_recon_is_relaunched_after_installing():
    """Updates started from inside RECON run Setup silently, and a run entry
    flagged skipifsilent is skipped exactly then -- which is how an update
    finished and left the shop with no RECON running."""
    run = re.search(r"^\[Run\](.*?)^\[", ISS, re.MULTILINE | re.DOTALL)
    assert run, "RECON.iss no longer has a [Run] section"
    # Inno continues a directive onto the next line with a trailing backslash,
    # and this entry uses that -- so the lines have to be rejoined before any
    # of it can be read as one entry.
    joined = re.sub(r"\\\s*\n\s*", " ", run.group(1))
    launch = [line for line in joined.splitlines() if "AppExe" in line and "postinstall" in line]
    assert launch, "nothing in [Run] starts RECON after installing"
    entry = " ".join(launch)
    assert "skipifsilent" not in entry, "a silent update would finish with RECON not running"
    assert "runasoriginaluser" in entry, "RECON would be relaunched with Setup's admin rights"


def test_an_update_never_rewrites_which_pc_this_is():
    """The role page does not run during a silent install, so RolePage sits at
    its default -- "main shop PC". Trusting it would promote every workstation
    to a second master the moment it updated, silently, with nobody having
    clicked anything. That is the two-sets-of-records failure the page exists
    to prevent, arriving by the back door."""
    code = ISS[ISS.index("[Code]") :]
    assert "function IsUpgrade" in code, "nothing distinguishes an upgrade from a first install"

    writer = re.search(r"procedure WriteDeploymentConfig;(.*?)\bend;", code, re.DOTALL)
    assert writer, "WriteDeploymentConfig is gone"
    assert re.search(r"if\s+IsUpgrade\s+then\s+Exit;", writer.group(1)), (
        "an update would overwrite deployment.json and could flip a workstation to master"
    )

    role = re.search(r"function IsMaster: Boolean;(.*?)\bend;\s*\n\s*\n", code, re.DOTALL)
    assert role, "IsMaster is gone"
    assert "IsUpgrade" in role.group(1), "IsMaster still trusts the wizard on an upgrade"


def test_the_role_question_is_not_asked_again_on_an_upgrade():
    skip = re.search(r"function ShouldSkipPage\(PageID: Integer\): Boolean;(.*?)\bend;", ISS, re.DOTALL)
    assert skip, "ShouldSkipPage is gone"
    assert "IsUpgrade" in skip.group(1), "an upgrade would re-ask which PC this is"


# --- the app's half: get out of the installer's way ---


def test_the_installer_is_run_unattended_and_recon_stands_down():
    """install_update starts Setup and then shuts RECON down. Closing the
    window would not do -- on the shop PC that hides to the tray on purpose --
    so it has to be the tray's full exit, which is what releases the exe and
    the port."""
    source = (REPO / "app" / "window.py").read_text(encoding="utf-8")
    body = source[source.index("def install_update") :]
    body = body[: body.index("\nclass ")]

    for flag in ("/SILENT", "/SUPPRESSMSGBOXES", "/FORCECLOSEAPPLICATIONS", "/NORESTART"):
        assert flag in body, f"the installer is not passed {flag}, so it can stall waiting on a person"
    assert "_on_quit" in body, "RECON keeps running and Setup cannot replace the exe it is holding"


def test_quitting_for_an_update_is_the_full_shutdown():
    """Not window.destroy(): the server, the tray icon and the single-instance
    mutex all have to go, or the next launch races the one being replaced."""
    tray = (REPO / "app" / "tray_app.py").read_text(encoding="utf-8")
    quit_for_update = re.search(r"def _quit_for_update\(self\).*?\n(.*?)\n    def ", tray, re.DOTALL)
    assert quit_for_update, "TrayApp._quit_for_update is gone -- window.py calls it"
    assert "self.quit_app()" in quit_for_update.group(1)
    assert "on_quit=self._quit_for_update" in tray, "the window has no way to ask the tray to exit"
