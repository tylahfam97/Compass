# Reports whether the built Windows .exe actually ended up Authenticode-signed - called from
# .github/workflows/build.yml (create-compass job, "Report Windows code signing status" step,
# `if: always()` so this still runs and reports even if an earlier step failed).
# No env vars required - RUNNER_TEMP/GITHUB_STEP_SUMMARY are ambient.
#
# Independently verifies via Get-AuthenticodeSignature (ground truth, not just trusting
# sign-windows.ps1's own self-report) and prints a result that's impossible to miss: a console
# annotation (shows as a banner in the Actions UI) AND a GitHub Step Summary entry (shows at
# the top of the run page, not buried in raw logs). Purely informational - never fails the build.

$exe = Get-ChildItem src-tauri\target\release\bundle\nsis\*.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
    Write-Warning "No built .exe found under src-tauri\target\release\bundle\nsis - skipping signing status check (build likely failed earlier)"
    exit 0
}

$statusFile = Join-Path $env:RUNNER_TEMP "compass-sign-status.txt"
$attempted  = if (Test-Path $statusFile) { Get-Content $statusFile -Raw } else { "(signing was not attempted - not fully configured for this run)" }

$sig = Get-AuthenticodeSignature -FilePath $exe.FullName
if ($sig.Status -eq "Valid") {
    Write-Host "::notice title=Windows build is SIGNED::$($exe.Name) is Authenticode-signed by: $($sig.SignerCertificate.Subject)"
    "## ✅ Windows build is SIGNED`n`n**File:** $($exe.Name)`n**Signer:** $($sig.SignerCertificate.Subject)" |
        Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
} else {
    Write-Warning "UNSIGNED - $($exe.Name) - Get-AuthenticodeSignature status: $($sig.Status) ($($sig.StatusMessage))"
    "## ⚠️ Windows build is UNSIGNED`n`n**File:** $($exe.Name)`n**Signature status:** $($sig.Status) - $($sig.StatusMessage)`n**Signing attempt log:** $attempted`n`nThe build itself succeeded - this is expected until Azure Trusted Signing is fully active in production, and does not need any action unless it's unexpected." |
        Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}
