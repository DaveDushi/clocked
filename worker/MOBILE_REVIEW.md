# Independent review: mobile sync backend (worker/**)

Reviewed 2026-10-19 against the uncommitted `worker/**` diff and the new untracked files. No source was edited. Baseline: `npm test` passes 57/57 in this worktree.

## Findings

### 1. CRITICAL: `/sessions` now rejects every session the shipped desktop app sends

- File: `worker/src/ingest.ts:144-145` (new strict regex in `isValid`)
- Client side: `src/db.rs:118-120` stores `DateTime<Utc>::to_rfc3339()`, and `src/db.rs:497-511` / `src/sync.rs:224-229` upload those strings unchanged.

`to_rfc3339()` on `DateTime<Utc>` writes a `+00:00` offset, never `Z`. With `Utc::now()` it also writes 3, 6 or 9 fractional digits; Windows clocks give 9. The new regex requires `Z` and allows at most 3 fractional digits, so every desktop session fails validation. When all sessions in a batch fail, the worker returns `400 no valid sessions`.

Reproduction:

1. Real chrono 0.4 output, from a throwaway crate built with `cargo run --offline` on this machine:
   ```
   Utc::now().to_rfc3339()                                  -> 2026-10-19T21:15:08.431918700+00:00
   Utc.with_ymd_and_hms(2026,10,19,12,0,0).to_rfc3339()     -> 2026-10-19T12:00:00+00:00
   ```
2. Those formats passed through the compiled `handleIngest` (`.tmp-test/ingest.js` from `npm test`) with a stub D1 that accepts all writes:
   ```
   toISOString Z (what tests use)      2026-10-19T19:15:22.683Z               -> 200 accepted
   chrono Utc::now() (Windows, 9 frac) 2026-10-19T19:15:22.431918700+00:00    -> 400 {"error":"no valid sessions"}
   chrono whole second                 2026-10-19T19:15:22+00:00              -> 400 {"error":"no valid sessions"}
   ```
   The script is in `%TEMP%\chronorepro\ingest-repro.mjs`.

Impact: `push_sessions` returns `Err` on a non-2xx status, and `sync::run` uses `?`. That means `push_activity` is skipped too, so desktop sync stops completely for every installed client, and every retry and every endpoint-change re-queue fails the same way. No session is lost (they stay `synced = 0`), but no desktop hours reach the server until the worker or client is fixed. Release 0.1.20 desktop clients are affected, and so is every earlier client that uses `fmt()`.

Why the tests missed it: every ingest fixture, including `test/ingest-timezone.test.mjs`, `test/mobile-*.test.mjs` and `scripts/verify-mobile-worker.mjs`, builds timestamps with `Date.prototype.toISOString()`. No test uses the Rust format. `MOBILE_SYNC.md` documents the narrower format as the `/sessions` contract, but the desktop client is the main producer of that contract.

Suggested fix (not applied): accept RFC 3339 with either `Z` or a numeric offset and any number of fractional digits, for example `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$`. Then truncate the fraction to milliseconds before `Date.parse`. Keep the canonical `toISOString()` storage. Drop or adapt the calendar-date echo check at `ingest.ts:152-153`, because with a non-zero offset the UTC date can differ from the literal date prefix. Add a regression test with `2026-10-19T19:15:22.431918700+00:00` and `...+02:00`.

### 2. MEDIUM: an iOS snapshot whose timezone differs from its stored bucket is never acknowledged, so the client retries forever

- File: `worker/src/mobile-usage.ts:106-114`

The bucket key is `(user_id, device_id, day, selection_id)` and does not include the timezone. If a stored row has a different timezone, the `ON CONFLICT ... WHERE mobile_usage.timezone = excluded.timezone` clause skips the update, `RETURNING` produces no row, and the ID is left out of `accepted`. A batch with only such entries returns `409`. `MOBILE_SYNC.md` documents this as intended. But nothing tells the client the entry is permanently rejected rather than temporarily failing, so a client that follows "acknowledge only returned IDs" keeps re-sending it. That covers any traveler, and any device whose timezone changes on a date that already has a snapshot. The measurement for that local day is also dropped silently. Check that the iOS client treats an unacknowledged 409 entry as final, or return rejected IDs separately. This is a contract-level gap, not a crash.

