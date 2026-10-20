# Independent iPhone implementation review

Reviewed 2026-10-19 against the files in this worktree. One reviewer, no delegation. Only this review file was written in the repository. No implementation changes or commits.

The implementation is not ready to be described as a working iPhone app. Account isolation and authorization recovery have defects. The Foundation tests pass, but the app and extensions have not been compiled with Xcode or exercised on a physical iPhone in this review.

## Severity-ranked findings

### 1. P1: replacing an account transfers its unacknowledged measurements to the new account

Locations: `ClockedCore/Sources/ClockedCore/UsageEngine.swift:129-140`, `:176-184`, `:201-217`; `ClockedCore/Sources/ClockedCore/UsageOutbox.swift:139-143`; `App/Sources/AppModel.swift:128-134`.

The account owns an outbox, but the underlying ledger is device-wide. A new account's start date depends only on the last acknowledged upload date. Deleting the old outbox does not prevent its measurements from being reconstructed from that ledger for the new account.

Reproduction, executed against the actual core sources in a throwaway Swift executable:

1. Connect account A, select apps, collect a 30-minute threshold today, and ingest it without a successful upload.
2. Disconnect A and connect B on the same server.
3. Sync with B's token.

Observed output:

```text
NEW ACCOUNT START 2026-10-19
UPLOAD ACCOUNT-B-TOKEN ["2026-10-19:1800"]
```

There is a second executed variant. Hold A's upload response, disconnect and connect B, then return an accepted response for A. The account-ID guard returns before updating `device.lastUploadedDay`. B then uploads the same day's measurement too:

```text
GATED UPLOAD A ["2026-10-19:1800"]
OLD RESPONSE notConnected
GATED UPLOAD B ["2026-10-19:1800"]
```

The same uncertainty exists after a server commit followed by process death before the local acknowledgement is saved. `testNewAccountNeverReceivesEarlierAccountsData` covers only an upload whose acknowledgement was fully saved before switching.

Recommendation: persist measurement ownership or a conservative account cutoff before sending, independent of acknowledgement. Replacement accounts must exclude days belonging to the previous account, including offline and ambiguous in-flight days. Bind credential identity to the account generation passed to sync, rather than accepting an unrelated token string. Add the two scenarios above and the ambiguous-commit/relaunch scenario to the tests.

### 2. P1: permission regrant reuses tokens Apple has voided

Locations: `App/Sources/AppModel.swift:82-96`, `App/Sources/ScreenTimeMonitoring.swift:64-84`, `ClockedCore/Sources/ClockedCore/MonitorPlan.swift:39-58`.

On denial, the implementation stops monitoring but retains every encoded `FamilyActivitySelection`. After authorization returns, reconciliation decodes and registers those same tokens. The UI shows access as allowed and retains the old nonempty selection, without asking the user to select again.

