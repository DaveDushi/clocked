// Stub of Apple's module for typecheck_bridge.sh. Signatures follow developer.apple.com.
import Foundation
import ManagedSettings
public struct DeviceActivityName: RawRepresentable, Hashable, Sendable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}
public struct DeviceActivitySchedule {
    public init(intervalStart: DateComponents, intervalEnd: DateComponents, repeats: Bool, warningTime: DateComponents? = nil) {}
}
public struct DeviceActivityEvent {
    public struct Name: RawRepresentable, Hashable, Sendable {
        public var rawValue: String
        public init(rawValue: String) { self.rawValue = rawValue }
        public init(_ rawValue: String) { self.rawValue = rawValue }
    }
    public init(applications: Set<ApplicationToken> = [], categories: Set<ActivityCategoryToken> = [], webDomains: Set<WebDomainToken> = [], threshold: DateComponents, includesPastActivity: Bool) {}
}
public struct DeviceActivityCenter {
    public init() {}
    public var activities: [DeviceActivityName] { [] }
    public func startMonitoring(_ activity: DeviceActivityName, during schedule: DeviceActivitySchedule, events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]) throws {}
    public func stopMonitoring(_ activities: [DeviceActivityName] = []) {}
}
open class DeviceActivityMonitor {
    public init() {}
    open func intervalDidStart(for activity: DeviceActivityName) {}
    open func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {}
}
