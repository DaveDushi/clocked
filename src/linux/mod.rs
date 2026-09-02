//! Linux desktop layer: GTK/AppIndicator tray UI, Wayland idle tracking,
//! Hyprland/logind lock detection, and suspend-aware session accounting.

mod gtk;

use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, Utc};
use rusqlite::Connection;

use crate::activity::ActivityTracker;
use crate::bridge::BridgeState;
use crate::config::Config;
use crate::engine::{self, IdleDecision, OpenDecision};
use crate::rules::Rules;

const TICK_SECS: u32 = 5;
const SHUTDOWN_SYNC_TIMEOUT: Duration = Duration::from_secs(3);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Some(_instance_lock) = InstanceLock::acquire()? else {
        return Ok(());
    };
    if !gtk::init() {
        return Err("GTK could not connect to the current desktop session".into());
    }

    install_signal_handlers();

    let mut app = Box::new(AppState::new());
    let app_ptr = (&mut *app) as *mut AppState;
    app.ui = Some(Ui::new(app_ptr));
    app.on_startup();
    app.refresh_ui();

    gtk::timer(TICK_SECS, tick_callback, app_ptr.cast());
    gtk::main_loop();

    if !app.shut_down {
        app.shutdown("quit");
    }
    Ok(())
}

struct AppState {
    conn: Connection,
    config: Config,
    rules: Rules,
    activity: ActivityTracker,
    own_exe: String,
    syncing: Arc<AtomicBool>,
    idle_out: bool,
    paused: bool,
    idle_warned: bool,
    idle_since: Option<DateTime<Utc>>,
    after_hours_answer: Option<bool>,
    after_hours_date: Option<NaiveDate>,
    bridge: Arc<BridgeState>,
    ui: Option<Ui>,
    ticks: u64,
    last_locked: Option<bool>,
    sleep_clock: SleepClock,
    shut_down: bool,
}

impl AppState {
    fn new() -> Self {
        let conn = crate::db::open().expect("open database");
        let config = Config::load();
        let _ = crate::db::prune_activity(&conn, Utc::now(), config.activity_retention_days);
        let bridge = BridgeState::new(config.bearer_token.clone());
        Self {
            conn,
            config,
            rules: Rules::load(),
            activity: ActivityTracker::new(),
            own_exe: std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
                .unwrap_or_default(),
            syncing: Arc::new(AtomicBool::new(false)),
            idle_out: false,
            paused: false,
            idle_warned: false,
            idle_since: None,
            after_hours_answer: None,
            after_hours_date: None,
            bridge,
            ui: None,
            ticks: 0,
            last_locked: session_locked(),
            sleep_clock: SleepClock::new(),
            shut_down: false,
        }
    }

    fn on_startup(&mut self) {
        crate::bridge::start(Arc::clone(&self.bridge), crate::bridge::DEFAULT_PORT);
        let _ = crate::db::recover_crashed(&self.conn, Utc::now());
        let _ = crate::db::heartbeat(&self.conn, Utc::now());
        // Do not begin a session when autostart happens into an already-locked
        // desktop. The first unlock transition will start it.
        if self.last_locked != Some(true) {
            self.open_event("start");
        }
        self.do_sync();
        self.check_for_updates();
        // Starts the Wayland listener immediately instead of waiting one minute.
        let _ = crate::idle::idle_duration();
    }

    fn tick(&mut self) {
        if STOP_REQUESTED.load(Ordering::SeqCst) {
            self.shutdown("shutdown");
            gtk::quit();
            return;
        }

        let locked_now = session_locked().or(self.last_locked);
        if let Some(slept) = self.sleep_clock.suspend_duration() {
            self.resume_after_suspend(slept, locked_now == Some(true));
        }
        if let (Some(previous), Some(current)) = (self.last_locked, locked_now) {
            if current != previous {
                if current {
                    self.close_event("lock");
                } else {
                    self.open_event("unlock");
                }
            }
        }
        self.last_locked = locked_now;

        self.record_activity_tick();
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks % (60 / TICK_SECS as u64) == 0 {
            self.heartbeat_tick();
        }
        if self.ticks % (3600 / TICK_SECS as u64) == 0 {
            self.do_sync();
        }
        if self.ticks % (6 * 3600 / TICK_SECS as u64) == 0 {
            self.check_for_updates();
        }
        self.refresh_ui();
    }

