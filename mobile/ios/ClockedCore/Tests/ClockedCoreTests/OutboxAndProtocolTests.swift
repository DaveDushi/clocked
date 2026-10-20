import XCTest
@testable import ClockedCore

let selS = "0f3a9c2e-1111-4222-8333-944455556666"
let selT = "7b1d0c55-aaaa-4bbb-8ccc-dddddddddddd"

final class AccountStateTests: XCTestCase {
    func m(_ d: String, _ sel: String, _ seconds: Int, zone: String = "Europe/Berlin") -> DayMeasurement {
        let base = ["s": selS, "t": selT][sel] ?? sel
        return DayMeasurement(day: day(d), selectionID: base, timeZone: zone, seconds: seconds, implausibleCallbacks: 0)
    }

    func account(start: String = "2026-05-01") -> AccountState {
        AccountState(accountID: "acc", origin: "https://example.com", deviceID: "ios-dev", startDay: day(start))
    }

    func testOnlyIncreasesAreQueued() {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900)], makeID: ids.next)
        a.enqueue([m("2026-05-04", "s", 900)], makeID: ids.next)
        a.enqueue([m("2026-05-04", "s", 0), m("2026-05-05", "s", 0)], makeID: ids.next)
        XCTAssertEqual(a.pending.map(\.seconds), [900])
        a.enqueue([m("2026-05-04", "s", 1800)], makeID: ids.next)
        XCTAssertEqual(a.nextBatch().map(\.durationSeconds), [1800])
        XCTAssertEqual(a.nextBatch().map(\.id), ["id2"])
    }

    func testDaysBeforeTheAccountStartAreNeverQueued() {
        var a = account(start: "2026-05-04")
        a.enqueue([m("2026-05-03", "s", 900), m("2026-05-04", "s", 900)], makeID: Counter().next)
        XCTAssertEqual(a.nextBatch().map(\.day), ["2026-05-04"])
    }

    func testALargerValueSupersedesAndAnOlderAcknowledgementCannotClearIt() {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900)], makeID: ids.next)
        let firstBatch = a.nextBatch()
        a.enqueue([m("2026-05-04", "s", 1800)], makeID: ids.next)
        XCTAssertEqual(a.pending.map(\.id), ["id2"], "one queued value per key")
        a.apply(sent: firstBatch, accepted: ["id1"])
        XCTAssertEqual(a.nextBatch().map(\.durationSeconds), [1800])
        a.apply(sent: a.nextBatch(), accepted: ["id2"])
        XCTAssertTrue(a.pending.isEmpty)
        let series = MeasurementSeries.id(selectionID: selS, timeZone: "Europe/Berlin")
        XCTAssertEqual(a.acknowledged[SnapshotKey(day: day("2026-05-04"), selectionID: series)], 1800)
    }

    /// Review finding 3: pending snapshots are not pruned by age.
    func testPendingSurvivesPruning() {
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900)], makeID: Counter().next)
        a.prune(before: day("2026-09-01"))
        XCTAssertEqual(a.nextBatch().map(\.day), ["2026-05-04"])
        XCTAssertEqual(a.nextBatch().map(\.timezone), ["Europe/Berlin"])
    }

    func testOnlyAcceptedIDsAreAcknowledgedAndDeclinedOnesEventuallyDrop() {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900), m("2026-05-05", "s", 900)], makeID: ids.next)
        let batch = a.nextBatch()
        a.apply(sent: batch, accepted: ["id1", "unknown"])
        XCTAssertEqual(a.pending.map(\.id), ["id2"])
        XCTAssertEqual(a.pending.first?.attempts, 1)
        a.apply(sent: a.nextBatch(), accepted: [])
        a.apply(sent: a.nextBatch(), accepted: [])
        XCTAssertTrue(a.pending.isEmpty)
        XCTAssertEqual(a.rejectedCount, 1)
        // A permanently declined series-day is not retried, even with a larger value.
        a.enqueue([m("2026-05-05", "s", 3600)], makeID: ids.next)
        XCTAssertTrue(a.pending.isEmpty)
        // An ID accepted without having been sent in this batch is ignored.
        a.enqueue([m("2026-05-06", "s", 900)], makeID: ids.next)
        a.apply(sent: [], accepted: ["id3"])
        XCTAssertEqual(a.pending.map(\.id), ["id3"])
        // Abandoned keys survive persistence.
        let store = JSONFileStore<AccountState>(url: tempDirectory().appendingPathComponent("a.json"))
        try? store.save(a)
        XCTAssertEqual(try? store.load()?.abandoned, a.abandoned)
    }

    func testEachZoneIsItsOwnSeriesSoBucketsNeverChangeZone() {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900, zone: "Europe/Berlin")], makeID: ids.next)
        a.enqueue([m("2026-05-04", "s", 1800, zone: "America/New_York")], makeID: ids.next)
        let batch = a.nextBatch()
        XCTAssertEqual(batch.count, 2)
        XCTAssertEqual(Set(batch.map(\.selectionID)).count, 2)
        for snap in batch {
            XCTAssertEqual(snap.selectionID, MeasurementSeries.id(selectionID: selS, timeZone: snap.timezone))
        }
    }

    func testSeriesIDIsStable() {
        XCTAssertEqual(MeasurementSeries.zoneTag("Europe/Berlin"), "31405cd4")
        let id = MeasurementSeries.id(selectionID: selS, timeZone: "America/Argentina/Buenos_Aires")
        XCTAssertTrue(MeasurementSeries.isServerValid(id))
        XCTAssertFalse(id.contains("Argentina"))
        XCTAssertFalse(MeasurementSeries.isServerValid("s1-z31405cd4"))
        XCTAssertFalse(MeasurementSeries.isServerValid(selS))
    }

    func testNonUUIDSelectionsAreNeverQueued() {
        var a = account()
        a.enqueue([m("2026-05-04", "custom-name", 900)], makeID: Counter().next)
        XCTAssertTrue(a.pending.isEmpty)
    }

    func testAbandoningAKeyDropsItsOlderQueuedValues() {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900)], makeID: ids.next)
        a.enqueue([m("2026-05-04", "s", 1800)], makeID: ids.next)
        a.enqueue([m("2026-05-04", "s", 2700)], makeID: ids.next)
        for _ in 0..<AccountState.maxAttempts { a.apply(sent: a.nextBatch(), accepted: []) }
        XCTAssertTrue(a.pending.isEmpty)
        XCTAssertTrue(a.nextBatch().isEmpty)
        XCTAssertEqual(a.rejectedCount, 1)
    }

    func testBatchesAreBoundedAndOrdered() {
        let ids = Counter()
        var a = account(start: "2020-01-01")
        let base = day("2025-01-01")
        a.enqueue((0..<600).map { m(base.adding(days: $0).description, "s", 900) }, makeID: ids.next)
        let batch = a.nextBatch()
        XCTAssertEqual(batch.count, 500)
        XCTAssertEqual(batch.first?.day, "2025-01-01")
        XCTAssertEqual(batch.map(\.day), batch.map(\.day).sorted())
        a.batchLimit = 7
        XCTAssertEqual(a.nextBatch().count, 7)
    }

    func testStartDayKeepsAccountsDisjoint() {
        XCTAssertEqual(AccountState.startDay(today: day("2026-05-04"), reservedThrough: nil), day("2026-05-04"))
        XCTAssertEqual(AccountState.startDay(today: day("2026-05-04"), reservedThrough: day("2026-05-03")), day("2026-05-04"))
        XCTAssertEqual(AccountState.startDay(today: day("2026-05-04"), reservedThrough: day("2026-05-04")), day("2026-05-05"))
        // Clock moved backwards after a later day was reserved.
        XCTAssertEqual(AccountState.startDay(today: day("2026-05-04"), reservedThrough: day("2026-05-09")), day("2026-05-10"))
    }

    func testRoundTripsThroughJSON() throws {
        let ids = Counter()
        var a = account()
        a.enqueue([m("2026-05-04", "s", 900), m("2026-05-05", "t", 1800)], makeID: ids.next)
        a.apply(sent: a.nextBatch(), accepted: ["id1"])
        a.retryAfter = Date(timeIntervalSince1970: 1_800_000_000)
        a.lastProblem = .offline
        let store = JSONFileStore<AccountState>(url: tempDirectory().appendingPathComponent("a.json"))
        try store.save(a)
        XCTAssertEqual(try store.load(), a)
    }
}

