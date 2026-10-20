import XCTest
@testable import ClockedCore

/// Reproductions from the third review (REVIEW-3.md).
extension UsageEngineTests {
    /// Finding 1: after pruning and a clock rollback, a new account must not
    /// recreate an earlier account's registration name and inherit its callbacks.
    func testReview3PrunedRegistrationIdentityCannotTransferLateCallback() async throws {
        let transport = FakeTransport()
        let r = rig(transport, now: "2026-05-05 08:00")
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        let aMay5 = try XCTUnwrap(r.center.registration(for: day("2026-05-05")))
        r.clock.set(at("2026-05-04 23:30", zone))
        let b = try await engine.connect(origin: .hosted)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(b.startDay, day("2026-05-05"))
        r.clock.set(at("2026-06-16 08:00", zone))
        _ = try await engine.status() // ingest prunes owners and registry
        r.center.clear() // the May registrations have ended
        r.clock.set(at("2026-05-05 08:00", zone))
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        let bMay5 = try XCTUnwrap(r.center.registration(for: day("2026-05-05")))
        XCTAssertNotEqual(aMay5.activityName, bMay5.activityName, "a registration name is never reused")
        try r.records.append(hit(aMay5, minutes: 120, at("2026-05-05 10:00", zone), zone: zone))
        r.clock.set(at("2026-05-05 10:05", zone))
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertTrue(transport.requests.isEmpty, "A's late callback must not be uploaded by B")

        // B's own recreated registration still measures and uploads.
        try r.records.append(hit(bMay5, minutes: 15, at("2026-05-05 10:30", zone), zone: zone))
        r.clock.set(at("2026-05-05 10:35", zone))
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertEqual(transport.requests.flatMap { $0.body.snapshots }.map(\.durationSeconds), [900])
    }

    /// The identity component is fixed when a registration is created: later
    /// refreshes keep the same registration instead of minting new ones.
    func testReview3RefreshKeepsTheSameRegistrationIdentity() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        let names = Set(r.center.activeNames())
        for minutes in [1, 30, 240] {
            r.clock.set(at("2026-05-04 08:00", zone).addingTimeInterval(TimeInterval(minutes * 60)))
            let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
            XCTAssertEqual(result.started, 0)
            XCTAssertEqual(result.stopped, 0)
        }
        XCTAssertEqual(Set(r.center.activeNames()), names)
    }

    /// Finding 2: a retained selection still owns its day on the inclusive
    /// retention cutoff.
    func testReview3RetainedSelectionSurvivesInclusiveCutoff() async throws {
        let transport = FakeTransport()
        let r = try await retainedSelectionRig(transport)
        let engine = r.engine()
        r.clock.set(at("2026-06-08 08:00", zone)) // cutoff is May 4, still eligible
        _ = try await engine.sync(credential: try await credential(engine, tokenA))
        XCTAssertEqual(transport.requests.flatMap { $0.body.snapshots }.map(\.durationSeconds), [7200])
    }

    /// The day after the cutoff, the raw callbacks and the retained entry both
    /// expire together; nothing is uploaded and nothing breaks.
    func testReview3RetainedSelectionExpiresTheFollowingDay() async throws {
        let transport = FakeTransport()
        let r = try await retainedSelectionRig(transport)
        let engine = r.engine()
        r.clock.set(at("2026-06-09 08:00", zone)) // cutoff is May 5
        _ = try await engine.sync(credential: try await credential(engine, tokenA))
        XCTAssertTrue(transport.requests.isEmpty)
        let schedule = try await engine.schedule()
        XCTAssertFalse(schedule.entries.contains { $0.retainedThrough != nil }, "the retained entry is pruned with its day")
    }

    /// Chooses on May 3, measures 120 minutes on May 4 without syncing, then
    /// renews voided tokens on May 4 so the first selection is retained.
    private func retainedSelectionRig(_ transport: FakeTransport) async throws -> Rig {
        let r = rig(transport, now: "2026-05-03 08:00")
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        r.clock.set(at("2026-05-04 11:00", zone))
        try fire(r, minutes: 120, at: "2026-05-04 11:00")
        r.center.clear()
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .denied)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        try await pickAndMonitor(engine, r, payload: 8)
        let before = try await engine.status()
        XCTAssertEqual(before.todaySeconds, 7200)
        return r
    }
}
