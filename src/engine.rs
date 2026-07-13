//! Platform-agnostic clock policy: the pure decisions behind automatic clock
//! in/out, extracted so every OS UI layer drives identical behavior and the
//! logic can be unit-tested without any windowing/run-loop plumbing.
//!
//! Each `decide_*` function takes a snapshot of the relevant state and returns an
//! *intent* the caller executes against the database, tray, and prompts. The
//! caller still owns side effects and the mutable flags (`idle_warned`,
//! `idle_out`, remembered after-hours answer, etc.).
//!
//! This mirrors the inline logic in the Windows `window.rs::AppState`; the
//! Windows layer will migrate onto these functions in a follow-up. Until then the
//! module is consumed only by the macOS layer, hence `allow(dead_code)` so the
//! Windows build stays warning-clean.
#![allow(dead_code)]

// Warn this many seconds before an idle auto-clock-out.
pub const IDLE_WARN_LEAD_SECS: u64 = 120;

// After an idle auto-clock-out, offer to reclaim the away time as worked when the
// gap sits in this range. Below the floor there's nothing worth asking about;
// above the ceiling it was almost certainly a genuine long absence.
pub const RECLAIM_MIN_SECS: i64 = 3 * 60;
pub const RECLAIM_MAX_SECS: i64 = 4 * 60 * 60;

// A live mic/camera only vouches for presence up to this long without any
// keyboard/mouse input. Beyond it, assume a call was left open and let the normal
// idle clock-out run so time isn't inflated.
pub const MEDIA_PRESENCE_MAX_SECS: u64 = 4 * 60 * 60;

/// What the heartbeat should do about the current idle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleDecision {
    /// Do nothing this tick.
    Nothing,
    /// On a call after an idle latch: clock back in with reason "call".
    ResumeFromCall,
    /// Idle past the timeout while clocked in: clock out "idle", backdated this
    /// many seconds (to the last input) so the dead time isn't counted.
    ClockOutIdle { backdate_secs: i64 },
    /// Input returned after an idle-out; the away gap is worth a reclaim prompt.
    PromptReclaim { idle_since_secs_ago: i64 },
    /// Input returned after an idle-out; just resume with reason "active".
    ResumeActive,
    /// Approaching the idle cutoff: warn once that we'll clock out soon.
    Warn { minutes_left: i64 },
}

/// Snapshot of the state `decide_idle` needs. Assembled by the caller each tick.
#[derive(Debug, Clone, Copy)]
pub struct IdleParams {
    pub paused: bool,
    pub timeout_secs: u64,
    pub idle_secs: u64,
    pub in_call: bool,
    pub clocked_in: bool,
    pub idle_out: bool,
    pub reclaim_pending: bool,
    pub idle_warned: bool,
    /// `Some(secs_ago)` when an idle-out latched after a real (non-empty)
    /// clock-out, giving the backdate anchor for a reclaim prompt.
    pub idle_since_secs_ago: Option<i64>,
}

/// Decide the idle action for this heartbeat. Pure — see module docs for the flag
/// management the caller must still perform.
pub fn decide_idle(p: &IdleParams) -> IdleDecision {
    if p.paused || p.timeout_secs == 0 {
        return IdleDecision::Nothing;
    }

    if p.idle_secs >= p.timeout_secs {
        // A live mic/camera means the user is on a call: count as present even
        // with no keyboard/mouse input, up to the presence cap.
        if p.idle_secs < MEDIA_PRESENCE_MAX_SECS && p.in_call {
            if p.idle_out && !p.reclaim_pending {
                return IdleDecision::ResumeFromCall;
            }
            return IdleDecision::Nothing;
        }
        if p.clocked_in {
            return IdleDecision::ClockOutIdle {
                backdate_secs: p.idle_secs as i64,
            };
        }
        return IdleDecision::Nothing;
    }

    // Below the timeout.
    if p.idle_out {
        if p.reclaim_pending {
            return IdleDecision::Nothing; // reclaim modal already up
        }
        if let Some(since_ago) = p.idle_since_secs_ago {
            if (RECLAIM_MIN_SECS..=RECLAIM_MAX_SECS).contains(&since_ago) {
                return IdleDecision::PromptReclaim {
                    idle_since_secs_ago: since_ago,
                };
            }
        }
        return IdleDecision::ResumeActive;
    }

    // Still counting time: warn once as we approach the cutoff, unless a live
    // mic/camera means we're on a call and won't clock out.
    let warn_at = p.timeout_secs.saturating_sub(IDLE_WARN_LEAD_SECS);
    if p.idle_secs >= warn_at && warn_at > 0 && !p.idle_warned && !p.in_call && p.clocked_in {
        let minutes_left = ((p.timeout_secs - p.idle_secs + 59) / 60) as i64;
        return IdleDecision::Warn { minutes_left };
    }
    IdleDecision::Nothing
}

/// What a "computer opened" moment (wake / unlock / app start) should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenDecision {
    /// Inside working hours or feature off: clock in and reset after-hours memory.
    ClockIn,
    /// After hours, already answered "working": clock in without asking again.
    ClockInAfterHours,
    /// After hours, answered "not working": stay clocked out.
    Skip,
    /// After hours, not yet answered: ask "are you working?".
    Prompt,
}

