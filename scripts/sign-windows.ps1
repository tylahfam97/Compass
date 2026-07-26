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

$statusFile = Join-Path $env:RUNNER_TEMP "compass-sign-status.txt"

Write-Host "Attempting to sign: $TargetPath"
& $CliPath -e $Endpoint -a $Account -c $CertProfile -d Compass $TargetPath
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host "Successfully signed: $TargetPath"
    "signed|$TargetPath" | Out-File -FilePath $statusFile -Encoding utf8 -Append
    exit 0
}

Write-Warning "Azure Trusted Signing failed for '$TargetPath' (artifact-signing-cli exited $exitCode). This usually means the signing account/certificate profile isn't fully active in Azure yet, even though credentials/config are set. Continuing with an UNSIGNED binary rather than failing the build."
"unsigned|$TargetPath|exit_$exitCode" | Out-File -FilePath $statusFile -Encoding utf8 -Append
exit 0
