# Independent second iPhone review

Reviewed 2026-10-20 in `C:/Users/david/.t3/worktrees/clocked/t3-07f0080b`. One reviewer, no delegation, source edits, or commits. The only repository file written in this round is this report. Read `mobile/CONTRACT.md`, the previous `REVIEW.md`, the current core, app bridge and UI, monitor and report extensions, project configuration, and relevant server aggregation code.

Four actionable defects remain. The existing 77 core tests pass. Four additional adversarial tests against copies of the actual sources fail with eight assertions. These are deterministic code failures; none depends on claiming a particular callback delay or hardware reliability guarantee.

## Ranked remaining defects

### 1. P1: a date rollback transfers unqueued measurements from account A to B

Locations: `ClockedCore/Sources/ClockedCore/UsageEngine.swift:222-242`, `:297-306`; `ClockedCore/Sources/ClockedCore/UsageOutbox.swift:77-78`, `:152-154`.

`connect` and `disconnect` reserve the maximum of the current local date and the previous account's last queued or acknowledged day. Neither includes measurements that have only reached the device ledger or monitor-record directory. `reservedThrough` is advanced for measurements during sync, not during ingestion. If the date moves backward before the account switch, a previously measured day can be later than both reservation inputs.

Executed reproduction, with separate variants for a callback still on disk and one already ingested:

1. On May 5 at 08:00 in Berlin, connect A and choose work apps.
2. Deliver a valid 30-minute threshold at 09:00. Do not sync A. In one variant call `status()` to persist the ledger; in the other leave the callback in the record directory.
3. Set the injected clock back to May 4 at 23:30, disconnect A, and connect B.
4. Sync B with B's account-bound credential.

Both variants produce:

```text
Bstart=2026-05-05 requests=[["2026-05-05:1800"]]
```

The request uses B's credential and contains A's 1,800 seconds. `sync` explicitly allows measurements through current day plus one, so the transfer already happens before the clock catches up. A direct replacement uses the same incomplete reservation rule.

Persist the ownership cutoff for observed measurements independently of upload, and account for still-undrained records at the account boundary. The cutoff must not move backward when the local date does. Keep the existing credential binding and pre-request reservation; those correctly protect queued and in-flight data but do not protect this unqueued case.

### 2. P2: same-day authorization recovery removes already measured, unsynced usage

Locations: `ClockedCore/Sources/ClockedCore/SelectionSchedule.swift:68-77`; `ClockedCore/Sources/ClockedCore/MeasurementLedger.swift:164-166`; `App/Sources/AppModel.swift:103-120`.

A generation mismatch forces `SelectionSchedule.choose` to replace today's owner even when today's owner has measurements. The ledger then excludes every callback belonging to the previous owner. If the original entry began today, the entry itself is also removed. The token invalidation fix therefore invalidates accounting history as well as token usability.

Executed reproduction:

1. Connect, choose apps, and ingest a valid 120-minute threshold today. Do not sync it.
2. Reconcile denial, then approval, then save a fresh selection today.
3. Read status and sync.

```text
REVIEW2 reauth before=7200 after=0 requests=0
```

The two hours disappear from the displayed measurement and never reach the outbox. An upload failure before this sequence would already have queued the value, which is why this reproduction deliberately uses measured-but-not-yet-queued usage. Even when a value was previously uploaded, the local display can fall below the dashboard.

Preserve the old day's measured value and selection identity when replacing void tokens. Token renewal must not remove valid historical measurements. It is acceptable to retain the conservative maximum across old and new registrations or defer the accounting ownership change, provided existing usage survives and the payloads use valid tokens. The current test checks yesterday's history, missing this same-day case.

### 3. P2: suspended revocation is missed after the seven-day horizon expires

Locations: `ClockedCore/Sources/ClockedCore/MonitorPlan.swift:123-133`; `ClockedCore/Sources/ClockedCore/UsageEngine.swift:168-185`.

