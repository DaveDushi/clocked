//! Local SQLite store — the source of truth for sessions.
//!
//! A **session** is one continuous span the user was present, stored as a row
//! with a UTC start/end and a reason for each edge. Invariant: at most one
//! open session (`end_utc IS NULL`) at a time.
//!
//! Core mutators take an explicit `now` so they can be unit-tested
//! deterministically; the app passes `Utc::now()`.

use chrono::{DateTime, Datelike, Local, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};

/// A completed session ready to sync to the Worker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Session {
    pub id: String,
    pub start_utc: String,
    pub end_utc: String,
    pub start_reason: String,
    pub end_reason: String,
}

/// Open (or create) the on-disk database and ensure the schema exists.
pub fn open() -> rusqlite::Result<Connection> {
    let path = crate::paths::db_file().expect("resolve data dir");
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Apply schema + pragmas. Separated so tests can use an in-memory connection.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
            id           TEXT PRIMARY KEY,
            start_utc    TEXT NOT NULL,
            end_utc      TEXT,
            start_reason TEXT NOT NULL,
            end_reason   TEXT,
            synced       INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
         CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced);
         CREATE TABLE IF NOT EXISTS activity (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_utc   TEXT NOT NULL,
            app      TEXT NOT NULL,
            title    TEXT NOT NULL,
            project  TEXT NOT NULL,
            secs     INTEGER NOT NULL,
            context  TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts_utc);
         -- Daily app/project aggregates ready to sync (no titles ever leave the machine).
         CREATE TABLE IF NOT EXISTS activity_day (
            day      TEXT NOT NULL,
            app      TEXT NOT NULL,
            project  TEXT NOT NULL,
            secs     INTEGER NOT NULL,
            synced   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, app, project)
         );
         CREATE INDEX IF NOT EXISTS idx_activity_day_synced ON activity_day(synced);",
    )?;
    // Older installs created `activity` without `context` — add it if missing.
    let has_context: bool = conn
        .prepare("PRAGMA table_info(activity)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .any(|name| name == "context");
    if !has_context {
        let _ = conn.execute(
            "ALTER TABLE activity ADD COLUMN context TEXT NOT NULL DEFAULT ''",
            [],
        );
    }
    // One-time scrub: blank historical titles so older installs don't keep a
    // sensitive title corpus after upgrading to privacy defaults.
    let scrubbed = meta_get(conn, "titles_scrubbed_v1")?.as_deref() == Some("1");
    if !scrubbed {
        let _ = conn.execute("UPDATE activity SET title = ''", []);
        meta_set(conn, "titles_scrubbed_v1", "1")?;
    }
    Ok(())
}

/// UTC instant of local midnight for the calendar day containing `now`. Used to
/// bound "today" queries to the user's wall-clock day.
fn local_day_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let local_now = now.with_timezone(&Local);
    let day_start_local = Local
        .with_ymd_and_hms(local_now.year(), local_now.month(), local_now.day(), 0, 0, 0)
        .single()
        .unwrap_or(local_now);
    day_start_local.with_timezone(&Utc)
}

fn fmt(ts: DateTime<Utc>) -> String {
    ts.to_rfc3339()
}

