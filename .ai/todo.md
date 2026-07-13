# macOS port — plan & progress

## Context
`clocked` is a native Rust + Win32 app (no cross-platform GUI framework). Goal: ship a
macOS build with parity. The Cloudflare Worker backend (`worker/`) is untouched — the Mac
app talks to the same HTTPS API. Strategy: keep one Rust codebase, `cfg`-gate the OS glue,
reimplement each platform module natively (Cocoa/IOKit via `objc2`/`core-graphics`/`security-framework`).

Hard constraint: this dev machine is Windows, so **macOS code cannot be compiled/notarized here** —
only the Windows build + shared unit tests are verifiable locally. Mac binary is produced on a
macOS CI runner. Every step must keep the Windows build green (baseline: builds + 21 tests pass).

## The only shared→platform coupling
`config.rs` → `secret` (token storage). Everything else platform-specific (`idle`, `media`,
`tray`, `autostart`, `keepalive`, window/run-loop) is consumed only from the platform UI layer.

## Steps

### Phase 1 — cross-platform foundation (DONE, Windows green: build + 30 tests)
- [x] Cargo.toml: `windows`/`winreg`/`winresource` under `[target.'cfg(windows)']`; macOS deps
      (`objc2`, `objc2-foundation`, `objc2-app-kit`, `security-framework`) under `cfg(target_os="macos")`.
      Idle links CoreGraphics directly (no core-graphics crate). Description de-Windows'd.
- [x] `secret.rs`: cfg-split — Windows DPAPI / macOS Keychain (`security_framework::passwords`).
- [x] `idle.rs`: cfg-split — Win32 `GetLastInputInfo` / macOS `CGEventSourceSecondsSinceLastEventType`.
- [x] `media.rs`: cfg-split — Windows registry / macOS fail-closed stub (real detection = TODO).
- [x] `autostart.rs`: cfg-split — HKCU Run / macOS LaunchAgent plist (RunAtLoad + KeepAlive).
- [x] `keepalive.rs`: cfg-split — schtasks / macOS delegates to the LaunchAgent.
- [x] `events.rs`: `Action` shared; Win32 mappings gated; macOS notification-name mapping added.
- [x] `main.rs`: Win32 UI gated `#[cfg(windows)]`; `#[cfg(target_os="macos")] mod macos`; per-platform dispatch.
- [x] Verified: Windows `cargo build` + `cargo test` green (30 passed).

### Phase 2 — shared engine (DONE, unit-tested on Windows)
- [x] `engine.rs`: pure clock/idle/reclaim/after-hours policy as intent-returning functions + 9 tests.
- [ ] FOLLOW-UP: migrate Windows `window.rs::AppState` onto `engine` to kill the duplicated policy
      (safe, testable on Windows — do before the two drift).

### Phase 3 — macOS UI layer (DONE; typechecks for aarch64-apple-darwin)
- [x] `macos/mod.rs`: portable `AppState` state machine driven by `engine` (clock/idle/after-hours/sync).
- [x] `macos/runloop.rs` `imp`: full objc2 AppKit run loop — `NSApplication` (accessory),
      `NSStatusItem` menu (Pause/Resume, Open timesheet, Sync now, Set sync token…, Start at login,
      Quit), `NSWorkspace` sleep/wake + distributed lock/unlock observers, `NSTimer`
      heartbeat/sync/update, `NSAlert` prompts, `performSelectorOnMainThread:` deferral.
- [x] Threading: sync guarded by a `Send` `AtomicBool` (no marshaling); notifications via `osascript`;
      token entry via `osascript` dialog; all objc2 touches on the main thread.
- [x] Verified WITHOUT a Mac: `cargo check --target aarch64-apple-darwin` compiles clean (0 warnings).
      Only framework LINKING is unverified until a real macOS build.
- [ ] On a Mac: `cargo build --target aarch64-apple-darwin`, run the `.app`, confirm the objc2
      method-name/mtm details noted in `runloop.rs` (e.g. `NSStatusItem::button(mtm)`, `NSAlert::new`).

### Phase 4 — packaging + CI (files DONE; secrets/icns pending)
- [x] `packaging/macos/Info.plist` (LSUIElement=1) + `entitlements.plist` (hardened runtime).
- [x] `packaging/macos/build-app.sh`: universal binary → `.app` → sign → `.dmg` → notarize+staple.
- [x] `.github/workflows/release.yml`: macOS sign+notarize+dmg job; Windows installer job.
- [x] macOS update check wired (osascript notification) reusing portable `update::check_latest`.
- [ ] Add `packaging/macos/clocked.icns` (convert `assets/clocked.ico`); set the 6 macOS repo secrets.
- [ ] Point the download page / `update::DOWNLOAD_URL` redirect at the macOS `.dmg`.

### Per-platform dependency notes (Cargo.toml)
- TLS: Windows = rustls (unchanged); macOS = native-tls (Security.framework, already linked for Keychain).
- SQLite: Windows = bundled; macOS = system libsqlite3.
- Both choices also let the macOS target typecheck on a Windows host (no `cc`/ring/bundled-sqlite C build).

## Testing
- Windows regression: `cargo test`, `cargo build`, run tray app, verify clock in/out unaffected.
- macOS (on a Mac): `cargo build --target aarch64-apple-darwin`, run `.app`, verify sleep/wake +
  lock/unlock clock in/out, idle, tray menu, Keychain token, launch-at-login.
