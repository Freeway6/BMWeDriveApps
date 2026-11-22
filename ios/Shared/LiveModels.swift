import Foundation

/// What the head unit sends (lib/ev_livedoc.js), as it comes out of the relay and the decryption.
/// Numbers come as JSON numbers; what the head unit did not know is null.
struct LiveState: Codable, Equatable {
    var v: Int
    var seq: Double
    /// The head unit's clock (ms since 1970) when it made this; the apps go by the relay's clock instead.
    var t: Double
    /// "charging" or "idle"
    var phase: String
    /// "DC" or "AC" while charging
    var kind: String?
    var soc: Double?
    var kw: Double?
    var cellT: Double?
    var cellTmax: Double?
    var stored: Double?
    var cap: Double?
    var target: Double?
    var session: Session?
    /// The rest of the charge as expected now: [minutes from t, charge level %, kW], to 100 %.
    var fc: [[Double]]?
    var last: LastCharge?
    var link: Bool?

    struct Session: Codable, Equatable {
        var id: Double
        var t0: Double
        var soc0: Double?
        var kwh: Double?
        var peak: Double?
        var peakSoc: Double?
        var cost: Double?
    }

    struct LastCharge: Codable, Equatable {
        var id: Double
        var t0: Double
        var t1: Double
        var kind: String?
        var soc0: Double?
        var soc1: Double?
        var kwh: Double?
        var peak: Double?
        var avg: Double?
        var cost: Double?
        var partial: Bool?
    }

    var isCharging: Bool { phase == "charging" }
}

/// The charge's curve (lib/ev_livedoc.js curveDoc).
struct LiveCurve: Codable, Equatable {
    var v: Int
    var seq: Double
    var id: Double?
    var live: Bool
    var kind: String?
    var t0: Double?
    /// [minutes from t0, charge level %, kW, cell °C]
    var pts: [[Double?]]
    var ref: Ref?
    var exp: Expected?

    struct Ref: Codable, Equatable {
        var id: Double
        var t0: Double
        /// [charge level %, kW]
        var pts: [[Double]]
    }

    struct Expected: Codable, Equatable {
        var cellT: Double?
        /// [charge level %, kW]
        var pts: [[Double?]]
    }
}

/// The relay's answer to GET /v1/c/<channel> (relay/src/channel.js).
struct RelayEnvelope: Decodable {
    var now: Double
    var state: Item?
    var curve: Item?

    struct Item: Decodable {
        var seq: Double
        /// When the relay received it (ms, the relay's clock).
        var rt: Double
        var blob: String?
    }
}

enum LiveError: LocalizedError, Equatable {
    case badLink
    case badData
    case unknownChannel
    case forbidden
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .badLink: return "Kein gültiger Kopplungs-Code."
        case .badData: return "Die Daten ließen sich nicht entschlüsseln (neu koppeln?)."
        case .unknownChannel: return "Das Relay kennt diese Kopplung (noch) nicht. Sobald die Headunit gesendet hat, geht es los."
        case .forbidden: return "Das Relay lehnt den Zugriff ab: neu koppeln."
        case .http(let code): return "Das Relay antwortet mit Fehler \(code)."
        }
    }
}