fn parse(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// Start time of the currently open session, if any.
pub fn open_session_start(conn: &Connection) -> rusqlite::Result<Option<DateTime<Utc>>> {
    let v: Option<String> = conn
        .query_row(
            "SELECT start_utc FROM sessions WHERE end_utc IS NULL LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.map(|s| parse(&s)))
}

/// Open a new session. No-op (returns `false`) if one is already open.
pub fn clock_in(conn: &Connection, reason: &str, now: DateTime<Utc>) -> rusqlite::Result<bool> {
    if open_session_start(conn)?.is_some() {
        return Ok(false);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sessions (id, start_utc, start_reason, synced) VALUES (?1, ?2, ?3, 0)",
        params![id, fmt(now), reason],
    )?;
    Ok(true)
}

/// Outcome of a `clock_out`.
#[derive(Debug, PartialEq, Eq)]
pub enum ClockOut {
    /// Nothing was open — no-op.
    None,
    /// An open session with real elapsed time was closed.
    Closed,
    /// The open session had zero duration (e.g. an automatic wake immediately
    /// followed by a lock) and was discarded rather than recorded.
    DroppedEmpty,
}

/// Close the open session. Returns `None` if none is open. A session whose end
/// wouldn't advance past its start (no time elapsed) is deleted rather than
/// recorded, so unattended wake/lock blips never reach the timesheet.
pub fn clock_out(conn: &Connection, reason: &str, now: DateTime<Utc>) -> rusqlite::Result<ClockOut> {
    let Some(start) = open_session_start(conn)? else {
        return Ok(ClockOut::None);
    };
    if now <= start {
        conn.execute("DELETE FROM sessions WHERE end_utc IS NULL", [])?;
        return Ok(ClockOut::DroppedEmpty);
    }
    conn.execute(
        "UPDATE sessions
            SET end_utc = ?1, end_reason = ?2, synced = 0
          WHERE end_utc IS NULL",
        params![fmt(now), reason],
    )?;
    Ok(ClockOut::Closed)
}

/// Record a liveness timestamp (used to recover from crashes/hard power-off).
pub fn heartbeat(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('last_alive', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        params![fmt(now)],
    )?;
    Ok(())
}

pub fn last_alive(conn: &Connection) -> rusqlite::Result<Option<DateTime<Utc>>> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'last_alive'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(v.map(|s| parse(&s)))
}

/// On startup: if a session was left open (crash / hard power-off), close it at
/// the last heartbeat time with reason `crash` (never before its start).
pub fn recover_crashed(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<bool> {
    let Some(start) = open_session_start(conn)? else {
        return Ok(false);
    };
    let end = last_alive(conn)?.unwrap_or(now);
    if end <= start {
        // No time elapsed before the crash — drop it rather than record a blip.
        conn.execute("DELETE FROM sessions WHERE end_utc IS NULL", [])?;
        return Ok(false);
    }
    conn.execute(
        "UPDATE sessions
            SET end_utc = ?1, end_reason = 'crash', synced = 0
          WHERE end_utc IS NULL",
        params![fmt(end)],
    )?;
    Ok(true)
}

/// Total seconds present so far during the local calendar day containing `now`
/// (open session counted up to `now`). Used for the Windows tray tooltip; the
/// macOS menu doesn't surface it yet.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn today_total_secs(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<i64> {
    let day_start = local_day_start(now);

    let mut stmt = conn.prepare(
        "SELECT start_utc, end_utc FROM sessions WHERE end_utc IS NULL OR end_utc >= ?1",
    )?;
    let rows = stmt.query_map(params![fmt(day_start)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;

    let mut total = 0i64;
    for row in rows {
        let (s, e) = row?;
        let start = parse(&s);
        let end = e.map(|x| parse(&x)).unwrap_or(now);
        let seg_start = start.max(day_start);
        let seg_end = end.min(now);
        if seg_end > seg_start {
            total += (seg_end - seg_start).num_seconds();
        }
    }
    Ok(total)
}

/// Record a foreground activity segment: `secs` credited to `project`, tagged
/// with the app, optional full title (opt-in), and privacy-safe context (domain
/// / document). Raw rows stay local; daily aggregates sync without titles/context.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn record_activity(
    conn: &Connection,
    now: DateTime<Utc>,
    app: &str,
    title: &str,
    project: &str,
    secs: i64,
) -> rusqlite::Result<()> {
    record_activity_full(conn, now, app, title, "", project, secs)
}

/// Like [`record_activity`] with an explicit context label.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn record_activity_full(
    conn: &Connection,
    now: DateTime<Utc>,
    app: &str,
    title: &str,
    context: &str,
    project: &str,
    secs: i64,
) -> rusqlite::Result<()> {
    if secs < 1 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO activity (ts_utc, app, title, project, secs, context)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![fmt(now), app, title, project, secs, context],
    )?;
    // Roll into the local calendar day aggregate for sync (no title/context).
    let day = now.with_timezone(&Local).format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO activity_day (day, app, project, secs, synced)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(day, app, project) DO UPDATE SET
           secs = activity_day.secs + excluded.secs,
           synced = 0",
        params![day, app, project, secs],
    )?;
    Ok(())
}

/// Delete activity samples older than `retention_days`. Returns rows removed.
pub fn prune_activity(conn: &Connection, now: DateTime<Utc>, retention_days: i64) -> rusqlite::Result<usize> {
    let days = retention_days.max(7); // never prune more aggressively than a week
    let cutoff = now - chrono::Duration::days(days);
    let n = conn.execute(
        "DELETE FROM activity WHERE ts_utc < ?1",
        params![fmt(cutoff)],
    )?;
    // Drop day aggregates older than retention (keep a little longer for reports).
    let day_cutoff = (now - chrono::Duration::days(days))
        .with_timezone(&Local)
        .format("%Y-%m-%d")
        .to_string();
    let _ = conn.execute(
        "DELETE FROM activity_day WHERE day < ?1",
        params![day_cutoff],
    )?;
    Ok(n)
}

