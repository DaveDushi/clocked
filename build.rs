//! Embed the application icon into the executable so it shows in Explorer,
//! Alt-Tab, and (loaded at runtime) the system tray. Icon resource id = 1.
//! Also embeds a manifest opting into Common-Controls v6 for themed widgets.

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
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

    if target_os == "linux" {
        build_linux_idle_monitor();
    }
}

/// Generate the ext-idle-notify client protocol and compile the tiny Wayland
/// shim used by `src/idle.rs`. Keeping this in C avoids pulling an entire GUI or
/// Wayland binding stack into the otherwise small native binary.
fn build_linux_idle_monitor() {
    use std::path::PathBuf;
    use std::process::Command;

    const PROTOCOL: &str =
        "/usr/share/wayland-protocols/staging/ext-idle-notify/ext-idle-notify-v1.xml";

    println!("cargo:rerun-if-changed=src/linux/idle_wayland.c");
    println!("cargo:rerun-if-changed={PROTOCOL}");

    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let header = out.join("ext-idle-notify-v1-client-protocol.h");
    let protocol_c = out.join("ext-idle-notify-v1-protocol.c");

    run(
        Command::new("wayland-scanner")
            .args(["client-header", PROTOCOL])
            .arg(&header),
        "generate Wayland idle protocol header",
    );
    run(
        Command::new("wayland-scanner")
            .args(["private-code", PROTOCOL])
            .arg(&protocol_c),
        "generate Wayland idle protocol code",
    );

    let wayland = pkg_config::Config::new()
        .atleast_version("1.20")
        .probe("wayland-client")
        .expect("wayland-client development files are required to build clocked on Linux");

    let mut build = cc::Build::new();
    build
        .file(&protocol_c)
        .file("src/linux/idle_wayland.c")
        .include(&out)
        .includes(wayland.include_paths)
        .flag_if_supported("-std=c11")
        .flag_if_supported("-pthread")
        .compile("clocked_idle_wayland");
}

fn run(command: &mut std::process::Command, what: &str) {
    let status = command
        .status()
        .unwrap_or_else(|e| panic!("failed to {what}: {e}"));
    assert!(status.success(), "failed to {what}");
}

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
