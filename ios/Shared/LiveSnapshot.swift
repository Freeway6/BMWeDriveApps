import Foundation

/// The newest state with its time in the phone's clock (now minus its age by the relay's clock), and what follows
/// from it: whether it is live, and where the charge should be now and when it reaches a level (the forecast).
struct LiveSnapshot: Codable, Equatable {
    var state: LiveState
    /// When the head unit sent it, in this device's clock.
    var measuredAt: Date
    var fetchedAt: Date

    /// No word from the head unit for longer than this: it sleeps, or it has no internet.
    static let staleAfter: TimeInterval = 90

    func age(at date: Date = Date()) -> TimeInterval { max(0, date.timeIntervalSince(measuredAt)) }
    func isLive(at date: Date = Date()) -> Bool { age(at: date) < Self.staleAfter }

    /// A time of the head unit's (ms since 1970: a session's start, a curve point) in this device's clock: shifted
    /// by the same amount as the state's own time, so a wrong clock in the car does not matter.
    func localDate(headUnitMs ms: Double) -> Date {
        measuredAt.addingTimeInterval((ms - state.t) / 1000)
    }

    var target: Double { state.target ?? 80 }
    var forecast: [[Double]] { (state.fc ?? []).filter { $0.count >= 3 } }

    /// Charge level and kW at date along the forecast (minutes from measuredAt); without one, the last values.
    func predicted(at date: Date = Date()) -> (soc: Double, kw: Double)? {
        let fc = forecast
        guard let first = fc.first else {
            if let soc = state.soc { return (soc: soc, kw: state.kw ?? 0) }
            return nil
        }
        let m = date.timeIntervalSince(measuredAt) / 60
        if m <= first[0] { return (soc: first[1], kw: first[2]) }
        for i in 1..<max(1, fc.count) {
            let a = fc[i - 1], b = fc[i]
            if m <= b[0] {
                let f = b[0] > a[0] ? (m - a[0]) / (b[0] - a[0]) : 1
                return (soc: a[1] + (b[1] - a[1]) * f, kw: a[2] + (b[2] - a[2]) * f)
            }
        }
        if let last = fc.last { return (soc: last[1], kw: 0) }
        return nil
    }

    /// When the charge reaches level (%) along the forecast; nil without a forecast or when it does not get there.
    func eta(_ level: Double) -> Date? {
        let fc = forecast
        guard let first = fc.first else { return nil }
        if first[1] >= level { return measuredAt }
        for i in 1..<max(1, fc.count) {
            let a = fc[i - 1], b = fc[i]
            if b[1] >= level {
                let f = b[1] > a[1] ? (level - a[1]) / (b[1] - a[1]) : 1
                return measuredAt.addingTimeInterval((a[0] + (b[0] - a[0]) * f) * 60)
            }
        }
        return nil
    }

    /// The forecast's end (100 %).
    var forecastEnd: Date? { forecast.last.map { measuredAt.addingTimeInterval($0[0] * 60) } }

    /// The forecast as [(time, level, kW)], for the charts.
    var forecastPoints: [(date: Date, soc: Double, kw: Double)] {
        forecast.map { (date: measuredAt.addingTimeInterval($0[0] * 60), soc: $0[1], kw: $0[2]) }
    }
}

/// The last snapshot, kept for the next start (shown at once, before the relay answers).
enum SnapshotCache {
    private static let key = "lastSnapshot"

    static func save(_ snapshot: LiveSnapshot?, defaults: UserDefaults = .standard) {
        guard let snapshot, let data = try? JSONEncoder().encode(snapshot) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }

    static func load(defaults: UserDefaults = .standard) -> LiveSnapshot? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(LiveSnapshot.self, from: data)
    }
}
