# Publishes the current build as a GitHub release -- the whole "push an
# update from home" flow in one command:
#
#   powershell -File installers\publish_update.ps1
#
# Builds the exe and installer, then creates release v<version> with the
# setup exe attached. The shop PC's daily check (app/online_updates.py)
# finds the release and pulls the installer into its updates folder, where
# the existing offer-and-install flow takes over.
#
# Needs the GitHub CLI, signed in once (`gh auth login`), and an `origin`
# remote pointing at the repository named in the shop's update_source.json.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# The version everything gets stamped with. Three files must agree
# (tests/test_updates.py asserts it too) -- a mismatch here means an
# installer that lies about what it installs, so fail before building.
$version = (Select-String -Path "app\version.py" -Pattern 'VERSION = "([^"]+)"').Matches[0].Groups[1].Value
if (-not $version) { throw "Could not read VERSION from app\version.py" }
$iss = (Select-String -Path "installers\RECON.iss" -Pattern '#define\s+AppVersion\s+"([^"]+)"').Matches[0].Groups[1].Value
$info = (Select-String -Path "version_info.txt" -Pattern "StringStruct\('FileVersion',\s*'([\d.]+)'\)").Matches[0].Groups[1].Value
if ($iss -ne $version) { throw "RECON.iss says $iss but app\version.py says $version -- update both before publishing." }
if (-not $info.StartsWith($version)) { throw "version_info.txt says $info but app\version.py says $version -- update both before publishing." }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI not found. Install it with:  winget install GitHub.cli"
}
gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in. Run:  gh auth login" }

# A version that's already out is a wall, not a warning: shop PCs compare
# numbers, so re-releasing 1.1.0 with different bits means some machines
# "on 1.1.0" run code other machines on 1.1.0 don't have.
gh release view "v$version" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    throw "Release v$version already exists. Bump the version (app\version.py, version_info.txt, installers\RECON.iss) first."
}

# Uncommitted work would produce an exe no commit corresponds to -- fine on
# a test bench, not as the build every PC in the shop installs.
$dirty = git status --porcelain
if ($dirty) {
    throw "The working tree has uncommitted changes. Commit (or stash) before publishing, so the release matches a commit."
}

& powershell -NoProfile -File "installers\build_exe.ps1"
if ($LASTEXITCODE -ne 0) { throw "build_exe.ps1 failed" }
& powershell -NoProfile -File "installers\build_installer.ps1"
if ($LASTEXITCODE -ne 0) { throw "build_installer.ps1 failed" }

$setup = "dist\RECON-Setup-$version.exe"
if (-not (Test-Path $setup)) { throw "$setup was not produced by the build" }

# The release is cut from the pushed branch, so push first; a tag pointing
# at a commit GitHub has never seen helps nobody debug next month.
git push origin master
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

gh release create "v$version" $setup --title "RECON $version" --notes "Built from $(git rev-parse --short HEAD)."
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Host ""
Write-Host "Published RECON $version."
Write-Host "The shop PC picks it up on its daily check, or immediately via"
Write-Host "tray menu > Check Online for Updates. Installing stays a click in the app."
