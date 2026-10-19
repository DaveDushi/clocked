import XCTest
@testable import ClockedCore

final class MeasurementLedgerTests: XCTestCase {
    let ladder = MilestoneLadder.standard
    let berlin = "Europe/Berlin"

    func measure(_ records: [MonitorRecord], _ sched: SelectionSchedule, zones: [String: String] = [:]) -> [DayMeasurement] {
        var l = MeasurementLedger()
        l.ingest(records)
        return l.measurements(schedule: sched, zones: zones, ladder: ladder)
    }

    func testHighestPlausibleMilestoneIsTheLowerBound() {
        let r = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let m = measure([
            start(r, at("2026-05-04 08:00:01", berlin), zone: berlin),
            hit(r, minutes: 15, at("2026-05-04 08:20", berlin), zone: berlin),
            hit(r, minutes: 30, at("2026-05-04 08:45", berlin), zone: berlin),
        ], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m, [DayMeasurement(day: day("2026-05-04"), selectionID: "s1", timeZone: berlin, seconds: 1800)])
    }

    func testCallbackSoonerThanItsThresholdIsIgnored() {
        // The iOS 26 defect fires thresholds seconds after registration.
        let r = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let m = measure([
            hit(r, minutes: 60, at("2026-05-04 08:00:20", berlin), zone: berlin),
            hit(r, minutes: 15, at("2026-05-04 08:16", berlin), zone: berlin),
        ], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m.first?.seconds, 900)
        XCTAssertEqual(m.first?.implausibleCallbacks, 1)
    }

    func testFutureDayRegistrationsMeasureFromLocalMidnight() {
        let r = reg("s1", "2026-05-05", zone: berlin)
        let m = measure([
            hit(r, minutes: 15, at("2026-05-05 00:10", berlin), zone: berlin), // impossible
            hit(r, minutes: 30, at("2026-05-05 07:00", berlin), zone: berlin),
        ], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m.map(\.day), [day("2026-05-05")])
        XCTAssertEqual(m.first?.seconds, 1800)
        XCTAssertEqual(m.first?.implausibleCallbacks, 1)
    }

    /// Review finding 5: a delayed 720-minute callback from yesterday must not
    /// become today's value after five seconds of use today.
    func testLateCallbackBelongsToTheDayInItsNameNotTheDeliveryDay() {
        let yesterday = reg("s1", "2026-10-18", zone: berlin)
        let today = reg("s1", "2026-10-19", zone: berlin)
        let sched = schedule("s1", from: "2026-10-01")
        let slightlyLate = measure([
            start(yesterday, at("2026-10-18 07:00", berlin), zone: berlin),
            start(today, at("2026-10-19 13:00", berlin), zone: berlin),
            hit(yesterday, minutes: 720, at("2026-10-19 01:00", berlin), zone: berlin),
        ], sched)
        XCTAssertEqual(slightlyLate.map { "\($0.day) \($0.seconds)" }, ["2026-10-18 43200"])

        let muchLater = measure([
            start(today, at("2026-10-19 13:00", berlin), zone: berlin),
            hit(yesterday, minutes: 720, at("2026-10-19 13:00:05", berlin), zone: berlin),
        ], sched)
        XCTAssertEqual(muchLater.map { "\($0.day) \($0.seconds) q\($0.quarantinedCallbacks)" }, ["2026-10-18 0 q1"])
        XCTAssertFalse(muchLater.contains { $0.day == day("2026-10-19") })
    }

    /// Review finding 4: registrations of one day may have measured the same
    /// minutes, so they are never added.
    func testOverlappingRegistrationsOfOneDayKeepTheLargestValue() {
        let first = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let second = reg("s1", "2026-05-04", startingAt: "2026-05-04 10:00", zone: berlin)
        let m = measure([
            hit(first, minutes: 90, at("2026-05-04 11:30", berlin), zone: berlin),
            hit(second, minutes: 90, at("2026-05-04 11:30", berlin), zone: berlin),
        ], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m.first?.seconds, 90 * 60)
    }

    func testValueIsCappedByTheWindowItCovers() {
        // Registered at 22:30: at most 90 minutes remain in the day.
        let r = reg("s1", "2026-05-04", startingAt: "2026-05-04 22:30", zone: berlin)
        let m = measure([
            hit(r, minutes: 105, at("2026-05-05 00:30", berlin), zone: berlin),
        ], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m.first?.seconds, 90 * 60)
    }

    func testDuplicateAndOutOfOrderDeliveryGiveTheSameResult() {
        let r = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let a = hit(r, minutes: 15, at("2026-05-04 08:20", berlin), zone: berlin)
        let b = hit(r, minutes: 45, at("2026-05-04 09:10", berlin), zone: berlin)
        let sched = schedule("s1", from: "2026-05-04")
        let once = measure([a, b], sched)
        XCTAssertEqual(measure([b, a, b, a], sched), once)
        var l = MeasurementLedger()
        l.ingest([b])
        l.ingest([a])
        l.ingest([b])
        XCTAssertEqual(l.measurements(schedule: sched, zones: [:], ladder: ladder), once)
        XCTAssertEqual(once.first?.seconds, 2700)
    }

