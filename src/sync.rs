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
#[cfg_attr(target_os = "linux", allow(dead_code))]
#[derive(Debug, Clone)]
pub struct SyncResult {
    pub manual: bool,
    pub ok: bool,
    pub items: usize,
    pub error: Option<String>,
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
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

#[cfg_attr(target_os = "linux", allow(dead_code))]
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
                let _ = PostMessageW(Some(hwnd), self.done_msg, WPARAM(ptr as usize), LPARAM(0));
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
        done.result = Some(match run(&config, DEFAULT_TIMEOUT, manual) {
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
pub fn run_blocking(
    cfg: &Config,
    timeout: Duration,
    force_policy: bool,
) -> Result<usize, Box<dyn std::error::Error>> {
    run(cfg, timeout, force_policy)
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

pub const SYNC_INTERVAL: Duration = Duration::from_secs(60);
const POLICY_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct SyncState {
    policy_refresh: Option<(String, std::time::Instant)>,
}

impl SyncState {
    fn policy_due(&self, account: &str, now: std::time::Instant) -> bool {
        self.policy_refresh.as_ref().is_none_or(|(previous, at)| {
            previous != account || now.duration_since(*at) >= POLICY_INTERVAL
        })
    }
}

static SYNC_LOCK: std::sync::Mutex<SyncState> = std::sync::Mutex::new(SyncState {
    policy_refresh: None,
});

/// Spend the suspend budget on uploading time, without policy downloads.
pub fn before_suspend(cfg: &Config) -> Result<usize, Box<dyn std::error::Error>> {
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "sync already in progress")?;
    let path = crate::paths::db_file().ok_or("no data dir")?;
    let conn = rusqlite::Connection::open(path)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()?;
    push_sessions(
        &client,
        &conn,
        cfg,
        cfg.effective_worker_url().trim_end_matches('/'),
    )
}

fn run(
    cfg: &Config,
    timeout: Duration,
    force_policy: bool,
) -> Result<usize, Box<dyn std::error::Error>> {
    let mut state = SYNC_LOCK
        .try_lock()
        .map_err(|_| "sync already in progress")?;
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

    // Upload presence before spending time on policy downloads.
    let sessions = push_sessions(&client, &conn, cfg, endpoint);
    // Refresh settings independently of the frequent time uploads, including when uploads fail.
    let account = crate::working_hours::account_key(cfg);
    let refresh_at = std::time::Instant::now();
    let (policy, inactivity) = if force_policy || state.policy_due(&account, refresh_at) {
        let policy = crate::working_hours::pull(&client, &conn, cfg);
        let inactivity = crate::inactivity::pull(&client, &conn, cfg);
        if policy.is_ok() && inactivity.is_ok() {
            state.policy_refresh = Some((account, refresh_at));
        }
        (policy, inactivity)
    } else {
        (Ok(0), Ok(0))
    };
    let mut total = 0usize;
    total += sessions?;
    // Always consider track_projects so the Worker can hide dashboard/CSV project
    // rollups when the feature is off (even with no pending activity rows).
    total += push_activity(&client, &conn, cfg, endpoint)?;
    total += policy?;
    total += inactivity?;
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
    crate::db::mark_uploaded(conn, &pending, &ids)?;
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
    let flag_dirty = crate::db::meta_get(conn, "synced_track_projects")?.as_deref() != Some(flag_s);

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

#[cfg(test)]
mod session_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn frequent_uploads_do_not_refresh_settings_until_due_or_account_changes() {
        let now = std::time::Instant::now();
        let mut state = SyncState::default();
        assert!(state.policy_due("account-a", now));
        state.policy_refresh = Some(("account-a".into(), now));
        assert!(!state.policy_due("account-a", now + Duration::from_secs(60)));
        assert!(!state.policy_due("account-a", now + Duration::from_secs(899)));
        assert!(state.policy_due("account-a", now + Duration::from_secs(900)));
        assert!(state.policy_due("account-b", now + Duration::from_secs(60)));
    }

    #[test]
    fn uploads_live_work_before_lid_close_and_then_final_end() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339("2026-10-29T09:18:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        crate::db::clock_in(&conn, "unlock", start).unwrap();
        crate::db::heartbeat(&conn, start + chrono::Duration::hours(7)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut ends = Vec::new();
            let mut session_ids = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0u8; 1];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let headers = String::from_utf8(bytes).unwrap();
                assert!(headers.starts_with("POST /sessions "));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let session = &body["sessions"][0];
                ends.push(session["end_utc"].as_str().unwrap().to_owned());
                session_ids.push(session["id"].as_str().unwrap().to_owned());
                let response =
                    serde_json::json!({"accepted":[session["id"]],"upserted":1}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    response
                )
                .unwrap();
            }
            assert_eq!(session_ids[0], session_ids[1]);
            ends
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let cfg = Config::default();
        assert_eq!(push_sessions(&client, &conn, &cfg, &endpoint).unwrap(), 1);
        crate::db::clock_out(&conn, "suspend", start + chrono::Duration::minutes(421)).unwrap();
        assert_eq!(push_sessions(&client, &conn, &cfg, &endpoint).unwrap(), 1);
        assert!(crate::db::unsynced(&conn).unwrap().is_empty());
        let ends = server.join().unwrap();
        assert_eq!(
            ends,
            vec!["2026-10-29T16:18:00+00:00", "2026-10-29T16:19:00+00:00"]
        );
    }
}
