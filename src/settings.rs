//! Native settings window (pure Win32).
//!
//! A real top-level window with edit boxes, day checkboxes, and Save/Cancel
//! buttons. It runs on the app's existing message loop (no extra thread), and
//! because the app owns the window it closes itself instantly on Save/Cancel.
//! Saving writes `config.toml` and posts `saved_msg` back to the main window so
//! the running app reloads live.

use core::ffi::c_void;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, SYSTEMTIME, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontIndirectW, DeleteObject, GetStockObject, SetBkMode, HBRUSH, HDC, HFONT, HGDIOBJ,
    TRANSPARENT, WHITE_BRUSH,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, DTM_GETSYSTEMTIME, DTM_SETFORMATW, DTM_SETSYSTEMTIME, DTS_TIMEFORMAT,
    GDT_VALID, ICC_DATE_CLASSES, INITCOMMONCONTROLSEX,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::config::Config;

const CLASS: PCWSTR = w!("ClockedSettingsWindow");

// Control ids.
const ID_SAVE: i32 = 1; // matches IDOK so Enter-on-default behaves sanely
const ID_CANCEL: i32 = 2;
const ID_WORKER_URL: i32 = 1001;
const ID_TOKEN: i32 = 1002;
const ID_IDLE: i32 = 1003;
const ID_TARGET: i32 = 1004;
const ID_START: i32 = 1005;
const ID_END: i32 = 1006;
const ID_AUTOSTART: i32 = 1007;
const ID_KEEPALIVE: i32 = 1008;
const ID_DAY_BASE: i32 = 1010; // + weekday index

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// State handed to the window so it can notify the app after a save.
struct Ctx {
    main_hwnd: isize,
    saved_msg: u32,
    font: HFONT,
}

/// The system UI font (Segoe UI on Win10/11), falling back to the stock GUI
/// font. Freed when the window is destroyed.
unsafe fn ui_font() -> HFONT {
    let mut ncm = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    let ok = SystemParametersInfoW(
        SPI_GETNONCLIENTMETRICS,
        ncm.cbSize,
        Some(&mut ncm as *mut _ as *mut c_void),
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
    )
    .is_ok();
    if ok {
        let f = CreateFontIndirectW(&ncm.lfMessageFont);
        if !f.is_invalid() {
            return f;
        }
    }
    HFONT(GetStockObject(windows::Win32::Graphics::Gdi::DEFAULT_GUI_FONT).0)
}

/// Open the settings window (or focus it if already open).
pub fn open(main_hwnd_raw: isize, saved_msg: u32) {
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else {
            return;
        };
        let hinst = HINSTANCE(module.0);
        init_common_controls();
        ensure_class(hinst);

        if let Ok(existing) = FindWindowW(CLASS, PCWSTR::null()) {
            if !existing.is_invalid() {
                let _ = SetForegroundWindow(existing);
                return;
            }
        }

        let (w, h) = (468, 482);
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
        let ctx = Box::into_raw(Box::new(Ctx {
            main_hwnd: main_hwnd_raw,
            saved_msg,
            font: ui_font(),
        }));

        match CreateWindowExW(
            WS_EX_DLGMODALFRAME,
            CLASS,
            w!("clocked settings"),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            x,
            y,
            w,
            h,
            None,
            None,
            Some(hinst),
            Some(ctx as *const c_void),
        ) {
            Ok(hwnd) => {
                let _ = ShowWindow(hwnd, SW_SHOW);
                let _ = SetForegroundWindow(hwnd);
            }
            Err(e) => {
                crate::logln!("settings window error: {e}");
                drop(Box::from_raw(ctx));
            }
        }
    }
}

/// Register the date/time common-control class so `SysDateTimePick32` works.
fn init_common_controls() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_DATE_CLASSES,
        };
        let _ = InitCommonControlsEx(&icc);
    });
}