    func testLateDuplicateCannotValidateAnEarlyCallback() {
        let r = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let early = hit(r, minutes: 60, at("2026-05-04 08:05", berlin), zone: berlin)
        let lateCopy = hit(r, minutes: 60, at("2026-05-04 10:00", berlin), zone: berlin)
        let m = measure([early, lateCopy], schedule("s1", from: "2026-05-04"))
        XCTAssertEqual(m.first?.seconds, 0)
        XCTAssertEqual(m.first?.implausibleCallbacks, 1)
    }

    func testOnlyTheOwningSelectionMeasuresADay() {
        var sched = schedule("old", from: "2026-05-04")
        XCTAssertEqual(sched.choose(id: "new", payload: Data([2]), isEmpty: false, today: day("2026-05-04"),
                                    todayHasMeasurements: true, authGeneration: 0), .tomorrow)
        let old4 = reg("old", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let new4 = reg("new", "2026-05-04", startingAt: "2026-05-04 12:00", zone: berlin)
        let old5 = reg("old", "2026-05-05", zone: berlin)
        let new5 = reg("new", "2026-05-05", zone: berlin)
        let m = measure([
            hit(old4, minutes: 30, at("2026-05-04 09:00", berlin), zone: berlin),
            hit(new4, minutes: 60, at("2026-05-04 14:00", berlin), zone: berlin), // not the owner that day
            hit(old5, minutes: 15, at("2026-05-05 09:00", berlin), zone: berlin), // stale registration
            hit(new5, minutes: 15, at("2026-05-05 09:00", berlin), zone: berlin),
        ], sched)
        XCTAssertEqual(m.map { "\($0.day) \($0.selectionID) \($0.seconds)" }, ["2026-05-04 old 1800", "2026-05-05 new 900"])
    }

    func testRegistrationZoneDecidesTheSeries() {
        // Re-registered in New York after landing; each registration keeps its zone.
        let ny = "America/New_York"
        let inBerlin = reg("s1", "2026-05-04", startingAt: "2026-05-04 08:00", zone: berlin)
        let inNewYork = reg("s1", "2026-05-04", startingAt: "2026-05-04 09:00", zone: ny)
        let m = measure([
            hit(inBerlin, minutes: 30, at("2026-05-04 09:00", berlin), zone: berlin),
            hit(inNewYork, minutes: 15, at("2026-05-04 09:30", ny), zone: ny),
        ], schedule("s1", from: "2026-05-01"), zones: [inBerlin.activityName: berlin, inNewYork.activityName: ny])
        XCTAssertEqual(m.map { "\($0.timeZone) \($0.seconds)" }.sorted(), ["America/New_York 900", "Europe/Berlin 1800"])
    }

    func testDSTShortDayUsesRealElapsedTime() {
        let ny = "America/New_York"
        let r = reg("s1", "2026-03-08", zone: ny)
        // Midnight to 03:30 on the spring-forward day is 2.5 real hours, not 3.5.
        let m = measure([
            hit(r, minutes: 180, at("2026-03-08 03:30", ny), zone: ny),
            hit(r, minutes: 120, at("2026-03-08 03:31", ny), zone: ny),
        ], schedule("s1", from: "2026-03-07"))
        XCTAssertEqual(m.first?.seconds, 120 * 60)
        XCTAssertEqual(m.first?.implausibleCallbacks, 1)
    }

    func testUnknownRecordsAreIgnoredAndPruneDropsOldDays() {
        let r1 = reg("s1", "2026-05-01")
        let r10 = reg("s1", "2026-05-10")
        var l = MeasurementLedger()
        l.ingest([
            MonitorRecord(kind: .threshold, activity: "someoneElse", event: "m15", at: at("2026-05-01 09:00"), timeZone: "UTC"),
            MonitorRecord(kind: .threshold, activity: r1.activityName, event: "m15", at: at("2026-05-01 09:00"), timeZone: "Mars/Base"),
            hit(r1, minutes: 15, at("2026-05-01 09:00"), zone: "UTC"),
            hit(r10, minutes: 15, at("2026-05-10 09:00"), zone: "UTC"),
        ])
        XCTAssertEqual(l.hits.count, 2)
        l.prune(before: day("2026-05-09"))
        XCTAssertEqual(l.measurements(schedule: schedule("s1", from: "2026-05-01"), zones: [:], ladder: ladder).map(\.day), [day("2026-05-10")])
    }

    func testSurvivesPersistence() throws {
        let r = reg("s1", "2026-05-01", startingAt: "2026-05-01 08:00")
        var l = MeasurementLedger()
        l.ingest([start(r, at("2026-05-01 08:00"), zone: "UTC"), hit(r, minutes: 15, at("2026-05-01 09:00"), zone: "UTC")])
        let store = JSONFileStore<MeasurementLedger>(url: tempDirectory().appendingPathComponent("l.json"))
        try store.save(l)
        XCTAssertEqual(try store.load(), l)
    }
}

final class SelectionScheduleTests: XCTestCase {
    func choose(_ s: inout SelectionSchedule, _ id: String, _ d: String, measured: Bool, generation: Int = 0, empty: Bool = false) -> SelectionSchedule.Placement {
        s.choose(id: id, payload: Data(), isEmpty: empty, today: day(d), todayHasMeasurements: measured, authGeneration: generation)
    }

