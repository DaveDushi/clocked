import XCTest
@testable import ClockedCore

final class UsageEngineTests: XCTestCase {
    let zone = "Europe/Berlin"
    let tokenA = "clk_" + String(repeating: "a", count: 32)
    let tokenB = "clk_" + String(repeating: "b", count: 32)

    final class Rig: @unchecked Sendable {
        let dir = tempDirectory()
        let records: MonitorRecordStore
        let clock: MutableClock
        let zone = MutableZone("Europe/Berlin")
        let ids = Counter()
        let transport: UsageTransport
        let center = FakeCenter()

        init(transport: UsageTransport, now: Date) {
            records = MonitorRecordStore(directory: dir.appendingPathComponent("records"))
            clock = MutableClock(now)
            self.transport = transport
        }

        /// A new engine over the same files: a relaunch of the app.
        func engine() -> UsageEngine {
            let clock = self.clock, ids = self.ids, zone = self.zone
            return UsageEngine(
                stateDirectory: dir.appendingPathComponent("state"), records: records, transport: transport,
                clock: { clock.now }, zone: { zone.zone }, makeID: { ids.next() }, jitter: { 1 }
            )
        }
    }

    func rig(_ transport: UsageTransport = FakeTransport(), now: String = "2026-05-04 08:00") -> Rig {
        Rig(transport: transport, now: at(now, zone))
    }

    /// Picks work apps and registers monitoring the way the app does.
    @discardableResult
    func pickAndMonitor(_ engine: UsageEngine, _ r: Rig, payload: UInt8 = 7) async throws -> SelectionSchedule.Placement {
        let placement = try await engine.chooseSelection(payload: Data([payload]), isEmpty: false)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        return placement
    }

    /// Simulates a Screen Time callback for the live registration of `d`.
    func fire(_ r: Rig, minutes: Int, at wall: String, for d: String? = nil, zone: String? = nil) throws {
        let z = zone ?? self.zone
        let target = try XCTUnwrap(r.center.registration(for: day(d ?? String(wall.prefix(10)))))
        try r.records.append(hit(target, minutes: minutes, at(wall, z), zone: z))
    }

    func credential(_ engine: UsageEngine, _ token: String) async throws -> SyncCredential {
        let status = try await engine.status()
        let id = try XCTUnwrap(status.account?.accountID)
        return SyncCredential(accountID: id, token: token)
    }

    // MARK: Upload basics

