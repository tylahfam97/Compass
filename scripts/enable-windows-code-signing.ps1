# Optionally enables Windows code signing via Azure Trusted Signing - called from
# .github/workflows/build.yml (create-compass job).
# Env vars required (all 6, or signing is skipped and the build proceeds unsigned):
#   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE   (repo variables -
#     not sensitive, just endpoint/account/profile names)
#   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID                 (repo secrets - the
#     actual credentials artifact-signing-cli authenticates with)
#
# Having all 6 values non-empty does NOT guarantee the Azure Trusted Signing account/
# certificate profile is actually active/"in production" in Azure yet - auth can succeed while
# the signing operation itself still fails. That's handled by scripts/sign-windows.ps1 (the
# wrapper this script points signCommand at), which always exits 0 so a not-yet-active signing
# profile falls back to an unsigned build instead of failing the whole workflow.

if (-not ($env:AZURE_SIGNING_ENDPOINT -and $env:AZURE_SIGNING_ACCOUNT -and $env:AZURE_SIGNING_PROFILE `
        -and $env:AZURE_CLIENT_ID -and $env:AZURE_CLIENT_SECRET -and $env:AZURE_TENANT_ID)) {
    Write-Warning "Azure Trusted Signing is not fully configured yet (variables and/or credential secrets missing) - the .exe/.msi will be unsigned (still shows an Unknown Publisher warning)"
    exit 0
}

# 2026-08 finding: artifact-signing-cli fails with "azure cli ... does not exists" even when
# AZURE_CLIENT_ID/SECRET/TENANT_ID are confirmed present in its own process (verified via a
# diagnostic in sign-windows.ps1) - so it does not authenticate via those env vars alone the way
# the Azure SDK's EnvironmentCredential normally would. It needs an actual Azure CLI install with
# a live login session, which is what its own error message is asking for. Installing it here
# (MSI, not winget - Windows Server images often lack winget) and logging in as the same service
# principal every run keeps this working even if the runner is ever reimaged.
$azCmd = Get-Command az -ErrorAction SilentlyContinue
$azWbin = Join-Path $env:ProgramFiles "Microsoft SDKs\Azure\CLI2\wbin"
if (-not $azCmd -and -not (Test-Path (Join-Path $azWbin "az.cmd"))) {
    Write-Host "Azure CLI not found - installing..."
    $msiPath = Join-Path $env:TEMP "AzureCLI.msi"
    Invoke-WebRequest -Uri "https://aka.ms/installazurecliwindows" -OutFile $msiPath -UseBasicParsing
    Start-Process msiexec.exe -Wait -ArgumentList "/I `"$msiPath`" /quiet /norestart"
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
}
if (-not $azCmd -and (Test-Path (Join-Path $azWbin "az.cmd"))) {
    # Freshly installed in this same process - PATH won't pick it up until a new session, same
    # class of gotcha as the cargo bin PATH issue above. Add it for this job's remaining steps too.
    Add-Content -Path $env:GITHUB_PATH -Value $azWbin
    $env:PATH = "$azWbin;$env:PATH"
}
if (Get-Command az -ErrorAction SilentlyContinue) {
    Write-Host "Logging into Azure CLI as the signing service principal..."
    az login --service-principal -u $env:AZURE_CLIENT_ID -p $env:AZURE_CLIENT_SECRET --tenant $env:AZURE_TENANT_ID --output none
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "az login --service-principal failed (exit $LASTEXITCODE) - the client id/secret/tenant may be wrong, expired, or missing the Trusted Signing role assignment. Signing will likely still fail, but the build continues unsigned."
    } else {
        Write-Host "Azure CLI login succeeded"
    }
} else {
    Write-Warning "Azure CLI install did not produce a usable az.cmd - signing will likely still fail via its Azure CLI fallback."
}

# Install BEFORE resolving/patching signCommand below - on a fresh runner with no cache,
# computing signCommand first would bake in a reference to a binary that doesn't exist on disk
# yet until this install step runs. Cached/idempotent on this persistent self-hosted runner -
# a no-op on every build after the first.
if (-not (Get-Command artifact-signing-cli -ErrorAction SilentlyContinue)) {
    Write-Host "Installing artifact-signing-cli..."
    cargo install artifact-signing-cli
} else {
    Write-Host "artifact-signing-cli already installed"
}

# Resolve the CLI's fully-qualified path instead of relying on the bare command name
# ("artifact-signing-cli") still being resolvable later, when Tauri's own bundler (a separate
# Rust subprocess spawned from npm run tauri build) tries to run signCommand - that
# subprocess's PATH isn't guaranteed to include ~/.cargo/bin on every self-hosted
# runner/service context ("failed to run artifact-signing-cli" was this exact issue).
$cli = Get-Command artifact-signing-cli -ErrorAction SilentlyContinue
if (-not $cli) {
    Write-Warning "artifact-signing-cli install appears to have failed (not found on PATH after install) - leaving the build unsigned rather than failing it."
    exit 0
}
$cliPath = $cli.Source
Write-Host "artifact-signing-cli resolved to: $cliPath"

# Same PATH-resolution issue applies to the bare "powershell" name Tauri would otherwise try to
# spawn directly ("failed to run powershell") - resolve its fully-qualified path too.
$pwshCli = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $pwshCli) {
    Write-Warning "powershell.exe could not be resolved on this runner - leaving the build unsigned rather than failing it."
    exit 0
}
$pwshPath = $pwshCli.Source

$wrapperPath = (Resolve-Path "scripts\sign-windows.ps1").Path

Write-Host "Azure Trusted Signing variables and credentials are all set - enabling Windows code signing"
$cfg = Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json
if (-not $cfg.bundle.windows) {
    $cfg.bundle | Add-Member -NotePropertyName windows -NotePropertyValue ([PSCustomObject]@{}) -Force
}

# Use the STRUCTURED { cmd, args } form instead of a single command-line string - Tauri's
# Windows bundler does not re-split a quoted string into argv the way a shell would (a plain
# string here previously caused "os error 123: The filename, directory name, or volume label
# syntax is incorrect" - it likely treated the whole quoted string as one literal path).
# Passing args as a JSON array sidesteps quoting entirely - each element becomes exactly one
# argv entry, no re-parsing involved.
$signCommand = [PSCustomObject]@{
    cmd  = $pwshPath
    args = @(
        "-ExecutionPolicy", "Bypass",
        "-File", $wrapperPath,
        "-CliPath", $cliPath,
        "-Endpoint", $env:AZURE_SIGNING_ENDPOINT,
        "-Account", $env:AZURE_SIGNING_ACCOUNT,
        "-CertProfile", $env:AZURE_SIGNING_PROFILE,
        "-TargetPath", "%1"
    )
}
$cfg.bundle.windows | Add-Member -NotePropertyName signCommand -NotePropertyValue $signCommand -Force
$cfg | ConvertTo-Json -Depth 32 | Set-Content src-tauri\tauri.conf.json -NoNewline
Write-Host "signCommand configured: $($signCommand | ConvertTo-Json -Compress)"
