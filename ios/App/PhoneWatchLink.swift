import Foundation
import WatchConnectivity

/// Hands the pairing link to the Apple Watch app (WatchConnectivity's application context: the watch gets the
/// newest one, also when it was not running), and answers the watch when it asks for it.
final class PhoneWatchLink: NSObject, WCSessionDelegate {
    /// The link to hand over ("" when unpaired); touched on the main thread only.
    private var link = ""

    func activate(link: String) {
        self.link = link
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(link: String) {
        self.link = link
        push()
    }

    private func push() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        try? session.updateApplicationContext(["pairing": link, "at": Date().timeIntervalSince1970])
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.push() }
    }

    func sessionWatchStateDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.push() }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    /// The watch asks: { "want": "pairing" } -> { "pairing": link }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async { replyHandler(["pairing": self.link]) }
    }
}
