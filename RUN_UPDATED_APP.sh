#!/usr/bin/env bash
set -euo pipefail

lenota_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$lenota_project_dir/apps/desktop"

# Older LeNota launchers forced this compatibility switch on. Clear an
# inherited value so the normal launcher can use the accelerated WebKit path.
unset WEBKIT_DISABLE_DMABUF_RENDERER

exec npm run tauri -- dev
