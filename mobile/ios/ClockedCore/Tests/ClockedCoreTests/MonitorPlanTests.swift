import XCTest
@testable import ClockedCore

final class MonitorPlanTests: XCTestCase {
    let berlin = tz("Europe/Berlin")
    let now = at("2026-05-04 09:00:30", "Europe/Berlin")

    func plan(active: [String] = [], registry: MonitorRegistry = MonitorRegistry(), schedule s: SelectionSchedule,
              now: Date? = nil, zone: TimeZone? = nil, authorized: Bool = true, generation: Int = 0) -> MonitorPlan {
        MonitorPlan.make(active: active, registry: registry, schedule: s, now: now ?? self.now,
                         timeZone: zone ?? berlin, authorized: authorized, authGeneration: generation)
    }

    func registry(_ names: [String], zone: String = "Europe/Berlin") -> MonitorRegistry {
        var r = MonitorRegistry()
        for n in names { r.started(n, timeZone: zone) }
        return r
    }

    func testRegistersEachDayOfTheHorizonAsItsOwnInterval() {
        let p = plan(schedule: schedule("a", from: "2026-05-01"))
        XCTAssertEqual(p.start.count, MonitorPlan.horizonDays)
        XCTAssertEqual(p.start.map(\.registration.day.description),
                       (0..<7).map { day("2026-05-04").adding(days: $0).description })
        // Today starts at the next whole minute; later days at midnight. All end at 23:59.
        XCTAssertEqual(p.start[0].interval.start, at("2026-05-04 09:01", "Europe/Berlin"))
        XCTAssertEqual(p.start[0].interval.end, at("2026-05-04 23:59", "Europe/Berlin"))
        XCTAssertEqual(p.start[1].interval.start, at("2026-05-05 00:00", "Europe/Berlin"))
        XCTAssertEqual(p.start[0].registration.startDate, p.start[0].interval.start)
        XCTAssertEqual(Set(p.start.map(\.registration.activityName)).count, 7)
    }

    func testFutureSelectionReplacesOnlyTheDaysItOwns() {
        var s = schedule("a", from: "2026-05-01")
        s.choose(id: "b", payload: Data([1]), isEmpty: false, today: day("2026-05-04"), todayHasMeasurements: true, authGeneration: 0)
        let existing = (0..<7).map { reg("a", day("2026-05-04").adding(days: $0).description, zone: "Europe/Berlin").activityName }
        let p = plan(active: existing, registry: registry(existing), schedule: s)
        XCTAssertEqual(p.stop, Array(existing.dropFirst()).sorted())
        XCTAssertEqual(p.start.map(\.registration.selectionID), Array(repeating: "b", count: 6))
        XCTAssertEqual(p.start.first?.registration.day, day("2026-05-05"))
    }

    func testKeepsMatchingRegistrationsAndYesterdayButStopsOlderOnes() {
        let s = schedule("a", from: "2026-05-01")
        let days = (0..<7).map { reg("a", day("2026-05-04").adding(days: $0).description, zone: "Europe/Berlin").activityName }
        let yesterday = reg("a", "2026-05-03", zone: "Europe/Berlin").activityName
        let older = reg("a", "2026-05-02", zone: "Europe/Berlin").activityName
        let foreign = "someoneElse"
        let p = plan(active: days + [yesterday, older, foreign], registry: registry(days + [yesterday, older]), schedule: s)
        XCTAssertEqual(p.start, [])
        XCTAssertEqual(p.stop, [older])
    }

    func testTimeZoneChangeReplacesEveryUpcomingRegistration() {
        let s = schedule("a", from: "2026-05-01")
        let days = (0..<7).map { reg("a", day("2026-05-04").adding(days: $0).description, zone: "Europe/Berlin").activityName }
        let p = plan(active: days, registry: registry(days), schedule: s, zone: tz("America/New_York"))
        XCTAssertEqual(p.stop.count, 7)
        XCTAssertEqual(p.start.count, 7)
        XCTAssertTrue(p.start.allSatisfy { $0.timeZone == "America/New_York" })
    }

    func testNothingIsRegisteredWithoutAuthorizationOrWithVoidOrEmptySelections() {
        let s = schedule("a", from: "2026-05-01")
        let mine = reg("a", "2026-05-04", zone: "Europe/Berlin").activityName
        XCTAssertEqual(plan(active: [mine, "foreign"], schedule: s, authorized: false), MonitorPlan(stop: [mine], start: []))
        XCTAssertEqual(plan(schedule: s, generation: 1), MonitorPlan(), "tokens from generation 0 were voided")
        var empty = SelectionSchedule()
        empty.choose(id: "z", payload: Data(), isEmpty: true, today: day("2026-05-04"), todayHasMeasurements: false, authGeneration: 0)
        XCTAssertEqual(plan(schedule: empty), MonitorPlan())
    }

    func testTooLateTodaySkipsOnlyToday() {
        let p = plan(schedule: schedule("a", from: "2026-05-01"), now: at("2026-05-04 23:50", "Europe/Berlin"))
        XCTAssertEqual(p.start.first?.registration.day, day("2026-05-05"))
        XCTAssertEqual(p.start.count, 6)
    }

    func testVanishedRegistrationsAreDetected() {
        let today = reg("a", "2026-05-04", startingAt: "2026-05-04 08:00", zone: "Europe/Berlin").activityName
        let tomorrow = reg("a", "2026-05-05", zone: "Europe/Berlin").activityName
        let r = registry([today, tomorrow])
        XCTAssertFalse(MonitorPlan.registrationsVanished(active: [today, tomorrow], registry: r, now: now, timeZone: berlin))
        XCTAssertTrue(MonitorPlan.registrationsVanished(active: [], registry: r, now: now, timeZone: berlin))
        // Today's interval may end on its own at 23:59.
        XCTAssertFalse(MonitorPlan.registrationsVanished(active: [tomorrow], registry: r,
                                                         now: at("2026-05-04 23:59:30", "Europe/Berlin"), timeZone: berlin))
    }
}
