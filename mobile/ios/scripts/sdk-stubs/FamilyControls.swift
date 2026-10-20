// Stub of Apple's module for typecheck_bridge.sh. Signatures follow developer.apple.com.
import ManagedSettings
public struct FamilyActivitySelection: Codable, Equatable {
    public init() {}
    public var applicationTokens: Set<ApplicationToken> = []
    public var categoryTokens: Set<ActivityCategoryToken> = []
    public var webDomainTokens: Set<WebDomainToken> = []
}
public enum AuthorizationStatus: Sendable { case notDetermined, denied, approved }
public enum FamilyControlsMember: Sendable { case child, individual }
public final class AuthorizationCenter: @unchecked Sendable {
    public static let shared = AuthorizationCenter()
    public var authorizationStatus: AuthorizationStatus { .notDetermined }
    public func requestAuthorization(for member: FamilyControlsMember) async throws {}
}
