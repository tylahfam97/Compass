# GitHub release publisher - called from .github/workflows/build.yml
# Env vars required: GH_TOKEN, APP_VERSION, GH_REPO

# Force TLS 1.2 — PowerShell 5.1 defaults to TLS 1.0 which GitHub rejects
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$version = $env:APP_VERSION
$token   = $env:GH_TOKEN
$repo    = $env:GH_REPO
$tagName = "v" + $version

if (-not $token) {
    Write-Error "GH_TOKEN is empty - check the GITHUB_TOKEN secret in repo settings"
    exit 1
}

Write-Host "Publishing $tagName for $repo (token length: $($token.Length))"

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

# Delete existing release for this tag if one exists
$existing = Invoke-Api "GET" ($api + "/releases/tags/" + $tagName)
if ($existing.id) {
    Invoke-Api "DELETE" ($api + "/releases/" + $existing.id) | Out-Null
    Write-Host "Removed existing release $tagName (ID $($existing.id))"
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

# Create the release — GitHub creates the tag at HEAD automatically
$releaseJson = (@{
    tag_name               = $tagName
    name                   = "Compass " + $tagName
    body                   = "Compass " + $tagName + " Windows installer."
    draft                  = $false
    prerelease             = $false
    generate_release_notes = $false
} | ConvertTo-Json -Compress)

$release   = Invoke-Api "POST" ($api + "/releases") $releaseJson
$releaseId = $release.id

if (-not $releaseId) {
    Write-Error "Failed to create release: $($release | ConvertTo-Json -Compress)"
    exit 1
}

Write-Host "Created release $tagName (ID $releaseId)"

# Brief pause so GitHub's API fully registers the new release before we upload assets
Start-Sleep -Seconds 3

$uploadBase = "https://uploads.github.com/repos/" + $repo + "/releases/" + $releaseId + "/assets"

# Helper: upload a file via curl.exe (reliable for large binaries; avoids PowerShell HTTP client TLS quirks)
function Upload-Asset($filePath, $assetName) {
    $url = $uploadBase + "?name=" + $assetName
    $result = curl.exe -s -w "%{http_code}" -X POST `
        -H ("Authorization: Bearer " + $token) `
        -H "Accept: application/vnd.github+json" `
        -H "X-GitHub-Api-Version: 2022-11-28" `
        -H "Content-Type: application/octet-stream" `
        "--data-binary" "@$filePath" $url
    $httpCode = $result[-3..-1] -join ''
    if ($httpCode -notmatch '^2') {
        Write-Warning "Upload of $assetName returned HTTP $httpCode"
    } else {
        Write-Host "Uploaded $assetName (HTTP $httpCode)"
    }
}

# Upload MSI
$msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msi) { Upload-Asset $msi.FullName $msi.Name } else { Write-Warning "No MSI found in bundle output" }

# Upload EXE (NSIS)
$exe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) { Upload-Asset $exe.FullName $exe.Name } else { Write-Warning "No EXE found in bundle output" }

# Upload NSIS zip (used by the in-app auto-updater) + generate latest.json
Write-Host "NSIS bundle directory:"
Get-ChildItem "src-tauri\target\release\bundle\nsis\" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length/1KB))KB)" }
$nsisZip = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$nsisSig = if ($nsisZip) { Get-Item ($nsisZip.FullName + ".sig") -ErrorAction SilentlyContinue } else { $null }

if ($nsisZip -and $nsisSig) {
    Upload-Asset $nsisZip.FullName $nsisZip.Name
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
    Upload-Asset $tmpJson "latest.json"
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