/// Decide what to do on an open event. `within_hours` is
/// `Config::within_working_hours` (`None` = feature disabled). `remembered` is
/// the after-hours answer already normalized for the current local day by the
/// caller (`None` once a new day resets it).
pub fn decide_open(
    paused: bool,
    within_hours: Option<bool>,
    remembered: Option<bool>,
) -> OpenDecision {
    if paused {
        return OpenDecision::Skip; // manual pause wins; nothing reopens
    }
    match within_hours {
        None | Some(true) => OpenDecision::ClockIn,
        Some(false) => match remembered {
            Some(true) => OpenDecision::ClockInAfterHours,
            Some(false) => OpenDecision::Skip,
            None => OpenDecision::Prompt,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> IdleParams {
        IdleParams {
            paused: false,
            timeout_secs: 900,
            idle_secs: 0,
            in_call: false,
            clocked_in: true,
            idle_out: false,
            reclaim_pending: false,
            idle_warned: false,
            idle_since_secs_ago: None,
        }
    }

    #[test]
    fn paused_or_disabled_does_nothing() {
        let mut p = base();
        p.paused = true;
        p.idle_secs = 10_000;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);

        let mut p = base();
        p.timeout_secs = 0;
        p.idle_secs = 10_000;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);
    }

    #[test]
    fn idle_past_timeout_clocks_out_backdated() {
        let mut p = base();
        p.idle_secs = 1000;
        assert_eq!(
            decide_idle(&p),
            IdleDecision::ClockOutIdle { backdate_secs: 1000 }
        );
    }

    #[test]
    fn on_a_call_stays_present_and_resumes_from_idle_latch() {
        // Clocked in, on a call, over timeout but under presence cap: do nothing.
        let mut p = base();
        p.idle_secs = 1000;
        p.in_call = true;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);

        // Latched idle-out, on a call: resume.
        p.idle_out = true;
        assert_eq!(decide_idle(&p), IdleDecision::ResumeFromCall);

        // ...unless a reclaim prompt is already pending.
        p.reclaim_pending = true;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);
    }

    #[test]
    fn call_presence_cap_lets_long_meetings_clock_out() {
        let mut p = base();
        p.in_call = true;
        p.idle_secs = MEDIA_PRESENCE_MAX_SECS + 1;
        assert_eq!(
            decide_idle(&p),
            IdleDecision::ClockOutIdle {
                backdate_secs: (MEDIA_PRESENCE_MAX_SECS + 1) as i64
            }
        );
    }

    #[test]
    fn return_after_idle_out_reclaims_within_window_else_resumes() {
        let mut p = base();
        p.idle_secs = 5; // back under timeout
        p.idle_out = true;
        p.idle_since_secs_ago = Some(600); // 10 min gap — worth reclaiming
        assert_eq!(
            decide_idle(&p),
            IdleDecision::PromptReclaim {
                idle_since_secs_ago: 600
            }
        );

        // Gap too small to bother: just resume.
        p.idle_since_secs_ago = Some(RECLAIM_MIN_SECS - 1);
        assert_eq!(decide_idle(&p), IdleDecision::ResumeActive);

        // Gap too large (genuine long absence): just resume.
        p.idle_since_secs_ago = Some(RECLAIM_MAX_SECS + 1);
        assert_eq!(decide_idle(&p), IdleDecision::ResumeActive);

        // Empty-session idle-out (no anchor): resume.
        p.idle_since_secs_ago = None;
        assert_eq!(decide_idle(&p), IdleDecision::ResumeActive);

        // Reclaim modal already up: nothing.
        p.reclaim_pending = true;
        p.idle_since_secs_ago = Some(600);
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);
    }

    #[test]
    fn warns_once_approaching_cutoff() {
        let mut p = base();
        p.timeout_secs = 900;
        p.idle_secs = 900 - IDLE_WARN_LEAD_SECS + 1; // inside the warn window
        assert_eq!(decide_idle(&p), IdleDecision::Warn { minutes_left: 2 });

        // Already warned: stay quiet.
        p.idle_warned = true;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);

        // On a call: no warning.
        p.idle_warned = false;
        p.in_call = true;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);

        // Not clocked in: nothing to warn about.
        p.in_call = false;
        p.clocked_in = false;
        assert_eq!(decide_idle(&p), IdleDecision::Nothing);
    }

    #[test]
    fn open_inside_hours_or_disabled_clocks_in() {
        assert_eq!(decide_open(false, None, None), OpenDecision::ClockIn);
        assert_eq!(decide_open(false, Some(true), None), OpenDecision::ClockIn);
    }

    #[test]
    fn open_after_hours_respects_memory() {
        assert_eq!(decide_open(false, Some(false), None), OpenDecision::Prompt);
        assert_eq!(
            decide_open(false, Some(false), Some(true)),
            OpenDecision::ClockInAfterHours
        );
        assert_eq!(
            decide_open(false, Some(false), Some(false)),
            OpenDecision::Skip
        );
    }

    #[test]
    fn open_while_paused_skips() {
        assert_eq!(decide_open(true, None, None), OpenDecision::Skip);
        assert_eq!(decide_open(true, Some(false), Some(true)), OpenDecision::Skip);
    }
}
