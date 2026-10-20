import BackgroundTasks
import ClockedCore
import FamilyControls
import Foundation
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var authorization: ScreenTimeAuthorization = .notDetermined
    @Published private(set) var status: EngineStatus?
    @Published private(set) var currentSelection = FamilyActivitySelection()
    @Published private(set) var message: String?
    @Published private(set) var problem: String?
    @Published private(set) var isBusy = false
    /// Set when the App Group is missing from the build's entitlements, in
    /// which case the monitor extension cannot hand callbacks to the app.
    @Published private(set) var configurationError: String?

    let engine: UsageEngine
    private let tokens = KeychainTokenStore()
    private let transport: URLSessionUsageTransport
    static let refreshTaskID = (Bundle.main.bundleIdentifier ?? "com.daviddusi.clocked.ios") + ".refresh"

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Clocked", isDirectory: true)
        let transport = URLSessionUsageTransport()
        self.transport = transport
        let shared = SharedContainer.recordsDirectory()
        let records = shared ?? support.appendingPathComponent("MonitorRecords", isDirectory: true)
        engine = UsageEngine(stateDirectory: support, records: MonitorRecordStore(directory: records), transport: transport)
        if shared == nil {
            configurationError = "This build has no App Group, so Screen Time callbacks cannot reach the app."
        }
    }

    // MARK: Lifecycle

    /// Foreground and background refresh: reconcile monitoring with the
    /// current permission, selection, time zone, and horizon, then upload.
    /// Cancelling the calling task (background expiry) cancels the upload.
    func refresh(userInitiated: Bool = false) async {
        authorization = ScreenTimeMonitoring.authorization
        do {
            let result = try await engine.reconcileMonitoring(center: SystemActivityCenter(), authorization: authorization)
            if result.revocationDetected {
                problem = "Clocked could not confirm Screen Time access stayed on, so the chosen work apps may no longer work. Choose them again to resume counting. Time already measured is kept."
            } else if let failure = result.failure {
                problem = "Screen Time did not accept every day's monitoring (\(failure)). Clocked will try again next time it opens."
            }
        } catch {
            problem = "Screen Time monitoring could not be updated: \(error.localizedDescription)"
        }
        await reloadStatus()
        await sync(force: userInitiated)
        scheduleBackgroundRefresh()
    }

    func reloadStatus() async {
        do {
            let s = try await engine.status()
            status = s
            if let id = s.currentSelectionID,
               let entry = try await engine.schedule().entries.first(where: { $0.id == id }),
               !s.needsReselection,
               let selection = ScreenTimeMonitoring.decode(entry.payload) {
                currentSelection = selection
            } else {
                currentSelection = FamilyActivitySelection()
            }
        } catch {
            problem = "Could not read saved measurements: \(error.localizedDescription)"
        }
    }

    func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    // MARK: Screen Time

    func requestAuthorization() async {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
        } catch {
            problem = "Screen Time access was not granted: \(error.localizedDescription)"
        }
        await refresh()
    }

    func saveSelection(_ selection: FamilyActivitySelection) async {
        do {
            let placement = try await engine.chooseSelection(
                payload: try ScreenTimeMonitoring.encode(selection), isEmpty: ScreenTimeMonitoring.isEmpty(selection)
            )
            problem = nil
            switch placement {
            case .today:
                message = ScreenTimeMonitoring.isEmpty(selection)
                    ? "No work apps chosen. Nothing is measured."
                    : "Work apps saved. Counting starts within a minute."
            case .tomorrow:
                message = "Work apps saved. Today keeps the apps it started with; the new choice starts at midnight."
            }
            await refresh()
        } catch {
            problem = "Could not save work apps: \(error.localizedDescription)"
        }
    }

    // MARK: Dashboard connection

    func connect(origin raw: String, token rawToken: String) async -> Bool {
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let origin = ServerOrigin(raw) else {
            problem = "Enter the dashboard address as https://host, without a path."
            return false
        }
        guard DeviceToken.isWellFormed(token) else {
            problem = "Device tokens start with clk_. Create one in dashboard Settings."
            return false
        }
        do {
            let account = try await engine.connect(origin: origin)
            do {
                try tokens.save(token, for: account.accountID)
            } catch {
                try? await engine.disconnect()
                throw error
            }
            problem = nil
            message = "Connected to \(origin.url.host ?? origin.string). Sending starts \(account.startDay.description)."
            await refresh(userInitiated: true)
            return true
        } catch {
            problem = "Could not save the connection: \(error.localizedDescription)"
            return false
        }
    }

    func disconnect() async {
        do {
            try await engine.disconnect()
        } catch {
            problem = "Could not disconnect: \(error.localizedDescription)"
            return
        }
        tokens.deleteAll()
        message = "Disconnected. Unsent totals were discarded; measurements stay on this iPhone."
        await reloadStatus()
    }

    func sync(force: Bool) async {
        guard let accountID = status?.account?.accountID, let credential = tokens.credential(for: accountID) else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let result = try await engine.sync(credential: credential, force: force)
            if case let .finished(_, _, p?) = result {
                problem = Self.describe(p)
            } else if force, case .finished = result {
                problem = nil
            }
        } catch {
            problem = "Sync failed: \(error.localizedDescription)"
        }
        await reloadStatus()
    }

    func openDashboard() async {
        guard let account = status?.account, let origin = ServerOrigin(account.origin) else { return }
        var url = origin.url
        if let credential = tokens.credential(for: account.accountID) {
            url = await DashboardLink.url(origin: origin, token: credential.token, transport: transport)
        }
        _ = await UIApplication.shared.open(url)
    }

    static func describe(_ p: SyncProblem) -> String {
        switch p {
        case .offline: return "Offline. Totals are saved and upload when the connection returns."
        case .unauthorized: return "The server rejected this device token. Create a new one in dashboard Settings and reconnect."
        case .subscriptionRequired: return "This account needs an active plan to sync."
        case .serverNeedsUpdate: return "This server does not accept iPhone measurements yet. Update the Worker and run its migrations."
        case .rateLimited: return "The server asked us to slow down. Retrying later."
        case .serverError: return "The server had a problem. Retrying later."
        case .badResponse: return "The server sent an unexpected reply. Retrying later."
        }
    }
}
