//! Minimal GTK 3 + Ayatana AppIndicator bindings used by the Linux tray.
//!
//! The machine already provides these stable C libraries. Binding only the
//! handful of functions clocked needs keeps compile time and binary size small.

use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void, CStr, CString};
use std::process::{Command, Stdio};
use std::ptr;

pub type Widget = *mut c_void;
pub type Callback = unsafe extern "C" fn(Widget, *mut c_void);
pub type TimerCallback = unsafe extern "C" fn(*mut c_void) -> c_int;

const GTK_ORIENTATION_VERTICAL: c_int = 1;
const GTK_RESPONSE_CANCEL: c_int = -6;
const GTK_RESPONSE_ACCEPT: c_int = -3;
const GTK_RESPONSE_YES: c_int = -8;
const GTK_RESPONSE_NO: c_int = -9;
const GDK_WINDOW_TYPE_HINT_DIALOG: c_int = 1;
const PROMPT_WIDTH: c_int = 380;
const PROMPT_HEIGHT: c_int = 150;
const PROMPT_POPOVER_RETRY_MS: c_uint = 50;
const PROMPT_POPOVER_MAX_ATTEMPTS: u8 = 10;
const APP_INDICATOR_CATEGORY_APPLICATION_STATUS: c_int = 0;
const APP_INDICATOR_STATUS_ACTIVE: c_int = 1;

#[link(name = "gtk-3")]
unsafe extern "C" {
    fn gtk_init_check(argc: *mut c_int, argv: *mut *mut *mut c_char) -> c_int;
    fn gtk_main();
    fn gtk_main_quit();
    fn gtk_menu_new() -> Widget;
    fn gtk_menu_item_new_with_label(label: *const c_char) -> Widget;
    fn gtk_separator_menu_item_new() -> Widget;
    fn gtk_menu_shell_append(menu: Widget, child: Widget);
    fn gtk_widget_show_all(widget: Widget);
    fn gtk_widget_set_sensitive(widget: Widget, sensitive: c_int);
    fn gtk_menu_item_set_label(item: Widget, label: *const c_char);

    fn gtk_dialog_new() -> Widget;
    fn gtk_window_set_title(window: Widget, title: *const c_char);
    fn gtk_window_set_default_size(window: Widget, width: c_int, height: c_int);
    fn gtk_window_set_keep_above(window: Widget, setting: c_int);
    fn gtk_window_set_modal(window: Widget, modal: c_int);
    fn gtk_window_set_resizable(window: Widget, resizable: c_int);
    fn gtk_window_set_type_hint(window: Widget, hint: c_int);
    fn gtk_window_stick(window: Widget);
    fn gtk_dialog_get_content_area(dialog: Widget) -> Widget;
    fn gtk_dialog_add_button(dialog: Widget, text: *const c_char, response: c_int) -> Widget;
    fn gtk_dialog_set_default_response(dialog: Widget, response: c_int);
    fn gtk_dialog_run(dialog: Widget) -> c_int;
    fn gtk_widget_destroy(widget: Widget);
    fn gtk_container_set_border_width(container: Widget, width: c_uint);
    fn gtk_box_new(orientation: c_int, spacing: c_int) -> Widget;
    fn gtk_box_pack_start(
        container: Widget,
        child: Widget,
        expand: c_int,
        fill: c_int,
        padding: c_uint,
    );
    fn gtk_label_new(text: *const c_char) -> Widget;
    fn gtk_label_set_line_wrap(label: Widget, wrap: c_int);
    fn gtk_label_set_max_width_chars(label: Widget, count: c_int);
    fn gtk_entry_new() -> Widget;
    fn gtk_entry_set_placeholder_text(entry: Widget, text: *const c_char);
    fn gtk_entry_set_visibility(entry: Widget, visible: c_int);
    fn gtk_entry_set_activates_default(entry: Widget, setting: c_int);
    fn gtk_entry_get_text(entry: Widget) -> *const c_char;
    fn gtk_widget_grab_focus(widget: Widget);
}

