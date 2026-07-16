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
// Tab control + Projects (bucket) tab controls.
const ID_TABS: i32 = 900;
const ID_RULES_HELP: i32 = 1200;
const ID_LBL_BUCKETS: i32 = 1201;
const ID_BUCKET_LIST: i32 = 1202;
const ID_LBL_MEMBERS: i32 = 1203;
const ID_MEMBER_LIST: i32 = 1204;
const ID_NEW_BUCKET: i32 = 1205;
const ID_ADD_BUCKET: i32 = 1206;
const ID_DEL_BUCKET: i32 = 1207;
const ID_ADD_TO: i32 = 1208;
const ID_REMOVE_FROM: i32 = 1209;
const ID_LBL_POOL: i32 = 1210;
const ID_POOL_LIST: i32 = 1211;
const ID_LBL_SITE: i32 = 1212;
const ID_SITE_EDIT: i32 = 1213;
const ID_ADD_SITE: i32 = 1214;
const ID_LBL_DEFAULT: i32 = 1215;
const ID_DEFAULT_BUCKET: i32 = 1216;
const ID_BUCKET_HINT: i32 = 1217;

/// Special first bucket: apps here are ignored as Non-work.
const BUCKET_NON_WORK: &str = "Non-work";

// Every General-tab control except the Advanced-gated worker URL pair, which is
// shown/hidden by the Advanced toggle instead.
const GENERAL_CORE_IDS: &[i32] = &[
    ID_LBL_TOKEN, ID_TOKEN, ID_TOKEN_HINT, ID_LBL_IDLE, ID_LBL_TARGET, ID_IDLE, ID_TARGET,
    ID_LBL_START, ID_LBL_END, ID_START, ID_END, ID_LBL_DAYS, ID_DAY_BASE, ID_DAY_BASE + 1,
    ID_DAY_BASE + 2, ID_DAY_BASE + 3, ID_DAY_BASE + 4, ID_DAY_BASE + 5, ID_DAY_BASE + 6,
    ID_AUTOSTART, ID_KEEPALIVE, ID_STORE_TITLES, ID_ADVANCED,
];
const PROJECT_IDS: &[i32] = &[
    ID_RULES_HELP,
    ID_LBL_BUCKETS,
    ID_BUCKET_LIST,
    ID_LBL_MEMBERS,
    ID_MEMBER_LIST,
    ID_NEW_BUCKET,
    ID_ADD_BUCKET,
    ID_DEL_BUCKET,
    ID_ADD_TO,
    ID_REMOVE_FROM,
    ID_LBL_POOL,
    ID_POOL_LIST,
    ID_LBL_SITE,
    ID_SITE_EDIT,
    ID_ADD_SITE,
    ID_LBL_DEFAULT,
    ID_DEFAULT_BUCKET,
    ID_BUCKET_HINT,
];

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// An item shown inside a bucket (app exe or site/title tag).
#[derive(Clone, Debug)]
enum MemberKey {
    App(String),
    Site(String),
}

/// State handed to the window so it can notify the app after a save.
struct Ctx {
    main_hwnd: isize,
    saved_msg: u32,
    font: HFONT,
    /// Whether the Advanced (Worker URL) row is currently revealed. Tracked so a
    /// tab switch back to General can restore it correctly.
    advanced: Cell<bool>,
    /// Live project rules edited on the Projects tab (committed on Save).
    rules: RefCell<crate::rules::Rules>,
    /// Known app executables (pool + assigned), lowercased.
    apps: RefCell<Vec<String>>,
    /// Parallel to the Members listbox rows for remove/edit.
    member_keys: RefCell<Vec<MemberKey>>,
    /// Parallel to the Unassigned pool listbox rows.
    pool_keys: RefCell<Vec<String>>,
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

