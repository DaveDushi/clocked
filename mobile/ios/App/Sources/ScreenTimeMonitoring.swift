import ClockedCore
import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

/// Bridges ClockedCore's reconciliation to Screen Time.
enum ScreenTimeMonitoring {
    /// Fails closed: anything other than `.approved` stops monitoring.
    /// `.approvedWithDataAccess` (iOS 26.4) needs an entitlement this app does
    /// not have, so it cannot occur here.
    static var authorization: ScreenTimeAuthorization {
        let status = AuthorizationCenter.shared.authorizationStatus
        if status == .approved { return .approved }
        if status == .notDetermined { return .notDetermined }
        return .denied
    }

    static func events(for selection: FamilyActivitySelection, ladder: MilestoneLadder = .standard)
        -> [DeviceActivityEvent.Name: DeviceActivityEvent]
    {
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
        for minutes in ladder.minutes {
            events[DeviceActivityEvent.Name(ladder.eventName(minutes: minutes))] = DeviceActivityEvent(
                applications: selection.applicationTokens,
                categories: selection.categoryTokens,
                webDomains: selection.webDomainTokens,
                threshold: DateComponents(hour: minutes / 60, minute: minutes % 60),
                // Never count usage from before the registration starts: that
                // is what makes its start a safe lower bound for the window.
                includesPastActivity: false
            )
        }
        return events
    }

    static func decode(_ payload: Data) -> FamilyActivitySelection? {
        try? JSONDecoder().decode(FamilyActivitySelection.self, from: payload)
    }

    static func encode(_ selection: FamilyActivitySelection) throws -> Data {
        try JSONEncoder().encode(selection)
    }

    static func isEmpty(_ selection: FamilyActivitySelection) -> Bool {
        selection.applicationTokens.isEmpty && selection.categoryTokens.isEmpty && selection.webDomainTokens.isEmpty
    }
}

/// DeviceActivityCenter as ClockedCore's `ActivityCenter`. Every registration
/// is a one-shot schedule for a single day, so a callback's activity name says
/// which day it measured.
struct SystemActivityCenter: ActivityCenter, @unchecked Sendable {
    struct UnreadableSelection: Error {}

    private let center = DeviceActivityCenter()

    func activeNames() -> [String] {
        center.activities.map(\.rawValue)
    }

    func stop(_ names: [String]) {
        center.stopMonitoring(names.map { DeviceActivityName($0) })
    }

    func start(_ registration: MonitorRegistration, interval: DateInterval, timeZone: TimeZone, payload: Data) throws {
        guard let selection = ScreenTimeMonitoring.decode(payload) else { throw UnreadableSelection() }
        let schedule = DeviceActivitySchedule(
            intervalStart: Self.components(interval.start, timeZone),
            intervalEnd: Self.components(interval.end, timeZone),
            repeats: false
        )
        try center.startMonitoring(
            DeviceActivityName(registration.activityName), during: schedule,
            events: ScreenTimeMonitoring.events(for: selection)
        )
    }

    /// Full calendar date and time in the registration's zone, so the
    /// schedule matches exactly one day.
    static func components(_ date: Date, _ timeZone: TimeZone) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        c.calendar = calendar
        c.timeZone = timeZone
        return c
    }
}