#[link(name = "ayatana-appindicator3")]
unsafe extern "C" {
    fn app_indicator_new(id: *const c_char, icon: *const c_char, category: c_int) -> Widget;
    fn app_indicator_set_status(indicator: Widget, status: c_int);
    fn app_indicator_set_menu(indicator: Widget, menu: Widget);
    fn app_indicator_set_title(indicator: Widget, title: *const c_char);
    fn app_indicator_set_icon_theme_path(indicator: Widget, path: *const c_char);
    fn app_indicator_set_tooltip_full(
        indicator: Widget,
        icon: *const c_char,
        title: *const c_char,
        body: *const c_char,
    );
}

#[link(name = "gobject-2.0")]
unsafe extern "C" {
    fn g_signal_connect_data(
        instance: Widget,
        signal: *const c_char,
        handler: *const c_void,
        data: *mut c_void,
        destroy_data: *const c_void,
        flags: c_int,
    ) -> c_ulong;
}

#[link(name = "glib-2.0")]
unsafe extern "C" {
    fn g_timeout_add_seconds(
        interval: c_uint,
        function: TimerCallback,
        data: *mut c_void,
    ) -> c_uint;
    fn g_timeout_add(interval: c_uint, function: TimerCallback, data: *mut c_void) -> c_uint;
}

fn c(text: &str) -> CString {
    CString::new(text.replace('\0', " ")).expect("sanitized CString")
}

pub fn init() -> bool {
    unsafe { gtk_init_check(ptr::null_mut(), ptr::null_mut()) != 0 }
}

pub fn main_loop() {
    unsafe { gtk_main() }
}

pub fn quit() {
    unsafe { gtk_main_quit() }
}

pub fn timer(seconds: u32, callback: TimerCallback, data: *mut c_void) {
    unsafe {
        g_timeout_add_seconds(seconds, callback, data);
    }
}

pub fn menu() -> Widget {
    unsafe { gtk_menu_new() }
}

pub fn menu_item(
    menu: Widget,
    label: &str,
    callback: Option<Callback>,
    data: *mut c_void,
) -> Widget {
    let label = c(label);
    let item = unsafe { gtk_menu_item_new_with_label(label.as_ptr()) };
    unsafe { gtk_menu_shell_append(menu, item) };
    if let Some(callback) = callback {
        let signal = c("activate");
        unsafe {
            g_signal_connect_data(
                item,
                signal.as_ptr(),
                callback as *const () as *const c_void,
                data,
                ptr::null(),
                0,
            );
        }
    }
    item
}

pub fn separator(menu: Widget) {
    unsafe {
        let item = gtk_separator_menu_item_new();
        gtk_menu_shell_append(menu, item);
    }
}

pub fn show_all(widget: Widget) {
    unsafe { gtk_widget_show_all(widget) }
}

pub fn set_sensitive(widget: Widget, sensitive: bool) {
    unsafe { gtk_widget_set_sensitive(widget, sensitive as c_int) }
}

pub fn set_label(widget: Widget, label: &str) {
    let label = c(label);
    unsafe { gtk_menu_item_set_label(widget, label.as_ptr()) }
}

pub fn indicator(menu: Widget, icon_name: &str, icon_theme_path: Option<&str>) -> Widget {
    let id = c("clocked");
    // The `-symbolic` suffix tells supporting tray hosts (including Omarchy's
    // Quickshell bar) to recolor the clock to the active theme foreground.
    let icon = c(icon_name);
    let title = c("clocked");
    unsafe {
        let indicator = app_indicator_new(
            id.as_ptr(),
            icon.as_ptr(),
            APP_INDICATOR_CATEGORY_APPLICATION_STATUS,
        );
        if let Some(path) = icon_theme_path {
            let path = c(path);
            app_indicator_set_icon_theme_path(indicator, path.as_ptr());
        }
        app_indicator_set_title(indicator, title.as_ptr());
        app_indicator_set_menu(indicator, menu);
        app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
        indicator
    }
}

