//! Start-at-login, per user, no admin required.
//! - Windows: the `HKCU\...\Run` registry value.
//! - macOS: a `LaunchAgent` plist in `~/Library/LaunchAgents`.

#[cfg(windows)]
pub use windows_impl::{disable, enable, is_enabled};

#[cfg(target_os = "macos")]
pub use macos_impl::{disable, enable, is_enabled};

/// The LaunchAgent label / Keychain-style bundle id, shared by autostart and
/// keepalive on macOS (they govern the same agent).
#[cfg(target_os = "macos")]
pub const LAUNCH_AGENT_LABEL: &str = "com.daviddusi.clocked";

#[cfg(windows)]
mod windows_impl {
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
}

#[cfg(target_os = "macos")]
mod macos_impl {
    //! One LaunchAgent covers both "start at login" (`RunAtLoad`) and "keep
    //! running" (`KeepAlive` — relaunch if the app quits). launchd has no direct
    //! screen-unlock trigger like the Windows scheduled task, but RunAtLoad +
    //! KeepAlive keeps tracking alive across logout/login and app exit.

    use std::path::PathBuf;
    use std::process::Command;

    use super::LAUNCH_AGENT_LABEL;

    pub(crate) fn plist_path() -> Option<PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/LaunchAgents")
                .join(format!("{LAUNCH_AGENT_LABEL}.plist")),
        )
    }

    pub fn is_enabled() -> bool {
        plist_path().map(|p| p.exists()).unwrap_or(false)
    }

    pub fn enable() -> std::io::Result<()> {
        let exe = std::env::current_exe()?;
        let path = plist_path()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no HOME"))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, plist(&exe.to_string_lossy()))?;
        // Best-effort load into the running GUI session so it takes effect now,
        // not only after the next login. Ignore "already loaded" style errors.
        let _ = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&path)
            .output();
        Ok(())
    }

    pub fn disable() -> std::io::Result<()> {
        let Some(path) = plist_path() else {
            return Ok(());
        };
        if path.exists() {
            let _ = Command::new("launchctl")
                .args(["unload", "-w"])
                .arg(&path)
                .output();
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn plist(exe: &str) -> String {
        let exe = xml_escape(exe);
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
"#
        )
    }
}