/// A daily app/project total ready to sync (no window titles).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ActivityDayRow {
    pub day: String,
    pub app: String,
    pub project: String,
    pub secs: i64,
}

/// Unsynced daily activity aggregates (titles never included).
pub fn unsynced_activity(conn: &Connection) -> rusqlite::Result<Vec<ActivityDayRow>> {
    let mut stmt = conn.prepare(
        "SELECT day, app, project, secs FROM activity_day
          WHERE synced = 0 AND secs > 0
          ORDER BY day, project, app
          LIMIT 2000",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ActivityDayRow {
            day: r.get(0)?,
            app: r.get(1)?,
            project: r.get(2)?,
            secs: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// Mark day aggregates as synced after the Worker accepts them.
pub fn mark_activity_synced(conn: &Connection, rows: &[(String, String, String)]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (day, app, project) in rows {
        tx.execute(
            "UPDATE activity_day SET synced = 1
              WHERE day = ?1 AND app = ?2 AND project = ?3",
            params![day, app, project],
        )?;
    }
    tx.commit()
}

/// Re-queue all day aggregates (endpoint change).
pub fn reset_activity_synced(conn: &Connection) -> rusqlite::Result<usize> {
    Ok(conn.execute("UPDATE activity_day SET synced = 0 WHERE synced = 1", [])?)
}

/// Seconds per app today, busiest first (local day).
#[allow(dead_code)] // Available for tray/settings drill-down; tray uses by_project today.
pub fn today_by_app(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<Vec<(String, i64)>> {
    let day_start = local_day_start(now);
    let mut stmt = conn.prepare(
        "SELECT app, SUM(secs) AS total
           FROM activity
          WHERE ts_utc >= ?1 AND app <> ''
          GROUP BY app
          ORDER BY total DESC",
    )?;
    let rows = stmt.query_map(params![fmt(day_start)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

/// Top privacy-safe contexts today (domains / document names), busiest first.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn today_by_context(
    conn: &Connection,
    now: DateTime<Utc>,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let day_start = local_day_start(now);
    let mut stmt = conn.prepare(
        "SELECT context, SUM(secs) AS total
           FROM activity
          WHERE ts_utc >= ?1 AND context <> ''
          GROUP BY context
          ORDER BY total DESC",
    )?;
    let rows = stmt.query_map(params![fmt(day_start)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

/// Unassigned apps with enough time to be worth a Settings nudge
/// (≥ 30 minutes all-time). Excludes already-assigned and ignored apps.
pub fn suggest_assignments(
    conn: &Connection,
    rules: &crate::rules::Rules,
    limit: usize,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT app, SUM(secs) AS total
           FROM activity
          WHERE app <> ''
          GROUP BY app
          HAVING total >= 1800
          ORDER BY total DESC
          LIMIT 40",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (app, secs) = row?;
        if rules.assigned(&app).is_some() || rules.is_ignored(&app) {
            continue;
        }
        out.push((app, secs));
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Seconds attributed to each project during the local calendar day containing
/// `now`, busiest first. Powers the tray's "Today by project" breakdown.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn today_by_project(
    conn: &Connection,
    now: DateTime<Utc>,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let day_start = local_day_start(now);
    let mut stmt = conn.prepare(
        "SELECT project, SUM(secs) AS total
           FROM activity
          WHERE ts_utc >= ?1
          GROUP BY project
          ORDER BY total DESC",
    )?;
    let rows = stmt.query_map(params![fmt(day_start)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

/// Distinct apps ever seen, busiest first, capped at `limit`. Powers the
/// Settings → Projects list so the user assigns real apps, not typed guesses.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn apps_seen(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT app, SUM(secs) AS total
           FROM activity
          WHERE app <> ''
          GROUP BY app
          ORDER BY total DESC
          LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Completed sessions not yet acknowledged by the Worker.
pub fn unsynced(conn: &Connection) -> rusqlite::Result<Vec<Session>> {
    let mut stmt = conn.prepare(
        "SELECT id, start_utc, end_utc, start_reason, end_reason
           FROM sessions
          WHERE end_utc IS NOT NULL AND synced = 0
          ORDER BY start_utc",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Session {
            id: r.get(0)?,
            start_utc: r.get(1)?,
            end_utc: r.get(2)?,
            start_reason: r.get(3)?,
            end_reason: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Mark the given session ids as synced (called only after an HTTP 2xx).
pub fn mark_synced(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        tx.execute("UPDATE sessions SET synced = 1 WHERE id = ?1", params![id])?;
    }
    tx.commit()
}

/// Clear the synced flag on every session, re-queuing them all for upload.
/// Returns the number of rows reset. Used when the sync endpoint changes so a
/// new Worker receives the full history (the flag is endpoint-agnostic).
pub fn reset_synced(conn: &Connection) -> rusqlite::Result<usize> {
    Ok(conn.execute("UPDATE sessions SET synced = 0 WHERE synced = 1", [])?)
}

/// Read a value from the `meta` key/value table (None if unset).
pub fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
        r.get(0)
    })
    .optional()
}

/// Upsert a value into the `meta` key/value table.
pub fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn clock_in_is_idempotent_while_open() {
        let c = mem();
        assert!(clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap());
        // Second clock-in while already open does nothing.
        assert!(!clock_in(&c, "unlock", t("2026-06-29T10:05:00Z")).unwrap());
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert!(open_session_start(&c).unwrap().is_some());
    }

    #[test]
    fn clock_out_closes_and_is_idempotent() {
        let c = mem();
        clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap();
        assert_eq!(
            clock_out(&c, "lock", t("2026-06-29T18:00:00Z")).unwrap(),
            ClockOut::Closed
        );
        assert!(open_session_start(&c).unwrap().is_none());
        // Second clock-out with nothing open is a no-op.
        assert_eq!(
            clock_out(&c, "suspend", t("2026-06-29T18:05:00Z")).unwrap(),
            ClockOut::None
        );
        let (end, reason): (String, String) = c
            .query_row(
                "SELECT end_utc, end_reason FROM sessions LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(reason, "lock");
        assert_eq!(parse(&end), t("2026-06-29T18:00:00Z"));
    }

    #[test]
    fn clock_out_drops_zero_length_session() {
        // The 10:24 blip: an automatic wake clocks in on `resume`, then the
        // machine re-locks in the same instant. No time elapsed, so the session
        // is discarded outright rather than left as a 0-second row.
        let c = mem();
        clock_in(&c, "resume", t("2026-07-07T10:24:16Z")).unwrap();
        assert_eq!(
            clock_out(&c, "lock", t("2026-07-07T10:24:16Z")).unwrap(),
            ClockOut::DroppedEmpty
        );
        assert!(open_session_start(&c).unwrap().is_none());
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        assert!(unsynced(&c).unwrap().is_empty());
    }

    #[test]
    fn crash_recovery_closes_open_session_at_last_alive() {
        let c = mem();
        clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap();
        heartbeat(&c, t("2026-06-29T12:34:00Z")).unwrap();
        assert!(recover_crashed(&c, t("2026-06-30T09:00:00Z")).unwrap());
        let (end, reason): (String, String) = c
            .query_row(
                "SELECT end_utc, end_reason FROM sessions LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(reason, "crash");
        assert_eq!(parse(&end), t("2026-06-29T12:34:00Z"));
    }

    #[test]
    fn no_recovery_when_all_closed() {
        let c = mem();
        clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap();
        clock_out(&c, "lock", t("2026-06-29T11:00:00Z")).unwrap();
        assert!(!recover_crashed(&c, t("2026-06-29T12:00:00Z")).unwrap());
    }

    #[test]
    fn unsynced_lists_only_completed_and_mark_clears() {
        let c = mem();
        clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap();
        clock_out(&c, "lock", t("2026-06-29T11:00:00Z")).unwrap();
        clock_in(&c, "unlock", t("2026-06-29T12:00:00Z")).unwrap(); // still open
        let pending = unsynced(&c).unwrap();
        assert_eq!(pending.len(), 1);
        let ids: Vec<String> = pending.iter().map(|s| s.id.clone()).collect();
        mark_synced(&c, &ids).unwrap();
        assert_eq!(unsynced(&c).unwrap().len(), 0);
    }

    #[test]
    fn reset_synced_requeues_all_completed_sessions() {
        let c = mem();
        // Two completed sessions, both marked synced (as if pushed to a Worker).
        clock_in(&c, "resume", t("2026-06-29T10:00:00Z")).unwrap();
        clock_out(&c, "lock", t("2026-06-29T11:00:00Z")).unwrap();
        clock_in(&c, "unlock", t("2026-06-29T12:00:00Z")).unwrap();
        clock_out(&c, "lock", t("2026-06-29T13:00:00Z")).unwrap();
        let ids: Vec<String> = unsynced(&c).unwrap().iter().map(|s| s.id.clone()).collect();
        mark_synced(&c, &ids).unwrap();
        assert_eq!(unsynced(&c).unwrap().len(), 0);

        // Switching endpoints re-queues both for the new Worker.
        assert_eq!(reset_synced(&c).unwrap(), 2);
        assert_eq!(unsynced(&c).unwrap().len(), 2);
        // Second reset is a no-op (nothing left marked synced).
        assert_eq!(reset_synced(&c).unwrap(), 0);
    }

    #[test]
    fn meta_get_set_round_trips_and_overwrites() {
        let c = mem();
        assert_eq!(meta_get(&c, "synced_endpoint").unwrap(), None);
        meta_set(&c, "synced_endpoint", "https://a.example").unwrap();
        assert_eq!(
            meta_get(&c, "synced_endpoint").unwrap().as_deref(),
            Some("https://a.example")
        );
        meta_set(&c, "synced_endpoint", "https://b.example").unwrap();
        assert_eq!(
            meta_get(&c, "synced_endpoint").unwrap().as_deref(),
            Some("https://b.example")
        );
    }

    #[test]
    fn today_by_project_sums_and_orders_todays_activity() {
        let c = mem();
        let now = Utc::now();
        // Two Coding samples and one Email sample, all "today".
        record_activity(&c, now, "code.exe", "main.rs", "Coding", 60).unwrap();
        record_activity(&c, now, "code.exe", "db.rs", "Coding", 60).unwrap();
        record_activity(&c, now, "outlook.exe", "Inbox", "Email", 60).unwrap();
        // A sample from two days ago must be excluded from "today".
        record_activity(
            &c,
            now - chrono::Duration::days(2),
            "code.exe",
            "old",
            "Coding",
            3600,
        )
        .unwrap();

        let breakdown = today_by_project(&c, now).unwrap();
        assert_eq!(
            breakdown,
            vec![("Coding".to_string(), 120), ("Email".to_string(), 60)]
        );
    }

    #[test]
    fn apps_seen_lists_distinct_apps_busiest_first() {
        let c = mem();
        let now = Utc::now();
        record_activity(&c, now, "code.exe", "a", "Coding", 60).unwrap();
        record_activity(&c, now, "code.exe", "b", "Coding", 60).unwrap();
        record_activity(&c, now, "chrome.exe", "c", "Browsing", 60).unwrap();
        record_activity(&c, now, "", "no-app", "X", 999).unwrap(); // blank app excluded

        assert_eq!(
            apps_seen(&c, 10).unwrap(),
            vec!["code.exe".to_string(), "chrome.exe".to_string()]
        );
        // Limit is honored (busiest kept).
        assert_eq!(apps_seen(&c, 1).unwrap(), vec!["code.exe".to_string()]);
    }

    #[test]
    fn prune_activity_drops_old_rows() {
        let c = mem();
        let now = Utc::now();
        record_activity(&c, now, "code.exe", "", "Coding", 60).unwrap();
        record_activity(
            &c,
            now - chrono::Duration::days(120),
            "old.exe",
            "",
            "Old",
            60,
        )
        .unwrap();
        let n = prune_activity(&c, now, 90).unwrap();
        assert!(n >= 1);
        assert_eq!(today_by_project(&c, now).unwrap(), vec![("Coding".into(), 60)]);
    }

    #[test]
    fn activity_day_aggregates_and_unsynced() {
        let c = mem();
        let now = Utc::now();
        record_activity(&c, now, "code.exe", "secret", "Coding", 60).unwrap();
        record_activity(&c, now, "code.exe", "other", "Coding", 30).unwrap();
        let pending = unsynced_activity(&c).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].app, "code.exe");
        assert_eq!(pending[0].project, "Coding");
        assert_eq!(pending[0].secs, 90);
        // Titles never appear in the sync payload.
        let keys = vec![(
            pending[0].day.clone(),
            pending[0].app.clone(),
            pending[0].project.clone(),
        )];
        mark_activity_synced(&c, &keys).unwrap();
        assert!(unsynced_activity(&c).unwrap().is_empty());
    }

    #[test]
    fn today_by_context_groups_domains() {
        let c = mem();
        let now = Utc::now();
        record_activity_full(&c, now, "chrome.exe", "", "github.com", "Coding", 120).unwrap();
        record_activity_full(&c, now, "chrome.exe", "", "github.com", "Coding", 60).unwrap();
        record_activity_full(&c, now, "chrome.exe", "", "news.ycombinator.com", "Browsing", 30)
            .unwrap();
        let ctx = today_by_context(&c, now).unwrap();
        assert_eq!(ctx[0], ("github.com".into(), 180));
        assert_eq!(ctx[1], ("news.ycombinator.com".into(), 30));
    }
}
