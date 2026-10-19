# Android third review: final verification

Reviewer: review agent, 2026-10-20. Read-only. No source, test, build or workflow file changed. This file is the only file written in the checkout. Scope: the second-round fixes in `EventFrames.kt`, `SampledEvents.kt`, `Timeline.kt`, `CollectionPolicy.kt`, `Tracker.kt` and `Vault.kt`, checked against `REVIEW-2.md` and `REVIEW-2-RESOLUTION.md`.

## Verdict

The four REVIEW-2 findings are fixed for the sequences REVIEW-2 described. One actionable bug remains on the reboot path. When the first collection after an unclean reboot runs less than 60 seconds after boot, the boot cut is never applied. The open span is billed through the reboot downtime, and the first visit of the new boot is dropped (R3-M1). Everything else I found is ambiguous platform evidence that the code deliberately resolves as undercount, listed under residual limits.

## What I checked

- Read every changed production file in full, plus the startup-pending persistence in `Vault.kt` and the receiver triggers in the manifest and `SyncWorker.kt`.
- Test artifacts: 60 tests, 0 failures, 0 errors (AccountQueue 4, CollectionPolicy 11, HttpUpload 1, PlatformModel 22, Protocol 5, SyncEngine 5, Timeline 12). The XML is from 00:10:41 and the newest source (`Vault.kt`) is from 00:10:06, so the results cover the current sources. I did not rerun the full build, lint or APK signing.
- `PlatformModelTest` has the literal REVIEW-2 appendix cases t1, t1b, t2, t3, t4, t6 and t7, and its `History` model applies the AOSP shift independently of the collector.
- Fetched AOSP `android14-release` `Notifier.java`, `ActivityManagerService.java` and `UserController.java` to close REVIEW-2's open question about a boot-time screen event (see below).
- Ran one scratch JUnit class against the unchanged production code, in a throwaway copy under `%TEMP%` using the checkout's `.tools` JDK and SDK. The copy has been deleted. The source is in the appendix.

## Finding

### R3-M1. A first collection less than 60 s after an unclean reboot skips the boot cut and bills the downtime

`CollectionPolicy.collect` passes `bootAt = p.now - p.elapsed` to `reconstruct` only when `!sameBoot`. `reconstruct` applies the cut only if `bootAt < end`, where `end = eventNow - 60 s`. `samples()` then stores the new boot count, so every later collection has `sameBoot = true` and `bootAt = null`. If the first post-boot collection runs with `elapsedRealtime < 60 s`, the cut is outside `[cursor, end)` and is lost for good.

With a clean reboot the retained SHUTDOWN closes the span on a later pass, so that case is fine. With an unclean reboot (the R2-M1 case, SHUTDOWN at or before the cursor, or no SHUTDOWN at all), nothing ends the old boot:

1. The first collection advances the cursor to `end1`, which is after the real power-off. Old `open`, `active`, `interactive` and `unlocked` carry over.
2. The next collection sees STARTUP with `startupPending = false` and seals `open` at `initial.cursor`, which is now `end1`, not the last pre-boot checkpoint. It also clears the new boot's SCREEN_ON and UNLOCK gates, which is the R2-H1 behavior again.

Repro (scratch): RESUME at 3600 s, collect at 7200 s (cursor 7140 s), crash, SHUTDOWN synthesized at 5400 s, boot at 9600 s, SCREEN_ON 9620 s, UNLOCK 9640 s, STARTUP 9640.2 s, RESUME 9700 s, PAUSE 10000 s. First collection at boot elapsed 45 s, second at 12000 s.

```
elapsed=45s first collect
  ideal:  [3600,7140), [9700,10000)
  actual: [3600,9585)               (2445 s overcount, 300 s first visit lost)
elapsed=120s first collect
  actual: [3600,7140), [9700,10000) (correct)
```

Why this is reachable: `ClockReceiver` collects on `BOOT_COMPLETED`, which is delivered right after the first unlock. A fast-booting phone with a quick PIN entry can deliver it with less than 60 s of elapsed time. Unclean reboots (crash, watchdog, forced restart) are less common than clean ones, but this path produces overcount, which the design is supposed to rule out.

