import Foundation

/// One look at the relay: the newest state and, when it changed, the curve, opened with the pairing's key.
struct LiveFetch {
    /// The relay's clock at its answer.
    var now: Date
    var state: LiveState?
    /// How old the state is, by the relay's clock alone (seconds): the car's and the phone's clocks don't matter.
    var stateAge: TimeInterval?
    /// The curve, when it is new to the caller (nil: unchanged, or none).
    var curve: LiveCurve?
    /// The relay's curve sequence (nil: the relay has no curve).
    var curveSeq: Double?
}

struct RelayClient {
    let pairing: Pairing
    var session: URLSession = .shared

    /// haveCurve: the curve sequence the caller has; the relay then leaves the curve out when it is the same.
    func fetch(haveCurve: Double?) async throws -> LiveFetch {
        guard var comps = URLComponents(url: pairing.relay.appendingPathComponent("v1/c/\(pairing.channel)"), resolvingAgainstBaseURL: false) else {
            throw LiveError.badLink
        }
        if let have = haveCurve {
            comps.queryItems = [URLQueryItem(name: "have", value: String(format: "%.0f", have))]
        }
        guard let url = comps.url else { throw LiveError.badLink }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("Bearer \(pairing.readToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw LiveError.http(0) }
        switch http.statusCode {
        case 200: break
        case 404: throw LiveError.unknownChannel
        case 401, 403: throw LiveError.forbidden
        default: throw LiveError.http(http.statusCode)
        }
        let decoder = JSONDecoder()
        let envelope = try decoder.decode(RelayEnvelope.self, from: data)
        var out = LiveFetch(now: Date(timeIntervalSince1970: envelope.now / 1000))
        if let item = envelope.state, let blob = item.blob {
            out.state = try decoder.decode(LiveState.self, from: pairing.open(blob, slot: "state"))
            out.stateAge = max(0, (envelope.now - item.rt) / 1000)
        }
        if let item = envelope.curve {
            out.curveSeq = item.seq
            if let blob = item.blob {
                out.curve = try decoder.decode(LiveCurve.self, from: pairing.open(blob, slot: "curve"))
            }
        }
        return out
    }
}
