# Builds the distributable Discount Auto Ops.exe with PyInstaller.
# Run from the repo root: powershell -File installers\build_exe.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

uv sync --group build
uv run pyinstaller --noconfirm --clean `
  --name "DiscountAutoOps" `
  --windowed `
  --add-data "static;static" `
  app/tray_app.py

Write-Host ""
Write-Host "Built: dist\DiscountAutoOps\DiscountAutoOps.exe"
Write-Host "Copy the whole dist\DiscountAutoOps folder to the target PC -- the .exe needs its _internal folder alongside it."
