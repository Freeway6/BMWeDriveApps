import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: LiveStore
    @State private var showsSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if store.pairing == nil { PairingView() } else { LiveView() }
            }
            .navigationTitle("i4 Laden")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showsSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Einstellungen")
                }
            }
            .sheet(isPresented: $showsSettings) { SettingsView() }
        }
    }
}

// MARK: - live

struct LiveView: View {
    @EnvironmentObject private var store: LiveStore

    var body: some View {
        // redrawn every few seconds: the age of the data and the forecast move on between fetches
        TimelineView(.periodic(from: .now, by: 5)) { context in
            ScrollView {
                VStack(spacing: 16) {
                    StatusBanner(snapshot: store.snapshot, error: store.error, now: context.date)
                    if let snap = store.snapshot {
                        if snap.state.isCharging {
                            ChargingCard(snapshot: snap, now: context.date)
                            Card(title: "Ladestand über die Zeit") {
                                SocTimeChart(curve: store.curve, snapshot: snap).frame(height: 180)
                            }
                        } else {
                            IdleCard(snapshot: snap)
                        }
                        Card(title: snap.state.isCharging ? "Leistung über den Ladestand" : "Letzte Ladung") {
                            PowerCurveChart(curve: store.curve, snapshot: snap).frame(height: 240)
                        }
                    } else if store.error == nil {
                        ProgressView("Warte auf die erste Nachricht der Headunit …").padding(.top, 40)
                    }
                }
                .padding()
            }
            .refreshable { await store.refresh() }
        }
    }
}

/// Where the data comes from: live, a forecast since the head unit went quiet, or an error.
struct StatusBanner: View {
    var snapshot: LiveSnapshot?
    var error: String?
    var now: Date

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.bold())
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }

    private var live: Bool { snapshot?.isLive(at: now) ?? false }
    private var icon: String { error != nil ? "exclamationmark.triangle.fill" : live ? "dot.radiowaves.left.and.right" : "moon.zzz.fill" }
    private var color: Color { error != nil ? .orange : live ? .green : .blue }
    private var title: String {
        if error != nil { return "Keine Verbindung zum Relay" }
        guard let s = snapshot else { return "Gekoppelt" }
        if live { return "Live von der Headunit" }
        return s.state.isCharging ? "Prognose: die Headunit meldet sich nicht" : "Headunit nicht erreichbar"
    }
    private var detail: String {
        if let error { return error }
        guard let s = snapshot else { return "Noch nichts empfangen" }
        let since: String = "Stand " + Fmt.dayTime(s.measuredAt) + " (" + Fmt.ago(s.measuredAt, now: now) + ")"
        if live { return since }
        return s.state.isCharging ? since + ". Sie schläft oder hat kein Internet; die Werte folgen der erwarteten Ladekurve." : since
    }
}

struct ChargingCard: View {
    var snapshot: LiveSnapshot
    var now: Date

