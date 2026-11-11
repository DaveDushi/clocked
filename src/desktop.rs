//! Shared desktop tracking state machine.
//!
//! Native integrations translate OS events into these methods and execute the
//! returned [`Effect`] values. Keeping prompts and other nested native run loops
//! outside this type is intentional: native callbacks must release their Rust
//! state borrow before displaying a modal dialog.

use std::sync::Arc;

use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::Connection;

use crate::activity::{ActivityTracker, Observation};
use crate::bridge::BridgeState;
use crate::config::Config;
use crate::engine::{self, IdleDecision, OpenDecision};
use crate::rules::Rules;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Sync,
    Notify(String),
    PromptAfterHours,
    PromptReclaim { minutes: i64 },
    DismissAfterHoursPrompt,
}

/// Answers to the after-hours prompt shown when returning from idle with away time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwayAnswer {
    CountAway,
    FromNow,
    Done,
}

pub struct DesktopState {
    pub conn: Connection,
    pub config: Config,
    pub rules: Rules,
    bridge: Arc<BridgeState>,
    activity: ActivityTracker,
    own_exe: String,
    idle_out: bool,
    paused: bool,
    idle_warned: bool,
    idle_since: Option<DateTime<Utc>>,
    pending_reclaim: Option<DateTime<Utc>>,
    after_hours_answer: Option<bool>,
    after_hours_date: Option<NaiveDate>,
    managed_hours: Option<crate::working_hours::WorkingHours>,
    managed_inactivity: Option<crate::inactivity::InactivityPolicy>,
    pending_open: Option<&'static str>,
    /// Start of the away gap the pending after-hours prompt offers to count.
    pending_away: Option<DateTime<Utc>>,
}

impl DesktopState {
    pub fn new() -> Self {
        let conn = crate::db::open().expect("open database");
        let config = Config::load();
        let _ = crate::db::prune_activity(&conn, Utc::now(), config.activity_retention_days);
        let bridge = BridgeState::new(config.bearer_token.clone());
        Self::from_parts(conn, config, Rules::load(), bridge)
    }

    fn from_parts(
        conn: Connection,
        config: Config,
        rules: Rules,
        bridge: Arc<BridgeState>,
    ) -> Self {
        let managed_inactivity = crate::inactivity::cached(&conn, &config);
        let managed_hours = crate::working_hours::cached(&conn, &config);
        Self {
            conn,
            config,
            rules,
            bridge,
            activity: ActivityTracker::new(),
            own_exe: std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
                .unwrap_or_default(),
            idle_out: false,
            paused: false,
            idle_warned: false,
            idle_since: None,
            pending_reclaim: None,
            after_hours_answer: None,
            after_hours_date: None,
            managed_hours,
            managed_inactivity,
            pending_open: None,
            pending_away: None,
        }
    }

    pub fn startup(&mut self, should_open: bool) -> Vec<Effect> {
        crate::bridge::start(Arc::clone(&self.bridge), crate::bridge::DEFAULT_PORT);
        let now = Utc::now();
        let _ = crate::db::recover_crashed(&self.conn, now);
        let _ = crate::db::heartbeat(&self.conn, now);
        let mut effects = if should_open {
            self.open_event("start")
        } else {
            Vec::new()
        };
        if !effects.contains(&Effect::Sync) {
            effects.push(Effect::Sync);
        }
        effects
    }

    pub fn is_clocked_in(&self) -> bool {
        matches!(crate::db::open_session_start(&self.conn), Ok(Some(_)))
    }

    #[cfg(any(windows, test))]
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    #[cfg(any(windows, target_os = "linux"))]
    pub fn status_line(&self) -> String {
        if self.paused {
            return "Paused".to_string();
        }
        match crate::db::open_session_start(&self.conn) {
            Ok(Some(start)) => format!(
                "Tracking · since {}",
                start.with_timezone(&Local).format("%H:%M")
            ),
            _ => "Not tracking".to_string(),
        }
    }

    #[cfg(any(windows, target_os = "linux"))]
    pub fn today_line(&self) -> String {
        let secs = crate::db::today_total_secs(&self.conn, Utc::now()).unwrap_or(0);
        let worked = format_duration(secs);
        let target = self.config.target_hours;
        if target > 0.0 {
            let mark = if secs as f64 >= target * 3600.0 {
                " ✓"
            } else {
                ""
            };
            format!("Today  {worked} / {}{mark}", format_hours(target))
        } else {
            format!("Today  {worked}")
        }
    }

