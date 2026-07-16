//! Hidden top-level Win32 window: the single message loop that captures power,
//! session (lock/unlock), and shutdown events, hosts the tray icon, and drives
//! the heartbeat/sync timers.
//!
//! NOTE: a *top-level* window is required — message-only (`HWND_MESSAGE`)
//! windows never receive `WM_POWERBROADCAST`. The window is created but never
//! shown.

use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::Connection;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Shell::{ShellExecuteW, NOTIFYICONDATAW};
use windows::Win32::UI::WindowsAndMessaging::*;

use std::sync::Arc;

use crate::activity::ActivityTracker;
use crate::bridge::BridgeState;
use crate::config::Config;
use crate::engine::{self, IdleDecision, OpenDecision};
use crate::events::{map_power, map_session, Action};

const CLASS_NAME: PCWSTR = w!("ClockedHiddenWindow");

// Custom + timer identifiers.
const WM_TRAY: u32 = WM_APP + 1;
const WM_SYNC_DONE: u32 = WM_APP + 2;
const WM_PROMPT_AFTER_HOURS: u32 = WM_APP + 3;
const WM_SETTINGS_SAVED: u32 = WM_APP + 4;
const WM_UPDATE_CHECK_DONE: u32 = WM_APP + 5;
const WM_PROMPT_IDLE_RECLAIM: u32 = WM_APP + 6;
const TIMER_HEARTBEAT: usize = 1;
const TIMER_SYNC: usize = 2;
const TIMER_UPDATE_CHECK: usize = 3;
/// Fast poll for foreground focus changes (segment-accurate app timing).
const TIMER_ACTIVITY: usize = 4;

// Blocking-sync budget on shutdown/quit. Windows only guarantees a few seconds
// after `WM_QUERYENDSESSION`, so keep this well under that.
const SHUTDOWN_SYNC_TIMEOUT: Duration = Duration::from_secs(3);

// How long a successful "up to date" result keeps showing before the tray menu
// offers a manual re-check again.
const UP_TO_DATE_TTL: Duration = Duration::from_secs(30 * 60);

// Menu command ids.
const IDM_SYNC_NOW: usize = 101;
const IDM_QUIT: usize = 104;
const IDM_OPEN_TIMESHEET: usize = 105;
const IDM_PAUSE: usize = 106;
const IDM_SETTINGS: usize = 107;
const IDM_DOWNLOAD_UPDATE: usize = 108;

// Keep the tray short: a few project lines, at most one site line.
const BREAKDOWN_MAX_ROWS: usize = 3;
const CONTEXT_MAX_ROWS: usize = 2;

struct AppState {
    conn: Connection,
    config: Config,
    /// Project-classification rules for foreground activity. Loaded at startup
    /// and reloaded when settings are saved so hand-edits to `rules.toml` apply
    /// without a restart.
    rules: crate::rules::Rules,
    hwnd: HWND,
    nid: NOTIFYICONDATAW,
    taskbar_created: u32,
    syncing: bool,
    /// True while we are auto-clocked-out for inactivity. Only this flag lets a
    /// bare keypress resume tracking; lock/suspend clock-outs still require their
    /// matching unlock/resume event.
    idle_out: bool,
    /// True while the user has manually paused tracking. Blocks the idle
    /// heartbeat and other automatic clock-ins, but the next open event (wake /
    /// unlock / app start) clears it and resumes — so the user never has to
    /// remember to unpause after closing the laptop.
    paused: bool,
    /// Whether the "clocking out soon" balloon has already fired for the current
    /// idle stretch (so we warn once, not every heartbeat).
    idle_warned: bool,
    /// When the user went idle for the current idle auto-clock-out (the backdated
    /// session end). Drives the "were you working?" reclaim prompt on return.
    /// `None` unless we are latched idle_out after a real (non-empty) clock-out.
    idle_since: Option<DateTime<Utc>>,
    /// In-flight guard + payload for the idle-reclaim modal: the idle-start time
    /// to backfill from. Set when the modal is queued, cleared when answered, so
    /// heartbeats during the modal don't stack a second prompt or resume early.
    pending_reclaim: Option<DateTime<Utc>>,
    /// Remembered answer to the after-hours "are you working?" prompt for this
    /// physical open cycle. Lock/suspend clears it; resume+unlock notifications
    /// from the same opening reuse it so they cannot stack duplicate prompts.
    /// It is also cleared on the next event inside working hours *or* on a new local
    /// day, so each evening — and each non-working day (e.g. a weekend where no
    /// event ever lands inside working hours) — asks fresh.
    after_hours_answer: Option<bool>,
    /// Local date the `after_hours_answer` was recorded for. Opening the laptop
    /// on a later date clears the remembered answer so the prompt fires again.
    after_hours_date: Option<NaiveDate>,
    /// Clock-in reason for the after-hours prompt, and the in-flight guard for
    /// it: set when the modal is queued and left set until it's answered, so a
    /// resume+unlock pair (or any event during the modal) can't stack a second
    /// prompt.
    pending_open: Option<&'static str>,
    update_status: crate::update::UpdateStatus,
    /// When the last update check completed. Lets a stale "up to date" revert to
    /// a checkable "check for updates" after `UP_TO_DATE_TTL`.
    update_checked_at: Option<Instant>,
    /// Continuous foreground segment accumulator (app / project timing).
    activity: ActivityTracker,
    /// Lowercased own exe so we never attribute time to clocked's UI.
    own_exe: String,
    /// Loopback bridge for the Chrome extension (active-tab domain).
    bridge: Arc<BridgeState>,
}

