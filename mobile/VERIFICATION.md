# Mobile verification

Evidence collected on 2026-10-20. No emulator or physical phone was used.

## iPhone

The [native iOS workflow](https://github.com/DaveDushi/clocked/actions/runs/39334598834) passed on source snapshot `6338190aba07705d966c0c6f7c67e926f6ac7d87`, including the final pruning fixes.

- Xcode 26.6, build 17F113, compiled the app and both extensions for generic iOS with SDK 26.5.
- All 93 Swift core tests passed on macOS and Linux.
- Static validation, the supplementary bridge typecheck, and generated bundle layout checks passed.
- The monitor is in `Clocked.app/PlugIns/ClockedMonitor.appex`. The report is in `Clocked.app/Extensions/ClockedReport.appex`.
- CI published `clocked-ios-unsigned-app`. The downloaded `ios/Clocked-unsigned.app.zip` contains all three native executables and their expected bundle identifiers.
- Archive SHA-256: `b2cca85992496b306fa7bf4a675dce2c1bd8937881bb507f542c5f259b03b585`.

The first Xcode run failed on an incorrect Foundation file-protection option. The successful run includes that correction. Linux core tests alone did not detect the SDK error.

The archive is unsigned. Installation requires your Apple Developer team, registered App Group, and appropriate Family Controls provisioning. Distribution requires Apple's entitlement approval. The build does not establish permission behavior, actual usage callbacks, report rendering, background delivery, or installation success.

iOS uploads aggregate threshold measurements in 15-minute steps. These are separate from exact timesheet totals. The app registers a seven-day monitoring horizon and requires a new selection if that horizon expires without a refresh. Re-registration can undercount because overlapping measurements use a maximum.

## Android

The final local Windows build passed 67 tests, Android lint, APK assembly, and APK signature verification. The forced run executed all 51 Gradle tasks. Lint reported four dependency-update warnings and no errors. The parent read the final JUnit XML and independently verified the APK signature.

The final [Android workflow](https://github.com/DaveDushi/clocked/actions/runs/39335312446) passed on Linux at snapshot `3bffeec11bd99938ddbaf4e9b07e6a78316692a1`. CI published `clocked-android-debug-apk`. The parent downloaded the reports and verified 67 tests with zero failures or errors. The downloaded APK at `android/app/build/ci-final-apk/app-debug.apk` has a valid v2 development signature. Its SHA-256 is `104c5addb0f05b6690e66fa609c40a216925cf128aaa98f0bac240159076adee`. CI and Windows use different development signing keys, so their APK hashes differ.

The final local debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Its SHA-256 is `23cf0418be1d55bebd67b85216ac7ad4329e4612eb59bb9bc1ef122f6e30bc01`.

The tests include source-derived AOSP boot ordering, shifted and unshifted event histories, the review's clock-correction reproductions, pending fast-boot boundaries across encrypted reloads, offline retries, account races, and union accounting. See [Android verification](android/VERIFICATION.md) for commands and evidence.

Android permission screens, Keystore behavior, manufacturer event delivery, work profiles, battery restrictions, and live uploads remain untested on a phone. Missing or ambiguous events can prevent exact reconstruction. Completed session payloads remain immutable across clock corrections.

## Dashboard backend

The [backend workflow](https://github.com/DaveDushi/clocked/actions/runs/39333651748) passed on source snapshot `4cba9ffe4f4553f93c6bb5eca43ccaaf9ebe37a6`. Type checking, all 62 tests, production bundling, and the workerd test with local D1 passed. The parent also ran the production verification locally.

The runtime check submits overlapping desktop and Android sessions and verifies a 240-minute union. A separate 1,200-second iOS measurement does not increase those exact minutes. The check also exercises authenticated routes, concurrent snapshot retries, account isolation, CSV export, deletion, and token revocation.

The production Worker has not been deployed. Migration `worker/migrations/0018_mobile_usage.sql` and all preceding migrations must be applied before this Worker version serves requests. See [backend protocol](../worker/MOBILE_SYNC.md).

## Reproduce the checks

From the repository root, run `node mobile/verify.mjs worker android ios-core`. The verifier uses the actual Worker, Gradle project, and Swift package. Install the prerequisites in the platform READMEs first.

On macOS with Xcode and XcodeGen, run `node mobile/verify.mjs ios-build`. With no scope arguments the verifier runs every scope and reports an unavailable Xcode build as a failure.

The verification branch is [t3/verify-native-ios-20261020](https://github.com/DaveDushi/clocked/tree/t3/verify-native-ios-20261020). It contains build snapshots. The current local branch and staging area were preserved.

The parent compared the final app and Worker source files with the build snapshots. They match. Independent Opus 5.5 and Sol 6.1 reviews produced the reproductions recorded in the platform review files. Every actionable finding was fixed with a production-path regression test; the original reports remain available beside their resolution records.
