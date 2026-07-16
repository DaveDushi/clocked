//! Infer a short, privacy-safe **context** for the focused window: what the user
//! is roughly working on *inside* an app, without needing extensions or
//! keylogging.
//!
//! Strategy (best-effort from the window title bar only):
//! - **Browsers** → hostname (`github.com`, not full URL/path/query)
//! - **Editors / Office-ish** → document stem (`main.rs`, `Q3 Report`)
//! - Private apps → never
//! - Garbage / empty → none
//!
//! Context is safe enough to store by default (unlike raw titles). It is still
//! local-only; cloud sync stays app + project aggregates.

/// Kind of inferred context (for tests / future UI icons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextKind {
    Domain,
    Document,
}

/// Result of parsing a window title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    pub kind: ContextKind,
    /// Short label, e.g. `"github.com"` or `"main.rs"`.
    pub label: String,
}

const BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "msedgewebview2.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "opera_gx.exe",
    "vivaldi.exe",
    "arc.exe",
    "chromium.exe",
    "iexplore.exe",
    "waterfox.exe",
    "librewolf.exe",
    "safari", // macOS process-style name
];

/// Browser-ish chrome suffixes stripped from titles before domain hunting.
const BROWSER_SUFFIXES: &[&str] = &[
    " - google chrome",
    " – google chrome",
    " — google chrome",
    " - microsoft edge",
    " – microsoft edge",
    " — microsoft edge",
    " - mozilla firefox",
    " – mozilla firefox",
    " — mozilla firefox",
    " - brave",
    " – brave",
    " — brave",
    " - opera",
    " – opera",
    " — opera",
    " - vivaldi",
    " – vivaldi",
    " — vivaldi",
    " - arc",
    " – arc",
    " — arc",
    " - chromium",
    " – chromium",
    " — chromium",
];

/// Document apps: strip these app-name suffixes to leave the file/doc name.
const DOC_APP_SUFFIXES: &[&str] = &[
    " - visual studio code",
    " - code - insiders",
    " - cursor",
    " - zed",
    " - sublime text",
    " - notepad++",
    " - notepad",
    " - word",
    " - excel",
    " - powerpoint",
    " - microsoft word",
    " - microsoft excel",
    " - microsoft powerpoint",
    " - google docs",
    " - google sheets",
    " - google slides",
    " - notion",
    " - obsidian",
    " - figma",
    " - adobe acrobat",
    " - acrobat reader",
    " - windows powerpoint",
    " - pages",
    " - numbers",
    " - keynote",
    " - textedit",
    " - preview",
];

const MAX_CONTEXT_LEN: usize = 64;

/// Infer context from the focused app + raw title bar. Returns `None` when we
/// cannot extract something privacy-safe and useful.
pub fn extract(app: &str, raw_title: &str) -> Option<Context> {
    let app = app.trim().to_ascii_lowercase();
    if app.is_empty() || crate::privacy::is_private_app(&app) {
        return None;
    }
    let title = raw_title.trim();
    if title.is_empty() {
        return None;
    }

    if is_browser(&app) {
        return domain_from_browser_title(title).map(|label| Context {
            kind: ContextKind::Domain,
            label,
        });
    }

    document_from_title(title).map(|label| Context {
        kind: ContextKind::Document,
        label,
    })
}

/// Context label only (empty string when none) — convenient for storage.
pub fn extract_label(app: &str, raw_title: &str) -> String {
    extract(app, raw_title)
        .map(|c| c.label)
        .unwrap_or_default()
}

fn is_browser(app: &str) -> bool {
    if BROWSERS.iter().any(|b| app == *b) {
        return true;
    }
    // macOS-style process names without .exe
    let stem = app.strip_suffix(".exe").unwrap_or(app);
    matches!(
        stem,
        "chrome" | "google chrome" | "msedge" | "firefox" | "brave" | "opera" | "vivaldi" | "safari" | "chromium" | "arc"
    ) || stem.contains("chrome")
        || stem.contains("firefox")
        || app.ends_with("browser.exe")
}

fn domain_from_browser_title(title: &str) -> Option<String> {
    let mut t = title.to_string();
    let lower = t.to_ascii_lowercase();
    for suf in BROWSER_SUFFIXES {
        if let Some(stripped) = lower.strip_suffix(suf) {
            t = title[..stripped.len()].trim().to_string();
            break;
        }
    }

    // Prefer an explicit URL in the title (rare but clean).
    if let Some(d) = domain_from_urlish(&t) {
        return Some(d);
    }

    // Common patterns: "Page — site.com", "site.com", "Page | site.com", "x · site.com"
    for part in t.split(['|', '—', '–', '•', '·']).rev() {
        if let Some(d) = looks_like_domain(part.trim()) {
            return Some(d);
        }
    }
    // Last token after " - " often is the site on mobile-style titles.
    if let Some((_, right)) = t.rsplit_once(" - ") {
        if let Some(d) = looks_like_domain(right.trim()) {
            return Some(d);
        }
        if let Some(d) = domain_from_urlish(right.trim()) {
            return Some(d);
        }
    }
    // Whole title is just a domain.
    looks_like_domain(t.trim())
}

