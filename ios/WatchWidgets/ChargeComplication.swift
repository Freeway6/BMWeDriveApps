import SwiftUI
import WidgetKit

@main
struct I4LadenWatchWidgets: WidgetBundle {
    var body: some Widget {
        ChargeComplication()
    }
}

struct ChargeEntry: TimelineEntry {
    let date: Date
    let soc: Double?
    let kw: Double?
    let target: Double
    let eta: Date?
    let charging: Bool
    let live: Bool
}

/// The watch face: entries every 2 minutes along the forecast until the charge should be full, from the snapshot the
/// watch app last fetched; so the complication moves on while nothing new comes.
struct ChargeProvider: TimelineProvider {
    func placeholder(in context: Context) -> ChargeEntry {
        ChargeEntry(date: Date(), soc: 54, kw: 142, target: 80, eta: Date().addingTimeInterval(14 * 60), charging: true, live: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (ChargeEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : (entries(from: ComplicationStore.load(), now: Date()).first ?? placeholder(in: context)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ChargeEntry>) -> Void) {
        let now = Date(), list = entries(from: ComplicationStore.load(), now: now)
        let next = list.count > 1 ? (list.last?.date ?? now).addingTimeInterval(60) : now.addingTimeInterval(30 * 60)
        completion(Timeline(entries: list, policy: .after(next)))
    }

    func entries(from snapshot: LiveSnapshot?, now: Date) -> [ChargeEntry] {
        guard let s = snapshot else {
            return [ChargeEntry(date: now, soc: nil, kw: nil, target: 80, eta: nil, charging: false, live: false)]
        }
        guard s.state.isCharging else {
            return [ChargeEntry(date: now, soc: s.state.soc, kw: nil, target: s.target, eta: nil, charging: false, live: s.isLive(at: now))]
        }
        let end = s.forecastEnd ?? now, eta = s.eta(s.target)
        var out: [ChargeEntry] = []
        var d = now
        for _ in 0..<45 {
            let live = s.isLive(at: d)
            let p = live ? (soc: s.state.soc ?? 0, kw: s.state.kw ?? 0) : (s.predicted(at: d) ?? (soc: s.state.soc ?? 0, kw: s.state.kw ?? 0))
            out.append(ChargeEntry(date: d, soc: p.soc, kw: p.kw, target: s.target, eta: eta, charging: true, live: live))
            if d >= end { break }
            d = d.addingTimeInterval(120)
        }
        return out
    }
}

struct ChargeComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ComplicationStore.kind, provider: ChargeProvider()) { entry in
            ComplicationView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("i4 Laden")
        .description("Ladestand und Zeit bis zum Ziel")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ChargeEntry

    private var socText: String { entry.soc.map { "\(Int($0.rounded()))" } ?? "--" }
    private var prefix: String { entry.charging && !entry.live ? "≈" : "" }

    var body: some View {
        switch family {
        case .accessoryCircular:
            Gauge(value: min(100, max(0, entry.soc ?? 0)), in: 0...100) {
                Image(systemName: entry.charging ? "bolt.fill" : "car.fill")
            } currentValueLabel: {
                Text(socText)
            }
            .gaugeStyle(.accessoryCircular)
            .tint(Color.green)
        case .accessoryCorner:
            Text(socText + "%")
                .widgetCurvesContent()
                .widgetLabel {
                    Text(entry.charging ? Fmt.kw(entry.kw) : "lädt nicht")
                }
        case .accessoryInline:
            Text(entry.charging ? prefix + socText + " %  " + Fmt.kw(entry.kw) : "i4 " + socText + " %")
        default:
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Image(systemName: "bolt.car.fill")
                    Text(prefix + socText + " %").font(.headline).monospacedDigit()
                    if entry.charging { Text(Fmt.kw(entry.kw)).font(.caption).monospacedDigit() }
                }
                if entry.charging, let eta = entry.eta {
                    Text(eta > entry.date ? "\(Int(entry.target)) % um " + Fmt.time(eta) : "\(Int(entry.target)) % erreicht").font(.caption)
                } else if !entry.charging {
                    Text("lädt nicht").font(.caption)
                }
                Gauge(value: min(100, max(0, entry.soc ?? 0)), in: 0...100) { EmptyView() }
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(Color.green)
            }
        }
    }
}
