import Foundation

/// Which work-app selection measures each local day.
///
/// Exactly one selection owns a day. A changed selection normally takes effect
/// the next local day, so usage already measured today is never measured
/// again under a second selection and past days keep their original label.
/// The opaque payload (an encoded `FamilyActivitySelection`) never leaves the
/// device.
public struct SelectionSchedule: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let id: String
        public let effectiveFrom: DayKey
        public let payload: Data
        public let isEmpty: Bool
        /// Authorization generation the tokens were picked under. Apple voids
        /// selection tokens when Screen Time authorization is revoked, so an
        /// entry from an older generation keeps its ID for history but can no
        /// longer be registered.
        public let authGeneration: Int
        /// Set when a selection with voided tokens is replaced on a day it
        /// already measured. It keeps owning that day for accounting, next to
        /// the replacement, so renewing tokens never erases measured usage.
        public var retainedThrough: DayKey?

        public init(id: String, effectiveFrom: DayKey, payload: Data, isEmpty: Bool, authGeneration: Int) {
            self.id = id
            self.effectiveFrom = effectiveFrom
            self.payload = payload
            self.isEmpty = isEmpty
            self.authGeneration = authGeneration
        }
    }

    public private(set) var entries: [Entry] = []

    public init() {}

    /// Matches the server's identifier rule: ASCII letters, digits, and `-`,
    /// starting with a letter or digit. The engine always mints lowercase UUIDs.
    public static func isValidID(_ id: String) -> Bool {
        guard (1...64).contains(id.count), let first = id.first, first.isASCII, first.isLetter || first.isNumber
        else { return false }
        return id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    /// The selection registered for `day`.
    public func effective(on day: DayKey) -> Entry? {
        entries.last { $0.effectiveFrom <= day }
    }

    /// Whether measurements of `id` count for `day`: the selection registered
    /// for it, or one with voided tokens that measured it before being replaced.
    /// Two owners of one day are reported as separate series; the phone and the
    /// server keep the larger, never the sum.
    public func owns(_ id: String, on day: DayKey) -> Bool {
        effective(on: day)?.id == id
            || entries.contains { $0.id == id && $0.effectiveFrom <= day && ($0.retainedThrough.map { $0 >= day } ?? false) }
    }

    /// A selection chosen today that starts tomorrow.
    public func pending(after today: DayKey) -> Entry? {
        entries.last { $0.effectiveFrom > today }
    }

    public enum Placement: Equatable, Sendable {
        case today
        case tomorrow
    }

    /// Records a new selection. `todayHasMeasurements` reports whether the
    /// selection currently owning today already has recorded usage today; the
    /// caller must ingest pending monitor records first. The new selection
    /// owns today when nothing was attributed to the current owner today, or
    /// when the current owner is empty or its tokens were voided. Otherwise it
    /// starts tomorrow.
    @discardableResult
    public mutating func choose(
        id: String, payload: Data, isEmpty: Bool, today: DayKey, todayHasMeasurements: Bool, authGeneration: Int
    ) -> Placement {
        precondition(Self.isValidID(id))
        entries.removeAll { $0.effectiveFrom > today }
        let current = effective(on: today)
        let voided = current.map { $0.authGeneration != authGeneration } ?? false
        let ownsToday = current == nil || current!.isEmpty || voided || !todayHasMeasurements
        let entry = { (from: DayKey) in
            Entry(id: id, effectiveFrom: from, payload: payload, isEmpty: isEmpty, authGeneration: authGeneration)
        }
        if voided && todayHasMeasurements, let index = entries.lastIndex(where: { $0.id == current!.id }) {
            // Keep the measured day; only the tokens are replaced.
            entries[index].retainedThrough = today
            entries.append(entry(today))
            return .today
        }
        if ownsToday {
            // A retained entry still owns measured usage today; never drop it.
            entries.removeAll { $0.effectiveFrom == today && $0.retainedThrough == nil }
            entries.append(entry(today))
            return .today
        }
        entries.append(entry(today.adding(days: 1)))
        return .tomorrow
    }

    /// Drops entries that no longer own any day on or after `day`.
    public mutating func prune(before day: DayKey) {
        guard let keep = effective(on: day) else { return }
        entries.removeAll { $0.effectiveFrom < keep.effectiveFrom }
    }
}
