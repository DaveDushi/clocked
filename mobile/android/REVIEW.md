# Android independent review

Reviewer: independent review agent, 2026-10-19. Scope: `mobile/CONTRACT.md`, `mobile/android/**`, `.github/workflows/mobile-android.yml`. Read-only review. No source was changed. `worker/src/ingest.ts` and `worker/src/report.ts` were read to confirm server behavior.

## Verdict

Not ready to claim reliable tracking. The privacy, account-isolation, queue and acknowledgment design is sound. The event reconstruction core (`Timeline.kt`) is careful. But the reset policy in `Tracker.kt` and the boundary receivers throw away large amounts of valid, recoverable work time in ordinary situations: a phone in a low standby bucket, a reboot, an automatic clock correction, a timezone change, or changing the app selection right after using a work app. These are fixable bugs, not platform limits. The events they discard are still held by `UsageStatsManager`, which the docs say keeps them "for a few days".

## Evidence re-run by this review

Re-ran on this machine with the local tools listed in `VERIFICATION.md`:

```
gradlew.bat -p mobile/android --no-daemon --rerun-tasks testDebugUnitTest lintDebug assembleDebug
```

- `BUILD SUCCESSFUL in 46s`, 51 tasks executed (forced rerun, not cached).
- JUnit XML: `TimelineTest` 13, `ProtocolTest` 5, `AccountQueueTest` 4. 22 tests, 0 failures, 0 errors, 0 skipped. This matches the report.
- Lint: `0 errors, 4 warnings`. This matches the report.
- `apksigner verify`: v2 signature valid. The rebuilt APK SHA-256 is `070011ea…c732`, which differs from the `a53443c9…` in `VERIFICATION.md`. A rebuild is expected to change it, but anyone comparing hashes should know.
- Wrapper JAR SHA-256 matches `2db75c40…8046`.

Claims check: `VERIFICATION.md` correctly says no emulator, device, or live upload was used, and that CI has never run. Nothing in the docs claims device verification. Two doc statements are misleading (see L5).

What the tests do not cover: every test exercises pure functions (`Timeline`, `Protocol`, `DeviceData.withConnection/acknowledge`). No test covers `Tracker.collect`, `select`, `invalidateBoundary`, the receivers, or the AppOps listener. Those are where all High findings sit. `shutdownClosesAtLastPersistedTimestampAndIgnoresLaterOpens` tests a path that production cannot reach (H2).

## Official facts checked

