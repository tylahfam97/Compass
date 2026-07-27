#!/bin/bash
# Normalizes Apple code-signing secrets, treating blank/"N/A" placeholder values as genuinely
# unset - called from .github/workflows/build.yml (build-macos job).
# Env vars required: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
# APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#
# Until a real Apple Developer ID is plugged in, these secrets are placeholder "N/A" values -
# normalize them (and any blank/whitespace-only value) to being genuinely UNSET, not just an
# empty string. Tauri's bundler checks whether e.g. APPLE_CERTIFICATE is *present* in the
# environment at all - an empty string still counts as "present", so it still tries (and fails)
# to import an empty certificate into the keychain. Skipping the export line entirely leaves
# the var truly absent. Swapping in real secret values later needs no workflow changes - this
# script just passes them through unchanged once they're real.
set -euo pipefail

for VAR in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  VAL="${!VAR}"
  NORMALIZED=$(echo "$VAL" | tr '[:upper:]' '[:lower:]' | xargs)
  if [ -n "$NORMALIZED" ] && [ "$NORMALIZED" != "n/a" ]; then
    echo "$VAR=$VAL" >> "$GITHUB_ENV"
  fi
  # else: real value missing/"N/A" - intentionally do NOT export anything, leaving
  # the var genuinely unset (not just empty) for the build step below.
done
