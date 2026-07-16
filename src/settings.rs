//! Native settings window (pure Win32).
//!
//! A real top-level window with edit boxes, day checkboxes, and Save/Cancel
//! buttons. It runs on the app's existing message loop (no extra thread), and
//! because the app owns the window it closes itself instantly on Save/Cancel.
//! Saving writes `config.toml` and posts `saved_msg` back to the main window so
//! the running app reloads live.

use core::ffi::c_void;
use std::cell::{Cell, RefCell};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, SYSTEMTIME, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateFontIndirectW, DeleteObject, GetStockObject, SetBkMode, HBRUSH, HDC, HFONT, HGDIOBJ,
    TRANSPARENT, WHITE_BRUSH,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, DTM_GETSYSTEMTIME, DTM_SETFORMATW, DTM_SETSYSTEMTIME, DTS_TIMEFORMAT,
    GDT_VALID, ICC_DATE_CLASSES, ICC_TAB_CLASSES, INITCOMMONCONTROLSEX, NMHDR, TCIF_TEXT, TCITEMW,
    TCM_GETCURSEL, TCM_INSERTITEMW, TCN_SELCHANGE,
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
const ID_ADVANCED: i32 = 1009;
const ID_DAY_BASE: i32 = 1010; // + weekday index
const ID_WORKER_URL_LABEL: i32 = 1020;
// General-tab label ids (so the whole page can be hidden when switching tabs).
const ID_LBL_TOKEN: i32 = 1021;
const ID_LBL_IDLE: i32 = 1022;
const ID_LBL_TARGET: i32 = 1023;
const ID_LBL_START: i32 = 1024;
const ID_LBL_END: i32 = 1025;
const ID_LBL_DAYS: i32 = 1026;
const ID_TOKEN_HINT: i32 = 1027;
const ID_STORE_TITLES: i32 = 1028;
// Tab control + Projects-tab controls.
const ID_TABS: i32 = 900;
const ID_RULES_HELP: i32 = 1200;
const ID_LBL_DEFAULT: i32 = 1202;
const ID_DEFAULT_BUCKET: i32 = 1203;
const ID_COL_APP: i32 = 1204;
const ID_COL_PROJ: i32 = 1205;
const ID_PRIVACY_HELP: i32 = 1206;
const ID_MATCH_HELP: i32 = 1207;
const ID_MATCH_COL_IF: i32 = 1208;
const ID_MATCH_COL_PROJ: i32 = 1209;
// One row per used app: a name label + a project edit box. Ids are base + row.
const ID_ROW_LABEL_BASE: i32 = 1300;
const ID_ROW_PROJ_BASE: i32 = 1340;
// Window text / domain match rules (if contains → project).
const ID_MATCH_CONTAINS_BASE: i32 = 1400;
const ID_MATCH_PROJ_BASE: i32 = 1410;
// Most-used apps listed for assignment; the long tail stays on app-name fallback.
const MAX_APP_ROWS: usize = 10;
const MAX_MATCH_ROWS: usize = 3;

// Every General-tab control except the Advanced-gated worker URL pair, which is
// shown/hidden by the Advanced toggle instead.
const GENERAL_CORE_IDS: &[i32] = &[
    ID_LBL_TOKEN, ID_TOKEN, ID_TOKEN_HINT, ID_LBL_IDLE, ID_LBL_TARGET, ID_IDLE, ID_TARGET,
    ID_LBL_START, ID_LBL_END, ID_START, ID_END, ID_LBL_DAYS, ID_DAY_BASE, ID_DAY_BASE + 1,
    ID_DAY_BASE + 2, ID_DAY_BASE + 3, ID_DAY_BASE + 4, ID_DAY_BASE + 5, ID_DAY_BASE + 6,
    ID_AUTOSTART, ID_KEEPALIVE, ID_STORE_TITLES, ID_ADVANCED,
];
// Fixed (non-row) Projects-tab controls; the per-app rows are toggled separately.
const PROJECT_IDS: &[i32] = &[
    ID_RULES_HELP,
    ID_PRIVACY_HELP,
    ID_COL_APP,
    ID_COL_PROJ,
    ID_LBL_DEFAULT,
    ID_DEFAULT_BUCKET,
    ID_MATCH_HELP,
    ID_MATCH_COL_IF,
    ID_MATCH_COL_PROJ,
];

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// State handed to the window so it can notify the app after a save.
struct Ctx {
    main_hwnd: isize,
    saved_msg: u32,
    font: HFONT,
    /// Whether the Advanced (Worker URL) row is currently revealed. Tracked so a
    /// tab switch back to General can restore it correctly.
    advanced: Cell<bool>,
    /// App executables shown in the Projects list, in row order. Captured when
    /// the window is built so Save can pair each project box back to its app.
    apps: RefCell<Vec<String>>,
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

