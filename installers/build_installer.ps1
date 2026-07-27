# Wraps dist\RECON.exe in a setup.exe. Run build_exe.ps1 first.
#   powershell -File installers\build_installer.ps1
#
# Also fetches the WebView2 bootstrapper, which the installer runs only on
# machines that don't already have the runtime.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$exe = "dist\RECON.exe"
if (-not (Test-Path $exe)) {
    throw "$exe not found -- run installers\build_exe.ps1 first."
}

# winget installs per-user unless it's run elevated, so LocalAppData is the
# likely location, not Program Files.
$iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
    throw "Inno Setup 6 not found. Install it with:  winget install JRSoftware.InnoSetup"
}

# Evergreen bootstrapper: ~2 MB, always the current runtime, and a no-op on a
# machine that already has it.
$bootstrapper = "installers\MicrosoftEdgeWebview2Setup.exe"
if (-not (Test-Path $bootstrapper)) {
    Write-Host "Fetching the WebView2 bootstrapper..."
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $bootstrapper
}

& $iscc /Qp "installers\RECON.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }

$setup = Get-ChildItem "dist\RECON-Setup-*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host "Built: $($setup.FullName)"
Write-Host ("Size:  {0:N1} MB" -f ($setup.Length / 1MB))
Write-Host ""
Write-Host "Run it on each PC. Pick 'main shop PC' on exactly one of them."
