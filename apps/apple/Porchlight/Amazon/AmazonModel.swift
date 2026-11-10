import Foundation
import Observation
import OSLog
import PorchKit

/// The app's Amazon importer: Connect, Disconnect, and imports on a schedule
/// (SPEC §6). The rules (15-minute floor, what counts as a failure, what is
/// reported) live in PorchKit's AmazonImportCoordinator; this wires them to
/// the web view and the app's lifecycle.
@Observable
@MainActor
final class AmazonModel {
    private(set) var status: AmazonLocalStatus
    private(set) var running = false
    private(set) var nextAllowedAt: Date?
    /// While this device isn't signed in to Amazon: the status another device
    /// reported, so Settings can say Amazon is already connected there.
    private(set) var elsewhere: AmazonIntegration?

    @ObservationIgnored private let engine = AmazonWebEngine()
    @ObservationIgnored private let coordinator: AmazonImportCoordinator
    @ObservationIgnored private let api: any APIClient
    @ObservationIgnored private let signedIn: @MainActor () -> Bool
    /// Called after an import that sent packages, so the app syncs and shows them.
    @ObservationIgnored private let didImport: @MainActor () -> Void
    /// The local packages, so the Mac timer can tell when a delivery is close.
    @ObservationIgnored private let packages: @Sendable () async -> [Package]
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private let log = Logger(subsystem: "co.xanom.porchlight", category: "amazon")

    init(
        api: any APIClient, signedIn: @escaping @MainActor () -> Bool,
        didImport: @escaping @MainActor () -> Void = {}, packages: @escaping @Sendable () async -> [Package] = { [] },
        defaults: UserDefaults = .standard
    ) {
        let store = DefaultsAmazonStatusStore(defaults: defaults)
        let loader = AmazonWebPageLoader(engine: engine)
        let names = OnDeviceItemNames()
        coordinator = AmazonImportCoordinator(store: store, api: api) {
            AmazonImporter(loader: loader, api: api, names: names)
        }
        self.api = api
        self.signedIn = signedIn
        self.didImport = didImport
        self.packages = packages
        status = store.load()
    }

    var connected: Bool { status.connected }

    /// After the Connect sheet reaches Your Orders: mark connected and import right away.
    func didSignIn() async {
        engine.reopen()
        await coordinator.connected()
        await reload()
        await importIfDue()
    }

    /// Removes the Amazon sign-in from this device and clears the status on the server.
    func disconnect() async {
        timer?.cancel()
        timer = nil
        engine.tearDown()
        await coordinator.disconnected()
        do {
            try await AmazonWebStore.remove()
        } catch {
            log.error("could not remove the Amazon data store: \(String(describing: error), privacy: .public)")
        }
        await reload()
        #if os(macOS)
        startTimer()
        #endif
    }

    /// Imports unless one ran in the last 15 minutes, nobody is signed in to
    /// Porchlight, or Amazon isn't connected. Safe to call often. `deadline`
    /// caps the time spent reading track pages (an iOS background refresh).
    func importIfDue(deadline: Date? = nil) async {
        await run(deadline: deadline, minimumInterval: AmazonImportCoordinator.minimumInterval)
    }

    /// Refresh on an Amazon package: import now unless one started in the last 2 minutes.
    func importNow() async {
        await run(deadline: nil, minimumInterval: AmazonImportCoordinator.manualMinimumInterval)
    }

    private func run(deadline: Date?, minimumInterval: TimeInterval) async {
        guard signedIn(), status.connected, !running else { return }
        running = true
        let before = status.lastImportAt
        status = await coordinator.runIfDue(deadline: deadline, minimumInterval: minimumInterval)
        running = false
        await reload()
        // A background refresh has synced already and has no time for another.
        if status.lastImportAt != before, (status.lastCount ?? 0) > 0, deadline == nil { didImport() }
    }

    func reload() async {
        status = await coordinator.status
        nextAllowedAt = await coordinator.nextAllowedAt()
        await loadElsewhere()
    }

    private func loadElsewhere() async {
        guard !status.connected, signedIn() else {
            elsewhere = nil
            return
        }
        do {
            elsewhere = try await api.amazonIntegration()
        } catch {
            // Settings then just offers Connect, as before.
            log.error("could not load the Amazon status: \(String(describing: error), privacy: .public)")
        }
    }

    #if os(macOS)
    /// While the app runs: every 5 minutes, import if the last good import is
    /// over half an hour old, or 10 minutes when a delivery is close
    /// (AmazonImportCoordinator.isDueOnMac, AmazonActivity.isBusy).
    func startTimer() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: AmazonImportCoordinator.macTick)
            }
        }
    }

    private func tick() async {
        let busy = AmazonActivity.isBusy(await packages(), now: Date(), timeZone: .current)
        guard await coordinator.isDueOnMac(busy: busy) else { return }
        await run(deadline: nil, minimumInterval: busy ? AmazonImportCoordinator.macBusyInterval : AmazonImportCoordinator.minimumInterval)
    }
    #endif
}