        let (w, h) = (468, 680);
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
        let ctx = Box::into_raw(Box::new(Ctx {
            main_hwnd: main_hwnd_raw,
            saved_msg,
            font: ui_font(),
            advanced: Cell::new(false),
            apps: RefCell::new(Vec::new()),
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
            dwICC: ICC_DATE_CLASSES | ICC_TAB_CLASSES,
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
                ID_ADVANCED => toggle_advanced(hwnd),
                _ => return DefWindowProcW(hwnd, msg, wp, lp),
            }
            LRESULT(0)
        }
        WM_NOTIFY => {
            let hdr = &*(lp.0 as *const NMHDR);
            if hdr.idFrom == ID_TABS as usize && hdr.code == TCN_SELCHANGE {
                apply_visibility(hwnd);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
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

    // Tab strip across the top; each page's controls are siblings shown/hidden
    // together (they stay children of the window so their labels paint on the
    // white background). Content starts just below the strip.
    tabs(hwnd, m - 12, 10, fw + 24, 28, hinst, font);

    // --- General page ---
    // Token is password-masked; leave blank to keep the saved token (never shown).
    label_id(hwnd, ID_LBL_TOKEN, "Sync token", m, 44, fw, lh, hinst, font);
    edit(
        hwnd,
        ID_TOKEN,
        m,
        66,
        fw,
        eh,
        WINDOW_STYLE(ES_PASSWORD as u32),
        hinst,
        font,
    );
    label_id(
        hwnd,
        ID_TOKEN_HINT,
        "Leave blank to keep. Same token for sync + Chrome extension bridge.",
        m,
        96,
        fw,
        lh,
        hinst,
        font,
    );

    label_id(hwnd, ID_LBL_IDLE, "Idle timeout   ?   minutes, 0 = off", m, 122, half, lh, hinst, font);
    label_id(hwnd, ID_LBL_TARGET, "Daily goal   ?   hours, 0 = hide", right, 122, half, lh, hinst, font);
    edit(hwnd, ID_IDLE, m, 144, half, eh, WINDOW_STYLE(ES_NUMBER as u32), hinst, font);
    edit(hwnd, ID_TARGET, right, 144, half, eh, WINDOW_STYLE(0), hinst, font);

    label_id(hwnd, ID_LBL_START, "Work start", m, 184, half, lh, hinst, font);
    label_id(hwnd, ID_LBL_END, "Work end", right, 184, half, lh, hinst, font);
    time_picker(hwnd, ID_START, m, 206, half, eh, hinst, font);
    time_picker(hwnd, ID_END, right, 206, half, eh, hinst, font);

    label_id(hwnd, ID_LBL_DAYS, "Work days   ?   none = after-hours prompt off", m, 246, fw, lh, hinst, font);
    let dw = (fw + 6) / 7; // even column width across the row
    for (i, d) in DAYS.iter().enumerate() {
        check(hwnd, ID_DAY_BASE + i as i32, d, m + i as i32 * dw, 270, dw - 6, hinst, font);
    }

    check(hwnd, ID_AUTOSTART, "Start clocked automatically at login", m, 304, fw, hinst, font);
    check(hwnd, ID_KEEPALIVE, "Keep clocked running (relaunch on unlock too)", m, 328, fw, hinst, font);
    check(
        hwnd,
        ID_STORE_TITLES,
        "Also store full window titles (opt-in; sanitized; local only)",
        m,
        352,
        fw,
        hinst,
        font,
    );
    // Hint under privacy: extension uses the same token (no extra control needed).

    button(hwnd, ID_ADVANCED, "Advanced settings...", m, 384, 154, hinst, font, false);
    label_id(
        hwnd,
        ID_WORKER_URL_LABEL,
        "Worker URL   ?   defaults to clocked.daviddusi.com",
        m,
        420,
        fw,
        lh,
        hinst,
        font,
    );
    edit(hwnd, ID_WORKER_URL, m, 442, fw, eh, WINDOW_STYLE(0), hinst, font);

    // --- Projects page: one row per used app, assign it to a project bucket ---
    label_id(
        hwnd,
        ID_RULES_HELP,
        "Apps you've used — type a project next to each (or Non-work to ignore).",
        m,
        44,
        fw,
        lh,
        hinst,
        font,
    );
    label_id(
        hwnd,
        ID_PRIVACY_HELP,
        "App + safe site/doc context while clocked in. Full titles off by default.",
        m,
        64,
        fw,
        lh,
        hinst,
        font,
    );
    let proj_x = m + 200;
    label_id(hwnd, ID_COL_APP, "App", m, 88, 190, lh, hinst, font);
    label_id(hwnd, ID_COL_PROJ, "Project", proj_x, 88, fw - 200, lh, hinst, font);
    build_app_rows(hwnd, m, 110, proj_x, fw, hinst, font);

    // Match rules: if window text or domain contains X → project (zero daily effort).
    let match_top = 110 + MAX_APP_ROWS as i32 * 30 + 8;
    label_id(
        hwnd,
        ID_MATCH_HELP,
        "If site/doc/window contains… (e.g. acme.com or Invoice) → project",
        m,
        match_top,
        fw,
        lh,
        hinst,
        font,
    );
    label_id(hwnd, ID_MATCH_COL_IF, "Contains", m, match_top + 22, half, lh, hinst, font);
    label_id(
        hwnd,
        ID_MATCH_COL_PROJ,
        "Project",
        m + half + gap,
        match_top + 22,
        half,
        lh,
        hinst,
        font,
    );
    for i in 0..MAX_MATCH_ROWS as i32 {
        let y = match_top + 44 + i * 30;
        edit(
            hwnd,
            ID_MATCH_CONTAINS_BASE + i,
            m,
            y,
            half,
            eh,
            WINDOW_STYLE(0),
            hinst,
            font,
        );
        edit(
            hwnd,
            ID_MATCH_PROJ_BASE + i,
            m + half + gap,
            y,
            half,
            eh,
            WINDOW_STYLE(0),
            hinst,
            font,
        );
    }

    let default_y = match_top + 44 + MAX_MATCH_ROWS as i32 * 30 + 10;
    label_id(
        hwnd,
        ID_LBL_DEFAULT,
        "Everything else   ?   leave blank to group by app name",
        m,
        default_y,
        fw,
        lh,
        hinst,
        font,
    );
    edit(
        hwnd,
        ID_DEFAULT_BUCKET,
        m,
        default_y + 22,
        half,
        eh,
        WINDOW_STYLE(0),
        hinst,
        font,
    );

    // --- Shared footer buttons ---
    button(hwnd, ID_CANCEL, "Cancel", m + fw - 104, 600, 104, hinst, font, false);
    button(hwnd, ID_SAVE, "Save", m + fw - 104 - 116, 600, 104, hinst, font, true);

    populate(hwnd);
    apply_visibility(hwnd);
}

/// Create the top tab strip with the two pages.
unsafe fn tabs(parent: HWND, x: i32, y: i32, w: i32, h: i32, hinst: HINSTANCE, font: WPARAM) {
    let Ok(tabs) = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("SysTabControl32"),
        PCWSTR::null(),
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        x,
        y,
        w,
        h,
        Some(parent),
        Some(HMENU(ID_TABS as usize as *mut c_void)),
        Some(hinst),
        None,
    ) else {
        return;
    };
    SendMessageW(tabs, WM_SETFONT, Some(font), Some(LPARAM(1)));
    for (i, title) in ["General", "Projects"].iter().enumerate() {
        let mut t = wide(title);
        let item = TCITEMW {
            mask: TCIF_TEXT,
            pszText: PWSTR(t.as_mut_ptr()),
            ..Default::default()
        };
        SendMessageW(
            tabs,
            TCM_INSERTITEMW,
            Some(WPARAM(i)),
            Some(LPARAM(&item as *const TCITEMW as isize)),
        );
    }
}

/// Build the per-app assignment rows: for each used app, a name label and a
/// project edit box pre-filled with its current assignment. The apps shown are
/// stashed on the Ctx (in row order) so Save can pair each box back to its app.
unsafe fn build_app_rows(
    parent: HWND,
    x: i32,
    top: i32,
    proj_x: i32,
    fw: i32,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    let rules = crate::rules::Rules::load();
    let apps = apps_to_show(&rules);

    for (i, app) in apps.iter().enumerate() {
        let y = top + i as i32 * 30;
        label_id(
            parent,
            ID_ROW_LABEL_BASE + i as i32,
            &crate::rules::pretty_app_name(app),
            x,
            y + 4, // nudge to vertically center against the edit box
            190,
            18,
            hinst,
            font,
        );
        edit(
            parent,
            ID_ROW_PROJ_BASE + i as i32,
            proj_x,
            y,
            fw - 200,
            26,
            WINDOW_STYLE(0),
            hinst,
            font,
        );
        let prefill = if rules.is_ignored(app) {
            "Non-work"
        } else {
            rules.assigned(app).unwrap_or("")
        };
        set_text(parent, ID_ROW_PROJ_BASE + i as i32, prefill);
    }

    if let Some(ctx) = ctx_ref(parent) {
        *ctx.apps.borrow_mut() = apps;
    }
}

/// The apps to list for assignment: the most-used apps first, then any already
/// assigned but idle so their bucket is still visible, capped so the panel never
/// scrolls. Assignments for apps that fall past the cap are preserved on Save
/// (it starts from the stored rules and only edits the shown rows).
fn apps_to_show(rules: &crate::rules::Rules) -> Vec<String> {
    let mut apps: Vec<String> = Vec::new();
    if let Ok(conn) = crate::db::open() {
        if let Ok(seen) = crate::db::apps_seen(&conn, 60) {
            apps = seen;
        }
    }
    for app in rules.assignments.keys() {
        if !apps.iter().any(|a| a.eq_ignore_ascii_case(app)) {
            apps.push(app.clone());
        }
    }
    apps.truncate(MAX_APP_ROWS);
    apps
}

unsafe fn ctx_ref<'a>(hwnd: HWND) -> Option<&'a Ctx> {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Ctx;
    if ptr.is_null() {
        None
    } else {
        Some(&*ptr)
    }
}

/// The current tab index (0 = General, 1 = Projects; 0 if the control is absent).
unsafe fn current_tab(hwnd: HWND) -> i32 {
    match GetDlgItem(Some(hwnd), ID_TABS) {
        Ok(tabs) => SendMessageW(tabs, TCM_GETCURSEL, None, None).0 as i32,
        Err(_) => 0,
    }
}

/// Show the controls for the active tab and hide the rest. The Advanced-gated
/// worker URL row is only shown on General *and* when Advanced is revealed.
unsafe fn apply_visibility(hwnd: HWND) {
    let general = current_tab(hwnd) == 0;
    let advanced = match GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Ctx {
        p if !p.is_null() => (*p).advanced.get(),
        _ => false,
    };
    for &id in GENERAL_CORE_IDS {
        show_ctrl(hwnd, id, general);
    }
    for &id in PROJECT_IDS {
        show_ctrl(hwnd, id, !general);
    }
    // Per-app rows (only the ones that exist respond; missing ids are skipped).
    for i in 0..MAX_APP_ROWS as i32 {
        show_ctrl(hwnd, ID_ROW_LABEL_BASE + i, !general);
        show_ctrl(hwnd, ID_ROW_PROJ_BASE + i, !general);
    }
    for i in 0..MAX_MATCH_ROWS as i32 {
        show_ctrl(hwnd, ID_MATCH_CONTAINS_BASE + i, !general);
        show_ctrl(hwnd, ID_MATCH_PROJ_BASE + i, !general);
    }
    show_ctrl(hwnd, ID_WORKER_URL_LABEL, general && advanced);
    show_ctrl(hwnd, ID_WORKER_URL, general && advanced);
    if let Ok(h) = GetDlgItem(Some(hwnd), ID_ADVANCED) {
        let text = if advanced {
            wide("Hide advanced")
        } else {
            wide("Advanced settings...")
        };
        let _ = SetWindowTextW(h, PCWSTR(text.as_ptr()));
    }
}

unsafe fn show_ctrl(hwnd: HWND, id: i32, show: bool) {
    if let Ok(h) = GetDlgItem(Some(hwnd), id) {
        let _ = ShowWindow(h, if show { SW_SHOW } else { SW_HIDE });
    }
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

unsafe fn label_id(
    p: HWND,
    id: i32,
    text: &str,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    let t = wide(text);
    mk(p, w!("STATIC"), PCWSTR(t.as_ptr()), WINDOW_STYLE(0), WINDOW_EX_STYLE(0), x, y, w, h, id, hinst, font);
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

/// Flip the Advanced (Worker URL) reveal and re-apply page visibility.
unsafe fn toggle_advanced(parent: HWND) {
    let ptr = GetWindowLongPtrW(parent, GWLP_USERDATA) as *const Ctx;
    if !ptr.is_null() {
        let cur = (*ptr).advanced.get();
        (*ptr).advanced.set(!cur);
    }
    apply_visibility(parent);
}

/// Fill controls from the current config.
unsafe fn populate(hwnd: HWND) {
    let c = Config::load();
    set_text(hwnd, ID_WORKER_URL, c.effective_worker_url());
    // Never put the full token in the edit box — leave empty so Save keeps it.
    set_text(hwnd, ID_TOKEN, "");
    if !c.bearer_token.is_empty() {
        let prefix = if c.bearer_token.len() > 12 {
            format!("{}…", &c.bearer_token[..12])
        } else {
            "saved".to_string()
        };
        set_text(
            hwnd,
            ID_TOKEN_HINT,
            &format!("Saved token: {prefix}  ·  leave blank to keep · paste new clk_… to replace"),
        );
    }
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
    if c.store_titles {
        if let Ok(h) = GetDlgItem(Some(hwnd), ID_STORE_TITLES) {
            SendMessageW(h, BM_SETCHECK, Some(WPARAM(1)), None);
        }
    }

    // Projects tab: fallback bucket + match rules.
    let rules = crate::rules::Rules::load();
    set_text(hwnd, ID_DEFAULT_BUCKET, &rules.default_project);
    for i in 0..MAX_MATCH_ROWS {
        let (contains, project) = rules
            .title_rules
            .get(i)
            .map(|r| (r.contains.as_str(), r.project.as_str()))
            .unwrap_or(("", ""));
        set_text(hwnd, ID_MATCH_CONTAINS_BASE + i as i32, contains);
        set_text(hwnd, ID_MATCH_PROJ_BASE + i as i32, project);
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

    let existing = Config::load();
    let token_field = get_text(hwnd, ID_TOKEN).trim().to_string();
    // Empty password field = keep existing DPAPI token (never re-displayed).
    let bearer_token = if token_field.is_empty() {
        existing.bearer_token
    } else {
        token_field
    };
    let cfg = Config {
        worker_url: get_text(hwnd, ID_WORKER_URL).trim().to_string(),
        bearer_token,
        // Entered in minutes; stored in seconds.
        idle_timeout_secs: get_text(hwnd, ID_IDLE).trim().parse::<u64>().unwrap_or(0) * 60,
        target_hours: get_text(hwnd, ID_TARGET).trim().parse().unwrap_or(0.0),
        work_start: get_time(hwnd, ID_START),
        work_end: get_time(hwnd, ID_END),
        work_days,
        store_titles: is_checked(hwnd, ID_STORE_TITLES),
        activity_retention_days: existing.activity_retention_days.max(7),
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

    // Projects tab: fold each row's project box back onto its app. Start from the
    // existing assignments so apps not currently listed aren't lost; a blank box
    // clears that app's assignment. Typing "Non-work" also adds to the ignore set.
    let mut rules = crate::rules::Rules::load();
    rules.default_project = get_text(hwnd, ID_DEFAULT_BUCKET).trim().to_string();
    let apps = ctx.apps.borrow().clone();
    for (i, app) in apps.iter().enumerate() {
        let project = get_text(hwnd, ID_ROW_PROJ_BASE + i as i32).trim().to_string();
        let key = app.trim().to_ascii_lowercase();
        if project.eq_ignore_ascii_case("non-work") || project.eq_ignore_ascii_case("ignore") {
            rules.ignore.insert(key.clone());
            rules.assignments.remove(&key);
            continue;
        }
        rules.ignore.remove(&key);
        if project.is_empty() {
            rules.assignments.remove(&key);
        } else {
            rules.assignments.insert(key, project);
        }
    }
    // Match rules: only keep rows with both fields; order preserved.
    rules.title_rules.clear();
    for i in 0..MAX_MATCH_ROWS {
        let contains = get_text(hwnd, ID_MATCH_CONTAINS_BASE + i as i32)
            .trim()
            .to_string();
        let project = get_text(hwnd, ID_MATCH_PROJ_BASE + i as i32)
            .trim()
            .to_string();
        if !contains.is_empty() && !project.is_empty() {
            rules.title_rules.push(crate::rules::TitleRule { contains, project });
        }
    }
    if let Err(e) = rules.save() {
        crate::logln!("rules save error: {e}");
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
