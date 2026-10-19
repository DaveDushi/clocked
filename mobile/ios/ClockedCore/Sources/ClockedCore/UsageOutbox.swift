import Foundation

/// One `/mobile/usage` snapshot as sent on the wire.
public struct UsageSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let deviceID: String
    public let platform: String
    public let day: String
    public let timezone: String
    public let selectionID: String
    public let durationSeconds: Int

    enum CodingKeys: String, CodingKey {
        case id
        case deviceID = "device_id"
        case platform
        case day
        case timezone
        case selectionID = "selection_id"
        case durationSeconds = "duration_seconds"
    }
}

public struct SnapshotKey: Hashable, Codable, Sendable {
    public let day: DayKey
    public let selectionID: String
}

/// Durable upload state for one connected account.
///
/// A new server origin or token is a new account: it gets a fresh device ID and
/// an empty outbox, and starts on a day no earlier account has uploaded, so
/// measurements already sent elsewhere never reach it.
public struct AccountState: Codable, Equatable, Sendable {
    public struct Pending: Codable, Equatable, Sendable {
        public let id: String
        public let key: SnapshotKey
        public let timezone: String
        public let seconds: Int
        public var attempts: Int
    }

    public let accountID: String
    public let origin: String
    public let deviceID: String
    public let startDay: DayKey
    /// Highest value the server acknowledged, per key.
    public private(set) var acknowledged: [SnapshotKey: Int] = [:]
    /// Zone first used for each key. Series IDs already include the zone, so
    /// this only guards the server rule that a bucket's zone never changes.
    public private(set) var pinnedZones: [SnapshotKey: String] = [:]
    public private(set) var pending: [Pending] = []
    public private(set) var rejectedCount = 0
    /// Series-days the server declined `maxAttempts` times. They are never
    /// queued again, so a permanent conflict cannot cause endless retries.
    public private(set) var abandoned: Set<SnapshotKey> = []
    public var failureCount = 0
    public var retryAfter: Date?
    public var lastSuccess: Date?
    public var lastProblem: SyncProblem?
    public var batchLimit = AccountState.maxBatch

    public static let maxBatch = 500
    /// Times the server may decline the same snapshot before it is dropped.
    public static let maxAttempts = 3

    public init(accountID: String, origin: String, deviceID: String, startDay: DayKey) {
        self.accountID = accountID
        self.origin = origin
        self.deviceID = deviceID
        self.startDay = startDay
    }

    /// Queues measurements that exceed everything already sent or queued for
    /// the same key. Values only grow, so retries and recomputation never
    /// subtract or double count. Each key keeps only its highest queued value:
    /// the server keeps the maximum, so a larger value supersedes a smaller
    /// one even if the smaller one was committed without an acknowledgement.
    public mutating func enqueue(_ measurements: [DayMeasurement], makeID: () -> String) {
        for m in measurements where m.day >= startDay && m.seconds > 0 {
            let key = SnapshotKey(day: m.day, selectionID: m.seriesID)
            // Never queue an ID the server is known to reject.
            guard MeasurementSeries.isServerValid(m.seriesID), !abandoned.contains(key) else { continue }
            let highest = max(acknowledged[key] ?? 0, pending.filter { $0.key == key }.map(\.seconds).max() ?? 0)
            guard m.seconds > highest else { continue }
            let zone = pinnedZones[key] ?? m.timeZone
            pinnedZones[key] = zone
            pending.removeAll { $0.key == key }
            pending.append(Pending(id: makeID(), key: key, timezone: zone, seconds: m.seconds, attempts: 0))
        }
    }

    /// The newest value for each key, oldest days first.
    public func nextBatch() -> [UsageSnapshot] {
        var best: [SnapshotKey: Pending] = [:]
        for p in pending where !abandoned.contains(p.key) && (best[p.key]?.seconds ?? -1) < p.seconds { best[p.key] = p }
        return best.values
            .sorted { ($0.key.day, $0.key.selectionID) < ($1.key.day, $1.key.selectionID) }
            .prefix(max(1, min(batchLimit, Self.maxBatch)))
            .map {
                UsageSnapshot(id: $0.id, deviceID: deviceID, platform: "ios", day: $0.key.day.description,
                              timezone: $0.timezone, selectionID: $0.key.selectionID, durationSeconds: $0.seconds)
            }
    }

