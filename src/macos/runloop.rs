//! AppKit run loop for macOS: status-bar item, sleep/wake + lock/unlock
//! observers, and the heartbeat/sync/update timers, all driving the shared
//! [`super::AppState`] (whose clock decisions come from [`crate::engine`]).
//!
//! Threading model — the tricky part — is kept simple by touching AppKit only on
//! the main thread. The single `AppState` lives in a main-thread-local cell; the
//! only background work is sync, guarded by a `Send` `AtomicBool` the worker
//! clears itself (no cross-thread objc2 marshaling). Prompts are enqueued to the
//! main thread via `performSelectorOnMainThread:` (non-reentrant) and shown with
//! `NSAlert`; user notifications go through `osascript` (no bundle entitlement).
//!
//! NOTE: developed on Windows, so this is compiled/verified on macOS via CI or a
//! local `cargo build --target aarch64-apple-darwin`. objc2 0.6 / objc2-app-kit
//! 0.3 idioms follow the upstream example + `define_class!` docs, but a couple of
//! method-name/mtm details are the likely first-build fixups (e.g. `NSStatusItem::
//! button` taking `mtm`, `NSAlert::new`).
#![allow(dead_code)]

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::AppState;
use crate::config::Config;
use crate::events::{self, Action};

// All AppKit callbacks (timers, observers, menu actions, prompts) fire on the
// main thread, so the single AppState lives in a main-thread-local cell rather
// than behind a lock.
thread_local! {
    static STATE: RefCell<Option<AppState>> = const { RefCell::new(None) };
}

fn with_state<R>(f: impl FnOnce(&mut AppState) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

// ---- Helpers called from AppState (parent module) --------------------------

/// Post a user notification (macOS analog of the Windows tray balloon). Uses
/// `osascript` so it works from a menu-bar agent without notification
/// entitlements; fire-and-forget, so no main-thread hop is needed.
pub(super) fn notify(title: &str, body: &str) {
    crate::logln!("notify: {title} — {body}");
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        applescript_escape(body),
        applescript_escape(title),
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Queue the after-hours "are you working?" modal on the main thread.
pub(super) fn defer_after_hours_prompt() {
    imp::defer(imp::Deferred::AfterHours);
}

/// Queue the idle-reclaim modal on the main thread.
pub(super) fn defer_reclaim_prompt() {
    imp::defer(imp::Deferred::Reclaim);
}

/// Run a sync on a worker thread; it clears the overlap guard when done.
pub(super) fn spawn_sync(config: Config, flag: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        match crate::sync::run_blocking(&config, Duration::from_secs(30)) {
            Ok(n) if n > 0 => crate::logln!("synced {n} session(s)"),
            Ok(_) => {}
            Err(e) => crate::logln!("sync error: {e}"),
        }
        flag.store(false, Ordering::SeqCst);
    });
}

/// Entry point: acquire the single-instance lock, seed state, run the loop.
pub(super) fn run() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(_lock) = acquire_single_instance_lock() {
        // `_lock` is held for the whole call — `imp::run_app()` blocks in
        // `NSApplication.run()` until the app terminates.
        STATE.with(|s| *s.borrow_mut() = Some(AppState::new()));
        imp::run_app();
        Ok(())
    } else {
        crate::logln!("another instance is already running; exiting");
        Ok(())
    }
}

/// One-time startup: crash recovery, first heartbeat, initial open, first sync.
/// Called from `imp::run_app` after the status item/observers exist (so a
/// deferred after-hours prompt has a controller to target).
fn startup() {
    with_state(|app| app.on_startup());
}

// ---- Single-instance lock (portable) ---------------------------------------

/// Hold an exclusive advisory lock for the lifetime of the returned guard.
/// Mirrors the Windows named mutex; released automatically on process exit.
fn acquire_single_instance_lock() -> Option<InstanceLock> {
    let path = crate::paths::data_dir()?.join("clocked.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        extern "C" {
            fn flock(fd: i32, op: i32) -> i32;
        }
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        // Fails immediately if another instance already holds the lock.
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } != 0 {
            return None;
        }
    }
    Some(InstanceLock { _file: file })
}