Apple explicitly documents that revoking authorization voids the tokens in an existing selection. See [FamilyActivitySelection](https://developer.apple.com/documentation/familycontrols/familyactivityselection). Reauthorization alone does not make those old tokens a supported selection again.

Reproduction on a physical iPhone: authorize, select an app, revoke Clocked's Screen Time authorization in Settings, return to Clocked, authorize again, and use the formerly selected app. The code has no path to invalidate the old selection or require new picker tokens. Whether registration rejects the void tokens or accepts an ineffective event needs device testing; automatic recovery is invalid under Apple's documented contract either way.

Recommendation: preserve historical selection identities for accounting, but mark their tokens unusable after revocation. Require a new picker selection and registration after regrant. Handle revocation while Clocked is suspended as well as denial observed in the foreground. Do not promise resumed measurement until a valid new selection exists.

### 3. P2: pending snapshots expire before upload after two weeks offline

Locations: `ClockedCore/Sources/ClockedCore/UsageEngine.swift:39`, `:83-89`, `:179-184`; `ClockedCore/Sources/ClockedCore/UsageOutbox.swift:132-136`.

Every sync prunes pending snapshots older than 14 calendar days before attempting a request. Ingest also removes the corresponding raw ledger data. This deletes valid, unacknowledged snapshots even when the only failure was being offline. The backend accepts snapshots up to roughly three years old.

Reproduction: enqueue a snapshot while offline, advance the injected clock by 15 days, restore network access, and sync. `account.prune(before:)` removes the pending entry before `nextBatch()`. Its stable ID and value are never sent again. The README's offline rule and `ClockedApp.swift:18-19` claim measurements remain saved without stating this expiry.

Recommendation: keep unacknowledged snapshots independently of the short raw-callback retention window. Compact to the highest outstanding value per series-day if storage is the concern. Expiry, if intentional, must be explicit and visible rather than silently treated as durable offline delivery.

### 4. P2: monitor reconciliation is not serialized across its asynchronous steps

Locations: `App/Sources/ScreenTimeMonitoring.swift:64-84`; `App/Sources/AppModel.swift:48-57`; `App/Sources/ClockedApp.swift:15-21`; `ClockedCore/Sources/ClockedCore/MonitorPlan.swift:48-58`; `ClockedCore/Sources/ClockedCore/MeasurementLedger.swift:145-176`.

The engine actor serializes individual calls, not the whole read-plan/apply/save transaction. `reconcile` reads `center.activities`, awaits a plan, awaits the schedule, starts/stops registrations, then awaits persistence. Foreground refresh, background refresh, and selection-save refresh can overlap. There is no reconciliation guard or generation check.

Reproduction interleaving: refresh A computes a start plan from an empty active list; pause it at the schedule await. Refresh B also computes a plan before A applies it. If their clocks straddle a second, they mint different names. Both plans start and neither stops the other's registration. A later refresh may clean this up, but the assertion that registrations never overlap is already false. A stale plan can also start an obsolete selection after another refresh has changed it.

This matters to accounting. Suppose registration A starts at 08:00, overlapping B starts at 10:00, and the only app use is 10:00-11:30. If both emit a 90-minute threshold, the ledger permits A to contribute 90 minutes, because its nominal 08:00-10:00 span is two hours, and B to contribute another 90 minutes. Capping a threshold by elapsed wall time does not establish that the usage occurred before B started. The resulting three hours exceeds the actual 90 minutes.

Recommendation: serialize reconciliation through one coordinator, covering activity discovery, planning, system mutation, and registry persistence. Coalesce concurrent requests and revalidate selection/authorization generations before applying. Add a controlled asynchronous interleaving test around a fake activity center. The concrete scheduling interleaving requires platform execution; the absence of a guard and the ledger's overlapping-registration arithmetic are directly visible in the sources.

### 5. P2: a callback's delivery date is treated as its measurement date, so sufficiently late callbacks can inflate another day

Locations: `MonitorExtension/ClockedMonitor.swift:24-25`; `ClockedCore/Sources/ClockedCore/MonitorRecord.swift:31-40`; `ClockedCore/Sources/ClockedCore/MeasurementLedger.swift:151-165`, `:194-204`; `App/Sources/ContentView.swift:285`.

The monitor records only `Date()` at delivery. Repeating schedules reuse the same activity and event names every day. The ledger selects an interval-start mark whose calendar day contains the delivery, or falls back to the delivery's local day. It has no proof that the threshold belongs to that interval. Its early-callback check measures elapsed time since midnight, not since the recorded interval-start callback.

Executed core reproduction: use a registration created yesterday, provide yesterday's interval-start mark, today's first-use interval-start mark at 13:00, and a delayed `m720` callback at 13:00:05. The ledger assigns 43,200 seconds to today:

```text
LATE YESTERDAY CALLBACK ["2026-10-19:43200"]
```

Only five seconds of use today would not support that lower bound. This is a deterministic ingestion defect for delayed prior-window input. This review has not established how often, or whether, the current iOS release delivers a prior-window threshold in precisely this order. Apple exposes only event/activity in the callback, not a usage timestamp; the implementation cannot claim such inputs are safely handled. The UI's assertion that a late callback can never increase the result is therefore unsupported.

Recommendation: use interval-specific event identities where supported, or conservatively quarantine ambiguous callbacks and explicitly describe the remaining platform uncertainty. Do not classify delivery-day attribution as proven measurement-day attribution. Add cross-midnight and travel delivery tests. See Apple's [threshold callback signature](https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor/eventdidreachthreshold(_:activity:)) and [activity-center callback timing](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter).

## Prior findings checked

- The desktop timestamp regression is fixed in the inspected `worker/src/ingest.ts:134-152`. The current backend test suite passes its offset and fractional-second regressions. I did not rerun the production workerd verification in this review.
- The iOS series rejection is fixed. `worker/src/mobile-usage.ts:12,29` accepts UUID/hex bases with the optional eight-digit zone tag and enforces the total length. App selections use lowercase UUIDs. The Swift tests inspect the current server regex and reproduce the shared fixture; backend tests accept that fixture.
- Smaller pending values after abandonment are fixed at `UsageOutbox.swift:93,125-126`, with a passing regression test.
- The phone's current-day display now takes the maximum across zone series at `UsageEngine.swift:148-154`, matching the backend's conservative maximum. Historical rows still list individual series, which may show repeated dates, but are not added to billable time.

## Other inspected behavior and remaining unknowns

App names, identifiers, tokens, and per-app usage are absent from upload payloads. The report extension has no App Group entitlement or export code. Aggregate snapshots remain separate from exact intervals. HTTPS origin validation, refused redirects, ephemeral URLSession storage, Keychain token storage, stable acknowledgement IDs, and bounded upload batches are present. These findings do not establish device or distribution success.

Selection changes before the first 15-minute milestone intentionally replace today's owner. Repeated 14-minute use/change cycles can produce zero synced duration, and a late threshold for a replaced selection is discarded. This loses subthreshold usage rather than counting it twice. The README describes the policy. It should be a deliberate product acceptance, not evidence that selected-app totals are preserved. Future selections are pre-registered immediately, but only their effective day's callbacks are retained in accounting.

The daily schedule repeats from 00:00 to 23:59 and the 48 event thresholds are real registrations, not placeholder tracking. Old registrations can remain active beyond selection expiry until the app next reconciles; accounting filters by the day's owner. Repeated-registration contributions are summed, so the UI's stated 12-hour daily cap is not actually enforced across restarts. Permission interruptions or timezone round trips can yield more than 12 hours in one series-day. The day-length cap still applies.

API signatures were checked in Apple's current DocC JSON as well as documentation pages. The event initializer with `includesPastActivity` is available from iOS 17.4; the picker initializer used here is available from iOS 16. The report filter's overload without `users` has a default optional `devices` parameter and is available from iOS 16. Its omission of `users` is not a compile defect. The report scene/configuration pattern and monitor override signatures match the documented APIs. See [event initializer](https://developer.apple.com/documentation/deviceactivity/deviceactivityevent/init(applications:categories:webdomains:threshold:includespastactivity:)), [picker initializer](https://developer.apple.com/documentation/familycontrols/familyactivitypicker/init(headertext:footertext:selection:)), and [filter initializer](https://developer.apple.com/documentation/deviceactivity/deviceactivityfilter/init(segment:devices:applications:categories:webdomains:)).

The project declares an app, monitor app extension, and report ExtensionKit extension, with separate entitlements and consistent context identifiers. The CI workflow requests an unsigned generic-device Xcode build and checks embedding under `PlugIns/` and `Extensions/`. Static validation does not validate generated build phases, SwiftUI actor diagnostics, SDK linking, actual extension discovery, signing, or installation. I found no additional definite compile error by source inspection; an actual Xcode build remains required.

Physical-device evidence remains required for 48 simultaneous events, selected app/category/domain union behavior, exact filtered report rendering, recurring-day reset, callback ordering and delays, first-unlock file access, authorization revocation/reselection, travel and clock changes, force termination/reboot, and background-refresh expiration. The callback-based URLSession transport does not propagate task cancellation to its data task; background expiration handling should also be checked. Background refresh is opportunistic and cannot guarantee upload timing. No simulator, emulator, Mac, or physical device was used.

## Verification performed

- `docker run --rm -v "${PWD}:/repo" -w /repo swift:6.1-noble swift test --package-path mobile/ios/ClockedCore`: 58 tests passed, Swift Testing reported Swift 6.1.3.
- `py -3 mobile/ios/scripts/validate_static.py`: passed, 17 Swift files checked.
- `npm test` in `worker`: 62 tests passed, including current mobile validation and desktop timestamp regressions.
- A temporary executable outside the repository compiled the actual core source files with Linux Swift 6.1 and executed the account-switch and delayed-callback scenarios above. It used controlled synthetic callbacks and transports, not Screen Time hardware evidence. Its source remains at `%TEMP%/clocked-ios-independent-review/Main.swift` in this review environment.
- No Xcode build, signed installation, device run, deployment, production runtime verification, or new XcodeGen generation was performed by this reviewer.
