// swift-tools-version:5.10
import PackageDescription

// Platform-neutral accounting, persistence, and sync logic shared by the app and
// the Device Activity monitor extension. It depends only on Foundation so the
// tests run on Linux as well as macOS.
let package = Package(
    name: "ClockedCore",
    platforms: [.iOS("17.4"), .macOS(.v13)],
    products: [
        .library(name: "ClockedCore", targets: ["ClockedCore"]),
    ],
    targets: [
        .target(name: "ClockedCore"),
        .testTarget(name: "ClockedCoreTests", dependencies: ["ClockedCore"]),
    ]
)