/// Releases the lock (closes the fd) on drop.
struct InstanceLock {
    _file: std::fs::File,
}

// ---- Bridge: run-loop callbacks → AppState ---------------------------------

/// Route an observed notification name to the state machine.
fn handle_notification(name: &str) {
    let action = events::map_notification(name);
    with_state(|app| match action {
        Action::ClockIn(r) => app.open_cmd(r),
        Action::ClockOut(r) => app.clock_out_cmd(r),
        Action::Ignore => {}
    });
}

fn tick_heartbeat() {
    with_state(|app| app.heartbeat_tick());
}
fn tick_sync() {
    with_state(|app| app.sync_now());
}
fn tick_update() {
    with_state(|app| app.check_for_updates());
}
fn menu_toggle_pause() {
    with_state(|app| app.toggle_pause_cmd());
}
fn menu_sync_now() {
    with_state(|app| app.sync_now());
}
fn menu_open_timesheet() {
    with_state(|app| app.open_timesheet());
}
fn menu_quit() {
    with_state(|app| app.quit());
    imp::terminate_app();
}
fn resolve_after_hours(working: bool) {
    with_state(|app| app.after_hours_answered(working));
}
fn resolve_reclaim(reclaim: bool) {
    with_state(|app| app.reclaim_answered(reclaim));
}
fn menu_set_token() {
    if let Some(token) = imp::prompt_text("Paste your clocked sync token:") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            with_state(|app| app.set_sync_token(token));
        }
    }
}
fn menu_toggle_start_at_login(enable: bool) -> bool {
    with_state(|app| app.set_start_at_login(enable)).unwrap_or(false)
}
fn start_at_login_state() -> bool {
    with_state(|app| app.start_at_login_enabled()).unwrap_or(false)
}

// ---- objc2 / AppKit implementation -----------------------------------------

