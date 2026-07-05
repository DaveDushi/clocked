//! Minimal file logger. Since the release build has no console
//! (`windows_subsystem = "windows"`), diagnostics go to
//! `%APPDATA%\clocked\clocked.log`.

use std::fs::OpenOptions;
use std::io::Write;

use chrono::Local;

pub fn log_line(msg: &str) {
    if let Some(path) = crate::paths::log_file() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{} {}", Local::now().format("%Y-%m-%d %H:%M:%S"), msg);
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("{msg}");
}

#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => { $crate::log::log_line(&format!($($arg)*)) };
}
