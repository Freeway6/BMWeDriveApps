import Foundation
import WatchKit
import WidgetKit

/// The watch app's state: the pairing (from the iPhone), the newest snapshot and curve, read straight from the
/// relay (the watch has its own connection through the iPhone, Wi-Fi or LTE). Polls while the app is in front
/// (every 10 s while charging), refreshes now and then in the background, and keeps the complications in step.
@MainActor
final class WatchStore: ObservableObject {
    static let shared = WatchStore()

    @Published private(set) var pairing: Pairing?
    @Published private(set) var snapshot: LiveSnapshot?
    @Published private(set) var curve: LiveCurve?
    @Published private(set) var error: String?

    private let phone = WatchPhoneLink()
    private var poller: Task<Void, Never>?

    private init() {
        pairing = KeychainStore.loadPairing()
        snapshot = pairing == nil ? nil : SnapshotCache.load()
        phone.onLink = { [weak self] link in self?.received(link) }
        phone.activate()
    }

    /// The pairing link from the iPhone ("" when the iPhone unpaired).
    func received(_ link: String) {
        if link.isEmpty {
            if pairing != nil { unpair() }
            return
        }
        guard let p = Pairing(link: link), p != pairing else { return }
        KeychainStore.savePairing(p)
        pairing = p
        snapshot = nil
        curve = nil
        error = nil
        SnapshotCache.save(nil)
        ComplicationStore.save(nil)
        reloadComplications()
        Task { await refresh() }
    }

    func unpair() {
        KeychainStore.savePairing(nil)
        pairing = nil
        snapshot = nil
        curve = nil
        SnapshotCache.save(nil)
        ComplicationStore.save(nil)
        reloadComplications()
    }

    func askPhone() { phone.ask() }

    var interval: TimeInterval { snapshot?.state.isCharging == true ? 10 : 60 }

    func startPolling() {
        poller?.cancel()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
            }
        }
    }

    func stopPolling() {
        poller?.cancel()
        poller = nil
    }

    func refresh() async {
        guard let p = pairing else { return }
        do {
            let f = try await RelayClient(pairing: p).fetch(haveCurve: curve?.seq)
            guard p == pairing else { return }
            let now = Date()
            error = nil
            if let s = f.state {
                let snap = LiveSnapshot(state: s, measuredAt: now.addingTimeInterval(-(f.stateAge ?? 0)), fetchedAt: now)
                if snap != snapshot {
                    snapshot = snap
                    SnapshotCache.save(snap)
                    ComplicationStore.save(snap)
                    reloadComplications()
                }
            }
            if let c = f.curve { curve = c } else if f.curveSeq == nil { curve = nil }
            scheduleBackgroundRefresh()
        } catch is CancellationError {
            return
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func reloadComplications() {
        WidgetCenter.shared.reloadTimelines(ofKind: ComplicationStore.kind)
    }

    /// watchOS decides when; while charging asked for every 15 minutes, else hourly.
    func scheduleBackgroundRefresh() {
        guard pairing != nil else { return }
        let wait: TimeInterval = snapshot?.state.isCharging == true ? 15 * 60 : 60 * 60
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: Date().addingTimeInterval(wait), userInfo: nil) { _ in }
    }
}

/// Background refreshes: fetch, hand the complications the new snapshot, done.
final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        Task { @MainActor in WatchStore.shared.scheduleBackgroundRefresh() }
    }

    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            if let refresh = task as? WKApplicationRefreshBackgroundTask {
                Task { @MainActor in
                    await WatchStore.shared.refresh()
                    refresh.setTaskCompletedWithSnapshot(false)
                }
            } else {
                task.setTaskCompletedWithSnapshot(false)
            }
        }
    }
}
