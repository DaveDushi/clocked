# Mobile implementation and verification contract

Each task has one T3 agent. Do not delegate further. Shared checkout, disjoint write scopes.

- iOS owner: mobile/ios/** and .github/workflows/mobile-ios.yml.
- Android owner: mobile/android/** and .github/workflows/mobile-android.yml.
- Backend owner: worker/** only. Parent owns this file and mobile/README.md.

Native UI follows worker/src/dashboard.ts: background #0a0b10, panel #151823, border #242938, text #e9eaf0, muted #8b91a0, amber #f2a950 / #ff8a3d. Use native SwiftUI and Kotlin/Compose.

Existing exact interval sync: POST /sessions, Authorization: Bearer clk_..., JSON {sessions:[{id,start_utc,end_utc,start_reason:"app",end_reason:"app",timezone}]}. UTC ISO8601 dates, IANA timezone. Response accepted IDs only are acknowledged locally. Stable IDs, durable offline state, bounded batches <=500, no secrets in URLs/logs/plain preferences. Per-account configuration must never upload old account data to a new account. HTTPS server configuration. Token obtained from existing dashboard Settings device tokens; do not invent auth endpoints. POST /api/auth/desktop/link may open a dashboard through a returned one-time URL.

Exact intervals must union on-device and in server reports, including desktop overlap. Never synthesize wall-clock intervals from cumulative screen time. App selection changes must not relabel historical usage. Permission loss, locked device, process death, offline retries, time changes, midnight/DST, multiwindow, and duplicate/out-of-order callbacks need explicit behavior and meaningful deterministic tests.

iOS: verify current Apple docs. DeviceActivityReport data must stay in the report sandbox. No App Group export hack. If sanctioned APIs only provide cumulative duration, use a separate duration snapshot endpoint POST /mobile/usage, bearer auth, request {snapshots:[{id,device_id,platform:"ios",day:"YYYY-MM-DD",timezone,selection_id,duration_seconds}]}. Backend stores an idempotent monotonic snapshot keyed by account/device/day/selection. Response {accepted:[ids]}. Keep aggregate durations separate from exact timesheet totals because overlap cannot be determined without timestamps. UI must be truthful about this limitation. Backend and iOS agents should independently honor this fixed contract. Backend may add stricter sensible validation without changing names. Read platform docs for supported data access and region limitations. Do not claim an unsupported export works.

Deliver complete build projects and headless CI, meaningful algorithm/protocol tests, reproducible verification commands, prerequisites for signing/entitlements, and clear limits. No emulator available. Do not claim builds/tests that were not run. Avoid placeholder tracking implementations or fake success UI.

Worldwide iOS clarification: Standard Screen Time authorization, picker, monitor thresholds and sandboxed reports are global. Implement a supported global path. Monitor threshold snapshots must be labeled lower-bound/quantized measurements and never presented as exact work sessions. EU data-access export is optional; it does not gate the whole app. Keep duration snapshots separate from billable time.

Privacy requirement from user: app names, bundle/package identifiers, application tokens, and per-app usage remain local. Upload only aggregate work time and opaque device/selection identifiers. Android sends unioned intervals without per-app attribution; iOS sends aggregate duration snapshots.