    func testFirstSelectionStartsToday() {
        var s = SelectionSchedule()
        XCTAssertEqual(choose(&s, "a", "2026-05-04", measured: false), .today)
        XCTAssertEqual(s.effective(on: day("2026-05-04"))?.id, "a")
        XCTAssertNil(s.effective(on: day("2026-05-03")))
    }

    func testChangeAfterMeasuredUsageStartsTomorrowAndKeepsHistory() {
        var s = schedule("a", from: "2026-05-01")
        XCTAssertEqual(choose(&s, "b", "2026-05-04", measured: true), .tomorrow)
        XCTAssertEqual(s.effective(on: day("2026-05-02"))?.id, "a")
        XCTAssertEqual(s.effective(on: day("2026-05-04"))?.id, "a")
        XCTAssertEqual(s.effective(on: day("2026-05-05"))?.id, "b")
        XCTAssertEqual(s.pending(after: day("2026-05-04"))?.id, "b")
        XCTAssertEqual(choose(&s, "c", "2026-05-04", measured: true), .tomorrow)
        XCTAssertEqual(s.effective(on: day("2026-05-05"))?.id, "c")
        XCTAssertEqual(s.entries.map(\.id), ["a", "c"])
    }

    func testChangeBeforeAnyUsageTakesTodayWithoutRelabelingPastDays() {
        var s = schedule("a", from: "2026-05-01")
        XCTAssertEqual(choose(&s, "b", "2026-05-04", measured: false), .today)
        XCTAssertEqual(s.effective(on: day("2026-05-03"))?.id, "a")
        XCTAssertEqual(s.effective(on: day("2026-05-04"))?.id, "b")
        _ = choose(&s, "c", "2026-05-04", measured: false)
        XCTAssertEqual(s.entries.map(\.id), ["a", "c"])
    }

    func testVoidedOrEmptyOwnerIsReplacedToday() {
        var s = schedule("a", from: "2026-05-01", generation: 0)
        // Access was revoked (generation 1): the old tokens are void.
        XCTAssertEqual(choose(&s, "b", "2026-05-04", measured: true, generation: 1), .today)
        XCTAssertEqual(s.effective(on: day("2026-05-03"))?.id, "a")
        var e = schedule("a", from: "2026-05-01")
        _ = choose(&e, "empty", "2026-05-02", measured: false, empty: true)
        XCTAssertEqual(choose(&e, "c", "2026-05-04", measured: true), .today)
    }

    func testVoidedOwnerWithMeasurementsKeepsOwningItsDay() {
        var s = schedule("a", from: "2026-05-04", generation: 0)
        XCTAssertEqual(choose(&s, "b", "2026-05-04", measured: true, generation: 1), .today)
        XCTAssertEqual(s.effective(on: day("2026-05-04"))?.id, "b", "only fresh tokens are registered")
        XCTAssertTrue(s.owns("a", on: day("2026-05-04")))
        XCTAssertTrue(s.owns("b", on: day("2026-05-04")))
        XCTAssertFalse(s.owns("a", on: day("2026-05-05")))
        // Choosing again the same day replaces b but keeps a's measured day.
        XCTAssertEqual(choose(&s, "c", "2026-05-04", measured: false, generation: 1), .today)
        XCTAssertTrue(s.owns("a", on: day("2026-05-04")))
        XCTAssertFalse(s.owns("b", on: day("2026-05-04")))
        XCTAssertEqual(s.effective(on: day("2026-05-04"))?.id, "c")
    }

    func testPruneKeepsTheOwnerOfTheCutoffDay() {
        var s = schedule("a", from: "2026-05-01")
        _ = choose(&s, "b", "2026-05-04", measured: true)
        s.prune(before: day("2026-05-03"))
        XCTAssertEqual(s.entries.map(\.id), ["a", "b"])
        s.prune(before: day("2026-05-06"))
        XCTAssertEqual(s.entries.map(\.id), ["b"])
    }

    func testIDRule() {
        XCTAssertTrue(SelectionSchedule.isValidID("0f3a-77"))
        XCTAssertFalse(SelectionSchedule.isValidID("-x"))
        XCTAssertFalse(SelectionSchedule.isValidID("a.b"))
        XCTAssertFalse(SelectionSchedule.isValidID(""))
        XCTAssertFalse(SelectionSchedule.isValidID(String(repeating: "a", count: 65)))
    }
}
