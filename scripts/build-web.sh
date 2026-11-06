#!/bin/bash
# Bundles the web UI into the given directory. Called by the Xcode build.
set -euo pipefail

OUT_DIR="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null; then
  echo "error: bun is required to bundle the web UI (https://bun.sh)" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
bun build "$ROOT/src/mainview/index.ts" --target=browser --outdir="$OUT_DIR"
cp "$ROOT/src/mainview/index.html" "$ROOT/src/mainview/index.css" "$OUT_DIR/"
