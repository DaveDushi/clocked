//! "Keep clocked running": relaunch the app so quitting or locking doesn't leave
//! you untracked. Windows-only — a per-user Scheduled Task triggered at logon
//! **and on unlock**. On macOS the LaunchAgent's `KeepAlive` (see `autostart`)
//! provides the equivalent, so this module isn't compiled there.

pub use windows_impl::{disable, enable, is_enabled};

mod windows_impl {
    //! The unlock trigger isn't expressible through `schtasks` flags, so we import
    //! a task XML. With the app's single-instance guard and the task's `IgnoreNew`
    //! policy, the task is a no-op whenever clocked is already running.

    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const TASK_NAME: &str = "clocked-keepalive";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
        Command::new("schtasks")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    /// True if the keep-alive task is installed.
    pub fn is_enabled() -> bool {
        schtasks(&["/query", "/tn", TASK_NAME])
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Remove the task (no error if it doesn't exist).
    pub fn disable() -> std::io::Result<()> {
        if !is_enabled() {
            return Ok(());
        }
        schtasks(&["/delete", "/tn", TASK_NAME, "/f"]).map(|_| ())
    }

    /// Install/replace the task pointing at the current executable.
    pub fn enable() -> std::io::Result<()> {
        let exe = std::env::current_exe()?;
        let xml = task_xml(&exe.display().to_string());
        let path = std::env::temp_dir().join("clocked-keepalive.xml");
        write_utf16(&path, &xml)?;
        let out = schtasks(&[
            "/create",
            "/tn",
            TASK_NAME,
            "/xml",
            &path.display().to_string(),
            "/f",
        ])?;
        let _ = std::fs::remove_file(&path);
        if out.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ))
        }
    }

    /// schtasks wants a UTF-16 file matching the XML declaration.
    fn write_utf16(path: &std::path::Path, s: &str) -> std::io::Result<()> {
        let mut bytes = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for u in s.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(path, bytes)
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn task_xml(exe: &str) -> String {
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(d), Ok(u)) => format!("{d}\\{u}"),
            _ => std::env::var("USERNAME").unwrap_or_default(),
        };
        let user = xml_escape(&user);
        let exe = xml_escape(exe);
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Relaunch clocked at logon and on unlock so tracking keeps running.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <StateChange>SessionUnlock</StateChange>
      <UserId>{user}</UserId>
    </SessionStateChangeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
    </Exec>
  </Actions>
</Task>
"#
        )
    }
}
