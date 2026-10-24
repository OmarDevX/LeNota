#!/usr/bin/env bash
set -euo pipefail

lenota_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$lenota_project_dir/apps/desktop"
# Honor an explicitly selected WebKit renderer. Set LENOTA_SAFE_RENDERER=1
# if the machine's DMA-BUF graphics driver still leaves stale canvas tiles.
if [[ "${LENOTA_SAFE_RENDERER:-0}" == "1" ]]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

if [[ ! -f node_modules/@tauri-apps/cli/tauri.js ]]; then
  npm ci
fi

# Explicitly build for this machine. This also makes the executable path
# predictable if a different build.target was previously configured in Cargo.
lenota_host_target="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$lenota_host_target" ]]; then
  echo "Could not determine the native Rust target." >&2
  exit 1
fi

npm run tauri -- build --no-bundle --target "$lenota_host_target"

lenota_binary_path="$(cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 | python3 -c '
import json, pathlib, sys
metadata = json.load(sys.stdin)
package = next(item for item in metadata["packages"] if item["name"] == "lenota-desktop")
binary = next(target["name"] for target in package["targets"] if "bin" in target["kind"])
print(pathlib.Path(metadata["target_directory"]) / sys.argv[1] / "release" / binary)
' "$lenota_host_target")"

exec "$lenota_binary_path" "$@"
