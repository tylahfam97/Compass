#!/bin/bash
# Reads the app version from tauri.conf.json, patches the __REPO__ updater endpoint
# placeholder, and computes the release tag name/prerelease flag for the macOS build - called
# from .github/workflows/build.yml (build-macos job).
# No env vars required - GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_ENV are all ambient env
# vars the runner already provides to every step.
set -euo pipefail

V=$(node -p "require('./src-tauri/tauri.conf.json').version")
echo "APP_VERSION=$V" >> "$GITHUB_ENV"

BRANCH="$GITHUB_REF_NAME"
if [ "$BRANCH" = "main" ]; then IS_PRERELEASE=false; else IS_PRERELEASE=true; fi
echo "IS_PRERELEASE=$IS_PRERELEASE" >> "$GITHUB_ENV"

if [ "$IS_PRERELEASE" = "true" ]; then
  SANITIZED=$(echo "$BRANCH" | sed -E 's/[^a-zA-Z0-9]+/-/g; s/^-+|-+$//g' | tr 'A-Z' 'a-z')
  echo "TAG_NAME=v$V-$SANITIZED" >> "$GITHUB_ENV"
else
  echo "TAG_NAME=v$V" >> "$GITHUB_ENV"
fi

node -e "
  const fs=require('fs'), p='src-tauri/tauri.conf.json';
  fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace(/__REPO__/g, '$GITHUB_REPOSITORY'));
"

echo "Building version $V for $GITHUB_REPOSITORY"
