import ActivityKit
import Foundation

/// The charge's Live Activity: started when the app sees a charge (iOS allows that only while the app is in
/// front), updated with every new snapshot, ended when the charge is over. Between updates its views count down
/// to the forecast's time by themselves; after LiveSnapshot.staleAfter without word it shows as a forecast.
enum ActivityController {
    @MainActor
    static func sync(_ snapshot: LiveSnapshot?, start: Bool) async {
        let current = Activity<ChargeActivityAttributes>.activities
        guard let snap = snapshot, snap.state.isCharging, let session = snap.state.session else {
            for activity in current {
                var state = activity.content.state
                state.ended = true
                await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(20 * 60)))
            }
            return
        }
        let content = ActivityContent(state: ChargeActivityAttributes.ContentState(snapshot: snap),
                                      staleDate: snap.measuredAt.addingTimeInterval(LiveSnapshot.staleAfter))
        if let mine = current.first(where: { $0.attributes.sessionId == session.id }) {
            await mine.update(content)
            for other in current where other.id != mine.id {
                await other.end(nil, dismissalPolicy: .immediate)
            }
            return
        }
        for other in current {
            await other.end(nil, dismissalPolicy: .immediate)
        }
        guard start, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attributes = ChargeActivityAttributes(sessionId: session.id, kind: snap.state.kind ?? "DC",
                                                  startedAt: snap.localDate(headUnitMs: session.t0),
                                                  soc0: session.soc0 ?? snap.state.soc ?? 0)
        // (throws when the app is not in front: then at the next start)
        _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
    }

    static func endAll() async {
        for activity in Activity<ChargeActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}
