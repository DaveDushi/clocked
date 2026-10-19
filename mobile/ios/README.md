# Clocked for iPhone

A native SwiftUI app that measures time spent in the work apps you choose, using Apple's Screen Time APIs, and syncs one number per day to your Clocked dashboard. It works in every region.

## What it measures, and what it does not

Apple does not let apps read Screen Time usage directly outside the EU, so the app uses the parts that work everywhere:

1. **FamilyControls** (individual authorization) and **FamilyActivityPicker**. You choose apps, categories, and websites. The app only ever holds opaque tokens.
2. **DeviceActivityMonitor**. For each of the next 7 days the app registers a separate, non-repeating schedule for that day only (from 00:00, or the next minute for today, to 23:59), each with 48 threshold events at 15, 30, … 720 minutes of combined use and `includesPastActivity: false`. The activity name carries the selection, the day, and the start instant, so every callback says which day it measured. The monitor extension writes each callback (activity name, threshold name, time, time zone) to a file in the App Group. It never sees app identities.
3. **DeviceActivityReport**. A report extension shows Apple's exact Screen Time total for the chosen apps inside the app. It runs in Apple's sandbox: it has no App Group, no network, and nothing in it reaches the app or the server.

The synced number is a **quantized lower bound**: "at least N × 15 minutes today". It is not a timesheet:

- There are no start or end times, so it cannot be merged with desktop or Android sessions. It goes to `POST /mobile/usage` and the dashboard shows it separately from billable time. The app never calls `/sessions` and never invents intervals.
- Only `{id, device_id, platform: "ios", day, timezone, selection_id, duration_seconds}` is sent. App names, bundle IDs, tokens, and per-app times stay on the phone.

## Accounting rules

All of these live in `ClockedCore` and are covered by tests.