pub fn tooltip(indicator: Widget, icon_name: &str, body: &str) {
    let icon = c(icon_name);
    let title = c("clocked");
    let body = c(body);
    unsafe {
        app_indicator_set_tooltip_full(indicator, icon.as_ptr(), title.as_ptr(), body.as_ptr())
    }
}

struct PopoverAttempt {
    attempts: u8,
}

/// Make the Clocked prompt behave like Omarchy's SUPER+O pop-out:
/// float, resize, center, pin, and raise it. The compositor can map a Wayland
/// surface a little after GTK shows it, so retry briefly from the nested dialog
/// loop. Looking through mapped clients instead of relying on the active window
/// also works when Hyprland's focus-stealing prevention leaves focus elsewhere.
unsafe extern "C" fn apply_prompt_popover(data: *mut c_void) -> c_int {
    let attempt = &mut *data.cast::<PopoverAttempt>();
    attempt.attempts += 1;

    if pop_clocked_prompt() || attempt.attempts >= PROMPT_POPOVER_MAX_ATTEMPTS {
        drop(Box::from_raw(data.cast::<PopoverAttempt>()));
        0
    } else {
        1
    }
}

fn pop_clocked_prompt() -> bool {
    let output = match Command::new("hyprctl")
        .args(["clients", "-j"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };
    let Ok(windows) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) else {
        return false;
    };
    let Some(window) = windows.iter().find(|window| {
        window.get("pid").and_then(|pid| pid.as_u64()) == Some(std::process::id() as u64)
            && window.get("title").and_then(|title| title.as_str()) == Some("clocked")
    }) else {
        return false;
    };

    let Some(address) = window.get("address").and_then(|address| address.as_str()) else {
        return false;
    };
    if address.is_empty() {
        return false;
    }
    let target = format!("address:{address}");
    let mut applied = true;

    if window.get("floating").and_then(|value| value.as_bool()) != Some(true) {
        applied &= hypr_dispatch(
            &format!("hl.dsp.window.float({{ window = \"{target}\", action = \"toggle\" }})"),
            &["togglefloating", &target],
        );
    }
    applied &= hypr_dispatch(
        &format!(
            "hl.dsp.window.resize({{ window = \"{target}\", x = {PROMPT_WIDTH}, y = {PROMPT_HEIGHT} }})"
        ),
        &[
            "resizeactive",
            "exact",
            &PROMPT_WIDTH.to_string(),
            &PROMPT_HEIGHT.to_string(),
            &target,
        ],
    );
    applied &= hypr_dispatch(
        &format!("hl.dsp.window.center({{ window = \"{target}\" }})"),
        &["centerwindow", &target],
    );
    if window.get("pinned").and_then(|value| value.as_bool()) != Some(true) {
        applied &= hypr_dispatch(
            &format!("hl.dsp.window.pin({{ window = \"{target}\" }})"),
            &["pin", &target],
        );
    }
    applied &= hypr_dispatch(
        &format!("hl.dsp.window.alter_zorder({{ window = \"{target}\", mode = \"top\" }})"),
        &["alterzorder", "top", &target],
    );
    applied &= hypr_dispatch(
        &format!("hl.dsp.window.tag({{ window = \"{target}\", tag = \"+pop\" }})"),
        &["tagwindow", "+pop", &target],
    );
    applied
}

