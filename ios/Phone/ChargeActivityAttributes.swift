import ActivityKit
import Foundation

/// The Live Activity of a charge (Lock Screen, Dynamic Island, and the Apple Watch's Smart Stack).
struct ChargeActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// At measuredAt.
        var soc: Double
        var kw: Double
        var cellT: Double?
        var target: Double
        /// When the target is reached, along the forecast; the views count down to it by themselves, so the
        /// activity keeps moving while the app cannot update it.
        var eta: Date?
        var measuredAt: Date
        var kwh: Double?
        var ended: Bool
    }

    var sessionId: Double
    var kind: String
    var startedAt: Date
    var soc0: Double
}

extension ChargeActivityAttributes.ContentState {
    init(snapshot s: LiveSnapshot) {
        self.init(soc: s.state.soc ?? 0, kw: s.state.kw ?? 0, cellT: s.state.cellT, target: s.target,
                  eta: s.eta(s.target), measuredAt: s.measuredAt, kwh: s.state.session?.kwh, ended: !s.state.isCharging)
    }
}