    var body: some View {
        let s = snapshot, live = s.isLive(at: now)
        let p = live ? (soc: s.state.soc ?? 0, kw: s.state.kw ?? 0) : (s.predicted(at: now) ?? (soc: s.state.soc ?? 0, kw: s.state.kw ?? 0))
        let approx = live ? "" : "≈ "
        let eta = s.eta(s.target), full = s.eta(100)
        return Card(title: "Lädt " + (s.state.kind ?? "")) {
            HStack(spacing: 20) {
                SocRing(soc: p.soc, target: s.target, prefix: approx).frame(width: 130, height: 130)
                VStack(alignment: .leading, spacing: 6) {
                    Text(approx + Fmt.kw(p.kw)).font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                    if let t = s.state.cellT {
                        Text("Zellen " + Fmt.temp(t) + (s.state.cellTmax.map { " - " + Fmt.temp($0) } ?? "")).font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let session = s.state.session {
                        Text(Fmt.kwh(session.kwh) + " geladen, seit " + Fmt.duration(now.timeIntervalSince(s.localDate(headUnitMs: session.t0))))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            Divider()
            InfoRow(label: "Bis \(Int(s.target)) %", value: etaText(eta, now: now))
            InfoRow(label: "Bis 100 %", value: etaText(full, now: now))
            if let session = s.state.session {
                InfoRow(label: "Start", value: Fmt.pct(session.soc0) + " um " + Fmt.time(s.localDate(headUnitMs: session.t0)))
                InfoRow(label: "Spitze", value: Fmt.kw(session.peak) + (session.peakSoc.map { " bei " + Fmt.pct($0) } ?? ""))
                if session.cost != nil { InfoRow(label: "Kosten bisher", value: "etwa " + Fmt.euro(session.cost)) }
            }
        }
    }

    private func etaText(_ d: Date?, now: Date) -> String {
        guard let d else { return "--" }
        if d <= now { return "erreicht" }
        return "in " + Fmt.duration(d.timeIntervalSince(now)) + "  (" + Fmt.time(d) + ")"
    }
}

struct IdleCard: View {
    var snapshot: LiveSnapshot

    var body: some View {
        let s = snapshot.state
        return Card(title: "Lädt nicht") {
            HStack(spacing: 20) {
                SocRing(soc: s.soc ?? 0, target: snapshot.target, prefix: "").frame(width: 110, height: 110)
                VStack(alignment: .leading, spacing: 6) {
                    if let stored = s.stored { Text(Fmt.kwh(stored) + " im Akku").font(.headline) }
                    if let t = s.cellT { Text("Zellen " + Fmt.temp(t)).font(.subheadline).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
            }
            if let last = s.last {
                Divider()
                InfoRow(label: "Letzte Ladung", value: (last.kind ?? "") + " " + Fmt.pct(last.soc0) + " → " + Fmt.pct(last.soc1))
                InfoRow(label: "Wann", value: Fmt.dayTime(snapshot.localDate(headUnitMs: last.t0)) + ", " + Fmt.duration((last.t1 - last.t0) / 1000))
                InfoRow(label: "Energie", value: Fmt.kwh(last.kwh) + (last.cost.map { ", etwa " + Fmt.euro($0) } ?? ""))
                InfoRow(label: "Spitze / Mittel", value: Fmt.kw(last.peak) + " / " + Fmt.kw(last.avg))
            }
        }
    }
}

struct SocRing: View {
    var soc: Double
    var target: Double
    var prefix: String

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.2), lineWidth: 12)
            Circle().trim(from: 0, to: min(1, max(0, soc / 100)))
                .stroke(Color.green, style: StrokeStyle(lineWidth: 12, lineCap: .round))
                .rotationEffect(.degrees(-90))
            // the target as a tick on the ring
            Circle().trim(from: max(0, target / 100 - 0.004), to: min(1, target / 100 + 0.004))
                .stroke(Color.primary, style: StrokeStyle(lineWidth: 16))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(prefix + Fmt.num(soc)).font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                Text("%").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct Card<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased()).font(.caption.bold()).foregroundStyle(.secondary)
            content
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}

struct InfoRow: View {
    var label: String
    var value: String

    var body: some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit().multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

// MARK: - pairing

struct PairingView: View {
    @EnvironmentObject private var store: LiveStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "qrcode.viewfinder").font(.system(size: 64)).foregroundStyle(.green)
                Text("Mit dem Auto koppeln").font(.title2.bold())
                VStack(alignment: .leading, spacing: 10) {
                    Step(n: 1, text: "Im Auto: Ladekurve öffnen, Einstellungen → \"Live auf iPhone und Apple Watch\" einschalten.")
                    Step(n: 2, text: "Zur Seite \"iPhone\" blättern: dort steht ein QR-Code.")
                    Step(n: 3, text: "Den Code mit der Kamera-App des iPhones scannen und \"In i4 Laden öffnen\" tippen.")
                }
                Text("Der Code enthält den Schlüssel, mit dem die Headunit die Daten verschlüsselt. Das Relay im Internet sieht nur verschlüsselte Daten.")
                    .font(.footnote).foregroundStyle(.secondary)
                PasteButton(payloadType: String.self) { strings in
                    guard let text = strings.first, let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                    Task { @MainActor in store.pair(with: url) }
                }
                if let error = store.error { Text(error).font(.footnote).foregroundStyle(.orange) }
            }
            .padding()
        }
    }
}

struct Step: View {
    var n: Int
    var text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.headline).frame(width: 26, height: 26).background(Color.green.opacity(0.2), in: Circle())
            Text(text)
        }
    }
}

// MARK: - settings

struct SettingsView: View {
    @EnvironmentObject private var store: LiveStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmsUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                if let p = store.pairing {
                    Section("Kopplung") {
                        LabeledContent("Relay", value: p.relayHost)
                        LabeledContent("Kanal", value: String(p.channel.prefix(8)))
                        if let last = store.lastFetch { LabeledContent("Zuletzt abgefragt", value: Fmt.time(last)) }
                        Button("Kopplung an die Apple Watch senden") { store.watch.send(link: p.link) }
                        Button("Entkoppeln", role: .destructive) { confirmsUnpair = true }
                    }
                }
                Section {
                    Toggle("Live-Aktivität beim Laden", isOn: $store.autoActivity)
                } footer: {
                    Text("Zeigt die Ladung auf dem Sperrbildschirm, in der Dynamic Island und auf der Apple Watch. Starten kann iOS sie nur, wenn die App offen ist: einmal öffnen, sobald die Ladung läuft.")
                }
                Section("So kommen die Daten") {
                    Text("Die Headunit sendet beim Laden alle paar Sekunden, sofern sie wach ist und über das Uplink des MGU Stores Internet hat (LTE-Stick, Handy-Hotspot oder WLAN). Schläft sie (abgeschlossenes Auto), rechnet die App mit der erwarteten Ladekurve weiter und zeigt das als Prognose.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Einstellungen")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } } }
            .confirmationDialog("Kopplung entfernen?", isPresented: $confirmsUnpair, titleVisibility: .visible) {
                Button("Entkoppeln", role: .destructive) { store.unpair(); dismiss() }
            } message: {
                Text("Danach den QR-Code der Headunit erneut scannen.")
            }
        }
    }
}
