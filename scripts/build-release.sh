#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION="$(node -p "require('$PROJECT_DIR/extension/manifest.json').version")"
DIST_DIR="$PROJECT_DIR/dist"
STAGE_DIR="$(mktemp -d)"
PACKAGE_DIR="$STAGE_DIR/video-subtitle-extractor-v$VERSION-macos"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$PACKAGE_DIR" "$DIST_DIR"
cp "$PROJECT_DIR/README.md" "$PROJECT_DIR/LICENSE" "$PROJECT_DIR/SECURITY.md" "$PACKAGE_DIR/"
cp "$PROJECT_DIR/install-macos.command" "$PROJECT_DIR/uninstall-macos.command" "$PACKAGE_DIR/"
cp -R "$PROJECT_DIR/extension" "$PROJECT_DIR/native-host" "$PACKAGE_DIR/"
rm -rf "$PACKAGE_DIR/native-host/tests" "$PACKAGE_DIR/native-host/__pycache__"
chmod 755 "$PACKAGE_DIR/install-macos.command" "$PACKAGE_DIR/uninstall-macos.command"

cd "$STAGE_DIR"
zip -qr "$DIST_DIR/video-subtitle-extractor-v$VERSION-macos.zip" "$(basename "$PACKAGE_DIR")"
cd "$DIST_DIR"
shasum -a 256 "video-subtitle-extractor-v$VERSION-macos.zip" > "SHA256SUMS.txt"

printf 'Built %s\n' "$DIST_DIR/video-subtitle-extractor-v$VERSION-macos.zip"
