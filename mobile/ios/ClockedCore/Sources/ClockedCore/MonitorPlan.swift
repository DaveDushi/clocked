import Foundation

/// The system's DeviceActivityCenter, reduced to what reconciliation needs.
/// The app adapts the real center; tests use a fake. All calls are
/// synchronous so a whole reconciliation runs inside one actor turn.
public protocol ActivityCenter: Sendable {
    /// Activity names the system currently monitors for this app.
    func activeNames() -> [String]
    func stop(_ names: [String])
    /// Registers a non-repeating schedule over `interval`, expressed in
    /// `timeZone`, for the selection encoded in `payload`.
    func start(_ registration: MonitorRegistration, interval: DateInterval, timeZone: TimeZone, payload: Data) throws
}

public enum ScreenTimeAuthorization: Equatable, Sendable {
    case approved
    case denied
    case notDetermined
}

/// Registrations the app made, with the zone each was made in.
public struct MonitorRegistry: Codable, Equatable, Sendable {
    /// Every registration still relevant for accounting, to its zone.
    public private(set) var zones: [String: String] = [:]
    /// Registrations the app believes the system is monitoring.
    public private(set) var live: Set<String> = []

    public init() {}

    mutating func started(_ name: String, timeZone: String) {
        zones[name] = timeZone
        live.insert(name)
    }

    mutating func stopped(_ names: [String]) {
        for n in names { live.remove(n) }
    }

    mutating func forgetLive() {
        live.removeAll()
    }

    mutating func prune(before day: DayKey) {
        zones = zones.filter { (MonitorRegistration(activityName: $0.key)?.day ?? day) >= day }
        live = live.filter { (MonitorRegistration(activityName: $0)?.day ?? day) >= day }
    }
}

/// What reconciliation should change in DeviceActivityCenter.
public struct MonitorPlan: Equatable, Sendable {
    public struct Start: Equatable, Sendable {
        public let registration: MonitorRegistration
        public let interval: DateInterval
        public let timeZone: String
    }

    public var stop: [String] = []
    public var start: [Start] = []

    /// Days ahead (including today) that are registered at once. Each day is one
    /// activity with one event per ladder step; the system rejects too many
    /// activities, so this stays small. The app re-extends the horizon whenever
    /// it runs.
    public static let horizonDays = 7
    /// Screen Time rejects intervals shorter than 15 minutes.
    public static let minimumInterval: TimeInterval = 15 * 60

    /// - Parameters:
    ///   - active: activity names the system currently monitors.
    ///   - authGeneration: selections picked under another generation have
    ///     voided tokens and are not registered.
    ///
    /// Each day from today through the horizon is registered for the selection
    /// that owns it, as a one-shot interval from local midnight (or the next
    /// whole minute, for today) to 23:59. A registration made in another zone,
    /// or for a selection that no longer owns its day, is replaced. Yesterday's
    /// registration is left in place so late callbacks can still arrive; older
    /// ones are stopped. Without authorization everything stops.
    public static func make(
        active: [String], registry: MonitorRegistry, schedule: SelectionSchedule,
        now: Date, timeZone: TimeZone, authorized: Bool, authGeneration: Int
    ) -> MonitorPlan {
        var plan = MonitorPlan()
        let ours = active.compactMap { name in MonitorRegistration(activityName: name).map { (name, $0) } }
        guard authorized else {
            plan.stop = ours.map(\.0).sorted()
            return plan
        }
        let today = DayKey.containing(now, in: timeZone)
        var keep: Set<String> = Set(ours.filter { $0.1.day == today.adding(days: -1) }.map(\.0))

        for offset in 0..<horizonDays {
            let day = today.adding(days: offset)
            guard let owner = schedule.effective(on: day), !owner.isEmpty, owner.authGeneration == authGeneration
            else { continue }
            // A matching registration already running is kept however little
            // of the day remains; the minimum length only applies to new ones.
            let current = ours.filter {
                $0.1.day == day && $0.1.selectionID == owner.id && registry.zones[$0.0] == timeZone.identifier
            }
            if let newest = current.max(by: { $0.1.startsAt < $1.1.startsAt }) {
                keep.insert(newest.0)
                continue
            }

            let whole = day.interval(in: timeZone)
            let start = offset == 0 ? max(whole.start, nextMinute(now)) : whole.start
            let end = whole.end.addingTimeInterval(-60)
            guard end.timeIntervalSince(start) >= minimumInterval else { continue }
            var reg = MonitorRegistration(selectionID: owner.id, day: day, startsAt: start)
            while active.contains(reg.activityName) || registry.zones[reg.activityName] != nil {
                reg = MonitorRegistration(selectionID: owner.id, day: day, startsAt: reg.startDate.addingTimeInterval(60))
            }
            plan.start.append(Start(registration: reg, interval: DateInterval(start: reg.startDate, end: end), timeZone: timeZone.identifier))
        }
        plan.stop = ours.map(\.0).filter { !keep.contains($0) }.sorted()
        return plan
    }

    /// True when registrations the app made for today or later have vanished
    /// from the system. Revoking Screen Time access clears an app's monitoring
    /// and voids its tokens, and that can happen while the app is not running,
    /// so this is treated as a revocation.
    public static func registrationsVanished(active: [String], registry: MonitorRegistry, now: Date, timeZone: TimeZone) -> Bool {
        let today = DayKey.containing(now, in: timeZone)
        let present = Set(active)
        return registry.live.contains { name in
            guard !present.contains(name), let reg = MonitorRegistration(activityName: name) else { return false }
            if reg.day > today { return true }
            // Today's one-shot interval may legitimately end at 23:59.
            return reg.day == today && now < reg.day.interval(in: timeZone).end.addingTimeInterval(-60)
        }
    }

    static func nextMinute(_ date: Date) -> Date {
        let t = date.timeIntervalSince1970
        return Date(timeIntervalSince1970: (t / 60).rounded(.up) * 60)
    }
}
