import Charts
import SwiftUI

enum ChartSeries {
    static let own = "Diese Ladung"
    static let ref = "Referenz"
    static let expected = "Erwartet"
    static let forecast = "Prognose"
}

struct ChartPoint: Identifiable {
    let id: Int
    let series: String
    let x: Double
    let y: Double
}

/// kW over the charge level: this charge (or the last one), its reference, what the car is expected to take at
/// the cells' temperature now, and the forecast for the rest of the charge.
struct PowerCurveChart: View {
    var curve: LiveCurve?
    var snapshot: LiveSnapshot?
    var showsLegend = true

    var body: some View {
        Chart(points) { p in
            LineMark(x: .value("Ladestand", p.x), y: .value("Leistung", p.y), series: .value("Serie", p.series))
                .foregroundStyle(by: .value("Serie", p.series))
                .lineStyle(Self.style(p.series))
        }
        .chartForegroundStyleScale([ChartSeries.own: Color.green, ChartSeries.ref: Color.blue,
                                    ChartSeries.expected: Color.gray, ChartSeries.forecast: Color.mint])
        .chartXScale(domain: 0.0...100.0)
        .chartXAxisLabel("Ladestand %")
        .chartYAxisLabel("kW")
        .chartLegend(showsLegend ? .visible : .hidden)
    }

    static func style(_ series: String) -> StrokeStyle {
        switch series {
        case ChartSeries.own: return StrokeStyle(lineWidth: 3, lineCap: .round)
        case ChartSeries.ref: return StrokeStyle(lineWidth: 2)
        default: return StrokeStyle(lineWidth: 1.5, dash: [4, 3])
        }
    }

    var points: [ChartPoint] {
        var out: [ChartPoint] = []
        func add(_ series: String, _ x: Double?, _ y: Double?) {
            guard let x, let y, x.isFinite, y.isFinite else { return }
            out.append(ChartPoint(id: out.count, series: series, x: x, y: y))
        }
        if let exp = curve?.exp { for p in exp.pts where p.count >= 2 { add(ChartSeries.expected, p[0], p[1]) } }
        if let ref = curve?.ref { for p in ref.pts where p.count >= 2 { add(ChartSeries.ref, p[0], p[1]) } }
        if let pts = curve?.pts { for p in pts where p.count >= 3 { add(ChartSeries.own, p[1], p[2]) } }
        if let snap = snapshot, snap.state.isCharging, curve?.live ?? true {
            for f in snap.forecast { add(ChartSeries.forecast, f[1], f[2]) }
        }
        return out
    }
}

struct TimePoint: Identifiable {
    let id: Int
    let date: Date
    let soc: Double
}

/// The charge level over time: so far (the curve) and as expected (the forecast), with the target.
struct SocTimeChart: View {
    var curve: LiveCurve?
    var snapshot: LiveSnapshot

    var body: some View {
        Chart {
            ForEach(own) { p in
                LineMark(x: .value("Zeit", p.date), y: .value("Ladestand", p.soc), series: .value("Serie", ChartSeries.own))
                    .foregroundStyle(Color.green)
                    .lineStyle(StrokeStyle(lineWidth: 3, lineCap: .round))
            }
            ForEach(forecast) { p in
                LineMark(x: .value("Zeit", p.date), y: .value("Ladestand", p.soc), series: .value("Serie", ChartSeries.forecast))
                    .foregroundStyle(Color.mint)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
            RuleMark(y: .value("Ziel", snapshot.target))
                .foregroundStyle(Color.secondary)
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                .annotation(position: .top, alignment: .leading) {
                    Text("\(Int(snapshot.target)) %").font(.caption2).foregroundStyle(.secondary)
                }
        }
        .chartYScale(domain: 0.0...100.0)
        .chartYAxisLabel("%")
    }

    /// This charge's points, at their time in this device's clock.
    var own: [TimePoint] {
        guard let c = curve, let t0 = c.t0, let session = snapshot.state.session, c.id == session.id else { return [] }
        var out: [TimePoint] = []
        for p in c.pts where p.count >= 2 {
            guard let m = p[0], let soc = p[1] else { continue }
            out.append(TimePoint(id: out.count, date: snapshot.localDate(headUnitMs: t0 + m * 60000), soc: soc))
        }
        return out
    }

    var forecast: [TimePoint] {
        var out: [TimePoint] = []
        for p in snapshot.forecastPoints { out.append(TimePoint(id: out.count, date: p.date, soc: p.soc)) }
        return out
    }
}
