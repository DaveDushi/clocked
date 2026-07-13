//! Idle detection: time since the last keyboard/mouse input.
//!
//! Fails open (returns `Duration::ZERO`) on any query failure so a bad read
//! never reports the user as idle and clocks them out.

#[cfg(windows)]
pub use windows_impl::idle_duration;

#[cfg(target_os = "macos")]
pub use macos_impl::idle_duration;

#[cfg(windows)]
mod windows_impl {
    //! `GetLastInputInfo` reports the tick (ms since boot) of the most recent
    //! keyboard/mouse input in this session. Comparing it to the current tick
    //! gives how long the machine has been idle. Both are 32-bit tick counts that
    //! wrap roughly every 49 days, so the subtraction must be wrapping.

    use std::time::Duration;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

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
}

#[cfg(target_os = "macos")]
mod macos_impl {
    //! `CGEventSourceSecondsSinceLastEventType` reports seconds since the last
    //! input event of a given type. Querying the HID system state for "any input"
    //! yields the system-wide idle time (keyboard + mouse), the direct analog of
    //! Windows' `GetLastInputInfo`. Linked directly against CoreGraphics so no
    //! third-party crate is required.

    use std::time::Duration;

    // CGEventSourceStateID: kCGEventSourceStateHIDSystemState = 1 (hardware input).
    const HID_SYSTEM_STATE: i32 = 1;
    // CGEventType: kCGAnyInputEventType = ~0, matching any input event.
    const ANY_INPUT_EVENT_TYPE: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    pub fn idle_duration() -> Duration {
        let secs =
            unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT_TYPE) };
        if secs.is_finite() && secs > 0.0 {
            Duration::from_secs_f64(secs)
        } else {
            Duration::ZERO
        }
    }
}
