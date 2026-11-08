import Foundation
import OSLog
import PorchKit
#if os(iOS)
import BackgroundTasks
#endif

/// Background syncs: `BGAppRefreshTask` on iOS (SwiftUI's `.backgroundTask`
/// in PorchlightApp runs it), a 15-minute timer on macOS while the app runs.
@MainActor
final class RefreshScheduler {
    private let sync: BackgroundSync
    /// Runs after a sync that changed the store, so screens on show reload.
    private let didChangeStore: @MainActor () -> Void
    private let log = Logger(subsystem: "co.xanom.porchlight", category: "refresh")
    #if os(macOS)
    private var timer: Task<Void, Never>?
    #endif

    init(sync: BackgroundSync, didChangeStore: @escaping @MainActor () -> Void) {
        self.sync = sync
        self.didChangeStore = didChangeStore
    }

    func run() async -> BackgroundSyncResult {
        let result = await sync.run()
        if result == .newData { didChangeStore() }
        return result
    }

    #if os(iOS)
    /// Asks iOS for the next refresh. iOS decides when, if ever, it runs.
    func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: PorchConfig.refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: BackgroundSync.iOSEarliestBegin)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            log.error("could not schedule app refresh: \(String(describing: error), privacy: .public)")
        }
    }
    #else
    func startTimer() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: BackgroundSync.macInterval)
                guard !Task.isCancelled, let self else { return }
                _ = await self.run()
            }
        }
    }
    #endif
}