    func testEndToEndUploadsOnlyAggregateDuration() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: ServerOrigin("https://clocked.example.com")!)
        try await pickAndMonitor(engine, r)
        XCTAssertEqual(r.center.registrations.count, MonitorPlan.horizonDays)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:05", zone))

        let result = try await engine.sync(credential: try await credential(engine, tokenA))
        XCTAssertEqual(result, .finished(uploaded: 1, remaining: 0, problem: nil))
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.url.absoluteString, "https://clocked.example.com/mobile/usage")
        XCTAssertEqual(req.bearer, tokenA)
        let s = try XCTUnwrap(req.body.snapshots.first)
        XCTAssertEqual(req.body.snapshots.count, 1)
        XCTAssertEqual(s.day, "2026-05-04")
        XCTAssertEqual(s.timezone, zone)
        XCTAssertEqual(s.durationSeconds, 1800)
        let afterSync = try await engine.status()
        let selection = try XCTUnwrap(afterSync.currentSelectionID)
        XCTAssertTrue(MeasurementSeries.isUUID(selection))
        XCTAssertEqual(s.selectionID, MeasurementSeries.id(selectionID: selection, timeZone: zone))
        XCTAssertFalse(String(decoding: req.raw, as: UTF8.self).contains(tokenA))
        try ServerRules.assertAccepted(req.raw)
        XCTAssertTrue(r.records.readAll().files.isEmpty, "records are drained after ingest")

        _ = try await engine.sync(credential: try await credential(engine, tokenA))
        XCTAssertEqual(transport.requests.count, 1, "nothing new, no request")
        let status = try await engine.status()
        XCTAssertEqual(status.todaySeconds, 1800)
        XCTAssertEqual(status.account?.pendingCount, 0)
        XCTAssertEqual(status.monitoredThrough, day("2026-05-10"))
    }

    func testOfflineKeepsSnapshotAndRetriesSameIDAfterRelaunch() async throws {
        let transport = FakeTransport([.offline])
        let r = rig(transport)
        var engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 08:40", zone))
        let cred = try await credential(engine, tokenA)

        let first = try await engine.sync(credential: cred)
        XCTAssertEqual(first, .finished(uploaded: 0, remaining: 1, problem: .offline))
        let waiting = try await engine.sync(credential: cred)
        guard case .waiting = waiting else { return XCTFail("expected waiting, got \(waiting)") }

        engine = r.engine()
        r.clock.set(at("2026-05-04 09:00", zone))
        _ = try await engine.sync(credential: cred)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests[0].body.snapshots.map(\.id), transport.requests[1].body.snapshots.map(\.id))
    }

    /// Review finding 3: weeks offline must not drop the snapshot.
    func testSnapshotSurvivesLongOfflinePeriods() async throws {
        let transport = FakeTransport([.offline])
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 08:40", zone))
        let cred = try await credential(engine, tokenA)
        _ = try await engine.sync(credential: cred)

        r.clock.set(at("2026-06-20 09:00", zone)) // 47 days later, past raw retention
        let result = try await engine.sync(credential: cred)
        XCTAssertEqual(result, .finished(uploaded: 1, remaining: 0, problem: nil))
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.requests[1].body.snapshots.map(\.day), ["2026-05-04"])
        XCTAssertEqual(transport.requests[0].body.snapshots.map(\.id), transport.requests[1].body.snapshots.map(\.id))
    }

    func testUnauthorizedBlocksUntilForced() async throws {
        let r = rig(FakeTransport([.status(401, #"{"error":"unauthorized"}"#)]))
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 08:40", zone))
        let cred = try await credential(engine, tokenA)
        let blocked = try await engine.sync(credential: cred)
        XCTAssertEqual(blocked, .finished(uploaded: 0, remaining: 1, problem: .unauthorized))
        let status = try await engine.status()
        XCTAssertEqual(status.account?.lastProblem, .unauthorized)
        let forced = try await engine.sync(credential: cred, force: true)
        XCTAssertEqual(forced, .finished(uploaded: 1, remaining: 0, problem: nil))
    }

    func testPartialAcceptanceAndBatchShrink() async throws {
        let transport = FakeTransport([.status(413, "{}"), .acceptFirst(1), .acceptAll])
        let r = rig(transport, now: "2026-05-01 07:00")
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        for d in ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"] {
            try fire(r, minutes: 15, at: "\(d) 08:30")
        }
        r.clock.set(at("2026-05-04 12:00", zone))
        let result = try await engine.sync(credential: try await credential(engine, tokenA))
        XCTAssertEqual(result, .finished(uploaded: 4, remaining: 0, problem: nil))
        XCTAssertEqual(transport.requests.map { $0.body.snapshots.count }, [4, 2, 2, 1])
    }

    func testCancelledUploadKeepsSnapshotWithoutCountingAFailure() async throws {
        let transport = HangingTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 08:40", zone))
        let cred = try await credential(engine, tokenA)
        let task = Task { try await engine.sync(credential: cred) }
        while transport.started == 0 { await Task.yield() }
        task.cancel()
        let result = try await task.value
        XCTAssertEqual(result, .cancelled)
        let account = try await engine.status().account
        XCTAssertEqual(account?.pendingCount, 1)
        XCTAssertNil(account?.lastProblem)
        XCTAssertNil(account?.retryAfter)
    }

    // MARK: Account boundaries (review finding 1)

    func testReplacementAccountNeverReceivesAnOfflineDayOfThePreviousAccount() async throws {
        let transport = FakeTransport([.offline])
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        _ = try await engine.sync(credential: try await credential(engine, tokenA)) // offline

        try await engine.disconnect()
        let b = try await engine.connect(origin: .hosted)
        XCTAssertEqual(b.startDay, day("2026-05-05"))
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertEqual(transport.requests.count, 1, "only A's failed attempt")
        XCTAssertEqual(transport.requests[0].bearer, tokenA)
    }

    func testReplacementAccountNeverReceivesADayThatWasOnlyMeasured() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        // Never synced under A. Connecting B replaces A directly.
        let b = try await engine.connect(origin: .hosted)
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testReplyForAReplacedAccountIsDroppedAndItsDayStaysReserved() async throws {
        let transport = GatedTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        let credA = try await credential(engine, tokenA)

        let inFlight = Task { try await engine.sync(credential: credA) }
        await transport.waitForRequests(1)
        try await engine.disconnect()
        let b = try await engine.connect(origin: .hosted)
        transport.releaseAcceptingAll()
        let replyA = try await inFlight.value
        XCTAssertEqual(replyA, .notConnected)

        let resultB = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertEqual(resultB, .finished(uploaded: 0, remaining: 0, problem: nil))
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testCommittedButUnacknowledgedDayStaysWithItsAccountAcrossRelaunch() async throws {
        let transport = FakeTransport([.commitThenLose])
        let r = rig(transport)
        var engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        _ = try await engine.sync(credential: try await credential(engine, tokenA))

        engine = r.engine() // the process died before any acknowledgement
        let b = try await engine.connect(origin: .hosted)
        XCTAssertEqual(b.startDay, day("2026-05-05"))
        _ = try await engine.sync(credential: SyncCredential(accountID: b.accountID, token: tokenB))
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testCredentialForAnotherAccountCannotUpload() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        let a = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:10", zone))
        _ = try await engine.connect(origin: .hosted)
        let stale = try await engine.sync(credential: SyncCredential(accountID: a.accountID, token: tokenA))
        XCTAssertEqual(stale, .notConnected)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testNextDayGoesToTheNewAccountOnly() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: ServerOrigin("https://old.example")!)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 08:40", zone))
        _ = try await engine.sync(credential: try await credential(engine, tokenA))

        try await engine.disconnect()
        _ = try await engine.connect(origin: ServerOrigin("https://new.example")!)
        // The app refreshes after connecting; the new account gets its own registrations.
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        try fire(r, minutes: 15, at: "2026-05-05 08:30")
        r.clock.set(at("2026-05-05 09:00", zone))
        _ = try await engine.sync(credential: try await credential(engine, tokenB))
        XCTAssertEqual(transport.requests.count, 2)
        let second = transport.requests[1]
        XCTAssertEqual(second.url.host, "new.example")
        XCTAssertEqual(second.body.snapshots.map(\.day), ["2026-05-05"])
        XCTAssertNotEqual(second.body.snapshots[0].deviceID, transport.requests[0].body.snapshots[0].deviceID)
    }

    // MARK: Authorization (review finding 2)

    func testRevokedTokensAreNeverReusedAndHistoryKeepsItsSelection() async throws {
        let r = rig(now: "2026-05-03 08:00")
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        let initial = try await engine.status()
        let original = try XCTUnwrap(initial.currentSelectionID)
        try fire(r, minutes: 15, at: "2026-05-03 09:00")

        r.clock.set(at("2026-05-04 08:00", zone))
        r.center.clear()
        let denied = try await engine.reconcileMonitoring(center: r.center, authorization: .denied)
        XCTAssertTrue(denied.revocationDetected)
        let regranted = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(regranted.started, 0, "old tokens are void")
        XCTAssertTrue(r.center.registrations.isEmpty)
        let blocked = try await engine.status()
        XCTAssertTrue(blocked.needsReselection)

        let placement = try await pickAndMonitor(engine, r, payload: 8)
        XCTAssertEqual(placement, .today)
        let status = try await engine.status()
        XCTAssertFalse(status.needsReselection)
        XCTAssertNotEqual(status.currentSelectionID, original)
        XCTAssertEqual(r.center.registrations.count, MonitorPlan.horizonDays)
        XCTAssertTrue(r.center.registrations.allSatisfy { $0.payload == Data([8]) })
        XCTAssertEqual(status.recentDays.map(\.selectionID), [original], "yesterday keeps its selection")
    }

    func testRevocationWhileSuspendedIsDetectedFromVanishedRegistrations() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        r.center.clear() // revoked and granted again while the app was not running
        let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertTrue(result.revocationDetected)
        XCTAssertEqual(result.started, 0)
        let status = try await engine.status()
        XCTAssertTrue(status.needsReselection)
    }

    func testUnknownOrMissingAuthorizationStopsMonitoring() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .notDetermined)
        XCTAssertTrue(r.center.registrations.isEmpty)
        let status = try await engine.status()
        XCTAssertNil(status.monitoredThrough)
    }

    // MARK: Reconciliation (review finding 4)

    func testConcurrentReconcilesAndSelectionChangesNeverOverlapADay() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<40 {
                group.addTask {
                    if i % 5 == 0 {
                        _ = try? await engine.chooseSelection(payload: Data([UInt8(i)]), isEmpty: false)
                    } else {
                        _ = try? await engine.reconcileMonitoring(center: r.center, authorization: .approved)
                    }
                }
            }
        }
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(r.center.overlaps, 0, "two live registrations for one day")
        let schedule = try await engine.schedule()
        for live in r.center.registrations {
            XCTAssertEqual(schedule.effective(on: live.registration.day)?.id, live.registration.selectionID)
        }
        XCTAssertEqual(Set(r.center.registrations.map(\.registration.day)).count, MonitorPlan.horizonDays)
        XCTAssertEqual(r.center.registrations.count, MonitorPlan.horizonDays)
        let before = r.center.startCount
        let idle = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(idle.started, 0)
        XCTAssertEqual(idle.stopped, 0)
        XCTAssertEqual(r.center.startCount, before)
    }

    func testActivityLimitRegistersNearestDaysAndReportsIt() async throws {
        let r = rig()
        r.center.limit = 3
        let engine = r.engine()
        _ = try await engine.chooseSelection(payload: Data([1]), isEmpty: false)
        let result = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertEqual(result.started, 3)
        XCTAssertNotNil(result.failure)
        let status = try await engine.status()
        XCTAssertEqual(status.monitoredThrough, day("2026-05-06"))
    }

    func testSelectionChangeAfterUsageKeepsTodayAndReplacesFutureDays() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        let first = try XCTUnwrap(r.center.registration(for: day("2026-05-04")))
        try fire(r, minutes: 15, at: "2026-05-04 08:30")
        r.clock.set(at("2026-05-04 09:00", zone))
        let placement = try await pickAndMonitor(engine, r, payload: 9)
        XCTAssertEqual(placement, .tomorrow)
        XCTAssertEqual(r.center.registration(for: day("2026-05-04")), first)
        XCTAssertNotEqual(r.center.registration(for: day("2026-05-05"))?.selectionID, first.selectionID)
        XCTAssertEqual(r.center.overlaps, 0)
        let status = try await engine.status()
        XCTAssertEqual(status.currentSelectionID, first.selectionID)
        XCTAssertEqual(status.nextSelectionStarts, day("2026-05-05"))
        XCTAssertEqual(status.todaySeconds, 900)
    }

    func testEmptySelectionStopsMonitoring() async throws {
        let r = rig()
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        let placement = try await engine.chooseSelection(payload: Data(), isEmpty: true)
        XCTAssertEqual(placement, .today)
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertTrue(r.center.registrations.isEmpty)
        let status = try await engine.status()
        XCTAssertTrue(status.currentSelectionIsEmpty)
    }

    // MARK: Days and zones (review finding 5)

    func testDelayedCallbackFromYesterdayDoesNotInflateToday() async throws {
        let r = rig(now: "2026-10-18 07:00")
        let engine = r.engine()
        try await pickAndMonitor(engine, r)
        let yesterday = try XCTUnwrap(r.center.registration(for: day("2026-10-18")))
        r.clock.set(at("2026-10-19 13:00", zone))
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        try r.records.append(hit(yesterday, minutes: 720, at("2026-10-19 13:00:05", zone), zone: zone))
        let status = try await engine.status()
        XCTAssertEqual(status.todaySeconds, 0)
        XCTAssertTrue(status.recentDays.allSatisfy { $0.seconds == 0 })
    }

    func testSameDayTravelUploadsSeparateSeriesAndShowsTheLarger() async throws {
        let transport = FakeTransport()
        let r = rig(transport)
        let engine = r.engine()
        _ = try await engine.connect(origin: .hosted)
        try await pickAndMonitor(engine, r)
        try fire(r, minutes: 30, at: "2026-05-04 09:00")
        r.clock.set(at("2026-05-04 09:05", zone))
        let cred = try await credential(engine, tokenA)
        _ = try await engine.sync(credential: cred)

        let ny = "America/New_York"
        r.zone.set(ny)
        r.clock.set(at("2026-05-04 09:00", ny))
        _ = try await engine.reconcileMonitoring(center: r.center, authorization: .approved)
        XCTAssertTrue(r.center.registrations.allSatisfy { $0.timeZone == ny })
        XCTAssertEqual(r.center.overlaps, 0)
        try fire(r, minutes: 15, at: "2026-05-04 09:30", zone: ny)
        r.clock.set(at("2026-05-04 17:30", ny))
        _ = try await engine.sync(credential: cred)

        XCTAssertEqual(transport.requests.count, 2)
        let later = transport.requests[1].body.snapshots
        XCTAssertEqual(later.map(\.timezone), [ny])
        XCTAssertEqual(later.map(\.day), ["2026-05-04"])
        XCTAssertNotEqual(transport.requests[0].body.snapshots[0].selectionID, later[0].selectionID)
        try ServerRules.assertAccepted(transport.requests[1].raw)
        let status = try await engine.status()
        XCTAssertEqual(status.todaySeconds, 1800)
    }
}
