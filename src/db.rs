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
         CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced);",
    )?;
    Ok(())
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
    let local_now = now.with_timezone(&Local);
    let day_start_local = Local
        .with_ymd_and_hms(local_now.year(), local_now.month(), local_now.day(), 0, 0, 0)
        .single()
        .unwrap_or(local_now);
    let day_start = day_start_local.with_timezone(&Utc);

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
}
