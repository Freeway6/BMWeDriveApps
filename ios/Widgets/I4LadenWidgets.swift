import ActivityKit
import SwiftUI
import WidgetKit

@main
struct I4LadenWidgets: WidgetBundle {
    var body: some Widget {
        ChargeLiveActivity()
    }
}

/// The charge on the Lock Screen and in the Dynamic Island; on the Apple Watch (Smart Stack) and in CarPlay as the
/// small family. Between updates the countdown and the bar to the target run on by themselves (timer views).
struct ChargeLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ChargeActivityAttributes.self) { context in
            ChargeActivityView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.75))
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Fmt.pct(context.state.soc)).font(.title2.bold()).monospacedDigit()
                        Text(context.attributes.kind + " " + Fmt.kw(context.state.kw)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    EtaLabel(state: context.state).font(.caption)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        TargetBar(state: context.state).frame(height: 6)
                        StandLabel(state: context.state, isStale: context.isStale).font(.caption2)
                    }
                }
            } compactLeading: {
                Image(systemName: "bolt.fill").foregroundStyle(.green)
            } compactTrailing: {
                Text("\(Int(context.state.soc.rounded())) %").font(.caption2.bold()).monospacedDigit()
            } minimal: {
                Text("\(Int(context.state.soc.rounded()))").font(.caption2.bold()).monospacedDigit()
            }
        }
        .supplementalActivityFamilies([.small, .medium])
    }
}

struct ChargeActivityView: View {
    let context: ActivityViewContext<ChargeActivityAttributes>
    @Environment(\.activityFamily) private var family

    var body: some View {
        switch family {
        case .small:
            SmallChargeView(state: context.state, isStale: context.isStale)
        default:
            LockScreenChargeView(context: context)
        }
    }
}

struct LockScreenChargeView: View {
    let context: ActivityViewContext<ChargeActivityAttributes>

    var body: some View {
        let s = context.state
        return HStack(spacing: 14) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.2), lineWidth: 6)
                Circle().trim(from: 0, to: min(1, max(0, s.soc / 100)))
                    .stroke(Color.green, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(s.soc.rounded()))").font(.headline.bold()).monospacedDigit()
            }
            .frame(width: 54, height: 54)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(s.ended ? "Ladung beendet" : Fmt.kw(s.kw)).font(.title3.bold()).monospacedDigit()
                    Text(context.attributes.kind).font(.caption.bold()).foregroundStyle(.green)
                    if let t = s.cellT { Text(Fmt.temp(t)).font(.caption).foregroundStyle(.secondary) }
                }
                EtaLabel(state: s).font(.subheadline)
                TargetBar(state: s).frame(height: 6)
                StandLabel(state: s, isStale: context.isStale).font(.caption2)
            }
        }
        .padding(14)
    }
}

/// The Apple Watch's Smart Stack (and CarPlay).
struct SmallChargeView: View {
    let state: ChargeActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(Int(state.soc.rounded())) %").font(.title3.bold()).monospacedDigit()
                Text(Fmt.kw(state.kw)).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            EtaLabel(state: state).font(.caption2)
        }
        .padding(8)
    }
}

/// "80 % in 12:34" (counting down by itself), "80 % erreicht", or the end.
struct EtaLabel: View {
    let state: ChargeActivityAttributes.ContentState

    var body: some View {
        let now = Date()
        if state.ended {
            Text("\(Int(state.soc.rounded())) % geladen")
        } else if state.soc >= state.target {
            Text("\(Int(state.target)) % erreicht")
        } else if let eta = state.eta, eta > now {
            HStack(spacing: 4) {
                Text("\(Int(state.target)) % in")
                Text(timerInterval: now...eta, countsDown: true).monospacedDigit()
            }
        } else {
            Text("\(Int(state.target)) % gleich erreicht")
        }
    }
}

/// From the last measurement to the target, filling with the time by itself.
struct TargetBar: View {
    let state: ChargeActivityAttributes.ContentState

    var body: some View {
        if let eta = state.eta, eta > state.measuredAt, !state.ended {
            ProgressView(timerInterval: state.measuredAt...eta, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                .tint(.green)
        } else {
            ProgressView(value: min(1, max(0, state.soc / 100))).tint(.green)
        }
    }
}

/// "Live 14:32" or, once the head unit has been quiet for a while, "Prognose seit 14:32".
struct StandLabel: View {
    let state: ChargeActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        Text((isStale ? "Prognose, Stand " : "Live, Stand ") + Fmt.time(state.measuredAt) + (state.kwh.map { "   " + Fmt.kwh($0) } ?? ""))
            .foregroundStyle(.secondary)
    }
}
