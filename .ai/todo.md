# clocked — plan & progress

## Activity + privacy (2026-07-15) — DONE in tree

- [x] Privacy defaults: titles off; opt-in sanitized titles; private-app list; retention (90d)
- [x] Segment-based activity tracker (focus changes + 5s poll + checkpoint)
- [x] Rules: ignore → Non-work; optional title_rules; Settings honesty
- [x] Token UI: never re-display full token; blank save keeps DPAPI/Keychain secret
- [x] Windows drives `engine` for idle/after-hours (no policy drift)
- [x] Daily `activity_day` sync → Worker `POST /activity` + dashboard/email project summary
- [x] macOS foreground via NSWorkspace (app only); activity ticks on heartbeat
- [x] Marketing tip no longer claims "never records apps"
- [x] Privacy-safe **context** (browser domain / document name) from title bar heuristics
- [x] Segments keyed by (app, project, context); tray "sites & docs"; match rules in Settings

## Remaining / device verification

- [ ] On a Mac: build, run, confirm NSWorkspace foreground + Keychain + bridge
- [x] Apply migration `0012_activity.sql` on remote D1 and deploy Worker (2026-07-16)
- [ ] packaging/macos/clocked.icns + notarize secrets
- [ ] Stripe live price IDs (still TEST in wrangler vars)
- [ ] Optional: richer browser domain capture via extension (strict opt-in)
- [ ] macOS call detection (media.rs still fail-closed)

## Fixed in tree (2026-07-16)

- [x] After-hours prompt auto-dismisses when working hours begin
- [x] Extension stores token in storage.local (not sync)
- [x] past_due 14-day grace for paid access
- [x] Session id validation on ingest; manual-session rate limit
- [x] GET /api/export + POST /api/account/delete
- [x] macOS starts localhost bridge; tray unassigned-app suggestions
- [x] Dashboard Privacy: export / delete cloud data

## Testing

- `cargo test` / `cargo build` on Windows
- Worker: `npm test` after building `.tmp-test` as usual
