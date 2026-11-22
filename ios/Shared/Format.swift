import Foundation

/// Numbers, times and durations as German writes them (decimal comma, 24 h).
enum Fmt {
    static let de = Locale(identifier: "de_DE")

    static func num(_ v: Double?, _ digits: Int = 0) -> String {
        guard let v, v.isFinite else { return "--" }
        return v.formatted(.number.precision(.fractionLength(digits)).locale(de))
    }

    static func pct(_ v: Double?, _ digits: Int = 0) -> String { v == nil ? "--" : num(v, digits) + " %" }
    static func kw(_ v: Double?) -> String { v == nil ? "--" : num(v) + " kW" }
    static func kwh(_ v: Double?, _ digits: Int = 1) -> String { v == nil ? "--" : num(v, digits) + " kWh" }
    static func temp(_ v: Double?) -> String { v == nil ? "--" : num(v) + " °C" }

    static func euro(_ v: Double?) -> String {
        guard let v, v.isFinite else { return "--" }
        return v.formatted(.currency(code: "EUR").locale(de))
    }

    /// "14:32"
    static func time(_ d: Date?) -> String {
        guard let d else { return "--" }
        return d.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(de))
    }

    /// "Mo 14:32" for another day, else "14:32"
    static func dayTime(_ d: Date?) -> String {
        guard let d else { return "--" }
        if Calendar.current.isDateInToday(d) { return time(d) }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.twoDigits).locale(de)) + " " + time(d)
    }

    /// "45 s", "12 min", "1:05 h"
    static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(Int(s.rounded())) s" }
        let m = Int((s / 60).rounded())
        if m < 60 { return "\(m) min" }
        return String(format: "%d:%02d h", m / 60, m % 60)
    }

    /// "vor 12 s", "vor 3 min"
    static func ago(_ d: Date, now: Date = Date()) -> String { "vor " + duration(now.timeIntervalSince(d)) }
}
