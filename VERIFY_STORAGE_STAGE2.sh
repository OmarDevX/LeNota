#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v cargo >/dev/null 2>&1; then
    echo 'ERROR: Rust Cargo is required for Stage 2 native storage verification.' >&2
    echo 'Do not upgrade your primary LeNota workspace until native tests pass.' >&2
    exit 1
fi
printf '\n[1/4] Native SQLite/storage, revisions, backups, and sync tests\n'
cargo test -p app-database --lib
printf '\n[2/4] Frontend TypeScript and production build\n'
(cd apps/desktop && npm run build)
printf '\n[3/4] Stage 1 large-canvas regression tests\n'
(cd apps/desktop && npm run test:performance)
printf '\n[4/4] Editor and selection tests\n'
(cd apps/desktop && npm run test:math)
printf '\nAll checks passed. Back up your workspace before starting the new app.\n'
