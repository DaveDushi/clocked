//! Hidden top-level Win32 window: the single message loop that captures power,
//! session (lock/unlock), and shutdown events, hosts the tray icon, and drives
//! the heartbeat/sync timers.
//!
//! NOTE: a *top-level* window is required — message-only (`HWND_MESSAGE`)
//! windows never receive `WM_POWERBROADCAST`. The window is created but never
//! shown.

use std::time::{Duration, Instant};

use chrono::Utc;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_ALREADY_EXISTS, FALSE, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT,
    TRUE, WPARAM,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::Threading::{CreateMutexW, GetCurrentThreadId};
use windows::Win32::UI::Shell::{ShellExecuteW, NOTIFYICONDATAW};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::desktop::format_duration;
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
    core: crate::desktop::DesktopState,
    hwnd: HWND,
    nid: NOTIFYICONDATAW,
    taskbar_created: u32,
    syncing: bool,
    after_hours_dialog_up: bool,
    update_status: crate::update::UpdateStatus,
    update_checked_at: Option<Instant>,
}

impl std::ops::Deref for AppState {
    type Target = crate::desktop::DesktopState;

    fn deref(&self) -> &Self::Target {
        &self.core
    }
}

impl std::ops::DerefMut for AppState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.core
    }
}

impl AppState {
    fn update_tooltip(&mut self) {
        let secs = crate::db::today_total_secs(&self.core.conn, Utc::now()).unwrap_or(0);
        let state = if self.core.is_paused() {
            "paused"
        } else if self.core.is_clocked_in() {
            "tracking"
        } else {
            "idle"
        };
        let tip = format!("clocked · {state} · {}", format_duration(secs));
        crate::tray::set_tip(&mut self.nid, &tip);
        crate::tray::modify(&self.nid);
    }

    fn do_sync(&mut self) {
        self.start_sync(false);
    }

    fn do_sync_manual(&mut self) {
        self.start_sync(true);
    }

    fn start_sync(&mut self, manual: bool) {
        if !self.core.config.is_configured() {
            if manual {
                crate::tray::notify(
                    &self.nid,
                    "clocked",
                    "Add your sync token in Settings first.",
                );
            }
            return;
        }
        if self.syncing {
            if manual {
                crate::tray::notify(&self.nid, "clocked", "Sync already in progress…");
            }
            return;
        }
        self.syncing = true;
        crate::sync::spawn(
            self.hwnd.0 as isize,
            WM_SYNC_DONE,
            self.core.config.clone(),
            manual,
        );
    }

    fn clock_out_blocking(&mut self, reason: &str) {
        if !self.core.shutdown(reason) || !self.core.config.is_configured() {
            return;
        }
        match crate::sync::run_blocking(&self.core.config, SHUTDOWN_SYNC_TIMEOUT) {
            Ok(n) if n > 0 => crate::logln!("synced {n} item(s) before exit"),
            Ok(_) => {}
            Err(e) => crate::logln!("shutdown sync error: {e}"),
        }
    }

    fn check_for_updates(&mut self, manual: bool) {
        if matches!(self.update_status, crate::update::UpdateStatus::Checking) {
            return;
        }
        self.update_status = crate::update::UpdateStatus::Checking;
        crate::update::spawn(self.hwnd.0 as isize, WM_UPDATE_CHECK_DONE, manual);
    }

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
}

fn prompt_after_hours(hwnd: HWND) -> bool {
    let text = to_wide("It's outside your working hours. Are you working?");
    let title = to_wide("clocked");
    unsafe {
        MessageBoxW(
            Some(hwnd),
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
        ) == IDYES
    }
}

fn prompt_reclaim(hwnd: HWND, minutes: i64) -> bool {
    let text = to_wide(&format!(
        "You were away for about {minutes} min with no keyboard or mouse activity.\n\n\
         Were you still working (e.g. in a meeting, on a call, or reading)? \
         Count that time as worked?"
    ));
    let title = to_wide("clocked");
    unsafe {
        MessageBoxW(
            Some(hwnd),
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
        ) == IDYES
    }
}

