//! Hidden top-level Win32 window: the single message loop that captures power,
//! session (lock/unlock), and shutdown events, hosts the tray icon, and drives
//! the heartbeat/sync timers.
//!
//! NOTE: a *top-level* window is required — message-only (`HWND_MESSAGE`)
//! windows never receive `WM_POWERBROADCAST`. The window is created but never
//! shown.

use chrono::{Local, Utc};
use rusqlite::Connection;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::UI::Shell::{ShellExecuteW, NOTIFYICONDATAW};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::config::Config;
use crate::events::{map_power, map_session, Action};

const CLASS_NAME: PCWSTR = w!("ClockedHiddenWindow");

// Custom + timer identifiers.
const WM_TRAY: u32 = WM_APP + 1;
const WM_SYNC_DONE: u32 = WM_APP + 2;
const TIMER_HEARTBEAT: usize = 1;
const TIMER_SYNC: usize = 2;

// Menu command ids.
const IDM_SYNC_NOW: usize = 101;
const IDM_AUTOSTART: usize = 102;
const IDM_OPEN_FOLDER: usize = 103;
const IDM_QUIT: usize = 104;

struct AppState {
    conn: Connection,
    config: Config,
    hwnd: HWND,
    nid: NOTIFYICONDATAW,
    taskbar_created: u32,
    syncing: bool,
}

impl AppState {
    fn clock_in(&mut self, reason: &str) {
        match crate::db::clock_in(&self.conn, reason, Utc::now()) {
            Ok(true) => {
                crate::logln!("clock in ({reason})");
                self.update_tooltip();
            }
            Ok(false) => {}
            Err(e) => crate::logln!("clock_in error: {e}"),
        }
    }

    fn clock_out(&mut self, reason: &str) {
        match crate::db::clock_out(&self.conn, reason, Utc::now()) {
            Ok(true) => {
                crate::logln!("clock out ({reason})");
                self.update_tooltip();
            }
            Ok(false) => {}
            Err(e) => crate::logln!("clock_out error: {e}"),
        }
    }

    fn status_line(&self) -> String {
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
        format!("Today: {}h {:02}m", secs / 3600, (secs % 3600) / 60)
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
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open_data_folder() {
    if let Some(dir) = crate::paths::data_dir() {
        let wide = to_wide(&dir.to_string_lossy());
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
}

/// Build and show the tray context menu. Uses `TPM_RETURNCMD` and holds no
/// borrow of `AppState` while `TrackPopupMenu` pumps its own modal loop.
unsafe fn show_menu(hwnd: HWND, ptr: *mut AppState) {
    let (status, today, autostart_on) = {
        let app = &*ptr;
        (app.status_line(), app.today_line(), crate::autostart::is_enabled())
    };

    let Ok(menu) = CreatePopupMenu() else {
        return;
    };
    let wstatus = to_wide(&status);
    let wtoday = to_wide(&today);
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wstatus.as_ptr()));
    let _ = AppendMenuW(menu, MF_GRAYED, 0, PCWSTR(wtoday.as_ptr()));
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let _ = AppendMenuW(menu, MF_STRING, IDM_SYNC_NOW, w!("Sync now"));
    let autostart_flags = if autostart_on {
        MF_STRING | MF_CHECKED
    } else {
        MF_STRING
    };
    let _ = AppendMenuW(menu, autostart_flags, IDM_AUTOSTART, w!("Start at login"));
    let _ = AppendMenuW(menu, MF_STRING, IDM_OPEN_FOLDER, w!("Open data folder"));
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
        IDM_SYNC_NOW => (*ptr).do_sync(),
        IDM_AUTOSTART => crate::autostart::toggle(),
        IDM_OPEN_FOLDER => open_data_folder(),
        IDM_QUIT => {
            let _ = DestroyWindow(hwnd);
        }
        _ => {}
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
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
                Action::ClockIn(r) => {
                    (*ptr).clock_in(r);
                    (*ptr).do_sync();
                }
                Action::ClockOut(r) => (*ptr).clock_out(r),
                Action::Ignore => {}
            }
            LRESULT(1)
        }
        WM_WTSSESSION_CHANGE => {
            match map_session(wparam.0 as u32) {
                Action::ClockIn(r) => (*ptr).clock_in(r),
                Action::ClockOut(r) => (*ptr).clock_out(r),
                Action::Ignore => {}
            }
            LRESULT(0)
        }
        WM_QUERYENDSESSION => {
            (*ptr).clock_out("shutdown");
            LRESULT(1)
        }
        WM_TIMER => {
            match wparam.0 {
                TIMER_HEARTBEAT => {
                    let app = &mut *ptr;
                    let _ = crate::db::heartbeat(&app.conn, Utc::now());
                    app.update_tooltip();
                }
                TIMER_SYNC => (*ptr).do_sync(),
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
        WM_DESTROY => {
            let app = &mut *ptr;
            app.clock_out("quit");
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
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize);

        // Startup sequence.
        {
            let app = &mut *ptr;
            let _ = crate::db::recover_crashed(&app.conn, Utc::now());
            let _ = crate::db::heartbeat(&app.conn, Utc::now());
            app.clock_in("start");

            let _ = RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE);
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            crate::tray::add(&app.nid);
            app.update_tooltip();

            let _ = SetTimer(Some(hwnd), TIMER_HEARTBEAT, 60_000, None);
            let _ = SetTimer(Some(hwnd), TIMER_SYNC, 3_600_000, None);
            app.do_sync();
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
