# Regression check for publish-release.ps1's provenance guard (manual; not wired into CI).
# Run from the Compass repository root: pwsh -File scripts/check-publish-release-provenance.ps1
# Each case must stop at the guard with exit 1 and its expected message before any API call.
# Network is pointed at a dead local proxy so a broken guard fails instead of touching GitHub.
$root = Split-Path -Parent $PSScriptRoot
if ((Get-Location).ProviderPath -ne $root) { Write-Host "FAIL: run from the repository root $root"; exit 1 }
$head = "$(git -C $root rev-parse --verify 'HEAD^{commit}' 2>$null)".Trim()
if ($LASTEXITCODE -ne 0 -or $head -cnotmatch '^[0-9a-f]{40}$') { Write-Host "FAIL: cannot resolve HEAD of $root"; exit 1 }
$publisher = Join-Path $PSScriptRoot "publish-release.ps1"
$wrong = if ($head -eq ("0" * 40)) { "1" * 40 } else { "0" * 40 }
$env:GH_TOKEN = "dummy"; $env:GH_REPO = "invalid/provenance-check"; $env:APP_VERSION = "0.0.0"
$env:IS_PRERELEASE = "true"; $env:HTTPS_PROXY = "http://127.0.0.1:9"; $env:APPRISE_DISCORD_URL = $null

# GITHUB_SHA, expected guard message, working directory
$bad = "GITHUB_SHA must be the full"
$cases = @(
    @($null, $bad, $root), @("", $bad, $root), @("main", $bad, $root),
    @($head.Substring(0, 7), $bad, $root), @($head.ToUpper(), $bad, $root),
    @($wrong, "does not match GITHUB_SHA", $root),
    @($head, "run from the repository root", $PSScriptRoot)
)
$failed = 0
foreach ($c in $cases) {
    $env:GITHUB_SHA = $c[0]
    Push-Location $c[2]
    $out = & pwsh -NoProfile -File $publisher 2>&1 | Out-String
    $code = $LASTEXITCODE
    Pop-Location
    # Whitespace stripped on both sides so console line-wrapping of the error can't break the match.
    if ($code -ne 1 -or -not ($out -replace '\s', '').Contains(($c[1] -replace '\s', ''))) {
        Write-Host "FAIL: GITHUB_SHA='$($c[0])' in $($c[2]) was not rejected with '$($c[1])'"; $failed++
    }
}
if ($failed) { exit 1 }
Write-Host "OK: guard rejected every bad GITHUB_SHA, the mismatched SHA and the wrong working directory"
