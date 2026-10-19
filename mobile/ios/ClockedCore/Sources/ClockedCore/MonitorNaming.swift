import Foundation

/// The cumulative-usage thresholds registered with DeviceActivity for one
/// monitored day. A callback for threshold `m` means Screen Time counted at
/// least `m` minutes of combined use of the selected apps inside that day's
/// registration, so measurements are rounded down to a step.
public struct MilestoneLadder: Equatable, Sendable {
    public let stepMinutes: Int
    public let maxMinutes: Int

    public static let standard = MilestoneLadder(stepMinutes: 15, maxMinutes: 12 * 60)

    public init(stepMinutes: Int, maxMinutes: Int) {
        precondition(stepMinutes > 0 && maxMinutes >= stepMinutes)
        self.stepMinutes = stepMinutes
        self.maxMinutes = maxMinutes
    }

    public var minutes: [Int] { Array(stride(from: stepMinutes, through: maxMinutes, by: stepMinutes)) }

    public func eventName(minutes: Int) -> String { "m\(minutes)" }

    public func minutes(fromEventName name: String) -> Int? {
        guard name.hasPrefix("m"), let m = Int(name.dropFirst()), m > 0, m <= maxMinutes,
              m % stepMinutes == 0
        else { return nil }
        return m
    }
}

/// One DeviceActivity registration covering exactly one local day.
///
/// Each registration is a non-repeating schedule for its own day, and its name
/// carries the selection, the day, and the instant monitoring starts. A
/// callback therefore identifies the day it measured, however late it is
/// delivered, and callbacks from different registrations never mix.
public struct MonitorRegistration: Hashable, Codable, Sendable {
    public static let prefix = "clk2"

    public let selectionID: String
    public let day: DayKey
    /// Whole seconds since 1970 when this registration's interval begins. Use
    /// before it is not counted because events use `includesPastActivity: false`.
    public let startsAt: Int

    public init(selectionID: String, day: DayKey, startsAt: Date) {
        self.selectionID = selectionID
        self.day = day
        self.startsAt = Int(startsAt.timeIntervalSince1970.rounded(.up))
    }

    public init?(activityName: String) {
        let parts = activityName.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == Self.prefix, SelectionSchedule.isValidID(String(parts[1])),
              let started = Int(parts[2]), started > 0, parts[3].count == 8,
              let y = Int(parts[3].prefix(4)), let m = Int(parts[3].dropFirst(4).prefix(2)), let d = Int(parts[3].suffix(2)),
              let day = DayKey(year: y, month: m, day: d)
        else { return nil }
        selectionID = String(parts[1])
        startsAt = started
        self.day = day
    }

    public var activityName: String {
        "\(Self.prefix).\(selectionID).\(startsAt).\(String(format: "%04d%02d%02d", day.year, day.month, day.day))"
    }

    public var startDate: Date { Date(timeIntervalSince1970: TimeInterval(startsAt)) }
}