final class ProtocolTests: XCTestCase {
    func testOriginValidation() {
        XCTAssertEqual(ServerOrigin("https://Clocked.Example.com/")?.string, "https://clocked.example.com")
        XCTAssertEqual(ServerOrigin(" https://host:8443 ")?.usageEndpoint.absoluteString, "https://host:8443/mobile/usage")
        XCTAssertEqual(ServerOrigin.hosted.dashboardLinkEndpoint.absoluteString, "https://clocked.daviddusi.com/api/auth/desktop/link")
        XCTAssertNil(ServerOrigin("http://clocked.example.com"))
        XCTAssertNil(ServerOrigin("https://user:pw@clocked.example.com"))
        XCTAssertNil(ServerOrigin("https://clocked.example.com/api"))
        XCTAssertNil(ServerOrigin("https://clocked.example.com?token=clk_x"))
        XCTAssertNil(ServerOrigin("clocked.example.com"))
        let origin = ServerOrigin("https://a.example")!
        XCTAssertTrue(origin.isSameOrigin(URL(string: "https://a.example/api/auth/desktop/open?code=x")!))
        XCTAssertFalse(origin.isSameOrigin(URL(string: "https://evil.example/open")!))
        XCTAssertFalse(origin.isSameOrigin(URL(string: "http://a.example/open")!))
    }

