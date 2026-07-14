//! Foreground-window capture: the executable name and window title of the app
//! the user is currently focused on. The rules engine turns this into a project
//! so each heartbeat's time can be attributed to what the user was doing.
//!
//! Fails open (returns `None`) on any query failure so a bad read never crashes
//! the heartbeat or attributes time to the wrong app.

// Consumed only by the Windows UI layer today; the macOS build sees the stub as
// dead code. Keep that build warning-clean without hiding real dead code on
// Windows (where these are used).
#![cfg_attr(not(windows), allow(dead_code))]

/// The focused app this instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreground {
    /// Executable file name, lowercased (e.g. `"code.exe"`). Empty if unknown.
    pub app: String,
    /// Window title as shown in the title bar. Empty if none.
    pub title: String,
}

#[cfg(windows)]
pub use windows_impl::foreground;

#[cfg(not(windows))]
pub use stub::foreground;

#[cfg(windows)]
mod windows_impl {
    //! Read the foreground window (`GetForegroundWindow`), its title
    //! (`GetWindowTextW`), and the owning process's executable
    //! (`QueryFullProcessImageNameW`). `PROCESS_QUERY_LIMITED_INFORMATION` is the
    //! least-privileged access that still resolves the image path, so this works
    //! for elevated-owned windows too.

    use super::Foreground;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    // Windows' legacy path cap; long-path executables are rare enough that a
    // truncated read here only affects the file *name* we key rules on.
    const MAX_PATH: usize = 260;

    pub fn foreground() -> Option<Foreground> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            let title = window_title(hwnd);
            let app = window_app(hwnd).unwrap_or_default();
            if app.is_empty() && title.is_empty() {
                return None;
            }
            Some(Foreground { app, title })
        }
    }

    unsafe fn window_title(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        // +1 for the null terminator GetWindowTextW writes.
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    unsafe fn window_app(hwnd: HWND) -> Option<String> {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; MAX_PATH];
        let mut size = buf.len() as u32;
        let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        res.ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or(path.as_str());
        Some(name.to_ascii_lowercase())
    }
}

#[cfg(not(windows))]
mod stub {
    use super::Foreground;

    /// No foreground capture off Windows yet; the rules engine simply records no
    /// samples. macOS support is a tracked follow-up.
    pub fn foreground() -> Option<Foreground> {
        None
    }
}
