//! macOS UI layer: the `NSApplication` run loop that mirrors what the Windows
//! `window.rs` does — observes sleep/wake and screen lock/unlock, hosts a status
//! bar (menu bar) item, and drives the heartbeat / sync / update timers. Clock
//! decisions come from the shared [`crate::engine`], so behavior matches Windows.
//!
//! STATUS: the portable state machine below (`AppState`) is complete and shares
//! `engine`/`db`/`config`/`sync` with the rest of the app. The AppKit glue
//! (`run`, the delegate class, status-item menu, notification observers, timers)
//! is written against objc2 0.6 / objc2-app-kit 0.3 but has NOT been compiled on
//! macOS yet — this repo is developed on Windows. Points needing on-device
//! verification are marked `TODO(macos-build)`. Build/iterate with
//! `cargo build --target aarch64-apple-darwin` on a Mac (see .ai/todo.md).
#![allow(dead_code)] // scaffold: some entry points are consumed once `imp` is wired.

mod runloop;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::Connection;

use crate::config::Config;
use crate::engine::{self, IdleDecision, OpenDecision};

/// Blocking-sync budget on quit/power-off, mirroring the Windows shutdown path.
const SHUTDOWN_SYNC_TIMEOUT: Duration = Duration::from_secs(3);

/// Portable clock state machine for macOS. Holds no AppKit handles — the run
/// loop calls these methods in response to observers and timers, and performs the
/// UI side effects (notify / prompt) the returned intents imply. Deliberately a
/// close analog of the Windows `AppState` so the two can converge on `engine`.
pub struct AppState {
    conn: Connection,
    config: Config,
    /// Overlap guard for background sync. Shared with the worker thread (which
    /// clears it on completion), so no main-thread callback is needed.
    syncing: Arc<AtomicBool>,
    idle_out: bool,
    paused: bool,
    idle_warned: bool,
    idle_since: Option<DateTime<Utc>>,
    pending_reclaim: Option<DateTime<Utc>>,
    after_hours_answer: Option<bool>,
    after_hours_date: Option<NaiveDate>,
    pending_open: Option<&'static str>,
}

impl AppState {
    pub fn new() -> AppState {
        let conn = crate::db::open().expect("open database");
        let config = Config::load();
        AppState {
            conn,
            config,
            syncing: Arc::new(AtomicBool::new(false)),
            idle_out: false,
            paused: false,
            idle_warned: false,
            idle_since: None,
            pending_reclaim: None,
            after_hours_answer: None,
            after_hours_date: None,
            pending_open: None,
        }
    }

