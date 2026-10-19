import XCTest
@testable import ClockedCore

final class DayKeyTests: XCTestCase {
    func testParsesAndFormats() {
        XCTAssertEqual(day("2026-02-28").description, "2026-02-28")
        XCTAssertNil(DayKey("2026-02-30"))
        XCTAssertNil(DayKey("2026-2-03"))
        XCTAssertNil(DayKey("garbage"))
        XCTAssertEqual(day("2028-02-28").adding(days: 1), day("2028-02-29"))
        XCTAssertEqual(day("2026-12-31").adding(days: 1), day("2027-01-01"))
        XCTAssertEqual(day("2026-03-01").adding(days: -1), day("2026-02-28"))
        XCTAssertEqual(day("2026-01-01").days(until: day("2026-03-01")), 59)
    }

    func testDSTDaysHaveTrueLength() {
        let ny = tz("America/New_York")
        XCTAssertEqual(day("2026-03-08").interval(in: ny).duration, 23 * 3600)
        XCTAssertEqual(day("2026-11-01").interval(in: ny).duration, 25 * 3600)
        XCTAssertEqual(day("2026-06-01").interval(in: ny).duration, 24 * 3600)
        // Chile moves clocks at local midnight; the day still has a start.
        let santiago = tz("America/Santiago")
        XCTAssertEqual(day("2026-09-06").interval(in: santiago).duration, 23 * 3600)
    }

    func testContainingUsesTheGivenZone() {
        let instant = at("2026-05-01 23:30", "UTC")
        XCTAssertEqual(DayKey.containing(instant, in: tz("UTC")), day("2026-05-01"))
        XCTAssertEqual(DayKey.containing(instant, in: tz("Asia/Tokyo")), day("2026-05-02"))
        XCTAssertEqual(DayKey.containing(instant, in: tz("America/Los_Angeles")), day("2026-05-01"))
    }

    func testCodableAsString() throws {
        let data = try JSONEncoder().encode([day("2026-07-04")])
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "[\"2026-07-04\"]")
        XCTAssertThrowsError(try JSONDecoder().decode([DayKey].self, from: Data("[\"2026-13-01\"]".utf8)))
    }
}

final class NamingTests: XCTestCase {
    func testRegistrationNameRoundTrip() {
        let r = MonitorRegistration(selectionID: "a1b2-c3", day: day("2026-05-04"), startsAt: Date(timeIntervalSince1970: 1_790_000_000.2))
        XCTAssertEqual(r.activityName, "clk2.a1b2-c3.1790000001.20260504")
        XCTAssertEqual(MonitorRegistration(activityName: r.activityName), r)
    }

    func testRejectsForeignNames() {
        XCTAssertNil(MonitorRegistration(activityName: "daily"))
        XCTAssertNil(MonitorRegistration(activityName: "clk2.-bad.100.20260504"))
        XCTAssertNil(MonitorRegistration(activityName: "clk2.ok.x.20260504"))
        XCTAssertNil(MonitorRegistration(activityName: "clk2.ok.100.20260230"))
        XCTAssertNil(MonitorRegistration(activityName: "clk1.ok.100"))
        XCTAssertNil(MonitorRegistration(activityName: "clk2.ok.100.2026050"))
    }

    func testLadder() {
        let l = MilestoneLadder.standard
        XCTAssertEqual(l.minutes.first, 15)
        XCTAssertEqual(l.minutes.last, 720)
        XCTAssertEqual(l.minutes.count, 48)
        XCTAssertEqual(l.minutes(fromEventName: l.eventName(minutes: 45)), 45)
        XCTAssertNil(l.minutes(fromEventName: "m50"))
        XCTAssertNil(l.minutes(fromEventName: "m735"))
        XCTAssertNil(l.minutes(fromEventName: "x15"))
    }
}

final class RecordStoreTests: XCTestCase {
    func testDuplicateCallbackKeepsFirstDelivery() throws {
        let store = MonitorRecordStore(directory: tempDirectory())
        let monday = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00")
        let tuesday = reg("s1", "2026-05-05")
        XCTAssertTrue(try store.append(hit(monday, minutes: 15, at("2026-05-04 08:20"), zone: "UTC")))
        XCTAssertFalse(try store.append(hit(monday, minutes: 15, at("2026-05-04 09:00"), zone: "UTC")))
        // Another day's registration is a different callback.
        XCTAssertTrue(try store.append(hit(tuesday, minutes: 15, at("2026-05-05 08:20"), zone: "UTC")))
        let (records, files) = store.readAll()
        XCTAssertEqual(files.count, 2)
        XCTAssertEqual(records.map(\.at).sorted(), [at("2026-05-04 08:20"), at("2026-05-05 08:20")])
    }

    func testCorruptFilesAreReportedForCleanup() throws {
        let dir = tempDirectory()
        let store = MonitorRecordStore(directory: dir)
        try Data("{".utf8).write(to: dir.appendingPathComponent("t_bad.json"))
        let (records, files) = store.readAll()
        XCTAssertTrue(records.isEmpty)
        XCTAssertEqual(files.count, 1)
        store.remove(files)
        XCTAssertTrue(store.readAll().files.isEmpty)
    }

    func testRejectsUnsafeNames() {
        let r = MonitorRecord(kind: .threshold, activity: "../x", event: "m15", at: Date(), timeZone: "UTC")
        XCTAssertNil(r.fileName)
        XCTAssertThrowsError(try MonitorRecordStore(directory: tempDirectory()).append(r))
    }
}
