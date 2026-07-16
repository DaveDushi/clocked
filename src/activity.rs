//! In-memory foreground segment accumulator.
//!
//! Tracks the currently focused app continuously and flushes elapsed seconds
//! to SQLite when the focus changes, on idle, on clock-out, or on a periodic
//! tick. Much more accurate than attributing a fixed minute every heartbeat.
//!
//! Segments are keyed by (app, project, context) so switching GitHub → Gmail in
//! Chrome, or main.rs → README in VS Code, becomes separate attribution.

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::privacy::{self, PRIVATE_PROJECT};
use crate::rules::Rules;

/// Open focus segment waiting to be flushed to the DB.
#[derive(Debug, Clone)]
struct OpenSeg {
    app: String,
    title: String,
    context: String,
    project: String,
    started: DateTime<Utc>,
}

/// Mutable tracker owned by the UI layer.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    open: Option<OpenSeg>,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self { open: None }
    }

    /// Observe the current foreground window. Flushes a previous segment when
    /// the classified (app, project, context) key changes.
    ///
    /// `context_override` (e.g. domain from the browser extension) wins over
    /// title-bar heuristics when non-empty.
    pub fn observe(
        &mut self,
        conn: &Connection,
        rules: &Rules,
        store_titles: bool,
        active: bool,
        now: DateTime<Utc>,
        app: &str,
        raw_title: &str,
        own_exe: &str,
        context_override: Option<&str>,
    ) {
        if !active {
            self.flush(conn, now);
            return;
        }

        let app = app.trim().to_ascii_lowercase();
        if app.is_empty() || app == own_exe.trim().to_ascii_lowercase() {
            // Don't pin time on our own UI, but keep any prior segment open so a
            // brief tray open doesn't split the previous app incorrectly.
            return;
        }

        // Prefer extension domain (accurate); fall back to title-bar heuristics.
        let context = context_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| crate::context::extract_label(&app, raw_title));
        let project = if rules.is_ignored(&app) {
            "Non-work".to_string()
        } else if privacy::is_private_app(&app) && rules.assigned(&app).is_none() {
            PRIVATE_PROJECT.to_string()
        } else {
            rules.classify_with_context(&app, raw_title, &context)
        };
        let title = privacy::title_for_storage(&app, raw_title, store_titles);

        match &self.open {
            Some(seg)
                if seg.app == app && seg.project == project && seg.context == context =>
            {
                if !title.is_empty() && seg.title != title {
                    if let Some(s) = self.open.as_mut() {
                        s.title = title;
                    }
                }
            }
            Some(_) => {
                self.flush(conn, now);
                self.open = Some(OpenSeg {
                    app,
                    title,
                    context,
                    project,
                    started: now,
                });
            }
            None => {
                self.open = Some(OpenSeg {
                    app,
                    title,
                    context,
                    project,
                    started: now,
                });
            }
        }
    }

    /// End the current segment and write elapsed seconds (min 1s if any).
    pub fn flush(&mut self, conn: &Connection, now: DateTime<Utc>) {
        let Some(seg) = self.open.take() else {
            return;
        };
        let secs = (now - seg.started).num_seconds();
        if secs < 1 {
            return;
        }
        if let Err(e) = crate::db::record_activity_full(
            conn,
            seg.started,
            &seg.app,
            &seg.title,
            &seg.context,
            &seg.project,
            secs,
        ) {
            crate::logln!("record_activity error: {e}");
        }
    }

    /// Periodic compact flush: write elapsed so far but keep the segment open
    /// from `now` so a crash only loses a few seconds.
    pub fn checkpoint(&mut self, conn: &Connection, now: DateTime<Utc>) {
        let Some(seg) = self.open.as_mut() else {
            return;
        };
        let secs = (now - seg.started).num_seconds();
        if secs < 30 {
            return;
        }
        if let Err(e) = crate::db::record_activity_full(
            conn,
            seg.started,
            &seg.app,
            &seg.title,
            &seg.context,
            &seg.project,
            secs,
        ) {
            crate::logln!("record_activity error: {e}");
            return;
        }
        seg.started = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::collections::BTreeMap;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::init_schema(&c).unwrap();
        c
    }

    fn rules() -> Rules {
        let mut assignments = BTreeMap::new();
        assignments.insert("code.exe".into(), "Coding".into());
        Rules {
            default_project: String::new(),
            assignments,
            ignore: Default::default(),
            title_rules: vec![crate::rules::TitleRule {
                contains: "github.com".into(),
                project: "Open Source".into(),
            }],
        }
    }

    #[test]
    fn switch_flushes_previous_segment() {
        let c = mem();
        let r = rules();
        let mut t = ActivityTracker::new();
        let t0 = Utc::now() - chrono::Duration::seconds(180);
        let t1 = t0 + chrono::Duration::seconds(120);
        let t2 = t1 + chrono::Duration::seconds(60);

        t.observe(&c, &r, false, true, t0, "code.exe", "a.rs", "clocked.exe", None);
        t.observe(&c, &r, false, true, t1, "chrome.exe", "News", "clocked.exe", None);
        t.flush(&c, t2);

        let by = db::today_by_project(&c, t2).unwrap();
        assert!(by.iter().any(|(p, s)| p == "Coding" && *s == 120));
        assert!(by.iter().any(|(p, s)| p == "Chrome" && *s == 60));
    }

    #[test]
    fn browser_domain_rule_classifies_and_stores_context() {
        let c = mem();
        let r = rules();
        let mut t = ActivityTracker::new();
        let t0 = Utc::now() - chrono::Duration::seconds(90);
        t.observe(
            &c,
            &r,
            false,
            true,
            t0,
            "chrome.exe",
            "PR · github.com - Google Chrome",
            "clocked.exe",
            None,
        );
        t.flush(&c, t0 + chrono::Duration::seconds(90));
        let by = db::today_by_project(&c, t0 + chrono::Duration::seconds(90)).unwrap();
        assert!(
            by.iter().any(|(p, s)| p == "Open Source" && *s == 90),
            "got {by:?}"
        );
        let ctx = db::today_by_context(&c, t0 + chrono::Duration::seconds(90)).unwrap();
        assert!(
            ctx.iter().any(|(c, s)| c == "github.com" && *s == 90),
            "got {ctx:?}"
        );
    }

    #[test]
    fn extension_override_wins_for_domain() {
        let c = mem();
        let r = rules();
        let mut t = ActivityTracker::new();
        let t0 = Utc::now() - chrono::Duration::seconds(60);
        // Title has no domain, but extension reports github.com.
        t.observe(
            &c,
            &r,
            false,
            true,
            t0,
            "chrome.exe",
            "Pull requests",
            "clocked.exe",
            Some("github.com"),
        );
        t.flush(&c, t0 + chrono::Duration::seconds(60));
        let ctx = db::today_by_context(&c, t0 + chrono::Duration::seconds(60)).unwrap();
        assert_eq!(ctx, vec![("github.com".into(), 60)]);
        let by = db::today_by_project(&c, t0 + chrono::Duration::seconds(60)).unwrap();
        assert!(by.iter().any(|(p, _)| p == "Open Source"));
    }

    #[test]
    fn inactive_flushes_without_new_segment() {
        let c = mem();
        let r = rules();
        let mut t = ActivityTracker::new();
        let t0 = Utc::now() - chrono::Duration::seconds(90);
        t.observe(&c, &r, false, true, t0, "code.exe", "", "clocked.exe", None);
        t.observe(
            &c,
            &r,
            false,
            false,
            t0 + chrono::Duration::seconds(90),
            "code.exe",
            "",
            "clocked.exe",
            None,
        );
        let by = db::today_by_project(&c, t0 + chrono::Duration::seconds(90)).unwrap();
        assert_eq!(by, vec![("Coding".into(), 90)]);
        assert!(t.open.is_none());
    }
}
