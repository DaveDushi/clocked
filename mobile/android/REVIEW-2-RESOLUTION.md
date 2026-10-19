# Second review: premise and timestamp-owner census

## Before changing production code

The false premise was: retained UsageStats event timestamps remain in the application's previous wall-clock frame, and DEVICE_STARTUP precedes the new boot's screen/keyguard events. Both previous fixes kept that premise and added reset decisions around it. The executable appendix demonstrates that those decisions can erase a PAUSE and bill personal use, or erase valid first-boot gates.

The new design must establish the event frame before consuming events. A drift magnitude alone is not frame proof. A known pre-change event fingerprint can prove a uniform shift or unchanged OEM history; conflicting or missing evidence must preserve only already-proven work and mark uncertainty. Already completed session records have a separate immutable contract and cannot join a bulk timestamp adjustment.

Timestamp owners, inventoried before the next production edit:

- **OS retained events:** AOSP can move the whole retained history by a wall-clock correction. An OEM can leave it unchanged. Startup is synthesized at unlock; earlier queued gates retain their earlier timestamps. These timestamps belong to the OS, not the app.
- **Unemitted reconstruction cursor and open start:** These must share the current retained-event frame. Moving one without the other changes duration or skips a closing event. The last trusted checkpoint also bounds the minimum proven prefix that can survive an unresolved boundary.
- **Selection and timezone boundaries:** These are local observations made on the wall clock. They must move with corresponding pre-change, unemitted event history when a frame shift is proven. Sentinel baseline entries are not timestamps and must not move.
- **Wall/elapsed samples and boot count:** These detect candidate corrections within one boot. Elapsed time cannot be extrapolated across reboot. A boot-start estimate may delimit state uncertainty but must never fabricate an interval end.
- **Event fingerprints:** Local identity hashes plus observed timestamps establish whether known history moved. They are private evidence, never upload metadata. Repeated indistinguishable events, missing retention or conflicting offsets do not prove a frame.
- **Pending and synced session records:** Their IDs, UTC endpoints, timezone labels and payloads stay immutable across history shifts. Server idempotence and an in-flight upload may already depend on them. Frame migration must affect only unemitted state, not these records.

The rerunnable census and literal review regressions are in `PlatformModelTest.kt`. Its platform model owns the shifted/unshifted event timestamps independently of production collection logic. The census writes `app/build/reports/platform-model-census.tsv`; run `gradlew testDebugUnitTest --tests app.clocked.mobile.PlatformModelTest`. This document will record actual results and resolved/deferred findings after the implementation checks.

## Authoritative source check

Fetched and read the official AOSP `android14-release` Java sources directly through Gitiles, including `UserUsageStatsService.init`, `checkAndGetTimeLocked`, `UsageStatsService.onUserUnlocked` and queued-event replay, `UsageStatsDatabase.onTimeChanged`, and the protobuf offset encoding. The review's two premises are confirmed in those sources. Android 15 and 16 `UserUsageStatsService` were also checked for the same startup synthesis and time-correction path. The rerunnable source-check script records the excerpts and hashes under ignored `.tools/aosp/`.

Primary sources:

- [UserUsageStatsService, Android 14](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/usage/java/com/android/server/usage/UserUsageStatsService.java)
- [UsageStatsService, Android 14](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/usage/java/com/android/server/usage/UsageStatsService.java)
- [UsageStatsDatabase, Android 14](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/usage/java/com/android/server/usage/UsageStatsDatabase.java)
- [UsageStatsProtoV2, Android 14](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/usage/java/com/android/server/usage/UsageStatsProtoV2.java)
- [UserUsageStatsService, Android 15](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/services/usage/java/com/android/server/usage/UserUsageStatsService.java)
- [UserUsageStatsService, Android 16](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/usage/java/com/android/server/usage/UserUsageStatsService.java)

## Resolved production behavior

- **R2-H1, startup order:** SHUTDOWN clears the old boot, and the first following event resumes event processing. The startup-pending context survives collection boundaries and encrypted persistence. STARTUP is a late initialization marker, so it preserves screen, keyguard and resumed-activity evidence already established in the new boot. A real swipe-lock event overrides the non-secure fallback. Literal appendix t1/t1b, secure/non-secure unlock-before/after tables, RESUME before STARTUP, separate collections and two reboots in one gap exercise this path.
- **R2-H2, history frames:** `EventFrames` fingerprints private event kind/package/class patterns and stores their observed raw timestamps. The collector probes both candidate ranges before applying its cursor. At least two agreeing known markers, with no competing supported offset, are required to establish a uniform shift. It moves only unemitted state and finite selection/timezone entries by that observed shift. Baseline sentinels and every completed session's ID/payload remain unchanged. The wall/elapsed pair remains an actual clock observation, separate from the stored event-frame offset. Below-threshold clock drift updates that offset, allowing a later accumulated AOSP shift to be recognized from fingerprints rather than a two-minute threshold.
- **R2-H2, unsafe frame fallback:** A single repeated RESUME, absent evidence, conflicting offsets or materially unshifted OEM history cannot authorize merging clock eras. Previously observed tail closes can complete the old visit; otherwise the open visit is sealed only through its last trusted checkpoint. The uncertain period emits no inferred work. Old events below either candidate upper bound cannot reappear as fresh resumes after a backward correction. The persistent notice states that fresh gates/activity are required. This fallback intentionally favors undercount over billing personal time.
- **R2-H2, action/query races:** Selection actions use elapsed time relative to the last sampled event frame. A selection made after the wall jump but before the next OS probe therefore moves exactly once. `SampledEvents`, used by the actual Android adapter, checks the post-query wall/elapsed/boot/permission sample. A changed sample leaves the checkpoint untouched and gets at most one immediate retry. This covers the query itself triggering AOSP's rewrite.
- **R2-M1, unclean reboot:** A synthesized shutdown can precede the application's cursor. A boot-state cut or unmatched startup keeps the old open span through the initial trusted cursor, rather than dropping it or extending it to estimated power-off/boot/unlock time. Clean retained shutdown evidence after the cursor still supplies its exact end. Appendix t7 and the first-new-visit unclean-reboot fixture cover both old-prefix preservation and new-boot gate recovery.
- **R2-L1, retained close after a long gap:** Collection age no longer clears carried activity. Appendix t6 retains `[3600s,10800s)` after the next call at 102 hours. Only evidence that the retained prefix is missing can invalidate continuity, and even then the previously proved prefix survives. The original 30-hour and older-returned-history tests still run.

