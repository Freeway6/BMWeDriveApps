import Foundation
import WatchConnectivity

/// Receives the pairing link from the iPhone app (application context), and asks for it when the watch app has
/// none yet (a watch app installed after the pairing).
final class WatchPhoneLink: NSObject, WCSessionDelegate {
    /// Called on the main thread with the link ("" when the iPhone unpaired).
    var onLink: ((String) -> Void)?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func ask() {
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["want": "pairing"], replyHandler: { [weak self] reply in
            if let link = reply["pairing"] as? String { self?.deliver(link) }
        }, errorHandler: nil)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        if let link = session.receivedApplicationContext["pairing"] as? String { deliver(link) } else { ask() }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let link = applicationContext["pairing"] as? String { deliver(link) }
    }

    private func deliver(_ link: String) {
        DispatchQueue.main.async { self.onLink?(link) }
    }
}
