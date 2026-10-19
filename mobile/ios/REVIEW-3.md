# Focused final iPhone review

Reviewed 2026-10-20. Read `REVIEW.md`, `REVIEW-2.md`, and `REVIEW-RESOLUTION.md`, then checked the engine, planner, ledger, selection schedule, outbox, app integration, and ownership regressions. One reviewer, no delegation, implementation edits, or commits. This report is the only repository file written.

The four exact second-review reproductions now pass, as do the added ownership regressions. Two narrower pruning defects remain, reproduced against copies of the actual core sources.

## Findings

### 1. P2: pruning permits an old account's activity name to be reassigned after clock rollback

Locations: `ClockedCore/Sources/ClockedCore/UsageEngine.swift:136-140`, `:225-226`, `:344-347`; `ClockedCore/Sources/ClockedCore/MonitorPlan.swift:117-120`; `ClockedCore/Sources/ClockedCore/MonitorNaming.swift:64-65`.

Registration names contain the selection, day, and start timestamp, but no permanent registration generation. The collision check avoids names only while they remain active or in `registry.zones`. Ingestion prunes both that registry and `registrationOwners` after 35 days. Returning the clock to an earlier registration's start can therefore recreate its exact name for another account. The ownership filter then accepts the old registration's callback because the same dictionary key now names B.

Executed reproduction, extending the existing late-A-callback ownership case:

1. A connects and registers May 5 at 08:00 in Berlin. Save that registration identity, with no threshold delivered yet.
2. Set the clock back to May 4 at 23:30, replace A with B, and reconcile. B's start day is May 5 and its registrations initially have different identities.
3. Set the clock to June 16 and call `status()`. Ingestion prunes all the May registrations and their ownership entries. Clear the fake center to represent the ended May schedules. Do not reconcile on June 16.
4. Set the clock back to May 5 at 08:00 and reconcile. The remembered horizon is May 10, and its live registry entries were pruned, so neither revocation check invalidates the selection. B recreates A's exact May 5 identity.
5. Supply A's saved registration's 120-minute callback at May 5 10:00, then sync B at 10:05.

```text
REVIEW3 pruned identity reused=true
REVIEW3 late A sent by B=[7200]
```

Both the identity inequality and empty-upload assertions fail. This needs the additional forward jump past retention and subsequent rollback; the simpler ownership tests pass. It proves an identity collision and incorrect acceptance for that input, without establishing how often iOS would deliver such a callback. The defect is the reassignment of the supposedly account-bound registration identity.

Make registration identities non-reusable across pruning and clock changes, for example with a persisted generation or unique registration component. Preserve the callback ownership filter. Merely extending the finite retention window postpones the same collision. A broader conservative rollback cutoff would also need to survive pruning and cover this exact reproduction.

### 2. P3: pruning removes a retained selection one day before its measurement expires

Locations: `ClockedCore/Sources/ClockedCore/SelectionSchedule.swift:106-108`; `ClockedCore/Sources/ClockedCore/UsageEngine.swift:134-137`; `ClockedCore/Sources/ClockedCore/MeasurementLedger.swift:177`.

`SelectionSchedule.prune(before:)` still assumes only the effective selection owns a day. It deletes entries whose `effectiveFrom` precedes the effective entry at the cutoff, even when their new `retainedThrough` includes that cutoff. The ledger and registration ownership retain that day's records, but `schedule.owns` subsequently rejects them.

Executed reproduction:

1. Connect and choose work apps on May 3.
2. Measure 120 minutes on May 4 without queueing a snapshot.
3. Observe denial and approval and choose fresh tokens on May 4. The old selection is correctly retained through May 4, and status still shows 7,200 seconds.
4. Advance to June 8 and sync. With 35-day retention, the inclusive cutoff is May 4. Its raw measurements remain eligible, but selection pruning deletes their retained owner.

```text
REVIEW3 cutoff retained sent=[]
```

The expected `[7200]` upload assertion fails. Already queued snapshots are unaffected. This is a one-day boundary error affecting measured-but-unqueued retained usage, not a claim that raw records must be kept forever.

Keep entries whose `retainedThrough` is on or after the cutoff, in addition to the entry needed for ordinary effective ownership. Test the inclusive cutoff and the following day separately.

## Confirmed fixes and privacy checks

- The undrained and already-ingested rollback cases, direct replacement, same-day 7,200-second renewal, second same-day choice, expired-horizon reselection, within-horizon renewal, and 23:45 preservation tests pass.
- The late A callback is dropped by B before pruning, including disconnect/relaunch. B's own 15-minute callback uploads exactly 900 seconds. First-account adoption preserves preconnection measurements and keeps adopted registrations.
- An additional mixed-account renewal test passes: A's late 7,200 seconds and B's own 900 seconds share the old selection; authorization renewal retains it, and a second fresh choice follows. B uploads only 900 seconds with B's credential. Only the latest fresh payload is registered, and the fake center records zero overlapping registrations. Retaining a selection does not itself bypass the account filter.
- In-flight and ambiguous acknowledgements, stale credentials, offline pending retention, serialized reconciliation, and separate travel series pass the focused existing checks. Upload snapshots still contain only the seven aggregate contract fields. Selection payloads stay local; the report extension has no aggregate export path or App Group entitlement.

## Verification and build status

Mounted the repository read-only in `swift:6.1-noble` and tested disposable copies. The focused existing run executed 19 tests with zero failures. The additional mixed-account retained-selection test passed. The two new pruning reproductions failed three assertions in total. Core implementation sources were unchanged. To avoid intermittent Linux discovery of test methods in extensions, the final disposable reproduction run used a test subclass and removed `final` from the copied test helper class only.

Reproduction sources and runnable container scripts are outside the repository in `%TEMP%/clocked-ios-review-3/`: `Review3Tests.swift`, `Review3PrivacyTests.swift`, `run-adversarial.sh`, and `run-privacy.sh`. The scripts use `/repo` and `/extra` read-only mounts, copying inputs under `/tmp/review` before building.

The parent reports a successful actual native Xcode 26.6 / iOS SDK 26.5 build at SHA `4cba9ff` in [run 39333651706](https://github.com/DaveDushi/clocked/actions/runs/39333651706), with 88 tests passing on macOS and Linux. The parent also checked app, monitor `PlugIns`, and report `Extensions` bundle placement and downloaded `mobile/ios/Clocked-unsigned.app.zip`. This supersedes the earlier unrun-build statement and the failed earlier SDK snapshot. I did not independently rerun Xcode or inspect the downloaded artifact in this review. Linux core results are not app-build evidence.

Signing, installation, and physical-device behavior remain unverified. Opportunistic background execution, seven-day horizon reselection, invisible revocation without an observable OS change, threshold quantization, early OS callbacks, and conservative maximum-based undercounting remain the previously accepted platform or product limitations. No simulator, emulator, physical phone, backend suite, or Android suite was run in this review; those gaps are not additional ranked findings.
