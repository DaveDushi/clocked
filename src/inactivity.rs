//! Account-scoped team inactivity policy, kept separately from personal settings.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::config::Config;

const CACHE_KEY: &str = "managed_inactivity";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InactivityPolicy {
    pub timeout_secs: u64,
    pub warning_secs: u64,
}

impl InactivityPolicy {
    fn valid(&self) -> bool {
        (60..=86400).contains(&self.timeout_secs) && self.warning_secs < self.timeout_secs
    }
}

#[derive(Serialize, Deserialize)]
struct CachedPolicy {
    account: String,
    policy: Option<InactivityPolicy>,
}

pub fn cached(conn: &Connection, cfg: &Config) -> Option<InactivityPolicy> {
    if !cfg.is_configured() {
        return None;
    }
    let raw = crate::db::meta_get(conn, CACHE_KEY).ok()??;
    let cache: CachedPolicy = serde_json::from_str(&raw).ok()?;
    if cache.account != crate::working_hours::account_key(cfg) {
        return None;
    }
    cache.policy.filter(InactivityPolicy::valid)
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
        .get(format!("{endpoint}/desktop/inactivity"))
        .bearer_auth(&cfg.bearer_token)
        .send()?;
    match response.status().as_u16() {
        404 => return Ok(0),
        401 | 403 => {
            conn.execute("DELETE FROM meta WHERE key = ?", [CACHE_KEY])?;
            return Err("inactivity access denied; cached assignment cleared".into());
        }
        _ => {}
    }
    let body: serde_json::Value = response.error_for_status()?.json()?;
    let policy: Option<InactivityPolicy> = serde_json::from_value(
        body.get("policy")
            .ok_or("inactivity response missing policy")?
            .clone(),
    )?;
    if policy.as_ref().is_some_and(|policy| !policy.valid()) {
        return Err("invalid inactivity policy".into());
    }
    store(conn, cfg, policy)
}

fn store(
    conn: &Connection,
    cfg: &Config,
    policy: Option<InactivityPolicy>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let value = serde_json::to_string(&CachedPolicy {
        account: crate::working_hours::account_key(cfg),
        policy,
    })?;
    if crate::db::meta_get(conn, CACHE_KEY)?.as_deref() == Some(&value) {
        return Ok(0);
    }
    crate::db::meta_set(conn, CACHE_KEY, &value)?;
    Ok(1)
}

#[cfg(test)]
pub(crate) fn assign_for_test(conn: &Connection, cfg: &Config, policy: Option<InactivityPolicy>) {
    store(conn, cfg, policy).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_survives_restart_but_is_scoped_to_account_and_reset() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let cfg = Config {
            bearer_token: "clk_team_member".into(),
            ..Config::default()
        };
        let policy = InactivityPolicy {
            timeout_secs: 1800,
            warning_secs: 300,
        };
        assign_for_test(&conn, &cfg, Some(policy));
        assert_eq!(cached(&conn, &cfg), Some(policy));
        assert_eq!(cfg.idle_timeout_secs, 900);
        let other = Config {
            bearer_token: "clk_other_member".into(),
            ..cfg.clone()
        };
        assert_eq!(cached(&conn, &other), None);
        let other = Config {
            worker_url: "https://other.example".into(),
            ..cfg.clone()
        };
        assert_eq!(cached(&conn, &other), None);
        assign_for_test(&conn, &cfg, None);
        assert_eq!(cached(&conn, &cfg), None);
    }

    #[test]
    fn http_refresh_applies_policy_preserves_offline_cache_and_clears_revoked_policy() {
        use std::io::{Read, Write};
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let old = InactivityPolicy {
            timeout_secs: 900,
            warning_secs: 120,
        };
        let new = InactivityPolicy {
            timeout_secs: 1800,
            warning_secs: 300,
        };
        for (status, body, success, expected) in [
            (
                200,
                r#"{"policy":{"timeout_secs":1800,"warning_secs":300}}"#,
                true,
                Some(new),
            ),
            (200, r#"{"policy":null}"#, true, None),
            (200, "{}", false, Some(old)),
            (
                200,
                r#"{"policy":{"timeout_secs":60,"warning_secs":60}}"#,
                false,
                Some(old),
            ),
            (500, "error", false, Some(old)),
            (404, "not found", true, Some(old)),
            (401, "denied", false, None),
            (403, "denied", false, None),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let cfg = Config {
                worker_url: format!("http://{}", listener.local_addr().unwrap()),
                bearer_token: "clk_test_member".into(),
                ..Config::default()
            };
            assign_for_test(&conn, &cfg, Some(old));
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]).to_ascii_lowercase();
                assert!(request.starts_with("get /desktop/inactivity "));
                assert!(request.contains("authorization: bearer clk_test_member"));
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap();
            assert_eq!(pull(&client, &conn, &cfg).is_ok(), success);
            server.join().unwrap();
            assert_eq!(cached(&conn, &cfg), expected);
        }
    }
}
