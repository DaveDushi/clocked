import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A validated dashboard origin such as `https://clocked.daviddusi.com`.
public struct ServerOrigin: Equatable, Sendable {
    public let url: URL

    public static let hosted = ServerOrigin("https://clocked.daviddusi.com")!

    /// Accepts only `https://host[:port]` with an optional trailing slash. No
    /// credentials, paths, queries, or fragments, so a token is never sent to
    /// an unexpected location.
    public init?(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed), comps.scheme?.lowercased() == "https",
              let host = comps.host, !host.isEmpty, comps.user == nil, comps.password == nil,
              comps.query == nil, comps.fragment == nil, comps.path.isEmpty || comps.path == "/"
        else { return nil }
        var clean = URLComponents()
        clean.scheme = "https"
        clean.host = host.lowercased()
        clean.port = comps.port
        guard let url = clean.url else { return nil }
        self.url = url
    }

    public var string: String { url.absoluteString }
    public var usageEndpoint: URL { url.appendingPathComponent("mobile/usage") }
    public var dashboardLinkEndpoint: URL { url.appendingPathComponent("api/auth/desktop/link") }

    /// A one-time dashboard URL returned by the server must stay on this origin.
    public func isSameOrigin(_ other: URL) -> Bool {
        other.scheme?.lowercased() == "https" && other.host?.lowercased() == url.host && other.port == url.port
    }
}

public enum DeviceToken {
    /// Dashboard device tokens are `clk_` followed by base64url text.
    public static func isWellFormed(_ token: String) -> Bool {
        guard token.hasPrefix("clk_") else { return false }
        let body = token.dropFirst(4)
        return (16...256).contains(body.count)
            && body.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

public enum SyncProblem: String, Codable, Equatable, Sendable {
    case offline
    case unauthorized
    case subscriptionRequired
    case serverNeedsUpdate
    case rateLimited
    case serverError
    case badResponse
}

public struct HTTPResult: Sendable {
    public let status: Int
    public let body: Data
    public let retryAfterSeconds: TimeInterval?

    public init(status: Int, body: Data, retryAfterSeconds: TimeInterval? = nil) {
        self.status = status
        self.body = body
        self.retryAfterSeconds = retryAfterSeconds
    }
}

public protocol UsageTransport: Sendable {
    /// Throws only for transport failures (offline, TLS, timeout).
    func post(_ url: URL, bearer: String, json: Data) async throws -> HTTPResult
}

public enum UploadOutcome: Equatable, Sendable {
    /// The server processed the batch; only these IDs are stored.
    case processed(accepted: Set<String>)
    /// Nothing was stored; keep everything and retry later.
    case retry(SyncProblem, after: TimeInterval?)
    /// Retrying cannot help until the user acts (new token, subscription, server update).
    case blocked(SyncProblem)
    /// The batch was too large for the server; retry with fewer snapshots.
    case shrinkBatch

    public static func classify(_ result: HTTPResult) -> UploadOutcome {
        switch result.status {
        case 200..<300, 409:
            guard let accepted = acceptedIDs(result.body) else { return .retry(.badResponse, after: nil) }
            return .processed(accepted: accepted)
        case 400:
            // "no valid snapshots" carries `accepted: []`; anything else is a client bug to retry later.
            if let accepted = acceptedIDs(result.body) { return .processed(accepted: accepted) }
            return .retry(.badResponse, after: nil)
        case 401, 403: return .blocked(.unauthorized)
        case 402: return .blocked(.subscriptionRequired)
        case 404, 405: return .blocked(.serverNeedsUpdate)
        case 413: return .shrinkBatch
        case 429: return .retry(.rateLimited, after: result.retryAfterSeconds)
        default: return .retry(.serverError, after: result.retryAfterSeconds)
        }
    }

    static func acceptedIDs(_ body: Data) -> Set<String>? {
        struct Reply: Decodable { let accepted: [String] }
        return (try? JSONDecoder().decode(Reply.self, from: body)).map { Set($0.accepted) }
    }
}

public enum Backoff {
    /// Exponential delay from 30 s to 6 h. `jitter` in 0...1 spreads retries
    /// between half and the full delay.
    public static func delay(failures: Int, jitter: Double) -> TimeInterval {
        let base: TimeInterval = 30
        let cap: TimeInterval = 6 * 3600
        let raw = min(cap, base * pow(2, Double(max(0, failures - 1))))
        return raw * (0.5 + 0.5 * min(1, max(0, jitter)))
    }

    /// Blocked states still recheck occasionally so a renewed subscription or
    /// an updated server resumes without user action.
    public static let blockedRecheck: TimeInterval = 6 * 3600
}

public struct UsageRequestBody: Codable, Equatable, Sendable {
    public let snapshots: [UsageSnapshot]
}

/// URLSession transport. The token travels only in the Authorization header.
public struct URLSessionUsageTransport: UsageTransport, @unchecked Sendable {
    let session: URLSession

    /// Ephemeral (no cookies or cache on disk) and never follows redirects,
    /// so the Authorization header cannot be replayed to another location.
    public init(session: URLSession = URLSession(configuration: .ephemeral, delegate: RefuseRedirects(), delegateQueue: nil)) {
        self.session = session
    }

    public func post(_ url: URL, bearer: String, json: Data) async throws -> HTTPResult {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = json
        // The callback form behaves the same on Apple platforms and Linux.
        // Cancelling the calling task (for example when background refresh
        // expires) cancels the request.
        let holder = TaskHolder()
        let (data, response): (Data, URLResponse) = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { cont in
                let task = session.dataTask(with: request) { data, response, error in
                    if let error { cont.resume(throwing: error) } else if let response {
                        cont.resume(returning: (data ?? Data(), response))
                    } else { cont.resume(throwing: URLError(.badServerResponse)) }
                }
                holder.set(task)
                task.resume()
            }
        } onCancel: {
            holder.cancel()
        }
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
        return HTTPResult(status: http.statusCode, body: data, retryAfterSeconds: retryAfter)
    }
}

final class TaskHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false

    func set(_ task: URLSessionTask) {
        lock.lock()
        self.task = task
        let cancelNow = cancelled
        lock.unlock()
        if cancelNow { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let t = task
        lock.unlock()
        t?.cancel()
    }
}

public final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    public func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Opens the dashboard already signed in, through the existing one-time
/// desktop link endpoint. The token stays in the Authorization header; only
/// the short-lived code appears in the returned URL.
public enum DashboardLink {
    public static func url(origin: ServerOrigin, token: String, transport: UsageTransport) async -> URL {
        guard let result = try? await transport.post(origin.dashboardLinkEndpoint, bearer: token, json: Data("{}".utf8)),
              (200..<300).contains(result.status)
        else { return origin.url }
        return parse(result.body, origin: origin) ?? origin.url
    }

    static func parse(_ body: Data, origin: ServerOrigin) -> URL? {
        struct Reply: Decodable { let url: String }
        guard let raw = try? JSONDecoder().decode(Reply.self, from: body), let url = URL(string: raw.url),
              origin.isSameOrigin(url)
        else { return nil }
        return url
    }
}
