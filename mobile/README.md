# Clocked mobile

Clocked mobile uses native interfaces and operating-system usage APIs. The Android project is in `android/`; the iPhone project is in `ios/`. Their build and test instructions live in those directories.

## Connect to your dashboard

1. Open your Clocked dashboard and sign in to an account with product access.
2. In Settings, create a separate device token for each phone. Copy the token when it is shown.
3. Enter your dashboard HTTPS origin and device token in the native app.
4. Grant the operating-system usage permission and select the apps you use for work.

The default hosted origin is `https://clocked.daviddusi.com`. Self-hosted installations need the latest Worker migrations before accepting iOS duration snapshots. Native apps do not put device tokens in browser URLs. Revoke a lost phone's token in dashboard Settings.

## Time accounting

Android reconstructs foreground activity intervals from UsageStatsManager events. It sends stable, retryable session records to the same `/sessions` endpoint as the desktop client. Clocked merges overlapping intervals to count elapsed work time once, including simultaneous desktop and Android usage.

Apple's ordinary Screen Time report extension displays usage inside its own sandbox. That data cannot be exported through shared preferences or a network request. Apple's separate data-access authorization and App and Website Usage entitlement support export on eligible EU devices and EU Apple Accounts. The app must handle unavailable access explicitly.

Worldwide iOS monitoring uses threshold callbacks for the combined selected work apps. These measurements are cumulative lower bounds, not exact timestamped work sessions. App selections and per-app identities stay on the phone. Only aggregate work time leaves the device. They use `/mobile/usage` and appear separately in the dashboard. They do not increase billable timesheet totals because Clocked cannot determine their overlap with desktop or Android sessions. Retried snapshots replace the same measurement instead of adding time. Changing selected work apps must not cause historical measurements to be added together.

## Verification limits

Run `node mobile/verify.mjs worker android ios-core` from the repository root for the headless checks available on Windows. Install the Worker dependencies with `npm ci` in `worker` first. Android needs the SDK/JDK described in its README. iOS core tests use a local Swift toolchain or Docker. The script also runs the iOS static checks.

On a Mac with Xcode and XcodeGen, run `node mobile/verify.mjs ios-build` to compile the app and extensions for generic iOS without an emulator. With no arguments the verifier runs every scope and fails if any scope cannot run. An unavailable Xcode build is reported as blocked, never as a passing check.

No emulator or phone is available in this workspace. Deterministic tests can verify event reconstruction, retries, identity, and accounting rules. Headless native builds can verify compiler and packaging correctness. Neither proves that a phone grants permission, delivers background events on schedule, or reports complete usage history.

An iPhone build requires macOS, a compatible Xcode SDK, and Apple provisioning with the required entitlements. Distribution approval and actual Screen Time behavior require an eligible physical device. Android requires a JDK and Android SDK for compilation; usage access and manufacturer background restrictions require device validation. Follow the platform READMEs and mobile CI workflows for reproducible checks.

## Official API references

- [Android UsageStatsManager](https://developer.android.com/reference/android/app/usage/UsageStatsManager)
- [Android usage event lifecycle](https://developer.android.com/reference/android/app/usage/UsageEvents.Event)
- [Apple DeviceActivityReport sandbox](https://developer.apple.com/documentation/deviceactivity/deviceactivityreport)
- [Apple supported device activity export](https://developer.apple.com/documentation/deviceactivity/deviceactivitydata/activitydata(filteredby:using:))
- [Apple data-access authorization and EU availability](https://developer.apple.com/documentation/familycontrols/authorizationstatus/approvedwithdataaccess)
- [Apple App and Website Usage entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.family-controls.app-and-website-usage)

