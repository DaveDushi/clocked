// No console window in release on Windows; keep it in debug for live logs.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[macro_use]
mod log;

// Portable core — compiles on every platform.
mod autostart;
mod config;
mod db;
mod events;
mod idle;
// "Keep running" relaunch is a Windows scheduled-task concept; on macOS the
// LaunchAgent's KeepAlive (see `autostart`) covers it, so the module is Win-only.
#[cfg(windows)]
mod keepalive;
mod media;
mod paths;
mod secret;
mod sync;
mod update;

// Shared clock/idle/after-hours policy the platform UI layers drive. Unit-tested
// on any host; consumed today by the macOS layer (Windows still uses its inline
// AppState — migrating it onto `engine` is a tracked follow-up).
mod engine;

// Windows UI layer: hidden Win32 window + message loop, tray, native settings.
#[cfg(windows)]
mod settings;
#[cfg(windows)]
mod tray;
#[cfg(windows)]
mod window;

// macOS UI layer: NSApplication run loop, status-bar item, workspace observers.
#[cfg(target_os = "macos")]
mod macos;

fn main() {
    logln!("clocked starting");
    if let Err(e) = run() {
        logln!("fatal: {e}");
    }
    logln!("clocked stopped");
}

#[cfg(windows)]
fn run() -> windows::core::Result<()> {
    window::run()
}

#[cfg(target_os = "macos")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    macos::run()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    Err("clocked supports Windows and macOS only".into())
}
