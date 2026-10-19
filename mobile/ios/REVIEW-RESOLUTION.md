# Review resolution status

Status of every finding in `REVIEW.md` (first review) and `REVIEW-2.md` (second review) as of 2026-10-20. Each fix has a regression test in `ClockedCore/Tests` that runs the real engine, planner, or ledger. No finding was closed by documentation alone.

## Second review (`REVIEW-2.md`)

The four reviewer tests were copied into `ClockedCore/Tests/ClockedCoreTests/Review2Tests.swift`. Before any fix, those four tests and one added direct-replacement variant failed with 12 assertion failures in total. After the fixes all of them pass.

| # | Finding | Status | Change | Tests |
| --- | --- | --- | --- | --- |
| 1 | P1: date rollback moves unqueued measurements from A to B | Fixed | `connect` and `disconnect` first drain callbacks on disk into the ledger. They then reserve the latest of today, every day the departing account queued, and every day measured on the device (`MeasurementLedger.latestMeasuredDay`). `reservedThrough` only ever grows. | `testReview2RollbackCannotTransferUnqueuedAccountData` (record on disk and already ingested), `testReview2RollbackDirectReplacementCannotTransferUnqueuedData` |
| 2 | P2: same-day reauthorization erases measured, unsynced usage | Fixed | When a selection with voided tokens has measured today and is replaced, it is kept with `retainedThrough = today`. `SelectionSchedule.owns` lets both selections own that day for accounting, while only the new one is registered. Each uploads as its own series. The phone shows the larger value, which is also what the server reports. A second choice the same day cannot remove the retained entry. | `testReview2SameDayReauthorizationPreservesUnsyncedMeasurement`, `testReview2SecondChoiceAfterRenewalKeepsMeasuredUsage`, `testVoidedOwnerWithMeasurementsKeepsOwningItsDay` |
| 3 | P2: revocation during a suspension past the horizon reuses void tokens | Fixed with a bounded, conservative rule | The engine stores the last day of the registration horizon (`horizonEnd`). If that day has passed when reconciliation runs, the app cannot rule out a revoke and regrant in the gap. It treats the gap as a revocation and requires a fresh choice before registering anything. Refreshing within the horizon keeps the existing tokens. | `testReview2SuspendedRevocationAfterHorizonRequiresFreshTokens`, `testReview2RefreshWithinHorizonKeepsTokens` |
| 4 | P2: refresh after 23:44 stops today's running registration | Fixed | The planner keeps an existing matching registration before it checks the 15-minute minimum. The minimum now applies only to new registrations. | `testReview2LateRefreshKeepsAnExistingValidInterval` |

## First review (`REVIEW.md`)

| # | Finding | Status | Change | Main tests |
| --- | --- | --- | --- | --- |
| 1 | P1: account replacement transfers unacknowledged measurements | Fixed, extended by second review finding 1 | A reservation is saved before the first request and on every account change. Replies for a replaced account are dropped. Uploads need the credential of the current account, and Keychain tokens are stored per account. | `testReplacementAccountNeverReceivesAnOfflineDayOfThePreviousAccount`, `testReplacementAccountNeverReceivesADayThatWasOnlyMeasured`, `testReplyForAReplacedAccountIsDroppedAndItsDayStaysReserved`, `testCommittedButUnacknowledgedDayStaysWithItsAccountAcrossRelaunch`, `testCredentialForAnotherAccountCannotUpload` |
| 2 | P1: regrant reuses voided tokens | Fixed, extended by second review findings 2 and 3 | An authorization generation advances when access is lost or vanished registrations suggest it was. Selections from an older generation are never registered, and the UI asks for a new choice. | `testRevokedTokensAreNeverReusedAndHistoryKeepsItsSelection`, `testRevocationWhileSuspendedIsDetectedFromVanishedRegistrations`, `testUnknownOrMissingAuthorizationStopsMonitoring` |
| 3 | P2: pending snapshots dropped after 14 days offline | Fixed | Pending snapshots are never pruned by age. Each series-day keeps its highest value. | `testSnapshotSurvivesLongOfflinePeriods`, `testPendingSurvivesPruning` |
| 4 | P2: unserialized reconciliation and summed overlapping registrations | Fixed | Reconciliation runs as one engine call with no suspension point. Registrations of one day are combined by maximum, never by sum. | `testConcurrentReconcilesAndSelectionChangesNeverOverlapADay`, `testOverlappingRegistrationsOfOneDayKeepTheLargestValue` |
| 5 | P2: delivery date used as measurement date | Fixed | Each registration is a one-shot schedule for one named day. Callbacks count for the day in their activity name. Callbacks more than 6 hours after that day are quarantined. | `testLateCallbackBelongsToTheDayInItsNameNotTheDeliveryDay`, `testDelayedCallbackFromYesterdayDoesNotInflateToday` |

Items requested alongside the first review were also handled: disconnect asks for confirmation and states how many totals will be discarded, authorization fails closed, and task cancellation cancels the URLSession request.

## Verification performed

Commands ran in the `swift:6.1-noble` container against a copy of the repository.

| Check | Result |
| --- | --- |
| `swift test --package-path mobile/ios/ClockedCore` | 85 tests, 0 failures |
| `swift build --build-tests -Xswiftc -strict-concurrency=complete` | 0 warnings, 0 errors |
| `bash mobile/ios/scripts/typecheck_bridge.sh` | Passed. Compiles the Screen Time bridge and monitor extension against stub SDK modules, with warnings as errors |
| `python3 mobile/ios/scripts/validate_static.py` | Passed, 17 Swift files |
| XcodeGen 2.46.0 project generation (built on Linux) | Passed in the previous round; `project.yml` is unchanged since |

The server wire fixture test (`testClientBuildsTheSharedWorkerFixture`) and the server-regex checks still pass. Upload payloads still contain only the seven contract fields and no app identities.

## Not verified

- **No Xcode build has run.** SwiftUI views, the report extension, SDK linking, embedding, signing, and installation are unverified until `.github/workflows/mobile-ios.yml` runs on a macOS runner or someone builds on a Mac.
- **No iPhone run.** Dated one-shot schedules with `repeats: false`, 7 activities of 48 events each, callback timing, first-unlock file access, revocation behavior, background refresh, and report rendering all need a physical device.

## Remaining limitations

These are accepted limits, not open defects:

- **Expired horizon.** If the app does not run before its 7-day horizon ends, the user must choose work apps again, even if access was never revoked. This trades convenience for never registering possibly void tokens.
- **Undetectable revocation.** A revoke and regrant that both happen while the app is closed and its registrations are still live and present cannot be detected.
- **Late callbacks across a clock rollback.** A callback measured under an old account, delivered only after an account switch, with the clock set back across that day, can be attributed to the new account. Callbacks already on disk at the switch are covered.
- **Undercounting.** Registrations of one day combine by maximum, so re-registration days (time zone change, renewed tokens) can undercount. Combining this way never adds the same minutes twice. A threshold that iOS reports early, but not impossibly early, can still raise a value; that cannot be detected.
- **Early selection change.** Changing work apps before the first 15-minute step of a day drops the minutes before the change.
