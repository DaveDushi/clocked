# Android second independent review

Reviewer: independent review agent, 2026-10-19. Read-only. No source, test, build, or workflow file was changed. This file is the only file written in the checkout. Scope: `mobile/CONTRACT.md`, `REVIEW.md`, `REVIEW-RESOLUTION.md`, `VERIFICATION.md`, and the current production sources under `mobile/android/app/src/main`.

## Verdict

Not ready to claim correct tracking across reboots and clock corrections. The 24-hour cutoff fix (old H1), the timestamped selection history (old H3), the network/lock split (old M2), and the deletion confirmation (old M3) hold up under adversarial sequences. The reboot and clock fixes (old H2 and M1) were tested against an event model that does not match what Android's UsageStats service actually writes:

- Android stamps `DEVICE_STARTUP` at the first user unlock. That is after the boot-time screen and unlock events. The collector resets its gates when it sees STARTUP, so the first screen session after every reboot is not counted.
- Android rewrites its whole stored event history when the wall clock changes by more than 2 seconds. The collector assumes old event timestamps stay put. A 90-second backward correction can turn into an hour of overcount. A large correction drops the in-progress work session and misplaces events.

Both platform behaviors come from AOSP source, cited below. The existing tests pass because their fixtures encode the opposite behavior.

## What I checked and how

- Read every production file: `CollectionPolicy.kt`, `Timeline.kt`, `Tracker.kt`, `SyncEngine.kt`, `HttpUpload.kt`, `SyncWorker.kt`, `Vault.kt`, `Protocol.kt`, `MainActivity.kt`, and the manifest. Read `CollectionPolicyTest.kt` in full.
- Read AOSP `android14-release` sources from android.googlesource.com:
  - `services/usage/java/com/android/server/usage/UserUsageStatsService.java`: `init` (lines 139-193) and `checkAndGetTimeLocked`/`onTimeChanged` (lines 266-292).
  - `UsageStatsService.java`: `onUserUnlocked` (lines 434-489), `ENABLE_TIME_CHANGE_CORRECTION` (line 144, default `true` via `persist.debug.time_correction`), and `TIME_CHANGE_THRESHOLD_MILLIS = 2000` (line 156).
  - `UsageStatsDatabase.java`: `onTimeChanged` (lines 688-733).
  - `UsageStatsProtoV2.java`: event times are stored as offsets from the file begin time (lines 247, 394).
- Ran 7 scratch JUnit sequences against the unchanged production `CollectionPolicy` and `Timeline`. They ran in a throwaway copy of `mobile/android` under `%TEMP%`, using the checkout's `.tools` JDK and SDK, and the copy was deleted afterwards. The test source is in the appendix so the results can be reproduced.
- Inspected existing build artifacts without rebuilding. `app/build/test-results` holds 43 tests (AccountQueue 4, CollectionPolicy 16, HttpUpload 1, Protocol 5, SyncEngine 5, Timeline 12), 0 failures, 0 errors. The report timestamp (23:34:54 local) is later than the newest source file (`SyncWorker.kt`, 23:34:21). The APK SHA-256 is `af59b93c…da42`, which matches `VERIFICATION.md`. `lint-results-debug.txt` reports 4 warnings and no errors. I did not rerun the full build because nothing in this review depended on a fresh one.

## Findings, most severe first

### R2-H1. The first screen session after every reboot is not counted

`Timeline.kt:40-43` handles a STARTUP group with `active.clear(); interactive = false; unlocked = startupUnlocked; open = null`. That reset assumes STARTUP comes before the boot's gate events. In AOSP it comes after them:

- `UserUsageStatsService.init` synthesizes both events after a reboot: `DEVICE_SHUTDOWN` at `max(lastTimeSaved, endTime)` and `DEVICE_STARTUP` at `System.currentTimeMillis()`.
- `init` runs from `UsageStatsService.onUserUnlocked`, which runs at the first credential unlock after boot.
- Events reported before that unlock are queued (`reportEventOrAddToQueue`). They are replayed after `init` with their original elapsed-time timestamps. Those timestamps are earlier than STARTUP.