impl AppState {
    fn clock_in(&mut self, reason: &str) {
        self.clock_in_at(reason, Utc::now());
    }

    /// Open a session starting at `at`. `at` is normally `Utc::now()`, but the
    /// idle-reclaim path backdates it to the moment the user went idle so the
    /// away stretch (a meeting, reading, etc.) counts as worked.
    fn clock_in_at(&mut self, reason: &str, at: DateTime<Utc>) {
        // While manually paused, ignore every automatic clock-in. The manual
        // resume path clears `paused` before calling this.
        if self.paused {
            return;
        }
        // Any real clock-in clears the idle latch: we are present again.
        self.idle_out = false;
        self.idle_since = None;
        match crate::db::clock_in(&self.conn, reason, at) {
            Ok(true) => {
                crate::logln!("clock in ({reason})");
                self.update_tooltip();
            }
            Ok(false) => {}
            Err(e) => crate::logln!("clock_in error: {e}"),
        }
    }

    fn is_clocked_in(&self) -> bool {
        matches!(crate::db::open_session_start(&self.conn), Ok(Some(_)))
    }

    /// A real lock/suspend ends the current open cycle. Forget the prior
    /// after-hours answer so the next resume/unlock asks again. Idle clock-outs
    /// do not pass through here and therefore still resume without this prompt.
    fn close_event(&mut self, reason: &'static str) {
        self.after_hours_answer = None;
        self.after_hours_date = None;
        self.clock_out(reason);
    }

    /// A "computer opened" moment (wake / unlock / app start). Policy comes from
    /// [`engine::decide_open`] so Windows and macOS stay in lockstep.
    fn open_event(&mut self, reason: &'static str) {
        // Opening the machine always resumes tracking: a manual pause lasts only
        // until the next open (wake / unlock / app start), so the user never has
        // to remember to unpause after closing the laptop.
        if self.paused {
            self.paused = false;
            crate::logln!("resumed (open)");
        }
        let now = Local::now();
        // A new local day is a fresh after-hours stretch.
        if self.after_hours_date != Some(now.date_naive()) {
            self.after_hours_answer = None;
        }
        match engine::decide_open(
            self.config.within_working_hours(now),
            self.after_hours_answer,
        ) {
            OpenDecision::ClockIn => {
                // Cancel any deferred after-hours dialog — hours (or config) say track.
                self.pending_open = None;
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
                // Defer the modal out of the power/session callback.
                if self.pending_open.is_none() {
                    self.pending_open = Some(reason);
                    let _ = unsafe {
                        PostMessageW(Some(self.hwnd), WM_PROMPT_AFTER_HOURS, WPARAM(0), LPARAM(0))
                    };
                }
            }
        }
    }

