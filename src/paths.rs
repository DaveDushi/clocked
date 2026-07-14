//! Filesystem locations for clocked's data, config, and log files.
//! Everything lives under `%APPDATA%\clocked\`.

use std::fs;
use std::path::PathBuf;

use directories::ProjectDirs;

/// `%APPDATA%\clocked\`, creating it if needed.
pub fn data_dir() -> Option<PathBuf> {
    let pd = ProjectDirs::from("", "", "clocked")?;
    let dir = pd.data_dir().to_path_buf();
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

pub fn db_file() -> Option<PathBuf> {
    Some(data_dir()?.join("clocked.db"))
}

pub fn config_file() -> Option<PathBuf> {
    Some(data_dir()?.join("config.toml"))
}

pub fn rules_file() -> Option<PathBuf> {
    Some(data_dir()?.join("rules.toml"))
}

pub fn log_file() -> Option<PathBuf> {
    Some(data_dir()?.join("clocked.log"))
}
