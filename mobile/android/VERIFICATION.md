# Android verification record

Verified in this checkout on 2026-10-20 using Windows PowerShell. This record supersedes the first-review build evidence. No emulator or physical device was used. No live account token was available, so no end-to-end server upload was attempted.

## Tools and commands

Downloaded Eclipse Temurin JDK 17.0.20.1 through the official Adoptium binary endpoint and Android command-line tools from Google's SDK repository. Installed Android platform 35, build tools 35.0.0, and platform tools through `sdkmanager`. Local tool downloads live under ignored `.tools/`.

From the repository root:

```powershell
$env:JAVA_HOME = (Get-ChildItem mobile/android/.tools/jdk -Directory | Select-Object -First 1).FullName
$env:ANDROID_HOME = (Resolve-Path mobile/android/.tools/sdk).Path
& mobile/android/gradlew.bat -p mobile/android --no-daemon --rerun-tasks testDebugUnitTest lintDebug assembleDebug
& mobile/android/.tools/sdk/build-tools/35.0.0/apksigner.bat verify --verbose mobile/android/app/build/outputs/apk/debug/app-debug.apk
& mobile/android/.tools/sdk/build-tools/35.0.0/aapt2.exe dump badging mobile/android/app/build/outputs/apk/debug/app-debug.apk
& mobile/android/scripts/check-aosp.ps1
# Focused platform model and timestamp-owner census:
& mobile/android/gradlew.bat -p mobile/android testDebugUnitTest --tests app.clocked.mobile.PlatformModelTest
```

The included wrapper JAR SHA-256 matches the official Gradle 8.11.1 checksum endpoint:

`2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`

## Results

- Final second-review Gradle run: `BUILD SUCCESSFUL`, 51 actionable tasks, all 51 executed with `--rerun-tasks`, 51 seconds with populated dependency caches.
- JVM tests: 60 passed, zero failures, errors, or skipped tests. `PlatformModelTest` has 22 tests, `CollectionPolicyTest` has 11, `SyncEngineTest` has 5, `HttpUploadTest` has 1, `TimelineTest` has 12, `ProtocolTest` has 5, and `AccountQueueTest` has 4. The platform model also executes a 24-case literal correction matrix and a four-case startup-order table inside those methods. Tests run without Android stub default-return behavior.
- Android lint: zero errors, four dependency-update warnings. Dependency versions remain pinned to the successfully built set. There are no remaining application-icon, data-extraction-rule, or Kotlin-extension warnings.
- APK assembly: succeeded. `apksigner verify` reports a valid v2 signature and one development signer.
- APK manifest inspection: package `app.clocked.mobile`, version `1.0.0`, minimum API 29, target and compile API 35, launcher label `Clocked`, usage-stats permission present.
- Final APK SHA-256: `c921add03e74e5a5f8277b13a18ae429118ab60576b62f19e0f0de130dbfb637`. This supersedes the initial and first-review APK hashes. The development signing key and subsequent builds can change this checksum.
- Protocol privacy test asserts the exact six session fields. Package names, app labels, selections, and per-app durations have no upload field.
- Read the actual tracking, persistence, UI, and transport code after implementation. Source changes stay within `mobile/android/**` and `.github/workflows/mobile-android.yml`. No commit was created.

## Second-review evidence

Before production edits, the failed premise and timestamp-owner census were recorded in `REVIEW-2-RESOLUTION.md`. The new platform-model fixture then ran against the previous code: eight methods executed, seven appendix assertions failed. Its census reproduced the skew: AOSP events moved by -90 seconds while the app's open start and finite selection/zone boundaries remained unchanged. The original cutoff and selection-tail fixes still have their production regressions.

The repaired platform model invokes the production collector and the guarded source adapter. All seven appendix sequences now assert literal intervals, not log-only output. The -90-second shifted-history fixture produces `[3510s,7080s)`, 3,570 seconds, with no personal-hour overcount. The +10-minute shifted-history fixture produces two separate visits totaling 4,170 seconds. Secure/non-secure pre-startup gates, unlock on either side of STARTUP, a swipe lock, RESUME before STARTUP, pending startup split across collections, repeated reboot, pre-cursor synthesized shutdown, and the 102-hour retained-close case pass.

The literal correction matrix covers both shifted AOSP and unshifted OEM models at both signs of 1,999/2,000/2,001 and 119,999/120,000/120,001 milliseconds. Other fixtures exercise accumulated sub-threshold corrections, private frame patterns, ambiguous/missing/lone markers, immutable pending/synced payloads, moving finite selection/zone boundaries exactly once, a selection made between a jump and probe, and a query-triggered rewrite rejected before cursor consumption. Old fixtures that assumed fixed timestamps or reversed boot order were removed or replaced.

The final census is `app/build/reports/platform-model-census.tsv`. The unemitted open start moves from `1800003600000` to `1800003510000`; finite selection/zone entries move from `1800007170000` to `1800007080000`; the completed payload's start stays `1800000001000`. The cursor subsequently advances in the corrected frame. The AOSP source checker was run successfully against official Android 14 sources and the Android 15/16 startup/time paths. Its local output is `app/build/reports/aosp-source-check.txt`, and the source hashes are listed in `REVIEW-2-RESOLUTION.md`.

The sync suite changes the account while a request waits outside the lock, verifies no new-account queue or status mutation from the old response, and changes the account between capture and initiation to verify that no old request starts. It also checks partial acceptance, stable retry rows, rejected-row rotation, stale deletion consent and `MODE_DEFAULT`. The HTTP test uses the actual OkHttp transport with a deliberately blocked injected DNS resolver and a shortened caller deadline. No request reaches a server in that test. Production uses a 40-second call timeout and a 45-second caller deadline.

Final lint has no protected-broadcast receiver warning after adding explicit action validation. Its remaining four warnings concern newer dependency versions. Android's development package still includes an unstripped Compose graphics native library; packaging and signature verification succeeded.

`REVIEW-2-RESOLUTION.md` lists the second review's resolved findings, source basis, ownership decisions and remaining limits. The original review reports remain unchanged. The first response is marked superseded for reboot/clock/long-gap behavior. CI action references remain pinned to upstream commit SHAs from the first follow-up.

Reports are in `app/build/reports/tests/testDebugUnitTest/` and `app/build/reports/lint-results-debug.html`. The APK is `app/build/outputs/apk/debug/app-debug.apk`. These generated files are ignored locally and published as artifacts by Android CI. The GitHub Actions workflow itself has not been run from this checkout.

## Still requires a physical device

Verify the permission-settings flow, actual selected-app event delivery, lock and unlock transitions, multiple activity classes and split-screen, Keystore persistence through process death, post-reboot unlock, AppOps revocation, manufacturer battery policies, offline retry, and a real dashboard upload. The unit tests exercise deterministic event and protocol behavior, not Android services.

Important limits are documented in `README.md` and `REVIEW-2-RESOLUTION.md`. Missing task identity, absent/ambiguous frame proof and unobserved permission changes remain unsupported facts. Conservative frame boundaries can omit valid work in the uncertain window; no time is inferred across it. Completed rows are never retimed, so past exported clock errors and cross-device UTC placement cannot be repaired retrospectively under this protocol. Work-profile behavior, accessible rows, real fingerprint patterns, clock broadcasts, persistence and OEM event ordering still require a phone. No claim of reliable hardware behavior follows from the source-derived fixtures. Release signing and store submission remain separate release work.
