import ClockedCore
import DeviceActivity
import FamilyControls
import SwiftUI

extension DeviceActivityReport.Context {
    /// Must match the context declared by the report extension.
    static let totalActivity = Self("Total Activity")
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    header
                    if let error = model.configurationError {
                        Notice(text: error, color: Palette.error)
                    }
                    if let problem = model.problem {
                        Notice(text: problem, color: Palette.error)
                    }
                    if let message = model.message {
                        Notice(text: message, color: Palette.ok)
                    }
                    PermissionPanel()
                    WorkAppsPanel()
                    TodayPanel()
                    SyncPanel()
                    MeasurementPanel()
                }
                .padding(16)
            }
            .background(Palette.background.ignoresSafeArea())
            .refreshable { await model.refresh(userInitiated: true) }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("clocked")
                .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                .foregroundStyle(LinearGradient(colors: [Palette.amber, Palette.amberDeep], startPoint: .leading, endPoint: .trailing))
            Text("Time in your work apps, measured by Screen Time")
                .font(.subheadline)
                .foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

struct Notice: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.5), lineWidth: 1))
    }
}

struct PermissionPanel: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Panel(title: "Screen Time access") {
            switch model.authorization {
            case .approved:
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ok)
            case .notDetermined:
                Text("Clocked needs Screen Time access to measure time in the work apps you choose. Apple keeps your choices private: Clocked receives time milestones, not app names.")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                Button("Allow Screen Time access") { Task { await model.requestAuthorization() } }
                    .buttonStyle(AmberButtonStyle())
            case .denied:
                Text("Screen Time access is off, so nothing is measured. Allow it again here or in Settings. Time while access was off is not counted.")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                Button("Try again") { Task { await model.requestAuthorization() } }
                    .buttonStyle(AmberButtonStyle(prominent: false))
            }
        }
    }
}

struct WorkAppsPanel: View {
    @EnvironmentObject private var model: AppModel
    @State private var draft = FamilyActivitySelection()
    @State private var picking = false

    var body: some View {
        Panel(title: "Work apps") {
            let s = model.currentSelection
            let reselect = model.status?.needsReselection ?? false
            if reselect {
                Text("Screen Time access was turned off, or Clocked was closed for longer than its monitoring week and cannot tell whether it was. Either way Apple's app references may be void. Choose your work apps again to resume counting; time already measured is kept.")
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
            } else if ScreenTimeMonitoring.isEmpty(s) {
                Text("No work apps chosen yet.")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            } else {
                Text("\(s.applicationTokens.count) apps · \(s.categoryTokens.count) categories · \(s.webDomainTokens.count) websites")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Palette.text)
            }
            if let next = model.status?.nextSelectionStarts {
                Text("Your new choice starts counting on \(next.description). Today keeps the apps it started with.")
                    .font(.caption)
                    .foregroundStyle(Palette.amber)
            }
            Button("Choose work apps") {
                draft = model.currentSelection
                picking = true
            }
            .buttonStyle(AmberButtonStyle(prominent: reselect || ScreenTimeMonitoring.isEmpty(s)))
            .disabled(model.authorization != .approved)
        }
        .sheet(isPresented: $picking) {
            NavigationStack {
                FamilyActivityPicker(
                    headerText: "Choose the apps, categories, and websites you use for work.",
                    footerText: "Your choices stay on this iPhone. If time was already counted today, a change starts tomorrow.",
                    selection: $draft
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { picking = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            picking = false
                            let chosen = draft
                            Task { await model.saveSelection(chosen) }
                        }
                    }
                }
            }
        }
    }
}

