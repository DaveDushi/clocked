; Inno Setup script for Clocked - a per-user install (no admin required).
;
; Build via ..\build-installer.ps1 (recommended), which compiles the release
; exe and passes the version from Cargo.toml as MyAppVersion. You can also run
; ISCC directly: ISCC.exe /DMyAppVersion=0.1.0 clocked.iss
;
; Requires Inno Setup 6: winget install JRSoftware.InnoSetup

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "Clocked"
#define MyAppExeName "clocked.exe"
#define MyAppPublisher "David D"

[Setup]
; AppId uniquely identifies the app for upgrades/uninstall - keep it constant.
AppId={{8F3A1C2E-5B4D-4E9A-9C7F-2A1B3C4D5E6F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install: lowest privileges, so {autopf} resolves to
; %LOCALAPPDATA%\Programs and no admin prompt appears.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=clocked-setup-{#MyAppVersion}
SetupIconFile=..\assets\clocked.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start-menu shortcut - this is what Windows search indexes.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; The app registers its own autostart under HKCU\...\Run (tray toggle). Remove
; it on uninstall so Windows doesn't try to launch a deleted exe at login.
Filename: "{sys}\reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v clocked /f"; Flags: runhidden; RunOnceId: "DelClockedAutostart"

; Note: user data in %APPDATA%\clocked (db, config, log) is intentionally left
; in place on uninstall so a reinstall keeps history.
