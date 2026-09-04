//! Linux desktop layer: GTK/AppIndicator tray UI, Wayland idle tracking,
//! Hyprland/logind lock detection, and suspend-aware session accounting.

mod gtk;
mod settings;

use std::fs::{File, OpenOptions};
use std::ops::{Deref, DerefMut};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;

use crate::desktop::{DesktopState, Effect};

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
    let startup_effects = app.on_startup();
    app.refresh_ui();
    apply_effects(app_ptr, startup_effects);

    gtk::timer(TICK_SECS, tick_callback, app_ptr.cast());
    gtk::main_loop();

    if !app.shut_down {
        app.shutdown("quit");
    }
    Ok(())
}

struct AppState {
    core: DesktopState,
    syncing: Arc<AtomicBool>,
    ui: Option<Ui>,
    ticks: u64,
    last_locked: Option<bool>,
    sleep_clock: SleepClock,
    shut_down: bool,
}

impl Deref for AppState {
    type Target = DesktopState;

    fn deref(&self) -> &Self::Target {
        &self.core
    }
}

impl DerefMut for AppState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.core
    }
}

impl AppState {
    fn new() -> Self {
        Self {
            core: DesktopState::new(),
            syncing: Arc::new(AtomicBool::new(false)),
            ui: None,
            ticks: 0,
            last_locked: session_locked(),
            sleep_clock: SleepClock::new(),
            shut_down: false,
        }
    }

    fn on_startup(&mut self) -> Vec<Effect> {
        // Do not begin a session when autostart happens into an already-locked
        // desktop. The first unlock transition will start it.
        let effects = self.core.startup(self.last_locked != Some(true));
        self.check_for_updates();
        // Starts the Wayland listener immediately instead of waiting one minute.
        let _ = crate::idle::idle_duration();
        effects
    }

    fn tick(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if STOP_REQUESTED.load(Ordering::SeqCst) {
            self.shutdown("shutdown");
            gtk::quit();
            return effects;
        }

        let locked_now = session_locked().or(self.last_locked);
        if let Some(slept) = self.sleep_clock.suspend_duration() {
            effects.extend(self.resume_after_suspend(slept, locked_now == Some(true)));
        }
        if let (Some(previous), Some(current)) = (self.last_locked, locked_now) {
            if current != previous {
                if current {
                    effects.extend(self.core.close_event("lock"));
                } else {
                    effects.extend(self.core.open_event("unlock"));
                }
            }
        }
        self.last_locked = locked_now;

        self.core.record_activity_tick();
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks.is_multiple_of(60 / TICK_SECS as u64) {
            effects.extend(self.core.heartbeat());
        }
        if self.ticks.is_multiple_of(3600 / TICK_SECS as u64) {
            effects.push(Effect::Sync);
        }
        if self.ticks.is_multiple_of(6 * 3600 / TICK_SECS as u64) {
            self.check_for_updates();
        }
        self.refresh_ui();
        effects
    }

    fn resume_after_suspend(&mut self, slept: Duration, still_locked: bool) -> Vec<Effect> {
        let at = Utc::now()
            - chrono::Duration::from_std(slept).unwrap_or_else(|_| chrono::Duration::zero());
        let mut effects = self.core.close_event_at("suspend", at);
        crate::logln!(
            "resume detected after {:.1}s suspended",
            slept.as_secs_f64()
        );
        if !still_locked {
            effects.extend(self.core.open_event("resume"));
        }
        effects
    }

    fn do_sync(&mut self) {
        self.start_sync(false);
    }

