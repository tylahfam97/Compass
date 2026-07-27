#!/bin/bash
# Dispatches host-release.yml via workflow_dispatch (GITHUB_TOKEN-created releases don't fire
# `release: published`, per GitHub's anti-recursion safeguard) - called from
# .github/workflows/build.yml (dispatch-host-release job).
# Env vars required: GH_TOKEN, TAG_NAME
# GITHUB_REPOSITORY and GITHUB_REF_NAME are ambient env vars the runner already provides.
set -euo pipefail

echo "Dispatching host-release.yml for $TAG_NAME"
curl -sf -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/workflows/host-release.yml/dispatches" \
  -d "{\"ref\":\"$GITHUB_REF_NAME\",\"inputs\":{\"tag_name\":\"$TAG_NAME\"}}"