Fix direction: do not let the boot cut depend on whether it falls inside the first post-boot window. For example, persist a pending boot cut in `TrackingState` (the boot estimate and the pre-boot cursor) when `!sameBoot`, and apply it in the reconstruct that first reaches it. The seal must use the stored pre-boot cursor, not the current `initial.cursor`. Add a fixture that runs the first post-boot collection at elapsed < 60 s, with SHUTDOWN before the cursor and with SHUTDOWN missing.

## REVIEW-2 findings rechecked

| Prior | Status | Basis |
|---|---|---|
| R2-H1 startup order | Fixed, except R3-M1 | SHUTDOWN sets `startupPending`. The first later group sets `running`. STARTUP keeps gates already set in the new boot. Pending state survives collections and `Vault` (`optBoolean("startupPending", !running)`). Test t1/t1b and the before/after unlock cases match AOSP order. |
| R2-H2 history shift | Fixed when evidence exists | Worked through t4 by hand: drift -90 s, expected shift -90 s, RESUME and PAUSE marks agree, `Uniform(-90000)`. The cursor moves to 1h57m30s, so the PAUSE at 1h58m00s is read and the personal hour is not billed. In t3 the forward shift keeps the gap. Only cursor, open, and finite selection and zone entries move. `MIN_VALUE` sentinels and sessions do not. |
| R2-H2 fallback | Conservative, as documented | `Missing`, or proof 0 with an expected shift over 2 s, goes to `uncertainBoundary`. The confirmed tail must match marks exactly (time and signature), so shifted history cannot be replayed in the old frame. The cursor moves past both frame bounds plus 2.5 s, so old events cannot come back as fresh resumes. |
| R2-H2 query race | Fixed | `SampledEvents` returns null when wall, elapsed, boot or permission changes during the query. `collect` keeps the checkpoint on null and `Tracker.collect` retries once. |
| R2-M1 shutdown before cursor | Fixed when the first post-boot collection is at elapsed >= 60 s | The boot cut seals at the pre-boot cursor. R3-M1 covers the faster case. |
| R2-L1 >96 h carry | Fixed | Staleness depends on the first returned event after the cursor. `sealProven` keeps the proven prefix before reset. |

## Duplicate-output invariants

- Every path that emits from `open` sets `open = null` in the same step: SHUTDOWN, unmatched STARTUP, boot cut, gate close, `sealProven` before a state reset, and the uncertain-tail reconstruct followed by a seal of the state it returns. `sealProven` only seals `open < checkpoint`, so a span the tail reopens is not sealed.
- Moving the cursor and the events by the same proven shift keeps the set of events above the cursor unchanged. Nothing is processed twice.
- After a proven backward shift, already-emitted rows (old frame) can overlap later rows (new frame) by up to |shift| in UTC. The server union absorbs this as at most |shift| undercount, never double time. This follows from the immutable-row contract and is not a bug.
- `enqueue` dedupes by ID. The uncertain path advances the cursor past every tail event it replayed.

## AOSP check that closes a REVIEW-2 limit

REVIEW-2 did not confirm whether `SCREEN_INTERACTIVE` is written at boot. It is. In `UserController.onSystemReady`, `mInjector.reportCurWakefulnessUsageEvent()` calls `ActivityManagerService.reportCurWakefulnessUsageEvent`, which reports `SCREEN_INTERACTIVE` when wakefulness is awake. System ready comes before the first unlock, so the event is queued and gets a timestamp earlier than DEVICE_STARTUP. That matches the order the new fixtures use.

## Residual limits (ambiguous evidence, not code bugs)

