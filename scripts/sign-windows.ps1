# Wrapper invoked by Tauri's bundle.windows.signCommand (configured in build.yml's "Ensure
# artifact-signing-cli is installed and enable Windows code signing" step) instead of calling
# artifact-signing-cli directly.
#
# Why this exists: having valid, non-empty AZURE_CLIENT_ID/SECRET/TENANT_ID secrets and
# AZURE_SIGNING_ENDPOINT/ACCOUNT/PROFILE variables does NOT guarantee the actual Azure Trusted
# Signing account/certificate profile is fully active/"in production" in Azure yet - the
# credentials can authenticate fine while the underlying signing operation itself still fails.
# Tauri treats any non-zero exit from signCommand as a hard build failure (the "Build Tauri
# application" step has no continue-on-error), so without this wrapper, a not-yet-active
# signing profile fails the ENTIRE build even though the app itself compiled fine.
#
# This wrapper always exits 0, so Tauri always treats signing as "handled" - if the real CLI
# fails, we log a clear warning and simply leave that file unsigned. A later workflow step
# ("Report Windows code signing status") independently verifies (via Get-AuthenticodeSignature)
# and prints a prominent signed/unsigned banner, since a silently-swallowed signing failure
# would otherwise be easy to miss in a wall of build logs.
param(
    [Parameter(Mandatory = $true)][string]$CliPath,
    [Parameter(Mandatory = $true)][string]$Endpoint,
    [Parameter(Mandatory = $true)][string]$Account,
    [Parameter(Mandatory = $true)][string]$CertProfile,
    [Parameter(Mandatory = $true)][string]$TargetPath
)

# AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID are inherited as env vars from the
# "Build Tauri application" step (the parent process here) - artifact-signing-cli reads them
# itself via the standard Azure SDK environment variable names, nothing to pass explicitly.
#
# 2026-08: a real run showed artifact-signing-cli falling through to an Azure CLI credential
# ("azure cli ... does not exists") instead of authenticating via these env vars - meaning
# EnvironmentCredential didn't succeed, for a reason not yet known (vars genuinely missing from
# THIS process - Tauri spawns signCommand as its own subprocess per file, which may not inherit
# the full parent env - vs. present but rejected for some other reason look identical from
# outside). The two lines below log which case it is (values themselves are never printed) and
# RUST_LOG=debug asks artifact-signing-cli's own Azure SDK crate for a more specific reason.

$statusFile = Join-Path $env:RUNNER_TEMP "compass-sign-status.txt"

Write-Host "Attempting to sign: $TargetPath"
Write-Host ("Service principal env vars present in THIS process - ClientId:{0} ClientSecret:{1} TenantId:{2}" -f `
    (-not [string]::IsNullOrEmpty($env:AZURE_CLIENT_ID)), (-not [string]::IsNullOrEmpty($env:AZURE_CLIENT_SECRET)), (-not [string]::IsNullOrEmpty($env:AZURE_TENANT_ID)))
$prevRustLog = $env:RUST_LOG
$env:RUST_LOG = "debug"
$cliOutput = & $CliPath -e $Endpoint -a $Account -c $CertProfile -d Compass $TargetPath 2>&1
$exitCode = $LASTEXITCODE
$env:RUST_LOG = $prevRustLog
$cliOutput | ForEach-Object { Write-Host $_ }

if ($exitCode -eq 0) {
    Write-Host "Successfully signed: $TargetPath"
    "signed|$TargetPath" | Out-File -FilePath $statusFile -Encoding utf8 -Append
    exit 0
}

# Collapse to one line and strip '|' so it can't corrupt the pipe-delimited status file format -
# this is what lets the summary step show WHY it failed instead of just an exit code.
$errorText = (($cliOutput | Out-String).Trim() -replace '[\r\n\|]+', ' ')
if (-not $errorText) { $errorText = "(artifact-signing-cli produced no output)" }

Write-Warning "Azure Trusted Signing failed for '$TargetPath' (artifact-signing-cli exited $exitCode): $errorText"
"unsigned|$TargetPath|exit_$exitCode|$errorText" | Out-File -FilePath $statusFile -Encoding utf8 -Append