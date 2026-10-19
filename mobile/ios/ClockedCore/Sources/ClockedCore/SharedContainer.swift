import Foundation

/// Locations shared by the app and the monitor extension. The App Group holds
/// only monitor records (activity name, threshold name, time, time zone).
public enum SharedContainer {
    /// Info.plist key whose value is the App Group identifier, set from the
    /// `CLOCKED_APP_GROUP` build setting so signing teams can change it.
    public static let infoKey = "ClockedAppGroup"

    public static func appGroupID(bundle: Bundle = .main) -> String? {
        bundle.object(forInfoDictionaryKey: infoKey) as? String
    }

    public static func recordsDirectory(bundle: Bundle = .main) -> URL? {
        #if canImport(Darwin)
        guard let group = appGroupID(bundle: bundle),
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        return root.appendingPathComponent("MonitorRecords", isDirectory: true)
        #else
        return nil
        #endif
    }
}
