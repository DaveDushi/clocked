//! Lightweight manual update checking.
//!
//! The app does not self-install updates. It checks the public GitHub latest
//! release in the background and, when a newer version exists, the tray menu
//! turns into a link to the hosted latest-installer redirect.

use core::ffi::c_void;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

pub const DOWNLOAD_URL: &str = "https://clocked.daviddusi.com/download";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/DaveDushi/clocked/releases/latest";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

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

    pub fn download_url(&self) -> Option<&str> {
        match self {
            UpdateStatus::Available { download_url, .. } => Some(download_url),
            _ => None,
        }
    }
}

pub struct UpdateCheckResult {
    pub manual: bool,
    pub status: UpdateStatus,
}

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

fn check_latest() -> Result<UpdateStatus, Box<dyn std::error::Error>> {
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
    fn semantic_version_compare_handles_v_prefix() {
        assert!(is_newer_version("v0.2.0", "0.1.9"));
        assert!(is_newer_version("1.0.0", "0.9.9"));
        assert!(!is_newer_version("v0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "0.2.0"));
    }
}
