#!/usr/bin/env bash

set -euo pipefail

# Deploy built plugin files from ./dist to the target Obsidian plugin folder.
# - Overwrites existing built files (main.js, styles.css, manifest.json)
# - Does NOT delete or modify other files like data.json or embeddings.json
#
# Usage:
#   scripts/deploy-to-obsidian.sh [--skip-build] [--target=/path/to/plugin]
#   scripts/deploy-to-obsidian.sh [/path/to/plugin]
#
# Defaults:
#   Builds with `bun run build` and targets:
#   $HOME/Documents/Knowledge/Vault/Palace/.obsidian/plugins/obsidian-better-command-palette

DEFAULT_TARGET_DIR="/Users/stellar/Local/Documents/Palace/.obsidian/plugins/obsidian-better-command-palette"
TARGET_DIR="$DEFAULT_TARGET_DIR"
SKIP_BUILD=0
SOURCE_DIR="dist"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --target=*)
      TARGET_DIR="${arg#*=}"
      ;;
    *)
      # If a positional path is provided, treat it as target dir
      if [[ -z "${arg:-}" ]]; then
        : # ignore
      else
        TARGET_DIR="$arg"
      fi
      ;;
  esac
done

echo "Deploying to: $TARGET_DIR"

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "Error: bun is required to build. Install bun or run with --skip-build." >&2
    exit 1
  fi
  echo "Building plugin with: bun run build"
  bun run build
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: build output directory '$SOURCE_DIR' not found. Did the build succeed?" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is required for safe deploy. Please install rsync and try again." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

# Copy built files into the target directory, overwriting existing ones
# while preserving other files (e.g., data.json, embeddings.json).
rsync -av \
  --exclude 'data.json' \
  --exclude 'embeddings.json' \
  "$SOURCE_DIR"/ "$TARGET_DIR"/

echo "✅ Deploy complete. Files from '$SOURCE_DIR' are now in '$TARGET_DIR'."

