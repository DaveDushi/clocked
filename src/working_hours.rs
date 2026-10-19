//! Managed schedules are cached separately so personal configuration survives removal.
use chrono::{DateTime, Datelike, NaiveTime, TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Config;

const CACHE_KEY: &str = "managed_working_hours";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum WorkingHours {
    Disabled,
    Scheduled {
        start: String,
        end: String,
        days: Vec<u32>,
    },
}

impl WorkingHours {
    fn valid(&self) -> bool {
        match self {
            Self::Disabled => true,
            Self::Scheduled { start, end, days } => {
                let valid_time = |time: &str| {
                    time.len() == 5 && NaiveTime::parse_from_str(time, "%H:%M").is_ok()
                };
                valid_time(start)
                    && valid_time(end)
                    && start != end
                    && !days.is_empty()
                    && days.len() <= 7
                    && days.iter().all(|day| (1..=7).contains(day))
                    && days
                        .iter()
                        .enumerate()
                        .all(|(i, day)| !days[..i].contains(day))
            }
        }
    }

    pub fn contains<T: TimeZone>(&self, now: DateTime<T>) -> Option<bool> {
        match self {
            Self::Disabled => None,
            Self::Scheduled { start, end, days } => {
                let start = NaiveTime::parse_from_str(start, "%H:%M").ok()?;
                let end = NaiveTime::parse_from_str(end, "%H:%M").ok()?;
                Some(contains_window(start, end, days, now))
            }
        }
    }
}

pub fn contains_window<T: TimeZone>(
    start: NaiveTime,
    end: NaiveTime,
    days: &[u32],
    now: DateTime<T>,
) -> bool {
    let time = now.time();
    let day = now.weekday().number_from_monday();
    // Working days name the day a shift starts, including its tail after midnight.
    let shift_day = if start > end && time < end {
        (day + 5) % 7 + 1
    } else {
        day
    };
    let inside = if start <= end {
        time >= start && time < end
    } else {
        time >= start || time < end
    };
    days.contains(&shift_day) && inside
}

#[derive(Serialize, Deserialize)]
struct CachedHours {
    account: String,
    schedule: Option<WorkingHours>,
}

fn account_key(cfg: &Config) -> String {
    let mut hash = Sha256::new();
    hash.update(cfg.effective_worker_url().trim_end_matches('/'));
    hash.update([0]);
    hash.update(cfg.bearer_token.as_bytes());
    format!("{:x}", hash.finalize())
}

pub fn cached(conn: &Connection, cfg: &Config) -> Option<WorkingHours> {
    if !cfg.is_configured() {
        return None;
    }
    let raw = crate::db::meta_get(conn, CACHE_KEY).ok()??;
    let cache: CachedHours = serde_json::from_str(&raw).ok()?;
    if cache.account != account_key(cfg) {
        return None;
    }
    cache.schedule.filter(WorkingHours::valid)
}

pub fn pull(
    client: &reqwest::blocking::Client,
    conn: &Connection,
    cfg: &Config,
) -> Result<usize, Box<dyn std::error::Error>> {
    if !cfg.is_configured() {
        return Ok(0);
    }
    let endpoint = cfg.effective_worker_url().trim_end_matches('/');
    let response = client
        .get(format!("{endpoint}/desktop/working-hours"))
        .bearer_auth(&cfg.bearer_token)
        .send()?;
    match response.status().as_u16() {
        404 => return Ok(0), // Older self-hosted Workers do not have this endpoint.
        401 | 403 => {
            conn.execute("DELETE FROM meta WHERE key = ?", [CACHE_KEY])?;
            return Err("working-hours access denied; cached assignment cleared".into());
        }
        _ => {}
    }
    let body: serde_json::Value = response.error_for_status()?.json()?;
    let schedule: Option<WorkingHours> = serde_json::from_value(
        body.get("schedule")
            .ok_or("working-hours response missing schedule")?
            .clone(),
    )?;
    if schedule.as_ref().is_some_and(|hours| !hours.valid()) {
        return Err("invalid working-hours schedule".into());
    }
    store(conn, cfg, schedule)
}

fn store(
    conn: &Connection,
    cfg: &Config,
    schedule: Option<WorkingHours>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let value = serde_json::to_string(&CachedHours {
        account: account_key(cfg),
        schedule,
    })?;
    if crate::db::meta_get(conn, CACHE_KEY)?.as_deref() == Some(&value) {
        return Ok(0);
    }
    crate::db::meta_set(conn, CACHE_KEY, &value)?;
    Ok(1)
}

#[cfg(test)]
pub(crate) fn assign_for_test(conn: &Connection, cfg: &Config, hours: Option<WorkingHours>) {
    store(conn, cfg, hours).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn schedule(start: &str, end: &str, days: &[u32]) -> WorkingHours {
        WorkingHours::Scheduled {
            start: start.into(),
            end: end.into(),
            days: days.into(),
        }
    }

    #[test]
    fn overnight_uses_the_shift_start_day_and_excludes_end() {
        let hours = schedule("22:00", "06:00", &[5]);
        let tz = FixedOffset::east_opt(0).unwrap();
        let at = |day, hour| tz.with_ymd_and_hms(2026, 10, day, hour, 0, 0).unwrap();
        assert_eq!(hours.contains(at(23, 23)), Some(true));
        assert_eq!(hours.contains(at(24, 5)), Some(true));
        assert_eq!(hours.contains(at(24, 6)), Some(false));
        assert_eq!(hours.contains(at(23, 5)), Some(false));
        assert_eq!(hours.contains(at(25, 5)), Some(false));
    }

    #[test]
    fn daytime_boundaries_and_disabled_prompt() {
        let hours = schedule("09:00", "17:00", &[1]);
        let tz = FixedOffset::east_opt(2 * 3600).unwrap();
        let at = |hour| tz.with_ymd_and_hms(2026, 10, 19, hour, 0, 0).unwrap();
        assert_eq!(hours.contains(at(8)), Some(false));
        assert_eq!(hours.contains(at(9)), Some(true));
        assert_eq!(hours.contains(at(17)), Some(false));
        assert_eq!(WorkingHours::Disabled.contains(at(8)), None);
    }

    #[test]
    fn cache_is_scoped_to_endpoint_and_token_and_removal_restores_personal_hours() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let cfg = Config {
            bearer_token: "clk_test_token_one".into(),
            ..Config::default()
        };
        let personal = cfg.clone();
        let hours = schedule("12:00", "20:00", &[1, 2]);
        assert_eq!(store(&conn, &cfg, Some(hours.clone())).unwrap(), 1);
        assert_eq!(store(&conn, &cfg, Some(hours.clone())).unwrap(), 0);
        assert_eq!(cached(&conn, &cfg), Some(hours));
        let different = Config {
            bearer_token: "clk_test_token_two".into(),
            ..cfg.clone()
        };
        assert_eq!(cached(&conn, &different), None);
        let different = Config {
            worker_url: "https://another.example".into(),
            ..cfg.clone()
        };
        assert_eq!(cached(&conn, &different), None);
        store(&conn, &cfg, Some(WorkingHours::Disabled)).unwrap();
        assert_eq!(cached(&conn, &cfg), Some(WorkingHours::Disabled));
        store(&conn, &cfg, None).unwrap();
        assert_eq!(cached(&conn, &cfg), None);
        assert_eq!(cfg, personal);
    }

    #[test]
    fn invalid_schedules_are_rejected() {
        for hours in [
            schedule("99:00", "17:00", &[1]),
            schedule("09:00", "09:00", &[1]),
            schedule("09:00", "17:00", &[]),
            schedule("09:00", "17:00", &[0]),
            schedule("09:00", "17:00", &[1, 1]),
        ] {
            assert!(!hours.valid());
        }
    }

    fn fetch_response(conn: &Connection, base: &Config, status: u16, body: &str) -> (Config, bool) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let cfg = Config {
            worker_url: format!("http://{}", listener.local_addr().unwrap()),
            ..base.clone()
        };
        // Seed this server's policy, then simulate its next response.
        store(conn, &cfg, Some(WorkingHours::Disabled)).unwrap();
        let body = body.to_string();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..n]).to_ascii_lowercase();
            assert!(request.starts_with("get /desktop/working-hours "));
            assert!(request.contains("authorization: bearer clk_test_token_one"));
            write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let ok = pull(&client, conn, &cfg).is_ok();
        server.join().unwrap();
        (cfg, ok)
    }

    #[test]
    fn http_policy_refresh_preserves_cache_on_errors_and_clears_on_removal_or_denial() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let base = Config {
            bearer_token: "clk_test_token_one".into(),
            ..Config::default()
        };
        let (cfg, ok) = fetch_response(
            &conn,
            &base,
            200,
            r#"{"schedule":{"mode":"scheduled","start":"10:00","end":"14:00","days":[1,3,5]}}"#,
        );
        assert!(ok);
        assert_eq!(
            cached(&conn, &cfg),
            Some(schedule("10:00", "14:00", &[1, 3, 5]))
        );
        for (status, body) in [
            (500, "error"),
            (200, "{}"),
            (
                200,
                r#"{"schedule":{"mode":"scheduled","start":"25:00","end":"14:00","days":[1]}}"#,
            ),
        ] {
            let (cfg, ok) = fetch_response(&conn, &base, status, body);
            assert!(!ok);
            assert_eq!(cached(&conn, &cfg), Some(WorkingHours::Disabled));
        }
        let (cfg, ok) = fetch_response(&conn, &base, 404, "not found");
        assert!(ok);
        assert_eq!(cached(&conn, &cfg), Some(WorkingHours::Disabled));
        let (cfg, ok) = fetch_response(&conn, &base, 200, r#"{"schedule":null}"#);
        assert!(ok);
        assert_eq!(cached(&conn, &cfg), None);
        for status in [401, 403] {
            let (cfg, ok) = fetch_response(&conn, &base, status, "denied");
            assert!(!ok);
            assert_eq!(cached(&conn, &cfg), None);
        }
    }
}
