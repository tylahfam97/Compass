# GitHub release publisher - called from .github/workflows/build.yml
# Env vars required: GH_TOKEN, APP_VERSION, GH_REPO

$version = $env:APP_VERSION
$token   = $env:GH_TOKEN
$repo    = $env:GH_REPO
$tagName = "v" + $version

if (-not $token) {
    Write-Error "GH_TOKEN is empty - check that secrets.GITHUB_TOKEN is available"
    exit 1
}

Write-Host "Publishing $tagName for $repo"

$api     = "https://api.github.com/repos/" + $repo
$authH   = "Authorization: token " + $token
$acceptH = "Accept: application/vnd.github+json"
$agentH  = "User-Agent: Compass-Release-Script"
$apiVerH = "X-GitHub-Api-Version: 2022-11-28"

# Delete existing release and tag if they already exist
$existingJson = curl.exe -s ($api + "/releases/tags/" + $tagName) -H $authH -H $acceptH -H $agentH
$existing = $existingJson | ConvertFrom-Json
if ($existing.id) {
    curl.exe -s -X DELETE ($api + "/releases/" + $existing.id) -H $authH -H $acceptH -H $agentH | Out-Null
    curl.exe -s -X DELETE ($api + "/git/refs/tags/" + $tagName) -H $authH -H $acceptH -H $agentH | Out-Null
    Write-Host "Removed existing release and tag $tagName"
}

# Write release JSON body to temp file (avoids shell quoting issues)
$body = '{"tag_name":"' + $tagName + '","name":"Compass ' + $tagName + '","body":"Compass ' + $tagName + ' Windows installer - includes MSI and EXE.","draft":false,"prerelease":false}'
$tmp  = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding $false))

$releaseRaw = curl.exe -s -X POST ($api + "/releases") -H $authH -H $acceptH -H $agentH -H $apiVerH -H "Content-Type: application/json" -d ("@" + $tmp)
Remove-Item $tmp -Force

Write-Host "API response: $releaseRaw"
$release   = $releaseRaw | ConvertFrom-Json
$releaseId = $release.id

if (-not $releaseId) {
    Write-Error "Failed to create release - see API response above"
    exit 1
}

Write-Host "Created release $tagName (ID $releaseId)"

# GitHub binary asset uploads go to uploads.github.com, not api.github.com
$uploadBase = "https://uploads.github.com/repos/" + $repo + "/releases/" + $releaseId + "/assets"

# Upload MSI
$msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msi) {
    curl.exe -s -X POST ($uploadBase + "?name=" + $msi.Name) `
        -H $authH -H $acceptH -H $agentH `
        -H "Content-Type: application/octet-stream" `
        --data-binary ("@" + $msi.FullName) | Out-Null
    Write-Host "Uploaded $($msi.Name)"
} else {
    Write-Warning "No MSI found in bundle output"
}

# Upload EXE (NSIS)
$exe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    curl.exe -s -X POST ($uploadBase + "?name=" + $exe.Name) `
        -H $authH -H $acceptH -H $agentH `
        -H "Content-Type: application/octet-stream" `
        --data-binary ("@" + $exe.FullName) | Out-Null
    Write-Host "Uploaded $($exe.Name)"
} else {
    Write-Warning "No EXE found in bundle output"
}

Write-Host "Release $tagName published"

