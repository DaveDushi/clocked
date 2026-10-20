import DeviceActivity
import SwiftUI

/// Renders Screen Time totals for the selected work apps inside Apple's
/// report sandbox. Nothing here can be read by the app, written to shared
/// storage, or sent over the network.
@main
struct ClockedReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        TotalActivityReport { TotalActivityView(totalSeconds: $0) }
    }
}

extension DeviceActivityReport.Context {
    static let totalActivity = Self("Total Activity")
}

struct TotalActivityReport: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .totalActivity
    let content: (TimeInterval) -> TotalActivityView

    func makeConfiguration(representing data: DeviceActivityResults<DeviceActivityData>) async -> TimeInterval {
        var total: TimeInterval = 0
        for await device in data {
            for await segment in device.activitySegments {
                total += segment.totalActivityDuration
            }
        }
        return total
    }
}

struct TotalActivityView: View {
    let totalSeconds: TimeInterval

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Screen Time today")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(red: 0x8b / 255, green: 0x91 / 255, blue: 0xa0 / 255))
            Text(Self.format(totalSeconds))
                .font(.system(.title2, design: .monospaced).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(Color(red: 0xe9 / 255, green: 0xea / 255, blue: 0xf0 / 255))
            Text("Exact Screen Time for your work apps. Shown on this iPhone only.")
                .font(.caption2)
                .foregroundStyle(Color(red: 0x8b / 255, green: 0x91 / 255, blue: 0xa0 / 255))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(red: 0x15 / 255, green: 0x18 / 255, blue: 0x23 / 255))
    }

    static func format(_ seconds: TimeInterval) -> String {
        let minutes = Int(seconds) / 60
        return String(format: "%d:%02d", minutes / 60, minutes % 60)
    }
}
