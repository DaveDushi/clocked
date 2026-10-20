#!/usr/bin/env bash
# Typechecks the app's Screen Time bridge and the monitor extension on any
# Swift toolchain (including Linux) against stub modules that copy Apple's
# documented signatures. It catches misuse of ClockedCore and of those API
# shapes. It is not a substitute for an Xcode build against the iOS SDK.
set -euo pipefail
ios="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Sources/ManagedSettings" "$work/Sources/FamilyControls" "$work/Sources/DeviceActivity" "$work/Sources/AppCheck" "$work/core"
cp -r "$ios/ClockedCore/Package.swift" "$ios/ClockedCore/Sources" "$work/core/"
for m in ManagedSettings FamilyControls DeviceActivity; do cp "$ios/scripts/sdk-stubs/$m.swift" "$work/Sources/$m/"; done
cp "$ios/App/Sources/ScreenTimeMonitoring.swift" "$ios/MonitorExtension/ClockedMonitor.swift" "$work/Sources/AppCheck/"
cat > "$work/Package.swift" <<'SPEC'
// swift-tools-version:5.10
import PackageDescription
let package = Package(
    name: "BridgeCheck",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "core")],
    targets: [
        .target(name: "ManagedSettings"),
        .target(name: "FamilyControls", dependencies: ["ManagedSettings"]),
        .target(name: "DeviceActivity", dependencies: ["ManagedSettings"]),
        .target(name: "AppCheck", dependencies: ["DeviceActivity", "FamilyControls", "ManagedSettings",
                                                 .product(name: "ClockedCore", package: "core")]),
    ]
)
SPEC
cd "$work" && swift build -Xswiftc -warnings-as-errors
echo "Bridge typecheck passed (stub SDK modules)."