fn ensure_class(hinst: HINSTANCE) {
    use std::sync::Once;
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| unsafe {
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            lpszClassName: CLASS,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            // White window (COLOR_WINDOW + 1) for a clean, modern settings look.
            hbrBackground: HBRUSH(6usize as *mut c_void),
            ..Default::default()
        };
        RegisterClassW(&wc);
    });
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_CREATE => {
            let cs = &*(lp.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
            build_controls(hwnd);
            LRESULT(0)
        }
        WM_COMMAND => {
            match (wp.0 & 0xFFFF) as i32 {
                ID_SAVE => save_and_close(hwnd),
                ID_CANCEL => {
                    let _ = DestroyWindow(hwnd);
                }
                _ => return DefWindowProcW(hwnd, msg, wp, lp),
            }
            LRESULT(0)
        }
        // Paint static labels and checkbox text on the white window background.
        WM_CTLCOLORSTATIC => {
            let hdc = HDC(wp.0 as *mut c_void);
            let _ = SetBkMode(hdc, TRANSPARENT);
            LRESULT(GetStockObject(WHITE_BRUSH).0 as isize)
        }
        WM_CLOSE => {
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_NCDESTROY => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Ctx;
            if !ptr.is_null() {
                let ctx = Box::from_raw(ptr);
                let _ = DeleteObject(HGDIOBJ(ctx.font.0));
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// Create every child control, apply the UI font, and fill in current values.
unsafe fn build_controls(hwnd: HWND) {
    let Ok(module) = GetModuleHandleW(None) else {
        return;
    };
    let hinst = HINSTANCE(module.0);
    let ctx = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Ctx;
    let font = WPARAM(if ctx.is_null() {
        GetStockObject(windows::Win32::Graphics::Gdi::DEFAULT_GUI_FONT).0 as usize
    } else {
        (*ctx).font.0 as usize
    });

    let m = 24; // outer margin
    let fw = 404; // full field width
    let gap = 20;
    let half = (fw - gap) / 2;
    let right = m + half + gap;
    let eh = 26; // edit height
    let lh = 18; // label height

    label(hwnd, "Worker URL   ·   blank = local only, no sync", m, 20, fw, lh, hinst, font);
    edit(hwnd, ID_WORKER_URL, m, 42, fw, eh, WINDOW_STYLE(0), hinst, font);

    label(hwnd, "Bearer token", m, 82, fw, lh, hinst, font);
    edit(hwnd, ID_TOKEN, m, 104, fw, eh, WINDOW_STYLE(ES_PASSWORD as u32), hinst, font);

    label(hwnd, "Idle timeout   ·   minutes, 0 = off", m, 144, half, lh, hinst, font);
    label(hwnd, "Daily goal   ·   hours, 0 = hide", right, 144, half, lh, hinst, font);
    edit(hwnd, ID_IDLE, m, 166, half, eh, WINDOW_STYLE(ES_NUMBER as u32), hinst, font);
    edit(hwnd, ID_TARGET, right, 166, half, eh, WINDOW_STYLE(0), hinst, font);

    label(hwnd, "Work start", m, 206, half, lh, hinst, font);
    label(hwnd, "Work end", right, 206, half, lh, hinst, font);
    time_picker(hwnd, ID_START, m, 228, half, eh, hinst, font);
    time_picker(hwnd, ID_END, right, 228, half, eh, hinst, font);

    label(hwnd, "Work days   ·   none = after-hours prompt off", m, 268, fw, lh, hinst, font);
    let dw = (fw + 6) / 7; // even column width across the row
    for (i, d) in DAYS.iter().enumerate() {
        check(hwnd, ID_DAY_BASE + i as i32, d, m + i as i32 * dw, 292, dw - 6, hinst, font);
    }

    check(hwnd, ID_AUTOSTART, "Start clocked automatically at login", m, 326, fw, hinst, font);
    check(hwnd, ID_KEEPALIVE, "Keep clocked running (relaunch on unlock too)", m, 352, fw, hinst, font);

    button(hwnd, ID_CANCEL, "Cancel", m + fw - 104, 390, 104, hinst, font, false);
    button(hwnd, ID_SAVE, "Save", m + fw - 104 - 116, 390, 104, hinst, font, true);

    populate(hwnd);
}

unsafe fn mk(
    parent: HWND,
    class: PCWSTR,
    text: PCWSTR,
    style: WINDOW_STYLE,
    exstyle: WINDOW_EX_STYLE,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    id: i32,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    if let Ok(child) = CreateWindowExW(
        exstyle,
        class,
        text,
        WS_CHILD | WS_VISIBLE | style,
        x,
        y,
        w,
        h,
        Some(parent),
        Some(HMENU(id as usize as *mut c_void)),
        Some(hinst),
        None,
    ) {
        SendMessageW(child, WM_SETFONT, Some(font), Some(LPARAM(1)));
    }
}

unsafe fn label(p: HWND, text: &str, x: i32, y: i32, w: i32, h: i32, hinst: HINSTANCE, font: WPARAM) {
    let t = wide(text);
    mk(p, w!("STATIC"), PCWSTR(t.as_ptr()), WINDOW_STYLE(0), WINDOW_EX_STYLE(0), x, y, w, h, 0, hinst, font);
}

unsafe fn edit(
    p: HWND,
    id: i32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    extra: WINDOW_STYLE,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    mk(
        p,
        w!("EDIT"),
        PCWSTR::null(),
        WS_TABSTOP | WINDOW_STYLE(ES_AUTOHSCROLL as u32) | extra,
        WS_EX_CLIENTEDGE,
        x,
        y,
        w,
        h,
        id,
        hinst,
        font,
    );
}

/// A native time picker (HH:MM, 24-hour) — spinner + field, no free text.
unsafe fn time_picker(
    p: HWND,
    id: i32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    if let Ok(child) = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("SysDateTimePick32"),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(DTS_TIMEFORMAT as u32),
        x,
        y,
        w,
        h,
        Some(p),
        Some(HMENU(id as usize as *mut c_void)),
        Some(hinst),
        None,
    ) {
        SendMessageW(child, WM_SETFONT, Some(font), Some(LPARAM(1)));
        let fmt = wide("HH:mm");
        SendMessageW(child, DTM_SETFORMATW, None, Some(LPARAM(fmt.as_ptr() as isize)));
    }
}

unsafe fn check(p: HWND, id: i32, text: &str, x: i32, y: i32, w: i32, hinst: HINSTANCE, font: WPARAM) {
    let t = wide(text);
    mk(
        p,
        w!("BUTTON"),
        PCWSTR(t.as_ptr()),
        WS_TABSTOP | WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
        WINDOW_EX_STYLE(0),
        x,
        y,
        w,
        22,
        id,
        hinst,
        font,
    );
}

unsafe fn button(
    p: HWND,
    id: i32,
    text: &str,
    x: i32,
    y: i32,
    w: i32,
    hinst: HINSTANCE,
    font: WPARAM,
    default: bool,
) {
    let t = wide(text);
    let style = if default {
        WINDOW_STYLE(BS_DEFPUSHBUTTON as u32)
    } else {
        WINDOW_STYLE(0)
    };
    mk(
        p,
        w!("BUTTON"),
        PCWSTR(t.as_ptr()),
        WS_TABSTOP | style,
        WINDOW_EX_STYLE(0),
        x,
        y,
        w,
        30,
        id,
        hinst,
        font,
    );
}

unsafe fn set_text(parent: HWND, id: i32, text: &str) {
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        let t = wide(text);
        let _ = SetWindowTextW(h, PCWSTR(t.as_ptr()));
    }
}

unsafe fn get_text(parent: HWND, id: i32) -> String {
    let Ok(h) = GetDlgItem(Some(parent), id) else {
        return String::new();
    };
    let len = GetWindowTextLengthW(h);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(h, &mut buf);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn parse_hhmm(s: &str) -> Option<(u16, u16)> {
    let (h, m) = s.trim().split_once(':')?;
    Some((h.trim().parse().ok()?, m.trim().parse().ok()?))
}

/// Set a time picker from an `"HH:MM"` string, falling back to `default_hour:00`.
unsafe fn set_time(parent: HWND, id: i32, text: &str, default_hour: u16) {
    let (hh, mm) = parse_hhmm(text).unwrap_or((default_hour, 0));
    // The date part is ignored in time mode but must be a valid calendar date.
    let st = SYSTEMTIME {
        wYear: 2020,
        wMonth: 1,
        wDay: 1,
        wHour: hh,
        wMinute: mm,
        ..Default::default()
    };
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        SendMessageW(
            h,
            DTM_SETSYSTEMTIME,
            Some(WPARAM(GDT_VALID.0 as usize)),
            Some(LPARAM(&st as *const SYSTEMTIME as isize)),
        );
    }
}

/// Read a time picker back as `"HH:MM"`.
unsafe fn get_time(parent: HWND, id: i32) -> String {
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        let mut st = SYSTEMTIME::default();
        let r = SendMessageW(
            h,
            DTM_GETSYSTEMTIME,
            None,
            Some(LPARAM(&mut st as *mut SYSTEMTIME as isize)),
        );
        if r.0 == GDT_VALID.0 as isize {
            return format!("{:02}:{:02}", st.wHour, st.wMinute);
        }
    }
    String::new()
}