### 3. LOW: stored legacy timestamps are not canonical, and range queries compare them as strings

- Files: `worker/src/report.ts:215-216, 249-250, 382-383`

Rows ingested before this change keep the raw desktop string (`...+00:00`, up to 9 fractional digits). New writes store `toISOString()`. The SQL filters compare against `Z` bounds lexicographically. Because `+` sorts before `.`, a row ending within the same second as a bound can be misclassified. The 15-hour `periodQueryBounds` padding makes this harmless in practice. The problem predates this change, and the next upsert of a row canonicalizes it. Noted only because `MOBILE_SYNC.md` says canonical storage makes "SQL range comparisons consistent", which holds for new rows only.

## Checked with no defect found

- **Ownership and races.** The upsert's `ON CONFLICT ... WHERE sessions.user_id IS NULL OR sessions.user_id = excluded.user_id` stops cross-account takeover at write time. The legacy global token (`userId = NULL`) cannot claim owned rows. Acknowledgement comes only from `RETURNING` rows or tombstones scoped with `user_id IS ?`.
- **Tombstones.** `deleteSession` inserts the tombstone and deletes the row in one `batch`. The ingest insert is guarded by `NOT EXISTS session_deletions`. A retry acknowledges the tombstone without restoring the row, and foreign tombstones are not acknowledged.
- **Token revocation.** Ingest re-checks `api_token` by `token_hash` inside the write statement. `deleteUserClockedData` is now one transactional `batch`. The plaintext-token upgrade became an in-place `UPDATE`, so a concurrent wipe can no longer be undone by re-inserting the token.
- **Mobile isolation.** `/mobile/usage` requires a `clk_` account token, rejects legacy and cookie auth, and binds `user_id` from the token. `/api/hours` takes `screenTime` from the cookie user only. Export includes `mobile_usage` and wipe deletes it.
- **Max aggregation.** `MAX(stored, incoming)` is monotonic under retries and out-of-order delivery. `mobileUsageForPeriod` takes the max across selections per device-day and the max across devices per day. `largestDeviceSeconds` is the largest single-device month and is never a cross-device sum, which matches the dashboard text.
- **Billing and timesheets.** `mobile_usage` is never read by the hours, CSV, timeline or email code paths. Billing totals are unaffected.
- **Union before date attribution.** `accountingIntervals` assigns each instant to the earliest-starting covering row before splitting at local midnight. Any row covering an instant inside a month's padded window overlaps that window and is fetched, so adjacent-month reports attribute shared instants the same way. Travel timezones are kept for non-overlapping tails.
- **DST.** `wallToUtc` now resolves the offset at the resulting instant and falls back to the old behavior inside a gap. The `duration_seconds` cap uses the real local day length.
- **Privacy.** Snapshot entries reject unknown fields, and `selection_id` must be a UUID or hex hash, so package names fail. Only opaque device and selection IDs are stored.
- **Migration.** `0018_mobile_usage.sql` only creates a table and an index. It must be applied before deploy because `/api/hours` and export query `mobile_usage` unconditionally and will 500 without it. `MOBILE_SYNC.md` states this.

## Limits of this review

- The production workerd/D1 runtime check (`npm run test:runtime`) and the sqlite race tests were not re-run. Only `npm test` and the targeted repro were.
- Concurrency claims come from reading the SQL and from D1's documented batch transaction semantics. I did not run my own multi-isolate stress test.
- Mobile clients were out of scope. Finding 2's real impact depends on how the iOS client handles unacknowledged entries.
- No deployment or remote migration was attempted.
