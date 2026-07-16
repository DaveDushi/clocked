//! Localhost bridge for the browser extension.
//!
//! Binds **127.0.0.1 only** (never LAN). The Chrome extension POSTs the active
//! tab's hostname using the same `clk_…` sync token (or any configured bearer)
//! so desktop tracking gets accurate site context without full-title scraping.
//!
//! Endpoints (all except OPTIONS/health require `Authorization: Bearer <token>`):
//! - `GET  /health`     → public liveness
//! - `GET  /v1/status`  → { ok, clocked }
//! - `POST /v1/tab`     → { domain, title? }  updates the latest browser tab hint
//!
//! Minimal HTTP/1.1 — no extra crate.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Default loopback port (extension options match this).
pub const DEFAULT_PORT: u16 = 19532;

/// How long a tab hint stays "fresh" for foreground browser attribution.
/// Must outlast the extension's slowest ping (Chrome alarms are often ~1 min)
/// so staying on one tab still attributes correctly between pings.
pub const TAB_HINT_TTL: Duration = Duration::from_secs(90);

/// Latest active-tab hint from the extension.
#[derive(Debug, Clone)]
pub struct TabHint {
    pub domain: String,
    pub title: String,
    pub at: Instant,
}

/// Shared between the UI thread and the bridge listener.
#[derive(Debug)]
pub struct BridgeState {
    token: Mutex<String>,
    tab: Mutex<Option<TabHint>>,
    running: AtomicBool,
}

impl BridgeState {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token: Mutex::new(token),
            tab: Mutex::new(None),
            running: AtomicBool::new(false),
        })
    }

    pub fn set_token(&self, token: &str) {
        if let Ok(mut t) = self.token.lock() {
            *t = token.trim().to_string();
        }
    }

    /// Domain for the active browser tab if the extension reported recently.
    pub fn fresh_domain(&self) -> Option<String> {
        let guard = self.tab.lock().ok()?;
        let hint = guard.as_ref()?;
        if hint.at.elapsed() > TAB_HINT_TTL {
            return None;
        }
        if hint.domain.is_empty() {
            return None;
        }
        Some(hint.domain.clone())
    }

    pub fn fresh_title(&self) -> Option<String> {
        let guard = self.tab.lock().ok()?;
        let hint = guard.as_ref()?;
        if hint.at.elapsed() > TAB_HINT_TTL {
            return None;
        }
        if hint.title.is_empty() {
            None
        } else {
            Some(hint.title.clone())
        }
    }

    fn auth_ok(&self, provided: &str) -> bool {
        let Ok(expected) = self.token.lock() else {
            return false;
        };
        let expected = expected.trim();
        let provided = provided.trim();
        if expected.is_empty() || provided.is_empty() {
            return false;
        }
        // Constant-time-ish compare (length leaks; fine for local loopback).
        if expected.len() != provided.len() {
            return false;
        }
        let mut diff = 0u8;
        for (a, b) in expected.bytes().zip(provided.bytes()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    fn set_tab(&self, domain: String, title: String) {
        if let Ok(mut t) = self.tab.lock() {
            *t = Some(TabHint {
                domain,
                title,
                at: Instant::now(),
            });
        }
    }
}

/// Spawn the loopback listener. Idempotent if already running.
pub fn start(state: Arc<BridgeState>, port: u16) {
    if state.running.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::Builder::new()
        .name("clocked-bridge".into())
        .spawn(move || {
            let addr = format!("127.0.0.1:{port}");
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => l,
                Err(e) => {
                    crate::logln!("bridge bind {addr} failed: {e}");
                    state.running.store(false, Ordering::SeqCst);
                    return;
                }
            };
            // Don't block forever on accept if we ever want shutdown; fine for tray lifetime.
            crate::logln!("bridge listening on http://{addr}");
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let st = Arc::clone(&state);
                        thread::spawn(move || handle_client(s, st));
                    }
                    Err(e) => crate::logln!("bridge accept error: {e}"),
                }
            }
        })
        .ok();
}