struct TodayPanel: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Panel(title: "Today") {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("at least")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                Text(Format.duration(model.status?.todaySeconds ?? 0))
                    .font(.system(size: 40, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(Palette.text)
            }
            Text("Counted in 15-minute steps from Screen Time alerts and rounded down. This number is what syncs.")
                .font(.caption)
                .foregroundStyle(Palette.muted)
            if let ignored = model.status?.todayImplausibleCallbacks, ignored > 0 {
                Text("Ignored \(ignored) Screen Time alert\(ignored == 1 ? "" : "s") that arrived sooner than possible.")
                    .font(.caption)
                    .foregroundStyle(Palette.amber)
            }
            if let late = model.status?.todayQuarantinedCallbacks, late > 0 {
                Text("Ignored \(late) alert\(late == 1 ? "" : "s") that arrived more than 6 hours after the day ended.")
                    .font(.caption)
                    .foregroundStyle(Palette.amber)
            }
            if let through = model.status?.monitoredThrough {
                Text("Monitoring is set up through \(through.description). Open Clocked before then to keep counting.")
                    .font(.caption)
                    .foregroundStyle(Palette.muted)
            } else if !ScreenTimeMonitoring.isEmpty(model.currentSelection), model.authorization == .approved {
                Text("Monitoring is not running. Open Clocked to set it up again.")
                    .font(.caption)
                    .foregroundStyle(Palette.amber)
            }
            if model.authorization == .approved, !ScreenTimeMonitoring.isEmpty(model.currentSelection) {
                // Rendered by the report extension in Apple's sandbox. The app
                // cannot read this value, so it is never synced.
                DeviceActivityReport(.totalActivity, filter: todayFilter)
                    .frame(height: 104)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            if let days = model.status?.recentDays, !days.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(days.enumerated()), id: \.offset) { _, d in
                        HStack {
                            Text(d.day.description)
                            Spacer()
                            Text("≥ " + Format.duration(d.seconds))
                        }
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Palette.muted)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private var todayFilter: DeviceActivityFilter {
        let s = model.currentSelection
        let today = Calendar.current.dateInterval(of: .day, for: Date())!
        return DeviceActivityFilter(
            segment: .daily(during: today),
            applications: s.applicationTokens,
            categories: s.categoryTokens,
            webDomains: s.webDomainTokens
        )
    }
}

struct SyncPanel: View {
    @EnvironmentObject private var model: AppModel
    @State private var origin = ServerOrigin.hosted.string
    @State private var token = ""
    @State private var confirmingDisconnect = false

    var body: some View {
        Panel(title: "Dashboard sync") {
            if let account = model.status?.account {
                row("Server", account.origin.replacingOccurrences(of: "https://", with: ""))
                row("Sending from", account.startDay.description)
                row("Last upload", account.lastSuccess.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "not yet")
                row("Waiting", "\(account.pendingCount) day totals")
                if account.rejectedCount > 0 {
                    row("Declined by server", "\(account.rejectedCount)")
                }
                HStack(spacing: 10) {
                    Button(model.isBusy ? "Syncing…" : "Sync now") { Task { await model.sync(force: true) } }
                        .buttonStyle(AmberButtonStyle())
                        .disabled(model.isBusy)
                    Button("Open dashboard") { Task { await model.openDashboard() } }
                        .buttonStyle(AmberButtonStyle(prominent: false))
                }
                Button("Disconnect", role: .destructive) { confirmingDisconnect = true }
                    .font(.footnote)
                    .foregroundStyle(Palette.error)
                    .confirmationDialog("Disconnect this iPhone?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
                        Button("Disconnect", role: .destructive) { Task { await model.disconnect() } }
                    } message: {
                        Text(Self.disconnectWarning(pending: account.pendingCount))
                    }
            } else {
                Text("Create a device token in dashboard Settings and paste it here. It is kept in the iPhone Keychain.")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                TextField("https://clocked.daviddusi.com", text: $origin)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textFieldStyle(InsetField())
                SecureField("clk_…", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(InsetField())
                Button("Connect") {
                    Task {
                        if await model.connect(origin: origin, token: token) { token = "" }
                    }
                }
                .buttonStyle(AmberButtonStyle())
                .disabled(token.isEmpty)
            }
        }
    }

    static func disconnectWarning(pending: Int) -> String {
        let unsent = pending == 0
            ? "Every total has been uploaded."
            : "\(pending) day total\(pending == 1 ? " has" : "s have") not been uploaded and will be discarded."
        return unsent + " Today stays with this account, so a newly connected account starts sending tomorrow."
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).foregroundStyle(Palette.text).monospacedDigit()
        }
        .font(.footnote)
    }
}

struct InsetField: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(.footnote, design: .monospaced))
            .padding(10)
            .background(Palette.panelInset, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border, lineWidth: 1))
    }
}

struct MeasurementPanel: View {
    var body: some View {
        Panel(title: "What is measured") {
            VStack(alignment: .leading, spacing: 8) {
                bullet("Each day gets one number: at least this much combined time in your work apps, rounded down to 15 minutes and capped at 12 hours.")
                bullet("Your dashboard receives the day, the time zone, and that number. App names, app identifiers, and per-app times stay on this iPhone.")
                bullet("It is not a timesheet. Without start and end times it cannot be merged with desktop time, so the dashboard shows it separately and does not add it to billable hours.")
                bullet("Each day is monitored separately, so an alert always counts for the day it belongs to. Alerts that arrive sooner than possible, or more than 6 hours after their day, are ignored. iOS can still report a step somewhat early, which this cannot detect.")
                bullet("Counting starts when monitoring starts. After a time zone change a new count begins, and the day shows the larger of the two counts, not their sum. Time while Screen Time access was off is not counted.")
                bullet("Clocked sets up monitoring a week ahead. If it is not opened for longer than that, counting stops and you will be asked to choose your work apps again.")
            }
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(Palette.amber).frame(width: 5, height: 5).padding(.top, 6)
            Text(text).font(.caption).foregroundStyle(Palette.muted)
        }
    }
}
