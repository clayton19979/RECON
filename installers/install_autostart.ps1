# Makes Discount Auto Ops start silently (no window) when you log into Windows,
# by placing a shortcut in your Startup folder. No admin rights needed.
# Run from the folder containing DiscountAutoOps.exe, or pass -ExePath.
#   powershell -ExecutionPolicy Bypass -File install_autostart.ps1
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "DiscountAutoOps.exe")
)

if (-not (Test-Path $ExePath)) {
    Write-Error "DiscountAutoOps.exe not found at $ExePath. Pass -ExePath <path to DiscountAutoOps.exe>."
    exit 1
}

$ExePath = (Resolve-Path $ExePath).Path
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "Discount Auto Ops.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path $ExePath
$shortcut.Description = "Discount Auto Ops"
$shortcut.Save()

Write-Host "Discount Auto Ops will now start automatically at login (tray icon, no window)."
Write-Host "Shortcut: $shortcutPath"
Write-Host "Starting it now..."
Start-Process -FilePath $ExePath
