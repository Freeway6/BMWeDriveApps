import SwiftUI

@main
struct I4LadenApp: App {
    @StateObject private var store = LiveStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                // the head unit's QR code, scanned with the camera: i4laden://pair?...
                .onOpenURL { url in store.pair(with: url) }
                .onChange(of: phase) { _, now in
                    switch now {
                    case .active: store.startPolling()
                    case .background: store.stopPolling(); store.scheduleBackgroundRefresh()
                    default: break
                    }
                }
        }
        .backgroundTask(.appRefresh(LiveStore.refreshTask)) {
            await store.backgroundRefresh()
        }
    }
}
