# Reads the app version from tauri.conf.json (the version source of truth - never overwritten
# here), patches the __REPO__ updater endpoint placeholder and keeps Cargo.toml's version in
# sync, and computes the release tag name/prerelease flag - called from
# .github/workflows/build.yml (create-compass job, step id "vars").
# No secrets/vars required - GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_ENV, GITHUB_OUTPUT are
# all ambient env vars the runner already provides to every step.

$v    = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$repo = $env:GITHUB_REPOSITORY

# Export version for the publish script
"APP_VERSION=$v" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

# Mark as prerelease on any branch other than main
$branch       = $env:GITHUB_REF_NAME
$isPrerelease = if ($branch -eq "main") { "false" } else { "true" }
"IS_PRERELEASE=$isPrerelease" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Branch: $branch | Prerelease: $isPrerelease"

# Tag name — mirrors publish-release.ps1's logic. Exposed as a job output so the
# dispatch-host-release job (which runs after both platform jobs finish) can host
# the exact tag without recomputing/duplicating this logic.
$tagName = if ($isPrerelease -eq "true") {
    $sanitized = ($branch -replace '[^a-zA-Z0-9]', '-') -replace '-{2,}', '-'
    "v" + $v + "-" + $sanitized.Trim('-').ToLower()
} else {
    "v" + $v
}
"tag_name=$tagName" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
"is_prerelease=$isPrerelease" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append

# Patch the updater endpoint placeholder
(Get-Content src-tauri\tauri.conf.json -Raw) -replace '__REPO__', $repo |
    Set-Content src-tauri\tauri.conf.json -NoNewline

# Keep Cargo.toml in sync
(Get-Content src-tauri\Cargo.toml -Raw) `
    -replace '(?m)^version\s*=\s*"[^"]*"', ('version = "' + $v + '"') |
    Set-Content src-tauri\Cargo.toml -NoNewline

Write-Host "Building version $v for $repo"
