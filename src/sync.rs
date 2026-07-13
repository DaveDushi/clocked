//! Push unsynced sessions to the Cloudflare Worker.
//!
//! Runs on a dedicated OS thread with its own SQLite connection so the Win32
//! message loop never blocks on the network. When done it posts `done_msg`
//! back to the window so the tray status can refresh.

use std::time::Duration;

#[cfg(windows)]
use core::ffi::c_void;
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::PostMessageW;

use crate::config::Config;

/// Network timeout for the routine background sync (used by the Windows `spawn`).
#[cfg(windows)]
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Spawn a background sync. `hwnd_raw` is the window handle as `isize` (raw
/// pointers aren't `Send`; we rebuild the `HWND` inside the thread). Windows-only:
/// it signals the message loop on completion. macOS uses `run_blocking` on a
/// worker thread with an `AtomicBool` guard instead.
#[cfg(windows)]
pub fn spawn(hwnd_raw: isize, done_msg: u32, config: Config) {
    // Posts `done_msg` back to the window on drop — including if `run` panics —
    // so the UI's `syncing` overlap guard is always released. Otherwise a single
    // panic in the sync path would strand the guard and silently disable every
    // future background sync until the app restarts.
    struct SignalDone(isize, u32);
    impl Drop for SignalDone {
        fn drop(&mut self) {
            unsafe {
                let hwnd = HWND(self.0 as *mut c_void);
                let _ = PostMessageW(Some(hwnd), self.1, WPARAM(0), LPARAM(0));
            }
        }
    }

    std::thread::spawn(move || {
        let _done = SignalDone(hwnd_raw, done_msg);
        match run(&config, DEFAULT_TIMEOUT) {
            Ok(n) if n > 0 => crate::logln!("synced {n} session(s)"),
            Ok(_) => {}
            Err(e) => crate::logln!("sync error: {e}"),
        }
    });
}

/// Sync on the calling thread, blocking until it finishes or `timeout` elapses.
/// Returns the number of sessions pushed. Used on shutdown/quit, where a
/// detached thread would be killed before it could complete — keep `timeout`
/// small so we don't stall the OS shutdown sequence.
pub fn run_blocking(cfg: &Config, timeout: Duration) -> Result<usize, Box<dyn std::error::Error>> {
    run(cfg, timeout)
}

/// Exchange the desktop Bearer sync token for a one-time browser-login URL, so
/// "Open timesheet" lands the user already signed in even in a fresh or
/// logged-out browser. Returns `None` (caller falls back to the plain dashboard
/// URL) when syncing isn't configured or the Worker is unreachable/outdated.
pub fn desktop_login_url(cfg: &Config) -> Option<String> {
    if cfg.bearer_token.trim().is_empty() {
        return None;
    }
    let endpoint = cfg.effective_worker_url().trim_end_matches('/');
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client
        .post(format!("{endpoint}/api/auth/desktop/link"))
        .bearer_auth(&cfg.bearer_token)
        .json(&serde_json::json!({})) // better-auth requires an application/json body
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }

    #[derive(serde::Deserialize)]
    struct LinkResp {
        url: String,
    }
    let body: LinkResp = resp.json().ok()?;
    let url = body.url.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

fn run(cfg: &Config, timeout: Duration) -> Result<usize, Box<dyn std::error::Error>> {
    let path = crate::paths::db_file().ok_or("no data dir")?;
    let conn = rusqlite::Connection::open(path)?;

    // The `synced` flag doesn't record *which* Worker a session went to. If the
    // endpoint changed (e.g. local dev -> the hosted domain), re-queue the whole
    // history so the new Worker gets it. Ingest is idempotent (upsert by id).
    let endpoint = cfg.effective_worker_url().trim_end_matches('/');
    if crate::db::meta_get(&conn, "synced_endpoint")?.as_deref() != Some(endpoint) {
        let n = crate::db::reset_synced(&conn)?;
        crate::db::meta_set(&conn, "synced_endpoint", endpoint)?;
        if n > 0 {
            crate::logln!("sync endpoint changed -> re-queued {n} session(s) for {endpoint}");
        }
    }

    let pending = crate::db::unsynced(&conn)?;
    if pending.is_empty() {
        return Ok(0);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()?;
    let url = format!("{endpoint}/sessions");
    let resp = client
        .post(url)
        .bearer_auth(&cfg.bearer_token)
        .json(&serde_json::json!({ "sessions": pending }))
        .send()?;

    if !resp.status().is_success() {
        return Err(format!("worker returned HTTP {}", resp.status()).into());
    }

    // Prefer the Worker's `accepted` list so invalid/rejected sessions stay
    // unsynced and can be retried. Fall back only for older Workers that omit it.
    #[derive(serde::Deserialize)]
    struct IngestResp {
        accepted: Option<Vec<String>>,
        upserted: Option<usize>,
    }
    let body: IngestResp = resp.json().unwrap_or(IngestResp {
        accepted: None,
        upserted: None,
    });
    let ids: Vec<String> = if let Some(accepted) = body.accepted {
        accepted
    } else if body.upserted == Some(pending.len()) {
        pending.iter().map(|s| s.id.clone()).collect()
    } else {
        return Err(
            "worker response missing accepted ids; refusing to mark sessions synced".into(),
        );
    };
    if ids.is_empty() {
        return Ok(0);
    }
    crate::db::mark_synced(&conn, &ids)?;
    Ok(ids.len())
}
