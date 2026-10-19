# Managed working hours

Managers open Team > Working hours, select the team default or a person, and save
a schedule. Members see their assigned hours in Desktop. Each computer evaluates
the schedule in its local timezone. Selected weekdays are shift start days.

The manager API accepts `{ schedule: { mode: "scheduled", start: "09:00", end:
"17:00", days: [1,2,3,4,5] } }`, `{ schedule: { mode: "disabled" } }`, or
`{ schedule: null }`. Null removes an assignment. A member then inherits the team
default; without a team default the desktop uses its personal configuration.

## Ownership and flow

`worker/src/working-hours.ts` owns validation, manager authorization, storage and
effective-policy resolution. Cookie authentication and CSRF checks remain at the
Worker boundary. The device endpoint authenticates the existing per-device token
and requires an approved account. It accepts no target user or organization.

`org_working_hours` stores one team policy. `member_working_hours` references a
membership with cascading deletion, so rejoining does not revive an old override.
The earliest membership, ordered by creation time and ID, supplies the policy.
This follows existing report ownership rather than combining conflicting teams.

`src/sync.rs` pulls the policy before uploads. A successful response updates one
SQLite metadata value; failed uploads cannot prevent policy refresh. The cache
is bound to a SHA-256 hash of the endpoint and token. Network/server failures
retain it; an explicit null restores personal hours, and authorization denial
clears it. Older Workers returning 404 remain supported.

`DesktopState::within_working_hours` resolves the managed layer for all four
prompt decisions. The next decision or heartbeat sees the new cached policy.
Personal settings remain in config.toml, without any background writes from sync.
Working hours continue to control prompts, with no forced shift-end clock-out.

## Design comparison

Two independent candidates agreed on separate cloud policy, local SQLite cache,
and preserving personal config. The membership-scoped candidate is the base
because deletion follows membership lifecycle and cache scope prevents applying
another account's policy. The other candidate's warning about refreshing policy
even when no uploads are pending is included. Its union of all team schedules is
rejected because one team could silently widen another team's working window.
Overwriting config.toml is rejected because Settings and sync would both own it.

The independent cross-judge also selected the membership-scoped design. Its
review led to shared overnight-day evaluation for personal and managed hours,
the same membership tie-break in report delivery, and a test that a policy change
does not resume tracking after an explicit rejection. Cache clearing on auth
denial is retained: revoked credentials cannot continue supplying a team policy.
The desktop waits for a new open event rather than clocking in on that fallback.

The design accepts sync latency and device-local time. There is one daily window
per schedule; split shifts and an organization-fixed timezone are outside this
change. This is a prompt preference, not a tamper-resistant attendance policy.

## Verification

- `cargo test` covers overnight boundaries, cache scope, HTTP failures, assignment
  removal, and managed hours driving the shared desktop prompt.
- `cd worker; npm test` runs policy and permission tests using real SQLite and all
  migrations, including membership removal and multiple-team precedence.
- `node scripts/verify-working-hours.mjs` starts an isolated Worker/D1 instance,
  signs in fixture accounts, and checks real cookie and device-token routes.
  Add `--serve` to inspect its dashboard. It does not use production credentials.
