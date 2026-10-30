#!/usr/bin/env bash
# dsh-multi-shell is plain ESM with no build step: this script is the whole
# "build" — syntax-check the runtime files and run the offline unit tests.
# It is what `npm run check` and `prepublishOnly` call.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== node --check ==="
node --check lib/index.js
node --check lib/shells.js

echo "=== unit tests ==="
node --test test/shells.test.mjs

echo "=== package contents (npm pack dry run) ==="
npm pack --dry-run
