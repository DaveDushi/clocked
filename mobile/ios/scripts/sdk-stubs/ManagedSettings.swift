// Stub of Apple's module for typecheck_bridge.sh. Signatures follow developer.apple.com.
// Signatures from Apple's documentation; bodies are stubs for typechecking only.
public struct Token<T>: Hashable, Codable, Sendable { }
public struct Application: Sendable { }
public struct ActivityCategory: Sendable { }
public struct WebDomain: Sendable { }
public typealias ApplicationToken = Token<Application>
public typealias ActivityCategoryToken = Token<ActivityCategory>
public typealias WebDomainToken = Token<WebDomain>
