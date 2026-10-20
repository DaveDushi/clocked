# Second-round review: mobile sync backend and iOS outbox

Reviewed 2026-10-19 against the uncommitted worktree. No source was edited. Scope: the round 1 findings in `MOBILE_REVIEW.md`, the RFC3339 fix in `worker/src/ingest.ts`, the current iOS `ClockedCore` sources (`UsageOutbox.swift`, `SyncProtocol.swift`, `MeasurementLedger.swift`), and `MOBILE_SYNC.md`. The iOS agent was still editing files under `mobile/ios` during this review (modification times 23:07 to 23:18 local), so the iOS findings apply to the snapshot read at that time.

Verification run:

- `npm test`: 60/60 pass.
- `npm run test:runtime` (built Worker in workerd with local D1): passed.
- Two throwaway scripts in `%TEMP%\chronorepro\` (`round2.test.mjs`, `ios-series.test.mjs`) that call the compiled `.tmp-test` modules with the repo's `test/sqlite-env.mjs`. Output is quoted below.

## Round 1 status

| Round 1 finding | Status |
| --- | --- |
| 1. CRITICAL desktop `+00:00` / 9-digit timestamps rejected | Fixed, verified |
| 2. MEDIUM timezone bucket conflict never acknowledged | Resolved on the client side, but see new finding A |
| 3. LOW legacy timestamp formatting | Unchanged and still harmless. Doc wording clarified below |

### Finding 1: fixed

`rfc3339Milliseconds` (`worker/src/ingest.ts:132-151`) accepts `Z`, `z`, or `±HH:MM`, any fraction length, and validates the written calendar fields and offset range before `Date.parse`. The ingest bind (`ingest.ts:93`) stores `new Date(...).toISOString()`, so storage is canonical millisecond UTC. The future check now uses `end` instead of `start`, which is stricter and correct.

The exact round 1 strings, through `handleIngest` with the SQLite env:

```
POST 2026-10-19T19:15:22.431918700+00:00 .. 20:15:22.431918700+00:00   (chrono Utc::now, Windows)
     2026-10-19T12:00:00+00:00 .. 12:30:00+00:00                         (chrono whole second)
     2026-10-18T10:00:00.999999999+00:00 .. 10:10:00.999999999+00:00
