//! Hidden top-level Win32 window: the single message loop that captures power,
//! session (lock/unlock), and shutdown events, hosts the tray icon, and drives
//! the heartbeat/sync timers.
//!
//! NOTE: a *top-level* window is required — message-only (`HWND_MESSAGE`)
//! windows never receive `WM_POWERBROADCAST`. The window is created but never
//! shown.

use std::time::{Duration, Instant};

use chrono::{Local, Utc};
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

use crate::config::Config;
use crate::events::{map_power, map_session, Action};

const CLASS_NAME: PCWSTR = w!("ClockedHiddenWindow");

// Custom + timer identifiers.
const WM_TRAY: u32 = WM_APP + 1;
const WM_SYNC_DONE: u32 = WM_APP + 2;
const WM_PROMPT_AFTER_HOURS: u32 = WM_APP + 3;
const WM_SETTINGS_SAVED: u32 = WM_APP + 4;
const WM_UPDATE_CHECK_DONE: u32 = WM_APP + 5;
const TIMER_HEARTBEAT: usize = 1;
const TIMER_SYNC: usize = 2;
const TIMER_UPDATE_CHECK: usize = 3;

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

// Warn this many seconds before an idle auto-clock-out.
const IDLE_WARN_LEAD_SECS: u64 = 120;

struct AppState {
    conn: Connection,
    config: Config,
    hwnd: HWND,
    nid: NOTIFYICONDATAW,
    taskbar_created: u32,
    syncing: bool,
    /// True while we are auto-clocked-out for inactivity. Only this flag lets a
    /// bare keypress resume tracking; lock/suspend clock-outs still require their
    /// matching unlock/resume event.
    idle_out: bool,
    /// True while the user has manually paused tracking. Blocks every automatic
    /// clock-in until they resume, so no event can reopen a session behind their
    /// back.
    paused: bool,
    /// Whether the "clocking out soon" balloon has already fired for the current
    /// idle stretch (so we warn once, not every heartbeat).
    idle_warned: bool,
    /// Remembered answer to the after-hours "are you working?" prompt for the
    /// current after-hours stretch: `Some(true/false)` once answered, cleared
    /// back to `None` on the next event inside working hours so each evening
    /// asks fresh.
    after_hours_answer: Option<bool>,
    /// Clock-in reason for the after-hours prompt, and the in-flight guard for
    /// it: set when the modal is queued and left set until it's answered, so a
    /// resume+unlock pair (or any event during the modal) can't stack a second
    /// prompt.
    pending_open: Option<&'static str>,
    update_status: crate::update::UpdateStatus,
    /// When the last update check completed. Lets a stale "up to date" revert to
    /// a checkable "check for updates" after `UP_TO_DATE_TTL`.
    update_checked_at: Option<Instant>,
}

