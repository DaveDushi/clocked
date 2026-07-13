#!/usr/bin/env bash
# Build a distributable macOS clocked.app + clocked.dmg.
#
# Runs on macOS only (uses lipo/codesign/hdiutil/xcrun). Signing and notarization
# are opt-in via environment variables so a plain `./build-app.sh` still produces
# an unsigned .app/.dmg for local testing.
#
# Env:
#   DEVELOPER_ID     e.g. "Developer ID Application: Your Name (TEAMID)".
#                    If unset, the app is left unsigned (local testing only).
#   NOTARY_PROFILE   `xcrun notarytool` keychain profile name. If set (and signed),
#                    the .dmg is submitted for notarization and stapled.
#
# Output: dist/clocked.app and dist/clocked-<version>.dmg
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root
PKG=packaging/macos
OUT=dist
APP="$OUT/clocked.app"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
echo "clocked $VERSION"

# 1. Compile a universal binary (Intel + Apple Silicon).
rustup target add x86_64-apple-darwin aarch64-apple-darwin >/dev/null 2>&1 || true
cargo build --release --target x86_64-apple-darwin
cargo build --release --target aarch64-apple-darwin

# 2. Assemble the .app bundle.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create \
  target/x86_64-apple-darwin/release/clocked \
  target/aarch64-apple-darwin/release/clocked \
  -output "$APP/Contents/MacOS/clocked"

# Info.plist with the real version stamped in.
sed "s/>0\.0\.0</>$VERSION</g" "$PKG/Info.plist" > "$APP/Contents/Info.plist"

# Icon: convert assets/clocked.ico -> .icns if a prebuilt .icns isn't checked in.
if [ -f "$PKG/clocked.icns" ]; then
  cp "$PKG/clocked.icns" "$APP/Contents/Resources/clocked.icns"
else
  echo "WARN: $PKG/clocked.icns missing — app will use the default icon."
fi

# 3. Sign (hardened runtime) if a Developer ID is provided.
if [ -n "${DEVELOPER_ID:-}" ]; then
  echo "Signing with: $DEVELOPER_ID"
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$PKG/entitlements.plist" \
    --sign "$DEVELOPER_ID" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
else
  echo "DEVELOPER_ID unset — leaving app unsigned (local testing only)."
fi

# 4. Build the .dmg. Stable filename (version lives in Info.plist) so the landing
# page's /releases/latest/download/clocked-setup.dmg URL always resolves.
DMG="$OUT/clocked-setup.dmg"
rm -f "$DMG"
hdiutil create -volname "clocked" -srcfolder "$APP" -ov -format UDZO "$DMG"

# 5. Notarize + staple if requested (requires a signed app).
if [ -n "${NOTARY_PROFILE:-}" ] && [ -n "${DEVELOPER_ID:-}" ]; then
  echo "Notarizing $DMG…"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
else
  echo "Notarization skipped (set NOTARY_PROFILE + DEVELOPER_ID to enable)."
fi

echo "Done: $APP and $DMG"