        let (w, h) = (520, 700);
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
        let ctx = Box::into_raw(Box::new(Ctx {
            main_hwnd: main_hwnd_raw,
            saved_msg,
            font: ui_font(),
            advanced: Cell::new(false),
            rules: RefCell::new(crate::rules::Rules::load()),
            apps: RefCell::new(Vec::new()),
            member_keys: RefCell::new(Vec::new()),
            pool_keys: RefCell::new(Vec::new()),
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
            let id = (wp.0 & 0xFFFF) as i32;
            let notify = ((wp.0 >> 16) & 0xFFFF) as u16;
            match (id, notify) {
                (ID_SAVE, _) => save_and_close(hwnd),
                (ID_CANCEL, _) => {
                    let _ = DestroyWindow(hwnd);
                }
                (ID_ADVANCED, _) => toggle_advanced(hwnd),
                (ID_ADD_BUCKET, _) => bucket_add(hwnd),
                (ID_DEL_BUCKET, _) => bucket_delete(hwnd),
                (ID_ADD_TO, _) => bucket_add_selected_app(hwnd),
                (ID_REMOVE_FROM, _) => bucket_remove_selected_member(hwnd),
                (ID_ADD_SITE, _) => bucket_add_site(hwnd),
                (ID_BUCKET_LIST, n) if n == LBN_SELCHANGE as u16 => {
                    refresh_bucket_members(hwnd);
                    refresh_members_label(hwnd);
                }
                (ID_POOL_LIST, n) if n == LBN_DBLCLK as u16 => bucket_add_selected_app(hwnd),
                (ID_MEMBER_LIST, n) if n == LBN_DBLCLK as u16 => bucket_remove_selected_member(hwnd),
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
    let fw = 456; // full field width (wider for bucket layout)
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

    // --- Projects page: bucket board (apps + site tags → named projects) ---
    label_id(
        hwnd,
        ID_RULES_HELP,
        "Project buckets — drop apps and site tags into a bucket.",
        m,
        44,
        fw,
        lh,
        hinst,
        font,
    );
    label_id(
        hwnd,
        ID_BUCKET_HINT,
        "Select a bucket, then add from Unassigned (or double-click). Sites use domains like acme.com.",
        m,
        64,
        fw,
        lh,
        hinst,
        font,
    );

    let bucket_w = 150;
    let mid = 36; // gap + transfer buttons
    let member_x = m + bucket_w + mid;
    let member_w = fw - bucket_w - mid;
    let board_top = 90;
    let board_h = 200;

    label_id(hwnd, ID_LBL_BUCKETS, "Buckets", m, board_top - 20, bucket_w, lh, hinst, font);
    label_id(
        hwnd,
        ID_LBL_MEMBERS,
        "In this bucket",
        member_x,
        board_top - 20,
        member_w,
        lh,
        hinst,
        font,
    );
    listbox(hwnd, ID_BUCKET_LIST, m, board_top, bucket_w, board_h, hinst, font);
    listbox(hwnd, ID_MEMBER_LIST, member_x, board_top, member_w, board_h, hinst, font);

    // Transfer buttons between pool actions and board.
    let btn_y = board_top + board_h + 8;
    edit(hwnd, ID_NEW_BUCKET, m, btn_y, 110, eh, WINDOW_STYLE(0), hinst, font);
    button(hwnd, ID_ADD_BUCKET, "+ New", m + 116, btn_y, 56, hinst, font, false);
    button(hwnd, ID_DEL_BUCKET, "Delete", m + 176, btn_y, 64, hinst, font, false);
    button(hwnd, ID_ADD_TO, "Add →", member_x, btn_y, 72, hinst, font, false);
    button(hwnd, ID_REMOVE_FROM, "← Remove", member_x + 80, btn_y, 88, hinst, font, false);

    let pool_top = btn_y + 40;
    label_id(
        hwnd,
        ID_LBL_POOL,
        "Unassigned apps — pick a bucket above, then Add (or double-click)",
        m,
        pool_top,
        fw,
        lh,
        hinst,
        font,
    );
    listbox(hwnd, ID_POOL_LIST, m, pool_top + 20, fw, 110, hinst, font);

    let site_y = pool_top + 140;
    label_id(
        hwnd,
        ID_LBL_SITE,
        "Tag a site or doc into the selected bucket (e.g. github.com or Invoice)",
        m,
        site_y,
        fw,
        lh,
        hinst,
        font,
    );
    edit(hwnd, ID_SITE_EDIT, m, site_y + 20, fw - 120, eh, WINDOW_STYLE(0), hinst, font);
    button(hwnd, ID_ADD_SITE, "Add tag", m + fw - 112, site_y + 20, 112, hinst, font, false);

    let default_y = site_y + 56;
    label_id(
        hwnd,
        ID_LBL_DEFAULT,
        "Everything else   ·   leave blank to group by app name",
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
        default_y + 20,
        half,
        eh,
        WINDOW_STYLE(0),
        hinst,
        font,
    );

    // --- Shared footer buttons ---
    button(hwnd, ID_CANCEL, "Cancel", m + fw - 104, 620, 104, hinst, font, false);
    button(hwnd, ID_SAVE, "Save", m + fw - 104 - 116, 620, 104, hinst, font, true);

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

/// Scrollable listbox used by the bucket board.
unsafe fn listbox(
    parent: HWND,
    id: i32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    hinst: HINSTANCE,
    font: WPARAM,
) {
    mk(
        parent,
        w!("LISTBOX"),
        PCWSTR::null(),
        WS_TABSTOP
            | WS_VSCROLL
            | WINDOW_STYLE((LBS_NOTIFY | LBS_NOINTEGRALHEIGHT | LBS_HASSTRINGS) as u32),
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

/// Apps known for the pool: most-used first, plus anything already assigned/ignored.
fn apps_to_show(rules: &crate::rules::Rules) -> Vec<String> {
    let mut apps: Vec<String> = Vec::new();
    if let Ok(conn) = crate::db::open() {
        if let Ok(seen) = crate::db::apps_seen(&conn, 80) {
            apps = seen;
        }
    }
    for app in rules.assignments.keys().chain(rules.ignore.iter()) {
        if is_bucket_marker(app) {
            continue;
        }
        if !apps.iter().any(|a| a.eq_ignore_ascii_case(app)) {
            apps.push(app.clone());
        }
    }
    apps
}

fn is_bucket_marker(app: &str) -> bool {
    app.starts_with("__bucket__")
}

/// Collect named project buckets from the draft rules (plus Non-work first).
fn bucket_names(rules: &crate::rules::Rules) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    names.push(BUCKET_NON_WORK.to_string());
    let mut rest: Vec<String> = Vec::new();
    for (app, p) in rules.assignments.iter() {
        let p = p.trim();
        if p.is_empty() || p.eq_ignore_ascii_case(BUCKET_NON_WORK) {
            continue;
        }
        // Markers only exist so empty buckets still appear in the list.
        let _ = app;
        if !rest.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            rest.push(p.to_string());
        }
    }
    for r in &rules.title_rules {
        let p = r.project.trim();
        if p.is_empty() || p.eq_ignore_ascii_case(BUCKET_NON_WORK) {
            continue;
        }
        if !rest.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            rest.push(p.to_string());
        }
    }
    rest.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    names.extend(rest);
    names
}

unsafe fn listbox_clear(parent: HWND, id: i32) {
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        SendMessageW(h, LB_RESETCONTENT, None, None);
    }
}

unsafe fn listbox_add(parent: HWND, id: i32, text: &str) {
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        let t = wide(text);
        SendMessageW(h, LB_ADDSTRING, None, Some(LPARAM(t.as_ptr() as isize)));
    }
}

unsafe fn listbox_sel(parent: HWND, id: i32) -> Option<usize> {
    let Ok(h) = GetDlgItem(Some(parent), id) else {
        return None;
    };
    let i = SendMessageW(h, LB_GETCURSEL, None, None).0;
    if i < 0 {
        None
    } else {
        Some(i as usize)
    }
}

unsafe fn listbox_set_sel(parent: HWND, id: i32, index: i32) {
    if let Ok(h) = GetDlgItem(Some(parent), id) {
        SendMessageW(h, LB_SETCURSEL, Some(WPARAM(index as usize)), None);
    }
}

/// Currently selected bucket name, if any.
unsafe fn selected_bucket(parent: HWND) -> Option<String> {
    let idx = listbox_sel(parent, ID_BUCKET_LIST)?;
    let names = {
        let ctx = ctx_ref(parent)?;
        bucket_names(&ctx.rules.borrow())
    };
    names.get(idx).cloned()
}

/// Rebuild the Buckets listbox from draft rules; keep selection if possible.
unsafe fn refresh_bucket_list(parent: HWND, prefer: Option<&str>) {
    let (names, prefer_owned) = {
        let Some(ctx) = ctx_ref(parent) else {
            return;
        };
        (bucket_names(&ctx.rules.borrow()), prefer.map(|s| s.to_string()))
    };
    let prev = prefer_owned.or_else(|| selected_bucket(parent));
    listbox_clear(parent, ID_BUCKET_LIST);
    for n in &names {
        listbox_add(parent, ID_BUCKET_LIST, n);
    }
    let sel = prev
        .and_then(|p| {
            names
                .iter()
                .position(|n| n.eq_ignore_ascii_case(&p))
                .map(|i| i as i32)
        })
        .unwrap_or(0);
    listbox_set_sel(parent, ID_BUCKET_LIST, sel);
    refresh_members_label(parent);
    refresh_bucket_members(parent);
    refresh_pool(parent);
}

unsafe fn refresh_members_label(parent: HWND) {
    let name = selected_bucket(parent).unwrap_or_else(|| "…".into());
    set_text(parent, ID_LBL_MEMBERS, &format!("In “{name}”"));
}

/// Fill Members for the selected bucket.
unsafe fn refresh_bucket_members(parent: HWND) {
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let bucket = match selected_bucket(parent) {
        Some(b) => b,
        None => {
            listbox_clear(parent, ID_MEMBER_LIST);
            ctx.member_keys.borrow_mut().clear();
            return;
        }
    };
    let rules = ctx.rules.borrow();
    let mut keys: Vec<MemberKey> = Vec::new();
    listbox_clear(parent, ID_MEMBER_LIST);

    if bucket.eq_ignore_ascii_case(BUCKET_NON_WORK) {
        for app in rules.ignore.iter() {
            keys.push(MemberKey::App(app.clone()));
            listbox_add(
                parent,
                ID_MEMBER_LIST,
                &format!("app · {}", crate::rules::pretty_app_name(app)),
            );
        }
    } else {
        for (app, project) in rules.assignments.iter() {
            if is_bucket_marker(app) {
                continue; // empty-bucket placeholder, not a real member
            }
            if project.eq_ignore_ascii_case(&bucket) {
                keys.push(MemberKey::App(app.clone()));
                listbox_add(
                    parent,
                    ID_MEMBER_LIST,
                    &format!("app · {}", crate::rules::pretty_app_name(app)),
                );
            }
        }
        for rule in &rules.title_rules {
            if rule.project.eq_ignore_ascii_case(&bucket) {
                keys.push(MemberKey::Site(rule.contains.clone()));
                listbox_add(
                    parent,
                    ID_MEMBER_LIST,
                    &format!("site · {}", rule.contains),
                );
            }
        }
    }
    drop(rules);
    *ctx.member_keys.borrow_mut() = keys;
}

/// Fill Unassigned pool (apps not in any bucket / ignore).
unsafe fn refresh_pool(parent: HWND) {
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let rules = ctx.rules.borrow();
    let apps = ctx.apps.borrow().clone();
    let mut pool: Vec<String> = Vec::new();
    listbox_clear(parent, ID_POOL_LIST);
    for app in apps {
        let key = app.trim().to_ascii_lowercase();
        if rules.is_ignored(&key) || rules.assigned(&key).is_some() {
            continue;
        }
        pool.push(key.clone());
        listbox_add(
            parent,
            ID_POOL_LIST,
            &crate::rules::pretty_app_name(&key),
        );
    }
    drop(rules);
    *ctx.pool_keys.borrow_mut() = pool;
}

unsafe fn bucket_add(parent: HWND) {
    let name = get_text(parent, ID_NEW_BUCKET).trim().to_string();
    if name.is_empty() {
        return;
    }
    if name.eq_ignore_ascii_case(BUCKET_NON_WORK) {
        set_text(parent, ID_NEW_BUCKET, "");
        return;
    }
    // Creating a bucket only needs it to appear in the list — seed with a no-op
    // title rule placeholder? Better: store empty assignment isn't enough.
    // We keep empty buckets alive by writing a sentinel site tag... messy.
    // Instead: add a zero-width placeholder via a special title rule we skip on
    // save if empty — simplest is track extra empty bucket names in Ctx.
    // For pure Rules model: add title_rules with contains="" is invalid.
    // Practical approach: if brand-new, inject a temporary assignment for a
    // fictional app "__bucket__" that we strip on save — hacky.
    //
    // Cleaner: store optional empty_buckets in Ctx.
    // Keep it simple: rename flow uses NEW name by assigning first app later.
    // For empty named buckets, stash in title_rules with contains = "\u{200B}"? no.
    //
    // Use a meta key in assignments: we don't.
    // Simplest UX that works: after + New, select the new name by temporarily
    // adding a title rule with contains = name and project = name, user can
    // remove — bad.
    //
    // Ctx field `extra_buckets: RefCell<Vec<String>>` is the right approach.
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    {
        let rules = ctx.rules.borrow();
        if bucket_names(&rules)
            .iter()
            .any(|b| b.eq_ignore_ascii_case(&name))
        {
            drop(rules);
            set_text(parent, ID_NEW_BUCKET, "");
            refresh_bucket_list(parent, Some(&name));
            return;
        }
    }
    // Mark existence with a no-op: empty assignment of a reserved key is wrong.
    // Attach a site tag equal to the bucket name only if user adds content.
    // We'll keep empty names by pushing a dummy title rule that save strips
    // when contains is empty — can't.
    //
    // Final approach: `extra_buckets` on Ctx.
    // Actually inject into rules by cloning and using a side list.
    // Quick fix: add title_rules entry with contains = format!("__bucket:{name}")
    // that classify never matches (underscore rare domains) and save filters them.
    //
    // Even simpler for ship: require adding an app immediately; still show
    // the name after first assignment. For + New with no members, use
    // reserved assignment "__bucket_marker__" = name, filtered on save and
    // hidden from pool.
    ctx.rules
        .borrow_mut()
        .assignments
        .insert(format!("__bucket__{}", name.to_ascii_lowercase()), name.clone());
    set_text(parent, ID_NEW_BUCKET, "");
    refresh_bucket_list(parent, Some(&name));
}

unsafe fn bucket_delete(parent: HWND) {
    let Some(bucket) = selected_bucket(parent) else {
        return;
    };
    if bucket.eq_ignore_ascii_case(BUCKET_NON_WORK) {
        return; // fixed bucket
    }
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let mut rules = ctx.rules.borrow_mut();
    rules.assignments.retain(|app, project| {
        if is_bucket_marker(app) && project.eq_ignore_ascii_case(&bucket) {
            return false;
        }
        if project.eq_ignore_ascii_case(&bucket) {
            return false; // unassign apps
        }
        true
    });
    rules
        .title_rules
        .retain(|r| !r.project.eq_ignore_ascii_case(&bucket));
    drop(rules);
    refresh_bucket_list(parent, Some(BUCKET_NON_WORK));
}

unsafe fn bucket_add_selected_app(parent: HWND) {
    let Some(bucket) = selected_bucket(parent) else {
        return;
    };
    let Some(pool_idx) = listbox_sel(parent, ID_POOL_LIST) else {
        return;
    };
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let app = match ctx.pool_keys.borrow().get(pool_idx).cloned() {
        Some(a) => a,
        None => return,
    };
    let key = app.trim().to_ascii_lowercase();
    let mut rules = ctx.rules.borrow_mut();
    if bucket.eq_ignore_ascii_case(BUCKET_NON_WORK) {
        rules.ignore.insert(key.clone());
        rules.assignments.remove(&key);
    } else {
        rules.ignore.remove(&key);
        rules.assignments.insert(key, bucket.clone());
    }
    drop(rules);
    refresh_bucket_list(parent, Some(&bucket));
}

unsafe fn bucket_remove_selected_member(parent: HWND) {
    let Some(bucket) = selected_bucket(parent) else {
        return;
    };
    let Some(mem_idx) = listbox_sel(parent, ID_MEMBER_LIST) else {
        return;
    };
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let member = match ctx.member_keys.borrow().get(mem_idx).cloned() {
        Some(m) => m,
        None => return,
    };
    let mut rules = ctx.rules.borrow_mut();
    match member {
        MemberKey::App(app) => {
            let key = app.trim().to_ascii_lowercase();
            rules.ignore.remove(&key);
            rules.assignments.remove(&key);
        }
        MemberKey::Site(contains) => {
            rules
                .title_rules
                .retain(|r| !(r.contains.eq_ignore_ascii_case(&contains)
                    && r.project.eq_ignore_ascii_case(&bucket)));
        }
    }
    drop(rules);
    refresh_bucket_list(parent, Some(&bucket));
}

unsafe fn bucket_add_site(parent: HWND) {
    let Some(bucket) = selected_bucket(parent) else {
        return;
    };
    if bucket.eq_ignore_ascii_case(BUCKET_NON_WORK) {
        // Sites don't go to Non-work ignore; leave a hint in the field.
        return;
    }
    let contains = get_text(parent, ID_SITE_EDIT).trim().to_string();
    if contains.is_empty() {
        return;
    }
    let Some(ctx) = ctx_ref(parent) else {
        return;
    };
    let mut rules = ctx.rules.borrow_mut();
    // Replace existing rule with same needle, or push.
    if let Some(existing) = rules
        .title_rules
        .iter_mut()
        .find(|r| r.contains.eq_ignore_ascii_case(&contains))
    {
        existing.project = bucket.clone();
    } else {
        rules.title_rules.push(crate::rules::TitleRule {
            contains: contains.clone(),
            project: bucket.clone(),
        });
    }
    drop(rules);
    set_text(parent, ID_SITE_EDIT, "");
    refresh_bucket_list(parent, Some(&bucket));
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

    // Projects tab: seed draft rules + app pool, paint the bucket board.
    if let Some(ctx) = ctx_ref(hwnd) {
        let rules = crate::rules::Rules::load();
        set_text(hwnd, ID_DEFAULT_BUCKET, &rules.default_project);
        *ctx.apps.borrow_mut() = apps_to_show(&rules);
        *ctx.rules.borrow_mut() = rules;
    }
    refresh_bucket_list(hwnd, Some(BUCKET_NON_WORK));
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

    // Projects tab: commit the in-memory bucket board (strip empty-bucket markers).
    let mut rules = ctx.rules.borrow().clone();
    rules.default_project = get_text(hwnd, ID_DEFAULT_BUCKET).trim().to_string();
    rules.assignments.retain(|app, _| !is_bucket_marker(app));
    rules
        .title_rules
        .retain(|r| !r.contains.trim().is_empty() && !r.project.trim().is_empty());
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
