//! Lightweight manual update checking.
//!
//! The app does not self-install updates. It checks the public GitHub latest
//! release in the background and, when a newer version exists, the tray menu
//! turns into a link to the hosted latest-installer redirect.

use std::time::Duration;

#[cfg(windows)]
use core::ffi::c_void;
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

pub const DOWNLOAD_URL: &str = "https://clocked.daviddusi.com/download";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/DaveDushi/clocked/releases/latest";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

// `Checking`/`Failed` drive the Windows tray-menu states; macOS only acts on
// `Available`, so those variants read as unconstructed there.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateStatus {
    Unknown,
    Checking,
    UpToDate {
        version: String,
    },
    Available {
        version: String,
        download_url: String,
    },
    Failed,
}

// These render the Windows tray-menu update entry; macOS notifies via osascript
// instead, so they're unused there.
#[cfg_attr(not(windows), allow(dead_code))]
impl UpdateStatus {
    pub fn menu_label(&self) -> String {
        match self {
            UpdateStatus::Unknown | UpdateStatus::Failed => {
                format!("Check for updates • {}", display_version(CURRENT_VERSION))
            }
            UpdateStatus::Checking => "Checking for updates…".to_string(),
            UpdateStatus::UpToDate { version } => {
                format!("Up to date • {}", display_version(version))
            }
            UpdateStatus::Available { version, .. } => {
                format!("Download latest update • {}", display_version(version))
            }
        }
    }

    pub fn menu_enabled(&self) -> bool {
        !matches!(self, UpdateStatus::Checking | UpdateStatus::UpToDate { .. })
    }

    /// How the menu should present this status given how long ago the check ran.
    /// A successful "up to date" is shown as-is (a disabled status line) for a
    /// while, then reverts to an actionable "check for updates" so the user can
    /// re-check. `since_check` is `None` if no check has completed yet.
    pub fn for_menu(&self, since_check: Option<Duration>, ttl: Duration) -> UpdateStatus {
        match self {
            UpdateStatus::UpToDate { .. } if since_check.map_or(true, |e| e >= ttl) => {
                UpdateStatus::Unknown
            }
            other => other.clone(),
        }
    }

    pub fn download_url(&self) -> Option<&str> {
        match self {
            UpdateStatus::Available { download_url, .. } => Some(download_url),
            _ => None,
        }
    }
}

/// Payload posted back to the Windows message loop by `spawn`. Windows-only.
#[cfg(windows)]
pub struct UpdateCheckResult {
    pub manual: bool,
    pub status: UpdateStatus,
}

/// Windows-only: check in the background and signal the message loop. The
/// version-fetch/compare logic (`check_latest`) is portable; macOS will drive it
/// from its own run loop.
#[cfg(windows)]
pub fn spawn(hwnd_raw: isize, done_msg: u32, manual: bool) {
    std::thread::spawn(move || {
        let status = match check_latest() {
            Ok(status) => status,
            Err(e) => {
                crate::logln!("update check error: {e}");
                UpdateStatus::Failed
            }
        };
        let result = Box::new(UpdateCheckResult { manual, status });
        unsafe {
            let hwnd = HWND(hwnd_raw as *mut c_void);
            let ptr = Box::into_raw(result);
            let _ = PostMessageW(Some(hwnd), done_msg, WPARAM(ptr as usize), LPARAM(0));
        }
    });
}

pub(crate) fn check_latest() -> Result<UpdateStatus, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let value: serde_json::Value = client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, "clocked")
        .send()?
        .error_for_status()?
        .json()?;
    let latest = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("latest release has no tag_name")?;

    if is_newer_version(latest, CURRENT_VERSION) {
        Ok(UpdateStatus::Available {
            version: normalize_version(latest),
            download_url: DOWNLOAD_URL.to_string(),
        })
    } else {
        Ok(UpdateStatus::UpToDate {
            version: normalize_version(CURRENT_VERSION),
        })
    }
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);
    let len = latest.len().max(current.len());
    for i in 0..len {
        let a = *latest.get(i).unwrap_or(&0);
        let b = *current.get(i).unwrap_or(&0);
        if a != b {
            return a > b;
        }
    }
    false
}

fn normalize_version(version: &str) -> String {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .trim()
        .to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn display_version(version: &str) -> String {
    format!("v{}", normalize_version(version))
}

fn version_parts(version: &str) -> Vec<u64> {
    normalize_version(version)
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_label_changes_when_update_is_available() {
        let status = UpdateStatus::Available {
            version: "0.2.0".to_string(),
            download_url: DOWNLOAD_URL.to_string(),
        };

        assert_eq!(status.menu_label(), "Download latest update • v0.2.0");
        assert!(status.menu_enabled());
        assert_eq!(status.download_url(), Some(DOWNLOAD_URL));
    }

    #[test]
    fn menu_label_starts_as_check_for_updates() {
        assert_eq!(
            UpdateStatus::Unknown.menu_label(),
            format!("Check for updates • v{}", env!("CARGO_PKG_VERSION"))
        );
        assert!(UpdateStatus::Unknown.menu_enabled());
    }

    #[test]
    fn up_to_date_menu_item_is_status_only() {
        let status = UpdateStatus::UpToDate {
            version: "0.1.0".to_string(),
        };

        assert_eq!(status.menu_label(), "Up to date • v0.1.0");
        assert!(!status.menu_enabled());
    }

    #[test]
    fn up_to_date_reverts_to_checkable_after_ttl() {
        let ttl = Duration::from_secs(30 * 60);
        let uptodate = UpdateStatus::UpToDate {
            version: "0.1.2".to_string(),
        };
        // Just checked: keep showing the disabled "up to date" status line.
        let fresh = uptodate.for_menu(Some(Duration::from_secs(60)), ttl);
        assert_eq!(fresh, uptodate);
        assert!(!fresh.menu_enabled());
        // Past the TTL: revert to an actionable "check for updates".
        let stale = uptodate.for_menu(Some(ttl), ttl);
        assert_eq!(stale, UpdateStatus::Unknown);
        assert!(stale.menu_enabled());
        assert!(stale.menu_label().starts_with("Check for updates"));
        // No check on record yet also presents as checkable.
        assert_eq!(uptodate.for_menu(None, ttl), UpdateStatus::Unknown);
    }

    #[test]
    fn available_and_failed_ignore_the_ttl() {
        let ttl = Duration::from_secs(30 * 60);
        let avail = UpdateStatus::Available {
            version: "0.2.0".to_string(),
            download_url: DOWNLOAD_URL.to_string(),
        };
        assert_eq!(avail.for_menu(Some(Duration::from_secs(9999)), ttl), avail);
        assert_eq!(
            UpdateStatus::Failed.for_menu(Some(Duration::from_secs(9999)), ttl),
            UpdateStatus::Failed
        );
    }

    #[test]
    fn semantic_version_compare_handles_v_prefix() {
        assert!(is_newer_version("v0.2.0", "0.1.9"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(!is_newer_version("v0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "0.2.0"));
    }
}
