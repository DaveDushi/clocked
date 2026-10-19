# Mobile sync backend reference

The payload names in `mobile/CONTRACT.md` are unchanged. All backend changes are in `worker/**`.

## Exact Android intervals

`POST /sessions` accepts the existing `{sessions:[{id,start_utc,end_utc,start_reason,end_reason,timezone}]}` contract with an account device bearer token. Android uses `app` reasons. The account, product-access, and rate guards remain the existing `/sessions` guards.

IDs must match `[A-Za-z0-9][A-Za-z0-9._:-]{7,127}`. The batch limit is 500. Timestamps accept RFC3339 with seconds and a `Z` or numeric `+HH:MM` or `-HH:MM` offset. This includes the desktop's `+00:00` suffix and nanosecond fractions from `DateTime<Utc>::to_rfc3339()`. Lowercase `t` and `z` are accepted. Fractional seconds are optional and may exceed three digits within the 128-character timestamp limit. New and re-uploaded rows truncate submillisecond precision and store canonical millisecond UTC timestamps. Rows from older Worker versions retain their original timestamp strings until re-uploaded. Report queries pad their month bounds by 15 hours, so both legacy and canonical strings remain included for subsequent timezone-aware filtering. No historical rewrite migration is performed.

Calendar validity is checked in the written local offset before UTC conversion, so valid date or month crossings remain valid. Invalid calendar dates, hours above 23, minutes or seconds above 59, and numeric offsets outside hours 00 to 23 or minutes 00 to 59 are rejected. Leap seconds are unsupported by the millisecond storage representation. Nonpositive intervals, durations over 40 days, ends more than 24 hours ahead, and ends older than three years are rejected. Missing or unknown timezone strings retain the existing fallback behavior. Non-string timezones are invalid.

Every accepted ID comes from the write's `RETURNING` rows or an account-owned deletion tombstone. Ownership is enforced in the SQL upsert, including simultaneous claims. Deletion and its tombstone share a transaction. A later retry acknowledges the tombstone without restoring the session. Foreign-account tombstones are never acknowledged. Missing tombstone migrations cause an error instead of silently bypassing deletion protection.

Reports assign each UTC instant once before splitting at local midnight. The earlier-starting interval supplies the timezone. Equal starts prefer the longer interval, then the timezone name in lexical order. Uncovered tails use their own session timezone. This rule prevents simultaneous devices from attributing one instant to different dates or adjacent months. Recorded travel timezones remain in use where intervals do not overlap. Timeline segments use the same accounting dates while preserving original session IDs for deletion.

Dashboard hours, daily totals, monthly totals, CSV, and email timesheets use this interval union. Minutes are rounded after each daily union. The timezone conversion resolves the offset at local midnight, including Auckland DST transitions.

## Cumulative iOS usage

`POST /mobile/usage` requires `Authorization: Bearer clk_...`. It supports account tokens only. The legacy global token and cookies cannot authenticate this route. Product access uses the same account access function as `/sessions`. Durable limits are 60 requests per IP per minute and 120 per account per minute.

```json
{
  "snapshots": [{
    "id": "snapshot-ack-id",
    "device_id": "device-opaque-id",
    "platform": "ios",
    "day": "2026-06-01",
    "timezone": "Europe/Berlin",
    "selection_id": "0f3a9c2e-1111-4222-8333-944455556666-z31405cd4",
    "duration_seconds": 900
  }]
}
```

The response is `{ "accepted": ["snapshot-ack-id"] }`. Clients acknowledge only returned IDs. Snapshot IDs are acknowledgement labels. The storage identity is `(account, device_id, day, selection_id)`.

Validation rules are:

