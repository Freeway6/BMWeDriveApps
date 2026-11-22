import SwiftUI

@main
struct I4LadenWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @StateObject private var store = WatchStore.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(store)
                .onAppear { store.startPolling() }
                .onChange(of: phase) { _, now in
                    if now == .active { store.startPolling() } else { store.stopPolling() }
                }
        }
    }
}

struct WatchRootView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        if store.pairing == nil {
            NotPairedView()
        } else {
            TabView {
                WatchNowView()
                WatchDetailsView()
                WatchCurveView()
            }
            .tabViewStyle(.verticalPage)
        }
    }
}

struct NotPairedView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: "iphone.and.arrow.forward").font(.title2).foregroundStyle(.green)
                Text("Noch nicht gekoppelt").font(.headline)
                Text("In der iPhone-App \"i4 Laden\" den QR-Code der Headunit scannen: die Kopplung kommt dann von selbst auf die Uhr.")
                    .font(.footnote).multilineTextAlignment(.center)
                Button("Vom iPhone holen") { store.askPhone() }
            }
            .padding(.horizontal, 4)
        }
    }
}

/// The charge level, power and the time to the target; live or along the forecast.
struct WatchNowView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            VStack(spacing: 4) {
                if let snap = store.snapshot {
                    let live = snap.isLive(at: context.date)
                    let charging = snap.state.isCharging
                    let p = charging && !live ? (snap.predicted(at: context.date) ?? (soc: snap.state.soc ?? 0, kw: snap.state.kw ?? 0)) : (soc: snap.state.soc ?? 0, kw: snap.state.kw ?? 0)
                    Gauge(value: min(100, max(0, p.soc)), in: 0...100) {
                        Image(systemName: "bolt.fill")
                    } currentValueLabel: {
                        Text((live ? "" : "≈") + Fmt.num(p.soc))
                    }
                    .gaugeStyle(.circular)
                    .tint(Gradient(colors: [.green, .mint]))
                    .scaleEffect(1.25)
                    .padding(.vertical, 8)
                    if charging {
                        Text(Fmt.kw(p.kw)).font(.title3.bold()).monospacedDigit()
                        if let eta = snap.eta(snap.target), eta > context.date {
                            Text("\(Int(snap.target)) % um " + Fmt.time(eta)).font(.footnote)
                        } else if p.soc >= snap.target {
                            Text("\(Int(snap.target)) % erreicht").font(.footnote)
                        }
                    } else {
                        Text("Lädt nicht").font(.headline)
                    }
                    Text(live ? "Live, " + Fmt.ago(snap.measuredAt, now: context.date) : "Prognose, Stand " + Fmt.time(snap.measuredAt))
                        .font(.caption2)
                        .foregroundStyle(live ? Color.green : Color.orange)
                } else if let error = store.error {
                    Text(error).font(.footnote).multilineTextAlignment(.center)
                } else {
                    ProgressView()
                }
            }
        }
    }
}

struct WatchDetailsView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if let s = store.snapshot {
                    if let session = s.state.session {
                        WatchRow(label: "Geladen", value: Fmt.kwh(session.kwh))
                        WatchRow(label: "Start", value: Fmt.pct(session.soc0) + ", " + Fmt.time(s.localDate(headUnitMs: session.t0)))
                        WatchRow(label: "Spitze", value: Fmt.kw(session.peak))
                        WatchRow(label: "Bis 100 %", value: Fmt.time(s.eta(100)))
                        if session.cost != nil { WatchRow(label: "Kosten", value: Fmt.euro(session.cost)) }
                    } else if let last = s.state.last {
                        Text("Letzte Ladung").font(.headline)
                        WatchRow(label: "Wann", value: Fmt.dayTime(s.localDate(headUnitMs: last.t0)))
                        WatchRow(label: "Ladestand", value: Fmt.pct(last.soc0) + " → " + Fmt.pct(last.soc1))
                        WatchRow(label: "Energie", value: Fmt.kwh(last.kwh))
                    }
                    if let t = s.state.cellT { WatchRow(label: "Zellen", value: Fmt.temp(t)) }
                    if let error = store.error { Text(error).font(.caption2).foregroundStyle(.orange) }
                }
            }
            .padding(.horizontal, 4)
        }
    }
}

struct WatchRow: View {
    var label: String
    var value: String

    var body: some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(.footnote)
    }
}

struct WatchCurveView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("kW über Ladestand").font(.caption2).foregroundStyle(.secondary)
            PowerCurveChart(curve: store.curve, snapshot: store.snapshot, showsLegend: false)
        }
        .padding(.horizontal, 4)
    }
}