| Situation | Behavior |
| --- | --- |
| Threshold `m` fires | Shows at least `m` minutes of use in that registration's window: from the later of local midnight and the registration start, to the end of its named day. |
| Threshold fires too early | Ignored if less wall time than `m` has passed since the window start. This catches the iOS 26 defect where thresholds fire seconds after registration ([forum thread](https://developer.apple.com/forums/thread/808470)). An early callback that still fits the elapsed time cannot be detected. The UI says so. |
| Callback delivered late | Counted for the day in its activity name, never for the delivery day. More than 6 hours after its day ended it is quarantined and shown as ignored. |
| Duplicate or out-of-order callbacks | The first delivery of each callback is kept. Results are recomputed from scratch, so order does not matter. |
| Several registrations of one day | Re-registration (time zone change, regained access) can measure the same minutes twice, so values are never added. The day keeps the largest single value. This can undercount and never adds the same minutes twice. |
| Work apps changed | If the current choice already has counted time today, the new choice starts at local midnight: future days are re-registered at once, today keeps its registration. Otherwise it replaces today's choice. Each day has one registered choice and past days keep their label. The one exception is renewing voided tokens, below. An empty choice stops monitoring. |
| Time zone change | All upcoming registrations are replaced in the new zone. Each zone gets its own series ID (`<uuid>-z<fnv1a32(zone)>`), so the server never sees a bucket change zone. On a travel day the app and dashboard both show the larger series, not the sum. |
| Access revoked | Apple voids the chosen app tokens. Monitoring stops and after access returns the app asks for a new choice before registering anything. The old selection keeps its ID and keeps owning every day it measured, including today: a fresh choice on the same day adds a second series instead of replacing the first, and the phone and server show the larger. Anything other than "approved" counts as no access. |
| Revocation while the app was closed | Not directly observable. Two cases are treated as possible revocation and require a fresh choice: registrations for today or later have vanished, or the whole registration horizon ended before the app ran again. Revocation and regrant that both happen while registrations are still live and still present are not detected. |
| Concurrent refreshes | Discovery, planning, registration changes, and saving the registry run in one engine call with no suspension point, so foreground, background, and selection refreshes are serialized and never act on a stale plan. |
| App not opened for a week | Registrations run out after the 7-day horizon and nothing more is measured until the app runs (foreground or background refresh). Because revocation in that gap cannot be ruled out, the app then asks for the work apps again. The UI shows the last monitored day. |
| Late refresh | A registration already running for today is kept however little of the day remains. Only new registrations need the 15-minute minimum. |
| Activity limit | Nearer days are registered first. If Screen Time rejects one, later days wait for the next run and the UI shows the error. |
| Locked phone, reboot | Records use `completeUntilFirstUnlock`. A callback before the first unlock after a reboot can be lost, which only lowers the number. |
| Midnight, DST | Days are local calendar days with their true length (23 or 25 hours). Values are capped at the window they cover. |
| Offline, process death | Snapshots are saved before each request and keep their ID until the server lists it in `accepted`. They are never dropped for age; each series-day keeps only its highest value. Retries back off from 30 s up to 6 h. Cancellation (background expiry) cancels the request and keeps everything. |
| Server declines a snapshot | After 3 declines its series-day is abandoned, with any smaller queued values, so it cannot retry forever. |
| 401, 402, 404 | Upload pauses with a clear message and rechecks every 6 h, or when you tap Sync. |
| New or replaced account | Disconnecting or replacing an account first moves any callbacks still on disk into the ledger, then reserves today, every day it queued, and every day measured on the device. The reservation never moves backwards, so setting the clock back before switching does not release a measured day. The next account starts after the reserved days, so it never receives a day the earlier account measured, queued, or may have had committed without an acknowledgement. A reply that arrives after its account was replaced is dropped. Tokens are stored per account and an upload needs the token of the current account. Disconnecting asks for confirmation and states how many totals will be discarded. |

## Project layout

```
mobile/ios/
  project.yml              XcodeGen spec (app, monitor app-extension, report ExtensionKit extension)
  Config/Clocked.xcconfig  bundle ID, App Group, version; optional Config/Local.xcconfig override
  ClockedCore/             Swift package: accounting, persistence, sync. Foundation only.
  App/                     SwiftUI app, Keychain token store, DeviceActivityCenter bridge
  MonitorExtension/        DeviceActivityMonitor that writes callback records
  ReportExtension/         DeviceActivityReport scene (sandboxed, display only)
  scripts/validate_static.py  plist, entitlement, and source hygiene checks
  scripts/typecheck_bridge.sh  typechecks the Screen Time bridge and monitor against stub SDK modules
  scripts/gen_app_icon.py  renders the app icon
```

## Build and test

Core tests (macOS or Linux, Swift 5.10 or newer). They read `worker/src/mobile-usage.ts` and `worker/test/fixtures/ios-zone-series.json` from this repository to check client output against the server's validation.

```sh
swift test --package-path mobile/ios/ClockedCore
# Without a local toolchain:
docker run --rm -v "$PWD:/repo" -w /repo swift:6.1-noble swift test --package-path mobile/ios/ClockedCore
```

Bridge typecheck (any Swift toolchain, including Linux). It compiles `App/Sources/ScreenTimeMonitoring.swift` and the monitor extension against stub `DeviceActivity`, `FamilyControls`, and `ManagedSettings` modules that copy Apple's documented signatures. It does not replace an Xcode build.

```sh
bash mobile/ios/scripts/typecheck_bridge.sh
```

Static checks (any OS with Python 3):

```sh
python3 mobile/ios/scripts/validate_static.py
```

App build (macOS with Xcode 26):

```sh
brew install xcodegen
cd mobile/ios && xcodegen generate
xcodebuild build -project Clocked.xcodeproj -scheme Clocked -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
```

`.github/workflows/mobile-ios.yml` runs the core tests on Linux and macOS, the bridge typecheck, the static checks, project generation, and an unsigned generic-iOS build. It then checks that the monitor is embedded in `PlugIns/` and the report extension in `Extensions/`.

## Signing and distribution prerequisites

- An Apple Developer team. Set `DEVELOPMENT_TEAM`, and if needed `CLOCKED_BUNDLE_ID` and `CLOCKED_APP_GROUP`, in `Config/Local.xcconfig`.
- Register the App Group (`group.com.daviddusi.clocked` by default) for the app and the monitor extension.
- **Family Controls (Distribution)** must be requested from Apple separately for the app, the monitor extension, and the report extension before TestFlight or App Store. Development signing works without approval.
- The report extension must stay an ExtensionKit extension in `Extensions/` with `EXAppExtensionAttributes` and no `NSExtension` keys. Otherwise device install or App Store validation fails ([forum thread](https://developer.apple.com/forums/thread/809227)).
- The EU-only `com.apple.developer.family-controls.app-and-website-usage` entitlement is deliberately not used. It is not needed for aggregate time, and developers report that adding it changes the permission prompt for every user to all-or-nothing.

## Limits

- Not yet built or run on a Mac or device. The core package was tested on Linux; the bridge was typechecked against stub modules; the project was generated with XcodeGen on Linux. SwiftUI views, the report extension, and the iOS SDK link step compile only in CI or on a Mac.
- Day-specific one-shot schedules use full date components with `repeats: false`. Apple documents the initializer but not this use explicitly. It needs confirmation on a device, along with 7 activities of 48 events each.
- Screen Time decides when callbacks arrive. Uploads happen when the app opens or iOS runs background refresh, so the dashboard can lag. Background refresh is not guaranteed to run at all.
- Thresholds stop at 12 hours a day. The last minute of each day is not monitored.
- Changing work apps before the first 15-minute step of the day replaces today's owner; the minutes before the change are lost rather than counted twice.
- Detecting revocation that happened while the app was closed relies on Screen Time removing the app's registrations, or on the horizon ending first. If iOS keeps live registrations through a revoke and regrant, the void tokens are only noticed after an observed denial.
- Account reservation covers callbacks on the device when the account changes. A callback measured under the old account but delivered by iOS after the switch, with the clock set back across that day, can still be attributed to the new account.