    /// Applies a server reply. Only IDs listed as accepted are acknowledged.
    /// Sent snapshots the server declined count an attempt and are dropped
    /// after `maxAttempts` so one bad value cannot block the queue.
    public mutating func apply(sent: [UsageSnapshot], accepted: Set<String>) {
        let sentIDs = Set(sent.map(\.id))
        for p in pending where accepted.contains(p.id) && sentIDs.contains(p.id) {
            acknowledged[p.key] = max(acknowledged[p.key] ?? 0, p.seconds)
        }
        var kept: [Pending] = []
        for var p in pending {
            if accepted.contains(p.id) && sentIDs.contains(p.id) { continue }
            if p.seconds <= (acknowledged[p.key] ?? 0) { continue }
            if sentIDs.contains(p.id) {
                p.attempts += 1
                if p.attempts >= Self.maxAttempts {
                    rejectedCount += 1
                    abandoned.insert(p.key)
                    continue
                }
            }
            kept.append(p)
        }
        // Smaller values queued earlier for an abandoned key go with it.
        pending = kept.filter { !abandoned.contains($0.key) }
    }

    /// The latest day this account has had acknowledged.
    public var lastAcknowledgedDay: DayKey? { acknowledged.keys.map(\.day).max() }

    /// Forgets bookkeeping for days the ledger no longer produces. Pending
    /// snapshots are never pruned by age: they stay until the server accepts
    /// or permanently declines them, however long the phone is offline.
    public mutating func prune(before day: DayKey) {
        let waiting = Set(pending.map(\.key))
        acknowledged = acknowledged.filter { $0.key.day >= day }
        pinnedZones = pinnedZones.filter { $0.key.day >= day || waiting.contains($0.key) }
        abandoned = abandoned.filter { $0.day >= day }
    }

    /// The first day a newly connected account may receive: the day after
    /// the last day reserved by any earlier account, or today.
    public static func startDay(today: DayKey, reservedThrough: DayKey?) -> DayKey {
        guard let last = reservedThrough, last >= today else { return today }
        return last.adding(days: 1)
    }

    /// Latest day this account has queued, sent, or had acknowledged.
    public var lastClaimedDay: DayKey? {
        (Array(acknowledged.keys.map(\.day)) + pending.map(\.key.day)).max()
    }

    // Dictionaries with struct keys encode as flat arrays; keep the file readable.
    enum CodingKeys: String, CodingKey {
        case accountID, origin, deviceID, startDay, acknowledged, pinnedZones, pending, rejectedCount, abandoned,
             failureCount, retryAfter, lastSuccess, lastProblem, batchLimit
    }

    struct KeyedInt: Codable { let key: SnapshotKey; let value: Int }
    struct KeyedString: Codable { let key: SnapshotKey; let value: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accountID = try c.decode(String.self, forKey: .accountID)
        origin = try c.decode(String.self, forKey: .origin)
        deviceID = try c.decode(String.self, forKey: .deviceID)
        startDay = try c.decode(DayKey.self, forKey: .startDay)
        acknowledged = Dictionary(try c.decode([KeyedInt].self, forKey: .acknowledged).map { ($0.key, $0.value) }, uniquingKeysWith: max)
        pinnedZones = Dictionary(try c.decode([KeyedString].self, forKey: .pinnedZones).map { ($0.key, $0.value) }, uniquingKeysWith: { a, _ in a })
        pending = try c.decode([Pending].self, forKey: .pending)
        rejectedCount = try c.decode(Int.self, forKey: .rejectedCount)
        abandoned = Set(try c.decodeIfPresent([SnapshotKey].self, forKey: .abandoned) ?? [])
        failureCount = try c.decode(Int.self, forKey: .failureCount)
        retryAfter = try c.decodeIfPresent(Date.self, forKey: .retryAfter)
        lastSuccess = try c.decodeIfPresent(Date.self, forKey: .lastSuccess)
        lastProblem = try c.decodeIfPresent(SyncProblem.self, forKey: .lastProblem)
        batchLimit = try c.decode(Int.self, forKey: .batchLimit)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accountID, forKey: .accountID)
        try c.encode(origin, forKey: .origin)
        try c.encode(deviceID, forKey: .deviceID)
        try c.encode(startDay, forKey: .startDay)
        try c.encode(acknowledged.map { KeyedInt(key: $0.key, value: $0.value) }.sorted { $0.key.day < $1.key.day }, forKey: .acknowledged)
        try c.encode(pinnedZones.map { KeyedString(key: $0.key, value: $0.value) }.sorted { $0.key.day < $1.key.day }, forKey: .pinnedZones)
        try c.encode(pending, forKey: .pending)
        try c.encode(rejectedCount, forKey: .rejectedCount)
        try c.encode(abandoned.sorted { ($0.day, $0.selectionID) < ($1.day, $1.selectionID) }, forKey: .abandoned)
        try c.encode(failureCount, forKey: .failureCount)
        try c.encodeIfPresent(retryAfter, forKey: .retryAfter)
        try c.encodeIfPresent(lastSuccess, forKey: .lastSuccess)
        try c.encodeIfPresent(lastProblem, forKey: .lastProblem)
        try c.encode(batchLimit, forKey: .batchLimit)
    }
}
