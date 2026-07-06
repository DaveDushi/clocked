//! Idle detection via the Win32 last-input timer.
//!
//! `GetLastInputInfo` reports the tick (ms since boot) of the most recent
//! keyboard/mouse input in this session. Comparing it to the current tick gives
//! how long the machine has been idle. Both are 32-bit tick counts that wrap
//! roughly every 49 days, so the subtraction must be wrapping.

use std::time::Duration;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// Time since the last keyboard/mouse input. Fails open (returns
/// `Duration::ZERO`) so a failed query never reports the user as idle.
pub fn idle_duration() -> Duration {
    let mut lii = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut lii).as_bool() {
            let idle_ms = GetTickCount().wrapping_sub(lii.dwTime);
            Duration::from_millis(idle_ms as u64)
        } else {
            Duration::ZERO
        }
    }
}
