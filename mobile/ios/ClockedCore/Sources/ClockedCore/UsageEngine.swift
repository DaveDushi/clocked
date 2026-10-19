import Foundation

/// Everything the device knows independent of any account.
public struct DeviceState: Codable, Equatable, Sendable {
    public var ledger = MeasurementLedger()
    public var schedule = SelectionSchedule()
    public var registry = MonitorRegistry()
    /// Increments whenever Screen Time authorization is lost. Selections picked
    /// under an older generation have voided tokens.
    public var authGeneration = 0
    /// Authorization was approved the last time it was checked.
    public var wasAuthorized = false
    /// Latest day reserved by any account: the day it was disconnected or
    /// replaced, any later day it queued, and any later day with a measurement
    /// on the device at that moment. It never moves backwards, even when the
    /// clock does. A new account starts after it.
    public var reservedThrough: DayKey?
    /// Last day of the most recent registration horizon. If it passes while
    /// the app is not running, revocation in the meantime cannot be ruled out.
    public var horizonEnd: DayKey?

    public init() {}
}

/// Ties a token to the account it was saved for, so a token from a previous
/// connection can never upload under a newer one.
public struct SyncCredential: Sendable {
    public let accountID: String
    public let token: String

    public init(accountID: String, token: String) {
        self.accountID = accountID
        self.token = token
    }
}

public struct EngineStatus: Equatable, Sendable {
    public var today: DayKey
    /// Largest single-zone measurement today, the same rule the dashboard uses.
    public var todaySeconds: Int
    public var todayImplausibleCallbacks: Int
    public var todayQuarantinedCallbacks: Int
    public var currentSelectionID: String?
    public var currentSelectionIsEmpty: Bool
    /// Screen Time access was revoked after the current work apps were chosen.
    /// Their tokens no longer work; the user must choose again.
    public var needsReselection: Bool
    public var nextSelectionStarts: DayKey?
    /// Last day with a live registration. Nothing is measured after it until
    /// the app runs again and extends the horizon.
    public var monitoredThrough: DayKey?
    public var recentDays: [DayMeasurement]
    public var account: AccountSummary?
}

public struct AccountSummary: Equatable, Sendable {
    public var accountID: String
    public var origin: String
    public var startDay: DayKey
    public var pendingCount: Int
    public var rejectedCount: Int
    public var lastSuccess: Date?
    public var lastProblem: SyncProblem?
    public var retryAfter: Date?
}

public struct ReconcileResult: Equatable, Sendable {
    public var started: Int
    public var stopped: Int
    public var revocationDetected: Bool
    /// Description of the first start the system rejected, if any.
    public var failure: String?
}

