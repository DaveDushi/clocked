//! Pure mapping from Windows power/session notifications to clock actions.
//! Kept free of window plumbing so the policy is obvious and testable.

use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
};

pub enum Action {
    ClockIn(&'static str),
    ClockOut(&'static str),
    Ignore,
}

/// `wParam` of `WM_POWERBROADCAST`.
pub fn map_power(event: u32) -> Action {
    match event {
        PBT_APMSUSPEND => Action::ClockOut("suspend"),
        PBT_APMRESUMEAUTOMATIC => Action::ClockIn("resume"),
        _ => Action::Ignore,
    }
}

/// `wParam` of `WM_WTSSESSION_CHANGE`.
pub fn map_session(event: u32) -> Action {
    match event {
        WTS_SESSION_LOCK => Action::ClockOut("lock"),
        WTS_SESSION_UNLOCK => Action::ClockIn("unlock"),
        _ => Action::Ignore,
    }
}
