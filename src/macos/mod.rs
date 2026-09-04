//! macOS UI layer: the `NSApplication` run loop that mirrors what the Windows
//! `window.rs` does — observes sleep/wake and screen lock/unlock, hosts a status
//! bar (menu bar) item, and drives the heartbeat / sync / update timers. Clock
//! decisions come from the shared [`crate::engine`], so behavior matches Windows.
//!
//! The shared state machine owns tracking policy; this module only adapts its
//! effects to AppKit and macOS services.

mod runloop;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Blocking-sync budget on quit/power-off, mirroring the Windows shutdown path.
const SHUTDOWN_SYNC_TIMEOUT: Duration = Duration::from_secs(3);

/// Portable clock state machine for macOS. Holds no AppKit handles — the run
/// loop calls these methods in response to observers and timers, and performs the
/// UI side effects (notify / prompt) the returned intents imply. Deliberately a
/// close analog of the Windows `AppState` so the two can converge on `engine`.
pub struct AppState {
    core: crate::desktop::DesktopState,
    syncing: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            core: crate::desktop::DesktopState::new(),
            syncing: Arc::new(AtomicBool::new(false)),
        }
    }

    fn apply_effects(&mut self, effects: Vec<crate::desktop::Effect>) {
        for effect in effects {
            match effect {
                crate::desktop::Effect::Sync => self.start_sync(false),
                crate::desktop::Effect::Notify(body) => runloop::notify("clocked", &body),
                crate::desktop::Effect::PromptAfterHours => runloop::defer_after_hours_prompt(),
                crate::desktop::Effect::PromptReclaim { .. } => runloop::defer_reclaim_prompt(),
                crate::desktop::Effect::DismissAfterHoursPrompt => {
                    runloop::dismiss_after_hours_alert_if_showing()
                }
            }
        }
    }

    fn start_sync(&mut self, manual: bool) {
        if !self.core.config.is_configured() {
            if manual {
                runloop::notify("clocked", "Add your sync token first.");
            }
            return;
        }
        if self.syncing.swap(true, Ordering::SeqCst) {
            if manual {
                runloop::notify("clocked", "Sync already in progress…");
            }
            return;
        }
        runloop::spawn_sync(self.core.config.clone(), Arc::clone(&self.syncing), manual);
    }

    pub(crate) fn on_startup(&mut self) {
        let effects = self.core.startup(true);
        self.apply_effects(effects);
        self.check_for_updates();
    }

    pub(crate) fn heartbeat_tick(&mut self) {
        self.core.record_activity_tick();
        let effects = self.core.heartbeat();
        self.apply_effects(effects);
    }

    pub(crate) fn open_cmd(&mut self, reason: &'static str) {
        let effects = self.core.open_event(reason);
        self.apply_effects(effects);
    }

    pub(crate) fn close_cmd(&mut self, reason: &'static str) {
        let effects = self.core.close_event(reason);
        self.apply_effects(effects);
    }

    pub(crate) fn sync_now(&mut self) {
        self.start_sync(true);
    }

    pub(crate) fn toggle_pause_cmd(&mut self) {
        let effects = self.core.toggle_pause();
        self.apply_effects(effects);
    }

    pub(crate) fn quit(&mut self) {
        if self.core.shutdown("quit") && self.core.config.is_configured() {
            match crate::sync::run_blocking(&self.core.config, SHUTDOWN_SYNC_TIMEOUT) {
                Ok(n) if n > 0 => crate::logln!("synced {n} item(s) before exit"),
                Ok(_) => {}
                Err(e) => crate::logln!("shutdown sync error: {e}"),
            }
        }
    }

    pub(crate) fn begin_after_hours_prompt(&mut self) -> bool {
        let (show, effects) = self.core.begin_after_hours_prompt();
        self.apply_effects(effects);
        show
    }

    pub(crate) fn after_hours_answered(&mut self, working: bool) {
        let effects = self.core.answer_after_hours(working);
        self.apply_effects(effects);
    }

    pub(crate) fn reclaim_answered(&mut self, reclaim: bool) {
        let effects = self.core.answer_reclaim(reclaim);
        self.apply_effects(effects);
    }

    pub(crate) fn open_timesheet(&mut self) {
        let config = self.core.config.clone();
        let fallback = config.effective_worker_url().to_string();
        if fallback.trim().is_empty() {
            return;
        }
        std::thread::spawn(move || {
            let url = crate::sync::desktop_login_url(&config).unwrap_or(fallback);
            let _ = std::process::Command::new("open").arg(url).spawn();
        });
    }

    pub(crate) fn check_for_updates(&mut self) {
        std::thread::spawn(|| match crate::update::check_latest() {
            Ok(crate::update::UpdateStatus::Available { version, .. }) => {
                crate::logln!("update available: v{version}");
                runloop::notify(
                    "clocked update available",
                    &format!(
                        "Version v{version} is ready — download at {}",
                        crate::update::DOWNLOAD_URL
                    ),
                );
            }
            Ok(_) => {}
            Err(e) => crate::logln!("update check error: {e}"),
        });
    }

    pub(crate) fn set_sync_token(&mut self, token: String) {
        self.core.config.bearer_token = token;
        if let Err(e) = self.core.config.save() {
            crate::logln!("save token error: {e}");
            return;
        }
        self.core.reload();
        self.start_sync(false);
    }

    pub(crate) fn set_start_at_login(&mut self, enable: bool) -> bool {
        let result = if enable {
            crate::autostart::enable()
        } else {
            crate::autostart::disable()
        };
        if let Err(e) = result {
            crate::logln!("start-at-login toggle error: {e}");
        }
        crate::autostart::is_enabled()
    }

    pub(crate) fn start_at_login_enabled(&self) -> bool {
        crate::autostart::is_enabled()
    }
}

/// Entry point for the macOS build. Delegates to the AppKit run loop.
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    runloop::run()
}
