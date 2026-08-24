# Daily blog publisher for ukbrewerytours.com
#
# Rebuilds the site and pushes ONLY if the build output actually changed, which
# happens on the day a queued post's date arrives (build.js drops future-dated
# posts). Any other day it is a no-op, so it is safe to run every morning.
# Cloudflare Pages is git-connected, so the push IS the deploy.
#
# Registered as the scheduled task "UKBreweryTours-DailyPublish".
# Remove with:
#   Unregister-ScheduledTask -TaskName "UKBreweryTours-DailyPublish" -Confirm:$false
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as
# ANSI, so a UTF-8 em dash decodes to a smart quote and silently terminates a
# string, breaking the whole script at parse time.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$log = Join-Path $root "publish.log"
function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
    Write-Output $line
}

try {
    Log "build starting"
    $buildOut = & node build.js 2>&1 | Out-String
    Log ($buildOut -split "`r?`n")[0].Trim()

    $changed = & git status --porcelain -- docs
    if (-not $changed) {
        Log "no changes in docs - nothing to publish"
        exit 0
    }

    & git add docs
    & git commit -m "Publish queued blog post(s)" --quiet
    & git push origin main --quiet
    Log "pushed - Cloudflare Pages will deploy"
} catch {
    Log ("FAILED: " + $_.Exception.Message)
    exit 1
}