- `UsageStatsManager.queryEvents`: "Events are only kept by the system for a few days." Begin is inclusive, end is exclusive. Starting with Android 11 it returns null when the user is not unlocked. ([reference](https://developer.android.com/reference/android/app/usage/UsageStatsManager))
- Standby buckets: on Android 13+, an app moves to the restricted bucket after 8 days without user interaction. Restricted jobs run "once per day" in a 10-minute batched window. Rare allows 10 minutes of jobs per rolling 24 hours. ([App Standby](https://developer.android.com/topic/performance/appstandby), [power limits](https://developer.android.com/topic/performance/power/power-details))
- `android.intent.action.TIME_SET` and `ACTION_TIMEZONE_CHANGED` are exempt from implicit-broadcast limits, so the manifest receiver will wake the app for them. ([exceptions](https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions))
- The 60-second "publication delay" is a choice this app made. It is not a documented platform delay.

## Findings, most severe first

### H1. The 24-hour cursor rule drops whole days on phones in rare or restricted standby (fixable)

`Tracker.kt:66`: `now - data.state.cursor > DAY` resets to `now` without querying. This app is meant to run unattended, so it will often not be opened for 8 or more days. On Android 13+ it then lands in the restricted bucket, where WorkManager runs about once per day. Any gap a little over 24 hours discards the whole day, even though the events are still available.

Reproduce: grant usage access, select an app, do not open Clocked. Force the bucket with `adb shell am set-standby-bucket app.clocked.mobile restricted`. Use the work app for 2 hours. Wait until the next job runs more than 24 hours after the previous one. The status reads "Tracking restarted at a safe boundary" and the 2 hours never appear. The same happens after any force stop longer than 24 hours.

Fix: query from the cursor as long as the cursor is within the event retention window. Use something like 72 to 96 hours, or check whether the earliest returned event is well after the cursor. If the history really has a gap, cut a boundary at the gap instead of dropping everything. Treat a stale `open` (also line 66) by closing it at the last trustworthy gate event or discarding only the open part, not the closed intervals between `cursor` and `now`. Add a `Tracker`-level test with a fake events source.

### H2. Reboot, time-set and timezone boundaries reset without collecting first (fixable)

`SyncWorker.kt:57` calls `invalidateBoundary()` (`Tracker.kt:153-157`) for `BOOT_COMPLETED`, `TIME_SET` and `TIMEZONE_CHANGED`. `collect` does the same for boot count and zone changes (`Tracker.kt:64-66`). Each one sets `cursor = now`, so every completed interval since the last collection is lost, plus any open span. In the rare or restricted bucket that can be up to a day.

- Reboot: the interval between the last collection and shutdown is lost. A span that was open at shutdown is also lost, even though `DEVICE_SHUTDOWN` gives an exact close time and `Timeline.kt:45` already handles it. That shutdown logic is unreachable in production.
- `TIME_SET`: the receiver resets on every clock set, including small automatic network-time corrections. That bypasses the 2-minute drift tolerance `collect` already has (`Tracker.kt:65`). On devices that correct the clock automatically, this throws away data on a recurring basis. Whether it fires for NTP/NITZ corrections depends on the OEM. Verify with `adb shell dumpsys alarm` history or by logging the broadcast on a test device.
- Timezone change: intervals are stored in UTC. The zone only labels sessions and drives the midnight split, so the reset is unnecessary. Reproduce: work in a selected app, travel across a zone boundary or change the zone in Settings. Everything since the last worker run disappears.

Reproduce (reboot): use a selected app for 10 minutes, then reboot within 15 minutes of the last worker run, before the next job. After unlocking, none of the 10 minutes appears.

Fix: on boot, query `[cursor, now)` normally and let `STARTUP` and `SHUTDOWN` close spans. On a zone change, collect with the old zone first, then switch zones. On `TIME_SET`, compare `now` with `wall + (elapsedRealtime - elapsed)`. If the drift is under the threshold, ignore the broadcast. If it is over, collect up to the last trusted point before the jump. Only the jump itself should become a boundary.

Latent issue unmasked by this fix: `STARTUP` sets `unlocked = false` (`Timeline.kt:34`). On a device with no lock screen ("None"), `KEYGUARD_HIDDEN` never fires, so after a reboot that is no longer masked by the reset, tracking would stay off. When processing a startup, seed `unlocked` from the first gate event, or from `KeyguardManager.isDeviceSecure`/`isKeyguardLocked` at collection time when no keyguard events follow.

### H3. Changing the selection right after leaving a work app discards that whole session (fixable)

`Tracker.kt:46-55`: `select` collects only up to `now - 60s` (line 72), then `reset` moves the cursor to `now`. The `[now-60s, now)` window is never queried, and `reset` clears `open`.

Reproduce: use a selected app for 2 hours with the screen on. Switch to Clocked. The `onResume` sync collects to `now-60s`, so the work app's `PAUSE` is not processed yet and the span is still open. Within 60 seconds, check or uncheck any app. The 2-hour span is discarded. Toggling several apps in a row repeats the loss.

Fix: store selection changes with timestamps (`[(effectiveAt, packages)]`) and reconstruct each event against the selection that was active at that event's time. Do not reset the cursor or `open` on a selection change. At minimum, keep the old selection until a later collect passes the change time. This also satisfies "selection changes must not relabel history" without throwing data away. The current `selectionResetDoesNotRelabelHistory` test does not model the 60-second tail.

### M1. After any reset, the app in the foreground is not counted until it resumes again (fixable)

`Tracker.kt:26` builds the new state with `active = emptySet()`. If a reset happens while the user is in a selected app (through the AppOps listener, `TIME_SET`, timezone, the 24-hour rule, or the boot path), the rest of that visit is uncounted until the next `ACTIVITY_RESUMED`. Combined with H2, a clock correction during a long session loses both the past and the remainder of that session.

Fix: after a reset, replay a short recent window (for example the last 30 to 60 minutes) through `Timeline.reconstruct` with output discarded, only to rebuild `active`, `interactive` and `unlocked`. Then set `open = now` if the device is working. That window predates the boundary, so it creates no time before the reset.

### M2. The global lock is held for the whole HTTPS request, with no bound on DNS (fixable)

`Tracker.kt:106-150` holds `Tracker.lock` through connect, write and read. `connectTimeout` and `readTimeout` do not cover DNS resolution, and the request-body write has no explicit timeout. During that time:

- `ClockReceiver` (`SyncWorker.kt:52-63`) uses `goAsync()`, and its thread blocks on the lock. A background broadcast has about a 60-second budget before the system may kill the process. A slow resolver or captive portal can exceed it.
- The AppOps listener thread (`SyncWorker.kt:40-44`) waits, so a revocation is not recorded until the request ends. The pre-network collect already happened, so this is safe for privacy but delays the boundary.
- UI actions wait. `onResume` sync does not set `busy` (`MainActivity.kt:46-52`), so checkboxes and buttons look enabled but hang.

Holding the lock keeps account isolation simple, which is the reason it was done. A safer pattern: under the lock, take a snapshot (`epoch`, `token`, `origin`, batch). Release it, run the request, then reacquire it. Apply acknowledgments only if `epoch` and `token` still match. That keeps the guarantee that old-account data never applies to a new account, and the lock is held for milliseconds. Also cap the total request time.

### M3. Disconnect and token change permanently delete unsynced work time with one tap (fixable UX)

`MainActivity.kt:128` (Disconnect) and `MainActivity.kt:127` with `Vault.kt:25-27` (any token or origin change) replace the vault, and the pending sessions are lost. There is no confirmation and no count. Isolating the new account is correct, but rotating a token on the same account or tapping Disconnect by mistake silently loses billable time.

Fix: show a confirmation with the pending count ("12 sessions (3h 10m) have not synced and will be deleted"). Offer to sync with the current token first. Keep the `withConnection` isolation behavior unchanged.

### M4. A missed closing event overcounts until the screen turns off (partly platform, mitigable)

`Timeline.kt:49`: once a selected activity key is in `active`, time accrues until a matching `PAUSE`/`STOP`, a screen-off, a keyguard or a shutdown. If a closing event is missing (an OEM bug, a crash path that does not report `ACTIVITY_STOPPED`, an event older than the 60-second allowance), time keeps accruing while the user is in unselected apps, until the screen turns off. Missing events themselves are a platform gap. The unbounded overcount is not: any `ACTIVITY_RESUMED` from an unselected package while no selected activity is in multi-resume could close stale keys. On API 29+ this needs care, because multi-resume allows several resumed apps. A conservative option: evict a selected key when the same task area gets a newer resume. At minimum, document it and verify it on a device by killing a selected app with `adb shell am kill` while it is in the foreground.

### M5. Work profile apps are not covered (platform gap, needs documentation)

`MainActivity.kt:82-85` lists launcher apps for the current profile only, and `queryEvents` returns events for the calling user only. Many people keep work apps in an Android work profile. If the same package (for example Slack) exists in both profiles, a user can select the personal copy believing it is the work app. The work-profile copy is never counted and the personal copy is. This is a real platform limit for an app installed only in the personal profile. The README should say so and point users to installing Clocked inside the work profile, which needs its own device check for screen and keyguard events.

### L1. Settings and browser intents can crash on some devices (fixable)

`MainActivity.kt:117` opens `ACTION_USAGE_ACCESS_SETTINGS` with a `package:` URI. Some OEM settings apps do not declare the data-scheme variant, which throws `ActivityNotFoundException` and crashes in `onClick`. Retry without the URI, and catch the exception. `MainActivity.kt:109` (`ACTION_VIEW` dashboard) has the same uncaught crash when no browser is installed.

### L2. `hasPermission` ignores `MODE_DEFAULT` (fixable)

`Tracker.kt:20-21` accepts only `MODE_ALLOWED`. When the mode is `MODE_DEFAULT`, Android uses the runtime grant (`checkSelfPermission(PACKAGE_USAGE_STATS)`), as with `adb shell pm grant` or managed devices. Those devices show "Usage access is off" forever. Treat `MODE_DEFAULT` as `checkSelfPermission == GRANTED`.

### L3. AppOps listener: one ordering gap (mostly acceptable)

`SyncWorker.kt:40-44`: each callback starts a raw thread. For quick revoke-then-grant toggles, thread order is arbitrary, but every thread reads `hasPermission()` when it runs and resets, so the final state is consistent. The listener exists only while the process is alive. A revoke-and-regrant entirely while the process is dead is invisible, and on return the collector uploads time from the revoked period. That conflicts with treating revocation as opt-out. This is a real platform gap (no public AppOps history), correctly documented. One cheap mitigation: re-register the watch in `MainActivity` too, and compare `data.permission` with live state on every worker run, which is already done.

### L4. `clocked-now` uses `ExistingWorkPolicy.KEEP` (fixable)

`SyncWorker.kt:33-36`. If an earlier one-time job is in exponential backoff (for example after a 401), saving a corrected token enqueues nothing new. The next upload waits for the backoff or the next app resume. Use `REPLACE` for user-initiated saves.

### L5. Doc and UI accuracy (fixable)

- `README.md:34` says shutdown events "can close a span". In production a reboot resets before those events are read (H2).
- `README.md:26` and the 60-second constant (`Tracker.kt:72`) present a one-minute "event publication delay" as if Android documented one. Call it a safety margin chosen by the app.
- The footer at `MainActivity.kt:155` says events older than 24 hours are not backfilled. It does not tell users that, for an app they rarely open, Android may run background work only once a day, so whole days can be dropped (H1). After fixing H1, update the text.
- The status from a reset (`Tracker.kt:68`) is overwritten by "Synced N sessions" (`Tracker.kt:144`) in the same run, so users never see that time was discarded. Keep a separate "last boundary" notice.

### L6. Checkbox rows are not accessible (fixable)

`MainActivity.kt:139-145`: the `Checkbox` has no label semantics and the row is not `toggleable`. TalkBack reads an unlabeled checkbox, and the touch target is the box only. Use `Modifier.toggleable(role = Role.Checkbox)` on the row with `onCheckedChange = null` on the box.

### L7. Smaller items

- Head-of-line rejection: the batch is always the first 500 unsynced sessions (`Tracker.kt:113`). The server drops invalid rows and accepts the rest (`ingest.ts:71-110`), so a few bad rows are fine. Sessions recorded while the device clock was more than 24 hours fast are rejected (`ingest.ts:151`) until real time catches up, and 500 of them would block the queue. That is unlikely. Consider moving rejected IDs to the back of the queue.
- `Vault.write` rewrites the whole encrypted file on every resume and every 15 minutes, including 90 days of synced history. That is fine at current sizes. Watch it if the backlog grows.
- The token field is cleared before `configure` validates (`MainActivity.kt:127`), so an origin typo forces the user to paste the token again.
- The server field is not prefilled with the hosted origin from `mobile/README.md:12`.
- There is no in-app "reset local data" action for the unrecoverable-vault case. The user must find Clear storage in system settings.
- The CI actions are pinned by major tag, not commit SHA. The workflow has not run yet.

## Confirmed sound

- Privacy: the wire body has exactly six fields, `reasons` are always `app`, and nothing in uploads, logs or URLs reveals package names, labels or selections. Package and class strings exist only in memory and in the encrypted vault (`active`).
- Server contract: `/sessions` upserts by ID and returns the IDs of retried rows and tombstoned rows in `accepted` (`worker/src/ingest.ts:78-110`). A crash after server acceptance but before the local write causes a harmless resend. Only sent IDs that appear in `accepted` are acknowledged. A malformed response acknowledges nothing.
- Account isolation: `configure`, `sync` and `disconnect` are serialized, a new epoch is created on any credential change, and the old queue cannot reach a new token. Redirects are disabled, HTTPS only, cleartext disabled.
- Storage: AES-GCM with a non-exportable Keystore key, an `AtomicFile` in `noBackupFilesDir`, backups and device transfer excluded, and a fail-closed path on decryption errors.
- Reconstruction: same-timestamp grouping, stable sort, deduplication, package plus class keys, resumed-only counting with a multi-resume union, screen and keyguard gates, unknown initial gates treated as not working, and midnight and DST splits using `java.time`. The server unions intervals across devices (`worker/src/report.ts:389-412`), so overlap with desktop time is counted once.

## Known platform gaps (not bugs)

- Same-class concurrent activity instances cannot be told apart.
- OEMs can drop or delay events. Retention is "a few days".
- A revoke-and-regrant while the process is dead cannot be detected.
- Doze, standby buckets, force stop and OEM battery managers delay collection. With H1 fixed, that should delay time, not lose it, within the retention window.
- Picture-in-picture calls and screen-off audio calls in work apps do not count as resumed foreground use.
- Work-profile apps need Clocked installed in that profile (M5).
- Nothing here has run on a physical device. Every lifecycle claim above that depends on OEM behavior needs on-device confirmation.

## Suggested fix order

1. H1, H2 and H3, plus `Tracker` tests using an injectable events source, clock, boot count and permission state. Cover: a 30-hour gap, a reboot with `SHUTDOWN`, a small and a large `TIME_SET`, a zone change, a selection change within 60 seconds of a `PAUSE`, and a no-lock-screen reboot.
2. M1 and M2.
3. M3 and the L items.
4. On-device run: standby bucket forcing, reboot, timezone change, split screen, kill while in the foreground, revoke and regrant, offline queue, live upload.
