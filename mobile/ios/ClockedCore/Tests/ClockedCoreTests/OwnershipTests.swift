import XCTest
@testable import ClockedCore

/// Callbacks belong to the account their registration was made for, decided
/// by the activity name, never by delivery time or the device clock.
extension UsageEngineTests {
    /// Account A registers May 5 and its usage callback arrives late. Before
    /// it arrives, the clock is set back to May 4, A is replaced by B, and B
    /// registers its own days. When the clock reaches May 5 again, A's callback
    /// arrives. B must upload only what its own May 5 registration measured.
    func testLateCallbackOfAReplacedAccountsRegistrationNeverReachesTheNewAccount() async throws {
        let transport = FakeTransport()
        let r = rig(transport, now: "2026-05-05 08:00")
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        let aMay5 = try XCTUnwrap(r.center.registration(for: day("2026-05-05")))

        r.clock.set(at("2026-05-04 23:30", zone)) // clock set back before the switch
        let b = try await engine.connect(origin: .hosted)
        XCTAssertEqual(b.startDay, day("2026-05-05"), "nothing measured yet, so only today is reserved")
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        let bMay5 = try XCTUnwrap(r.center.registration(for: day("2026-05-05")))
        XCTAssertNotEqual(bMay5.activityName, aMay5.activityName, "B gets registrations of its own")
        XCTAssertEqual(r.center.overlaps, 0)

        // A's callback is delivered after the switch, once the clock is past May 5 09:00.
        try r.records.append(hit(aMay5, minutes: 120, at("2026-05-05 10:00", zone), zone: zone))
        r.clock.set(at("2026-05-05 10:05", zone))
        let credB = SyncCredential(accountID: b.accountID, token: tokenB)
        _ = try await engine.sync(credential: credB)
        XCTAssertTrue(transport.requests.isEmpty, "B must not upload anything measured by A's registration")

        // B's own registration measures May 5 and uploads.
        try r.records.append(hit(bMay5, minutes: 15, at("2026-05-05 10:30", zone), zone: zone))
        r.clock.set(at("2026-05-05 10:35", zone))
        _ = try await engine.sync(credential: credB)
        guard transport.requests.count == 1 else {
            return XCTFail("expected one upload from B's own registration, got \(transport.requests.count)")
        }
        let sent = transport.requests[0].body.snapshots
        XCTAssertEqual(sent.map(\.day), ["2026-05-05"])
        XCTAssertEqual(sent.map(\.durationSeconds), [900], "only B's registration, not A's 7200")
        XCTAssertEqual(transport.requests[0].bearer, tokenB)
    }

    /// The same with an explicit disconnect and a relaunch between the switch
    /// and the late delivery.
    func testOwnershipSurvivesDisconnectAndRelaunch() async throws {
        let transport = FakeTransport()
        let r = rig(transport, now: "2026-05-05 08:00")
        var engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        let aMay6 = try XCTUnwrap(r.center.registration(for: day("2026-05-06")))
        r.clock.set(at("2026-05-04 12:00", zone))
        try await engine.disconnect()
        let b = try await engine.connect(origin: .hosted)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        engine = r.engine()
        try r.records.append(hit(aMay6, minutes: 60, at("2026-05-06 09:00", zone), zone: zone))
        r.clock.set(at("2026-05-06 09:30", zone))
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    /// Registrations made before any account connected are adopted by the
    /// first account, so its first day keeps usage measured before connecting.
    func testFirstAccountAdoptsRegistrationsMadeBeforeConnecting() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        let a = try await engine.connect(origin: .hosted)
        XCTAssertEqual(a.startDay, day("2026-05-04"))
        let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(result.started, 0, "adopted registrations are kept, not replaced")
        _ = try await engine.sync(credential: SyncCredential(accountID: a.accountID, token: tokenA))
        XCTAssertEqual(transport.requests.first?.body.snapshots.map(\.durationSeconds), [1800])
    }
}
