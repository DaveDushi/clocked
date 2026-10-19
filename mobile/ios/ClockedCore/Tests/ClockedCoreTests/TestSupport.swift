import Foundation
import XCTest
@testable import ClockedCore

func tz(_ id: String) -> TimeZone { TimeZone(identifier: id)! }

func day(_ s: String) -> DayKey { DayKey(s)! }

/// A wall-clock instant in a zone, e.g. `at("2026-03-10 08:15", "Europe/Berlin")`.
func at(_ wall: String, _ zone: String = "UTC") -> Date {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = tz(zone)
    f.dateFormat = wall.count > 16 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm"
    return f.date(from: wall)!
}

/// A registration for `d` that starts at `start` (local wall time in `zone`).
func reg(_ sel: String, _ d: String, startingAt start: String? = nil, zone: String = "UTC") -> MonitorRegistration {
    MonitorRegistration(selectionID: sel, day: day(d), startsAt: start.map { at($0, zone) } ?? day(d).interval(in: tz(zone)).start)
}

func hit(_ r: MonitorRegistration, minutes: Int, _ when: Date, zone: String) -> MonitorRecord {
    MonitorRecord(kind: .threshold, activity: r.activityName, event: "m\(minutes)", at: when, timeZone: zone)
}

func start(_ r: MonitorRegistration, _ when: Date, zone: String) -> MonitorRecord {
    MonitorRecord(kind: .intervalStart, activity: r.activityName, event: nil, at: when, timeZone: zone)
}

func schedule(_ id: String, from: String, generation: Int = 0) -> SelectionSchedule {
    var s = SelectionSchedule()
    s.choose(id: id, payload: Data([1]), isEmpty: false, today: day(from), todayHasMeasurements: false, authGeneration: generation)
    return s
}

func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("clocked-tests-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    private let prefix: String
    init(_ prefix: String = "id") { self.prefix = prefix }
    func next() -> String {
        lock.lock(); defer { lock.unlock() }
        n += 1
        return "\(prefix)\(n)"
    }
}

final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ value: Date) { self.value = value }
    var now: Date { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ d: Date) { lock.lock(); value = d; lock.unlock() }
}

final class MutableZone: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeZone
    init(_ id: String) { value = TimeZone(identifier: id)! }
    var zone: TimeZone { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ id: String) { lock.lock(); value = TimeZone(identifier: id)!; lock.unlock() }
}

/// In-memory DeviceActivityCenter. It records overlapping registrations of
/// the same day, which reconciliation must never create.
final class FakeCenter: ActivityCenter, @unchecked Sendable {
    struct Live { let registration: MonitorRegistration; let interval: DateInterval; let timeZone: String; let payload: Data }
    struct Rejected: Error, CustomStringConvertible { var description: String { "excessiveActivities" } }

    private let lock = NSLock()
    private var live: [String: Live] = [:]
    private(set) var overlaps = 0
    private(set) var startCount = 0
    var limit: Int?

    func activeNames() -> [String] { lock.withLock { Array(live.keys) } }

    func stop(_ names: [String]) { lock.withLock { for n in names { live[n] = nil } } }

    func start(_ registration: MonitorRegistration, interval: DateInterval, timeZone: TimeZone, payload: Data) throws {
        try lock.withLock {
            if let limit, live.count >= limit { throw Rejected() }
            if live.values.contains(where: { $0.registration.day == registration.day }) { overlaps += 1 }
            live[registration.activityName] = Live(registration: registration, interval: interval, timeZone: timeZone.identifier, payload: payload)
            startCount += 1
        }
    }

    /// What Screen Time revocation does: all monitoring disappears.
    func clear() { lock.withLock { live.removeAll() } }

    var registrations: [Live] { lock.withLock { live.values.sorted { $0.registration.day < $1.registration.day } } }

    func registration(for d: DayKey) -> MonitorRegistration? {
        lock.withLock { live.values.first { $0.registration.day == d }?.registration }
    }
}

/// Scripted transport that records every request.
final class FakeTransport: UsageTransport, @unchecked Sendable {
    enum Reply {
        case status(Int, String)
        case acceptAll
        case acceptFirst(Int)
        case offline
        /// The server stores the batch but the reply is lost.
        case commitThenLose
    }

    private let lock = NSLock()
    private var replies: [Reply]
    private(set) var requests: [(url: URL, bearer: String, body: UsageRequestBody, raw: Data)] = []

    init(_ replies: [Reply] = []) { self.replies = replies }

    func post(_ url: URL, bearer: String, json: Data) async throws -> HTTPResult {
        let body = (try? JSONDecoder().decode(UsageRequestBody.self, from: json)) ?? UsageRequestBody(snapshots: [])
        let reply: Reply = lock.withLock {
            requests.append((url, bearer, body, json))
            return replies.isEmpty ? .acceptAll : replies.removeFirst()
        }
        switch reply {
        case .offline, .commitThenLose: throw URLError(.networkConnectionLost)
        case let .status(code, text): return HTTPResult(status: code, body: Data(text.utf8))
        case .acceptAll: return Self.accept(body.snapshots.map(\.id))
        case let .acceptFirst(n): return Self.accept(body.snapshots.prefix(n).map(\.id))
        }
    }

    static func accept(_ ids: [String]) -> HTTPResult {
        let json = try! JSONSerialization.data(withJSONObject: ["accepted": ids])
        return HTTPResult(status: ids.isEmpty ? 409 : 200, body: json)
    }
}

/// Holds each request until the test releases it, to interleave other work
/// while an upload is in flight.
final class GatedTransport: UsageTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [CheckedContinuation<HTTPResult, Error>] = []
    private(set) var requests: [(bearer: String, body: UsageRequestBody)] = []

    func post(_ url: URL, bearer: String, json: Data) async throws -> HTTPResult {
        let body = try JSONDecoder().decode(UsageRequestBody.self, from: json)
        return try await withCheckedThrowingContinuation { cont in
            lock.withLock {
                requests.append((bearer, body))
                waiting.append(cont)
            }
        }
    }

    func waitForRequests(_ n: Int) async {
        while lock.withLock({ requests.count }) < n { await Task.yield() }
    }

    func releaseAcceptingAll() {
        let (conts, ids) = lock.withLock { () -> ([CheckedContinuation<HTTPResult, Error>], [String]) in
            defer { waiting.removeAll() }
            return (waiting, requests.last?.body.snapshots.map(\.id) ?? [])
        }
        for c in conts { c.resume(returning: FakeTransport.accept(ids)) }
    }
}

/// Never answers; only cancellation ends a request.
final class HangingTransport: UsageTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var started = 0

    func post(_ url: URL, bearer: String, json: Data) async throws -> HTTPResult {
        lock.withLock { started += 1 }
        while !Task.isCancelled { try await Task.sleep(nanoseconds: 1_000_000) }
        throw CancellationError()
    }
}