On a secure device, the user must wake the screen and enter the PIN before the unlock, so `SCREEN_INTERACTIVE` always comes before STARTUP. `KEYGUARD_HIDDEN` races with it. After STARTUP the collector has `interactive = false`, and `unlocked = false` on secure devices. Nothing counts until the screen turns off and on again. On non-secure devices, `startupUnlocked` sets `unlocked`, but `interactive` is still false. Any `RESUME` between SHUTDOWN and STARTUP is also ignored, because `running` is false.

Repro (scratch `t1`, secure, events in AOSP order: RESUME 1h, SHUTDOWN 2h, SCREEN_ON 2h01, UNLOCK 2h02, STARTUP 2h02+200ms, RESUME 2h03, PAUSE 3h03):

```
ideal:  [3600s,7200s) + [7380s,10980s) total=7200s
actual: [3600s,7200s) total=3600s
```

Scratch `t1b` (non-secure swipe lock) gives the same loss. The existing `rebootReadsShutdownBeforeStartupAndRequiresSecureUnlock` and `rebootWithoutKeyguardHiddenEventStillCountsNonSecureDevice` tests put SCREEN_ON and UNLOCK after STARTUP, which is the reverse of what the platform writes.

Impact: every reboot (OS updates, overnight restarts, battery) drops the first working session, until the screen next times out or is locked. This is systematic undercount, not an edge case.

Fix direction: SHUTDOWN and STARTUP are always written together at `init`, so every event after a SHUTDOWN belongs to the new boot. Reset gates and `active` at SHUTDOWN (this already happens). Set `running = true` again at the first event after SHUTDOWN. At STARTUP, do not clear gates that later boot events already set. Replace the fixtures with the AOSP order, and add a case where KEYGUARD_HIDDEN lands just before STARTUP and one where it lands just after.

### R2-H2. Clock corrections do not match how UsageStats rewrites history

AOSP `UserUsageStatsService.checkAndGetTimeLocked` runs on every `queryEvents` call (`validRange(checkAndGetTimeLocked(), …)`). When wall time drifts from elapsed-realtime by more than 2 seconds, `onTimeChanged` persists the current stats. `UsageStatsDatabase.onTimeChanged` then renames every stats file to `beginTime + diff`. Event times are stored as offsets from the file's begin time, so every retained event moves by the same diff. This is on by default.

The collector does three things that conflict with this:

1. For corrections from 2 to 120 seconds (`CollectionPolicy.kt:61`), it continues normally with `cursor`, `open`, selection change times and zone change times still on the old clock, while the platform's events are now on the new clock.
2. For larger jumps (`CollectionPolicy.kt:63-75`), it processes `[cursor, trustedEnd)` as if pre-jump events still had their old timestamps.
3. Regardless of shifting, the large-jump path drops the open span entirely. `initialize` replaces `state`, and `uncertainOpen` only goes into the notice. The span was proven working through the previous checkpoint and should have been closed at that checkpoint.

Repros (scratch):

- `t4`, a 90-second backward correction. Work runs from 1h until a PAUSE at 1h59m30s, which falls in the 60-second tail of a collect at 2h. That is the normal pattern when the user leaves a work app and opens Clocked, which runs `onResume` sync. History shifts by -90 s, so the PAUSE lands below the cursor and is never read. The user then spends an hour in a personal app with the screen on.
  ```
  ideal:  about 3570s
  actual: [3600s,10800s) total=7200s     (one hour of personal use billed as work)
  ```
- `t2`, a +10 minute correction during a work session that started at 1h, using the test file's own unshifted model:
  ```
  ideal:  at least [3600s,7140s) retained
  actual: total=0s, open restarted at the new boundary
  ```
  The existing `largeForwardJumpKeepsClosedWorkAndRestoresActivityAtNewBoundary` test asserts this loss (the 3h-to-jump visit disappears).