fn domain_from_urlish(s: &str) -> Option<String> {
    let s = s.trim();
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .or_else(|| s.strip_prefix("www."))
        .unwrap_or(s);
    let host = rest.split(['/', '?', '#']).next()?.trim();
    let host = host.strip_prefix("www.").unwrap_or(host);
    looks_like_domain(host)
}

fn looks_like_domain(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches('/');
    if s.len() < 4 || s.len() > 80 {
        return None;
    }
    // Must look like host.tld (no spaces, has a dot, no @).
    if s.contains(' ') || s.contains('@') || !s.contains('.') {
        return None;
    }
    if s.starts_with('.') || s.ends_with('.') {
        return None;
    }
    // Only host-safe characters.
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
    {
        return None;
    }
    // Strip port if present.
    let host = s.split(':').next().unwrap_or(s);
    // Need at least one label + TLD of length >= 2.
    let mut parts = host.split('.').filter(|p| !p.is_empty());
    let labels: Vec<&str> = parts.by_ref().collect();
    if labels.len() < 2 {
        return None;
    }
    let tld = labels.last()?;
    if tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    // Drop obvious non-sites.
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".local") {
        return None;
    }
    Some(clamp(&lower))
}

fn document_from_title(title: &str) -> Option<String> {
    let mut t = title.to_string();
    let lower = t.to_ascii_lowercase();
    for suf in DOC_APP_SUFFIXES {
        if let Some(stripped) = lower.strip_suffix(suf) {
            t = title[..stripped.len()].trim().to_string();
            break;
        }
    }
    // "file — path" / "file - App" leftovers: take left of last " - " if long.
    if t.contains(" - ") {
        if let Some((left, _)) = t.rsplit_once(" - ") {
            // Keep left only when it still looks like a document (has extension
            // or is short enough to be a name, not a full sentence).
            let left = left.trim();
            if is_plausible_doc(left) {
                t = left.to_string();
            }
        }
    }
    // "• file" / dirty prefixes.
    t = t.trim_start_matches(['●', '•', '*', ' ']).trim().to_string();
    if !is_plausible_doc(&t) {
        return None;
    }
    // Never keep things that look like full emails or secrets.
    if t.contains('@') || t.len() > 120 {
        return None;
    }
    let cleaned = crate::privacy::sanitize_title(&t);
    if cleaned.is_empty() || cleaned.contains('[') {
        // Over-redacted → not useful as a document label.
        if cleaned.contains("[email]") || cleaned.contains("[token]") {
            return None;
        }
    }
    let label = if cleaned.is_empty() { t } else { cleaned };
    if !is_plausible_doc(&label) {
        return None;
    }
    Some(clamp(&label))
}

fn is_plausible_doc(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 2 || s.len() > 100 {
        return false;
    }
    // Reject pure browser-style leftover chrome.
    let l = s.to_ascii_lowercase();
    if l == "new tab" || l == "new tab page" || l == "startpage" || l == "extensions" {
        return false;
    }
    // Prefer names with a file extension or short multi-word titles.
    let has_ext = s
        .rsplit_once('.')
        .map(|(_, ext)| {
            let ext = ext.trim();
            (2..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or(false);
    if has_ext {
        return true;
    }
    // Short human doc titles without being a paragraph.
    s.chars().count() <= 48 && !s.contains("http") && s.split_whitespace().count() <= 8
}

fn clamp(s: &str) -> String {
    if s.chars().count() <= MAX_CONTEXT_LEN {
        s.to_string()
    } else {
        let t: String = s.chars().take(MAX_CONTEXT_LEN.saturating_sub(1)).collect();
        format!("{t}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_title_yields_domain() {
        let c = extract("chrome.exe", "Issue · github.com - Google Chrome");
        assert_eq!(c.map(|x| x.label), Some("github.com".into()));
    }

    #[test]
    fn edge_urlish_title() {
        let c = extract(
            "msedge.exe",
            "https://docs.google.com/document/d/abc - Microsoft Edge",
        );
        assert_eq!(c.unwrap().label, "docs.google.com");
    }

    #[test]
    fn vscode_document_name() {
        let c = extract("code.exe", "main.rs - clocked - Visual Studio Code").unwrap();
        assert_eq!(c.kind, ContextKind::Document);
        assert_eq!(c.label, "main.rs");
    }

    #[test]
    fn private_app_no_context() {
        assert!(extract("1password.exe", "Vault — Work").is_none());
    }

    #[test]
    fn empty_title_none() {
        assert!(extract("chrome.exe", "").is_none());
        assert!(extract("code.exe", "   ").is_none());
    }

    #[test]
    fn domain_only_title() {
        let c = extract("firefox.exe", "news.ycombinator.com — Mozilla Firefox");
        assert_eq!(c.unwrap().label, "news.ycombinator.com");
    }
}
