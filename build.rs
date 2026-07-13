//! Embed the application icon into the executable so it shows in Explorer,
//! Alt-Tab, and (loaded at runtime) the system tray. Icon resource id = 1.
//! Also embeds a manifest opting into Common-Controls v6 for themed widgets.

fn main() {
    #[cfg(windows)]
    {
        // Only embed Windows resources when the *target* is Windows. On a Windows
        // host cross-checking a macOS target, skip it (winresource would warn).
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
            return;
        }
        println!("cargo:rerun-if-changed=assets/clocked.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon_with_id("assets/clocked.ico", "1");
        // Opt into Common-Controls v6 so buttons/checkboxes/edits get the
        // modern themed (Win10/11) look instead of the classic gray widgets.
        res.set_manifest(MANIFEST);
        if let Err(e) = res.compile() {
            // Don't hard-fail the build if the resource compiler is unavailable;
            // the app falls back to the stock icon at runtime.
            println!("cargo:warning=resource embed skipped: {e}");
        }
    }
}

#[cfg(windows)]
const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;