- `t3`, a +10 minute correction with the platform shift applied. The real pattern is 59.5 minutes of work, a 10-minute gap, then 10 minutes of work. The output is a single 69.5-minute block that spans the gap, and the second real session is lost. The total matches only by coincidence; the intervals are wrong, and they are what the server unions with desktop time.

Frequency depends on the device. Corrections above 2 seconds come from network time and NITZ fixes, carrier NITZ glitches, and manual changes. OEMs can turn the correction off with `persist.debug.time_correction`, in which case the app's current model holds for small jumps.

Fix direction: compute `D = now - (wall + elapsed delta)` the same way AOSP does. When `|D| > 2 s` and the boot is the same, shift the persisted `cursor`, `open`, `wall`, selection change times and zone change times by `D`, then collect normally. This keeps the app in the same frame as the shifted history, and it needs no uncertainty boundary. Keep a fallback for devices where history was not shifted. One way to detect that: compare the timestamp of a known pre-jump event, such as the last processed event, which the app could store as a fingerprint. Whatever happens, close any open span at the last trusted checkpoint instead of dropping it. Add fixtures that shift history the way `UsageStatsDatabase.onTimeChanged` does.

### R2-M1. An unclean reboot drops the whole open span when the synthesized SHUTDOWN is before the checkpoint

The SHUTDOWN timestamp is `max(lastTimeSaved, endTime)`, the last flush or last event time, not the real power-off time. After a crash or a forced restart, the last flush can be up to 20 minutes (`FLUSH_INTERVAL`) before power-off. If the app collected after that flush, `Timeline.kt:34` filters the SHUTDOWN out (`it.at >= initial.cursor`). The STARTUP-without-SHUTDOWN branch then drops `open` with no interval.

Repro (scratch `t7`): RESUME at 1h, collect at 2h (cursor 1h59m), SHUTDOWN synthesized at 1h30, STARTUP at 2h30.

```
ideal:  at least [3600s,7140s)   (working through the checkpoint)
actual: total=0s
```

Clean shutdowns should flush first, so this mostly affects crashes, hard resets, and OEM watchdog reboots. I did not confirm the clean-shutdown flush timing on a device.

Fix: when a boot boundary arrives and the SHUTDOWN is at or before the cursor (or missing), close `open` at `max(shutdownAt, previous cursor)`.

### R2-L1. A gap over 96 hours discards a carried open span that the retained events close

`CollectionPolicy.kt:98-99` replaces the carried state with an empty one whenever `end - cursor > 96h`, even if the returned events start right at the cursor and contain the closing gate.

Repro (scratch `t6`): open since 1h, next collect at 102h, and the returned history includes SCREEN_OFF at 3h.

```
ideal:  [3600s,10800s)
actual: total=0s
```

Fix: decide staleness from the evidence, for example the earliest returned event being well after the cursor, not from the gap length. Low, because a gap over 96 hours requires the app not to run for four days.

## Prior findings rechecked

| Prior | Status | Basis |
|---|---|---|
| H1 24h cutoff | Fixed | `process` queries the whole `[cursor, end)` gap. Only the >96h carry rule remains (R2-L1). |
| H2 reboot/time/zone resets | Partly fixed | The zone change path is correct: UTC is kept, and the metadata splits at the change. Reboot and clock handling are wrong against real platform data (R2-H1, R2-H2, R2-M1). The receiver no longer resets anything. |
| H3 selection during 60 s lag | Fixed | `changeSelection` records `max(now, cursor, last.at)`. `reconstruct` applies changes in time order with events and keeps `open`. Checked: deselect after a PAUSE in the tail, select an already-resumed app, several toggles inside one tail, a change at the same millisecond as an event, and a change made while collection fails (cursor not advanced). The only remaining issue is clock shift (inside R2-H2). |
| M1 foreground after reset | Fixed for permission and account boundaries | `initialize` replays 96h and seeds gates from live state. The large-clock path inherits R2-H2's open-span loss. Reboots do not go through `initialize` (R2-H1). |
| M2 network under lock | Fixed | Capture, initiation and acknowledgment are three separate lock sections, with an epoch/origin/token recheck before initiation and before ACK. OkHttp `enqueue` keeps DNS off the caller. A 40 s call timeout and a 45 s caller deadline apply. Broadcasts only call `collectOnly`. A concurrent sync for the same epoch returns `false` and does not double-send. A late response after an account change writes nothing. |
| M3 destructive change | Fixed | The dialog shows the pending count and union duration. `DeletionConsent` binds the epoch and pending IDs, so new unsynced rows force another review. |
| M4 missing close | Deferred, inherent | It is still unbounded until a gate. R2-H2's `t4` shows a new way to reach this state: a close event erased by a history shift. |
| M5 work profile | Documented | No change needed for this review. |
| L1-L7 | Fixed or reasonably deferred | Fallback intents, `MODE_DEFAULT`, serial AppOps executor, REPLACE for user-initiated work, accessible rows, rejected-row rotation. |

