import Foundation

/// A per-day lower bound on combined Screen Time use of one selection,
/// measured in one time zone.
public struct DayMeasurement: Equatable, Sendable {
    public let day: DayKey
    public let selectionID: String
    public let timeZone: String
    /// Multiple of the ladder step, never more than the window it covers.
    public let seconds: Int
    /// Callbacks ignored because they arrived sooner than their threshold could
    /// have been reached inside the registration's window.
    public let implausibleCallbacks: Int
    /// Callbacks ignored because they arrived long after their day ended.
    public let quarantinedCallbacks: Int

    public init(day: DayKey, selectionID: String, timeZone: String, seconds: Int,
                implausibleCallbacks: Int = 0, quarantinedCallbacks: Int = 0) {
        self.day = day
        self.selectionID = selectionID
        self.timeZone = timeZone
        self.seconds = seconds
        self.implausibleCallbacks = implausibleCallbacks
        self.quarantinedCallbacks = quarantinedCallbacks
    }

    /// The `selection_id` sent to the server. It combines the local selection
    /// with the measurement time zone, so a day measured partly in two zones
    /// (travel) becomes two series instead of one bucket whose zone changes,
    /// which the server would reject. The dashboard keeps the larger series
    /// for such a day, so travel days can show less than was used.
    public var seriesID: String { MeasurementSeries.id(selectionID: selectionID, timeZone: timeZone) }
}

public enum MeasurementSeries {
    /// `<lowercase UUID>-z<8 hex>`. The base must be a UUID minted by
    /// `UsageEngine`; the server accepts only a UUID or hex base with this
    /// optional suffix.
    public static func id(selectionID: String, timeZone: String) -> String {
        "\(selectionID)-z\(zoneTag(timeZone))"
    }

    /// Mirrors the server's `selection_id` rule for the format this client sends.
    public static func isServerValid(_ id: String) -> Bool {
        id.range(of: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-z[0-9a-f]{8}$", options: .regularExpression) != nil
    }

    public static func isUUID(_ id: String) -> Bool {
        id.range(of: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }

    /// Stable FNV-1a hash of the zone identifier, so the wire ID is short,
    /// deterministic, and carries no readable location.
    public static func zoneTag(_ timeZone: String) -> String {
        var hash: UInt32 = 0x811C_9DC5
        for byte in timeZone.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        return String(format: "%08x", hash)
    }
}

/// Device-level store of monitor callbacks and the rules that turn them into
/// per-day measurements. It holds no app identities and no account data.
///
/// Rules:
/// - Every registration covers one named local day and never repeats, so a
///   callback's day comes from its activity name, not from when it arrived.
/// - A callback for threshold `m` shows at least `m` minutes of combined use
///   inside its registration's window: from the later of local midnight and
///   the registration start, to the end of that day.
/// - A callback that arrives less than `m` minutes after its window began is
///   impossible and is ignored. This rejects the early firing seen on iOS 26
///   (Apple feedback FB18061981). An early callback that still fits inside the
///   elapsed time cannot be detected.
/// - A callback that arrives more than `lateGrace` after its day ended is
///   quarantined rather than trusted.
/// - Several registrations of one day (after a time zone change or a
///   re-registration) may have measured the same minutes, so their results
///   are never added: the day keeps the largest single value.
/// - Values are grouped by day, selection, and the zone the registration was
///   made in. Only selections that own a day (see `SelectionSchedule.owns`)
///   are measured for that day.
/// - Duplicate and out-of-order callbacks are harmless: the earliest delivery
///   of each callback is kept and results are recomputed from scratch.
public struct MeasurementLedger: Codable, Equatable, Sendable {
    struct Hit: Codable, Equatable, Sendable {
        let activity: String
        let event: String
        var at: Date
        let timeZone: String
    }

    /// Activity name to the zone reported by its `intervalDidStart`.
    var intervalZones: [String: String] = [:]
    /// Keyed by record file name, which identifies one callback.
    var hits: [String: Hit] = [:]

    /// Slack for clock granularity between registration and callback.
    public static let tolerance: TimeInterval = 5
    /// How long after its day ends a callback is still accepted.
    public static let lateGrace: TimeInterval = 6 * 3600

    public init() {}

    public var isEmpty: Bool { hits.isEmpty && intervalZones.isEmpty }

    public mutating func ingest(_ records: [MonitorRecord]) {
        for r in records {
            guard TimeZone(identifier: r.timeZone) != nil, MonitorRegistration(activityName: r.activity) != nil,
                  let key = r.fileName
            else { continue }
            switch r.kind {
            case .intervalStart:
                if intervalZones[r.activity] == nil { intervalZones[r.activity] = r.timeZone }
            case .threshold:
                guard let event = r.event else { continue }
                if var existing = hits[key] {
                    existing.at = min(existing.at, r.at)
                    hits[key] = existing
                } else {
                    hits[key] = Hit(activity: r.activity, event: event, at: r.at, timeZone: r.timeZone)
                }
            }
        }
    }

    /// The latest day any stored callback measured.
    public var latestMeasuredDay: DayKey? {
        hits.values.compactMap { MonitorRegistration(activityName: $0.activity)?.day }.max()
    }

    /// Forgets callbacks for registrations of days before `day`.
    public mutating func prune(before day: DayKey) {
        func keep(_ activity: String) -> Bool { (MonitorRegistration(activityName: activity)?.day ?? day) >= day }
        hits = hits.filter { keep($0.value.activity) }
        intervalZones = intervalZones.filter { keep($0.key) }
    }

    /// - Parameter zones: the zone each registration was made in, from the
    ///   monitor registry. Falls back to the zone its `intervalDidStart` reported.
    public func measurements(schedule: SelectionSchedule, zones: [String: String], ladder: MilestoneLadder) -> [DayMeasurement] {
        struct Key: Hashable { let selectionID: String; let day: DayKey; let timeZone: String }
        var best: [Key: Int] = [:]
        var early: [Key: Int] = [:]
        var late: [Key: Int] = [:]
        let step = ladder.stepMinutes * 60

        for hit in hits.values {
            guard let reg = MonitorRegistration(activityName: hit.activity),
                  let minutes = ladder.minutes(fromEventName: hit.event),
                  let tz = TimeZone(identifier: zones[hit.activity] ?? intervalZones[hit.activity] ?? hit.timeZone)
            else { continue }
            let key = Key(selectionID: reg.selectionID, day: reg.day, timeZone: tz.identifier)
            let day = reg.day.interval(in: tz)
            let windowStart = max(day.start, reg.startDate)
            if hit.at.addingTimeInterval(Self.tolerance) < windowStart.addingTimeInterval(TimeInterval(minutes * 60)) {
                early[key, default: 0] += 1
                continue
            }
            if hit.at > day.end.addingTimeInterval(Self.lateGrace) {
                late[key, default: 0] += 1
                continue
            }
            let span = max(0, Int(day.end.timeIntervalSince(windowStart)))
            best[key] = max(best[key] ?? 0, min(minutes * 60, span / step * step))
        }

        var result: [DayMeasurement] = []
        for k in Set(best.keys).union(early.keys).union(late.keys) {
            guard schedule.owns(k.selectionID, on: k.day) else { continue }
            result.append(DayMeasurement(
                day: k.day, selectionID: k.selectionID, timeZone: k.timeZone, seconds: best[k] ?? 0,
                implausibleCallbacks: early[k] ?? 0, quarantinedCallbacks: late[k] ?? 0
            ))
        }
        return result.sorted { ($0.day, $0.selectionID, $0.timeZone) < ($1.day, $1.selectionID, $1.timeZone) }
    }
}