The missing-registration heuristic only checks registrations dated today or later. If access is revoked and regranted while the app is suspended beyond its seven-day monitoring horizon, all stored registrations are dated in the past. Even an empty activity center fails to advance the authorization generation. Reconciliation then registers the old selection again.

Executed reproduction:

1. Choose apps and register May 4 through May 10 under generation zero.
2. Clear the fake center to represent registrations removed during revocation. The app observes no intermediate denial.
3. Advance to May 12 and reconcile with authorization approved, representing regrant before the next refresh.

```text
REVIEW2 after horizon revoked=false starts=7 needsReselection=false
```

All seven starts receive the original payload. Apple's [FamilyActivitySelection documentation](https://developer.apple.com/documentation/familycontrols/familyactivityselection) states that revocation voids previously issued tokens. They cannot become a supported selection just because the old monitoring dates have expired.

Handle this unobservable gap explicitly before claiming recovery with the old selection. A conservative requirement for a fresh picker after an expired horizon is one bounded option. The app need not detect every possible hardware state, but it must cover this case in its stated vanished-registration recovery policy. This defect persists even under the implementation's assumption that revocation removes registrations; it does not require iOS to retain them. The fake center demonstrates the decision error, not whether real iOS rejects or silently accepts the void payload.

### 4. P2: a late-evening refresh stops an existing valid day's monitoring

Locations: `ClockedCore/Sources/ClockedCore/MonitorPlan.swift:96-105`, `:114`.

The 15-minute minimum check runs before the lookup that preserves an existing matching registration. At 23:45, the planner computes a prospective new interval ending at 23:59, rejects its 14-minute length, and never adds today's existing registration to `keep`. The final stop list therefore stops that registration, even if its valid interval began at 08:00.

Executed planner reproduction uses a matching active May 4 registration beginning at 08:00, its saved Berlin registry entry, an unchanged selection, and a refresh at 23:45:

```text
REVIEW2 late refresh stops existing=true
```

Opening the app or receiving a background refresh after 23:44 can prematurely stop the day's monitoring. Usage just short of the next threshold then cannot reach it during the remaining scheduled time. This exceeds the documented one-minute gap at the end of the day.

Preserve an existing valid registration before applying the minimum-duration guard for a new registration. Apple's [minimum interval documentation](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/monitoringerror/intervaltooshort) describes a minimum schedule length, not a requirement to stop ongoing intervals once fewer than 15 minutes remain. The existing late-today test starts from an empty center and misses this path.

## Prior findings and fix verification

- The original same-date offline, measured-only, in-flight response, ambiguous-commit/relaunch, and stale-credential account scenarios now have passing tests. Pre-request persistent reservation and per-account Keychain credentials address those original paths. Finding 1 is the remaining date-rollback variant.
- Observed authorization loss advances the generation, invalidates old payloads for new registrations, clears the UI selection, and asks for reselection. Missing current/future registrations also trigger recovery. Findings 2 and 3 are remaining history and lifecycle cases.
- Pending snapshots are compacted to the highest value per series-day and no longer age-pruned. The 47-day offline queued-snapshot regression passes.
- Reconciliation now performs discovery, plan, system mutation, and registry persistence in one actor turn without an `await`. The concurrent reconcile test passes. Ledger aggregation uses maximum instead of summing overlapping epochs, enforcing the standard 720-minute maximum per series-day. I found no residual inflation from the original overlapping-epoch reproduction.
- Activity names include selection, start instant, and named day. The late-prior-day regression passes, and the ledger attributes the callback to that named day, with a six-hour late quarantine. It no longer assigns a prior day's large threshold to today's delivery date.
- Full date components include the Gregorian calendar and registration time zone, and the bridge uses `repeats: false`. Future selection changes replace the appropriate future registrations. The shared UUID plus `-z` plus eight-hex wire fixture passes. Server daily reports take a maximum across selections and zones per device, and period summaries sum those daily maxima per device before taking the largest device total. No backend or Android suite was run.
- The report extension has no App Group entitlement or export path. Aggregate upload fields do not contain app identities. Cancellation now reaches the URLSession task through a cancellation holder; the core cancellation test passes. UI disconnect confirmation exists. I did not independently simulate URLSession cancellation on iOS.

