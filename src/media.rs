//! "Is the user on a call?" detection.
//!
//! A live microphone or camera means the user is almost certainly in a
//! call/meeting, so a long stretch with no keyboard/mouse input shouldn't trip
//! the idle auto-clock-out. Every platform exposes the same `in_use()` predicate
//! and fails closed (reports "not in use") on bad data so detection never keeps
//! someone clocked in incorrectly.

#[cfg(windows)]
pub use windows_impl::in_use;

#[cfg(target_os = "macos")]
pub use macos_impl::in_use;

#[cfg(windows)]
mod windows_impl {
    //! Windows records which apps are actively using the microphone and camera
    //! under the CapabilityAccessManager ConsentStore. Each app subkey carries a
    //! `LastUsedTimeStop` value (a QWORD FILETIME) that is `0` while the device is
    //! *currently* in use, and a matching `LastUsedTimeStart`.
    //!
    //! Both packaged (UWP) apps — listed directly under the capability key — and
    //! win32 apps — listed under its `NonPackaged` subkey — are checked.

    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const CONSENT_STORE: &str =
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    /// True if the microphone or camera is in use right now.
    pub fn in_use() -> bool {
        capability_active("microphone") || capability_active("webcam")
    }

    /// A single app's usage record marks the device *in use now* when it has a
    /// real start time but no stop time yet.
    fn is_active(start: u64, stop: u64) -> bool {
        start != 0 && stop == 0
    }

    fn capability_active(capability: &str) -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(root) = hkcu.open_subkey(format!("{CONSENT_STORE}\\{capability}")) else {
            return false;
        };
        if any_app_active(&root) {
            return true;
        }
        // Win32 (non-Store) apps such as Zoom, Teams, Chrome, Edge live here.
        match root.open_subkey("NonPackaged") {
            Ok(non_packaged) => any_app_active(&non_packaged),
            Err(_) => false,
        }
    }

    fn any_app_active(parent: &RegKey) -> bool {
        parent.enum_keys().flatten().any(|name| {
            if name == "NonPackaged" {
                return false; // handled separately; not an app record
            }
            let Ok(app) = parent.open_subkey(&name) else {
                return false;
            };
            let start = app.get_value::<u64, _>("LastUsedTimeStart").unwrap_or(0);
            let stop = app.get_value::<u64, _>("LastUsedTimeStop").unwrap_or(1);
            is_active(start, stop)
        })
    }

    #[cfg(test)]
    mod tests {
        use super::is_active;

        #[test]
        fn active_only_with_a_start_and_no_stop() {
            // In use right now: started, not yet stopped.
            assert!(is_active(134281954183939941, 0));
            // Finished: has a stop time.
            assert!(!is_active(134281954183939941, 134281954433094372));
            // Never used / missing values: not active.
            assert!(!is_active(0, 0));
            assert!(!is_active(0, 1));
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    //! macOS call detection is not yet implemented. Returns `false` (fail-closed):
    //! a user on a call with no keyboard/mouse input will clock out on the normal
    //! idle timeout until real detection lands. Planned approach: query CoreAudio
    //! for an input device that is `kAudioDevicePropertyDeviceIsRunningSomewhere`,
    //! and CoreMediaIO for an active camera, mirroring the Windows semantics.

    pub fn in_use() -> bool {
        false
    }
}