    fn is_clocked_in(&self) -> bool {
        matches!(crate::db::open_session_start(&self.conn), Ok(Some(_)))
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

    fn clock_out(&mut self, reason: &str) {
        match crate::db::clock_out(&self.conn, reason, Utc::now()) {
            Ok(crate::db::ClockOut::Closed) => {
                crate::logln!("clock out ({reason})");
                self.do_sync();
            }
            Ok(crate::db::ClockOut::DroppedEmpty) => {
                crate::logln!("ignored empty session ({reason})")
            }
            Ok(crate::db::ClockOut::None) => {}
            Err(e) => crate::logln!("clock_out error: {e}"),
        }
    }

    /// Clock out and sync synchronously before returning (quit/power-off).
    fn clock_out_blocking(&mut self, reason: &str) {
        match crate::db::clock_out(&self.conn, reason, Utc::now()) {
            Ok(crate::db::ClockOut::Closed) => crate::logln!("clock out ({reason})"),
            Ok(crate::db::ClockOut::DroppedEmpty) => {
                crate::logln!("ignored empty session ({reason})");
                return;
            }
            Ok(crate::db::ClockOut::None) => return,
            Err(e) => {
                crate::logln!("clock_out error: {e}");
                return;
            }
        }
        if !self.config.is_configured() {
            return;
        }
        match crate::sync::run_blocking(&self.config, SHUTDOWN_SYNC_TIMEOUT) {
            Ok(n) if n > 0 => crate::logln!("synced {n} session(s) before exit"),
            Ok(_) => {}
            Err(e) => crate::logln!("shutdown sync error: {e}"),
        }
    }

    /// A "computer opened" moment (wake / unlock / app start).
    fn open_event(&mut self, reason: &'static str) {
        // Opening the machine always resumes tracking: a manual pause lasts only
        // until the next open, so the user never has to remember to unpause.
        if self.paused {
            self.paused = false;
            crate::logln!("resumed (open)");
        }
        let now = Local::now();
        // Normalize the remembered after-hours answer for the current local day.
        if self.after_hours_date != Some(now.date_naive()) {
            self.after_hours_answer = None;
        }
        match engine::decide_open(
            self.config.within_working_hours(now),
            self.after_hours_answer,
        ) {
            OpenDecision::ClockIn => {
                self.after_hours_answer = None;
                self.after_hours_date = None;
                self.clock_in(reason);
                self.do_sync();
            }
            OpenDecision::ClockInAfterHours => {
                self.clock_in(reason);
                self.do_sync();
            }
            OpenDecision::Skip => {}
            OpenDecision::Prompt => {
                if self.pending_open.is_none() {
                    self.pending_open = Some(reason);
                    runloop::defer_after_hours_prompt();
                }
            }
        }
    }

    /// Answer a deferred after-hours prompt (run loop calls this on the main
    /// thread after showing the modal).
    fn resolve_after_hours(&mut self, working: bool) {
        let Some(reason) = self.pending_open.take() else {
            return;
        };
        self.after_hours_answer = Some(working);
        self.after_hours_date = Some(Local::now().date_naive());
        if working {
            self.clock_in(reason);
            self.do_sync();
        } else {
            crate::logln!("after-hours: user not working");
        }
    }

    /// Heartbeat idle check — delegates the decision to `engine` and performs the
    /// side effect it selects.
    fn check_idle(&mut self) {
        let idle_secs = crate::idle::idle_duration().as_secs();
        let params = engine::IdleParams {
            paused: self.paused,
            timeout_secs: self.config.idle_timeout_secs,
            idle_secs,
            in_call: crate::media::in_use(),
            clocked_in: self.is_clocked_in(),
            idle_out: self.idle_out,
            reclaim_pending: self.pending_reclaim.is_some(),
            idle_warned: self.idle_warned,
            idle_since_secs_ago: self
                .idle_since
                .map(|s| (Utc::now() - s).num_seconds()),
        };
        match engine::decide_idle(&params) {
            IdleDecision::Nothing => {
                // Reset the once-per-stretch warn latch once we drop back under
                // the warn window, matching the Windows behavior.
                let warn_at = params
                    .timeout_secs
                    .saturating_sub(engine::IDLE_WARN_LEAD_SECS);
                if idle_secs < warn_at {
                    self.idle_warned = false;
                }
            }
            IdleDecision::ResumeFromCall => {
                self.idle_warned = false;
                self.clock_in("call");
                self.do_sync();
            }
            IdleDecision::ClockOutIdle { backdate_secs } => {
                let last_input = Utc::now() - chrono::Duration::seconds(backdate_secs);
                match crate::db::clock_out(&self.conn, "idle", last_input) {
                    Ok(crate::db::ClockOut::Closed) => {
                        crate::logln!("clock out (idle {idle_secs}s)");
                        self.idle_out = true;
                        self.idle_since = Some(last_input);
                        self.idle_warned = false;
                        self.do_sync();
                    }
                    Ok(crate::db::ClockOut::DroppedEmpty) => {
                        crate::logln!("ignored empty session (idle {idle_secs}s)");
                        self.idle_out = true;
                        self.idle_since = None;
                        self.idle_warned = false;
                    }
                    Ok(crate::db::ClockOut::None) => {}
                    Err(e) => crate::logln!("idle clock_out error: {e}"),
                }
            }
            IdleDecision::PromptReclaim {
                idle_since_secs_ago,
            } => {
                self.idle_warned = false;
                self.pending_reclaim = Some(Utc::now() - chrono::Duration::seconds(idle_since_secs_ago));
                runloop::defer_reclaim_prompt();
            }
            IdleDecision::ResumeActive => {
                self.idle_warned = false;
                self.clock_in("active");
                self.do_sync();
            }
            IdleDecision::Warn { minutes_left } => {
                runloop::notify(
                    "clocked",
                    &format!("No activity — clocking out in ~{minutes_left} min unless you return."),
                );
                self.idle_warned = true;
            }
        }
    }

    /// Resolve a queued idle-reclaim prompt (run loop supplies the answer).
    fn resolve_idle_reclaim(&mut self, reclaim: bool) {
        let Some(since) = self.pending_reclaim.take() else {
            return;
        };
        if reclaim {
            let mins = ((Utc::now() - since).num_seconds().max(0) + 30) / 60;
            self.clock_in_at("reclaimed", since);
            crate::logln!("reclaimed idle time ({mins} min)");
        } else {
            self.clock_in("active");
        }
        self.do_sync();
    }

    /// Toggle tracking from the menu.
    fn toggle_pause(&mut self) {
        if self.is_clocked_in() {
            self.paused = true;
            self.idle_out = false;
            self.idle_warned = false;
            match crate::db::clock_out(&self.conn, "manual", Utc::now()) {
                Ok(_) => crate::logln!("paused"),
                Err(e) => crate::logln!("pause clock_out error: {e}"),
            }
            self.do_sync();
        } else {
            self.paused = false;
            self.idle_warned = false;
            self.after_hours_answer = Some(true);
            self.after_hours_date = Some(Local::now().date_naive());
            crate::logln!("resumed");
            self.clock_in("manual");
            self.do_sync();
        }
    }

    fn do_sync(&mut self) {
        if !self.config.is_configured() {
            return;
        }
        // Claim the guard; bail if a sync is already in flight. The worker clears
        // it when done — no window message / main-thread hop required.
        if self.syncing.swap(true, Ordering::SeqCst) {
            return;
        }
        runloop::spawn_sync(self.config.clone(), self.syncing.clone());
    }

    fn reload_config(&mut self) {
        self.config = Config::load();
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Entry points the run loop (child module) calls in response to timers,
/// observers, menu commands, and marshaled worker completions. Thin wrappers over
/// the private state-machine methods above so the run loop needs no internals.
impl AppState {
    /// One-time startup: crash recovery, first heartbeat, initial open, first
    /// update check. Mirrors the Windows startup sequence.
    pub(crate) fn on_startup(&mut self) {
        let _ = crate::db::recover_crashed(&self.conn, Utc::now());
        let _ = crate::db::heartbeat(&self.conn, Utc::now());
        self.open_event("start");
        self.do_sync();
        self.check_for_updates();
    }

    /// 60s heartbeat: keep the crash-recovery marker fresh, then run idle logic.
    pub(crate) fn heartbeat_tick(&mut self) {
        let _ = crate::db::heartbeat(&self.conn, Utc::now());
        self.check_idle();
    }

    pub(crate) fn open_cmd(&mut self, reason: &'static str) {
        self.open_event(reason);
    }
    pub(crate) fn clock_out_cmd(&mut self, reason: &'static str) {
        self.clock_out(reason);
    }
    pub(crate) fn sync_now(&mut self) {
        self.do_sync();
    }
    pub(crate) fn toggle_pause_cmd(&mut self) {
        self.toggle_pause();
    }
    pub(crate) fn quit(&mut self) {
        self.clock_out_blocking("quit");
    }
    pub(crate) fn after_hours_answered(&mut self, working: bool) {
        self.resolve_after_hours(working);
    }
    pub(crate) fn reclaim_answered(&mut self, reclaim: bool) {
        self.resolve_idle_reclaim(reclaim);
    }
    pub(crate) fn config_changed(&mut self) {
        self.reload_config();
        self.do_sync();
    }

    /// Open the Worker dashboard (current month), signed in when possible. The
    /// token→login-URL swap is a network call, so it runs off the main thread.
    pub(crate) fn open_timesheet(&mut self) {
        let cfg = self.config.clone();
        let fallback = cfg.effective_worker_url().to_string();
        if fallback.trim().is_empty() {
            return;
        }
        std::thread::spawn(move || {
            let url = crate::sync::desktop_login_url(&cfg).unwrap_or(fallback);
            let _ = std::process::Command::new("open").arg(url).spawn();
        });
    }

    /// Background update check. Reuses the portable `update::check_latest`; when a
    /// newer release exists, notify via `osascript` (delivery differs from the
    /// Win32 tray-menu link, but the check itself is shared).
    pub(crate) fn check_for_updates(&mut self) {
        std::thread::spawn(|| match crate::update::check_latest() {
            Ok(crate::update::UpdateStatus::Available { version, .. }) => {
                crate::logln!("update available: v{version}");
                runloop::notify(
                    "clocked update available",
                    &format!(
                        "Version v{version} is ready — download at {}",
                        crate::update::DOWNLOAD_URL
                    ),
                );
            }
            Ok(_) => {}
            Err(e) => crate::logln!("update check error: {e}"),
        });
    }

    /// Store a pasted sync token: persist to Keychain + config.toml, reload, sync.
    pub(crate) fn set_sync_token(&mut self, token: String) {
        self.config.bearer_token = token;
        if let Err(e) = self.config.save() {
            crate::logln!("save token error: {e}");
            return;
        }
        self.config = Config::load();
        self.do_sync();
    }

    /// Toggle launch-at-login (LaunchAgent). Returns the resulting enabled state
    /// so the menu checkmark can be updated.
    pub(crate) fn set_start_at_login(&mut self, enable: bool) -> bool {
        let r = if enable {
            crate::autostart::enable()
        } else {
            crate::autostart::disable()
        };
        if let Err(e) = r {
            crate::logln!("start-at-login toggle error: {e}");
        }
        crate::autostart::is_enabled()
    }

    /// Whether launch-at-login is currently enabled (for the initial menu state).
    pub(crate) fn start_at_login_enabled(&self) -> bool {
        crate::autostart::is_enabled()
    }
}

/// Entry point for the macOS build. Delegates to the AppKit run loop.
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    runloop::run()
}