impl AppState {
    fn clock_in(&mut self, reason: &str) {
        // While manually paused, ignore every automatic clock-in. The manual
        // resume path clears `paused` before calling this.
        if self.paused {
            return;
        }
        // Any real clock-in clears the idle latch: we are present again.
        self.idle_out = false;
        match crate::db::clock_in(&self.conn, reason, Utc::now()) {
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

    /// A "computer opened" moment (wake / unlock / app start). Inside working
    /// hours we just clock in; outside them we ask once whether the user is
    /// actually working before tracking anything.
    fn open_event(&mut self, reason: &'static str) {
        if self.paused {
            return; // manual pause wins; nothing reopens until they resume
        }
        match self.config.within_working_hours(Local::now()) {
            None | Some(true) => {
                // Feature off, or inside hours: fresh slate for tonight.
                self.after_hours_answer = None;
                self.clock_in(reason);
                self.do_sync();
            }
            Some(false) => match self.after_hours_answer {
                Some(true) => {
                    self.clock_in(reason);
                    self.do_sync();
                }
                Some(false) => {} // already told us they're not working
                None => {
                    // Defer the modal out of the power/session callback. A wake
                    // fires both a resume and an unlock, and the second often
                    // lands while the first modal is already up (the modal pumps
                    // messages). `pending_open` stays set for the whole prompt
                    // lifecycle, so only the first event queues a modal.
                    if self.pending_open.is_none() {
                        self.pending_open = Some(reason);
                        let _ = unsafe {
                            PostMessageW(Some(self.hwnd), WM_PROMPT_AFTER_HOURS, WPARAM(0), LPARAM(0))
                        };
                    }
                }
            },
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

    /// Answer a deferred after-hours prompt: track if working, stay out if not,
    /// and remember the choice for the rest of this after-hours stretch.
    fn resolve_after_hours(&mut self) {
        let Some(reason) = self.pending_open else {
            return;
        };
        let working = self.prompt_are_you_working();
        // Clear the in-flight marker only now, after the modal is answered, so
        // any wake event that arrived while it was up couldn't stack a second
        // prompt (`open_event` skips posting while `pending_open` is set).
        self.pending_open = None;
        self.after_hours_answer = Some(working);
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
            crate::logln!("resumed");
            self.clock_in("manual");
            self.do_sync();
        }
    }

    /// Stop the clock after a stretch of inactivity, resume it on the first
    /// input afterwards. Called from the heartbeat timer. Backdates the idle
    /// clock-out to the last input so the dead time isn't counted.
    fn check_idle(&mut self) {
        if self.paused {
            return; // manual pause overrides idle handling entirely
        }
        let timeout = self.config.idle_timeout_secs;
        if timeout == 0 {
            return; // idle detection disabled
        }
        let idle_secs = crate::idle::idle_duration().as_secs();

        if idle_secs >= timeout {
            let clocked_in = matches!(crate::db::open_session_start(&self.conn), Ok(Some(_)));
            if clocked_in {
                // Backdate to the last input so the idle stretch isn't counted.
                let ago = chrono::Duration::seconds(idle_secs as i64);
                let last_input = Utc::now() - ago;
                match crate::db::clock_out(&self.conn, "idle", last_input) {
                    Ok(crate::db::ClockOut::Closed) => {
                        crate::logln!("clock out (idle {idle_secs}s)");
                        self.idle_out = true;
                        self.idle_warned = false;
                        self.update_tooltip();
                        self.do_sync();
                    }
                    Ok(crate::db::ClockOut::DroppedEmpty) => {
                        // Whole span was idle (backdated before its start); drop
                        // it but still latch idle so activity reopens tracking.
                        crate::logln!("ignored empty session (idle {idle_secs}s)");
                        self.idle_out = true;
                        self.idle_warned = false;
                        self.update_tooltip();
                    }
                    Ok(crate::db::ClockOut::None) => {}
                    Err(e) => crate::logln!("idle clock_out error: {e}"),
                }
            }
        } else if self.idle_out {
            // Input returned after an idle auto-clock-out: resume tracking.
            self.idle_warned = false;
            self.clock_in("active");
            self.do_sync();
        } else {
            // Still counting time: warn once as we approach the idle cutoff.
            let warn_at = timeout.saturating_sub(IDLE_WARN_LEAD_SECS);
            if idle_secs < warn_at {
                self.idle_warned = false;
            } else if warn_at > 0 && !self.idle_warned {
                let clocked_in = matches!(crate::db::open_session_start(&self.conn), Ok(Some(_)));
                if clocked_in {
                    let mins = (timeout - idle_secs + 59) / 60;
                    crate::tray::notify(
                        &self.nid,
                        "clocked",
                        &format!("No activity — clocking out in ~{mins} min unless you return."),
                    );
                    self.idle_warned = true;
                }
            }
        }
    }

    fn clock_out(&mut self, reason: &str) {
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

    fn status_line(&self) -> String {
        if self.paused {
            return "Paused".to_string();
        }
        match crate::db::open_session_start(&self.conn) {
            Ok(Some(start)) => format!(
                "Clocked in since {}",
                start.with_timezone(&Local).format("%H:%M")
            ),
            _ => "Clocked out".to_string(),
        }
    }

    fn today_line(&self) -> String {
        let secs = crate::db::today_total_secs(&self.conn, Utc::now()).unwrap_or(0);
        let base = format!("Today: {}h {:02}m", secs / 3600, (secs % 3600) / 60);
        let target = self.config.target_hours;
        if target > 0.0 {
            let mark = if secs as f64 >= target * 3600.0 {
                " ✓"
            } else {
                ""
            };
            format!("{base} / {}{mark}", fmt_hours(target))
        } else {
            base
        }
    }

    fn update_tooltip(&mut self) {
        let tip = format!("clocked · {} · {}", self.status_line(), self.today_line());
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
    let (status, today, worker_url, clocked_in, update_label, update_enabled) = {
        let app = &*ptr;
        let update = app.effective_update_status();
        (
            app.status_line(),
            app.today_line(),
            app.config.effective_worker_url().to_string(),
            app.is_clocked_in(),
            update.menu_label(),
            update.menu_enabled(),
        )
    };

    let Ok(menu) = CreatePopupMenu() else {
        return;
    };
    let wstatus = to_wide(&status);
    let wtoday = to_wide(&today);
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wstatus.as_ptr()));
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wtoday.as_ptr()));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let pause_label = if clocked_in {
        w!("Pause tracking")
    } else {
        w!("Resume tracking")
    };
    let _ = AppendMenuW(menu, MF_STRING, IDM_PAUSE, pause_label);
    // Opens the Worker dashboard (defaults to the current month). Grayed when
    // syncing isn't configured, since there's no dashboard to open.
    let timesheet_flags = if worker_url.trim().is_empty() {
        MF_GRAYED
    } else {
        MF_STRING
    };
    let _ = AppendMenuW(
        menu,
        timesheet_flags,
        IDM_OPEN_TIMESHEET,
        w!("Open timesheet"),
    );
    let _ = AppendMenuW(menu, MF_STRING, IDM_SYNC_NOW, w!("Sync now"));
    let _ = AppendMenuW(menu, MF_STRING, IDM_SETTINGS, w!("Settings…"));
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
                Action::ClockOut(r) => (*ptr).clock_out(r),
                Action::Ignore => {}
            }
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            match map_session(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).open_event(r),
                Action::ClockOut(r) => (*ptr).clock_out(r),
                Action::Ignore => {}
            }
            LRESULT(0)
        }
        WM_PROMPT_AFTER_HOURS => {
            (*ptr).resolve_after_hours();
            LRESULT(0)
        }
        WM_SETTINGS_SAVED => {
            let app = &mut *ptr;
            app.config = Config::load();
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
                    let _ = crate::db::heartbeat(&app.conn, Utc::now());
                    app.check_idle();
                    app.update_tooltip();
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
            hwnd,
            nid,
            taskbar_created,
            syncing: false,
            idle_out: false,
            paused: false,
            idle_warned: false,
            after_hours_answer: None,
            pending_open: None,
            update_status: crate::update::UpdateStatus::Unknown,
            update_checked_at: None,
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);

        // Startup sequence.
        {
            let app = &mut *ptr;
            let _ = crate::db::recover_crashed(&app.conn, Utc::now());
            let _ = crate::db::heartbeat(&app.conn, Utc::now());
            app.open_event("start");

            let _ = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            crate::tray::add(&app.nid);
            app.update_tooltip();

            let _ = SetTimer(Some(hwnd), TIMER_HEARTBEAT, 60_000, None);
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
