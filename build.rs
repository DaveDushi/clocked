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

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
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
    let protocol_o = out.join("ext-idle-notify-v1-protocol.o");
    let idle_o = out.join("clocked-idle-wayland.o");
    let archive = out.join("libclocked_idle_wayland.a");

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

    let cflags = Command::new("pkg-config")
        .args(["--cflags", "wayland-client"])
        .output()
        .expect("run pkg-config for wayland-client");
    if !cflags.status.success() {
        panic!("wayland-client development files are required to build clocked on Linux");
    }
    let flags = String::from_utf8_lossy(&cflags.stdout);

    let mut protocol_cc = Command::new("cc");
    protocol_cc
        .arg("-fPIC")
        .arg("-I")
        .arg(&out)
        .args(flags.split_whitespace())
        .arg("-c")
        .arg(&protocol_c)
        .arg("-o")
        .arg(&protocol_o);
    run(&mut protocol_cc, "compile Wayland idle protocol");

    let mut idle_cc = Command::new("cc");
    idle_cc
        .args(["-std=c11", "-fPIC", "-pthread"])
        .arg("-I")
        .arg(&out)
        .args(flags.split_whitespace())
        .arg("-c")
        .arg("src/linux/idle_wayland.c")
        .arg("-o")
        .arg(&idle_o);
    run(&mut idle_cc, "compile clocked Wayland idle monitor");

    run(
        Command::new("ar")
            .arg("crs")
            .arg(&archive)
            .arg(&protocol_o)
            .arg(&idle_o),
        "archive clocked Wayland idle monitor",
    );

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=clocked_idle_wayland");
    println!("cargo:rustc-link-lib=dylib=wayland-client");
    println!("cargo:rustc-link-lib=dylib=pthread");
}

fn run(command: &mut std::process::Command, what: &str) {
    let status = command
        .status()
        .unwrap_or_else(|e| panic!("failed to {what}: {e}"));
    assert!(status.success(), "failed to {what}");
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
