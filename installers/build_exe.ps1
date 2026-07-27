# Builds RECON.exe -- one self-contained file -- using RECON.spec as the
# source of truth, so this script and the spec can't drift out of sync.
# Run from the repo root: powershell -File installers\build_exe.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# OneDrive refuses to hardlink into uv's cache (os error 396), which aborts
# the sync partway through. Copying costs a second and always works.
$env:UV_LINK_MODE = "copy"

uv sync --group build
uv run pyinstaller --noconfirm RECON.spec

Write-Host ""
Write-Host "Built: dist\RECON.exe (single self-contained file)"
Write-Host "Next:  powershell -File installers\build_installer.ps1   to wrap it in a setup.exe"
