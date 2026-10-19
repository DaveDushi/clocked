import ClockedCore
import Foundation
import Security

/// Stores the dashboard device token in the Keychain under the account it was
/// entered for, readable after the first unlock (so background refresh works)
/// and never synced or backed up to another device.
struct KeychainTokenStore {
    private let service = "com.daviddusi.clocked.device-token"

    /// The token saved for `accountID`, bound to it for upload.
    func credential(for accountID: String) -> SyncCredential? {
        var query = baseQuery
        query[kSecAttrAccount as String] = accountID
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let token = String(data: data, encoding: .utf8)
        else { return nil }
        return SyncCredential(accountID: accountID, token: token)
    }

    /// Replaces every stored token with this one.
    func save(_ token: String, for accountID: String) throws {
        deleteAll()
        var query = baseQuery
        query[kSecAttrAccount as String] = accountID
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    func deleteAll() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
    }
}
