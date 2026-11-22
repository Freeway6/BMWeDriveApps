import CryptoKit
import Foundation

/// A pairing with the car: the relay, the channel there and the key, from the link in the head unit's QR code:
///
///     i4laden://pair?v=1&r=<relay URL>&c=<channel, 32 hex digits>&k=<key, 32 bytes base64url>
///
/// Everything else is derived from the key, as the head unit does (lib/ev_live.js): the AES-256-GCM key the data
/// is sealed with, and the token that reads it from the relay.
struct Pairing: Equatable {
    static let scheme = "i4laden"

    let relay: URL
    let channel: String
    let key: Data
    /// The link as scanned: kept (Keychain) and handed to the Watch.
    let link: String

    init?(link url: URL) {
        guard url.scheme?.lowercased() == Pairing.scheme, url.host?.lowercased() == "pair",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var q: [String: String] = [:]
        for item in comps.queryItems ?? [] {
            if let value = item.value { q[item.name] = value }
        }
        guard let r = q["r"], let relay = URL(string: r), let s = relay.scheme?.lowercased(), s == "https" || s == "http",
              let c = q["c"], c.count == 32, c.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let k = q["k"], let key = Pairing.base64url(k), key.count == 32 else { return nil }
        self.relay = relay
        self.channel = c
        self.key = key
        self.link = url.absoluteString
    }

    init?(link string: String) {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(link: url)
    }

    static func base64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    private func derive(_ label: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(label.utf8), using: SymmetricKey(data: key)))
    }

    /// The key the head unit seals the documents with.
    var sealKey: SymmetricKey { SymmetricKey(data: derive("i4live enc v1")) }

    /// The token that reads this channel from the relay (64 hex digits).
    var readToken: String { derive("i4live read v1").map { String(format: "%02x", $0) }.joined() }

    /// The relay's host, for the settings.
    var relayHost: String { relay.host ?? relay.absoluteString }

    /// A sealed document of a slot ("state", "curve"): base64 of nonce (12 bytes) | ciphertext | tag (16 bytes),
    /// the channel and the slot authenticated with it.
    func open(_ blob: String, slot: String) throws -> Data {
        guard let data = Data(base64Encoded: blob) else { throw LiveError.badData }
        do {
            let box = try AES.GCM.SealedBox(combined: data)
            return try AES.GCM.open(box, using: sealKey, authenticating: Data("i4live|\(channel)|\(slot)|v1".utf8))
        } catch {
            throw LiveError.badData
        }
    }
}
