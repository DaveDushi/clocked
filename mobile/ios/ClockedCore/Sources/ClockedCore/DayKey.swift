import Foundation

/// A calendar date (`YYYY-MM-DD`) with no time zone attached. Time zones are
/// applied only when converting to or from instants, so DST transitions and
/// zone changes never shift the key itself.
public struct DayKey: Hashable, Comparable, Codable, CustomStringConvertible, Sendable {
    public let year: Int
    public let month: Int
    public let day: Int

    public init?(year: Int, month: Int, day: Int) {
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = day
        guard (1...9999).contains(year), comps.isValidDate(in: DayKey.utcCalendar) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    public init?(_ string: String) {
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    /// The local calendar date of `date` in `timeZone`.
    public static func containing(_ date: Date, in timeZone: TimeZone) -> DayKey {
        let c = calendar(in: timeZone).dateComponents([.year, .month, .day], from: date)
        return DayKey(year: c.year!, month: c.month!, day: c.day!)!
    }

    public func adding(days: Int) -> DayKey {
        let cal = DayKey.utcCalendar
        let base = cal.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
        let moved = cal.date(byAdding: .day, value: days, to: base)!
        return DayKey.containing(moved, in: TimeZone(identifier: "UTC")!)
    }

    /// Whole days from `self` to `other` (positive when `other` is later).
    public func days(until other: DayKey) -> Int {
        let cal = DayKey.utcCalendar
        let a = cal.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
        let b = cal.date(from: DateComponents(year: other.year, month: other.month, day: other.day, hour: 12))!
        return cal.dateComponents([.day], from: a, to: b).day!
    }

    /// Local midnight to the next local midnight. Lengths are 23 or 25 hours on
    /// DST transition days. Zones that skip midnight start at the first valid instant.
    public func interval(in timeZone: TimeZone) -> DateInterval {
        let cal = DayKey.calendar(in: timeZone)
        let start = DayKey.startOfDay(self, cal)
        let end = DayKey.startOfDay(adding(days: 1), cal)
        return DateInterval(start: start, end: end)
    }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func < (lhs: DayKey, rhs: DayKey) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let key = DayKey(raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad day \(raw)"))
        }
        self = key
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(description)
    }

    static func calendar(in timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }

    private static let utcCalendar = calendar(in: TimeZone(identifier: "UTC")!)

    private static func startOfDay(_ key: DayKey, _ cal: Calendar) -> Date {
        // Noon always exists, so this avoids nil or shifted results for zones
        // whose DST transition happens at midnight.
        let noon = cal.date(from: DateComponents(year: key.year, month: key.month, day: key.day, hour: 12))!
        return cal.startOfDay(for: noon)
    }
}
