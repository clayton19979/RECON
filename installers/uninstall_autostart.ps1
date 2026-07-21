# Removes the Startup-folder shortcut created by install_autostart.ps1.
# Does not stop a currently running copy -- use the tray icon's Exit for that.
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "Discount Auto Ops.lnk"
if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "Auto-start removed."
} else {
    Write-Host "Auto-start was not set up (no shortcut found)."
}
