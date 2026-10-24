#!/usr/bin/env bash
set -euo pipefail

lenota_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$lenota_project_dir/apps/desktop"

exec npm run tauri:safe-renderer -- dev
