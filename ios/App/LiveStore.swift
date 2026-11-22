import BackgroundTasks
import Foundation
import SwiftUI

/// The app's state: the pairing, the newest snapshot and curve from the relay, and what to do with them.
/// Polls while the app is in front (every 5 s while charging, else every 30 s), now and then in the background,
/// and keeps the Live Activity and the Watch in step.
@MainActor
final class LiveStore: ObservableObject {
    nonisolated static let refreshTask = (Bundle.main.bundleIdentifier ?? "i4laden") + ".refresh"

    @Published private(set) var pairing: Pairing?
    @Published private(set) var snapshot: LiveSnapshot?
    @Published private(set) var curve: LiveCurve?
    @Published private(set) var error: String?
    @Published private(set) var lastFetch: Date?
    @Published var autoActivity: Bool {
        didSet { UserDefaults.standard.set(autoActivity, forKey: "autoActivity") }
    }

    let watch = PhoneWatchLink()
    private var poller: Task<Void, Never>?

    init() {
        autoActivity = UserDefaults.standard.object(forKey: "autoActivity") as? Bool ?? true
        pairing = KeychainStore.loadPairing()
        snapshot = pairing == nil ? nil : SnapshotCache.load()
        watch.activate(link: pairing?.link ?? "")
    }

    // MARK: pairing

    /// From the link in the head unit's QR code (the camera opens the app with it) or pasted.
    @discardableResult
    func pair(with url: URL) -> Bool {
        guard let p = Pairing(link: url) else {
            error = LiveError.badLink.errorDescription
            return false
        }
        if p != pairing {
            KeychainStore.savePairing(p)
            pairing = p
            snapshot = nil
            curve = nil
            SnapshotCache.save(nil)
        }
        error = nil
        watch.send(link: p.link)
        Task { await refresh() }
        return true
    }

    func unpair() {
        KeychainStore.savePairing(nil)
        pairing = nil
        snapshot = nil
        curve = nil
        error = nil
        SnapshotCache.save(nil)
        watch.send(link: "")
        Task { await ActivityController.endAll() }
    }

    // MARK: polling

    var interval: TimeInterval { snapshot?.state.isCharging == true ? 5 : 30 }

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
            guard p == pairing else { return }          // unpaired or paired again meanwhile
            let now = Date()
            lastFetch = now
            error = nil
            if let s = f.state {
                let snap = LiveSnapshot(state: s, measuredAt: now.addingTimeInterval(-(f.stateAge ?? 0)), fetchedAt: now)
                if snap != snapshot { snapshot = snap; SnapshotCache.save(snap) }
            }
            if let c = f.curve { curve = c } else if f.curveSeq == nil { curve = nil }
            await ActivityController.sync(snapshot, start: autoActivity)
            scheduleBackgroundRefresh()
        } catch is CancellationError {
            return
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: background

    /// While a charge goes on: ask iOS for a refresh in 5 minutes (it decides when; often later).
    func scheduleBackgroundRefresh() {
        guard pairing != nil, snapshot?.state.isCharging == true else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTask)
        request.earliestBeginDate = Date().addingTimeInterval(5 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func backgroundRefresh() async {
        await refresh()
    }
}
