# Builds the distributable DiscountAutoOps.exe with PyInstaller, using
# DiscountAutoOps.spec (single-file / onefile mode) as the source of truth,
# so this script and the spec can't drift out of sync with each other.
# Run from the repo root: powershell -File installers\build_exe.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

uv sync --group build
uv run pyinstaller --noconfirm DiscountAutoOps.spec

Write-Host ""
Write-Host "Built: dist\DiscountAutoOps.exe (single self-contained file)"
Write-Host "Copy just that one .exe to the target PC -- nothing else is needed to run it."
