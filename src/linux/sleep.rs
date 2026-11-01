//! logind's delay inhibitor gives the UI time to close and upload before sleep.

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedFd;

pub(super) struct Request {
    pub deadline: Instant,
    pub done: Sender<()>,
}

pub(super) fn start(wake_ui: impl Fn() + Send + 'static) -> Receiver<Request> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        if let Err(error) = monitor(sender, wake_ui) {
            crate::logln!(
                "pre-sleep notifications unavailable: {error}; periodic sync remains active"
            );
        }
    });
    receiver
}

fn inhibit(proxy: &Proxy<'_>) -> zbus::Result<OwnedFd> {
    proxy.call(
        "Inhibit",
        &("sleep", "clocked", "Save and upload worked time", "delay"),
    )
}

fn monitor(sender: Sender<Request>, wake_ui: impl Fn()) -> Result<(), Box<dyn std::error::Error>> {
    let connection = Connection::system()?;
    let proxy = Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    let signals = proxy.receive_signal("PrepareForSleep")?;
    let mut inhibitor = Some(inhibit(&proxy)?);
    for signal in signals {
        let (sleeping,): (bool,) = signal.body().deserialize()?;
        if sleeping {
            let (done, acknowledged) = mpsc::channel();
            sender.send(Request {
                deadline: Instant::now() + Duration::from_secs(3),
                done,
            })?;
            wake_ui();
            let _ = acknowledged.recv_timeout(Duration::from_secs(3));
            // Releasing the fd lets logind finish sleeping, including when offline.
            drop(inhibitor.take());
        } else {
            inhibitor = Some(inhibit(&proxy)?);
        }
    }
    Err("logind sleep signal stream ended".into())
}
