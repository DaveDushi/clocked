//! Start-at-login via the per-user `HKCU\...\Run` registry key (no admin needed).

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "clocked";

fn run_key() -> std::io::Result<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_PATH, KEY_READ | KEY_WRITE)
}

/// True if we're registered to launch at login.
pub fn is_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_PATH)
        .and_then(|k| k.get_value::<String, _>(VALUE_NAME))
        .is_ok()
}

pub fn enable() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    // Quote the path so spaces in the exe location are handled.
    let value = format!("\"{}\"", exe.display());
    run_key()?.set_value(VALUE_NAME, &value)
}

pub fn disable() -> std::io::Result<()> {
    match run_key()?.delete_value(VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn toggle() {
    let r = if is_enabled() { disable() } else { enable() };
    if let Err(e) = r {
        crate::logln!("autostart toggle error: {e}");
    }
}
