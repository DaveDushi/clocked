//! Push unsynced sessions to the Cloudflare Worker.
//!
//! Runs on a dedicated OS thread with its own SQLite connection so the Win32
//! message loop never blocks on the network. When done it posts `done_msg`
//! back to the window so the tray status can refresh.

use core::ffi::c_void;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

use crate::config::Config;

/// Spawn a background sync. `hwnd_raw` is the window handle as `isize` (raw
/// pointers aren't `Send`; we rebuild the `HWND` inside the thread).
pub fn spawn(hwnd_raw: isize, done_msg: u32, config: Config) {
    std::thread::spawn(move || {
        match run(&config) {
            Ok(n) if n > 0 => crate::logln!("synced {n} session(s)"),
            Ok(_) => {}
            Err(e) => crate::logln!("sync error: {e}"),
        }
        unsafe {
            let hwnd = HWND(hwnd_raw as *mut c_void);
            let _ = PostMessageW(Some(hwnd), done_msg, WPARAM(0), LPARAM(0));
        }
    });
}

fn run(cfg: &Config) -> Result<usize, Box<dyn std::error::Error>> {
    let path = crate::paths::db_file().ok_or("no data dir")?;
    let conn = rusqlite::Connection::open(path)?;
    let pending = crate::db::unsynced(&conn)?;
    if pending.is_empty() {
        return Ok(0);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let url = format!("{}/sessions", cfg.worker_url.trim_end_matches('/'));
    let resp = client
        .post(url)
        .bearer_auth(&cfg.bearer_token)
        .json(&serde_json::json!({ "sessions": pending }))
        .send()?;

    if !resp.status().is_success() {
        return Err(format!("worker returned HTTP {}", resp.status()).into());
    }

    let ids: Vec<String> = pending.iter().map(|s| s.id.clone()).collect();
    crate::db::mark_synced(&conn, &ids)?;
    Ok(ids.len())
}
