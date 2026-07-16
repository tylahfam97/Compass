# GitHub release publisher - called from .github/workflows/build.yml
# Env vars required: GH_TOKEN, APP_VERSION, GH_REPO

# Force TLS 1.2 - PowerShell 5.1 defaults to TLS 1.0 which GitHub rejects
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$version      = $env:APP_VERSION
$token        = $env:GH_TOKEN
$repo         = $env:GH_REPO
$isPrerelease = $env:IS_PRERELEASE -eq "true"

# Stable builds use "v{version}"; prerelease builds append the sanitized branch name
# so dev/feature tags never collide with or overwrite the stable release tag.
$tagName = if ($isPrerelease) {
    $branch    = if ($env:GITHUB_REF_NAME) { $env:GITHUB_REF_NAME } else { "dev" }
    $sanitized = ($branch -replace '[^a-zA-Z0-9]', '-') -replace '-{2,}', '-'
    $sanitized = $sanitized.Trim('-').ToLower()
    "v" + $version + "-" + $sanitized
} else {
    "v" + $version
}

if (-not $token) {
    Write-Error "GH_TOKEN is empty - check the GITHUB_TOKEN secret in repo settings"
    exit 1
}

Write-Host "Publishing $tagName for $repo | prerelease=$isPrerelease (token length: $($token.Length))"

$api         = "https://api.github.com/repos/" + $repo
$authHeaders = @("-H", ("Authorization: Bearer " + $token), "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "-H", "User-Agent: compass-release-script")

# Helper: run a curl API call and return parsed JSON
function Invoke-Api($method, $url, $body = $null) {
    $curlArgs = @("-s", "-X", $method) + $authHeaders
    $tmpFile  = $null
    if ($body) {
        $tmpFile = [IO.Path]::GetTempFileName()
        [IO.File]::WriteAllText($tmpFile, $body, (New-Object System.Text.UTF8Encoding $false))
        $curlArgs += @("-H", "Content-Type: application/json", "-d", "@$tmpFile")
    }
    $response = curl.exe @curlArgs $url
    if ($tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
    return ($response | ConvertFrom-Json -ErrorAction SilentlyContinue)
}

# Check if a release for this tag already exists
$existing = Invoke-Api "GET" ($api + "/releases/tags/" + $tagName)
if ($existing.id) {
    $delResult = Invoke-Api "DELETE" ($api + "/releases/" + $existing.id)
    if ($delResult -eq $null -or $delResult.message -eq $null) {
        Write-Host "Removed existing release $tagName (ID $($existing.id))"
    } else {
        # Release exists but can't be deleted (likely immutable) - abort with clear message
        Write-Error "Release $tagName already exists and cannot be deleted (it may be marked immutable). " +
                    "Go to GitHub Settings > General > Releases and disable 'Immutable releases', " +
                    "then manually delete the release and tag before re-running."
        exit 1
    }
} else {
    Write-Host "No existing release for $tagName"
}

# Delete the existing tag ref so GitHub recreates it at the current HEAD commit
$tagDel = Invoke-Api "DELETE" ($api + "/git/refs/tags/" + $tagName)
if ($tagDel.message -and $tagDel.message -ne "") {
    Write-Host "Tag ref note: $($tagDel.message)"
} else {
    Write-Host "Removed existing tag ref $tagName"
}

# Create the release - GitHub creates the tag at HEAD automatically
$releaseNotes = if (Test-Path "RELEASE_NOTES.md") {
    [IO.File]::ReadAllText((Resolve-Path "RELEASE_NOTES.md").Path)
} else {
    "Compass $tagName Windows installer."
}

$releaseJson = (@{
    tag_name               = $tagName
    name                   = if ($isPrerelease) { "[DEV] Compass $tagName" } else { "Compass $tagName" }
    body                   = $releaseNotes
    draft                  = $false
    prerelease             = $isPrerelease
    generate_release_notes = $false
} | ConvertTo-Json -Compress)

$release   = Invoke-Api "POST" ($api + "/releases") $releaseJson
$releaseId = $release.id

if (-not $releaseId) {
    Write-Error "Failed to create release: $($release | ConvertTo-Json -Compress)"
    exit 1
}

Write-Host "Created release $tagName (ID $releaseId)"

# Brief pause so GitHub's API fully registers the new release before uploading assets
Start-Sleep -Seconds 3

# Upload headers - Invoke-RestMethod is used for binary uploads (proven reliable with ReadAllBytes)
$uploadHeaders = @{
    "Authorization"        = "Bearer " + $token
    "Accept"               = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "compass-release-script"
    "Content-Type"         = "application/octet-stream"
}
$uploadBase = "https://uploads.github.com/repos/" + $repo + "/releases/" + $releaseId + "/assets"

# Upload MSI
$msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msi) {
    $msiBytes = [IO.File]::ReadAllBytes($msi.FullName)
    Invoke-RestMethod -Uri ($uploadBase + "?name=" + $msi.Name) -Headers $uploadHeaders -Method Post -Body $msiBytes | Out-Null
    Write-Host "Uploaded $($msi.Name)"
} else {
    Write-Warning "No MSI found in bundle output"
}

# Upload EXE (NSIS)
$exe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    $exeBytes = [IO.File]::ReadAllBytes($exe.FullName)
    Invoke-RestMethod -Uri ($uploadBase + "?name=" + $exe.Name) -Headers $uploadHeaders -Method Post -Body $exeBytes | Out-Null
    Write-Host "Uploaded $($exe.Name)"
} else {
    Write-Warning "No EXE found in bundle output"
}