    /// Ask, via a modal Yes/No box, whether the user is working right now.
    fn prompt_are_you_working(&self) -> bool {
        let text = to_wide("It's outside your working hours. Are you working?");
        let title = to_wide("clocked");
        let r = unsafe {
            MessageBoxW(
                Some(self.hwnd),
                PCWSTR(text.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
            )
        };
        r == IDYES
    }

    /// Clock in after auto-dismissing a stale after-hours prompt / "not working"
    /// answer once we are inside working hours (or the feature is disabled).
    fn auto_accept_after_hours(&mut self, reason: &'static str) {
        self.pending_open = None;
        self.after_hours_answer = None;
        self.after_hours_date = None;
        crate::logln!("after-hours: auto clock-in ({reason}; now within working hours)");
        self.clock_in(reason);
        self.do_sync();
    }

    /// If a deferred prompt or remembered "not working" is still open when the
    /// clock rolls into working hours, start tracking without another click.
    /// Safe to call from the heartbeat (including nested while a MessageBox is up).
    fn maybe_enter_working_hours(&mut self) {
        if self.paused || self.is_clocked_in() {
            return;
        }
        let within = self.config.within_working_hours(Local::now());
        if !engine::should_auto_accept_after_hours(within) {
            return;
        }
        // Only auto-start when we previously deferred/asked after hours — do not
        // invent sessions for machines that simply sat idle overnight unopened.
        let reason = match self.pending_open.take() {
            Some(r) => r,
            None if self.after_hours_answer == Some(false) => "schedule",
            None => return,
        };
        self.auto_accept_after_hours(reason);
    }

    /// Answer a deferred after-hours prompt: track if working, stay out if not,
    /// and remember the choice until the next lock/suspend.
    ///
    /// Re-checks working hours before *and* after the modal so a prompt that
    /// fired before 9:00 (or sat open past start) auto-dismisses into tracking.
    fn resolve_after_hours(&mut self) {
        let Some(reason) = self.pending_open else {
            return;
        };
        // Already inside hours (e.g. delayed WM_PROMPT after a later open_event
        // clocked us in, or the heartbeat cleared the latch): skip the dialog.
        if engine::should_auto_accept_after_hours(self.config.within_working_hours(Local::now())) {
            self.auto_accept_after_hours(reason);
            return;
        }
        let working = self.prompt_are_you_working();
        // Dialog may have been left open past work start — heartbeats can also
        // clear `pending_open` while MessageBox runs its nested pump.
        if self.pending_open.is_none() {
            return;
        }
        if engine::should_auto_accept_after_hours(self.config.within_working_hours(Local::now())) {
            self.auto_accept_after_hours(reason);
            return;
        }
        // Clear the in-flight marker only now, after the modal is answered, so
        // any wake event that arrived while it was up couldn't stack a second
        // prompt (`open_event` skips posting while `pending_open` is set).
        self.pending_open = None;
        self.after_hours_answer = Some(working);
        self.after_hours_date = Some(Local::now().date_naive());
        if working {
            self.clock_in(reason);
            self.do_sync();
        } else {
            crate::logln!("after-hours: user not working");
        }
    }

    /// Toggle tracking from the tray. Stops the clock when running (and latches
    /// it off); otherwise resumes — clearing both the pause and any after-hours
    /// "not working" decision so a fresh session opens.
    fn toggle_pause(&mut self) {
        if self.is_clocked_in() {
            self.activity_flush();
            self.paused = true;
            self.idle_out = false;
            self.idle_warned = false;
            match crate::db::clock_out(&self.conn, "manual", Utc::now()) {
                Ok(_) => crate::logln!("paused"),
                Err(e) => crate::logln!("pause clock_out error: {e}"),
            }
            self.update_tooltip();
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

    /// Stop the clock after a stretch of inactivity, resume it on the first
    /// input afterwards. Decisions come from [`engine::decide_idle`].
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
            idle_since_secs_ago: self.idle_since.map(|s| (Utc::now() - s).num_seconds()),
        };
        match engine::decide_idle(&params) {
            IdleDecision::Nothing => {
                // Clear the one-shot warn flag once the user is active again.
                let warn_at = self
                    .config
                    .idle_timeout_secs
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
                self.activity_flush();
                let last_input = Utc::now() - chrono::Duration::seconds(backdate_secs);
                match crate::db::clock_out(&self.conn, "idle", last_input) {
                    Ok(crate::db::ClockOut::Closed) => {
                        crate::logln!("clock out (idle {backdate_secs}s)");
                        self.idle_out = true;
                        self.idle_since = Some(last_input);
                        self.idle_warned = false;
                        self.update_tooltip();
                        self.do_sync();
                    }
                    Ok(crate::db::ClockOut::DroppedEmpty) => {
                        crate::logln!("ignored empty session (idle {backdate_secs}s)");
                        self.idle_out = true;
                        self.idle_since = None;
                        self.idle_warned = false;
                        self.update_tooltip();
                    }
                    Ok(crate::db::ClockOut::None) => {}
                    Err(e) => crate::logln!("idle clock_out error: {e}"),
                }
            }
            IdleDecision::PromptReclaim { .. } => {
                self.idle_warned = false;
                if let Some(since) = self.idle_since {
                    self.pending_reclaim = Some(since);
                    let _ = unsafe {
                        PostMessageW(Some(self.hwnd), WM_PROMPT_IDLE_RECLAIM, WPARAM(0), LPARAM(0))
                    };
                } else {
                    self.clock_in("active");
                    self.do_sync();
                }
            }
            IdleDecision::ResumeActive => {
                self.idle_warned = false;
                self.clock_in("active");
                self.do_sync();
            }
            IdleDecision::Warn { minutes_left } => {
                crate::tray::notify(
                    &self.nid,
                    "clocked",
                    &format!(
                        "No activity — clocking out in ~{minutes_left} min unless you return."
                    ),
                );
                self.idle_warned = true;
            }
        }
    }

    /// Resolve a queued idle-reclaim prompt: ask whether the away stretch was
    /// working time and either backfill it from `idle_since` or resume from now.
    fn resolve_idle_reclaim(&mut self) {
        // Keep `pending_reclaim` set for the whole modal. `MessageBoxW` runs a
        // nested message loop, so heartbeat timers still fire; if we cleared
        // the guard first, each tick would re-queue another "you were away"
        // prompt (with a climbing minute count as wall time advances).
        let Some(since) = self.pending_reclaim else {
            return;
        };
        let mins = ((Utc::now() - since).num_seconds().max(0) + 30) / 60;
        let reclaim = self.prompt_reclaim(mins);
        // Clear only after the answer, matching `resolve_after_hours`.
        self.pending_reclaim = None;
        if reclaim {
            self.clock_in_at("reclaimed", since);
            crate::logln!("reclaimed idle time ({mins} min)");
        } else {
            self.clock_in("active");
        }
        self.do_sync();
    }

    /// Ask, via a modal Yes/No box, whether the user was working during an idle
    /// stretch of about `mins` minutes.
    fn prompt_reclaim(&self, mins: i64) -> bool {
        let text = to_wide(&format!(
            "You were away for about {mins} min with no keyboard or mouse activity.\n\n\
             Were you still working (e.g. in a meeting, on a call, or reading)? \
             Count that time as worked?"
        ));
        let title = to_wide("clocked");
        let r = unsafe {
            MessageBoxW(
                Some(self.hwnd),
                PCWSTR(text.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
            )
        };
        r == IDYES
    }

    /// Sample the focused window into the activity tracker. Active only while
    /// clocked in, not paused, and either recently active or on a call.
    fn record_activity_tick(&mut self) {
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
        let own = self.own_exe.clone();
        // Prefer extension domain when Chrome/Edge/etc. is focused.
        let (override_ctx, title) = if is_browser_app(&fg.app) {
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
            &self.rules,
            self.config.store_titles,
            true,
            now,
            &fg.app,
            &title,
            &own,
            override_ctx.as_deref(),
        );
    }

    fn activity_flush(&mut self) {
        self.activity.flush(&self.conn, Utc::now());
    }

    fn clock_out(&mut self, reason: &str) {
        self.activity_flush();
        match crate::db::clock_out(&self.conn, reason, Utc::now()) {
            Ok(crate::db::ClockOut::Closed) => {
                crate::logln!("clock out ({reason})");
                self.update_tooltip();
                self.do_sync();
            }
            Ok(crate::db::ClockOut::DroppedEmpty) => {
                crate::logln!("ignored empty session ({reason})");
                self.update_tooltip();
            }
            Ok(crate::db::ClockOut::None) => {}
            Err(e) => crate::logln!("clock_out error: {e}"),
        }
    }

    /// Clock out and sync *synchronously* before returning. For shutdown/quit,
    /// where the spawned background sync would be killed with the process; a
    /// short timeout keeps us from stalling the exit if the network is down.
    fn clock_out_blocking(&mut self, reason: &str) {
        self.activity_flush();
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
            Ok(n) if n > 0 => crate::logln!("synced {n} item(s) before exit"),
            Ok(_) => {}
            Err(e) => crate::logln!("shutdown sync error: {e}"),
        }
    }

    fn status_line(&self) -> String {
        if self.paused {
            return "Paused".to_string();
        }
        match crate::db::open_session_start(&self.conn) {
            Ok(Some(start)) => format!("Tracking · since {}", start.with_timezone(&Local).format("%H:%M")),
            _ => "Not tracking".to_string(),
        }
    }

    fn today_line(&self) -> String {
        let secs = crate::db::today_total_secs(&self.conn, Utc::now()).unwrap_or(0);
        let worked = fmt_dur(secs);
        let target = self.config.target_hours;
        if target > 0.0 {
            let mark = if secs as f64 >= target * 3600.0 { " ✓" } else { "" };
            format!("Today  {worked}  /  {}{mark}", fmt_hours(target))
        } else {
            format!("Today  {worked}")
        }
    }

    fn update_tooltip(&mut self) {
        // Short hover tip — full breakdown lives in the menu.
        let secs = crate::db::today_total_secs(&self.conn, Utc::now()).unwrap_or(0);
        let state = if self.paused {
            "paused"
        } else if self.is_clocked_in() {
            "tracking"
        } else {
            "idle"
        };
        let tip = format!("clocked · {state} · {}", fmt_dur(secs));
        crate::tray::set_tip(&mut self.nid, &tip);
        crate::tray::modify(&self.nid);
    }

    fn do_sync(&mut self) {
        if self.syncing || !self.config.is_configured() {
            return;
        }
        self.syncing = true;
        crate::sync::spawn(self.hwnd.0 as isize, WM_SYNC_DONE, self.config.clone());
    }

    fn check_for_updates(&mut self, manual: bool) {
        if matches!(self.update_status, crate::update::UpdateStatus::Checking) {
            return;
        }
        self.update_status = crate::update::UpdateStatus::Checking;
        crate::update::spawn(self.hwnd.0 as isize, WM_UPDATE_CHECK_DONE, manual);
    }

    /// The update status as the tray menu should show it: a successful "up to
    /// date" older than `UP_TO_DATE_TTL` reverts to an actionable check.
    fn effective_update_status(&self) -> crate::update::UpdateStatus {
        self.update_status
            .for_menu(self.update_checked_at.map(|t| t.elapsed()), UP_TO_DATE_TTL)
    }

    fn finish_update_check(&mut self, result: crate::update::UpdateCheckResult) {
        let manual = result.manual;
        self.update_status = result.status;
        self.update_checked_at = Some(Instant::now());
        match &self.update_status {
            crate::update::UpdateStatus::Available { version, .. } => {
                crate::logln!("update available: v{version}");
                crate::tray::notify(
                    &self.nid,
                    "clocked update available",
                    &format!("Version v{version} is ready to download from the tray menu."),
                );
            }
            crate::update::UpdateStatus::UpToDate { version } => {
                crate::logln!("clocked is up to date: v{version}");
                if manual {
                    crate::tray::notify(
                        &self.nid,
                        "clocked",
                        &format!("You're up to date on v{version}."),
                    );
                }
            }
            crate::update::UpdateStatus::Failed if manual => {
                crate::tray::notify(
                    &self.nid,
                    "clocked",
                    "Couldn't check for updates. Try again later.",
                );
            }
            crate::update::UpdateStatus::Failed => {}
            crate::update::UpdateStatus::Unknown | crate::update::UpdateStatus::Checking => {}
        }
    }

    /// Open the native settings window (or focus it if already open).
    fn open_settings(&mut self) {
        crate::settings::open(self.hwnd.0 as isize, WM_SETTINGS_SAVED);
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Format a duration in seconds as `2h 05m`, or `45m` under an hour, for the
/// tray breakdown lines.
fn fmt_dur(secs: i64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 0 {
        format!("{h}h {m:02}m")
    } else {
        format!("{m}m")
    }
}

fn truncate(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{t}…")
    }
}

fn is_browser_app(app: &str) -> bool {
    let a = app.to_ascii_lowercase();
    a.contains("chrome")
        || a.contains("msedge")
        || a.contains("firefox")
        || a.contains("brave")
        || a.contains("opera")
        || a.contains("vivaldi")
        || a == "safari"
        || a.ends_with("browser.exe")
}

/// Format a goal like `8h` or `7.5h`, dropping a trailing `.0`.
fn fmt_hours(h: f64) -> String {
    if (h.fract()).abs() < 1e-9 {
        format!("{}h", h as i64)
    } else {
        format!("{h:.1}h")
    }
}

/// Open a URL in the default browser. Used to launch the Worker dashboard,
/// whose month picker defaults to the current month — i.e. this month's
/// timesheet.
fn open_url(url: &str) {
    let url = url.trim();
    if url.is_empty() {
        return;
    }
    let wide = to_wide(url);
    unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Build and show the tray context menu. Uses `TPM_RETURNCMD` and holds no
/// borrow of `AppState` while `TrackPopupMenu` pumps its own modal loop.
unsafe fn show_menu(hwnd: HWND, ptr: *mut AppState) {
    let (
        status,
        today,
        breakdown,
        contexts,
        suggestions,
        worker_url,
        clocked_in,
        configured,
        update_label,
        update_enabled,
    ) = {
        let app = &*ptr;
        let update = app.effective_update_status();
        let now = Utc::now();
        (
            app.status_line(),
            app.today_line(),
            crate::db::today_by_project(&app.conn, now).unwrap_or_default(),
            crate::db::today_by_context(&app.conn, now).unwrap_or_default(),
            crate::db::suggest_assignments(&app.conn, &app.rules, 3).unwrap_or_default(),
            app.config.effective_worker_url().to_string(),
            app.is_clocked_in(),
            app.config.is_configured(),
            update.menu_label(),
            update.menu_enabled(),
        )
    };

    let Ok(menu) = CreatePopupMenu() else {
        return;
    };

    // —— Status (gray, scannable) ——
    let wstatus = to_wide(&status);
    let wtoday = to_wide(&today);
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wstatus.as_ptr()));
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wtoday.as_ptr()));

    // —— Compact breakdown (projects, then top sites) ——
    if !breakdown.is_empty() || !contexts.is_empty() {
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    }
    if !breakdown.is_empty() {
        for (project, secs) in breakdown.iter().take(BREAKDOWN_MAX_ROWS) {
            // Fixed-width feel: "  Coding              1h 20m"
            let line = to_wide(&format!("  {:<18}  {}", truncate(project, 18), fmt_dur(*secs)));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
        if breakdown.len() > BREAKDOWN_MAX_ROWS {
            let other: i64 = breakdown[BREAKDOWN_MAX_ROWS..].iter().map(|(_, s)| s).sum();
            let line = to_wide(&format!("  {:<18}  {}", "Other", fmt_dur(other)));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
    }
    if !contexts.is_empty() {
        // Indent sites under projects so the menu reads as one block.
        for (ctx, secs) in contexts.iter().take(CONTEXT_MAX_ROWS) {
            let line = to_wide(&format!("    · {:<16} {}", truncate(ctx, 16), fmt_dur(*secs)));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
    }
    // Unassigned apps with enough time — nudge to Settings → Projects.
    if !suggestions.is_empty() {
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_GRAYED, 0, w!("Unassigned (set in Settings)"));
        for (app, secs) in suggestions.iter() {
            let label = crate::rules::pretty_app_name(app);
            let line = to_wide(&format!("  {:<18}  {}", truncate(&label, 18), fmt_dur(*secs)));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
    }

    // —— Primary actions ——
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let pause_label = if clocked_in {
        w!("Pause")
    } else {
        w!("Resume")
    };
    let _ = AppendMenuW(menu, MF_STRING, IDM_PAUSE, pause_label);
    if !worker_url.trim().is_empty() {
        let _ = AppendMenuW(menu, MF_STRING, IDM_OPEN_TIMESHEET, w!("Open timesheet"));
    }
    let _ = AppendMenuW(menu, MF_STRING, IDM_SETTINGS, w!("Settings"));

    // —— Secondary (only when useful) ——
    if configured {
        let _ = AppendMenuW(menu, MF_STRING, IDM_SYNC_NOW, w!("Sync now"));
    }
    // Always show updates: clickable to re-check, or opens download when one exists.
    // Only grayed while a check is in flight (`update_enabled` false).
    let update_flags = if update_enabled { MF_STRING } else { MF_GRAYED };
    let wupdate = to_wide(&update_label);
    let _ = AppendMenuW(
        menu,
        update_flags,
        IDM_DOWNLOAD_UPDATE,
        PCWSTR(wupdate.as_ptr()),
    );

    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let _ = AppendMenuW(menu, MF_STRING, IDM_QUIT, w!("Quit"));

    let _ = SetForegroundWindow(hwnd);
    let mut pt = POINT::default();
    let _ = GetCursorPos(&mut pt);
    let cmd = TrackPopupMenu(
        menu,
        TPM_RIGHTBUTTON | TPM_RETURNCMD,
        pt.x,
        pt.y,
        None,
        hwnd,
        None,
    );
    let _ = DestroyMenu(menu);
    // Classic dismissal fix so the menu closes on outside click.
    let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));

    match cmd.0 as usize {
        IDM_PAUSE => (*ptr).toggle_pause(),
        IDM_SETTINGS => (*ptr).open_settings(),
        IDM_OPEN_TIMESHEET => {
            // Open the dashboard already signed in: swap the sync token for a
            // one-time login URL off the UI thread (network), falling back to
            // the plain dashboard if that's unavailable. open_url just launches
            // the default browser, which is safe from a background thread.
            let cfg = (*ptr).config.clone();
            std::thread::spawn(move || {
                let url = crate::sync::desktop_login_url(&cfg).unwrap_or(worker_url);
                open_url(&url);
            });
        }
        IDM_SYNC_NOW => (*ptr).do_sync(),
        IDM_DOWNLOAD_UPDATE => {
            let app = &mut *ptr;
            if let Some(url) = app.update_status.download_url() {
                open_url(url);
            } else {
                app.check_for_updates(true);
            }
        }
        IDM_QUIT => {
            let _ = DestroyWindow(hwnd);
        }
        _ => {}
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppState;
    if ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    // Re-add the icon if Explorer restarted (runtime message id, not a const).
    {
        let app = &*ptr;
        if msg == app.taskbar_created {
            crate::tray::add(&app.nid);
            return LRESULT(0);
        }
    }

    match msg {
        WM_POWERBROADCAST => {
            match map_power(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).open_event(r),
                Action::Close(r) => (*ptr).close_event(r),
                Action::Ignore => {}
            }
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            match map_session(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).open_event(r),
                Action::Close(r) => (*ptr).close_event(r),
                Action::Ignore => {}
            }
            LRESULT(0)
        }
        WM_PROMPT_AFTER_HOURS => {
            (*ptr).resolve_after_hours();
            LRESULT(0)
        }
        WM_PROMPT_IDLE_RECLAIM => {
            (*ptr).resolve_idle_reclaim();
            LRESULT(0)
        }
        WM_SETTINGS_SAVED => {
            let app = &mut *ptr;
            app.config = Config::load();
            app.rules = crate::rules::Rules::load();
            app.bridge.set_token(&app.config.bearer_token);
            app.update_tooltip();
            app.do_sync();
            LRESULT(0)
        }
        WM_QUERYENDSESSION => {
            (*ptr).clock_out_blocking("shutdown");
            LRESULT(1)
        }
        WM_TIMER => {
            match wparam.0 {
                TIMER_HEARTBEAT => {
                    let app = &mut *ptr;
                    let now = Utc::now();
                    let _ = crate::db::heartbeat(&app.conn, now);
                    // Checkpoint open activity segments and prune old history.
                    app.activity.checkpoint(&app.conn, now);
                    let _ = crate::db::prune_activity(
                        &app.conn,
                        now,
                        app.config.activity_retention_days,
                    );
                    // Enter working hours: dismiss a stale after-hours prompt /
                    // "not working" answer without another user click.
                    app.maybe_enter_working_hours();
                    app.check_idle();
                    app.record_activity_tick();
                    app.update_tooltip();
                }
                TIMER_ACTIVITY => {
                    (*ptr).record_activity_tick();
                }
                TIMER_SYNC => (*ptr).do_sync(),
                TIMER_UPDATE_CHECK => (*ptr).check_for_updates(false),
                _ => {}
            }
            LRESULT(0)
        }
        WM_TRAY => {
            let low = (lparam.0 as u32) & 0xFFFF;
            if low == WM_RBUTTONUP || low == WM_CONTEXTMENU || low == WM_LBUTTONUP {
                show_menu(hwnd, ptr);
            }
            LRESULT(0)
        }
        WM_SYNC_DONE => {
            let app = &mut *ptr;
            app.syncing = false;
            app.update_tooltip();
            LRESULT(0)
        }
        WM_UPDATE_CHECK_DONE => {
            let app = &mut *ptr;
            let raw = wparam.0 as *mut crate::update::UpdateCheckResult;
            if !raw.is_null() {
                app.finish_update_check(*Box::from_raw(raw));
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            let app = &mut *ptr;
            app.clock_out_blocking("quit");
            crate::tray::remove(&app.nid);
            let _ = WTSUnRegisterSessionNotification(hwnd);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Create the window, wire up notifications/tray/timers, and run the loop.
pub fn run() -> windows::core::Result<()> {
    unsafe {
        // Single-instance guard: bail out if another clocked is already running in
        // this user session. CreateMutexW still returns a valid handle when the named
        // mutex already exists, but sets the last error to ERROR_ALREADY_EXISTS. The
        // kernel releases the mutex automatically when the process exits (even on a
        // crash), so there is no stale lock to clean up. `_mutex` is held for the whole
        // process lifetime — dropping it early would release the guard.
        let _mutex = CreateMutexW(None, true, w!("Local\\ClockedSingleInstance"))?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            logln!("another instance is already running; exiting");
            return Ok(());
        }

        let hinstance = HINSTANCE(GetModuleHandleW(None)?.0);
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err(windows::core::Error::from_thread());
        }

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            w!("clocked"),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance),
            None,
        )?;

        // Build state and attach it to the window. The window is never shown.
        let conn = crate::db::open().expect("open database");
        let config = Config::load();
        let taskbar_created = RegisterWindowMessageW(w!("TaskbarCreated"));
        let nid = crate::tray::build(hwnd, WM_TRAY);
        let ptr = Box::into_raw(Box::new(AppState {
            conn,
            config,
            rules: crate::rules::Rules::load(),
            hwnd,
            nid,
            taskbar_created,
            syncing: false,
            idle_out: false,
            paused: false,
            idle_warned: false,
            idle_since: None,
            pending_reclaim: None,
            after_hours_answer: None,
            after_hours_date: None,
            pending_open: None,
            update_status: crate::update::UpdateStatus::Unknown,
            update_checked_at: None,
            activity: ActivityTracker::new(),
            own_exe: std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
                .unwrap_or_default(),
            bridge: BridgeState::new(Config::load().bearer_token),
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);

        // Startup sequence.
        {
            let app = &mut *ptr;
            let now = Utc::now();
            let _ = crate::db::recover_crashed(&app.conn, now);
            let _ = crate::db::heartbeat(&app.conn, now);
            let _ = crate::db::prune_activity(&app.conn, now, app.config.activity_retention_days);
            // Browser extension bridge (127.0.0.1 only). Needs a token to accept tabs.
            crate::bridge::start(Arc::clone(&app.bridge), crate::bridge::DEFAULT_PORT);
            app.open_event("start");

            let _ = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            crate::tray::add(&app.nid);
            app.update_tooltip();

            let _ = SetTimer(Some(hwnd), TIMER_HEARTBEAT, 60_000, None);
            // 5s focus poll — segment tracker attributes exact elapsed times.
            let _ = SetTimer(Some(hwnd), TIMER_ACTIVITY, 5_000, None);
            let _ = SetTimer(Some(hwnd), TIMER_SYNC, 3_600_000, None);
            let _ = SetTimer(Some(hwnd), TIMER_UPDATE_CHECK, 21_600_000, None);
            app.do_sync();
            app.check_for_updates(false);
        }

        // Message loop.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // Window destroyed — reclaim state.
        drop(Box::from_raw(ptr));
    }
    Ok(())
}
