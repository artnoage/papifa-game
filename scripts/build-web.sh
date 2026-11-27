#!/usr/bin/env bash
# Thin wrapper around scripts/build-web.mjs (kept for release habits and existing tooling).
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec node "$repo/scripts/build-web.mjs" "$@"