fn hypr_dispatch(lua: &str, legacy: &[&str]) -> bool {
    let lua_status = Command::new("hyprctl")
        .arg("dispatch")
        .arg(lua)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if lua_status.is_ok_and(|status| status.success()) {
        return true;
    }

    Command::new("hyprctl")
        .arg("dispatch")
        .args(legacy)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn prepare_prompt(dialog: Widget) {
    unsafe {
        gtk_window_set_default_size(dialog, PROMPT_WIDTH, PROMPT_HEIGHT);
        gtk_window_set_resizable(dialog, 0);
        gtk_window_set_modal(dialog, 1);
        gtk_window_set_type_hint(dialog, GDK_WINDOW_TYPE_HINT_DIALOG);
        gtk_window_set_keep_above(dialog, 1);

        let desktop_is_hyprland = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktop| {
            desktop
                .split(':')
                .any(|name| name.eq_ignore_ascii_case("hyprland"))
        });
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() || desktop_is_hyprland {
            let attempt = Box::new(PopoverAttempt { attempts: 0 });
            g_timeout_add(
                PROMPT_POPOVER_RETRY_MS,
                apply_prompt_popover,
                Box::into_raw(attempt).cast(),
            );
        } else {
            // Traditional window managers can honor this standard GTK hint.
            // Hyprland pinning is handled explicitly above because Wayland has
            // no portable protocol for making a toplevel follow workspaces.
            gtk_window_stick(dialog);
        }
    }
}

pub fn ask(title: &str, body: &str, yes: &str, no: &str) -> bool {
    unsafe {
        let dialog = gtk_dialog_new();
        let title = c(title);
        gtk_window_set_title(dialog, title.as_ptr());
        prepare_prompt(dialog);
        let area = gtk_dialog_get_content_area(dialog);
        gtk_container_set_border_width(area, 18);
        let body = c(body);
        let label = gtk_label_new(body.as_ptr());
        gtk_label_set_line_wrap(label, 1);
        gtk_label_set_max_width_chars(label, 42);
        gtk_box_pack_start(area, label, 1, 1, 8);
        let no = c(no);
        let yes = c(yes);
        gtk_dialog_add_button(dialog, no.as_ptr(), GTK_RESPONSE_NO);
        gtk_dialog_add_button(dialog, yes.as_ptr(), GTK_RESPONSE_YES);
        gtk_dialog_set_default_response(dialog, GTK_RESPONSE_YES);
        gtk_widget_show_all(dialog);
        let response = gtk_dialog_run(dialog);
        gtk_widget_destroy(dialog);
        response == GTK_RESPONSE_YES
    }
}

pub fn text_input(title: &str, body: &str, placeholder: &str) -> Option<String> {
    unsafe {
        let dialog = gtk_dialog_new();
        let title = c(title);
        gtk_window_set_title(dialog, title.as_ptr());
        gtk_window_set_default_size(dialog, 480, 150);
        let area = gtk_dialog_get_content_area(dialog);
        gtk_container_set_border_width(area, 18);
        let column = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
        gtk_box_pack_start(area, column, 1, 1, 0);

        let body = c(body);
        let label = gtk_label_new(body.as_ptr());
        gtk_label_set_line_wrap(label, 1);
        gtk_box_pack_start(column, label, 0, 0, 0);

        let entry = gtk_entry_new();
        let placeholder = c(placeholder);
        gtk_entry_set_placeholder_text(entry, placeholder.as_ptr());
        gtk_entry_set_visibility(entry, 0);
        gtk_entry_set_activates_default(entry, 1);
        gtk_box_pack_start(column, entry, 0, 0, 0);

        let cancel = c("Cancel");
        let save = c("Save");
        gtk_dialog_add_button(dialog, cancel.as_ptr(), GTK_RESPONSE_CANCEL);
        gtk_dialog_add_button(dialog, save.as_ptr(), GTK_RESPONSE_ACCEPT);
        gtk_dialog_set_default_response(dialog, GTK_RESPONSE_ACCEPT);
        gtk_widget_show_all(dialog);
        gtk_widget_grab_focus(entry);
        let response = gtk_dialog_run(dialog);
        let result = if response == GTK_RESPONSE_ACCEPT {
            let text = gtk_entry_get_text(entry);
            if text.is_null() {
                None
            } else {
                Some(CStr::from_ptr(text).to_string_lossy().trim().to_string())
            }
        } else {
            None
        };
        gtk_widget_destroy(dialog);
        result.filter(|s| !s.is_empty())
    }
}
