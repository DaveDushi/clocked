//! User configuration: `%APPDATA%\clocked\config.toml`.
//! Holds the Cloudflare Worker sync endpoint and the shared bearer token.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub worker_url: String,
    #[serde(default)]
    pub bearer_token: String,
}

const TEMPLATE: &str = "\
# clocked configuration
# Fill these in to enable syncing sessions to your Cloudflare Worker.
# Leave blank to run in local-only mode (no sync, no monthly email).

worker_url   = \"\"   # e.g. https://clocked-worker.<subdomain>.workers.dev
bearer_token = \"\"   # must match the BEARER_TOKEN secret set on the Worker
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
}
