// No console window in release; keep it in debug for live logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod log;
mod autostart;
mod config;
mod db;
mod events;
mod paths;
mod sync;
mod tray;
mod window;

fn main() {
    logln!("clocked starting");
    if let Err(e) = window::run() {
        logln!("fatal: {e}");
    }
    logln!("clocked stopped");
}
