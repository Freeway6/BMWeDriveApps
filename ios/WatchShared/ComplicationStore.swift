import Foundation

/// The newest snapshot for the watch face: the watch app writes it, its complications read it (an App Group both
/// share; on the watch App Groups need no paid developer membership). The complications need no key and no network:
/// they go along the snapshot's forecast.
enum ComplicationStore {
    static let kind = "I4LadenCharge"

    private static var defaults: UserDefaults {
        if let group = Bundle.main.object(forInfoDictionaryKey: "I4AppGroup") as? String, !group.isEmpty,
           let shared = UserDefaults(suiteName: group) {
            return shared
        }
        return .standard
    }

    static func save(_ snapshot: LiveSnapshot?) { SnapshotCache.save(snapshot, defaults: defaults) }
    static func load() -> LiveSnapshot? { SnapshotCache.load(defaults: defaults) }
}
