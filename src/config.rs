//! User configuration: `%APPDATA%\clocked\config.toml`.
//! Holds the Cloudflare Worker sync endpoint and bearer token.

use chrono::{DateTime, Datelike, Local, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};

pub const DEFAULT_WORKER_URL: &str = "https://clocked.daviddusi.com";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub worker_url: String,
    #[serde(default)]
    pub bearer_token: String,
    /// Auto clock-out after this many seconds without keyboard/mouse input.
    /// `0` disables idle detection. Defaults to 15 minutes.
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    /// Daily goal in hours, shown in the tray tooltip/menu. `0` hides the goal.
    #[serde(default = "default_target_hours")]
    pub target_hours: f64,
    /// Local start of the working day as `"HH:MM"`. Blank disables the
    /// after-hours "are you working?" prompt.
    #[serde(default = "default_work_start")]
    pub work_start: String,
    /// Local end of the working day as `"HH:MM"`. Blank disables the prompt.
    #[serde(default = "default_work_end")]
    pub work_end: String,
    /// Working weekdays (names or 1=Mon..7=Sun). Days outside this set count as
    /// after-hours.
    #[serde(default = "default_work_days")]
    pub work_days: Vec<String>,
    /// When true, store a *sanitized* window title with each activity sample.
    /// Default false — only the app name is recorded (recommended).
    #[serde(default)]
    pub store_titles: bool,
    /// Delete local activity samples older than this many days. Floor of 7.
    #[serde(default = "default_activity_retention_days")]
    pub activity_retention_days: i64,
}

fn default_idle_timeout_secs() -> u64 {
    900
}

fn default_target_hours() -> f64 {
    8.0
}

fn default_work_start() -> String {
    "09:00".to_string()
}

fn default_work_end() -> String {
    "17:00".to_string()
}

fn default_work_days() -> Vec<String> {
    ["Mon", "Tue", "Wed", "Thu", "Fri"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn default_activity_retention_days() -> i64 {
    crate::privacy::DEFAULT_RETENTION_DAYS
}

impl Default for Config {
    fn default() -> Self {
        Config {
            worker_url: DEFAULT_WORKER_URL.to_string(),
            bearer_token: String::new(),
            idle_timeout_secs: default_idle_timeout_secs(),
            target_hours: default_target_hours(),
            work_start: default_work_start(),
            work_end: default_work_end(),
            work_days: default_work_days(),
            store_titles: false,
            activity_retention_days: default_activity_retention_days(),
        }
    }
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    match s.trim().to_ascii_lowercase().as_str() {
        "mon" | "monday" | "1" => Some(Weekday::Mon),
        "tue" | "tues" | "tuesday" | "2" => Some(Weekday::Tue),
        "wed" | "weds" | "wednesday" | "3" => Some(Weekday::Wed),
        "thu" | "thur" | "thurs" | "thursday" | "4" => Some(Weekday::Thu),
        "fri" | "friday" | "5" => Some(Weekday::Fri),
        "sat" | "saturday" | "6" => Some(Weekday::Sat),
        "sun" | "sunday" | "7" => Some(Weekday::Sun),
        _ => None,
    }
}

/// Escape a value for a TOML basic (double-quoted) string.
fn escape_toml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

impl Config {
    /// Load config, writing a commented default on first run if none exists.
    /// The bearer token is loaded from DPAPI storage (`token.dpapi`), with a
    /// one-time migration from legacy plaintext `bearer_token` in config.toml.
    pub fn load() -> Config {
        let Some(path) = crate::paths::config_file() else {
            return Config::default();
        };
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).unwrap_or_default(),
            Err(_) => {
                let cfg = Config::default();
                let _ = std::fs::write(&path, cfg.to_toml());
                cfg
            }
        };

        let dpapi = crate::secret::load_token();
        if !dpapi.is_empty() {
            cfg.bearer_token = dpapi;
        } else if !cfg.bearer_token.trim().is_empty() {
            // Migrate legacy plaintext token out of config.toml into DPAPI.
            if crate::secret::save_token(&cfg.bearer_token).is_ok() {
                let _ = cfg.save(); // rewrites toml without the secret
            }
        }
        cfg
    }

    /// Render the config as a commented `config.toml` (the on-disk format the
    /// Settings page writes; still hand-editable). Bearer token is NOT written
    /// here — it is stored via DPAPI (`token.dpapi`).
    pub fn to_toml(&self) -> String {
        let days = self
            .work_days
            .iter()
            .map(|d| format!("\"{}\"", escape_toml(d)))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "# clocked configuration\n\
             # Managed by the tray Settings page, but safe to edit by hand.\n\
             # Worker URL defaults to https://clocked.daviddusi.com and is usually hidden in Advanced settings.\n\
             # The bearer token is stored separately (DPAPI-protected token.dpapi), not in this file.\n\
             \n\
             worker_url   = \"{worker_url}\"\n\
             \n\
             # Auto clock-out after this many idle seconds (no keyboard/mouse). 0 disables.\n\
             idle_timeout_secs = {idle}\n\
             \n\
             # Daily goal in hours, shown in the tray. 0 hides it. Fractions allowed.\n\
             target_hours = {target}\n\
             \n\
             # Working hours. Opening the computer outside these prompts \"Are you working?\".\n\
             # Blank work_start/work_end (or no work_days) disables the prompt. Overnight OK.\n\
             work_start = \"{work_start}\"\n\
             work_end   = \"{work_end}\"\n\
             work_days  = [{days}]\n\
             \n\
             # App tracking privacy. Default: record which app was focused, never the window title.\n\
             # store_titles = true keeps a sanitized title (emails/numbers redacted) locally only.\n\
             store_titles = {store_titles}\n\
             # Delete local activity samples older than this many days (minimum 7).\n\
             activity_retention_days = {retention}\n",
            worker_url = escape_toml(&self.worker_url),
            idle = self.idle_timeout_secs,
            target = self.target_hours,
            work_start = escape_toml(&self.work_start),
            work_end = escape_toml(&self.work_end),
            days = days,
            store_titles = self.store_titles,
            retention = self.activity_retention_days.max(7),
        )
    }

    /// Write non-secret config to `config.toml` and the bearer token to DPAPI.
    pub fn save(&self) -> std::io::Result<()> {
        let path = crate::paths::config_file().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir")
        })?;
        std::fs::write(path, self.to_toml())?;
        crate::secret::save_token(&self.bearer_token)?;
        Ok(())
    }

    /// True once both the endpoint and token are set.
    pub fn is_configured(&self) -> bool {
        !self.effective_worker_url().is_empty() && !self.bearer_token.trim().is_empty()
    }

    /// Sync endpoint to use. Empty configs and the old local-dev default fall
    /// back to the hosted clocked domain; advanced settings can still override
    /// this with another non-local URL.
    pub fn effective_worker_url(&self) -> &str {
        let url = self.worker_url.trim();
        if url.is_empty() || is_local_dev_url(url) {
            DEFAULT_WORKER_URL
        } else {
            url
        }
    }

    /// Whether `now` falls inside the configured working hours.
    /// `None` = the feature is disabled (blank/invalid times or no work days).
    /// Handles overnight windows where `work_start > work_end` (e.g. 22:00–06:00).
    pub fn within_working_hours(&self, now: DateTime<Local>) -> Option<bool> {
        let start = NaiveTime::parse_from_str(self.work_start.trim(), "%H:%M").ok()?;
        let end = NaiveTime::parse_from_str(self.work_end.trim(), "%H:%M").ok()?;
        let days: Vec<Weekday> = self.work_days.iter().filter_map(|d| parse_weekday(d)).collect();
        if days.is_empty() {
            return None;
        }
        let t = now.time();
        let day_ok = days.contains(&now.weekday());
        let time_ok = if start <= end {
            t >= start && t < end
        } else {
            t >= start || t < end
        };
        Some(day_ok && time_ok)
    }
}

