//! Privacy helpers for foreground activity capture.
//!
//! Default posture: record **which app** was focused and for how long — never
//! window titles (titles often contain emails, doc names, chat snippets). Users
//! may opt into storing a **sanitized** title for richer local breakdowns.
//!
//! Private apps (password managers, banking, etc.) are never attributed; their
//! time is bucketed as "Private" so totals stay honest without leaking content.

/// Display bucket for blocked private apps.
pub const PRIVATE_PROJECT: &str = "Private";

/// Default retention for activity rows (days). Older samples are deleted.
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

/// Max length of a stored title when the user opts into title capture.
const MAX_TITLE_LEN: usize = 80;

/// Lowercased executable names that should never expose a title and always map
/// to [`PRIVATE_PROJECT`] unless the user assigns them explicitly.
const PRIVATE_APPS: &[&str] = &[
    "1password.exe",
    "1password-browser-support.exe",
    "keepass.exe",
    "keepassxc.exe",
    "bitwarden.exe",
    "lastpass.exe",
    "dashlane.exe",
    "enpass.exe",
    "roboform.exe",
    "passwordsafe.exe",
    // Banking / finance (common US/EU desktop shells).
    "chase.exe",
    "wellsfargo.exe",
    "bankofamerica.exe",
    "schwab.exe",
    "fidelity.exe",
    "etrade.exe",
    "paypal.exe",
    // Secure comms often leak contact names in titles.
    "signal.exe",
    "signal-desktop.exe",
    "session.exe",
    "element.exe",
    "keybase.exe",
    // System auth / vaults.
    "credentialuibroker.exe",
    "windowshelloface.exe",
    "systemsettings.exe",
];

/// True when this executable should be treated as private by default.
pub fn is_private_app(app: &str) -> bool {
    let a = app.trim().to_ascii_lowercase();
    PRIVATE_APPS.iter().any(|p| *p == a)
}

/// Title to persist for a sample.
///
/// - `store_titles == false` → always empty (default).
/// - Private apps → always empty even if titles are enabled.
/// - Otherwise sanitized and truncated.
pub fn title_for_storage(app: &str, title: &str, store_titles: bool) -> String {
    if !store_titles || is_private_app(app) {
        return String::new();
    }
    sanitize_title(title)
}

/// Strip obvious secrets from a window title and cap length.
pub fn sanitize_title(title: &str) -> String {
    let mut s = title.trim().to_string();
    if s.is_empty() {
        return s;
    }
    // Collapse long digit runs (account #s, phone, card fragments).
    s = redact_long_digits(&s);
    // Collapse email-shaped tokens.
    s = redact_emails(&s);
    // Collapse likely tokens / API keys (long base64-ish runs).
    s = redact_tokens(&s);
    // Truncate for storage/display.
    if s.chars().count() > MAX_TITLE_LEN {
        let t: String = s.chars().take(MAX_TITLE_LEN.saturating_sub(1)).collect();
        format!("{t}…")
    } else {
        s
    }
}

fn redact_long_digits(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut digit_run = 0usize;
    let mut buf = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            digit_run += 1;
            buf.push(c);
        } else {
            flush_digits(&mut out, &mut buf, digit_run);
            digit_run = 0;
            out.push(c);
        }
    }
    flush_digits(&mut out, &mut buf, digit_run);
    out
}

fn flush_digits(out: &mut String, buf: &mut String, run: usize) {
    if run >= 6 {
        out.push_str("[num]");
    } else {
        out.push_str(buf);
    }
    buf.clear();
}

fn redact_emails(s: &str) -> String {
    // Simple pass: replace sequences containing @ with a local-part-looking left
    // side and a domain. Avoids pulling in a regex crate.
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('@') {
        let left = &rest[..at];
        // Find start of the local part (walk back over word chars).
        let start = left
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '%' || c == '+' || c == '-'))
            .map(|i| i + 1)
            .unwrap_or(0);
        let after = &rest[at + 1..];
        let end_rel = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .unwrap_or(after.len());
        if at > start && end_rel > 0 && after[..end_rel].contains('.') {
            out.push_str(&rest[..start]);
            out.push_str("[email]");
            rest = &rest[at + 1 + end_rel..];
        } else {
            out.push_str(&rest[..=at]);
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    out
}

fn redact_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            run.push(c);
        } else {
            flush_token(&mut out, &mut run);
            out.push(c);
        }
    }
    flush_token(&mut out, &mut run);
    out
}

fn flush_token(out: &mut String, run: &mut String) {
    // Long mixed tokens look like secrets (clk_…, API keys). Keep short words.
    let looks_secret = run.len() >= 24
        && run.chars().any(|c| c.is_ascii_digit())
        && run.chars().any(|c| c.is_ascii_alphabetic());
    if looks_secret {
        out.push_str("[token]");
    } else {
        out.push_str(run);
    }
    run.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_off_by_default() {
        assert_eq!(title_for_storage("code.exe", "secret.doc", false), "");
    }

    #[test]
    fn private_app_never_stores_title() {
        assert_eq!(
            title_for_storage("1password.exe", "Vault — Work", true),
            ""
        );
        assert!(is_private_app("Bitwarden.exe"));
    }

    #[test]
    fn sanitizes_email_and_digits() {
        let s = sanitize_title("Re: plan for jane.doe@acme.com acct 1234567890");
        assert!(!s.contains("jane.doe@acme.com"));
        assert!(s.contains("[email]"));
        assert!(s.contains("[num]"));
        assert!(!s.contains("1234567890"));
    }

    #[test]
    fn truncates_long_titles() {
        let long = "a".repeat(200);
        let s = sanitize_title(&long);
        assert!(s.chars().count() <= MAX_TITLE_LEN);
        assert!(s.ends_with('…'));
    }
}