    fn heartbeat_tick(&mut self) {
        let now = Utc::now();
        let _ = crate::db::heartbeat(&self.conn, now);
        if self.config.track_projects {
            self.activity.checkpoint(&self.conn, now);
            let _ = crate::db::prune_activity(
                &self.conn,
                now,
                self.config.activity_retention_days,
            );
        }
        self.maybe_enter_working_hours();
        self.check_idle();
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

    fn activity_flush(&mut self) {
        self.activity.flush(&self.conn, Utc::now());
    }

    fn record_activity_tick(&mut self) {
        if !self.config.track_projects {
            self.activity.flush(&self.conn, Utc::now());
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
            &self.own_exe,
            override_ctx.as_deref(),
        );
    }

    fn clock_out_at(&mut self, reason: &str, at: DateTime<Utc>, sync: bool) {
        self.activity_flush();
        match crate::db::clock_out(&self.conn, reason, at) {
            Ok(crate::db::ClockOut::Closed) => {
                crate::logln!("clock out ({reason})");
                if sync {
                    self.do_sync();
                }
            }
            Ok(crate::db::ClockOut::DroppedEmpty) => {
                crate::logln!("ignored empty session ({reason})")
            }
            Ok(crate::db::ClockOut::None) => {}
            Err(e) => crate::logln!("clock_out error: {e}"),
        }
    }

    fn close_event(&mut self, reason: &'static str) {
        self.after_hours_answer = None;
        self.after_hours_date = None;
        self.clock_out_at(reason, Utc::now(), true);
    }

    fn resume_after_suspend(&mut self, slept: Duration, still_locked: bool) {
        let at = Utc::now()
            - chrono::Duration::from_std(slept).unwrap_or_else(|_| chrono::Duration::zero());
        self.after_hours_answer = None;
        self.after_hours_date = None;
        self.clock_out_at("suspend", at, true);
        crate::logln!("resume detected after {:.1}s suspended", slept.as_secs_f64());
        if !still_locked {
            self.open_event("resume");
        }
    }

    fn open_event(&mut self, reason: &'static str) {
        if self.paused {
            self.paused = false;
            crate::logln!("resumed (open)");
        }
        let now = Local::now();
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
                let working = gtk::ask(
                    "clocked",
                    "This is outside your configured working hours. Are you working?",
                    "Yes, start tracking",
                    "No",
                );
                self.after_hours_answer = Some(working);
                self.after_hours_date = Some(Local::now().date_naive());
                if working {
                    self.clock_in(reason);
                    self.do_sync();
                } else {
                    crate::logln!("after-hours: user not working");
                }
            }
        }
    }

    fn maybe_enter_working_hours(&mut self) {
        if self.paused || self.is_clocked_in() || self.after_hours_answer != Some(false) {
            return;
        }
        if engine::should_auto_accept_after_hours(
            self.config.within_working_hours(Local::now()),
        ) {
            self.after_hours_answer = None;
            self.after_hours_date = None;
            self.clock_in("schedule");
            self.do_sync();
        }
    }

    fn check_idle(&mut self) {
        let idle_secs = crate::idle::idle_duration().as_secs();
        let params = engine::IdleParams {
            paused: self.paused,
            timeout_secs: self.config.idle_timeout_secs,
            idle_secs,
            in_call: crate::media::in_use(),
            clocked_in: self.is_clocked_in(),
            idle_out: self.idle_out,
            reclaim_pending: false,
            idle_warned: self.idle_warned,
            idle_since_secs_ago: self
                .idle_since
                .map(|since| (Utc::now() - since).num_seconds()),
        };
        match engine::decide_idle(&params) {
            IdleDecision::Nothing => {
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
                self.activity_flush();
                match crate::db::clock_out(&self.conn, "idle", last_input) {
                    Ok(crate::db::ClockOut::Closed) => {
                        crate::logln!("clock out (idle {idle_secs}s)");
                        self.idle_out = true;
                        self.idle_since = Some(last_input);
                        self.idle_warned = false;
                        self.do_sync();
                    }
                    Ok(crate::db::ClockOut::DroppedEmpty) => {
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
                let since = Utc::now() - chrono::Duration::seconds(idle_since_secs_ago);
                let minutes = (idle_since_secs_ago.max(0) + 30) / 60;
                let reclaim = gtk::ask(
                    "clocked",
                    &format!("You were away for about {minutes} minutes. Count that time as worked?"),
                    "Yes, count it",
                    "No",
                );
                if reclaim {
                    self.clock_in_at("reclaimed", since);
                    crate::logln!("reclaimed idle time ({minutes} min)");
                } else {
                    self.clock_in("active");
                }
                self.do_sync();
            }
            IdleDecision::ResumeActive => {
                self.idle_warned = false;
                self.clock_in("active");
                self.do_sync();
            }
            IdleDecision::Warn { minutes_left } => {
                notify(&format!(
                    "No activity — clocking out in ~{minutes_left} min unless you return."
                ));
                self.idle_warned = true;
            }
        }
    }

    fn toggle_pause(&mut self) {
        if self.is_clocked_in() {
            self.paused = true;
            self.idle_out = false;
            self.idle_warned = false;
            self.clock_out_at("manual", Utc::now(), true);
            crate::logln!("paused");
        } else {
            self.paused = false;
            self.idle_warned = false;
            self.after_hours_answer = Some(true);
            self.after_hours_date = Some(Local::now().date_naive());
            self.clock_in("manual");
            self.do_sync();
            crate::logln!("resumed");
        }
        self.refresh_ui();
    }

    fn do_sync(&mut self) {
        self.start_sync(false);
    }

    fn start_sync(&mut self, manual: bool) {
        if !self.config.is_configured() {
            if manual {
                notify("Add your sync token from the clocked tray menu first.");
            }
            return;
        }
        if self.syncing.swap(true, Ordering::SeqCst) {
            if manual {
                notify("Sync already in progress…");
            }
            return;
        }
        let config = self.config.clone();
        let syncing = Arc::clone(&self.syncing);
        std::thread::spawn(move || {
            let result = crate::sync::run_blocking(&config, Duration::from_secs(30));
            match result {
                Ok(n) => {
                    if n > 0 {
                        crate::logln!("synced {n} item(s)");
                    }
                    if manual {
                        notify(if n > 0 { "Sync complete." } else { "Already up to date." });
                    }
                }
                Err(e) => {
                    crate::logln!("sync error: {e}");
                    if manual {
                        notify(&format!("Sync failed: {e}"));
                    }
                }
            }
            syncing.store(false, Ordering::SeqCst);
        });
    }

    fn set_sync_token(&mut self) {
        let Some(token) = gtk::text_input(
            "Set clocked sync token",
            "Paste the clk_… token from your clocked dashboard. It will be stored in your desktop keyring.",
            "clk_…",
        ) else {
            return;
        };
        self.config.bearer_token = token;
        match self.config.save() {
            Ok(()) => {
                self.config = Config::load();
                self.bridge.set_token(&self.config.bearer_token);
                notify("Sync token saved securely.");
                self.do_sync();
            }
            Err(e) => {
                crate::logln!("save token error: {e}");
                notify(&format!("Could not save the token: {e}"));
            }
        }
    }

    fn open_timesheet(&self) {
        let config = self.config.clone();
        let fallback = config.effective_worker_url().to_string();
        std::thread::spawn(move || {
            let url = crate::sync::desktop_login_url(&config).unwrap_or(fallback);
            let _ = Command::new("xdg-open")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        });
    }

    fn open_settings(&self) {
        if let Some(path) = crate::paths::config_file() {
            if let Err(e) = open_settings_file(&path) {
                crate::logln!("open settings error: {e}");
                notify(&format!("Could not open settings: {e}"));
            }
        }
    }

    fn reload_settings(&mut self) {
        self.config = Config::load();
        self.rules = Rules::load();
        self.bridge.set_token(&self.config.bearer_token);
        notify("Settings reloaded.");
        self.do_sync();
        self.refresh_ui();
    }

    fn toggle_autostart(&mut self) {
        let result = if crate::autostart::is_enabled() {
            crate::autostart::disable()
        } else {
            crate::autostart::enable()
        };
        if let Err(e) = result {
            crate::logln!("autostart update error: {e}");
            notify(&format!("Could not update login startup: {e}"));
        }
        self.refresh_ui();
    }

    fn check_for_updates(&self) {
        std::thread::spawn(|| match crate::update::check_latest() {
            Ok(crate::update::UpdateStatus::Available { version, .. }) => notify(&format!(
                "clocked v{version} is available at {}",
                crate::update::DOWNLOAD_URL
            )),
            Ok(_) => {}
            Err(e) => crate::logln!("update check error: {e}"),
        });
    }

    fn shutdown(&mut self, reason: &str) {
        if self.shut_down {
            return;
        }
        self.shut_down = true;
        self.activity_flush();
        match crate::db::clock_out(&self.conn, reason, Utc::now()) {
            Ok(crate::db::ClockOut::Closed) => crate::logln!("clock out ({reason})"),
            Ok(_) => return,
            Err(e) => {
                crate::logln!("clock_out error: {e}");
                return;
            }
        }
        if self.config.is_configured() {
            match crate::sync::run_blocking(&self.config, SHUTDOWN_SYNC_TIMEOUT) {
                Ok(n) if n > 0 => crate::logln!("synced {n} item(s) before exit"),
                Ok(_) => {}
                Err(e) => crate::logln!("shutdown sync error: {e}"),
            }
        }
    }

    fn status_line(&self) -> String {
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

    fn today_line(&self) -> String {
        let secs = crate::db::today_total_secs(&self.conn, Utc::now()).unwrap_or(0);
        let worked = fmt_duration(secs);
        if self.config.target_hours > 0.0 {
            let mark = if secs as f64 >= self.config.target_hours * 3600.0 {
                " ✓"
            } else {
                ""
            };
            format!(
                "Today  {worked} / {}{mark}",
                fmt_hours(self.config.target_hours)
            )
        } else {
            format!("Today  {worked}")
        }
    }

    fn refresh_ui(&self) {
        let Some(ui) = &self.ui else {
            return;
        };
        let status = self.status_line();
        let today = self.today_line();
        let pause = if self.is_clocked_in() {
            "Pause tracking"
        } else {
            "Resume tracking"
        };
        let autostart = if crate::autostart::is_enabled() {
            "Disable start at login"
        } else {
            "Enable start at login"
        };
        gtk::set_label(ui.status, &status);
        gtk::set_label(ui.today, &today);
        gtk::set_label(ui.pause, pause);
        gtk::set_label(ui.autostart, autostart);
        gtk::tooltip(
            ui.indicator,
            &ui.icon_name,
            &format!("{status} · {today}"),
        );
    }
}

/// Open the hand-editable config in the desktop's editor.
///
/// On Hyprland, `xdg-open` uses its generic launcher. That launcher does not
/// honor `Terminal=true` in desktop files, so terminal editors such as Neovim
/// are started without a terminal and disappear immediately. Omarchy's editor
/// launcher handles both terminal and graphical editor choices correctly.
fn open_settings_file(path: &std::path::Path) -> std::io::Result<()> {
    let omarchy = Command::new("omarchy-launch-editor")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match omarchy {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Command::new("xdg-open")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ()),
        Err(e) => Err(e),
    }
}

struct Ui {
    indicator: gtk::Widget,
    icon_name: String,
    status: gtk::Widget,
    today: gtk::Widget,
    pause: gtk::Widget,
    autostart: gtk::Widget,
}

impl Ui {
    fn new(app: *mut AppState) -> Self {
        let data = app.cast();
        let menu = gtk::menu();
        let status = gtk::menu_item(menu, "Starting…", None, data);
        let today = gtk::menu_item(menu, "Today", None, data);
        gtk::set_sensitive(status, false);
        gtk::set_sensitive(today, false);
        gtk::separator(menu);
        let pause = gtk::menu_item(menu, "Pause tracking", Some(on_pause), data);
        gtk::menu_item(menu, "Open timesheet", Some(on_timesheet), data);
        gtk::menu_item(menu, "Sync now", Some(on_sync), data);
        gtk::separator(menu);
        gtk::menu_item(menu, "Set sync token…", Some(on_token), data);
        gtk::menu_item(menu, "Open settings file", Some(on_settings), data);
        gtk::menu_item(menu, "Reload settings", Some(on_reload), data);
        let autostart = gtk::menu_item(menu, "Enable start at login", Some(on_autostart), data);
        gtk::separator(menu);
        gtk::menu_item(menu, "Quit", Some(on_quit), data);
        gtk::show_all(menu);

        let icon_name = "clocked-symbolic".to_string();
        let indicator = gtk::indicator(menu, &icon_name, tray_icon_theme_path().as_deref());
        Self {
            indicator,
            icon_name,
            status,
            today,
            pause,
            autostart,
        }
    }
}

unsafe extern "C" fn tick_callback(data: *mut std::ffi::c_void) -> i32 {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (&mut *data.cast::<AppState>()).tick();
    }));
    (!STOP_REQUESTED.load(Ordering::SeqCst)) as i32
}