fn is_local_dev_url(url: &str) -> bool {
    matches!(
        url.trim_end_matches('/'),
        "http://localhost:8787" | "http://127.0.0.1:8787" | "http://[::1]:8787"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // 2024-01-01 is a Monday; 2024-01-06 a Saturday.
    fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    #[test]
    fn working_hours_default_window() {
        let c = Config::default(); // 09:00–17:00, Mon–Fri
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 10, 0)), Some(true));
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 8, 59)), Some(false));
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 17, 0)), Some(false)); // end exclusive
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 20, 0)), Some(false));
        assert_eq!(c.within_working_hours(local(2024, 1, 6, 10, 0)), Some(false)); // Saturday
    }

    #[test]
    fn working_hours_disabled_when_blank_or_no_days() {
        let mut c = Config::default();
        c.work_start = String::new();
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 10, 0)), None);

        let mut c = Config::default();
        c.work_days = vec![];
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 10, 0)), None);
    }

    #[test]
    fn working_hours_overnight_window_wraps() {
        let mut c = Config::default();
        c.work_start = "22:00".to_string();
        c.work_end = "06:00".to_string();
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 23, 0)), Some(true));
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 5, 0)), Some(true));
        assert_eq!(c.within_working_hours(local(2024, 1, 1, 12, 0)), Some(false));
    }

    #[test]
    fn to_toml_round_trips_non_secret_fields() {
        let c = Config {
            worker_url: "https://ex.workers.dev".to_string(),
            bearer_token: "s3cr3t".to_string(), // not written to toml
            idle_timeout_secs: 600,
            target_hours: 7.5,
            work_start: "08:30".to_string(),
            work_end: "16:30".to_string(),
            work_days: vec!["Mon".into(), "Wed".into(), "Fri".into()],
            store_titles: true,
            activity_retention_days: 60,
        };
        let reloaded: Config = toml::from_str(&c.to_toml()).unwrap();
        assert_eq!(reloaded.worker_url, c.worker_url);
        assert_eq!(reloaded.idle_timeout_secs, c.idle_timeout_secs);
        assert_eq!(reloaded.target_hours, c.target_hours);
        assert_eq!(reloaded.work_start, c.work_start);
        assert_eq!(reloaded.work_end, c.work_end);
        assert_eq!(reloaded.work_days, c.work_days);
        assert_eq!(reloaded.store_titles, true);
        assert_eq!(reloaded.activity_retention_days, 60);
        assert!(reloaded.bearer_token.is_empty());
        assert!(!c.to_toml().contains("s3cr3t"));
        assert!(!c.to_toml().contains("bearer_token"));
    }

    #[test]
    fn default_worker_url_is_hosted_domain() {
        assert_eq!(Config::default().worker_url, DEFAULT_WORKER_URL);
        assert_eq!(Config::default().effective_worker_url(), DEFAULT_WORKER_URL);
    }

    #[test]
    fn old_local_dev_url_falls_back_to_hosted_domain() {
        let mut c = Config::default();
        c.worker_url = "http://localhost:8787/".to_string();
        c.bearer_token = "token".to_string();

        assert_eq!(c.effective_worker_url(), DEFAULT_WORKER_URL);
        assert!(c.is_configured());
    }
}
