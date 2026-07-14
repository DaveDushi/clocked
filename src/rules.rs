//! Rules engine: map each focused app to a project bucket.
//!
//! The model is a simple **app → project** assignment. A window is classified by
//! looking up its executable name; unmatched windows fall to `default_project`,
//! and a blank default means "label it by app name" — so a fresh install is
//! useful with no setup at all.
//!
//! Assignments are made in the Settings → Projects tab (which lists the apps
//! you've actually used and lets you drop each into a bucket) and persisted to
//! `%APPDATA%\clocked\data\rules.toml`, which stays hand-editable.
//!
//! Pure and platform-agnostic, so it unit-tests on any host.

// Consumed by the Windows UI layer; keep the macOS build warning-clean without
// hiding genuine dead code on Windows.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// App→project assignments plus the fallback bucket for unmatched windows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Rules {
    /// Bucket for windows with no assignment. Blank → label by app name.
    #[serde(default)]
    pub default_project: String,
    /// Lowercased app executable (e.g. `"chrome.exe"`) → project name.
    #[serde(default)]
    pub assignments: BTreeMap<String, String>,
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
    /// Project for the focused app. An explicit assignment wins; otherwise a
    /// blank `default_project` falls back to the app's own name.
    pub fn classify(&self, app: &str, _title: &str) -> String {
        let a = app.trim().to_lowercase();
        if let Some(p) = self.assignments.get(&a) {
            let p = p.trim();
            if !p.is_empty() {
                return p.to_string();
            }
        }
        if self.default_project.trim().is_empty() {
            pretty_app_name(app)
        } else {
            self.default_project.trim().to_string()
        }
    }

    /// The project assigned to `app`, if any (ignores the fallback). Used to
    /// pre-fill the Settings list.
    pub fn assigned(&self, app: &str) -> Option<&str> {
        self.assignments
            .get(&app.trim().to_lowercase())
            .map(String::as_str)
            .filter(|s| !s.trim().is_empty())
    }

    /// Load rules from disk, writing the default template on first run. A
    /// malformed file falls back to defaults rather than crashing tracking.
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
        let mut out = String::from(RULES_HEADER);
        out.push_str(&format!(
            "default_project = \"{}\"\n\n[assignments]\n",
            escape_toml(&self.default_project)
        ));
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
        out
    }
}

/// Escape a value for a TOML basic (double-quoted) string.
fn escape_toml(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Header comment written above the rules in `rules.toml`.
const RULES_HEADER: &str = "# clocked rules — which app counts as which project.\n\
     # Set these from Settings → Projects, or hand-edit here.\n\
     #\n\
     # [assignments] maps an app executable to a project bucket. Unassigned apps\n\
     # go to default_project — leave it blank (\"\") to label them by app name.\n\
     \n";

/// Written to `rules.toml` on first run. Ships with **no** assignments on
/// purpose: the Projects tab shows the apps you actually use so you bucket those,
/// rather than a wall of apps you may never open. Until you assign any, every app
/// is simply labelled by its own name.
const DEFAULT_RULES_TOML: &str = r#"# clocked rules — which app counts as which project.
# Set these from Settings → Projects, or hand-edit here.
#
# [assignments] maps an app executable to a project bucket. Unassigned apps
# go to default_project — leave it blank ("") to label them by app name.

default_project = ""

[assignments]
# "code.exe" = "Coding"
# "chrome.exe" = "Browsing"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        let mut assignments = BTreeMap::new();
        assignments.insert("code.exe".to_string(), "Coding".to_string());
        assignments.insert("outlook.exe".to_string(), "Email".to_string());
        Rules {
            default_project: "Unassigned".to_string(),
            assignments,
        }
    }

    #[test]
    fn assigned_app_maps_to_its_project() {
        let r = rules();
        assert_eq!(r.classify("code.exe", "main.rs"), "Coding");
        assert_eq!(r.classify("OUTLOOK.EXE", "Inbox"), "Email"); // case-insensitive
    }

    #[test]
    fn unassigned_falls_to_explicit_default_when_set() {
        let r = rules(); // default_project = "Unassigned"
        assert_eq!(r.classify("notepad.exe", "untitled"), "Unassigned");
    }

    #[test]
    fn blank_default_buckets_unassigned_by_app_name() {
        let r = Rules {
            default_project: String::new(),
            assignments: BTreeMap::new(),
        };
        assert_eq!(r.classify("jean.exe", "Jean"), "Jean");
        assert_eq!(r.classify("Code.exe", "main.rs"), "Code");
        assert_eq!(r.classify("whatsapp.root.exe", "Chat"), "Whatsapp");
        assert_eq!(r.classify("", "no app"), "Unknown");
    }

    #[test]
    fn assigned_reports_explicit_assignment_only() {
        let r = rules();
        assert_eq!(r.assigned("code.exe"), Some("Coding"));
        assert_eq!(r.assigned("CODE.EXE"), Some("Coding"));
        assert_eq!(r.assigned("notepad.exe"), None); // fallback, not an assignment
    }

    #[test]
    fn shipped_default_template_is_empty_and_labels_by_app() {
        let r: Rules = toml::from_str(DEFAULT_RULES_TOML).unwrap();
        assert_eq!(r.default_project, "");
        assert!(r.assignments.is_empty()); // no pre-seeded apps
        // With nothing assigned, every app is labelled by its own name.
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