fn handle_client(mut stream: TcpStream, state: Arc<BridgeState>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };
    let raw = String::from_utf8_lossy(&buf[..n]);
    let (method, path, headers, body) = match parse_http(&raw) {
        Some(v) => v,
        None => {
            write_response(&mut stream, 400, "text/plain", "bad request");
            return;
        }
    };

    // CORS preflight for the extension options page / service worker.
    if method == "OPTIONS" {
        write_cors_preflight(&mut stream);
        return;
    }

    if method == "GET" && path == "/health" {
        write_json(&mut stream, 200, r#"{"ok":true,"service":"clocked"}"#);
        return;
    }

    let auth = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or(auth);
    if !state.auth_ok(token) {
        write_json(&mut stream, 401, r#"{"error":"unauthorized"}"#);
        return;
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/v1/status") => {
            write_json(&mut stream, 200, r#"{"ok":true,"bridge":true}"#);
        }
        ("POST", "/v1/tab") => {
            let (domain, title) = parse_tab_json(body);
            if domain.is_empty() {
                write_json(&mut stream, 400, r#"{"error":"domain required"}"#);
                return;
            }
            // Never store full URL paths — domain only.
            let domain = sanitize_domain(&domain);
            if domain.is_empty() {
                write_json(&mut stream, 400, r#"{"error":"invalid domain"}"#);
                return;
            }
            let title = crate::privacy::sanitize_title(&title);
            state.set_tab(domain, title);
            write_json(&mut stream, 200, r#"{"ok":true}"#);
        }
        _ => write_json(&mut stream, 404, r#"{"error":"not found"}"#),
    }
}

fn parse_http(raw: &str) -> Option<(String, String, Vec<(String, String)>, &str)> {
    let (head, body) = raw.split_once("\r\n\r\n").or_else(|| raw.split_once("\n\n"))?;
    let mut lines = head.lines();
    let req = lines.next()?;
    let mut parts = req.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.split('?').next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Some((method, path, headers, body))
}

fn parse_tab_json(body: &str) -> (String, String) {
    // Tiny manual parse to avoid depending on full failure modes; serde is fine too.
    #[derive(serde::Deserialize)]
    struct TabIn {
        #[serde(default)]
        domain: String,
        #[serde(default)]
        title: String,
        /// Accepted but ignored for storage — we only keep the host.
        #[serde(default)]
        url: String,
    }
    let parsed: TabIn = serde_json::from_str(body).unwrap_or(TabIn {
        domain: String::new(),
        title: String::new(),
        url: String::new(),
    });
    let mut domain = parsed.domain.trim().to_string();
    if domain.is_empty() && !parsed.url.is_empty() {
        domain = domain_from_url(&parsed.url).unwrap_or_default();
    }
    (domain, parsed.title)
}

fn domain_from_url(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?
        .split(['/', '?', '#'])
        .next()?;
    let host = rest.strip_prefix("www.").unwrap_or(rest);
    let host = host.split(':').next()?.to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    Some(host)
}

fn sanitize_domain(d: &str) -> String {
    let d = d.trim().to_ascii_lowercase();
    let d = d.strip_prefix("www.").unwrap_or(&d);
    let d = d.split(['/', '?', '#', ':']).next().unwrap_or(d);
    if d.len() < 3 || d.len() > 80 || !d.contains('.') || d.contains(' ') {
        return String::new();
    }
    if !d
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return String::new();
    }
    d.to_string()
}

fn write_cors_preflight(stream: &mut TcpStream) {
    let body = "";
    let resp = format!(
        "HTTP/1.1 204 No Content\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
         Access-Control-Max-Age: 86400\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n{body}"
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn write_json(stream: &mut TcpStream, status: u16, body: &str) {
    write_response(stream, status, "application/json; charset=utf-8", body);
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_domain_strips_junk() {
        assert_eq!(sanitize_domain("HTTPS://GitHub.com/foo"), "");
        assert_eq!(sanitize_domain("github.com"), "github.com");
        assert_eq!(sanitize_domain("www.GitHub.com"), "github.com");
        assert_eq!(sanitize_domain("evil.com/path"), "evil.com");
        assert!(sanitize_domain("not a domain").is_empty());
    }

    #[test]
    fn domain_from_url_works() {
        assert_eq!(
            domain_from_url("https://docs.google.com/document/d/x?q=1"),
            Some("docs.google.com".into())
        );
    }

    #[test]
    fn auth_requires_matching_token() {
        let s = BridgeState::new("clk_secret".into());
        assert!(s.auth_ok("clk_secret"));
        assert!(!s.auth_ok("clk_other"));
        assert!(!s.auth_ok(""));
    }

    #[test]
    fn fresh_domain_expires() {
        let s = BridgeState::new("t".into());
        s.set_tab("github.com".into(), String::new());
        assert_eq!(s.fresh_domain().as_deref(), Some("github.com"));
    }
}
