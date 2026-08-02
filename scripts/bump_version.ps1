# Sets RECON's version in the three files that must agree.
#
#   powershell -File scripts\bump_version.ps1 1.2.0
#
# app\version.py, installers\RECON.iss and version_info.txt each write the
# version in a different syntax, and publish_update.ps1 refuses to build when
# they disagree. That check was the only automation -- setting them was three
# manual edits in three formats, which is exactly the step worth scripting:
# the failure it prevents (an installer labelled 1.2.0 that installs an exe
# calling itself 1.1.0) is silent until a workstation stops updating.
#
# Writes nothing until all three files have been matched, so a version this
# cannot fully apply leaves the repo on the old one rather than half-bumped.
param(
    [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be three dotted numbers, e.g. 1.2.0 -- got '$Version'"
}

# The Windows resource wants the 4-part form; the other two use 3-part.
$quad = "$Version.0"
$tuple = ($Version.Split('.') + '0') -join ', '

$edits = @(
    @{ Path = "app\version.py"; Pattern = '(VERSION = ")[^"]+(")'; Replace = "`${1}$Version`${2}" }
    # pyproject.toml is the FOURTH file, and it was missing here until 1.2.0.
    # tests/test_updates.py::test_pyproject_matches_version_module asserts it
    # agrees with app\version.py, so leaving it behind turned every bump into
    # an immediately red test suite -- discovered the only way it can be, by
    # bumping and watching it fail. Anchored to the line start so it hits the
    # [project] version and not ruff's target-version or pyright's
    # pythonVersion further down the file.
    @{ Path = "pyproject.toml"; Pattern = '(?m)(^version = ")[^"]+(")'; Replace = "`${1}$Version`${2}" }
    @{ Path = "installers\RECON.iss"; Pattern = '(#define\s+AppVersion\s+")[^"]+(")'; Replace = "`${1}$Version`${2}" }
    @{ Path = "version_info.txt"; Pattern = '(filevers=\()[\d, ]+(\))'; Replace = "`${1}$tuple`${2}" }
    @{ Path = "version_info.txt"; Pattern = '(prodvers=\()[\d, ]+(\))'; Replace = "`${1}$tuple`${2}" }
    @{ Path = "version_info.txt"; Pattern = "(StringStruct\('FileVersion',\s*')[\d.]+(')"; Replace = "`${1}$quad`${2}" }
    @{ Path = "version_info.txt"; Pattern = "(StringStruct\('ProductVersion',\s*')[\d.]+(')"; Replace = "`${1}$quad`${2}" }
)

$staged = @{}
foreach ($e in $edits) {
    if (-not $staged.ContainsKey($e.Path)) {
        $staged[$e.Path] = Get-Content $e.Path -Raw
    }
    if ($staged[$e.Path] -notmatch $e.Pattern) {
        throw "No match for $($e.Pattern) in $($e.Path) -- the file's format changed; fix this script before releasing."
    }
    $staged[$e.Path] = $staged[$e.Path] -replace $e.Pattern, $e.Replace
}

# WriteAllText with an explicit no-BOM encoding, NOT Set-Content -Encoding utf8:
# under Windows PowerShell 5.1 that switch writes a BOM, which lands as three
# bytes in front of the first line. Python tolerates it, but version_info.txt is
# eval'd by PyInstaller and RECON.iss is parsed by Inno Setup -- and every bump
# would have rewritten the first line of all three files for no reason.
# Get-Content -Raw preserved the original CRLF endings, so they round-trip.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($path in $staged.Keys) {
    [System.IO.File]::WriteAllText((Resolve-Path $path), $staged[$path], $utf8NoBom)
    Write-Output "  updated $path"
}

Write-Output ""
Write-Output "Version is now $Version. Next:"
Write-Output "  .venv\Scripts\python scripts\check.py     # confirm still green"
Write-Output "  powershell -File installers\publish_update.ps1"