unsafe fn is_checked(parent: HWND, id: i32) -> bool {
    match GetDlgItem(Some(parent), id) {
        Ok(h) => SendMessageW(h, BM_GETCHECK, None, None).0 == 1,
        Err(_) => false,
    }
}

/// Fill controls from the current config.
unsafe fn populate(hwnd: HWND) {
    let c = Config::load();
    set_text(hwnd, ID_WORKER_URL, &c.worker_url);
    set_text(hwnd, ID_TOKEN, &c.bearer_token);
    // Shown in minutes; stored in seconds.
    set_text(hwnd, ID_IDLE, &(c.idle_timeout_secs / 60).to_string());
    set_text(hwnd, ID_TARGET, &fmt_hours(c.target_hours));
    set_time(hwnd, ID_START, &c.work_start, 9);
    set_time(hwnd, ID_END, &c.work_end, 17);
    for (i, d) in DAYS.iter().enumerate() {
        if c.work_days.iter().any(|w| w.eq_ignore_ascii_case(d)) {
            if let Ok(h) = GetDlgItem(Some(hwnd), ID_DAY_BASE + i as i32) {
                SendMessageW(h, BM_SETCHECK, Some(WPARAM(1)), None);
            }
        }
    }
    // "Start at login" reflects the actual HKCU\...\Run registry entry.
    if crate::autostart::is_enabled() {
        if let Ok(h) = GetDlgItem(Some(hwnd), ID_AUTOSTART) {
            SendMessageW(h, BM_SETCHECK, Some(WPARAM(1)), None);
        }
    }
    // "Keep running" reflects the scheduled task.
    if crate::keepalive::is_enabled() {
        if let Ok(h) = GetDlgItem(Some(hwnd), ID_KEEPALIVE) {
            SendMessageW(h, BM_SETCHECK, Some(WPARAM(1)), None);
        }
    }
}

