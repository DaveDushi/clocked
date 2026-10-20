# Third-review resolution

R3-M1 is resolved. The original report remains unchanged.

The failed premise was that sampling a new boot and consuming its lifecycle boundary happen in the same transaction. The collector intentionally delays its event window by 60 seconds. A first collection at boot elapsed 45 seconds therefore saves the new boot count while its event cursor is still 15 seconds before boot. The old implementation discarded the only boot cut at that point.

## State and persistence

`TrackingState.bootCuts` now owns each unconsumed boot estimate, boot count and original pre-boot checkpoint. `CollectionPolicy` records this before sampling the new boot, even if the delayed window cannot consume it. Later same-boot samples leave that checkpoint unchanged. A second reboot appends its own boundary without replacing the first. A null or unstable query still changes neither boot sample nor checkpoint.

`Timeline` consumes each boundary once, when the exclusive query end passes it. It seals an old open span at that boundary's saved checkpoint, clears the old boot's gates and activity, then processes fresh lifecycle evidence. A cut exactly at the query end remains pending. A retained clean SHUTDOWN still closes the actual evidenced span. STARTUP retains the new boot's earlier screen and unlock evidence. Reached cuts disappear in the same state transition that emits their intervals.

Pending cut times and proof checkpoints belong to the unemitted OS event frame. `EventFrames` moves both during a proved history rewrite. Completed session IDs, payloads and acknowledgment flags remain immutable. Conservative fallback sealing also respects a pending cut's original proof checkpoint. The transport and account boundary code are unchanged.

The existing authenticated JSON envelope was extracted to `VaultFormat`, used directly by `Vault.read` and `Vault.write`. It serializes all pending boundaries inside the same AES-GCM ciphertext as the cursor, boot sample and queue. Android still supplies the non-exportable Keystore key and writes the result with `AtomicFile`. A vault without the new optional field decodes with no pending cuts. An earlier version that already lost a boundary cannot reconstruct it retrospectively.

## Executable proof

Before changing production code, `FastBootTest` ran the appendix's literal 45- and 120-second cases. Two tests ran; the 45-second assertion failed and the 120-second assertion passed. The repaired code returns exactly `[3600,7140)` and `[9700,10000)` in both cases, totaling 3,840 seconds. The old 45-second result `[3600,9585)` totaled 5,985 seconds and lost the first new-boot visit.

The additional fixtures call the production collector and write/read actual encrypted bytes through a temporary file between collections. They create a new decoded object, compare persisted state and queue, and continue collection with it. This proves serialization recovery without relying on an in-memory shared object. It does not simulate Android Keystore or crash-test `AtomicFile`.

- The 24-case matrix uses first elapsed times 0, 30, 45, 59, 60 and 120 seconds, each with missing SHUTDOWN, SHUTDOWN at 5400 before cursor, SHUTDOWN exactly at cursor 7140, or clean SHUTDOWN at 9000. Unclean cases assert the literal appendix intervals. Clean cases assert `[3600,9000)` and `[9700,10000)`.
- Successive early collections at all five times through 60 seconds keep the original 7140-second proof checkpoint. The later collection consumes the cut once.
- Two rapid reboots before the first pending cut is reached survive separate encrypted reloads and preserve the first boundary's original checkpoint. Final rows are the literal appendix intervals.
- An unavailable first post-boot query retains the old boot sample for retry.
- Proved AOSP history shifts of both -90 and +90 seconds move pending boundaries and proof checkpoints with the events. Literal resulting intervals preserve duration, while a pre-existing completed retry row remains unchanged.
- A further collection after encrypted reload must leave the exact session list and IDs unchanged. Assertions inspect stored rows directly, without unioning away duplicates.

Run all new fixtures with `gradlew testDebugUnitTest --tests app.clocked.mobile.FastBootTest`. Final validation passed all 67 tests, lint with zero errors and four dependency-update warnings, and APK assembly. The forced full run executed all 51 tasks in 54 seconds. The APK has a valid v2 signature and SHA-256 `23cf0418be1d55bebd67b85216ac7ad4329e4612eb59bb9bc1ef122f6e30bc01`. Commands and artifact locations are recorded in `VERIFICATION.md`.

## Scope and limits

No protocol, UI, worker, iOS or workflow changes were needed. App identities remain local; only aggregate intervals enter the existing session payload. The parent's `packages: platform-tools` workflow input is unchanged. No commit or delegation was performed.

The AOSP behavior and evidence limits described in `REVIEW-2-RESOLUTION.md` and `REVIEW-3.md` still apply. This fix retains a known boundary across delayed collection; it does not invent missing lifecycle events or prove cross-boot clock frames. No phone, emulator, actual BOOT_COMPLETED latency, Keystore process-death behavior or live server upload was tested. OEM event loss, ambiguous fingerprints, threshold-edge jitter, cross-boot clock correction, concurrent same-class activities and unobserved permission changes remain documented platform limits.