mod imp {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, sel, MainThreadOnly};
    use objc2_app_kit::{
        NSAlert, NSApplication, NSApplicationActivationPolicy, NSMenu, NSMenuItem, NSStatusBar,
        NSStatusItem, NSWorkspace,
    };
    use objc2_foundation::{
        MainThreadMarker, NSDistributedNotificationCenter, NSNotification, NSObjectProtocol,
        NSString, NSTimer,
    };

    use crate::events::{DID_WAKE, SCREEN_LOCKED, SCREEN_UNLOCKED, WILL_SLEEP};

    // NSVariableStatusItemLength — a self-sizing status item.
    const VARIABLE_STATUS_ITEM_LENGTH: f64 = -1.0;
    // NSAlertFirstButtonReturn — the first (Yes) button.
    const ALERT_FIRST_BUTTON: isize = 1000;

    // Long-lived objects kept alive for the process lifetime. The status item
    // vanishes if dropped; NSNotificationCenter does not retain observers, so the
    // controller must outlive registration too.
    thread_local! {
        static CONTROLLER: RefCell<Option<Retained<Controller>>> = const { RefCell::new(None) };
        static STATUS_ITEM: RefCell<Option<Retained<NSStatusItem>>> = const { RefCell::new(None) };
    }

    pub enum Deferred {
        AfterHours,
        Reclaim,
    }

    define_class!(
        // The status-item target/observer/timer receiver. Forwards each selector
        // to the portable bridge fns in the parent module.
        #[unsafe(super(objc2_foundation::NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ClockedController"]
        struct Controller;

        unsafe impl NSObjectProtocol for Controller {}

        impl Controller {
            #[unsafe(method(heartbeat:))]
            fn heartbeat(&self, _t: Option<&NSTimer>) {
                super::tick_heartbeat();
            }
            #[unsafe(method(syncTick:))]
            fn sync_tick(&self, _t: Option<&NSTimer>) {
                super::tick_sync();
            }
            #[unsafe(method(updateTick:))]
            fn update_tick(&self, _t: Option<&NSTimer>) {
                super::tick_update();
            }
            #[unsafe(method(menuPause:))]
            fn menu_pause(&self, _s: Option<&AnyObject>) {
                super::menu_toggle_pause();
            }
            #[unsafe(method(menuSyncNow:))]
            fn menu_sync_now(&self, _s: Option<&AnyObject>) {
                super::menu_sync_now();
            }
            #[unsafe(method(menuTimesheet:))]
            fn menu_timesheet(&self, _s: Option<&AnyObject>) {
                super::menu_open_timesheet();
            }
            #[unsafe(method(menuQuit:))]
            fn menu_quit(&self, _s: Option<&AnyObject>) {
                super::menu_quit();
            }
            #[unsafe(method(menuSetToken:))]
            fn menu_set_token(&self, _s: Option<&AnyObject>) {
                super::menu_set_token();
            }
            #[unsafe(method(menuStartAtLogin:))]
            fn menu_start_at_login(&self, sender: Option<&AnyObject>) {
                let now_on = super::start_at_login_state();
                let result = super::menu_toggle_start_at_login(!now_on);
                if let Some(item) = sender {
                    // Reflect the resulting state as a checkmark on the item.
                    let state: isize = if result { 1 } else { 0 };
                    unsafe {
                        let _: () = msg_send![item, setState: state];
                    }
                }
            }
            #[unsafe(method(afterHoursPrompt:))]
            fn after_hours_prompt(&self, _s: Option<&AnyObject>) {
                let working = run_yes_no(
                    "It's outside your working hours.",
                    "Are you working?",
                );
                super::resolve_after_hours(working);
            }
            #[unsafe(method(reclaimPrompt:))]
            fn reclaim_prompt(&self, _s: Option<&AnyObject>) {
                let yes = run_yes_no(
                    "You were away with no keyboard or mouse activity.",
                    "Were you still working (a meeting, a call, reading)? Count it as worked?",
                );
                super::resolve_reclaim(yes);
            }
            #[unsafe(method(onWorkspaceNote:))]
            fn on_workspace_note(&self, note: &NSNotification) {
                let name = note.name();
                super::handle_notification(&name.to_string());
            }
            #[unsafe(method(onDistributedNote:))]
            fn on_distributed_note(&self, note: &NSNotification) {
                let name = note.name();
                super::handle_notification(&name.to_string());
            }
        }
    );

    impl Controller {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Build the app, wire the status item / observers / timers, run the startup
    /// sequence, then enter `NSApplication.run()` (blocks until quit).
    pub fn run_app() {
        let mtm = MainThreadMarker::new().expect("clocked must start on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        // Accessory: menu-bar app, no Dock icon / main window (also set via
        // Info.plist LSUIElement).
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

        let controller = Controller::new(mtm);

        // Status-bar item with a small glyph and the context menu.
        let status_bar = NSStatusBar::systemStatusBar();
        let status_item = status_bar.statusItemWithLength(VARIABLE_STATUS_ITEM_LENGTH);
        if let Some(button) = status_item.button(mtm) {
            button.setTitle(&NSString::from_str("◔"));
        }
        let menu = build_menu(mtm, &controller);
        status_item.setMenu(Some(&menu));

        register_observers(&controller);
        schedule_timers(&controller);

        CONTROLLER.with(|c| *c.borrow_mut() = Some(controller));
        STATUS_ITEM.with(|s| *s.borrow_mut() = Some(status_item));

        // Now that a controller exists to target deferred prompts, run startup.
        super::startup();

        app.run();
    }

    pub fn terminate_app() {
        let mtm = MainThreadMarker::new().expect("terminate on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        app.terminate(None);
    }

    /// Enqueue a prompt selector to run at the next run-loop pass (non-reentrant),
    /// mirroring the Windows `PostMessage` deferral so overlapping wake/unlock
    /// events can't stack two modals.
    pub fn defer(which: Deferred) {
        CONTROLLER.with(|c| {
            if let Some(controller) = c.borrow().as_ref() {
                let sel = match which {
                    Deferred::AfterHours => sel!(afterHoursPrompt:),
                    Deferred::Reclaim => sel!(reclaimPrompt:),
                };
                let obj: &Controller = controller;
                let no_arg: Option<&AnyObject> = None;
                unsafe {
                    let _: () = msg_send![
                        obj,
                        performSelectorOnMainThread: sel,
                        withObject: no_arg,
                        waitUntilDone: false,
                    ];
                }
            }
        });
    }

    fn build_menu(mtm: MainThreadMarker, controller: &Retained<Controller>) -> Retained<NSMenu> {
        let menu = NSMenu::new(mtm);
        add_item(&menu, mtm, controller, "Pause / Resume tracking", sel!(menuPause:));
        add_item(&menu, mtm, controller, "Open timesheet", sel!(menuTimesheet:));
        add_item(&menu, mtm, controller, "Sync now", sel!(menuSyncNow:));
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        add_item(&menu, mtm, controller, "Set sync token…", sel!(menuSetToken:));
        let login = add_item(&menu, mtm, controller, "Start at login", sel!(menuStartAtLogin:));
        // Reflect the current launch-at-login state as a checkmark.
        let state: isize = if super::start_at_login_state() { 1 } else { 0 };
        unsafe {
            let _: () = msg_send![&*login, setState: state];
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        add_item(&menu, mtm, controller, "Quit clocked", sel!(menuQuit:));
        menu
    }

    fn add_item(
        menu: &NSMenu,
        mtm: MainThreadMarker,
        controller: &Retained<Controller>,
        title: &str,
        action: objc2::runtime::Sel,
    ) -> Retained<NSMenuItem> {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                Some(action),
                &NSString::from_str(""),
            )
        };
        let target: &AnyObject = controller;
        unsafe { item.setTarget(Some(target)) };
        menu.addItem(&item);
        item
    }

    fn register_observers(controller: &Retained<Controller>) {
        let target: &AnyObject = controller;
        // Sleep/wake arrive on NSWorkspace's own notification center.
        let ws = NSWorkspace::sharedWorkspace();
        let wc = ws.notificationCenter();
        for name in [WILL_SLEEP, DID_WAKE] {
            unsafe {
                wc.addObserver_selector_name_object(
                    target,
                    sel!(onWorkspaceNote:),
                    Some(&NSString::from_str(name)),
                    None,
                );
            }
        }
        // Lock/unlock arrive as distributed notifications.
        let dc = NSDistributedNotificationCenter::defaultCenter();
        for name in [SCREEN_LOCKED, SCREEN_UNLOCKED] {
            unsafe {
                dc.addObserver_selector_name_object(
                    target,
                    sel!(onDistributedNote:),
                    Some(&NSString::from_str(name)),
                    None,
                );
            }
        }
    }

    fn schedule_timers(controller: &Retained<Controller>) {
        let target: &AnyObject = controller;
        // The run loop retains scheduled timers, so the returned handles can drop.
        unsafe {
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                60.0,
                target,
                sel!(heartbeat:),
                None,
                true,
            );
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                3600.0,
                target,
                sel!(syncTick:),
                None,
                true,
            );
            NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
                21600.0,
                target,
                sel!(updateTick:),
                None,
                true,
            );
        }
    }

    /// Show a two-button Yes/No modal on the main thread; true = "Yes".
    fn run_yes_no(message: &str, informative: &str) -> bool {
        let mtm = MainThreadMarker::new().expect("prompt on the main thread");
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(message));
        alert.setInformativeText(&NSString::from_str(informative));
        alert.addButtonWithTitle(&NSString::from_str("Yes"));
        alert.addButtonWithTitle(&NSString::from_str("No"));
        alert.runModal() == ALERT_FIRST_BUTTON
    }

    /// Prompt for a single line of text via `osascript`; `None` on cancel/empty.
    /// Avoids wiring an NSTextField accessory view for a one-off token entry.
    pub fn prompt_text(prompt: &str) -> Option<String> {
        let script = format!(
            "display dialog \"{}\" default answer \"\" buttons {{\"Cancel\", \"Save\"}} default button \"Save\"",
            super::applescript_escape(prompt),
        );
        let out = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .ok()?;
        if !out.status.success() {
            return None; // Cancel → non-zero exit
        }
        // osascript prints e.g. "button returned:Save, text returned:TOKEN".
        // text returned is the trailing field, so take everything after it.
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        let marker = "text returned:";
        s.find(marker).map(|i| s[i + marker.len()..].to_string())
    }
}