    func testTokenShape() {
        XCTAssertTrue(DeviceToken.isWellFormed("clk_" + String(repeating: "aZ0-_", count: 6)))
        XCTAssertFalse(DeviceToken.isWellFormed("clk_short"))
        XCTAssertFalse(DeviceToken.isWellFormed("tok_" + String(repeating: "a", count: 32)))
        XCTAssertFalse(DeviceToken.isWellFormed("clk_" + String(repeating: "a", count: 31) + " "))
    }

    func testWireFormatMatchesContract() throws {
        let body = UsageRequestBody(snapshots: [UsageSnapshot(
            id: "id1", deviceID: "ios-dev", platform: "ios", day: "2026-05-04",
            timezone: "Europe/Berlin", selectionID: "sel", durationSeconds: 900
        )])
        let json = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(body)) as! [String: Any]
        let snap = (json["snapshots"] as! [[String: Any]])[0]
        XCTAssertEqual(Set(snap.keys), ["id", "device_id", "platform", "day", "timezone", "selection_id", "duration_seconds"])
        XCTAssertEqual(snap["duration_seconds"] as? Int, 900)
        XCTAssertEqual(snap["platform"] as? String, "ios")
    }

    func testClassification() {
        func c(_ s: Int, _ b: String = "", retry: TimeInterval? = nil) -> UploadOutcome {
            UploadOutcome.classify(HTTPResult(status: s, body: Data(b.utf8), retryAfterSeconds: retry))
        }
        XCTAssertEqual(c(200, #"{"accepted":["a","b"]}"#), .processed(accepted: ["a", "b"]))
        XCTAssertEqual(c(409, #"{"accepted":[]}"#), .processed(accepted: []))
        XCTAssertEqual(c(400, #"{"error":"no valid snapshots","accepted":[]}"#), .processed(accepted: []))
        XCTAssertEqual(c(400, #"{"error":"invalid json"}"#), .retry(.badResponse, after: nil))
        XCTAssertEqual(c(200, "<html>"), .retry(.badResponse, after: nil))
        XCTAssertEqual(c(401), .blocked(.unauthorized))
        XCTAssertEqual(c(402), .blocked(.subscriptionRequired))
        XCTAssertEqual(c(404), .blocked(.serverNeedsUpdate))
        XCTAssertEqual(c(413), .shrinkBatch)
        XCTAssertEqual(c(429, retry: 60), .retry(.rateLimited, after: 60))
        XCTAssertEqual(c(503), .retry(.serverError, after: nil))
        XCTAssertEqual(c(302), .retry(.serverError, after: nil))
    }

    func testBackoffBounds() {
        XCTAssertEqual(Backoff.delay(failures: 1, jitter: 1), 30)
        XCTAssertEqual(Backoff.delay(failures: 1, jitter: 0), 15)
        XCTAssertEqual(Backoff.delay(failures: 3, jitter: 1), 120)
        XCTAssertEqual(Backoff.delay(failures: 40, jitter: 1), 6 * 3600)
    }
}

final class DashboardLinkTests: XCTestCase {
    func testUsesSameOriginLinkOrFallsBack() async {
        let origin = ServerOrigin("https://clocked.example.com")!
        let good = FakeTransport([.status(200, #"{"url":"https://clocked.example.com/api/auth/desktop/open?code=abc"}"#)])
        let url = await DashboardLink.url(origin: origin, token: "clk_x", transport: good)
        XCTAssertEqual(url.absoluteString, "https://clocked.example.com/api/auth/desktop/open?code=abc")
        XCTAssertEqual(good.requests.first?.url.path, "/api/auth/desktop/link")

        let evil = FakeTransport([.status(200, #"{"url":"https://evil.example/steal"}"#)])
        let fallback = await DashboardLink.url(origin: origin, token: "clk_x", transport: evil)
        XCTAssertEqual(fallback, origin.url)

        let down = FakeTransport([.offline])
        let offline = await DashboardLink.url(origin: origin, token: "clk_x", transport: down)
        XCTAssertEqual(offline, origin.url)
    }
}
