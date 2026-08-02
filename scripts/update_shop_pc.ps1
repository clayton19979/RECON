# Automates the checkable half of DEPLOYING-TO-THE-SHOP-PC.md.
#
#   powershell -File scripts\update_shop_pc.ps1              # report only
#   powershell -File scripts\update_shop_pc.ps1 -Install     # also install
#
# Report mode touches nothing: it asks the running app what it is, what it has
# to offer, and whether the MCP mount answers, then prints a verdict. Run it
# before and after an update.
#
# -Install additionally downloads the pending installer and runs it silently.
# That closes and replaces the running app, so it is opt-in rather than the
# default -- the shop uses this machine all day and an unannounced restart in
# the middle of writing a ticket is its own kind of outage.
#
# What this deliberately does NOT do:
#   * Touch the database. Backups are a view in the app.
#   * Handle the GitHub token or the RECON API key. Those are Clayton's to
#     type; see the runbook.
#   * Configure Hermes/DART. Nothing about the MCP surface changed in 1.2.1,
#     so a working DART needs no work -- and this script cannot verify the
#     Hermes config layout, so it reports what it sees and stops there.
param(
    [switch]$Install,
    [string]$BaseUrl = "http://127.0.0.1:8787"
)
$ErrorActionPreference = "Stop"

$problems = @()

function Get-Json($Url) {
    try {
        return Invoke-RestMethod -Uri $Url -TimeoutSec 10
    } catch {
        return $null
    }
}

Write-Host ""
Write-Host "RECON update check -- $BaseUrl"
Write-Host ("-" * 52)

# --- What is running -------------------------------------------------------
$status = Get-Json "$BaseUrl/api/version"
if (-not $status) {
    Write-Host "RECON is not answering. Start it, then run this again." -ForegroundColor Red
    exit 1
}

Write-Host ("  running     : {0}" -f $status.version)
Write-Host ("  role        : {0}" -f $status.role)
Write-Host ("  updates dir : {0}" -f $status.updates_dir)

if ($status.role -ne "master") {
    # A workstation updates from the shop PC, not from its own folder. Running
    # this there is not harmful, but the answer means something different.
    Write-Host "  note        : this is a client, not the shop PC. It updates from the master." -ForegroundColor Yellow
}

# --- What is on offer ------------------------------------------------------
if (-not $status.update) {
    Write-Host "  pending     : nothing newer than $($status.version)"
} else {
    $mb = [math]::Round($status.update.size_bytes / 1MB, 1)
    Write-Host ("  pending     : {0}  ({1}, {2} MB)" -f $status.update.version, $status.update.filename, $mb) -ForegroundColor Cyan
}

# --- Is the MCP mount alive ------------------------------------------------
# Unauthenticated on purpose. With a key configured the correct answer is 401,
# which proves both that the mount is there and that it is guarded. 200/406 is
# a mount with no key set. A timeout or 404 is the real failure.
function Describe-McpStatus($Code) {
    switch ($Code) {
        401     { "mounted, API key required (expected)" }
        403     { "mounted, but the key sent was rejected" }
        404     { "NOT MOUNTED" }
        default { "mounted, no API key configured (status $Code)" }
    }
}

# No -SkipHttpErrorCheck: that switch is PowerShell 7+ and this runs under
# Windows PowerShell 5.1 on the shop PC, where passing it is a parameter
# binding error -- which the catch below would then misreport as "unreachable"
# on a perfectly healthy mount. Both editions throw on 4xx anyway, and both
# carry the status on the exception's Response, so the catch is the real path
# for the expected 401.
$mcpState = "unreachable"
try {
    $r = Invoke-WebRequest -Uri "$BaseUrl/mcp/" -Method GET -TimeoutSec 10 `
        -Headers @{ "accept" = "text/event-stream" } -UseBasicParsing
    $mcpState = Describe-McpStatus ([int]$r.StatusCode)
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($null -eq $code) {
        $mcpState = "unreachable: $($_.Exception.Message)"
    } else {
        $mcpState = Describe-McpStatus $code
    }
}
Write-Host ("  mcp mount   : {0}" -f $mcpState)
if ($mcpState -like "*NOT MOUNTED*" -or $mcpState -like "unreachable*") {
    $problems += "The MCP mount at /mcp/ did not answer as expected: $mcpState"
}

# --- Install ---------------------------------------------------------------
if ($Install) {
    if (-not $status.update) {
        Write-Host ""
        Write-Host "Nothing to install." -ForegroundColor Green
    } else {
        $target = $status.update.version
        Write-Host ""
        Write-Host "Installing $target. RECON will close and reopen." -ForegroundColor Yellow

        $setup = Join-Path $env:TEMP $status.update.filename
        Invoke-WebRequest -Uri "$BaseUrl/api/update/download" -OutFile $setup -TimeoutSec 300
        if (-not (Test-Path $setup)) { throw "Download produced no file at $setup" }

        # Inno Setup's own switches. /SILENT shows a progress window but asks
        # nothing; /VERYSILENT would hide even that, which is worse here --
        # someone standing at the PC should see that something is happening.
        $proc = Start-Process -FilePath $setup -ArgumentList "/SILENT", "/NORESTART" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)" }
        Remove-Item $setup -Force -ErrorAction SilentlyContinue

        # The installer relaunches the app; give it a moment to bind the port
        # before asking it anything.
        Write-Host "Waiting for RECON to come back up..."
        $after = $null
        foreach ($attempt in 1..30) {
            Start-Sleep -Seconds 2
            $after = Get-Json "$BaseUrl/api/version"
            if ($after) { break }
        }

        if (-not $after) {
            $problems += "RECON did not come back up after installing. Start it from the desktop icon."
        } elseif ($after.version -ne $target) {
            # The most common real failure: the old process was still holding
            # the exe, so setup replaced nothing.
            $problems += "Installed $target but the app still reports $($after.version) -- it did not actually restart."
        } else {
            Write-Host ("  now running : {0}" -f $after.version) -ForegroundColor Green
        }
    }
}

# --- Verdict ---------------------------------------------------------------
Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "OK." -ForegroundColor Green
    if (-not $Install -and $status.update) {
        Write-Host "Re-run with -Install to apply $($status.update.version), or install from the banner in the app."
    }
    Write-Host "DART needs no re-registration -- the MCP tool surface is unchanged."
    exit 0
}

Write-Host "Problems:" -ForegroundColor Red
foreach ($p in $problems) { Write-Host "  * $p" -ForegroundColor Red }
exit 1