# Upload NSIS zip (used by the in-app auto-updater) + generate latest.json
Write-Host "NSIS bundle contents:"
Get-ChildItem "src-tauri\target\release\bundle\nsis\" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1KB))KB)" }
$nsisZip = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$nsisSig = if ($nsisZip) { Get-Item ($nsisZip.FullName + ".sig") -ErrorAction SilentlyContinue } else { $null }

if ($nsisZip -and $nsisSig) {
    $nsisZipBytes = [IO.File]::ReadAllBytes($nsisZip.FullName)
    Invoke-RestMethod -Uri ($uploadBase + "?name=" + $nsisZip.Name) -Headers $uploadHeaders -Method Post -Body $nsisZipBytes | Out-Null
    Write-Host "Uploaded $($nsisZip.Name)"

    if ($isPrerelease) {
        Write-Host "Prerelease build - skipping latest.json so stable users are not prompted to update."
    } else {
        # Build latest.json - consumed by tauri-plugin-updater on every app launch check
        $signature   = Get-Content $nsisSig.FullName -Raw
        $downloadUrl = "https://github.com/" + $repo + "/releases/download/" + $tagName + "/" + $nsisZip.Name
        $pubDate     = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")

        $latestJson = [ordered]@{
            version  = $version
            notes    = "Compass $tagName"
            pub_date = $pubDate
            platforms = [ordered]@{
                "windows-x86_64" = [ordered]@{
                    signature = $signature.Trim()
                    url       = $downloadUrl
                }
            }
        } | ConvertTo-Json -Depth 5

        $tmpJson     = [IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
        [IO.File]::WriteAllText($tmpJson, $latestJson, (New-Object System.Text.UTF8Encoding $false))
        $latestBytes = [IO.File]::ReadAllBytes($tmpJson)
        Invoke-RestMethod -Uri ($uploadBase + "?name=latest.json") -Headers $uploadHeaders -Method Post -Body $latestBytes | Out-Null
        Remove-Item $tmpJson -Force
        Write-Host "Uploaded latest.json (updater manifest)"
    }
} else {
    if (-not $nsisZip) {
        Write-Warning "No .nsis.zip found - signing key was likely not picked up during tauri build."
    } else {
        Write-Warning "Found $($nsisZip.Name) but no .sig alongside it - key/password mismatch."
    }
    Write-Warning "Auto-updater manifest (latest.json) was NOT generated."
}

Write-Host "Release $tagName published"

# -- Apprise / Discord notification (stable releases only) -------------------
$appriseDiscordUrl = $env:APPRISE_DISCORD_URL
if ($appriseDiscordUrl -and -not $isPrerelease) {
    $releasePageUrl = "https://github.com/" + $repo + "/releases/tag/" + $tagName
    $baseDownload   = "https://github.com/" + $repo + "/releases/download/" + $tagName

    $releaseNoteText = if (Test-Path "RELEASE_NOTES.md") {
        $raw = [IO.File]::ReadAllText((Resolve-Path "RELEASE_NOTES.md").Path).Trim()
        # Strip markdown that Discord embeds can't render: tables (|) and rule separators (--)
        # Also strip ## heading markers, keeping the text
        $stripped = ($raw -split "`n" |
            Where-Object { $_ -notmatch '^\s*\|' -and $_ -notmatch '^\s*---' } |
            ForEach-Object { ($_ -replace '^#+\s*', '').TrimEnd() }) -join "`n"
        # Trim consecutive blank lines and cap at 900 chars
        $stripped = ($stripped -replace '(\r?\n){3,}', "`n`n").Trim()
        if ($stripped.Length -gt 900) { $stripped.Substring(0, 897) + "…" } else { $stripped }
    } else { "" }

    $notifyBody  = "Compass $tagName is now available for Windows. `@here"
    if ($releaseNoteText) { $notifyBody += "`n`n" + $releaseNoteText }
    $notifyBody += "`n`nRelease page: " + $releasePageUrl
    if ($msi) { $notifyBody += "`nMSI: " + $baseDownload + "/" + $msi.Name }
    if ($exe) { $notifyBody += "`nEXE: " + $baseDownload + "/" + $exe.Name }

    $notifyPayload = @{
        urls  = $appriseDiscordUrl
        title = "Compass $tagName Released"
        body  = $notifyBody
        type  = "success"
    }
    $notifyJson = $notifyPayload | ConvertTo-Json -Compress

    $tmpNotify = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmpNotify, $notifyJson, (New-Object System.Text.UTF8Encoding $false))

    Write-Host "Sending Discord notification via Apprise..."
    curl.exe -s -X POST "$env:APPRISE_URL/notify" -H "Content-Type: application/json" -d ("@" + $tmpNotify)
    Write-Host ""
    Remove-Item $tmpNotify -Force
    Write-Host "Apprise notification sent"
} else {
    if (-not $appriseDiscordUrl) {
        Write-Host "APPRISE_DISCORD_URL secret not set - skipping Discord notification"
    } else {
        Write-Host "Prerelease build - skipping Discord notification"
    }
}

# -- Trigger host-release.yml (stable releases only) --------------------------
# GitHub does not start new workflow runs from events (like this release being
# published) that were themselves produced via the API using GITHUB_TOKEN - an
# anti-recursion safeguard. That means host-release.yml's `release: published`
# trigger never actually fires for releases created by this script. workflow_dispatch
# IS exempt from that restriction, so dispatch it directly instead of relying on
# the event to fire on its own.
if (-not $isPrerelease) {
    Write-Host "Dispatching host-release.yml for $tagName ..."
    $dispatchBody = (@{ ref = $env:GITHUB_REF_NAME; inputs = @{ tag_name = $tagName } } | ConvertTo-Json -Compress)
    $dispatchResult = Invoke-Api "POST" ($api + "/actions/workflows/host-release.yml/dispatches") $dispatchBody
    if ($dispatchResult -and $dispatchResult.message) {
        Write-Warning "host-release.yml dispatch may have failed: $($dispatchResult.message)"
    } else {
        Write-Host "host-release.yml dispatched"
    }
} else {
    Write-Host "Prerelease build - skipping host-release.yml dispatch"
}