## Apple schedule constraints and remaining platform unknowns

Checked current Apple official documentation, rather than treating the stub SDK or Linux Foundation tests as Screen Time evidence:

- The [schedule initializer](https://developer.apple.com/documentation/deviceactivity/deviceactivityschedule/init(intervalstart:intervalend:repeats:warningtime:)) documents one-shot behavior when recurrence is false, immediate interval-start notification for an ongoing interval, and otherwise the next matching start date. I found no documented prohibition on the full calendar-date components used here.
- [nextInterval](https://developer.apple.com/documentation/deviceactivity/deviceactivityschedule/nextinterval) can be nil when the components have no future match. Apple specifies calendar matching, delayed start/end callbacks tied to device use, and wall-clock end behavior across time-zone changes. A delayed interval-start callback is not proof that the actual counting window began at delivery time.
- [startMonitoring](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/startmonitoring(_:during:events:)) can reject excessive or tightly scheduled activities and replaces an existing activity with the same name. The event accounting zone is the device's zone at the interval start. The saved registration zone and future dates still require device validation when travel happens without an app refresh.
- Apple documents a [20-activity limit](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/monitoringerror/excessiveactivities), the 15-minute minimum above, and a [one-week maximum interval](https://developer.apple.com/documentation/deviceactivity/deviceactivitycenter/monitoringerror/intervaltoolong). Seven separate daily intervals, plus a retained prior day, do not inherently exceed these limits. They do not prove support for every combination of 48 simultaneous thresholds on each activity.
- The [event initializer](https://developer.apple.com/documentation/deviceactivity/deviceactivityevent/init(applications:categories:webdomains:threshold:includespastactivity:)) documents `includesPastActivity` and combined selected usage within the schedule. The false setting is consistent with excluding usage before monitoring starts. Actual threshold timing, selected app/category/domain overlap behavior, and OS defects require device evidence.

An actual Xcode build is still unrun in this review. Linux tests and the previous stub bridge typecheck cannot establish SwiftUI compilation, SDK linking, generated extension embedding, signing, installation, or report discovery. I found no additional definite compile defect by source inspection. Device validation is still needed for dated one-shot scheduling, horizon renewal, callback delivery and first unlock, revocation/regrant, report filtering, travel/DST, and background expiration. No Mac, iPhone, simulator, or emulator was used. These are validation unknowns, not additional ranked code defects.

## Verification and reproduction artifacts

Mounted the repository read-only into `swift:6.1-noble`, copied `Package.swift`, `Sources`, and `Tests` into a disposable container directory, and copied only the server source and fixed fixture needed by the core validation tests. Ran `swift test --package-path /tmp/review/mobile/ios/ClockedCore`. All 77 tests passed using Swift 6.1.3.

Added four tests only to the disposable copy, then ran `swift test --package-path /tmp/review/mobile/ios/ClockedCore --filter Review2`. Four tests failed with eight assertions. The account test covers both undrained and ingested data. Test source remains outside the repository at `%TEMP%/clocked-ios-review-2/Review2Tests.swift` and extends the existing `UsageEngineTests` and `MonitorPlanTests` helpers. It contains:

- `testReview2RollbackCannotTransferUnqueuedAccountData`
- `testReview2SameDayReauthorizationPreservesUnsyncedMeasurement`
- `testReview2SuspendedRevocationAfterHorizonRequiresFreshTokens`
- `testReview2LateRefreshKeepsAnExistingValidInterval`

These tests exercise the actual engine and planner with the existing controlled clock, record store, fake center, and request-capturing transport. No implementation mutation, mutation-test rerun, full backend/Android suite, Xcode build, deployment, or commit was performed.

