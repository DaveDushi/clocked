import ClockedCore
import DeviceActivity
import Foundation

/// Records Screen Time callbacks for the app to turn into measurements. It
/// writes the activity name, threshold name, time, and time zone only. App
/// identities never reach this process: events carry opaque tokens that the
/// system evaluates.
final class ClockedMonitor: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        record(.intervalStart, activity: activity, event: nil)
    }

    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        record(.threshold, activity: activity, event: event.rawValue)
    }

    private func record(_ kind: MonitorRecord.Kind, activity: DeviceActivityName, event: String?) {
        guard MonitorRegistration(activityName: activity.rawValue) != nil,
              let directory = SharedContainer.recordsDirectory()
        else { return }
        let record = MonitorRecord(
            kind: kind, activity: activity.rawValue, event: event, at: Date(), timeZone: TimeZone.current.identifier
        )
        // A failed write (for example before the first unlock after a reboot)
        // loses one callback. The measurement stays a lower bound.
        _ = try? MonitorRecordStore(directory: directory).append(record)
    }
}
