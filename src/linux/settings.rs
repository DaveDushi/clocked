//! Native GTK settings panel for the Linux tray app.

use super::gtk;
use crate::config::Config;

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

pub(super) struct Update {
    pub config: Config,
    pub autostart: bool,
}

/// Show the Linux equivalent of the Windows General settings page.
///
/// The token field is deliberately empty: an empty value keeps the secret
/// already stored in the desktop keyring, while a new value replaces it.
pub(super) fn show(current: &Config, autostart: bool) -> Option<Update> {
    let dialog = gtk::dialog("clocked settings", 560, 600);
    let area = gtk::dialog_content(dialog, 20);
    let page = gtk::box_layout(false, 14);
    gtk::pack(area, page, true);

    let intro =
        gtk::wrapping_label("Configure tracking here. Changes are applied as soon as you save.");
    gtk::pack(page, intro, false);

    let form = gtk::grid(8, 12);
    gtk::pack(page, form, false);

    gtk::grid_attach(form, gtk::label("Sync token"), 0, 0, 2);
    let token = gtk::entry("", "Leave blank to keep the saved clk_… token", true);
    gtk::grid_attach(form, token, 0, 1, 2);

    gtk::grid_attach(form, gtk::label("Idle timeout (minutes; 0 = off)"), 0, 2, 1);
    gtk::grid_attach(form, gtk::label("Daily goal (hours; 0 = hide)"), 1, 2, 1);
    let idle = gtk::spin(0.0, 1440.0, 1.0, (current.idle_timeout_secs / 60) as f64, 0);
    let target = gtk::spin(0.0, 24.0, 0.25, current.target_hours, 2);
    gtk::grid_attach(form, idle, 0, 3, 1);
    gtk::grid_attach(form, target, 1, 3, 1);

    gtk::grid_attach(form, gtk::label("Work start (HH:MM)"), 0, 4, 1);
    gtk::grid_attach(form, gtk::label("Work end (HH:MM)"), 1, 4, 1);
    let work_start = gtk::entry(&current.work_start, "09:00", false);
    let work_end = gtk::entry(&current.work_end, "17:00", false);
    gtk::grid_attach(form, work_start, 0, 5, 1);
    gtk::grid_attach(form, work_end, 1, 5, 1);

    gtk::grid_attach(
        form,
        gtk::label("Work days (none disables the after-hours prompt)"),
        0,
        6,
        2,
    );
    let day_row = gtk::box_layout(true, 10);
    let days: Vec<_> = DAYS
        .iter()
        .map(|day| {
            let active = current
                .work_days
                .iter()
                .any(|configured| configured.eq_ignore_ascii_case(day));
            let button = gtk::checkbox(day, active);
            gtk::pack(day_row, button, false);
            button
        })
        .collect();
    gtk::grid_attach(form, day_row, 0, 7, 2);

    let start_at_login = gtk::checkbox("Start clocked automatically at login", autostart);
    gtk::grid_attach(form, start_at_login, 0, 8, 2);
    let track_projects = gtk::checkbox(
        "Track apps and projects (takes effect after Save)",
        current.track_projects,
    );
    gtk::grid_attach(form, track_projects, 0, 9, 2);
    let store_titles = gtk::checkbox(
        "Also store sanitized window titles locally",
        current.store_titles,
    );
    gtk::grid_attach(form, store_titles, 0, 10, 2);

    let advanced = gtk::grid(8, 12);
    gtk::grid_attach(advanced, gtk::label("Worker URL"), 0, 0, 1);
    let worker_url = gtk::entry(
        current.effective_worker_url(),
        crate::config::DEFAULT_WORKER_URL,
        false,
    );
    gtk::grid_attach(advanced, worker_url, 0, 1, 1);
    gtk::grid_attach(
        advanced,
        gtk::label("Keep local activity for (days)"),
        0,
        2,
        1,
    );
    let retention = gtk::spin(
        7.0,
        3650.0,
        1.0,
        current.activity_retention_days.max(7) as f64,
        0,
    );
    gtk::grid_attach(advanced, retention, 0, 3, 1);
    gtk::pack(page, gtk::expander("Advanced settings", advanced), false);

    gtk::dialog_button(dialog, "Cancel", gtk::RESPONSE_CANCEL);
    gtk::dialog_button(dialog, "Save", gtk::RESPONSE_ACCEPT);
    gtk::dialog_default(dialog, gtk::RESPONSE_ACCEPT);

    let response = gtk::dialog_run_modal(dialog);
    let update = if response == gtk::RESPONSE_ACCEPT {
        let token_field = gtk::entry_text(token).trim().to_string();
        let track_projects = gtk::checked(track_projects);
        Some(Update {
            config: Config {
                worker_url: gtk::entry_text(worker_url).trim().to_string(),
                bearer_token: if token_field.is_empty() {
                    current.bearer_token.clone()
                } else {
                    token_field
                },
                idle_timeout_secs: gtk::spin_value(idle).round() as u64 * 60,
                target_hours: gtk::spin_value(target),
                work_start: gtk::entry_text(work_start).trim().to_string(),
                work_end: gtk::entry_text(work_end).trim().to_string(),
                work_days: days
                    .iter()
                    .zip(DAYS)
                    .filter(|(button, _)| gtk::checked(**button))
                    .map(|(_, day)| day.to_string())
                    .collect(),
                track_projects,
                store_titles: track_projects && gtk::checked(store_titles),
                activity_retention_days: gtk::spin_value(retention).round() as i64,
            },
            autostart: gtk::checked(start_at_login),
        })
    } else {
        None
    };
    gtk::destroy(dialog);
    update
}
