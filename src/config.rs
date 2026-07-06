//! User configuration: `%APPDATA%\clocked\config.toml`.
//! Holds the Cloudflare Worker sync endpoint and the shared bearer token.

use chrono::{DateTime, Datelike, Local, NaiveTime, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl Default for Config {
    fn default() -> Self {
        Config {
            worker_url: String::new(),
            bearer_token: String::new(),
            idle_timeout_secs: default_idle_timeout_secs(),
            target_hours: default_target_hours(),
            work_start: default_work_start(),
            work_end: default_work_end(),
            work_days: default_work_days(),
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

const TEMPLATE: &str = "\
# clocked configuration
# Fill these in to enable syncing sessions to your Cloudflare Worker.
# Leave blank to run in local-only mode (no sync, no monthly email).

worker_url   = \"\"   # e.g. https://clocked-worker.<subdomain>.workers.dev
bearer_token = \"\"   # must match the BEARER_TOKEN secret set on the Worker

# Auto clock-out after this many idle seconds (no keyboard/mouse). 0 disables.
idle_timeout_secs = 900

# Daily goal in hours, shown in the tray. 0 hides it. Fractions allowed (e.g. 7.5).
target_hours = 8

# Working hours. If you open the computer (wake/unlock/launch) outside these,
# clocked asks whether you're working before it starts tracking. Blank
# work_start/work_end (or empty work_days) disables the prompt. Overnight
# windows are allowed (e.g. work_start = \"22:00\", work_end = \"06:00\").
work_start = \"09:00\"
work_end   = \"17:00\"
work_days  = [\"Mon\", \"Tue\", \"Wed\", \"Thu\", \"Fri\"]
";

impl Config {
    /// Load config, writing a commented template on first run if none exists.
    pub fn load() -> Config {
        let Some(path) = crate::paths::config_file() else {
            return Config::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).unwrap_or_default(),
            Err(_) => {
                let _ = std::fs::write(&path, TEMPLATE);
                Config::default()
            }
        }
    }

    /// True once both the endpoint and token are set.
    pub fn is_configured(&self) -> bool {
        !self.worker_url.trim().is_empty() && !self.bearer_token.trim().is_empty()
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
}