fn fmt_hours(h: f64) -> String {
    if h.fract().abs() < 1e-9 {
        format!("{}", h as i64)
    } else {
        format!("{h}")
    }
}

/// Read controls, write config.toml, tell the app to reload, then close.
unsafe fn save_and_close(hwnd: HWND) {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Ctx;
    if ptr.is_null() {
        let _ = DestroyWindow(hwnd);
        return;
    }
    let ctx = &*ptr;

    let work_days = DAYS
        .iter()
        .enumerate()
        .filter(|(i, _)| is_checked(hwnd, ID_DAY_BASE + *i as i32))
        .map(|(_, d)| d.to_string())
        .collect();

    let cfg = Config {
        worker_url: get_text(hwnd, ID_WORKER_URL).trim().to_string(),
        bearer_token: get_text(hwnd, ID_TOKEN).trim().to_string(),
        // Entered in minutes; stored in seconds.
        idle_timeout_secs: get_text(hwnd, ID_IDLE).trim().parse::<u64>().unwrap_or(0) * 60,
        target_hours: get_text(hwnd, ID_TARGET).trim().parse().unwrap_or(0.0),
        work_start: get_time(hwnd, ID_START),
        work_end: get_time(hwnd, ID_END),
        work_days,
    };

    // Apply the "start at login" choice (registry, not config.toml).
    let want_autostart = is_checked(hwnd, ID_AUTOSTART);
    if want_autostart != crate::autostart::is_enabled() {
        let r = if want_autostart {
            crate::autostart::enable()
        } else {
            crate::autostart::disable()
        };
        if let Err(e) = r {
            crate::logln!("autostart update error: {e}");
        }
    }

    // Apply the "keep running" choice (scheduled task).
    let want_keepalive = is_checked(hwnd, ID_KEEPALIVE);
    if want_keepalive != crate::keepalive::is_enabled() {
        let r = if want_keepalive {
            crate::keepalive::enable()
        } else {
            crate::keepalive::disable()
        };
        if let Err(e) = r {
            crate::logln!("keepalive update error: {e}");
        }
    }

    match cfg.save() {
        Ok(()) => {
            crate::logln!("settings saved");
            let main = HWND(ctx.main_hwnd as *mut c_void);
            let _ = PostMessageW(Some(main), ctx.saved_msg, WPARAM(0), LPARAM(0));
        }
        Err(e) => crate::logln!("settings save error: {e}"),
    }
    let _ = DestroyWindow(hwnd);
}
