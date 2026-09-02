#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist"
ARCH="$(uname -m)"

if [[ "$ARCH" != "x86_64" ]]; then
  echo "Linux release packaging currently supports x86_64 only (found $ARCH)." >&2
  exit 1
fi

cd "$ROOT"
cargo build --release

STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$STAGE_ROOT"' EXIT
BUNDLE="$STAGE_ROOT/clocked-linux-x86_64"
mkdir -p "$BUNDLE" "$OUT"

install -Dm755 target/release/clocked "$BUNDLE/clocked"
install -Dm755 packaging/linux/install-release.sh "$BUNDLE/install.sh"
install -Dm644 packaging/linux/clocked.desktop.in "$BUNDLE/clocked.desktop.in"
install -Dm644 packaging/linux/clocked.png "$BUNDLE/clocked.png"
install -Dm644 packaging/linux/clocked-symbolic.svg "$BUNDLE/clocked-symbolic.svg"
install -Dm644 packaging/linux/RELEASE-README.md "$BUNDLE/README.md"

tar -C "$STAGE_ROOT" -czf "$OUT/clocked-linux-x86_64.tar.gz" \
  clocked-linux-x86_64
sha256sum "$OUT/clocked-linux-x86_64.tar.gz" \
  > "$OUT/clocked-linux-x86_64.tar.gz.sha256"

echo "Created $OUT/clocked-linux-x86_64.tar.gz"
echo "Created $OUT/clocked-linux-x86_64.tar.gz.sha256"
