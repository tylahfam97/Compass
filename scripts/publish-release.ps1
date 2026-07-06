# Gitea release publisher - called from .github/workflows/build.yml
# Env vars required: GITEA_TOKEN, APP_VERSION, GITEA_REPO

$version = $env:APP_VERSION
$token   = $env:GITEA_TOKEN
$repo    = $env:GITEA_REPO
$tagName = "v" + $version

if (-not $token) {
    Write-Error "GITEA_TOKEN is empty - check the GitHubToken secret in Gitea repo settings"
    exit 1
}

Write-Host "Publishing $tagName for $repo (token length: $($token.Length))"

$proto  = "https"
$api    = $proto + "://gitea.fameli.net/api/v1/repos/" + $repo
$authH  = "Authorization: token " + $token

# Delete existing release if one already exists for this tag
$existingJson = curl.exe -k -s ($api + "/releases/tags/" + $tagName) -H $authH
$existing = $existingJson | ConvertFrom-Json
if ($existing.id) {
    curl.exe -k -s -X DELETE ($api + "/releases/" + $existing.id) -H $authH | Out-Null
    Write-Host "Removed existing release $tagName"
}

# Build JSON body and write to temp file (avoids shell quoting issues)
$body = '{"tag_name":"' + $tagName + '","name":"Compass ' + $tagName + '","body":"Compass ' + $tagName + ' Windows installer - includes MSI and EXE.","draft":false,"prerelease":false}'
$tmp  = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($tmp, $body, (New-Object System.Text.UTF8Encoding $false))

$releaseRaw = curl.exe -k -s -X POST ($api + "/releases") -H $authH -H "Content-Type: application/json" -d ("@" + $tmp)
Remove-Item $tmp -Force

Write-Host "API response: $releaseRaw"
$release   = $releaseRaw | ConvertFrom-Json
$releaseId = $release.id

if (-not $releaseId) {
    Write-Error "Failed to create release - see API response above"
    exit 1
}

Write-Host "Created release $tagName (ID $releaseId)"

# Upload MSI
$msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msi) {
    curl.exe -k -s -X POST ($api + "/releases/" + $releaseId + "/assets?name=" + $msi.Name) `
        -H $authH -F ("attachment=@" + $msi.FullName) | Out-Null
    Write-Host "Uploaded $($msi.Name)"
} else {
    Write-Warning "No MSI found in bundle output"
}

# Upload EXE (NSIS)
$exe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    curl.exe -k -s -X POST ($api + "/releases/" + $releaseId + "/assets?name=" + $exe.Name) `
        -H $authH -F ("attachment=@" + $exe.FullName) | Out-Null
    Write-Host "Uploaded $($exe.Name)"
} else {
    Write-Warning "No EXE found in bundle output"
}

Write-Host "Release $tagName published"
