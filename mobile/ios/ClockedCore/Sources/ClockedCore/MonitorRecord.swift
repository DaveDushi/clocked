import Foundation

/// A fact observed by the DeviceActivity monitor extension. It carries no app
/// identities: only the activity name, the threshold name, a timestamp, and the
/// device time zone at the time of the callback.
public struct MonitorRecord: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// `intervalDidStart`. Screen Time computes a whole interval in the
        /// time zone in effect when the interval started.
        case intervalStart
        /// `eventDidReachThreshold`.
        case threshold
    }

    public let kind: Kind
    public let activity: String
    public let event: String?
    public let at: Date
    public let timeZone: String

    public init(kind: Kind, activity: String, event: String?, at: Date, timeZone: String) {
        self.kind = kind
        self.activity = activity
        self.event = event
        self.at = at
        self.timeZone = timeZone
    }

    /// Registrations are day-specific and one-shot, so the activity and event
    /// names identify one callback. Duplicate deliveries map to the same file
    /// and only the first is kept.
    public var fileName: String? {
        guard TimeZone(identifier: timeZone) != nil,
              Self.isSafeComponent(activity), event.map(Self.isSafeComponent) ?? true
        else { return nil }
        switch kind {
        case .intervalStart: return "s_\(activity).json"
        case .threshold:
            guard let event else { return nil }
            return "t_\(activity)_\(event).json"
        }
    }

    static func isSafeComponent(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 120 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
    }
}

/// Append-only directory of monitor records, written by the extension and
/// drained by the app. One small file per record keeps writes atomic without
/// cross-process locks.
public struct MonitorRecordStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// Returns false when a record for the same callback already exists.
    @discardableResult
    public func append(_ record: MonitorRecord) throws -> Bool {
        guard let name = record.fileName else { throw CocoaError(.fileWriteInvalidFileName) }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(name)
        if fm.fileExists(atPath: target.path) { return false }
        let temp = directory.appendingPathComponent(".tmp-\(UUID().uuidString)")
        try JSONCoding.encoder.encode(record).write(to: temp, options: DurableFile.writeOptions)
        do {
            try fm.moveItem(at: temp, to: target)
        } catch {
            try? fm.removeItem(at: temp)
            if fm.fileExists(atPath: target.path) { return false }
            throw error
        }
        return true
    }

    /// Readable records plus every file that was examined, including corrupt
    /// ones, so the caller can delete them after durably ingesting the records.
    public func readAll() -> (records: [MonitorRecord], files: [URL]) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return ([], []) }
        var records: [MonitorRecord] = []
        var files: [URL] = []
        for name in names.sorted() where name.hasSuffix(".json") {
            let url = directory.appendingPathComponent(name)
            files.append(url)
            if let data = try? Data(contentsOf: url), let r = try? JSONCoding.decoder.decode(MonitorRecord.self, from: data) {
                records.append(r)
            }
        }
        return (records, files)
    }

    public func remove(_ files: [URL]) {
        for url in files { try? FileManager.default.removeItem(at: url) }
    }
}

enum JSONCoding {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }()
}

enum DurableFile {
    #if os(iOS)
    // Monitor callbacks can run while the phone is locked; files must stay
    // writable after the first unlock following a reboot.
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUnlock]
    #else
    static let writeOptions: Data.WritingOptions = [.atomic]
    #endif
}

/// Atomic JSON persistence for a single value.
public struct JSONFileStore<Value: Codable>: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func load() throws -> Value? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONCoding.decoder.decode(Value.self, from: Data(contentsOf: url))
    }

    public func save(_ value: Value) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONCoding.encoder.encode(value).write(to: url, options: DurableFile.writeOptions)
    }

    public func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}