Sequences that held up: two selected apps in split screen with interleaved RESUME/PAUSE (one union, no zero-length gap, because a same-timestamp group is evaluated once); an unrelated resume during split screen; a midnight/DST split with a zone change during an open visit; account switch with an upload in flight; a revoke callback while a worker collect holds the lock (initialize resets the cursor on regrant, so nothing is double-counted); duplicate interval emission (the ID check in `enqueue`, plus server upsert by ID).

## Verification limits

- No phone or emulator. Every AOSP behavior above is from `android14-release` source only. I did not check every Android version or OEM build, and OEMs can change `persist.debug.time_correction`.
- I did not confirm whether `SCREEN_INTERACTIVE` is written at boot. R2-H1 does not depend on it, because STARTUP clears `interactive` either way.
- The scratch tests model platform event order from source reading, not captured device logs. A device check should run `adb shell dumpsys usagestats` after a reboot and after `adb shell date` or a manual time change, and compare event order and timestamps with the fixtures here.
- I reviewed only the Android client. I did not review the server's union in `worker/src/report.ts` or the dashboard totals again. I did not review iOS.
- No full Gradle rerun. I relied on the existing test XML, APK and lint artifacts, which are consistent with `VERIFICATION.md`.

## Appendix: scratch sequences

Put this file in `app/src/test/java/app/clocked/mobile/` in a throwaway copy and run `gradlew testDebugUnitTest --tests app.clocked.mobile.Review2ScratchTest`. Results go to `%TEMP%/clocked-review2-results.txt`.