-> 200 {"ok":true,"upserted":3,"accepted":["chrono-now-9frac","chrono-whole-sec","chrono-999"]}
stored: 2026-10-19T19:15:22.431Z, 2026-10-19T12:00:00.000Z, 2026-10-18T10:00:00.999Z
```

Sub-millisecond digits truncate (`.999999999` becomes `.999Z`, it does not round into the next second).

Offset crossings, with a desktop row written in `+02:00`, an Android row in `Z` covering the same instants, and a `-05:00` row:

```
desk-offset  2026-10-01T00:30:00.123456789+02:00 .. 02:30 +02:00  (Europe/Berlin) -> 2026-09-30T22:30:00.123Z .. 2026-10-01T00:30:00.123Z
android-z    2026-09-30T22:30:00.123Z .. 2026-10-01T01:00:00.123Z (Europe/Berlin)
desk-neg     2026-09-30T20:00:00-05:00 .. 21:00 -05:00 (America/Chicago) -> 2026-10-01T01:00:00.000Z .. 02:00:00.000Z
report 2026-09: 60 min  [["2026-09-30",60]]
report 2026-10: 150 min [["2026-10-01",150]]
```

The literal date prefix (Oct 1), the UTC date (Sep 30 or Oct 1), and the local date all differ here. The Berlin pair unions to 150 minutes on local Oct 1 with no double counting. The Chicago hour lands on local Sep 30. The total of 210 minutes matches the wall-clock union from 22:30Z to 02:00Z. The repo tests at `test/mobile-intervals.test.mjs:138-189` also cover `+05:45`, `+14:00` on a leap day, lowercase `t`/`z`, and the rejection cases (Feb 29 in a non-leap year, Apr 31, `+24:00`, `+01:60`, `+0000`, a missing offset, trailing junk). The runtime script uses the nanosecond `+00:00` form in workerd, so V8 parsing in the production runtime matches Node.

The Android client (`Protocol.kt:9-10`) sends `Instant.toString()`, which is `Z` with 0 or 3 fraction digits. That form is accepted.

### Finding 2: resolved by the client design for bucket timezone conflicts

The client can no longer produce the round 1 scenario in normal operation:

- The wire `selection_id` is the series ID `"<selection>-z<fnv1a32(zone)>"` (`MeasurementLedger.swift:19-36`). A different zone gives a different bucket key, so the server's `WHERE mobile_usage.timezone = excluded.timezone` guard only fires on a 32-bit hash collision between two zones on the same device, day, and selection.
- `AccountState.enqueue` pins the zone per `SnapshotKey(day, selectionID)` (`UsageOutbox.swift:75-86`), so one key never sends two zones.
- A declined entry (`409`, a `400` with `accepted: []`, or omission from a mixed `200`) counts an attempt. After `maxAttempts = 3` the key is abandoned and never queued again (`UsageOutbox.swift:101-119`, `SyncProtocol.swift:82-90`). Retries are bounded.

No new server response contract is needed for this case. However, the series ID format that resolves it fails the server's `selection_id` validation. See finding A.

### Finding 3: documentation clarification

`MOBILE_SYNC.md:9` says ingest "stores canonical millisecond UTC timestamps so SQL range comparisons are consistent." That holds for rows written or rewritten after this change. Rows stored before it keep the raw desktop string (`+00:00`, up to 9 fraction digits) until the same ID is upserted again. Desktop only re-uploads a synced row on an endpoint change, so most legacy rows stay raw. Range filtering stays correct because of the 15-hour `periodQueryBounds` padding, not because of canonical storage. Check: a raw legacy row `2026-10-02T08:00:00.431918700+00:00 .. 09:00` counted 60 minutes in the October report before resync, and a resync rewrote it in place to `...08:00:00.431Z` with no duplicate row. Suggested wording: "New and re-uploaded rows are stored as canonical millisecond UTC. Rows from older Worker versions keep their original string until re-uploaded. Report queries pad their bounds, so both forms filter correctly."

## New findings

### A. CRITICAL: the server rejects every iOS snapshot, and the client then drops it

- Server: `worker/src/mobile-usage.ts:12`, `SELECTION_ID = /^(?:[a-f0-9]{32,128}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i`
- Client: `mobile/ios/ClockedCore/Sources/ClockedCore/MeasurementLedger.swift:23-25` sends `"\(selectionID)-z\(zoneTag)"`, and `UsageOutbox.swift:93-94` puts that string in `selection_id`.

The `-z` and the 8-digit suffix match neither alternative of the anchored regex, whatever the base selection ID is. Through the compiled `ingestMobileUsage`:

```
zoneTag(Europe/Berlin) = 31405cd4   (same value the iOS test asserts)
bare uuid    0f3a9c2e-1111-4222-8333-944455556666           -> 200 {"accepted":["ack-a"]}
iOS series   0f3a9c2e-1111-4222-8333-944455556666-z31405cd4 -> 400 {"error":"no valid snapshots","accepted":[]}
mixed batch  (one of each)                                  -> 200 {"accepted":["ack-c"]}
```

What happens on the client: `UploadOutcome.classify` maps that `400` with `accepted: []` to `.processed(accepted: [])` (`SyncProtocol.swift:87-90`). `apply` counts an attempt for each sent entry. After three uploads each key is added to `abandoned` and never queued again. Every iOS measurement is rejected and then dropped for good, and `rejectedCount` is the only signal. Nothing reaches the dashboard. Retries stay bounded, so it fails silently rather than looping.

Why the tests missed it: `OutboxAndProtocolTests.testSeriesIDIsStableAndServerSafe` (`OutboxAndProtocolTests.swift:83-89`) checks the series ID against the snapshot `id` regex `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, not the `selection_id` rule. The worker tests use bare UUIDs. No test sends a client-built snapshot to the server.

Fix options (pick one, no response contract change either way):

1. Server: allow the suffix, for example `^(?:[a-f0-9]{32,128}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:-z[a-f0-9]{8})?$/i`, and update `MOBILE_SYNC.md:44`. This keeps the opaque, no-package-name intent.
2. Client: send a form the server already accepts, such as a 64-digit hex SHA-256 of `selection + "\n" + zone`.

Whichever side changes, add a cross-check: one test that runs a `ClockedCore`-built `UsageSnapshot` JSON through `ingestMobileUsage`, or at least matches the iOS test against the server's `SELECTION_ID` pattern. This also depends on how the app creates the base selection ID. `SelectionSchedule.isValidID` (`SelectionSchedule.swift:24-28`) allows any 1 to 64 alphanumeric-or-hyphen string, so a non-UUID, non-hex base ID would still fail under option 1. Confirm that the app files mint a lowercase UUID or hex hash.

### B. LOW: the server takes the max across a device's series, while the client says they can be summed

`MeasurementLedger.swift:14-18` says zone series "never overlap and may be added together". `mobileUsageForPeriod` (`mobile-usage.ts:121-139`) and `MOBILE_SYNC.md:57` take the maximum across a device's selections for each day. Once finding A is fixed, a travel day measured in two zones shows only the larger series on the dashboard. It is still a lower bound and never double counts, so it does not break the brief. It is an undercount on those days, and the iOS UI may show a higher number than the dashboard. Either accept this and say so in `MOBILE_SYNC.md`, or have the server sum series that share a base selection. The second option needs the server to parse the suffix, so it only fits fix option 1.

### C. LOW: abandoning a key leaves its older pending entries to be retried

In `UsageOutbox.swift:108-119`, abandoning the entry that hit `maxAttempts` removes only that entry. Older, smaller pending entries for the same key stay in `pending`. `enqueue` skips abandoned keys, but `nextBatch` does not, so the next-largest entry for the key is sent and gets its own three attempts. With finding A in place, a key that built up N threshold snapshots while offline takes about 3N uploads to clear, not 3. The cost is bounded and does not affect accounting. Fix: drop all pending entries with `abandoned.contains(p.key)` in `apply`, or filter them in `nextBatch`.

## Checked with no new defect

- Desktop sync path: `/activity` (`activity.ts`) was not changed. Only `/sessions` validation changed, and it now accepts every format `src/db.rs` produces.
- Billing separation: still holds. `mobile_usage` is only read by `mobileUsageForPeriod`, export, and wipe.
- Round 1 ownership, tombstone, revocation, and DST conclusions: the relevant code is unchanged since round 1. `npm test` and `test:runtime` still cover them.

## Unresolved risks

- Finding A blocks all iOS data until one side changes. Treat it as a release blocker for iOS.
- iOS sources were changing during this review. Recheck finding A, the series ID format, and `apply` against the final iOS files.
- The base selection ID format comes from app files outside `ClockedCore`. I did not read those, per the brief.
- I did not run the Swift tests. The Swift behavior described here comes from reading the code.
- Round 1 finding 3 stays as documented. No code change is needed.
