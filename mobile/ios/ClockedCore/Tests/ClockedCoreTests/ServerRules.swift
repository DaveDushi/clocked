import Foundation
import XCTest
@testable import ClockedCore

/// Checks client-built request bodies against the validation rules in the
/// Worker source (`worker/src/mobile-usage.ts`), so a format drift between
/// the two fails here instead of silently on a phone.
enum ServerRules {
    struct Rules {
        let id: NSRegularExpression
        let selectionID: NSRegularExpression
        let fields: Set<String>
    }

    static let workerSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // ClockedCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ClockedCore
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // mobile
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("worker/src/mobile-usage.ts")

    /// Snapshot body the Worker tests accept and persist.
    static let sharedFixture = workerSource
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("test/fixtures/ios-zone-series.json")

    static func load() throws -> Rules {
        let source = try String(contentsOf: workerSource, encoding: .utf8)
        return Rules(
            id: try regex(named: "ID", in: source),
            selectionID: try regex(named: "SELECTION_ID", in: source),
            fields: try fieldSet(in: source)
        )
    }

    /// Fails the calling test if any snapshot in `body` breaks a server rule.
    static func assertAccepted(_ body: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let rules = try load()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any], file: file, line: line)
        let snapshots = try XCTUnwrap(json["snapshots"] as? [[String: Any]], file: file, line: line)
        XCTAssertFalse(snapshots.isEmpty, file: file, line: line)
        for snap in snapshots {
            XCTAssertEqual(Set(snap.keys), rules.fields, file: file, line: line)
            for key in ["id", "device_id"] {
                let value = snap[key] as? String ?? ""
                XCTAssertTrue(matches(rules.id, value), "\(key) \(value) fails the server ID rule", file: file, line: line)
            }
            let selection = snap["selection_id"] as? String ?? ""
            XCTAssertTrue(matches(rules.selectionID, selection), "selection_id \(selection) fails the server rule", file: file, line: line)
        }
    }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// Reads `const NAME = /pattern/flags;` from TypeScript.
    static func regex(named name: String, in source: String) throws -> NSRegularExpression {
        let finder = try NSRegularExpression(pattern: "const \(name) = /(.+)/([a-z]*);")
        guard let m = finder.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              let p = Range(m.range(at: 1), in: source), let f = Range(m.range(at: 2), in: source)
        else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSLocalizedDescriptionKey: "\(name) not found in Worker source"]) }
        let options: NSRegularExpression.Options = source[f].contains("i") ? [.caseInsensitive] : []
        return try NSRegularExpression(pattern: String(source[p]), options: options)
    }

    static func fieldSet(in source: String) throws -> Set<String> {
        let finder = try NSRegularExpression(pattern: "const SNAPSHOT_FIELDS = new Set\\(\\[([^\\]]+)\\]\\)")
        guard let m = finder.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              let r = Range(m.range(at: 1), in: source)
        else {
            // Older Worker revisions have no explicit field list; fall back to the contract.
            return ["id", "device_id", "platform", "day", "timezone", "selection_id", "duration_seconds"]
        }
        return Set(source[r].split(separator: ",").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) })
    }
}

final class ServerRulesTests: XCTestCase {
    /// A client-built body must satisfy the Worker as it is in this checkout.
    func testClientSnapshotMatchesWorkerValidation() throws {
        var a = AccountState(accountID: "acc", origin: "https://example.com", deviceID: "ios-0b8c2f4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e", startDay: day("2026-05-01"))
        a.enqueue([DayMeasurement(day: day("2026-05-04"), selectionID: selS, timeZone: "America/Argentina/Buenos_Aires", seconds: 900, implausibleCallbacks: 0)],
                  makeID: { "5c4b3a29-1817-4615-a413-121110090807" })
        let body = try JSONCoding.encoder.encode(UsageRequestBody(snapshots: a.nextBatch()))
        try ServerRules.assertAccepted(body)
    }

    /// ClockedCore must produce exactly the body the Worker's shared fixture holds.
    func testClientBuildsTheSharedWorkerFixture() throws {
        let fixture = try Data(contentsOf: ServerRules.sharedFixture)
        try ServerRules.assertAccepted(fixture)
        var a = AccountState(accountID: "acc", origin: "https://example.com", deviceID: "70bbd501-0793-45f4-bdf3-e69ab3ffadcb", startDay: day("2026-06-01"))
        a.enqueue([DayMeasurement(day: day("2026-06-01"), selectionID: "0f3a9c2e-1111-4222-8333-944455556666", timeZone: "Europe/Berlin", seconds: 900, implausibleCallbacks: 0)],
                  makeID: { "e182052c-4254-4bf4-801b-af97429dcafa" })
        let built = try JSONCoding.encoder.encode(UsageRequestBody(snapshots: a.nextBatch()))
        let lhs = try JSONSerialization.jsonObject(with: built) as? NSDictionary
        let rhs = try JSONSerialization.jsonObject(with: fixture) as? NSDictionary
        XCTAssertEqual(lhs, rhs)
    }
}
