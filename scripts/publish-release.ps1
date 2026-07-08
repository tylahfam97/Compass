# GitHub release publisher - called from .github/workflows/build.yml
# Env vars required: GH_TOKEN, APP_VERSION, GH_REPO

$version = $env:APP_VERSION
$token   = $env:GH_TOKEN
$repo    = $env:GH_REPO
$tagName = "v" + $version

if (-not $token) {
    Write-Error "GH_TOKEN is empty - check the GITHUB_TOKEN secret in repo settings"
    exit 1
}

Write-Host "Publishing $tagName for $repo (token length: $($token.Length))"

$api     = "https://api.github.com/repos/" + $repo
$headers = @{
    "Authorization"        = "Bearer " + $token
    "Accept"               = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "compass-release-script"
}

# Delete existing release if one already exists for this tag
try {
    $existing = Invoke-RestMethod -Uri ($api + "/releases/tags/" + $tagName) -Headers $headers -Method Get -ErrorAction Stop
    if ($existing.id) {
        Invoke-RestMethod -Uri ($api + "/releases/" + $existing.id) -Headers $headers -Method Delete | Out-Null
        Write-Host "Removed existing release $tagName"
    }
} catch {
    Write-Host "No existing release found for $tagName (this is fine for first publish)"
}

# Also delete the existing tag ref so GitHub recreates it at the current commit
try {
    Invoke-RestMethod -Uri ($api + "/git/refs/tags/" + $tagName) -Headers $headers -Method Delete | Out-Null
    Write-Host "Removed existing tag $tagName"
} catch {
    # Tag didn't exist yet — ignore
}

# Create the release (GitHub will create the tag at HEAD automatically)
$releaseBody = @{
    tag_name         = $tagName
    name             = "Compass " + $tagName
    body             = "Compass " + $tagName + " Windows installer - includes MSI and EXE."
    draft            = $false
    prerelease       = $false
    generate_release_notes = $false
}

$release   = Invoke-RestMethod -Uri ($api + "/releases") -Headers $headers -Method Post -Body ($releaseBody | ConvertTo-Json) -ContentType "application/json"
$releaseId = $release.id

if (-not $releaseId) {
    Write-Error "Failed to create release"
    exit 1
}

Write-Host "Created release $tagName (ID $releaseId)"

# Upload headers for asset binary uploads (different endpoint)
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
$nsisZip = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$nsisSig = if ($nsisZip) { Get-ChildItem ($nsisZip.FullName + ".sig") -ErrorAction SilentlyContinue } else { $null }

if ($nsisZip -and $nsisSig) {
    # Upload the signed NSIS zip bundle
    $nsisZipBytes = [IO.File]::ReadAllBytes($nsisZip.FullName)
    Invoke-RestMethod -Uri ($uploadBase + "?name=" + $nsisZip.Name) -Headers $uploadHeaders -Method Post -Body $nsisZipBytes | Out-Null
    Write-Host "Uploaded $($nsisZip.Name)"

    # Build latest.json — consumed by tauri-plugin-updater on every app launch check
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

    $tmpJson = [IO.Path]::GetTempFileName() -replace '\.tmp$', '.json'
    [IO.File]::WriteAllText($tmpJson, $latestJson, (New-Object System.Text.UTF8Encoding $false))
    $jsonBytes = [IO.File]::ReadAllBytes($tmpJson)
    Invoke-RestMethod -Uri ($uploadBase + "?name=latest.json") -Headers $uploadHeaders -Method Post -Body $jsonBytes | Out-Null
    Remove-Item $tmpJson -Force
    Write-Host "Uploaded latest.json (updater manifest)"
} else {
    Write-Warning "No signed NSIS zip found - auto-updater manifest (latest.json) was NOT generated."
    Write-Warning "Ensure TAURI_SIGNING_PRIVATE_KEY is set in the build step environment."
}

Write-Host "Release $tagName published"

# -- Apprise / Discord notification ------------------------------------------
$appriseDiscordUrl = $env:APPRISE_DISCORD_URL
if ($appriseDiscordUrl) {
    $releasePageUrl = "https://github.com/" + $repo + "/releases/tag/" + $tagName
    $baseDownload   = "https://github.com/" + $repo + "/releases/download/" + $tagName

    $notifyBody  = "Compass $tagName is now available for Windows.`n`n"
    $notifyBody += "Release notes: " + $releasePageUrl
    if ($msi) { $notifyBody += "`nMSI installer: " + $baseDownload + "/" + $msi.Name }
    if ($exe) { $notifyBody += "`nEXE installer: " + $baseDownload + "/" + $exe.Name }

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
    curl.exe -s -X POST "http://192.168.50.149:9305/notify" -H "Content-Type: application/json" -d ("@" + $tmpNotify)
    Write-Host ""
    Remove-Item $tmpNotify -Force
    Write-Host "Apprise notification sent"
} else {
    Write-Host "APPRISE_DISCORD_URL secret not set - skipping Discord notification"
}

