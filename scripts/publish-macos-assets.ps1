# macOS release-asset publisher - called from .github/workflows/build.yml AFTER the Windows
# job (create-compass) has already created the GitHub release for this tag. Unlike
# publish-release.ps1, this script never deletes/recreates the release - it only ADDS to the
# one the Windows job already published, so a macOS build failure can never take the Windows
# release down with it.
# Env vars required: GH_TOKEN, GH_REPO, TAG_NAME, APP_VERSION, IS_PRERELEASE

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tagName      = $env:TAG_NAME
$version      = $env:APP_VERSION
$token        = $env:GH_TOKEN
$repo         = $env:GH_REPO
$isPrerelease = $env:IS_PRERELEASE -eq "true"

if (-not $token -or -not $tagName) {
    Write-Error "GH_TOKEN/TAG_NAME missing - was this run after the Windows job?"
    exit 1
}

$api = "https://api.github.com/repos/" + $repo
$authHeaders = @("-H", ("Authorization: Bearer " + $token), "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "-H", "User-Agent: compass-release-script")

# Helper: run a curl API call and return parsed JSON
function Invoke-Api($method, $url, $body = $null) {
    $curlArgs = @("-s", "-X", $method) + $authHeaders
    $tmpFile = $null
    if ($body) {
        $tmpFile = [IO.Path]::GetTempFileName()
        [IO.File]::WriteAllText($tmpFile, $body, (New-Object System.Text.UTF8Encoding $false))
        $curlArgs += @("-H", "Content-Type: application/json", "-d", "@$tmpFile")
    }
    $response = curl @curlArgs $url
    if ($tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
    return ($response | ConvertFrom-Json -ErrorAction SilentlyContinue)
}

# The Windows job (create-compass) creates the release for this tag - retry briefly in case
# this job's API read races its creation.
$release = $null
for ($i = 0; $i -lt 10; $i++) {
    $release = Invoke-Api "GET" ($api + "/releases/tags/" + $tagName)
    if ($release.id) { break }
    Start-Sleep -Seconds 5
}
if (-not $release.id) {
    Write-Error "No release found for tag $tagName - the Windows job may have failed to create it."
    exit 1
}
$releaseId = $release.id
Write-Host "Found release $tagName (ID $releaseId)"

$uploadHeaders = @{
    "Authorization"        = "Bearer " + $token
    "Accept"               = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "compass-release-script"
    "Content-Type"         = "application/octet-stream"
}
$uploadBase = "https://uploads.github.com/repos/" + $repo + "/releases/" + $releaseId + "/assets"

function Upload-Asset($path) {
    if (-not $path -or -not (Test-Path $path)) { Write-Warning "Asset not found: $path"; return }
    $name = Split-Path $path -Leaf
    # Remove any pre-existing asset with the same name (re-run safety)
    $existingAsset = $release.assets | Where-Object { $_.name -eq $name }
    if ($existingAsset) { Invoke-Api "DELETE" ($api + "/releases/assets/" + $existingAsset.id) | Out-Null }
    $bytes = [IO.File]::ReadAllBytes($path)
    Invoke-RestMethod -Uri ($uploadBase + "?name=" + $name) -Headers $uploadHeaders -Method Post -Body $bytes | Out-Null
    Write-Host "Uploaded $name"
}

$dmg    = Get-ChildItem -Path "src-tauri/target" -Filter "*.dmg" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$appTar = Get-ChildItem -Path "src-tauri/target" -Filter "*.app.tar.gz" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$appSig = Get-ChildItem -Path "src-tauri/target" -Filter "*.app.tar.gz.sig" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

if ($dmg) { Upload-Asset $dmg.FullName } else { Write-Warning "No .dmg found in build output" }

if ($appTar -and $appSig) {
    Upload-Asset $appTar.FullName
    Upload-Asset $appSig.FullName

    if ($isPrerelease) {
        Write-Host "Prerelease build - skipping latest.json update so stable users are not prompted."
    } else {
        # Merge darwin platform entries into the EXISTING latest.json asset (uploaded by the
        # Windows job) rather than overwriting it outright, so windows-x86_64 stays intact.
        $existingLatest = $release.assets | Where-Object { $_.name -eq "latest.json" }
        $manifest = $null
        if ($existingLatest) {
            $raw = curl -s -H ("Authorization: Bearer " + $token) -H "Accept: application/octet-stream" $existingLatest.browser_download_url
            $manifest = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
        }
        if (-not $manifest) {
            $manifest = [ordered]@{ version = $version; notes = "Compass $tagName"; pub_date = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"); platforms = [ordered]@{} }
        }
        $signature     = (Get-Content $appSig.FullName -Raw).Trim()
        $downloadUrl   = "https://github.com/" + $repo + "/releases/download/" + $tagName + "/" + $appTar.Name
        $platformEntry = [ordered]@{ signature = $signature; url = $downloadUrl }
        # A universal binary works on both architectures, so both platform keys point at the
        # same asset - PSCustomObject from ConvertFrom-Json needs Add-Member for new properties.
        foreach ($key in @("darwin-x86_64", "darwin-aarch64")) {
            if ($manifest.platforms.PSObject.Properties.Name -contains $key) {
                $manifest.platforms.$key = $platformEntry
            } else {
                $manifest.platforms | Add-Member -NotePropertyName $key -NotePropertyValue $platformEntry
            }
        }

        if ($existingLatest) { Invoke-Api "DELETE" ($api + "/releases/assets/" + $existingLatest.id) | Out-Null }
        $tmpJson = [IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
        [IO.File]::WriteAllText($tmpJson, ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
        $latestBytes = [IO.File]::ReadAllBytes($tmpJson)
        Invoke-RestMethod -Uri ($uploadBase + "?name=latest.json") -Headers $uploadHeaders -Method Post -Body $latestBytes | Out-Null
        Remove-Item $tmpJson -Force
        Write-Host "Updated latest.json with darwin platform entries"
    }
} else {
    Write-Warning "No signed .app.tar.gz found - macOS auto-updates will not work until Apple signing is configured (this is expected/fine for an unsigned test build)."
}

Write-Host "macOS assets published for $tagName"

# -- Apprise / Discord notification (stable releases only, same as publish-release.ps1) ------
$appriseDiscordUrl = $env:APPRISE_DISCORD_URL
if ($dmg -and $appriseDiscordUrl -and -not $isPrerelease) {
    $releasePageUrl = "https://github.com/" + $repo + "/releases/tag/" + $tagName
    $dmgUrl         = "https://github.com/" + $repo + "/releases/download/" + $tagName + "/" + $dmg.Name

    $notifyBody = "Compass $tagName is now available for macOS too (beta, unsigned - see the release page for how to open it). `@here" +
        "`n`nRelease page: " + $releasePageUrl +
        "`nDMG: " + $dmgUrl

    $notifyPayload = @{
        urls  = $appriseDiscordUrl
        title = "Compass $tagName Released (macOS)"
        body  = $notifyBody
        type  = "success"
    }
    $notifyJson = $notifyPayload | ConvertTo-Json -Compress
    $tmpNotify  = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmpNotify, $notifyJson, (New-Object System.Text.UTF8Encoding $false))

    Write-Host "Sending Discord notification for macOS via Apprise..."
    curl -s -X POST ($env:APPRISE_URL + "/notify") -H "Content-Type: application/json" -d ("@" + $tmpNotify)
    Write-Host ""
    Remove-Item $tmpNotify -Force
    Write-Host "Apprise notification sent"
} elseif (-not $appriseDiscordUrl) {
    Write-Host "APPRISE_DISCORD_URL secret not set - skipping Discord notification"
} elseif ($isPrerelease) {
    Write-Host "Prerelease build - skipping Discord notification"
}