- The body is at most 512 KiB and contains only `snapshots`. A batch has at most 500 entries. An empty batch returns `200` with an empty accepted array.
- Each entry contains only the seven fields shown above. App names, package names, application tokens, domains, and other per-app fields are rejected.
- `id` and `device_id` are 1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`.
- `selection_id` is an opaque UUID or a 32 to 128 digit hexadecimal hash, optionally followed by `-z` and exactly eight hexadecimal digits. The entire value must be at most 128 characters, including the suffix. Bare legacy UUIDs and hashes remain valid. A package name such as `com.example.work`, with or without a zone suffix, is invalid. The backend cannot establish randomness or consent from a string. Clients must create a fresh opaque selection identity when the selection changes.
- `platform` is exactly `ios`. `timezone` must be an IANA timezone name accepted by `Intl.DateTimeFormat`, at most 100 characters. Numeric UTC offsets such as `+01:00` are rejected.
- `day` is a real `YYYY-MM-DD` date between 2000 and 2100, no later than today in the supplied timezone, and no more than `3 * 366` days old.
- `duration_seconds` is a nonnegative safe integer, at most the local day's elapsed duration and at most 90,000 seconds. A 23-hour DST day therefore caps at 82,800 seconds. Zero is valid.

Malformed JSON or a missing array returns `400`. Oversized bodies or batches return `413`. Invalid entries in a mixed batch are omitted from `accepted`. A nonempty batch with no valid entries returns `400`. Conflicts with a bucket's stored timezone return no acknowledgement for that entry, or `409` if no entry is acknowledged. The bucket's timezone never changes after creation.

The SQL upsert uses `MAX(stored, incoming)` inside a D1 batch transaction. Retries, duplicate IDs, smaller delayed snapshots, and concurrent updates cannot increase a bucket twice or reduce it. Updates advance `updated_at` only when the duration grows. An already authenticated request checks its token again inside its write transaction. Cloud-data deletion and token revocation share one transaction, preventing an in-flight upload from restoring wiped data.

The current iOS app creates lowercase UUID selection bases through `UsageEngine`'s default `makeSelectionID`, which calls `UUID().uuidString.lowercased()`. `AppModel` uses that default. `MeasurementSeries.id` appends the timezone's FNV-1a 32-bit tag, for example `0f3a9c2e-1111-4222-8333-944455556666-z31405cd4` for Berlin. The wire value stays opaque and contains no app identity. The client pins each series bucket's timezone. The server accepts the optional tag as an opaque identifier component and does not derive or verify the timezone from its hash. Required payload fields and the acknowledgement response are unchanged.

## Dashboard measurements

Authenticated `GET /api/hours?period=YYYY-MM` returns a separate `screenTime` object scoped to the cookie account. Query parameters cannot override its account. The response has `Cache-Control: no-store`.

- `devices` contains one measurement for each device and local day: the maximum across that device's selection and timezone-series snapshots, never their sum.
- `days` contains the largest device measurement for each recorded local day, never a sum across devices.
- `deviceTotals` sums each device's daily measurements within the requested month.
- `largestDeviceSeconds` is the largest single-device monthly measurement, never a combined device total.

The Screen Time panel displays device-day measurements and the largest single-device month measurement. It describes them as cumulative measurements that may be threshold lower bounds. They have no session timestamps. Different selections can cover the same usage, and different devices or local dates can overlap. These measurement summaries are not exact elapsed work totals or billable time. They never enter `sessions`, timeline arcs, CSV hours, or email timesheet hours. Raw aggregate snapshots appear in the account's JSON data export and are removed by cloud-data deletion.

Taking the maximum across timezone series is intentional. A travel day with disjoint series of 1,200 and 1,000 seconds shows 1,200 seconds, not 2,200. This conservative lower bound can be smaller than the app's local sum. The backend does not infer disjointness or add uncertain durations to exact totals.

## Verification and deployment prerequisites

Node.js 24 or later is required for the SQLite test adapter. From `worker`, `npm ci` installs locked dependencies and `npm run verify` runs typecheck, all 62 tests, the production build, and the production-bundle workerd/D1 verification. The command needs no signing credentials, account secrets, mobile emulator, or remote D1 database. It is the headless CI entry point. Workflow files are outside this task's write scope.

`test/fixtures/ios-zone-series.json` contains the iOS wire series ID above. Both SQLite tests and the production workerd verification ingest this same fixture, assert acknowledgement and persisted identity, and verify monotonic retries plus the maximum across timezone series. Validation tests cover bare legacy IDs, suffixed UUID and hex IDs, the 128-character limit, malformed suffixes, and rejected package identifiers.

`test/sqlite-env.mjs` applies every production migration to an in-memory SQLite database and executes the production ingest/report SQL. The new tests cover Rust RFC3339 timestamps with nanosecond precision, positive and negative offsets across UTC dates and months, invalid local calendar dates and offsets, overlap, retries, atomic deletion in either order, ownership races, differing device timezones across a month boundary, Berlin and Auckland DST, snapshot validation, account isolation, token revocation after authentication, and both durable rate limits.

`npm run test:runtime` exercises the built Worker in workerd with real local D1 bindings. It applies every migration and generates temporary test credentials. It verifies authenticated ingest, concurrent monotonic updates, account-isolated `/api/hours`, the 240-minute desktop/Android union using Rust-format nanosecond timestamps with canonical millisecond storage assertions, separate 1,200-second Screen Time measurement, CSV, data export, deletion, retry acknowledgement, and cloud wipe with token revocation. No external auth or email service is called.

Migration `0018_mobile_usage.sql`, plus all preceding migrations, is required before serving this version. Deployment and remote migration were not performed. The existing locked dependency set reports eight high-severity npm audit findings; dependency remediation is outside this change.

## Official sources checked on 2026-10-19

- [RFC 3339 sections 5.6 and 5.7](https://www.rfc-editor.org/rfc/rfc3339#section-5.6): numeric offsets, fractional seconds, and Gregorian calendar restrictions define the accepted timestamp syntax.
- [Apple DeviceActivityReport](https://developer.apple.com/documentation/deviceactivity/deviceactivityreport): the report sandbox prevents network requests and movement of sensitive content outside the extension's address space. This backend provides no report-export workaround.
- [Apple DeviceActivityMonitor](https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor) and [event thresholds](https://developer.apple.com/documentation/deviceactivity/deviceactivityevent/threshold): threshold callbacks indicate that monitored activity reached a threshold. Treating callback milestones as lower-bound measurements is the application's conservative accounting policy, not a claim that callbacks provide exact sessions or exact cumulative totals.
- [Android UsageEvents.Event](https://developer.android.com/reference/android/app/usage/UsageEvents.Event): resumed and paused events describe activity lifecycle transitions, and shutdown ends started activity. The native tracker supplies exact intervals; the server does not reconstruct intervals from aggregate durations.
- [Cloudflare D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): D1 batches execute statements sequentially and roll back on failure. Prepared statements bind client values. Latest published Workers type definitions, `5.20261019.1`, were inspected for the D1 binding signatures while the project's locked compiler dependency remains unchanged.