    pub fn open_event(&mut self, reason: &'static str) -> Vec<Effect> {
        if self.paused {
            self.paused = false;
            crate::logln!("resumed (open)");
        }
        let now = Local::now();
        if self.after_hours_date != Some(now.date_naive()) {
            self.after_hours_answer = None;
        }
        match engine::decide_open(self.within_working_hours(now), self.after_hours_answer) {
            OpenDecision::ClockIn => {
                self.pending_open = None;
                self.pending_away = None;
                self.after_hours_answer = None;
                self.after_hours_date = None;
                self.clock_in(reason);
                vec![Effect::DismissAfterHoursPrompt, Effect::Sync]
            }
            OpenDecision::ClockInAfterHours => {
                self.clock_in(reason);
                vec![Effect::Sync]
            }
            OpenDecision::Skip => Vec::new(),
            OpenDecision::Prompt => {
                if self.pending_open.is_none() {
                    self.pending_open = Some(reason);
                    vec![Effect::PromptAfterHours]
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn within_working_hours(&mut self, now: DateTime<Local>) -> Option<bool> {
        let managed = crate::working_hours::cached(&self.conn, &self.config);
        if managed != self.managed_hours {
            self.after_hours_answer = None;
            self.after_hours_date = None;
            self.managed_hours = managed;
        }
        match &self.managed_hours {
            Some(schedule) => schedule.contains(now),
            None => self.config.within_working_hours(now),
        }
    }

    pub fn close_event(&mut self, reason: &'static str) -> Vec<Effect> {
        self.close_event_at(reason, Utc::now())
    }

    /// All native sleep notifications use the same close-and-upload sequence.
    pub fn prepare_for_suspend(&mut self) {
        self.close_event("suspend");
        if self.config.is_configured() {
            match crate::sync::before_suspend(&self.config) {
                Ok(n) => crate::logln!("synced {n} session(s) before suspend"),
                Err(e) => crate::logln!("suspend sync pending: {e}"),
            }
        }
    }

    pub fn close_event_at(&mut self, reason: &'static str, at: DateTime<Utc>) -> Vec<Effect> {
        self.after_hours_answer = None;
        self.after_hours_date = None;
        if self.clock_out_at(reason, at) {
            vec![Effect::Sync]
        } else {
            Vec::new()
        }
    }

    /// Re-check a deferred after-hours prompt immediately before displaying it.
    pub fn begin_after_hours_prompt(&mut self) -> (bool, Vec<Effect>) {
        let Some(reason) = self.pending_open else {
            return (false, Vec::new());
        };
        if engine::should_auto_accept_after_hours(self.within_working_hours(Local::now())) {
            return (false, self.accept_after_hours(reason));
        }
        (true, Vec::new())
    }

    /// Minutes the pending after-hours prompt offers to count, when it came from idle.
    pub fn pending_away_minutes(&self) -> Option<i64> {
        self.pending_away
            .map(|since| ((Utc::now() - since).num_seconds().max(0) + 30) / 60)
    }

    pub fn answer_after_hours(&mut self, working: bool) -> Vec<Effect> {
        self.resolve_after_hours(working, false)
    }

    pub fn answer_away_after_hours(&mut self, answer: AwayAnswer) -> Vec<Effect> {
        self.resolve_after_hours(answer != AwayAnswer::Done, answer == AwayAnswer::CountAway)
    }

    fn resolve_after_hours(&mut self, working: bool, count_away: bool) -> Vec<Effect> {
        let Some(reason) = self.pending_open else {
            return Vec::new();
        };
        if engine::should_auto_accept_after_hours(self.within_working_hours(Local::now())) {
            return self.accept_after_hours(reason);
        }
        let since = self.pending_away.take().filter(|_| count_away);
        self.pending_open = None;
        self.after_hours_answer = Some(working);
        self.after_hours_date = Some(Local::now().date_naive());
        if working {
            match since {
                Some(since) => {
                    self.clock_in_at("reclaimed", since);
                    crate::logln!("after-hours: counted away time");
                }
                None => self.clock_in(reason),
            }
            vec![Effect::Sync]
        } else {
            // An idle-out latched before the open would otherwise resume on the next input.
            self.idle_out = false;
            self.idle_since = None;
            crate::logln!("after-hours: user not working");
            Vec::new()
        }
    }

    pub fn maybe_enter_working_hours(&mut self) -> Vec<Effect> {
        let within = self.within_working_hours(Local::now());
        if !engine::should_auto_accept_after_hours(within) {
            return Vec::new();
        }
        if self.paused || self.is_clocked_in() {
            return if self.pending_open.is_some() {
                vec![Effect::DismissAfterHoursPrompt]
            } else {
                Vec::new()
            };
        }
        let reason = match self.pending_open {
            Some(reason) => reason,
            None if self.after_hours_answer == Some(false) => "schedule",
            None => return Vec::new(),
        };
        self.accept_after_hours(reason)
    }

    fn accept_after_hours(&mut self, reason: &'static str) -> Vec<Effect> {
        self.pending_open = None;
        self.pending_away = None;
        self.after_hours_answer = None;
        self.after_hours_date = None;
        crate::logln!("after-hours: auto clock-in ({reason}; now within working hours)");
        self.clock_in(reason);
        vec![Effect::DismissAfterHoursPrompt, Effect::Sync]
    }

    pub fn heartbeat(&mut self) -> Vec<Effect> {
        let now = Utc::now();
        let _ = crate::db::heartbeat(&self.conn, now);
        if self.config.track_projects {
            self.activity.checkpoint(&self.conn, now);
            let _ = crate::db::prune_activity(&self.conn, now, self.config.activity_retention_days);
        }
        let mut effects = self.maybe_enter_working_hours();
        effects.extend(self.check_idle());
        effects
    }

    pub fn check_idle(&mut self) -> Vec<Effect> {
        self.check_idle_with(
            crate::idle::idle_duration().as_secs(),
            crate::media::in_use(),
        )
    }

    fn check_idle_with(&mut self, idle_secs: u64, in_call: bool) -> Vec<Effect> {
        let managed = crate::inactivity::cached(&self.conn, &self.config);
        if managed != self.managed_inactivity {
            self.idle_warned = false;
            self.managed_inactivity = managed;
        }
        let policy = managed.unwrap_or(crate::inactivity::InactivityPolicy {
            timeout_secs: self.config.idle_timeout_secs,
            warning_secs: engine::IDLE_WARN_LEAD_SECS,
        });
        let params = engine::IdleParams {
            paused: self.paused,
            timeout_secs: policy.timeout_secs,
            warning_secs: policy.warning_secs,
            idle_secs,
            in_call,
            clocked_in: self.is_clocked_in(),
            // The after-hours answer decides whether input resumes tracking.
            idle_out: self.idle_out && self.pending_open.is_none(),
            reclaim_pending: self.pending_reclaim.is_some(),
            idle_warned: self.idle_warned,
            idle_since_secs_ago: self
                .idle_since
                .map(|since| (Utc::now() - since).num_seconds()),
        };
        let decision = engine::decide_idle(&params);
        if matches!(
            decision,
            IdleDecision::ResumeFromCall
                | IdleDecision::PromptReclaim { .. }
                | IdleDecision::ResumeActive
        ) {
            if let Some(effects) = self.hold_resume_after_hours(decision) {
                return effects;
            }
        }
        match decision {
            IdleDecision::Nothing => {
                let warn_at = params.timeout_secs.saturating_sub(params.warning_secs);
                if idle_secs < warn_at {
                    self.idle_warned = false;
                }
                Vec::new()
            }
            IdleDecision::ResumeFromCall => {
                self.idle_warned = false;
                self.clock_in("call");
                vec![Effect::Sync]
            }
            IdleDecision::ClockOutIdle { backdate_secs } => {
                self.activity_flush();
                let last_input = Utc::now() - chrono::Duration::seconds(backdate_secs);
                match crate::db::clock_out(&self.conn, "idle", last_input) {
                    Ok(crate::db::ClockOut::Closed) => {
                        crate::logln!("clock out (idle {backdate_secs}s)");
                        self.idle_out = true;
                        self.idle_since = Some(last_input);
                        self.idle_warned = false;
                        vec![Effect::Sync]
                    }
                    Ok(crate::db::ClockOut::DroppedEmpty) => {
                        crate::logln!("ignored empty session (idle {backdate_secs}s)");
                        self.idle_out = true;
                        self.idle_since = None;
                        self.idle_warned = false;
                        Vec::new()
                    }
                    Ok(crate::db::ClockOut::None) => Vec::new(),
                    Err(e) => {
                        crate::logln!("idle clock_out error: {e}");
                        Vec::new()
                    }
                }
            }
            IdleDecision::PromptReclaim {
                idle_since_secs_ago,
            } => {
                self.idle_warned = false;
                let since = Utc::now() - chrono::Duration::seconds(idle_since_secs_ago);
                self.pending_reclaim = Some(since);
                vec![Effect::PromptReclaim {
                    minutes: (idle_since_secs_ago.max(0) + 30) / 60,
                }]
            }
            IdleDecision::ResumeActive => {
                self.idle_warned = false;
                self.clock_in("active");
                vec![Effect::Sync]
            }
            IdleDecision::Warn { minutes_left } => {
                self.idle_warned = true;
                vec![Effect::Notify(format!(
                    "No activity — clocking out in ~{minutes_left} min unless you return."
                ))]
            }
        }
    }

    /// Returning from idle outside working hours asks "are you working?" like an open does,
    /// offering to count the away gap when it is in the reclaim range.
    fn hold_resume_after_hours(&mut self, decision: IdleDecision) -> Option<Vec<Effect>> {
        let now = Local::now();
        if self.after_hours_date != Some(now.date_naive()) {
            self.after_hours_answer = None;
        }
        match engine::decide_open(self.within_working_hours(now), self.after_hours_answer) {
            OpenDecision::ClockIn | OpenDecision::ClockInAfterHours => None,
            OpenDecision::Skip => {
                self.idle_out = false;
                self.idle_since = None;
                Some(Vec::new())
            }
            OpenDecision::Prompt => {
                self.idle_warned = false;
                self.pending_open = Some(match decision {
                    IdleDecision::ResumeFromCall => "call",
                    _ => "active",
                });
                self.pending_away = match decision {
                    IdleDecision::PromptReclaim {
                        idle_since_secs_ago,
                    } => Some(Utc::now() - chrono::Duration::seconds(idle_since_secs_ago)),
                    _ => None,
                };
                Some(vec![Effect::PromptAfterHours])
            }
        }
    }

    pub fn answer_reclaim(&mut self, reclaim: bool) -> Vec<Effect> {
        let Some(since) = self.pending_reclaim.take() else {
            return Vec::new();
        };
        if reclaim {
            let mins = ((Utc::now() - since).num_seconds().max(0) + 30) / 60;
            self.clock_in_at("reclaimed", since);
            crate::logln!("reclaimed idle time ({mins} min)");
        } else {
            self.clock_in("active");
        }
        vec![Effect::Sync]
    }

    pub fn toggle_pause(&mut self) -> Vec<Effect> {
        if self.is_clocked_in() {
            self.paused = true;
            self.idle_out = false;
            self.idle_warned = false;
            self.clock_out_at("manual", Utc::now());
            crate::logln!("paused");
        } else {
            self.paused = false;
            self.idle_warned = false;
            self.after_hours_answer = Some(true);
            self.after_hours_date = Some(Local::now().date_naive());
            self.clock_in("manual");
            crate::logln!("resumed");
        }
        vec![Effect::Sync]
    }

    pub fn record_activity_tick(&mut self) {
        if !self.config.track_projects {
            self.activity_flush();
            return;
        }
        let active = !self.paused
            && self.is_clocked_in()
            && (crate::idle::idle_duration().as_secs() < 60 || crate::media::in_use());
        let now = Utc::now();
        if !active {
            self.activity.flush(&self.conn, now);
            return;
        }
        let Some(fg) = crate::foreground::foreground() else {
            return;
        };
        let (override_ctx, title) = if crate::context::is_browser_app(&fg.app) {
            let domain = self.bridge.fresh_domain();
            let title = self
                .bridge
                .fresh_title()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| fg.title.clone());
            (domain, title)
        } else {
            (None, fg.title.clone())
        };
        self.activity.observe(
            &self.conn,
            Observation {
                rules: &self.rules,
                store_titles: self.config.store_titles,
                active: true,
                now,
                app: &fg.app,
                raw_title: &title,
                own_exe: &self.own_exe,
                context_override: override_ctx.as_deref(),
            },
        );
    }

    pub fn activity_flush(&mut self) {
        self.activity.flush(&self.conn, Utc::now());
    }

    pub fn shutdown(&mut self, reason: &str) -> bool {
        self.clock_out_at(reason, Utc::now())
    }

    pub fn reload(&mut self) {
        self.config = Config::load();
        self.rules = Rules::load();
        self.bridge.set_token(&self.config.bearer_token);
    }

    fn clock_in(&mut self, reason: &str) {
        self.clock_in_at(reason, Utc::now());
    }

    fn clock_in_at(&mut self, reason: &str, at: DateTime<Utc>) {
        if self.paused {
            return;
        }
        self.idle_out = false;
        self.idle_since = None;
        match crate::db::clock_in(&self.conn, reason, at) {
            Ok(true) => crate::logln!("clock in ({reason})"),
            Ok(false) => {}
            Err(e) => crate::logln!("clock_in error: {e}"),
        }
    }

    fn clock_out_at(&mut self, reason: &str, at: DateTime<Utc>) -> bool {
        self.activity_flush();
        match crate::db::clock_out(&self.conn, reason, at) {
            Ok(crate::db::ClockOut::Closed) => {
                crate::logln!("clock out ({reason})");
                true
            }
            Ok(crate::db::ClockOut::DroppedEmpty) => {
                crate::logln!("ignored empty session ({reason})");
                false
            }
            Ok(crate::db::ClockOut::None) => false,
            Err(e) => {
                crate::logln!("clock_out error: {e}");
                false
            }
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn format_duration(secs: i64) -> String {
    let seconds = secs.max(0);
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else {
        format!("{minutes}m")
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn format_hours(hours: f64) -> String {
    if hours.fract().abs() < 1e-9 {
        format!("{}h", hours as i64)
    } else {
        format!("{hours:.1}h")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_outside_working_hours() -> DesktopState {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let config = Config {
            // An empty interval is outside working hours on every day.
            work_start: "00:00".to_string(),
            work_end: "00:00".to_string(),
            work_days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            ..Config::default()
        };
        let bridge = BridgeState::new(String::new());
        DesktopState::from_parts(conn, config, Rules::default(), bridge)
    }

    #[test]
    fn suspend_closes_local_session_without_needing_network() {
        let mut state = state_outside_working_hours();
        let start = Utc::now() - chrono::Duration::hours(7);
        crate::db::clock_in(&state.conn, "unlock", start).unwrap();
        state.prepare_for_suspend();
        assert!(!state.is_clocked_in());
        let pending = crate::db::unsynced(&state.conn).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].end_reason, "suspend");
        state.prepare_for_suspend();
        assert_eq!(crate::db::unsynced(&state.conn).unwrap().len(), 1);
    }

    #[test]
    fn after_hours_prompt_is_single_and_drives_shared_transition() {
        let mut state = state_outside_working_hours();

        assert_eq!(state.open_event("start"), vec![Effect::PromptAfterHours]);
        assert!(state.open_event("unlock").is_empty());
        assert_eq!(state.begin_after_hours_prompt(), (true, Vec::new()));
        assert_eq!(state.answer_after_hours(true), vec![Effect::Sync]);
        assert!(state.is_clocked_in());
    }

    #[test]
    fn rejecting_after_hours_suppresses_prompts_for_the_day() {
        let mut state = state_outside_working_hours();

        state.open_event("start");
        assert!(state.answer_after_hours(false).is_empty());
        assert!(!state.is_clocked_in());
        assert!(state.open_event("unlock").is_empty());
    }

    #[test]
    fn input_after_an_overnight_idle_out_respects_the_after_hours_answer() {
        let mut state = state_outside_working_hours();
        crate::db::clock_in(
            &state.conn,
            "active",
            Utc::now() - chrono::Duration::hours(1),
        )
        .unwrap();
        state.check_idle_with(3600, false);
        assert!(!state.is_clocked_in());

        assert_eq!(state.open_event("unlock"), vec![Effect::PromptAfterHours]);
        assert!(state.check_idle_with(1, false).is_empty());
        assert!(!state.is_clocked_in());

        state.answer_after_hours(false);
        assert!(state.check_idle_with(1, false).is_empty());
        assert!(!state.is_clocked_in());
    }

    fn away_after_hours(answer: AwayAnswer) -> DesktopState {
        let mut state = state_outside_working_hours();
        crate::db::clock_in(
            &state.conn,
            "active",
            Utc::now() - chrono::Duration::hours(1),
        )
        .unwrap();
        state.check_idle_with(1200, false);
        assert_eq!(
            state.check_idle_with(1, false),
            vec![Effect::PromptAfterHours]
        );
        assert_eq!(state.begin_after_hours_prompt(), (true, Vec::new()));
        assert_eq!(state.pending_away_minutes(), Some(20));
        state.answer_away_after_hours(answer);
        assert_eq!(state.pending_away_minutes(), None);
        state
    }

    #[test]
    fn away_prompt_after_hours_can_count_the_gap_resume_now_or_stop() {
        let start = |state: &DesktopState| {
            let start = crate::db::open_session_start(&state.conn).unwrap().unwrap();
            (Utc::now() - start).num_minutes()
        };
        let state = away_after_hours(AwayAnswer::CountAway);
        assert_eq!(start(&state), 20);

        let state = away_after_hours(AwayAnswer::FromNow);
        assert_eq!(start(&state), 0);

        let mut state = away_after_hours(AwayAnswer::Done);
        assert!(!state.is_clocked_in());
        assert!(state.check_idle_with(1, false).is_empty());
        assert!(!state.is_clocked_in());
    }

    #[test]
    fn returning_from_idle_after_hours_asks_before_resuming() {
        let mut state = state_outside_working_hours();
        crate::db::clock_in(
            &state.conn,
            "active",
            Utc::now() - chrono::Duration::hours(1),
        )
        .unwrap();
        state.check_idle_with(1000, false);
        assert!(!state.is_clocked_in());

        assert_eq!(
            state.check_idle_with(1, false),
            vec![Effect::PromptAfterHours]
        );
        assert!(state.check_idle_with(1, false).is_empty());
        assert!(!state.is_clocked_in());
        assert_eq!(state.begin_after_hours_prompt(), (true, Vec::new()));
        assert_eq!(state.answer_after_hours(true), vec![Effect::Sync]);
        assert!(state.is_clocked_in());

        state.check_idle_with(1000, false);
        assert!(!state.is_clocked_in());
        assert_eq!(state.check_idle_with(1, false), vec![Effect::Sync]);
        assert!(state.is_clocked_in());
    }

    #[test]
    fn manager_policy_changes_the_prompt_and_removal_restores_personal_settings() {
        let mut state = state_outside_working_hours();
        state.config.bearer_token = "clk_test_device".into();
        let personal = state.config.clone();
        assert_eq!(state.open_event("start"), vec![Effect::PromptAfterHours]);
        crate::working_hours::assign_for_test(
            &state.conn,
            &state.config,
            Some(crate::working_hours::WorkingHours::Disabled),
        );
        assert!(!state.begin_after_hours_prompt().0);
        assert!(state.is_clocked_in());
        assert_eq!(state.config, personal);
        state.close_event("lock");
        crate::working_hours::assign_for_test(&state.conn, &state.config, None);
        assert_eq!(state.open_event("unlock"), vec![Effect::PromptAfterHours]);
        assert_eq!(state.config, personal);
    }

    #[test]
    fn policy_change_keeps_an_explicit_rejection_clocked_out_until_the_next_open() {
        let mut state = state_outside_working_hours();
        state.config.bearer_token = "clk_test_device".into();
        state.open_event("start");
        state.answer_after_hours(false);
        assert!(!state.is_clocked_in());
        crate::working_hours::assign_for_test(
            &state.conn,
            &state.config,
            Some(crate::working_hours::WorkingHours::Disabled),
        );
        state.maybe_enter_working_hours();
        assert!(!state.is_clocked_in());
        state.open_event("unlock");
        assert!(state.is_clocked_in());
    }

    #[test]
    fn losing_a_managed_assignment_does_not_resume_an_explicit_rejection() {
        let mut state = state_outside_working_hours();
        state.config.bearer_token = "clk_test_device".into();
        state.config.work_start.clear(); // Personal hours have no prompt.
        let now = Local::now();
        let hours = crate::working_hours::WorkingHours::Scheduled {
            start: (now + chrono::Duration::hours(1))
                .format("%H:%M")
                .to_string(),
            end: (now + chrono::Duration::hours(2))
                .format("%H:%M")
                .to_string(),
            days: (1..=7).collect(),
        };
        crate::working_hours::assign_for_test(&state.conn, &state.config, Some(hours));
        assert_eq!(state.open_event("start"), vec![Effect::PromptAfterHours]);
        state.answer_after_hours(false);
        crate::working_hours::assign_for_test(&state.conn, &state.config, None);
        state.maybe_enter_working_hours();
        assert!(!state.is_clocked_in());
        state.open_event("unlock");
        assert!(state.is_clocked_in());
    }

    #[test]
    fn pause_toggle_uses_the_same_transition_for_every_desktop() {
        let mut state = state_outside_working_hours();

        assert_eq!(state.toggle_pause(), vec![Effect::Sync]);
        assert!(state.is_clocked_in());
        assert_eq!(state.toggle_pause(), vec![Effect::Sync]);
        assert!(state.is_paused());
        assert!(!state.is_clocked_in());
    }
}
