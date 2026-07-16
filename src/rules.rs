//! Rules engine: map each focused app to a project bucket.
//!
//! The model is a simple **app → project** assignment. A window is classified by
//! looking up its executable name; unmatched windows fall to `default_project`,
//! and a blank default means "label it by app name" — so a fresh install is
//! useful with no setup at all.
//!
//! Optional:
//! - **ignore**: apps always bucketed as `"Non-work"` (games, Spotify, …)
//! - **title_rules**: substring matches on the raw title **or** inferred context
//!   (browser domain / document name) → project when the app has no assignment.
//!
//! Assignments are made in the Settings → Projects tab and persisted to
//! `%APPDATA%\clocked\data\rules.toml`, which stays hand-editable.
//!
//! Pure and platform-agnostic, so it unit-tests on any host.

// Consumed by the Windows UI layer; keep the macOS build warning-clean without
// hiding genuine dead code on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// App→project assignments plus fallbacks and ignore list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Rules {
    /// Bucket for windows with no assignment. Blank → label by app name.
    #[serde(default)]
    pub default_project: String,
    /// Lowercased app executable (e.g. `"chrome.exe"`) → project name.
    #[serde(default)]
    pub assignments: BTreeMap<String, String>,
    /// Lowercased apps that always count as non-work (still timed, not billable).
    #[serde(default)]
    pub ignore: BTreeSet<String>,
    /// Optional title substring → project rules (case-insensitive contains).
    #[serde(default)]
    pub title_rules: Vec<TitleRule>,
}

/// Match when the window title contains `contains` (case-insensitive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TitleRule {
    pub contains: String,
    pub project: String,
}

/// Turn an executable name into a tidy display label for the per-app fallback
/// and the Settings list: `"jean.exe"` → `"Jean"`, `"Code.exe"` → `"Code"`,
/// `"whatsapp.root.exe"` → `"Whatsapp"`. Empty app → `"Unknown"`.
pub fn pretty_app_name(app: &str) -> String {
    let a = app.trim().to_lowercase();
    let stem = a.strip_suffix(".exe").unwrap_or(&a);
    let base = stem.split('.').next().unwrap_or(stem);
    let mut chars = base.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Unknown".to_string(),
    }
}

impl Rules {
    /// Project for the focused app. Order: ignore → assignment → title/context
    /// rule → default / pretty app name.
    ///
    /// `title` is the raw window title; `context` is the privacy-safe inferred
    /// label (domain or document). Rules match either string.
    pub fn classify(&self, app: &str, title: &str) -> String {
        self.classify_with_context(app, title, "")
    }

    pub fn classify_with_context(&self, app: &str, title: &str, context: &str) -> String {
        let a = app.trim().to_lowercase();
        if self.is_ignored(&a) {
            return "Non-work".to_string();
        }
        if let Some(p) = self.assignments.get(&a) {
            let p = p.trim();
            if !p.is_empty() {
                return p.to_string();
            }
        }
        if let Some(p) = self.match_title_rules(title, context) {
            return p;
        }
        if self.default_project.trim().is_empty() {
            pretty_app_name(app)
        } else {
            self.default_project.trim().to_string()
        }
    }

    fn match_title_rules(&self, title: &str, context: &str) -> Option<String> {
        let title_l = title.trim().to_ascii_lowercase();
        let ctx_l = context.trim().to_ascii_lowercase();
        if title_l.is_empty() && ctx_l.is_empty() {
            return None;
        }
        for rule in &self.title_rules {
            let needle = rule.contains.trim();
            if needle.is_empty() {
                continue;
            }
            let n = needle.to_ascii_lowercase();
            if (!title_l.is_empty() && title_l.contains(&n))
                || (!ctx_l.is_empty() && (ctx_l == n || ctx_l.contains(&n)))
            {
                let p = rule.project.trim();
                if !p.is_empty() {
                    return Some(p.to_string());
                }
            }
        }
        None
    }

    pub fn is_ignored(&self, app: &str) -> bool {
        self.ignore.contains(&app.trim().to_lowercase())
    }

    /// The project assigned to `app`, if any (ignores the fallback).
    pub fn assigned(&self, app: &str) -> Option<&str> {
        self.assignments
            .get(&app.trim().to_lowercase())
            .map(String::as_str)
            .filter(|s| !s.trim().is_empty())
    }

    /// Load rules from disk, writing the default template on first run.
    pub fn load() -> Rules {
        let Some(path) = crate::paths::rules_file() else {
            return Rules::default();
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).unwrap_or_default(),
            Err(_) => {
                let _ = std::fs::write(&path, DEFAULT_RULES_TOML);
                toml::from_str(DEFAULT_RULES_TOML).unwrap_or_default()
            }
        }
    }

    /// Persist rules to `rules.toml` as commented, hand-editable TOML.
    pub fn save(&self) -> std::io::Result<()> {
        let path = crate::paths::rules_file().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir")
        })?;
        std::fs::write(path, self.to_toml())
    }

    fn to_toml(&self) -> String {
        // Root keys first — anything after `[assignments]` would nest under that table.
        let mut out = String::from(RULES_HEADER);
        out.push_str(&format!(
            "default_project = \"{}\"\n",
            escape_toml(&self.default_project)
        ));
        out.push_str("\n# Apps that always count as Non-work (still timed).\nignore = [");
        if self.ignore.is_empty() {
            out.push_str("]\n");
        } else {
            out.push('\n');
            for app in &self.ignore {
                out.push_str(&format!("  \"{}\",\n", escape_toml(app)));
            }
            out.push_str("]\n");
        }
        out.push_str("\n[assignments]\n");
        for (app, project) in &self.assignments {
            if project.trim().is_empty() {
                continue;
            }
            out.push_str(&format!(
                "\"{}\" = \"{}\"\n",
                escape_toml(app),
                escape_toml(project.trim())
            ));
        }
        if !self.title_rules.is_empty() {
            out.push_str("\n# Optional: title substring → project (only when titles are stored).\n");
            for rule in &self.title_rules {
                if rule.contains.trim().is_empty() || rule.project.trim().is_empty() {
                    continue;
                }
                out.push_str("[[title_rules]]\n");
                out.push_str(&format!(
                    "contains = \"{}\"\nproject = \"{}\"\n",
                    escape_toml(rule.contains.trim()),
                    escape_toml(rule.project.trim())
                ));
            }
        }
        out
    }
}

