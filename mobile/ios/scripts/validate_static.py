"""Static checks for the iOS project that run anywhere (no Xcode needed).

    py mobile/ios/scripts/validate_static.py

Verifies that project.yml references real files, plists parse and declare the
right extension points, entitlements match each target's role, the report
extension cannot share data, and sources never log or put the device token in
URLs. Exit code 1 on any failure.
"""
import plistlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
failures: list[str] = []


def check(ok: bool, message: str) -> None:
    if not ok:
        failures.append(message)


def plist(rel: str) -> dict:
    path = ROOT / rel
    check(path.exists(), f"missing {rel}")
    if not path.exists():
        return {}
    try:
        return plistlib.loads(path.read_bytes())
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{rel} does not parse: {exc}")
        return {}


# project.yml: every referenced path exists.
spec = (ROOT / "project.yml").read_text(encoding="utf-8")
for ref in re.findall(r"(?:path|INFOPLIST_FILE|CODE_SIGN_ENTITLEMENTS):\s*([\w./-]+)", spec):
    check((ROOT / ref).exists(), f"project.yml references missing path {ref}")
check("type: extensionkit-extension" in spec, "report extension must be an ExtensionKit extension")
check("type: app-extension" in spec, "monitor extension must be an app extension")
for cfg in re.findall(r"(?:Debug|Release):\s*(Config/[\w.]+)", spec):
    check((ROOT / cfg).exists(), f"missing xcconfig {cfg}")

# App
app = plist("App/Info.plist")
check(app.get("ClockedAppGroup") == "$(CLOCKED_APP_GROUP)", "app Info.plist must expose ClockedAppGroup")
check("$(PRODUCT_BUNDLE_IDENTIFIER).refresh" in app.get("BGTaskSchedulerPermittedIdentifiers", []),
      "app must permit the refresh BGTask identifier")
check("fetch" in app.get("UIBackgroundModes", []), "app needs the fetch background mode")
app_ent = plist("App/Clocked.entitlements")
check(app_ent.get("com.apple.developer.family-controls") is True, "app needs Family Controls")
check(app_ent.get("com.apple.security.application-groups") == ["$(CLOCKED_APP_GROUP)"], "app needs the App Group")
check("com.apple.developer.family-controls.app-and-website-usage" not in app_ent,
      "the EU data-access entitlement changes the permission prompt for everyone; it is intentionally not used")

# Monitor extension
mon = plist("MonitorExtension/Info.plist")
ext = mon.get("NSExtension", {})
check(ext.get("NSExtensionPointIdentifier") == "com.apple.deviceactivity.monitor-extension", "monitor extension point")
check(ext.get("NSExtensionPrincipalClass") == "$(PRODUCT_MODULE_NAME).ClockedMonitor", "monitor principal class")
check(mon.get("ClockedAppGroup") == "$(CLOCKED_APP_GROUP)", "monitor Info.plist must expose ClockedAppGroup")
mon_ent = plist("MonitorExtension/ClockedMonitor.entitlements")
check(mon_ent.get("com.apple.developer.family-controls") is True, "monitor needs Family Controls")
check(mon_ent.get("com.apple.security.application-groups") == ["$(CLOCKED_APP_GROUP)"], "monitor needs the App Group")
check("class ClockedMonitor: DeviceActivityMonitor" in (ROOT / "MonitorExtension/ClockedMonitor.swift").read_text(encoding="utf-8"),
      "principal class not found")

# Report extension: ExtensionKit attributes only, and no way to share data.
rep = plist("ReportExtension/Info.plist")
check(rep.get("EXAppExtensionAttributes", {}).get("EXExtensionPointIdentifier") == "com.apple.deviceactivityui.report-extension",
      "report extension point")
check("NSExtension" not in rep, "report extension must not declare NSExtension keys (device install fails)")
rep_ent = plist("ReportExtension/ClockedReport.entitlements")
check(rep_ent.get("com.apple.developer.family-controls") is True, "report needs Family Controls")
check("com.apple.security.application-groups" not in rep_ent, "report extension must not have an App Group")
report_src = (ROOT / "ReportExtension/ClockedReport.swift").read_text(encoding="utf-8")
for banned in ("UserDefaults", "FileManager", "URLSession", "ClockedCore", "Keychain"):
    check(banned not in report_src, f"report extension must not use {banned}")
check('Self("Total Activity")' in report_src, "report context name")
check('Self("Total Activity")' in (ROOT / "App/Sources/ContentView.swift").read_text(encoding="utf-8"),
      "app and report contexts must match")

# Asset catalog
icon = ROOT / "App/Resources/Assets.xcassets/AppIcon.appiconset"
check((icon / "AppIcon.png").exists(), "app icon image missing")

# Secrets hygiene across all Swift sources.
swift = list(ROOT.glob("App/**/*.swift")) + list(ROOT.glob("MonitorExtension/*.swift")) + list(ROOT.glob("ClockedCore/Sources/**/*.swift"))
for f in swift:
    text = f.read_text(encoding="utf-8")
    rel = f.relative_to(ROOT)
    check(not re.search(r"\b(print|NSLog|os_log|Logger)\b", text), f"{rel}: no logging, to keep tokens and usage out of logs")
    check("UserDefaults" not in text, f"{rel}: do not store state in UserDefaults")
    check(not re.search(r"queryItems|token=|\?token", text), f"{rel}: token must never be put in a URL")
    check("bundleIdentifier" not in text or rel.name == "AppModel.swift", f"{rel}: app identities must not be read")

# The only place the token goes on the wire is the Authorization header.
proto = (ROOT / "ClockedCore/Sources/ClockedCore/SyncProtocol.swift").read_text(encoding="utf-8")
check('forHTTPHeaderField: "Authorization"' in proto, "token must be sent as a Bearer header")
check("RefuseRedirects" in proto and ".ephemeral" in proto, "uploads must not follow redirects or persist cookies")

if failures:
    print("iOS static validation FAILED:")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print(f"iOS static validation passed ({len(swift)} Swift files checked).")
