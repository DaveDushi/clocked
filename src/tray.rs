//! System-tray icon (Shell_NotifyIcon) hosted on the app's hidden window.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{LoadIconW, HICON, IDI_APPLICATION};

pub const TRAY_UID: u32 = 1;

/// Build the notify-icon data. `callback_msg` is the message the shell will
/// send to our window on mouse events over the icon.
pub fn build(hwnd: HWND, callback_msg: u32) -> NOTIFYICONDATAW {
    let hicon: HICON = unsafe { LoadIconW(None, IDI_APPLICATION) }.unwrap_or_default();
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