fn escape_toml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

const RULES_HEADER: &str = "# clocked rules — which app counts as which project.\n\
     # Set these from Settings → Projects, or hand-edit here.\n\
     #\n\
     # [assignments] maps an app executable to a project bucket. Unassigned apps\n\
     # go to default_project — leave it blank (\"\") to label them by app name.\n\
     # ignore = apps that always count as Non-work.\n\
     \n";

const DEFAULT_RULES_TOML: &str = r#"# clocked rules — which app counts as which project.
# Set these from Settings → Projects, or hand-edit here.
#
# [assignments] maps an app executable to a project bucket. Unassigned apps
# go to default_project — leave it blank ("") to label them by app name.

default_project = ""

# Games / personal apps — still timed, bucketed as Non-work:
ignore = [
  # "steam.exe",
  # "spotify.exe",
]

[assignments]
# "code.exe" = "Coding"
# "chrome.exe" = "Browsing"

# Optional: if window title or site/doc context contains this → project.
# (Also editable under Settings → Projects.)
# [[title_rules]]
# contains = "acme.com"
# project = "Client Acme"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        let mut assignments = BTreeMap::new();
        assignments.insert("code.exe".to_string(), "Coding".to_string());
        assignments.insert("outlook.exe".to_string(), "Email".to_string());
        let mut ignore = BTreeSet::new();
        ignore.insert("spotify.exe".into());
        Rules {
            default_project: "Unassigned".to_string(),
            assignments,
            ignore,
            title_rules: vec![TitleRule {
                contains: "Acme".into(),
                project: "Client Acme".into(),
            }],
        }
    }

    #[test]
    fn assigned_app_maps_to_its_project() {
        let r = rules();
        assert_eq!(r.classify("code.exe", "main.rs"), "Coding");
        assert_eq!(r.classify("OUTLOOK.EXE", "Inbox"), "Email");
    }

    #[test]
    fn unassigned_falls_to_explicit_default_when_set() {
        let r = rules();
        assert_eq!(r.classify("notepad.exe", "untitled"), "Unassigned");
    }

    #[test]
    fn blank_default_buckets_unassigned_by_app_name() {
        let r = Rules {
            default_project: String::new(),
            assignments: BTreeMap::new(),
            ignore: BTreeSet::new(),
            title_rules: vec![],
        };
        assert_eq!(r.classify("jean.exe", "Jean"), "Jean");
        assert_eq!(r.classify("Code.exe", "main.rs"), "Code");
        assert_eq!(r.classify("whatsapp.root.exe", "Chat"), "Whatsapp");
        assert_eq!(r.classify("", "no app"), "Unknown");
    }

    #[test]
    fn ignore_buckets_as_non_work() {
        let r = rules();
        assert_eq!(r.classify("spotify.exe", "Song"), "Non-work");
        assert!(r.is_ignored("SPOTIFY.EXE"));
    }

    #[test]
    fn title_rule_matches_when_no_app_assignment() {
        let r = rules();
        assert_eq!(r.classify("chrome.exe", "Acme — Docs"), "Client Acme");
        // Explicit assignment wins over title rule.
        assert_eq!(r.classify("code.exe", "Acme — main.rs"), "Coding");
    }

    #[test]
    fn title_rule_matches_inferred_context_domain() {
        let r = rules();
        assert_eq!(
            r.classify_with_context("chrome.exe", "secret tab title", "acme.com"),
            "Client Acme"
        );
    }

    #[test]
    fn assigned_reports_explicit_assignment_only() {
        let r = rules();
        assert_eq!(r.assigned("code.exe"), Some("Coding"));
        assert_eq!(r.assigned("CODE.EXE"), Some("Coding"));
        assert_eq!(r.assigned("notepad.exe"), None);
    }

    #[test]
    fn shipped_default_template_is_empty_and_labels_by_app() {
        let r: Rules = toml::from_str(DEFAULT_RULES_TOML).unwrap();
        assert_eq!(r.default_project, "");
        assert!(r.assignments.is_empty());
        assert_eq!(r.classify("code.exe", "main.rs"), "Code");
        assert_eq!(r.classify("steam.exe", "Store"), "Steam");
    }

    #[test]
    fn to_toml_round_trips_through_parser() {
        let r = rules();
        let reparsed: Rules = toml::from_str(&r.to_toml()).unwrap();
        assert_eq!(reparsed, r);
    }
}
