# Builds RECON.exe -- one self-contained file -- using RECON.spec as the
# source of truth, so this script and the spec can't drift out of sync.
# Run from the repo root: powershell -File installers\build_exe.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# OneDrive refuses to hardlink into uv's cache (os error 396), which aborts
# the sync partway through. Copying costs a second and always works.
$env:UV_LINK_MODE = "copy"

uv sync --group build
if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }

# `python -m PyInstaller`, NOT the bare `pyinstaller` entry point: the .exe
# trampolines in .venv\Scripts embed the absolute path the venv was created
# at, so a repo that has moved (this one left OneDrive on 2026-07-28) fails
# with "uv trampoline failed to canonicalize script path". python.exe resolves
# its config relative to itself and survives the move.
uv run python -m PyInstaller --noconfirm RECON.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

# PowerShell does not stop on a native command's exit code, whatever
# $ErrorActionPreference says -- without the checks above this script printed
# "Built:" over a build that never happened.
if (-not (Test-Path "dist\RECON.exe")) { throw "PyInstaller reported success but dist\RECON.exe is missing" }

Write-Host ""
Write-Host "Built: dist\RECON.exe (single self-contained file)"
Write-Host "Next:  powershell -File installers\build_installer.ps1   to wrap it in a setup.exe"