Original H1 and H3 remain covered by production collection tests. Network capture/start/ACK epoch checks, finite HTTP deadlines and destructive deletion consent were not weakened. Exact union/privacy, retry IDs, account races and per-profile scope remain unchanged.

## Executable evidence

Before production edits, the eight-method platform fixture ran against the previous collector: seven appendix assertions failed and the census alone passed. Its census showed OS timestamps moving by -90 seconds while the open start and local boundaries stayed in the old frame. This reproduced the incorrect ownership assignment before the replacement.

The repaired fixture asserts literal appendix outcomes:

- t1/t1b: `[3600,7200)` plus `[7380,10980)`, 7,200 seconds.
- t2: at least the proved `[3600,7140)` prefix survives unshifted-history uncertainty.
- t3: shifted `[4200,7770)` plus `[8400,9000)`, 4,170 seconds with the real gap preserved.
- t4: shifted `[3510,7080)`, 3,570 seconds. The later personal hour is never billed.
- t6: `[3600,10800)` survives the 102-hour gap.
- t7: `[3600,7140)` survives a synthesized shutdown before the checkpoint.

The expanded suite includes 24 literal shifted/unshifted correction cases at both signs of 1,999/2,000/2,001 and 119,999/120,000/120,001 milliseconds, cumulative sub-threshold steps, byte-for-byte pending/synced payload checks, finite metadata alignment, missing/conflicting/lone fingerprints, selection placement during a jump, and a query-triggered clock change. The platform model determines history shifts independently of the collector. Obsolete first-review clock tests were replaced, not rewritten to retain their false premise.

The census now shows the open start and finite selection/zone boundaries aligned by -90 seconds, while the completed payload remains byte-for-byte unchanged. The cursor subsequently advances in the aligned event frame; it is not expected to stay at its pre-collection shifted value. Generated census TSV and JUnit reports are included by the existing CI report artifact path. Final build, lint, signer and APK hash evidence is in `VERIFICATION.md`.

Source-check SHA-256 values from the official downloads on 2026-10-20:

- Android 14 `UserUsageStatsService`: `8ddb9a77e2bc00a7104d5e2aae7f0cc3e72fdc38c8ce16d05eccc65ddd3e83af`.
- Android 14 `UsageStatsService`: `b5f8632a89e099a89d72bbed30474b3cfd35e7ef8e47146c772ab76441d9e2c0`.
- Android 14 `UsageStatsDatabase`: `300de985a6a329b9f5a687cede5f7e45a54686988264c8e2e137616a0143850c`.
- Android 14 `UsageStatsProtoV2`: `829cbcb2e592d5906f56305b78f3ff5daff6355a5b1279a1317d42096a1c5fb5`.
- Android 15 and 16 `UserUsageStatsService`: `1834c1ab93dd5df1bc47ef273e25eca29014de7e0bfec980662b3ff9bf3cc766`.

## Honest remaining limits

- Source-derived fixtures are not captured phone logs. No emulator, phone, work-profile test or live upload was used. Manufacturer modifications, event completeness and actual clock/broadcast timing remain hardware checks. No reliable-hardware claim follows from these results.
- Public usage events have no trustworthy unique event/task identity. Fingerprint patterns can be absent or ambiguous. The fallback preserves proved work but can omit the uncertain window, including valid work, and can wait for fresh gates after a backward jump. Unchanged retained history alone does not establish how a customized OEM timestamps new events, so it does not justify spanning that jump.
- Missing OS closing events, same-class concurrent instances and an entirely unobserved permission revoke/regrant remain the prior documented platform limits. The app-caused PAUSE loss from the wrong clock frame is covered and fixed; this does not solve every OEM event omission.
- Completed rows are immutable even when a past device clock was wrong. The client cannot retroactively repair already-uploaded UTC placement or cross-device overlap under the existing retry protocol. It does not silently move old rows or recycle their IDs with changed payloads. Frame corrections apply only before emission.
- A wall/boot transition without enough retained frame evidence cannot yield an exact duration across the transition. Boot estimates are state delimiters only. No span is emitted merely because the clock or a boot estimate moved.

No subagents or commits were used. Original `REVIEW-2.md` remains unchanged. Changes remain in the Android ownership scope.
