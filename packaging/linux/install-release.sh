#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${DATA_DIR}/applications"
ICON_DIR="${DATA_DIR}/icons/hicolor/256x256/apps"
SYMBOLIC_ICON_DIR="${DATA_DIR}/icons/hicolor/scalable/apps"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

if [[ ! -x "$BUNDLE_DIR/clocked" ]]; then
  echo "The clocked binary is missing from $BUNDLE_DIR." >&2
  exit 1
fi
if ! command -v secret-tool >/dev/null; then
  echo "Missing secret-tool. On Arch/Omarchy, install the libsecret package." >&2
  exit 1
fi

install -Dm755 "$BUNDLE_DIR/clocked" "$BIN_DIR/clocked"
install -Dm644 "$BUNDLE_DIR/clocked.png" "$ICON_DIR/clocked.png"
install -Dm644 "$BUNDLE_DIR/clocked-symbolic.svg" \
  "$SYMBOLIC_ICON_DIR/clocked-symbolic.svg"

mkdir -p "$APP_DIR" "$AUTOSTART_DIR"
sed "s|@EXEC@|$BIN_DIR/clocked|g" "$BUNDLE_DIR/clocked.desktop.in" \
  > "$APP_DIR/clocked.desktop"
cp "$APP_DIR/clocked.desktop" "$AUTOSTART_DIR/clocked.desktop"

if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed clocked to $BIN_DIR/clocked"
echo "Enabled start at login: $AUTOSTART_DIR/clocked.desktop"