```kotlin
package app.clocked.mobile

import org.junit.Test
import java.io.File

class Review2ScratchTest {
    private val min = 60_000L
    private val hour = 3_600_000L
    private val base = 1_800_000_000_000L
    private val out = File(System.getProperty("java.io.tmpdir"), "clocked-review2-results.txt")
    private fun snapshot(now: Long, elapsed: Long = now - base, boot: Int = 1, zone: String = "UTC",
        secure: Boolean = true, allowed: Boolean = true) = PlatformSnapshot(now, elapsed, boot, allowed, true, true, true, secure, zone)
    private fun data() = DeviceData(token = "clk_test_credential", selected = setOf("work"), state = TrackingState(base, interactive = true, unlocked = true),
        zone = "UTC", permission = true, boot = 1, wall = base, elapsed = 0)
    private fun ev(at: Long, kind: Kind, pkg: String = "work") = UsageEvent(base + at, kind, pkg, "Main")
    private fun source(events: List<UsageEvent>) = EventSource { s, e -> events.filter { it.at >= s && it.at < e }.sortedBy { it.at } }
    private fun fmt(d: DeviceData) = Timeline.union(d.sessions.map { it.interval }).joinToString { "[${(it.start - base) / 1000}s,${(it.end - base) / 1000}s)" } +
        " total=${Timeline.union(d.sessions.map { it.interval }).sumOf { it.end - it.start } / 1000}s open=${d.state.open?.let { (it - base) / 1000 }}"
    private fun log(name: String, ideal: String, d: DeviceData) = out.appendText("$name\n  ideal: $ideal\n  actual: ${fmt(d)}\n")

    @Test fun t1_rebootAospOrderSecure() {
        val d = data()
        val e = listOf(ev(hour, Kind.RESUME), ev(2 * hour, Kind.SHUTDOWN), ev(2 * hour + min, Kind.SCREEN_ON),
            ev(2 * hour + 2 * min, Kind.UNLOCK), ev(2 * hour + 2 * min + 200, Kind.STARTUP),
            ev(2 * hour + 3 * min, Kind.RESUME), ev(3 * hour + 3 * min, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 5 * hour, elapsed = 3 * hour, boot = 2), source(e))
        log("t1 reboot, secure, AOSP order", "[3600s,7200s) + [7380s,10980s) total=7200s", d)
    }

    @Test fun t1b_rebootAospOrderNonSecure() {
        val d = data()
        val e = listOf(ev(hour, Kind.RESUME), ev(2 * hour, Kind.SHUTDOWN), ev(2 * hour + min, Kind.SCREEN_ON),
            ev(2 * hour + min + 500, Kind.STARTUP), ev(2 * hour + 2 * min, Kind.UNLOCK),
            ev(2 * hour + 3 * min, Kind.RESUME), ev(3 * hour + 3 * min, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 5 * hour, elapsed = 3 * hour, boot = 2, secure = false), source(e))
        log("t1b reboot, non-secure swipe, AOSP order", "[3600s,7200s) + [7380s,10980s) total=7200s", d)
    }

    @Test fun t2_largeForwardJumpDropsOpenSession() {
        val d = data()
        val e = listOf(ev(hour, Kind.RESUME))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(e))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour + 40 * min, elapsed = 2 * hour + 30 * min), source(e))
        log("t2 +10min jump during open session (test's unshifted model)", "at least [3600s,7140s) retained", d)
    }

    @Test fun t3_largeForwardJumpWithPlatformHistoryShift() {
        val d = data()
        val pre = listOf(ev(hour, Kind.RESUME), ev(2 * hour - 30_000, Kind.PAUSE), ev(2 * hour + 10 * min, Kind.RESUME), ev(2 * hour + 20 * min, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(pre))
        val shifted = pre.map { it.copy(at = it.at + 10 * min) }
        CollectionPolicy.collect(d, snapshot(base + 2 * hour + 40 * min, elapsed = 2 * hour + 30 * min), source(shifted))
        log("t3 +10min jump with AOSP history shift", "59.5min + 10min = 4170s of work", d)
    }

    @Test fun t4_smallBackwardCorrectionWithShiftLosesPause() {
        val d = data()
        val pre = listOf(ev(hour, Kind.RESUME), ev(2 * hour - 30_000, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(pre))
        val after = pre.map { it.copy(at = it.at - 90_000) } + listOf(ev(2 * hour, Kind.RESUME, "personal"), ev(3 * hour, Kind.SCREEN_OFF))
        CollectionPolicy.collect(d, snapshot(base + 4 * hour, elapsed = 4 * hour + 90_000), source(after))
        log("t4 -90s correction with AOSP history shift", "about 3570s (work ended at 1h59m30s)", d)
    }

    @Test fun t6_staleCarryDropsOpenThatGapEventsClose() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(listOf(ev(hour, Kind.RESUME))))
        CollectionPolicy.collect(d, snapshot(base + 102 * hour), source(listOf(ev(hour, Kind.RESUME), ev(3 * hour, Kind.SCREEN_OFF))))
        log("t6 >96h gap where retained events close the carried open span", "[3600s,10800s)", d)
    }

    @Test fun t7_uncleanRebootShutdownBeforeCursor() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(listOf(ev(hour, Kind.RESUME))))
        val e = listOf(ev(hour, Kind.RESUME), ev(hour + 30 * min, Kind.SHUTDOWN), ev(2 * hour + 30 * min, Kind.STARTUP))
        CollectionPolicy.collect(d, snapshot(base + 3 * hour, elapsed = 20 * min, boot = 2), source(e))
        log("t7 unclean reboot, synthesized SHUTDOWN earlier than cursor", "at least [3600s,7140s) (working through checkpoint)", d)
    }
}
```