macro_rules! callback {
    ($name:ident, $body:expr) => {
        unsafe extern "C" fn $name(_: gtk::Widget, data: *mut std::ffi::c_void) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let app = &mut *data.cast::<AppState>();
                $body(app);
            }));
        }
    };
}

callback!(on_pause, |app: &mut AppState| app.toggle_pause());
callback!(on_timesheet, |app: &mut AppState| app.open_timesheet());
callback!(on_sync, |app: &mut AppState| app.start_sync(true));
callback!(on_token, |app: &mut AppState| app.set_sync_token());
callback!(on_settings, |app: &mut AppState| app.open_settings());
callback!(on_reload, |app: &mut AppState| app.reload_settings());
callback!(on_autostart, |app: &mut AppState| app.toggle_autostart());
callback!(on_quit, |app: &mut AppState| {
    app.shutdown("quit");
    gtk::quit();
});

fn notify(body: &str) {
    let mut command = Command::new("notify-send");
    command.arg("--app-name=clocked");
    if let Some(icon) = notification_icon() {
        // Omarchy's Quickshell notification renderer does not reliably resolve
        // custom icon-theme names and shows its magenta missing-image texture.
        // An absolute filename is unambiguous on every notification server.
        command.arg("--icon").arg(icon);
    }
    let _ = command
        .args(["clocked", body])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn notification_icon() -> Option<PathBuf> {
    let icon = crate::paths::data_dir()?
        .parent()?
        .join("icons/hicolor/256x256/apps/clocked.png");
    icon.is_file().then_some(icon)
}

fn session_locked() -> Option<bool> {
    // Omarchy's helper understands its ext-session-lock implementation and is
    // the most accurate source on this machine.
    if let Ok(status) = Command::new("omarchy-hyprland-session-locked")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        match status.code() {
            Some(0) => return Some(true),
            Some(1) => return Some(false),
            _ => {}
        }
    }

    // Standard desktop fallback. GNOME/KDE and many lockers update logind's
    // LockedHint for the active graphical session.
    let id = std::env::var("XDG_SESSION_ID").ok()?;
    let output = Command::new("loginctl")
        .args(["show-session", &id, "--property=LockedHint", "--value"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}

unsafe extern "C" {
    fn clock_gettime(clock_id: i32, time: *mut Timespec) -> i32;
    fn signal(signal: i32, handler: unsafe extern "C" fn(i32)) -> usize;
    fn flock(fd: i32, operation: i32) -> i32;
}

fn clock_seconds(id: i32) -> f64 {
    let mut ts = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { clock_gettime(id, &mut ts) } == 0 {
        ts.tv_sec as f64 + ts.tv_nsec as f64 / 1_000_000_000.0
    } else {
        0.0
    }
}

struct SleepClock {
    boot: f64,
    monotonic: f64,
}

impl SleepClock {
    fn new() -> Self {
        Self {
            boot: clock_seconds(7),      // CLOCK_BOOTTIME: includes suspend
            monotonic: clock_seconds(1), // CLOCK_MONOTONIC: excludes suspend
        }
    }

    fn suspend_duration(&mut self) -> Option<Duration> {
        let boot = clock_seconds(7);
        let monotonic = clock_seconds(1);
        let slept = (boot - self.boot) - (monotonic - self.monotonic);
        self.boot = boot;
        self.monotonic = monotonic;
        (slept > 1.5).then(|| Duration::from_secs_f64(slept))
    }
}

unsafe extern "C" fn stop_signal(_: i32) {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() {
    unsafe {
        signal(2, stop_signal);  // SIGINT
        signal(15, stop_signal); // SIGTERM
    }
}

struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    fn acquire() -> std::io::Result<Option<Self>> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(runtime.join("clocked.lock"))?;
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
            Ok(Some(Self { _file: file }))
        } else {
            Ok(None)
        }
    }
}

fn installed_icon_root() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("icons/hicolor"))
}

fn tray_icon_theme_path() -> Option<String> {
    let installed = installed_icon_root()?.join("scalable/apps");
    if installed.join("clocked-symbolic.svg").exists() {
        return Some(installed.to_string_lossy().into_owned());
    }
    // Development/smoke-test fallback.
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("packaging/linux/clocked.png")
        .parent()?
        .to_string_lossy()
        .into_owned(),
    )
}

fn fmt_duration(secs: i64) -> String {
    let secs = secs.max(0);
    format!("{}:{:02}", secs / 3600, (secs % 3600) / 60)
}

fn fmt_hours(hours: f64) -> String {
    let total_minutes = (hours * 60.0).round() as i64;
    format!("{}:{:02}", total_minutes / 60, total_minutes % 60)
}

fn is_browser_app(app: &str) -> bool {
    let app = app.to_ascii_lowercase();
    app.contains("chrome")
        || app.contains("chromium")
        || app.contains("firefox")
        || app.contains("brave")
        || app.contains("opera")
        || app.contains("vivaldi")
        || app.ends_with("browser")
}
