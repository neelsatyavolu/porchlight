import Foundation
import Observation
import OSLog
import PorchKit

/// Reads USPS, UPS and FedEx tracking pages on this device when the server
/// asks (docs/API.md, "Device tracking"). The pace and the rules live in
/// PorchKit's DeviceTrackingCoordinator; this wires them to the hidden web
/// view and the app's lifecycle: every 5 minutes on the Mac while the app or
/// its menu-bar item runs, and on iOS when the app comes forward and inside
/// the background refresh.
@Observable
@MainActor
final class CarrierTrackingModel {
    /// When the app last asked which carrier pages to check. Nil before the first time.
    private(set) var lastCheckedAt: Date?
    private(set) var running = false

    @ObservationIgnored private let engine = CarrierWebEngine()
    @ObservationIgnored private let coordinator: DeviceTrackingCoordinator
    @ObservationIgnored private let signedIn: @MainActor () -> Bool
    /// Runs after a check that posted readings, so the list picks up what the server applied.
    @ObservationIgnored private let didPost: @MainActor () -> Void
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private let log = Logger(subsystem: "co.xanom.porchlight", category: "carriers")

    init(
        api: any APIClient, signedIn: @escaping @MainActor () -> Bool, didPost: @escaping @MainActor () -> Void,
        defaults: UserDefaults = .standard
    ) {
        let store = DefaultsDeviceTrackingStateStore(defaults: defaults)
        coordinator = DeviceTrackingCoordinator(api: api, reader: CarrierWebPageReader(engine: engine), store: store)
        self.signedIn = signedIn
        self.didPost = didPost
        lastCheckedAt = store.load().lastCheckedAt
    }

    /// Refresh on a USPS, UPS or FedEx package: the server has just marked it due,
    /// so read it now instead of on the next 5-minute tick. Returns once posted.
    func checkNow() async { await checkIfDue() }

    /// Reads whatever is due, unless nobody is signed in or a check is running.
    /// `deadline` bounds an iOS background refresh (DeviceTrackingCoordinator.backgroundBudget).
    func checkIfDue(deadline: Date? = nil) async {
        guard signedIn(), !running else { return }
        running = true
        let run = await coordinator.runIfDue(deadline: deadline)
        running = false
        lastCheckedAt = await coordinator.lastCheckedAt
        if let error = run.error { log.error("\(error, privacy: .public)") }
        // A background refresh has synced already and has no time for another.
        if !run.outcomes.isEmpty, deadline == nil { didPost() }
    }

    #if os(macOS)
    func startTimer() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkIfDue()
                try? await Task.sleep(for: DeviceTrackingCoordinator.macInterval)
            }
        }
    }
    #endif
}
