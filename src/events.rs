//! Pure mapping from OS power/session notifications to clock actions.
//! Kept free of window/run-loop plumbing so the policy is obvious and testable.

pub enum Action {
    ClockIn(&'static str),
    /// The computer became unavailable because it locked or suspended. Unlike
    /// an idle clock-out, this starts a new physical open cycle.
    Close(&'static str),
    Ignore,
}

#[cfg(windows)]
pub use windows_impl::{map_power, map_session};

#[cfg(target_os = "macos")]
pub use macos_impl::{map_notification, DID_WAKE, SCREEN_LOCKED, SCREEN_UNLOCKED, WILL_SLEEP};

#[cfg(windows)]
mod windows_impl {
    use super::Action;
    use windows::Win32::UI::WindowsAndMessaging::{
        PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };

    /// `wParam` of `WM_POWERBROADCAST`.
    pub fn map_power(event: u32) -> Action {
        match event {
            PBT_APMSUSPEND => Action::Close("suspend"),
            PBT_APMRESUMEAUTOMATIC => Action::ClockIn("resume"),
            _ => Action::Ignore,
        }
    }

    /// `wParam` of `WM_WTSSESSION_CHANGE`.
    pub fn map_session(event: u32) -> Action {
        match event {
            WTS_SESSION_LOCK => Action::Close("lock"),
            WTS_SESSION_UNLOCK => Action::ClockIn("unlock"),
            _ => Action::Ignore,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn lock_and_suspend_are_close_boundaries() {
            assert!(matches!(
                map_session(WTS_SESSION_LOCK),
                Action::Close("lock")
            ));
            assert!(matches!(
                map_power(PBT_APMSUSPEND),
                Action::Close("suspend")
            ));
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::Action;

    // Sleep/wake arrive on NSWorkspace's notification center; lock/unlock arrive
    // as distributed notifications. clocked observes all four (see `macos`).
    pub const WILL_SLEEP: &str = "NSWorkspaceWillSleepNotification";
    pub const DID_WAKE: &str = "NSWorkspaceDidWakeNotification";
    pub const SCREEN_LOCKED: &str = "com.apple.screenIsLocked";
    pub const SCREEN_UNLOCKED: &str = "com.apple.screenIsUnlocked";

    /// Map an observed notification name to a clock action.
    pub fn map_notification(name: &str) -> Action {
        match name {
            WILL_SLEEP => Action::Close("suspend"),
            DID_WAKE => Action::ClockIn("resume"),
            SCREEN_LOCKED => Action::Close("lock"),
            SCREEN_UNLOCKED => Action::ClockIn("unlock"),
            _ => Action::Ignore,
        }
    }
}
