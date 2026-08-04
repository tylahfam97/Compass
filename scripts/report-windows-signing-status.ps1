# Reports whether the built Windows .exe actually ended up Authenticode-signed - called from
# .github/workflows/build.yml (create-compass job, "Report Windows code signing status" step,
# `if: always()` so this still runs and reports even if an earlier step failed).
# No env vars required - RUNNER_TEMP/GITHUB_STEP_SUMMARY are ambient.
#
# Independently verifies via Get-AuthenticodeSignature (ground truth, not just trusting
# sign-windows.ps1's own self-report) and prints a result that's impossible to miss: a console
# annotation (shows as a banner in the Actions UI) AND a GitHub Step Summary entry (shows at
# the top of the run page, not buried in raw logs). Purely informational - never fails the build.
#
# NOTE: emoji are built from explicit Unicode code points ([char]0x....) rather than embedded as
# literal glyphs in this file. This step runs under `shell: powershell` (Windows PowerShell 5.1,
# see build.yml), which parses .ps1 source using the system's default ANSI codepage unless the
# file carries a UTF-8 BOM - literal emoji glyphs get silently corrupted into mojibake (e.g.
# "âš ï¸") when re-saved without a BOM. Building the glyph at runtime from its code point sidesteps
# source-encoding entirely and can't regress no matter how this file gets saved/edited later.
$checkMark = [char]0x2705
$warnMark  = [string]([char]0x26A0) + [string]([char]0xFE0F)

# Canonical version source of truth (tauri.conf.json) - falls back to APP_VERSION (set earlier
# this job by read-version-and-patch-config.ps1) only if the config can't be read for some reason.
$version = try { (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version } catch { $null }
if (-not $version) { $version = $env:APP_VERSION }

# Parses compass-sign-status.txt (written line-by-line by sign-windows.ps1 as `signed|<path>` or
# `unsigned|<path>|exit_<code>|<error text>`) into a short grouped summary instead of dumping one
# line per file - an NSIS bundle signs a dozen+ plugin DLLs individually, and listing all of them
# when they all share the same root cause (e.g. "exit_1") is noisy and not actionable.
function Format-SigningLog {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return "(signing was not attempted - not fully configured for this run)"
    }
    $lines = Get-Content $Path | Where-Object { $_ -match '\S' }
    if (-not $lines) {
        return "(signing was not attempted - not fully configured for this run)"
    }

    $entries = $lines | ForEach-Object {
        $parts = $_ -split '\|'
        [pscustomobject]@{
            Status    = $parts[0]
            ExitCode  = if ($parts.Count -gt 2) { $parts[2] -replace '^exit_', '' } else { $null }
            ErrorText = if ($parts.Count -gt 3) { $parts[3] } else { $null }
            Name      = Split-Path $parts[1] -Leaf
        }
    }

    $summaryLines = foreach ($group in ($entries | Group-Object Status, ExitCode)) {
        $sample = $group.Group[0]
        $label = if ($sample.Status -eq 'signed') { "$checkMark signed" } else { "$warnMark unsigned (exit code $($sample.ExitCode))" }
        # Wrapped in @(...) - Windows PowerShell 5.1 collapses a single-item Where-Object result to
        # a scalar (no .Count property), which would silently break the "+N supporting files" count
        # whenever a group has exactly one non-installer file.
        $primary = @($group.Group | Where-Object { $_.Name -match '\.(exe|msi)$' })
        $rest    = @($group.Group | Where-Object { $_.Name -notmatch '\.(exe|msi)$' })
        $names = @($primary | ForEach-Object { $_.Name })
        if ($rest.Count -gt 0) {
            $names += "+$($rest.Count) supporting file$(if ($rest.Count -ne 1) { 's' }) (WiX/NSIS plugin DLLs, same cause)"
        }
        $line = "- $label`: $($names -join ', ')"
        if ($sample.ErrorText) { $line += "`n  - artifact-signing-cli said: $($sample.ErrorText)" }
        $line
    }
    return ($summaryLines -join "`n")
}

# Filtered to the CURRENT version's filename (not just sorted by mtime) - a local/long-lived
# bundle folder can hold installers from many past versions, and a stale file's timestamp can
# end up newer than a fresh rebuild's for all sorts of reasons. Sort-Object stays as a
# tie-breaker only. Falls back to an unfiltered (sorted) pick if $version couldn't be resolved
# at all, rather than reporting nothing.
$pattern = if ($version) { "src-tauri\target\release\bundle\nsis\*_${version}_*.exe" } else { "src-tauri\target\release\bundle\nsis\*.exe" }
$exe = Get-ChildItem $pattern -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) {
    Write-Warning "No built .exe found under src-tauri\target\release\bundle\nsis - skipping signing status check (build likely failed earlier)"
    exit 0
}

$statusFile = Join-Path $env:RUNNER_TEMP "compass-sign-status.txt"
$attempted  = Format-SigningLog -Path $statusFile

$sig = Get-AuthenticodeSignature -FilePath $exe.FullName
if ($sig.Status -eq "Valid") {
    Write-Host "::notice title=Windows build is SIGNED::$($exe.Name) is Authenticode-signed by: $($sig.SignerCertificate.Subject)"
    "## $checkMark Windows build is SIGNED`n`n**File:** $($exe.Name)`n**Signer:** $($sig.SignerCertificate.Subject)" |
        Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
} else {
    Write-Warning "UNSIGNED - $($exe.Name) - Get-AuthenticodeSignature status: $($sig.Status) ($($sig.StatusMessage))"
    "## $warnMark Windows build is UNSIGNED`n`n**File:** $($exe.Name)`n**Signature status:** $($sig.Status) - $($sig.StatusMessage)`n**Signing attempt log:**`n$attempted" |
        Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}
