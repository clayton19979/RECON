# Fully uninstalls Discount Auto Ops from this PC: stops it if running,
# removes the auto-start shortcut (if set up), and deletes the .exe.
# Your database/backups are left alone by default -- pass -RemoveData to
# wipe those too (asks for a typed confirmation first, since that's the
# one truly destructive part of this script).
#
# Run from the folder containing DiscountAutoOps.exe, or pass -ExePath.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "DiscountAutoOps.exe"),
    [switch]$RemoveData
)

Write-Host "Stopping Discount Auto Ops if it's running..."
Get-Process -Name "DiscountAutoOps" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) "Discount Auto Ops.lnk"
if (Test-Path $startupShortcut) {
    Remove-Item $startupShortcut -Force
    Write-Host "Removed auto-start shortcut."
} else {
    Write-Host "Auto-start was not set up (no shortcut found)."
}

if (Test-Path $ExePath) {
    Remove-Item $ExePath -Force
    Write-Host "Removed $ExePath"
} else {
    Write-Host "No exe found at $ExePath -- skipping (pass -ExePath <path> if it's somewhere else)."
}

$dataRoot = Join-Path $env:LOCALAPPDATA "DiscountAutoOps"
if ($RemoveData) {
    if (Test-Path $dataRoot) {
        $confirm = Read-Host "This deletes your database and ALL backups at `"$dataRoot`" -- type YES to confirm"
        if ($confirm -eq "YES") {
            Remove-Item $dataRoot -Recurse -Force
            Write-Host "Removed $dataRoot (database, backups, logs)."
        } else {
            Write-Host "Skipped -- your data was NOT deleted."
        }
    } else {
        Write-Host "No data folder found at $dataRoot -- nothing to remove."
    }
} else {
    Write-Host "Your database and backups are still at $dataRoot -- re-run with -RemoveData to delete those too."
}

Write-Host ""
Write-Host "Uninstall complete."