    fn start_sync(&mut self, manual: bool) {
        if !self.config.is_configured() {
            if manual {
                notify("Add your sync token in Settings first.");
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
            struct ClearOnDrop(Arc<AtomicBool>);
            impl Drop for ClearOnDrop {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let _clear = ClearOnDrop(Arc::clone(&syncing));
            let result = crate::sync::run_blocking(&config, Duration::from_secs(30));
            match result {
                Ok(n) => {
                    if n > 0 {
                        crate::logln!("synced {n} item(s)");
                    }
                    if manual {
                        notify(if n > 0 {
                            "Sync complete."
                        } else {
                            "Already up to date."
                        });
                    }
                }
                Err(e) => {
                    crate::logln!("sync error: {e}");
                    if manual {
                        notify(&format!("Sync failed: {e}"));
                    }
                }
            }
        });
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

    fn apply_settings(&mut self, update: settings::Update, autostart: bool) {
        if let Err(e) = update.config.save() {
            crate::logln!("settings save error: {e}");
            notify(&format!("Could not save settings: {e}"));
            return;
        }

        let mut autostart_error = None;
        if update.autostart != autostart {
            let result = if update.autostart {
                crate::autostart::enable()
            } else {
                crate::autostart::disable()
            };
            if let Err(e) = result {
                crate::logln!("autostart update error: {e}");
                autostart_error = Some(e);
            }
        }
        self.core.reload();
        if let Some(e) = autostart_error {
            notify(&format!(
                "Settings saved, but start at login could not be updated: {e}"
            ));
        } else {
            notify("Settings saved.");
        }
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
        if self.core.shutdown(reason) && self.config.is_configured() {
            match crate::sync::run_blocking(&self.config, SHUTDOWN_SYNC_TIMEOUT) {
                Ok(n) if n > 0 => crate::logln!("synced {n} item(s) before exit"),
                Ok(_) => {}
                Err(e) => crate::logln!("shutdown sync error: {e}"),
            }
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
        gtk::tooltip(ui.indicator, &ui.icon_name, &format!("{status} · {today}"));
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
        gtk::menu_item(menu, "Settings…", Some(on_settings), data);
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

fn apply_effects(app: *mut AppState, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Sync => unsafe { (&mut *app).do_sync() },
            Effect::Notify(body) => notify(&body),
            Effect::PromptAfterHours => {
                let (show, follow_up) = unsafe { (&mut *app).core.begin_after_hours_prompt() };
                apply_effects(app, follow_up);
                if show {
                    let working = gtk::ask(
                        "clocked",
                        "This is outside your configured working hours. Are you working?",
                        "Yes, start tracking",
                        "No",
                    );
                    let follow_up = unsafe { (&mut *app).core.answer_after_hours(working) };
                    apply_effects(app, follow_up);
                }
            }
            Effect::PromptReclaim { minutes } => {
                let reclaim = gtk::ask(
                    "clocked",
                    &format!(
                        "You were away for about {minutes} minutes. Count that time as worked?"
                    ),
                    "Yes, count it",
                    "No",
                );
                let follow_up = unsafe { (&mut *app).core.answer_reclaim(reclaim) };
                apply_effects(app, follow_up);
            }
            // GTK's modal API has no stable cross-desktop programmatic close
            // hook. The answer handler becomes a no-op after the shared state
            // has already auto-accepted the pending prompt.
            Effect::DismissAfterHoursPrompt => {}
        }
    }
    unsafe { (&*app).refresh_ui() };
}

unsafe extern "C" fn tick_callback(data: *mut std::ffi::c_void) -> i32 {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let app = data.cast::<AppState>();
        let effects = (&mut *app).tick();
        apply_effects(app, effects);
    }));
    (!STOP_REQUESTED.load(Ordering::SeqCst)) as i32
}

macro_rules! callback {
    ($name:ident, $body:expr) => {
        unsafe extern "C" fn $name(_: gtk::Widget, data: *mut std::ffi::c_void) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let app = data.cast::<AppState>();
                let effects = $body(&mut *app);
                apply_effects(app, effects);
            }));
        }
    };
}

callback!(on_pause, |app: &mut AppState| {
    let effects = app.core.toggle_pause();
    app.refresh_ui();
    effects
});
callback!(on_timesheet, |app: &mut AppState| {
    app.open_timesheet();
    Vec::new()
});
callback!(on_sync, |app: &mut AppState| {
    app.start_sync(true);
    Vec::new()
});
unsafe extern "C" fn on_settings(_: gtk::Widget, data: *mut std::ffi::c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let app = data.cast::<AppState>();
        // Do not hold a Rust borrow of AppState while gtk_dialog_run spins its
        // nested event loop: heartbeat timer callbacks remain live underneath.
        let current = (&*app).config.clone();
        let autostart = crate::autostart::is_enabled();
        if let Some(update) = settings::show(&current, autostart) {
            (&mut *app).apply_settings(update, autostart);
        }
    }));
}
callback!(on_autostart, |app: &mut AppState| {
    app.toggle_autostart();
    Vec::new()
});
callback!(on_quit, |app: &mut AppState| {
    app.shutdown("quit");
    gtk::quit();
    Vec::new()
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
        signal(2, stop_signal); // SIGINT
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
            .truncate(false)
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
