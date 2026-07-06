//! Embed the application icon into the executable so it shows in Explorer,
//! Alt-Tab, and (loaded at runtime) the system tray. Icon resource id = 1.

fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=assets/clocked.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon_with_id("assets/clocked.ico", "1");
        if let Err(e) = res.compile() {
            // Don't hard-fail the build if the resource compiler is unavailable;
            // the app falls back to the stock icon at runtime.
            println!("cargo:warning=icon embed skipped: {e}");
        }
    }
}
