//! System-tray icon (Shell_NotifyIcon) hosted on the app's hidden window.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE,
    NIM_MODIFY, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, LoadIconW, LoadImageW, HICON, IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTCOLOR,
    SM_CXSMICON, SM_CYSMICON,
};

pub const TRAY_UID: u32 = 1;

/// Icon resource id embedded by `build.rs` (see `set_icon_with_id(.., "1")`).
const ICON_RES_ID: u16 = 1;

/// Load the embedded app icon at the tray's small-icon size, falling back to
/// the stock application icon if the resource can't be loaded.
fn load_app_icon() -> HICON {
    unsafe {
        if let Ok(module) = GetModuleHandleW(None) {
            let cx = GetSystemMetrics(SM_CXSMICON);
            let cy = GetSystemMetrics(SM_CYSMICON);
            if let Ok(handle) = LoadImageW(
                Some(HINSTANCE(module.0)),
                PCWSTR(ICON_RES_ID as usize as *const u16),
                IMAGE_ICON,
                cx,
                cy,
                LR_DEFAULTCOLOR,
            ) {
                if !handle.is_invalid() {
                    return HICON(handle.0);
                }
            }
        }
        LoadIconW(None, IDI_APPLICATION).unwrap_or_default()
    }
}

/// Build the notify-icon data. `callback_msg` is the message the shell will
/// send to our window on mouse events over the icon.
pub fn build(hwnd: HWND, callback_msg: u32) -> NOTIFYICONDATAW {
    let hicon: HICON = load_app_icon();
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: TRAY_UID,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: callback_msg,
        hIcon: hicon,
        ..Default::default()
    };
    set_tip(&mut nid, "clocked");
    nid
}

/// Set the hover tooltip (max 127 UTF-16 code units).
pub fn set_tip(nid: &mut NOTIFYICONDATAW, text: &str) {
    let mut buf: Vec<u16> = text.encode_utf16().take(127).collect();
    buf.push(0);
    nid.szTip = [0u16; 128];
    nid.szTip[..buf.len()].copy_from_slice(&buf);
}

/// Copy `text` into a fixed-size UTF-16 field, truncating and null-terminating.
fn fill(dst: &mut [u16], text: &str) {
    let cap = dst.len().saturating_sub(1);
    let mut buf: Vec<u16> = text.encode_utf16().take(cap).collect();
    buf.push(0);
    dst[..buf.len()].copy_from_slice(&buf);
}

/// Show a one-shot balloon notification without disturbing the persistent icon
/// state (works on a temporary copy of the notify-icon data).
pub fn notify(nid: &NOTIFYICONDATAW, title: &str, msg: &str) {
    let mut n = *nid;
    n.uFlags |= NIF_INFO;
    n.dwInfoFlags = NIIF_INFO;
    fill(&mut n.szInfoTitle, title);
    fill(&mut n.szInfo, msg);
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &n);
    }
}

pub fn add(nid: &NOTIFYICONDATAW) {
    unsafe {
        let _ = Shell_NotifyIconW(NIM_ADD, nid);
    }
}

pub fn modify(nid: &NOTIFYICONDATAW) {
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, nid);
    }
}

pub fn remove(nid: &NOTIFYICONDATAW) {
    unsafe {
        let _ = Shell_NotifyIconW(NIM_DELETE, nid);
    }
}