/// Coordinates the ledger, selection schedule, monitoring registrations, and
/// account outbox. State is saved before every network request and after
/// every reply, so a process killed at any point resumes by resending the
/// same snapshot IDs.
public actor UsageEngine {
    /// Raw callbacks and per-day bookkeeping are kept this long. Unsent
    /// snapshots are kept until the server accepts or declines them.
    public static let retentionDays = 35

    private let deviceStore: JSONFileStore<DeviceState>
    private let accountStore: JSONFileStore<AccountState>
    private let records: MonitorRecordStore
    private let transport: UsageTransport
    private let ladder: MilestoneLadder
    private let clock: @Sendable () -> Date
    private let zone: @Sendable () -> TimeZone
    private let makeID: @Sendable () -> String
    private let makeSelectionID: @Sendable () -> String
    private let jitter: @Sendable () -> Double
    private var syncing = false

    public init(
        stateDirectory: URL,
        records: MonitorRecordStore,
        transport: UsageTransport,
        ladder: MilestoneLadder = .standard,
        clock: @escaping @Sendable () -> Date = { Date() },
        zone: @escaping @Sendable () -> TimeZone = { TimeZone.current },
        makeID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
        makeSelectionID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) }
    ) {
        deviceStore = JSONFileStore(url: stateDirectory.appendingPathComponent("device.json"))
        accountStore = JSONFileStore(url: stateDirectory.appendingPathComponent("account.json"))
        self.records = records
        self.transport = transport
        self.ladder = ladder
        self.clock = clock
        self.zone = zone
        self.makeID = makeID
        self.makeSelectionID = makeSelectionID
        self.jitter = jitter
    }

    private var today: DayKey { DayKey.containing(clock(), in: zone()) }

    private func loadDevice() throws -> DeviceState { try deviceStore.load() ?? DeviceState() }

    /// Moves monitor records into the ledger. Files are deleted only after the
    /// ledger is saved; re-ingesting a record is a no-op.
    @discardableResult
    public func ingest() throws -> DeviceState {
        var device = try loadDevice()
        let (found, files) = records.readAll()
        let cutoff = today.adding(days: -Self.retentionDays)
        device.ledger.ingest(found)
        device.ledger.prune(before: cutoff)
        device.schedule.prune(before: cutoff)
        device.registry.prune(before: cutoff)
        try deviceStore.save(device)
        records.remove(files)
        return device
    }

    private func measurements(_ device: DeviceState) -> [DayMeasurement] {
        device.ledger.measurements(schedule: device.schedule, zones: device.registry.zones, ladder: ladder)
    }

    // MARK: Selection

    /// Stores a new work-app selection. Returns when it starts counting.
    public func chooseSelection(payload: Data, isEmpty: Bool) throws -> SelectionSchedule.Placement {
        var device = try ingest()
        let day = today
        let measured = device.schedule.effective(on: day).map { owner in
            measurements(device).contains { $0.day == day && $0.selectionID == owner.id && $0.seconds > 0 }
        } ?? false
        let id = makeSelectionID()
        precondition(MeasurementSeries.isUUID(id), "selection IDs must be lowercase UUIDs")
        let placement = device.schedule.choose(
            id: id, payload: payload, isEmpty: isEmpty, today: day,
            todayHasMeasurements: measured, authGeneration: device.authGeneration
        )
        try deviceStore.save(device)
        return placement
    }

    public func schedule() throws -> SelectionSchedule { try loadDevice().schedule }

    // MARK: Monitoring

    /// Brings DeviceActivity registrations in line with authorization, the
    /// selection schedule, the time zone, and the horizon.
    ///
    /// The whole transaction (discovery, planning, system changes, and saving
    /// the registry) runs without suspending, so concurrent callers are
    /// serialized by the actor and never act on a stale plan.
    public func reconcileMonitoring(center: ActivityCenter, authorization: ScreenTimeAuthorization) throws -> ReconcileResult {
        var device = try ingest()
        let now = clock()
        let tz = zone()
        let active = center.activeNames()
        var revoked = false

        if authorization == .approved {
            if device.wasAuthorized,
               MonitorPlan.registrationsVanished(active: active, registry: device.registry, now: now, timeZone: tz) {
                revoked = true
            }
            // Every registration expired while the app was not running, so their
            // disappearance proves nothing either way. Access may have been
            // revoked and granted again in that gap, which voids the tokens; ask
            // for a fresh choice rather than registering possibly void ones.
            if device.wasAuthorized, let end = device.horizonEnd, end < DayKey.containing(now, in: tz) {
                revoked = true
            }
        } else if device.wasAuthorized {
            revoked = true
        }
        if revoked {
            device.authGeneration += 1
            device.registry.forgetLive()
        }
        device.wasAuthorized = authorization == .approved

        let plan = MonitorPlan.make(
            active: active, registry: device.registry, schedule: device.schedule, now: now, timeZone: tz,
            authorized: authorization == .approved, authGeneration: device.authGeneration
        )
        if !plan.stop.isEmpty { center.stop(plan.stop) }
        device.registry.stopped(plan.stop)

        var started = 0
        var failure: String?
        for item in plan.start {
            guard let entry = device.schedule.entries.first(where: { $0.id == item.registration.selectionID }),
                  let itemZone = TimeZone(identifier: item.timeZone)
            else { continue }
            do {
                try center.start(item.registration, interval: item.interval, timeZone: itemZone, payload: entry.payload)
                device.registry.started(item.registration.activityName, timeZone: item.timeZone)
                started += 1
            } catch {
                // Nearer days come first; stop at the first rejection (for
                // example too many activities) and retry on the next run.
                failure = String(describing: error)
                break
            }
        }
        device.horizonEnd = device.registry.live.compactMap { MonitorRegistration(activityName: $0)?.day }.max()
        try deviceStore.save(device)
        return ReconcileResult(started: started, stopped: plan.stop.count, revocationDetected: revoked, failure: failure)
    }

    // MARK: Accounts

    /// Starts a new account. A replaced account reserves today, so the new
    /// one starts tomorrow and never receives a day the earlier account could
    /// have measured, sent, or had committed without an acknowledgement. The
    /// reservation is saved before the new account exists.
    public func connect(origin: ServerOrigin) throws -> AccountSummary {
        var device = try ingest()
        if let previous = try accountStore.load() {
            reserveForDeparting(previous, &device)
        }
        let account = AccountState(
            accountID: makeID(), origin: origin.string, deviceID: "ios-\(makeID())",
            startDay: AccountState.startDay(today: today, reservedThrough: device.reservedThrough)
        )
        try deviceStore.save(device)
        try accountStore.save(account)
        return summary(account)
    }

    /// Ends the account. Its unsent snapshots are discarded, never transferred,
    /// and today stays reserved for it.
    public func disconnect() throws {
        var device = try ingest()
        if let previous = try accountStore.load() {
            reserveForDeparting(previous, &device)
            try deviceStore.save(device)
        }
        accountStore.delete()
    }

    /// Everything the departing account could own: today, every day it
    /// queued, and every day measured on the device so far. The caller drains
    /// callbacks still on disk into the ledger first. Counting measured days
    /// as well as today keeps this correct when the clock was set back.
    private func reserveForDeparting(_ account: AccountState, _ device: inout DeviceState) {
        let days = [today, account.lastClaimedDay, device.ledger.latestMeasuredDay].compactMap { $0 }
        reserve(&device, through: days.max()!)
    }

    private func reserve(_ device: inout DeviceState, through day: DayKey) {
        device.reservedThrough = max(device.reservedThrough ?? day, day)
    }

    // MARK: Status

    public func status() throws -> EngineStatus {
        let device = try ingest()
        let day = today
        let all = measurements(device)
        let current = device.schedule.effective(on: day)
        // Same rule as the dashboard: on a day measured in two zones, show the
        // larger series rather than a sum the server would not report.
        // Includes a selection whose voided tokens were renewed today.
        let todays = all.filter { $0.day == day }
        let live = device.registry.live.compactMap { MonitorRegistration(activityName: $0)?.day }.filter { $0 >= day }
        return EngineStatus(
            today: day,
            todaySeconds: todays.map(\.seconds).max() ?? 0,
            todayImplausibleCallbacks: todays.map(\.implausibleCallbacks).reduce(0, +),
            todayQuarantinedCallbacks: todays.map(\.quarantinedCallbacks).reduce(0, +),
            currentSelectionID: current?.id,
            currentSelectionIsEmpty: current?.isEmpty ?? true,
            needsReselection: current.map { !$0.isEmpty && $0.authGeneration != device.authGeneration } ?? false,
            nextSelectionStarts: device.schedule.pending(after: day)?.effectiveFrom,
            monitoredThrough: live.max(),
            recentDays: Array(all.filter { $0.day < day }.suffix(7)),
            account: try accountStore.load().map(summary)
        )
    }

    // MARK: Sync

    public enum SyncResult: Equatable, Sendable {
        case notConnected
        case alreadyRunning
        case waiting(until: Date)
        case cancelled
        case finished(uploaded: Int, remaining: Int, problem: SyncProblem?)
    }

    /// Uploads queued measurements. `force` ignores the retry timer (user tapped Sync).
    public func sync(credential: SyncCredential, force: Bool = false) async throws -> SyncResult {
        guard !syncing else { return .alreadyRunning }
        syncing = true
        defer { syncing = false }

        var device = try ingest()
        guard var account = try accountStore.load(), account.accountID == credential.accountID,
              let origin = ServerOrigin(account.origin)
        else { return .notConnected }
        let day = today
        let oldest = day.adding(days: -Self.retentionDays)
        let measured = measurements(device).filter { $0.day >= oldest && $0.day <= day.adding(days: 1) }
        account.enqueue(measured, makeID: makeID)
        account.prune(before: oldest)
        // Reserve every queued day before any request, so a later account
        // cannot receive it even if this upload's outcome is never known.
        if let claimed = account.lastClaimedDay, claimed > (device.reservedThrough ?? claimed.adding(days: -1)) {
            reserve(&device, through: claimed)
            try deviceStore.save(device)
        }
        try accountStore.save(account)

        let now = clock()
        if !force, let wait = account.retryAfter, wait > now { return .waiting(until: wait) }

        var uploaded = 0
        var problem: SyncProblem?
        upload: for _ in 0..<20 {
            if Task.isCancelled { return .cancelled }
            let batch = account.nextBatch()
            if batch.isEmpty { break upload }
            let body = try JSONCoding.encoder.encode(UsageRequestBody(snapshots: batch))
            let outcome: UploadOutcome
            do {
                outcome = UploadOutcome.classify(try await transport.post(origin.usageEndpoint, bearer: credential.token, json: body))
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled || error is CancellationError {
                    // Not a server or network failure: keep everything and the retry timer as is.
                    return .cancelled
                }
                outcome = .retry(.offline, after: nil)
            }
            // The account may have been replaced while the request was in flight;
            // its reply then belongs to nobody and is dropped.
            guard let latest = try accountStore.load(), latest.accountID == account.accountID else {
                return .notConnected
            }
            account = latest
            switch outcome {
            case .processed(let accepted):
                account.apply(sent: batch, accepted: accepted)
                account.failureCount = 0
                account.retryAfter = nil
                account.lastSuccess = clock()
                account.lastProblem = nil
                uploaded += accepted.intersection(batch.map(\.id)).count
                try accountStore.save(account)
                // Nothing accepted and nothing dropped: stop instead of resending at once.
                if accepted.isEmpty && account.nextBatch() == batch { break upload }
                continue upload
            case .shrinkBatch:
                account.batchLimit = max(1, min(account.batchLimit, batch.count) / 2)
                try accountStore.save(account)
                if batch.count == 1 { problem = .badResponse; break upload }
                continue upload
            case .retry(let p, let after):
                account.failureCount += 1
                account.retryAfter = clock().addingTimeInterval(max(after ?? 0, Backoff.delay(failures: account.failureCount, jitter: jitter())))
                account.lastProblem = p
                problem = p
            case .blocked(let p):
                account.retryAfter = clock().addingTimeInterval(Backoff.blockedRecheck)
                account.lastProblem = p
                problem = p
            }
            try accountStore.save(account)
            break upload
        }
        return .finished(uploaded: uploaded, remaining: Set(account.pending.map(\.key)).count, problem: problem)
    }

    private func summary(_ a: AccountState) -> AccountSummary {
        AccountSummary(
            accountID: a.accountID, origin: a.origin, startDay: a.startDay, pendingCount: Set(a.pending.map(\.key)).count,
            rejectedCount: a.rejectedCount, lastSuccess: a.lastSuccess, lastProblem: a.lastProblem, retryAfter: a.retryAfter
        )
    }
}
