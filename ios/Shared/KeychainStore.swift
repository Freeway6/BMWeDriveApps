import Foundation
import Security

/// The pairing link holds the key: it is kept in the Keychain (this app's own), readable after the first unlock so
/// that a background refresh can use it.
enum KeychainStore {
    private static var service: String { Bundle.main.bundleIdentifier ?? "i4laden" }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func save(_ data: Data, account: String) {
        SecItemDelete(query(account) as CFDictionary)
        var item = query(account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func load(account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    /// The pairing, kept as its link.
    static func loadPairing() -> Pairing? {
        guard let data = load(account: "pairing"), let link = String(data: data, encoding: .utf8) else { return nil }
        return Pairing(link: link)
    }

    static func savePairing(_ pairing: Pairing?) {
        if let pairing { save(Data(pairing.link.utf8), account: "pairing") } else { delete(account: "pairing") }
    }
}
