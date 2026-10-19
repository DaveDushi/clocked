import XCTest
@testable import ClockedCore

/// Reproductions from the second independent review (REVIEW-2.md), kept as
/// regression tests against the real engine and planner.
extension UsageEngineTests {
    /// Finding 1: a date rollback before an account switch must not hand
    /// measured-but-unqueued usage of account A to account B, whether the
    /// callback is still on disk or already in the ledger.
    func testReview2RollbackCannotTransferUnqueuedAccountData() async throws {
        for ingestBeforeRollback in [false, true] {
            let transport = FakeTransport()
            let r = rig(transport, now: "2026-05-05 08:00")
            let engine = r.engine()
            _ = try await engine.connect(origin: .hosted)
            try await pickAndMonitor(engine, r)
            try fire(r, minutes: 30, at: "2026-05-05 09:00")
            r.clock.set(at("2026-05-05 09:10", zone))
            if ingestBeforeRollback { _ = try await engine.status() }
            r.clock.set(at("2026-05-04 23:30", zone))
            try await engine.disconnect()
            let b = try await engine.connect(origin: .hosted)
            XCTAssertGreaterThan(b.startDay, day("2026-05-05"), "ingested=\(ingestBeforeRollback)")
            _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
            XCTAssertTrue(transport.requests.isEmpty, "B received A's measured day (ingested=\(ingestBeforeRollback))")
        }
    }

    /// The same rollback without an explicit disconnect: connecting B replaces A.
    func testReview2RollbackDirectReplacementCannotTransferUnqueuedData() async throws {
        let transport = FakeTransport()
        let r = rig(transport, now: "2026-05-05 08:00")
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-05 09:00")
        r.clock.set(at("2026-05-04 23:30", zone))
        let b = try await engine.connect(origin: .hosted)
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    /// Finding 2: renewing voided tokens on the same day must keep the usage
    /// already measured under the old selection.
    func testReview2SameDayReauthorizationPreservesUnsyncedMeasurement() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        let original = try XCTUnwrap(r.center.registration(for: day("2026-05-04"))?.selectionID)
        try fire(r, minutes: 120, at: "2026-05-04 11:00")
        r.clock.set(at("2026-05-04 11:10", zone))
        let before = try await engine.status()
        XCTAssertEqual(before.todaySeconds, 7200)
        r.center.clear()
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .denied)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        try await pickAndMonitor(engine, r, payload: 8)
        let after = try await engine.status()
        XCTAssertFalse(after.needsReselection)
        XCTAssertTrue(r.center.registrations.allSatisfy { $0.payload == Data([8]) }, "only fresh tokens are registered")
        XCTAssertGreaterThanOrEqual(after.todaySeconds, before.todaySeconds, "already measured usage must survive reselection")
        _ = try await engine.sync(credential: try await credential(engine, tokenA))
        let sent = transport.requests.first?.body.snapshots ?? []
        XCTAssertEqual(sent.map(\.durationSeconds), [7200])
        XCTAssertEqual(sent.first?.selectionID, MeasurementSeries.id(selectionID: original, timeZone: zone),
                       "the measurement keeps the selection it was measured under")
    }

    /// A further choice on the same day must not drop the retained measurement.
    func testReview2SecondChoiceAfterRenewalKeepsMeasuredUsage() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 120, at: "2026-05-04 11:00")
        r.clock.set(at("2026-05-04 11:10", zone))
        r.center.clear()
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .denied)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        try await pickAndMonitor(engine, r, payload: 8)
        try await pickAndMonitor(engine, r, payload: 9)
        let status = try await engine.status()
        XCTAssertEqual(status.todaySeconds, 7200)
        XCTAssertTrue(r.center.registrations.allSatisfy { $0.payload == Data([9]) })
        XCTAssertEqual(r.center.overlaps, 0)
    }

    /// Finding 3: registrations that all expired while the app was suspended
    /// cannot show whether access was revoked meanwhile, so the old tokens are
    /// not reused.
    func testReview2SuspendedRevocationAfterHorizonRequiresFreshTokens() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        r.center.clear()
        r.clock.set(at("2026-05-12 08:00", zone))
        let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        let status = try await engine.status()
        XCTAssertTrue(result.revocationDetected)
        XCTAssertEqual(result.started, 0, "tokens possibly voided during suspension must not be registered")
        XCTAssertTrue(status.needsReselection)
    }

    /// Opening the app within the horizon keeps the old tokens in use.
    func testReview2RefreshWithinHorizonKeepsTokens() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        r.clock.set(at("2026-05-09 08:00", zone))
        let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertFalse(result.revocationDetected)
        XCTAssertEqual(result.started, 5, "the horizon extends through 2026-05-15")
    }
}

extension MonitorPlanTests {
    /// Finding 4: an existing interval for today is kept even when too little
    /// of the day remains to start a new one.
    func testReview2LateRefreshKeepsAnExistingValidInterval() {
        let name = reg("a", "2026-05-04", startingAt: "2026-05-04 08:00", zone: "Europe/Berlin").activityName
        let p = plan(active: [name], registry: registry([name]), schedule: schedule("a", from: "2026-05-01"),
                     now: at("2026-05-04 23:45", "Europe/Berlin"))
        XCTAssertFalse(p.stop.contains(name), "minimum new interval length must not stop an ongoing day")
        XCTAssertFalse(p.start.contains { $0.registration.day == day("2026-05-04") })
    }
}