unsafe fn apply_effects(ptr: *mut AppState, effects: Vec<crate::desktop::Effect>) {
    for effect in effects {
        match effect {
            crate::desktop::Effect::Sync => (*ptr).do_sync(),
            crate::desktop::Effect::Notify(body) => {
                crate::tray::notify(&(*ptr).nid, "clocked", &body)
            }
            crate::desktop::Effect::PromptAfterHours => {
                let _ = PostMessageW(
                    Some((*ptr).hwnd),
                    WM_PROMPT_AFTER_HOURS,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
            crate::desktop::Effect::PromptReclaim { minutes } => {
                let _ = PostMessageW(
                    Some((*ptr).hwnd),
                    WM_PROMPT_IDLE_RECLAIM,
                    WPARAM(minutes as usize),
                    LPARAM(0),
                );
            }
            crate::desktop::Effect::DismissAfterHoursPrompt => {
                if (*ptr).after_hours_dialog_up {
                    dismiss_owned_message_box((*ptr).hwnd);
                }
            }
        }
    }
    (*ptr).update_tooltip();
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// End a `MessageBoxW` owned by `owner` (dialog class `#32770`) by simulating
/// Yes. Called from the nested pump while the after-hours box is up so work
/// start can clear it without a click. No-op when no matching dialog exists.
fn dismiss_owned_message_box(owner: HWND) {
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let owner = HWND(lparam.0 as *mut core::ffi::c_void);
        let dlg_owner = match GetWindow(hwnd, GW_OWNER) {
            Ok(h) => h,
            Err(_) => return TRUE,
        };
        if dlg_owner.0 != owner.0 {
            return TRUE;
        }
        let mut class = [0u16; 32];
        let n = GetClassNameW(hwnd, &mut class);
        if n <= 0 {
            return TRUE;
        }
        let class_name = String::from_utf16_lossy(&class[..n as usize]);
        if class_name != "#32770" {
            return TRUE;
        }
        // Prefer EndDialog (MessageBox is a dialog). IDYES matches a Yes click.
        let _ = EndDialog(hwnd, IDYES.0 as isize);
        FALSE
    }
    unsafe {
        let _ = EnumThreadWindows(
            GetCurrentThreadId(),
            Some(enum_proc),
            LPARAM(owner.0 as isize),
        );
    }
}

/// Format a duration in seconds as `2h 05m`, or `45m` under an hour, for the
/// tray breakdown lines.
fn truncate(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{t}…")
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
        let (breakdown, contexts, suggestions) = if app.config.track_projects {
            (
                crate::db::today_by_project(&app.conn, now).unwrap_or_default(),
                crate::db::today_by_context(&app.conn, now).unwrap_or_default(),
                crate::db::suggest_assignments(&app.conn, &app.rules, 3).unwrap_or_default(),
            )
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };
        (
            app.status_line(),
            app.today_line(),
            breakdown,
            contexts,
            suggestions,
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
            let line = to_wide(&format!(
                "  {:<18}  {}",
                truncate(project, 18),
                format_duration(*secs)
            ));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
        if breakdown.len() > BREAKDOWN_MAX_ROWS {
            let other: i64 = breakdown[BREAKDOWN_MAX_ROWS..].iter().map(|(_, s)| s).sum();
            let line = to_wide(&format!("  {:<18}  {}", "Other", format_duration(other)));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
    }
    if !contexts.is_empty() {
        // Indent sites under projects so the menu reads as one block.
        for (ctx, secs) in contexts.iter().take(CONTEXT_MAX_ROWS) {
            let line = to_wide(&format!(
                "    · {:<16} {}",
                truncate(ctx, 16),
                format_duration(*secs)
            ));
            let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(line.as_ptr()));
        }
    }
    // Unassigned apps with enough time — nudge to Settings → Projects.
    if !suggestions.is_empty() {
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_GRAYED, 0, w!("Unassigned (set in Settings)"));
        for (app, secs) in suggestions.iter() {
            let label = crate::rules::pretty_app_name(app);
            let line = to_wide(&format!(
                "  {:<18}  {}",
                truncate(&label, 18),
                format_duration(*secs)
            ));
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
        IDM_PAUSE => {
            let effects = (*ptr).core.toggle_pause();
            apply_effects(ptr, effects);
        }
        IDM_SETTINGS => crate::settings::open(hwnd.0 as isize, WM_SETTINGS_SAVED),
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
        IDM_SYNC_NOW => (*ptr).do_sync_manual(),
        IDM_DOWNLOAD_UPDATE => {
            let url = (*ptr).update_status.download_url().map(str::to_owned);
            if let Some(url) = url {
                open_url(&url);
            } else {
                (*ptr).check_for_updates(true);
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
            let effects = match map_power(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).core.open_event(r),
                Action::Close(r) => (*ptr).core.close_event(r),
                Action::Ignore => Vec::new(),
            };
            apply_effects(ptr, effects);
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            let effects = match map_session(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).core.open_event(r),
                Action::Close(r) => (*ptr).core.close_event(r),
                Action::Ignore => Vec::new(),
            };
            apply_effects(ptr, effects);
            LRESULT(0)
        }
        WM_PROMPT_AFTER_HOURS => {
            let (show, effects) = (*ptr).core.begin_after_hours_prompt();
            apply_effects(ptr, effects);
            if show {
                (*ptr).after_hours_dialog_up = true;
                let working = prompt_after_hours(hwnd);
                (*ptr).after_hours_dialog_up = false;
                let effects = (*ptr).core.answer_after_hours(working);
                apply_effects(ptr, effects);
            }
            LRESULT(0)
        }
        WM_PROMPT_IDLE_RECLAIM => {
            let reclaim = prompt_reclaim(hwnd, wparam.0 as i64);
            let effects = (*ptr).core.answer_reclaim(reclaim);
            apply_effects(ptr, effects);
            LRESULT(0)
        }
        WM_SETTINGS_SAVED => {
            (*ptr).core.reload();
            (*ptr).do_sync();
            (*ptr).update_tooltip();
            LRESULT(0)
        }
        WM_QUERYENDSESSION => {
            (*ptr).clock_out_blocking("shutdown");
            LRESULT(1)
        }
        WM_TIMER => {
            match wparam.0 {
                TIMER_HEARTBEAT => {
                    (*ptr).core.record_activity_tick();
                    let effects = (*ptr).core.heartbeat();
                    apply_effects(ptr, effects);
                }
                TIMER_ACTIVITY => {
                    // ~5s: auto-dismiss after-hours dialog soon after work start
                    // (heartbeat alone is 60s and can leave the box up too long).
                    let effects = (*ptr).core.maybe_enter_working_hours();
                    (*ptr).core.record_activity_tick();
                    apply_effects(ptr, effects);
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
            let raw = wparam.0 as *mut crate::sync::SyncResult;
            if !raw.is_null() {
                let result = *Box::from_raw(raw);
                if result.manual {
                    crate::tray::notify(&app.nid, "clocked", &result.notify_body());
                }
            }
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
        let taskbar_created = RegisterWindowMessageW(w!("TaskbarCreated"));
        let nid = crate::tray::build(hwnd, WM_TRAY);
        let ptr = Box::into_raw(Box::new(AppState {
            core: crate::desktop::DesktopState::new(),
            hwnd,
            nid,
            taskbar_created,
            syncing: false,
            after_hours_dialog_up: false,
            update_status: crate::update::UpdateStatus::Unknown,
            update_checked_at: None,
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);

        // Startup sequence.
        let effects = (*ptr).core.startup(true);
        apply_effects(ptr, effects);

        let _ = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        crate::tray::add(&(*ptr).nid);

        let _ = SetTimer(Some(hwnd), TIMER_HEARTBEAT, 60_000, None);
        // 5s focus poll — segment tracker attributes exact elapsed times.
        let _ = SetTimer(Some(hwnd), TIMER_ACTIVITY, 5_000, None);
        let _ = SetTimer(Some(hwnd), TIMER_SYNC, 3_600_000, None);
        let _ = SetTimer(Some(hwnd), TIMER_UPDATE_CHECK, 21_600_000, None);
        (*ptr).check_for_updates(false);

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
