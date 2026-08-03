//! Push unsynced sessions and daily activity aggregates to the Cloudflare Worker.
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

/// Outcome of a sync run, posted back to the UI thread on Windows (and used for
/// tray balloons when the user clicked **Sync now**).
#[derive(Debug, Clone)]
pub struct SyncResult {
    pub manual: bool,
    pub ok: bool,
    pub items: usize,
    pub error: Option<String>,
}

impl SyncResult {
    /// Short user-facing line for a tray balloon / notification.
    pub fn notify_body(&self) -> String {
        if self.ok {
            if self.items > 0 {
                format!(
                    "Synced {} item{}.",
                    self.items,
                    if self.items == 1 { "" } else { "s" }
                )
            } else {
                "Already up to date.".to_string()
            }
        } else {
            let detail = self
                .error
                .as_deref()
                .map(|e| truncate(e, 120))
                .unwrap_or_else(|| "see clocked.log".to_string());
            format!("Sync failed: {detail}")
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Spawn a background sync. `hwnd_raw` is the window handle as `isize` (raw
/// pointers aren't `Send`; we rebuild the `HWND` inside the thread). Windows-only:
/// it signals the message loop on completion. macOS uses `run_blocking` on a
/// worker thread with an `AtomicBool` guard instead.
///
/// `manual` is true when the user clicked **Sync now** — the UI shows a balloon
/// even when nothing was pending (otherwise the menu item looks broken).
#[cfg(windows)]
pub fn spawn(hwnd_raw: isize, done_msg: u32, config: Config, manual: bool) {
    // Posts `done_msg` with a `Box<SyncResult>` in WPARAM on drop — including if
    // `run` panics — so the UI's `syncing` overlap guard is always released.
    // Otherwise a single panic would strand the guard and silently disable every
    // future background sync until the app restarts.
    struct SignalDone {
        hwnd_raw: isize,
        done_msg: u32,
        manual: bool,
        result: Option<SyncResult>,
    }
    impl Drop for SignalDone {
        fn drop(&mut self) {
            let result = self.result.take().unwrap_or(SyncResult {
                manual: self.manual,
                ok: false,
                items: 0,
                error: Some("sync interrupted".into()),
            });
            unsafe {
                let hwnd = HWND(self.hwnd_raw as *mut c_void);
                let ptr = Box::into_raw(Box::new(result));
                let _ = PostMessageW(
                    Some(hwnd),
                    self.done_msg,
                    WPARAM(ptr as usize),
                    LPARAM(0),
                );
            }
        }
    }

    std::thread::spawn(move || {
        let mut done = SignalDone {
            hwnd_raw,
            done_msg,
            manual,
            result: None,
        };
        done.result = Some(match run(&config, DEFAULT_TIMEOUT) {
            Ok(n) => {
                if n > 0 {
                    crate::logln!("synced {n} item(s)");
                } else if manual {
                    crate::logln!("sync complete (nothing pending)");
                }
                SyncResult {
                    manual,
                    ok: true,
                    items: n,
                    error: None,
                }
            }
            Err(e) => {
                crate::logln!("sync error: {e}");
                SyncResult {
                    manual,
                    ok: false,
                    items: 0,
                    error: Some(e.to_string()),
                }
            }
        });
    });
}

/// Sync on the calling thread, blocking until it finishes or `timeout` elapses.
/// Returns the number of items pushed (sessions + activity day rows + pref updates).
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
        let a = crate::db::reset_activity_synced(&conn)?;
        // Re-push track_projects to the new Worker (cloud has no prior pref).
        let _ = crate::db::meta_set(&conn, "synced_track_projects", "");
        crate::db::meta_set(&conn, "synced_endpoint", endpoint)?;
        if n + a > 0 {
            crate::logln!(
                "sync endpoint changed -> re-queued {n} session(s) + {a} activity day(s) for {endpoint}"
            );
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()?;

    let mut total = 0usize;
    total += push_sessions(&client, &conn, cfg, endpoint)?;
    // Always consider track_projects so the Worker can hide dashboard/CSV project
    // rollups when the feature is off (even with no pending activity rows).
    total += push_activity(&client, &conn, cfg, endpoint)?;
    Ok(total)
}

fn push_sessions(
    client: &reqwest::blocking::Client,
    conn: &rusqlite::Connection,
    cfg: &Config,
    endpoint: &str,
) -> Result<usize, Box<dyn std::error::Error>> {
    let pending = crate::db::unsynced(conn)?;
    if pending.is_empty() {
        return Ok(0);
    }

    let url = format!("{endpoint}/sessions");
    let resp = client
        .post(url)
        .bearer_auth(&cfg.bearer_token)
        .json(&serde_json::json!({ "sessions": pending }))
        .send()?;

    if !resp.status().is_success() {
        return Err(format!("worker returned HTTP {} on /sessions", resp.status()).into());
    }

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
    crate::db::mark_synced(conn, &ids)?;
    Ok(ids.len())
}

/// Push the track_projects preference (when it changed) and, when the feature
/// is on, daily app/project aggregates (never window titles). Soft-fails if the
/// Worker is older and doesn't know `/activity` yet.
fn push_activity(
    client: &reqwest::blocking::Client,
    conn: &rusqlite::Connection,
    cfg: &Config,
    endpoint: &str,
) -> Result<usize, Box<dyn std::error::Error>> {
    // Only send day rows when the feature is on.
    let pending = if cfg.track_projects {
        crate::db::unsynced_activity(conn)?
    } else {
        Vec::new()
    };

    // Also POST when the local flag differs from what we last told the Worker,
    // so turning the feature off hides dashboard/CSV projects without waiting
    // for new activity rows.
    let flag_s = if cfg.track_projects { "1" } else { "0" };
    let flag_dirty =
        crate::db::meta_get(conn, "synced_track_projects")?.as_deref() != Some(flag_s);

    if pending.is_empty() && !flag_dirty {
        return Ok(0);
    }

    let url = format!("{endpoint}/activity");
    let resp = client
        .post(url)
        .bearer_auth(&cfg.bearer_token)
        .json(&serde_json::json!({
            "days": pending,
            "track_projects": cfg.track_projects,
        }))
        .send()?;

    // Older Workers return 404 — leave rows unsynced; next release will catch up.
    if resp.status().as_u16() == 404 {
        crate::logln!("activity sync skipped (Worker has no /activity yet)");
        return Ok(0);
    }
    // Older Workers that require non-empty days return 400 for pref-only pushes.
    // Leave the flag dirty so a future Worker upgrade (or pending rows) retries.
    if !resp.status().is_success() {
        if pending.is_empty() {
            crate::logln!(
                "activity pref sync skipped (Worker HTTP {}); project flag may be stale on cloud",
                resp.status()
            );
            return Ok(0);
        }
        return Err(format!("worker returned HTTP {} on /activity", resp.status()).into());
    }

    let mut count = 0usize;
    if flag_dirty {
        let _ = crate::db::meta_set(conn, "synced_track_projects", flag_s);
        // Count a successful preference push so manual Sync now isn't a no-op
        // after toggling track_projects with no pending day rows.
        count += 1;
    }

    if pending.is_empty() {
        return Ok(count);
    }

    #[derive(serde::Deserialize)]
    struct ActResp {
        accepted: Option<usize>,
        upserted: Option<usize>,
    }
    let body: ActResp = resp.json().unwrap_or(ActResp {
        accepted: None,
        upserted: None,
    });
    let n = body.accepted.or(body.upserted).unwrap_or(pending.len());
    if n == 0 {
        return Ok(count);
    }
    // Mark everything we sent; the Worker replaces aggregates by primary key.
    let keys: Vec<(String, String, String)> = pending
        .iter()
        .map(|r| (r.day.clone(), r.app.clone(), r.project.clone()))
        .collect();
    crate::db::mark_activity_synced(conn, &keys)?;
    Ok(count + keys.len())
}