- **Repeated patterns can produce a false `Missing`.** `prove` rejects any second offset with two or more agreeing marks within 2.5 s of the expected shift. With no correction at all, this happens if one signature repeats three times at exactly equal millisecond spacing within 2.5 s, or two signatures repeat with the same millisecond spacing (for example, SCREEN_OFF and LOCK stamped in the same millisecond, twice within 2.5 s). The result is a one-time uncertain boundary: proven work is sealed, gates reset, and nothing more is counted until fresh screen and unlock events. It needs exact millisecond coincidences, so I rate it as residual ambiguity. A device log would show whether any event pair is routinely stamped in the same millisecond.
- **Threshold-edge jitter.** If AOSP measures 1,999 ms (no shift) while the app measures more than 2,000 ms, or AOSP's reference snapshot disagrees with the app's after an `initialize`, the app records a false uncertain boundary. Android's time detector rarely makes changes under 2 s, so this band should almost never be hit.
- **Cross-boot frame.** With `!sameBoot` the proof is forced to `Uniform(0)`. An AOSP shift that happens between first unlock and the `BOOT_COMPLETED` collection is not fingerprinted. The window is seconds long and post-boot corrections are usually small.
- **OEMs that disable time correction.** Every correction over 2 s goes through the uncertain boundary, as designed. Sub-threshold drift accumulates in `eventOffset` and can hit the same boundary after several small steps.
- Already documented: missing OEM close events, same-class concurrent instances, unobserved permission revoke and regrant, and immutable rows written under a wrong past clock.

## Verification limits

- No phone or emulator. Every platform behavior here comes from AOSP source, not captured `dumpsys usagestats` logs. The models are derived from source and are not phone truth.
- I did not measure real `BOOT_COMPLETED` delivery latency. R3-M1 depends on it being under 60 s of `elapsedRealtime`.
- I did not re-review account, transport, selection, deletion, iOS or the worker. Those held up in the previous review and were outside this scope.
- No full Gradle, lint or APK rerun. I relied on the existing artifacts, which postdate the newest source file.

## Appendix: scratch test

Put this in `app/src/test/java/app/clocked/mobile/` in a throwaway copy and run `gradlew testDebugUnitTest --tests app.clocked.mobile.Review3ScratchTest`. The output goes to `%TEMP%/clocked-review3-results.txt`.

```kotlin
package app.clocked.mobile

import org.junit.Test
import java.io.File

class Review3ScratchTest {
    private val base = 1_800_000_000_000L
    private val out = File(System.getProperty("java.io.tmpdir"), "clocked-review3-results.txt")
    private fun snapshot(s: Long, el: Long, boot: Int) = PlatformSnapshot(base + s * 1000, el * 1000, boot, true, true, true, true, true, "UTC")
    private fun data() = DeviceData(token = "clk_test_credential", selected = setOf("work"), state = TrackingState(base, interactive = true, unlocked = true),
        zone = "UTC", permission = true, boot = 1, wall = base, elapsed = 0)
    private fun ev(s: Long, kind: Kind, pkg: String = "work") = UsageEvent(base + s * 1000, kind, pkg, "Main")
    private fun src(e: List<UsageEvent>) = EventSource { a, b -> e.filter { it.at >= a && it.at < b }.sortedBy { it.at } }
    private fun fmt(d: DeviceData) = Timeline.union(d.sessions.map { it.interval }).joinToString { "[${(it.start - base) / 1000},${(it.end - base) / 1000})" } +
        " open=${d.state.open?.let { (it - base) / 1000 }} pending=${d.state.startupPending}"

    private fun run(firstElapsed: Long): String {
        val d = data()
        val pre = listOf(ev(3600, Kind.RESUME))
        CollectionPolicy.collect(d, snapshot(7200, 7200, 1), src(pre))
        val e = pre + listOf(ev(5400, Kind.SHUTDOWN), ev(9620, Kind.SCREEN_ON), ev(9640, Kind.UNLOCK),
            UsageEvent(base + 9640_200, Kind.STARTUP), ev(9700, Kind.RESUME), ev(10000, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(9600 + firstElapsed, firstElapsed, 2), src(e))
        val mid = fmt(d)
        CollectionPolicy.collect(d, snapshot(12000, 2400, 2), src(e))
        return "after first: $mid\n  final: ${fmt(d)}"
    }
    @Test fun fastFirstCollect() { out.appendText("elapsed=45s first collect\n  ideal: [3600,7140), [9700,10000)\n  ${run(45)}\n") }
    @Test fun slowFirstCollect() { out.appendText("elapsed=120s first collect\n  ideal: [3600,7140), [9700,10000)\n  ${run(120)}\n") }
}
```
