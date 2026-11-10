import Foundation

/// This device's Amazon connection, kept on the device only.
public struct AmazonLocalStatus: Hashable, Sendable, Codable {
    /// The person signed in through Connect and hasn't disconnected.
    public var connected: Bool = false
    /// The last definite outcome; nil before the first import.
    public var state: AmazonImportState?
    public var lastImportAt: Date?
    public var lastAttemptAt: Date?
    /// Why the last run didn't work, in one sentence. Also set for a network
    /// failure, which leaves `state` as it was.
    public var lastError: String?
    /// Packages sent by the last import that worked.
    public var lastCount: Int?

    public init() {}
}

public protocol AmazonStatusStoring: Sendable {
    func load() -> AmazonLocalStatus
    func save(_ status: AmazonLocalStatus)
}

/// UserDefaults under one key. Holds no Amazon data, only times and states.
/// UserDefaults is thread-safe, so the unchecked conformance is sound.
public final class DefaultsAmazonStatusStore: AmazonStatusStoring, @unchecked Sendable {
    public static let key = "porchlight.amazon.status"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> AmazonLocalStatus {
        defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(AmazonLocalStatus.self, from: $0) } ?? AmazonLocalStatus()
    }

    public func save(_ status: AmazonLocalStatus) {
        guard let data = try? JSONEncoder().encode(status) else { return }
        defaults.set(data, forKey: Self.key)
    }
}

/// Decides when an import may run, runs it, keeps the local status and
/// reports it to the server (`PUT /v1/integrations/amazon`).
///
/// Imports never start less than 15 minutes apart, whoever asks (SPEC §6).
public actor AmazonImportCoordinator {
    public static let minimumInterval: TimeInterval = 15 * 60
    /// The floor for a Refresh someone pressed on an Amazon package.
    public static let manualMinimumInterval: TimeInterval = 2 * 60
    /// macOS: how often the app checks `isDueOnMac()` while it runs.
    public static let macTick: Duration = .seconds(5 * 60)
    /// macOS: how old the last good import may get before the next one.
    public static let macFreshness: TimeInterval = 30 * 60
    /// macOS, when a delivery is close (AmazonActivity.isBusy): both the floor and the freshness.
    public static let macBusyInterval: TimeInterval = 10 * 60

    private let store: any AmazonStatusStoring
    private let api: any APIClient
    private let importer: @Sendable () -> AmazonImporter
    private let now: @Sendable () -> Date
    private var running = false

    public init(
        store: any AmazonStatusStoring, api: any APIClient, now: @escaping @Sendable () -> Date = Date.init,
        importer: @escaping @Sendable () -> AmazonImporter
    ) {
        self.store = store
        self.api = api
        self.importer = importer
        self.now = now
    }

    public var status: AmazonLocalStatus { store.load() }

    /// The earliest time the next import may start, or nil if it may start now.
    public func nextAllowedAt(minimumInterval: TimeInterval = AmazonImportCoordinator.minimumInterval) -> Date? {
        guard let last = store.load().lastAttemptAt else { return nil }
        let next = last.addingTimeInterval(minimumInterval)
        return next > now() ? next : nil
    }

    /// The Mac's schedule, checked every `macTick`: due once the last good import
    /// is over 30 minutes old (or there was none) and the 15-minute floor has
    /// passed. An attempt that never finished (the app quit mid-run) is retried
    /// 15 minutes after it started, not half an hour after the next launch.
    /// `busy` (a delivery is close) shortens both to 10 minutes.
    public func isDueOnMac(busy: Bool = false) -> Bool {
        let s = store.load()
        let floor = busy ? Self.macBusyInterval : Self.minimumInterval
        guard s.connected, !running, nextAllowedAt(minimumInterval: floor) == nil else { return false }
        guard let last = s.lastImportAt else { return true }
        return now().timeIntervalSince(last) >= (busy ? Self.macBusyInterval : Self.macFreshness)
    }

    /// Call once the Connect sheet reaches a signed-in page. The first import may run right away.
    public func connected() {
        var s = store.load()
        s.connected = true
        s.lastAttemptAt = nil
        s.lastError = nil
        if s.state == .needsSignIn { s.state = nil }
        store.save(s)
    }

    /// Forgets this device's Amazon status and clears the account's on the
    /// server. The app removes the web data store itself.
    public func disconnected() async {
        store.save(AmazonLocalStatus())
        try? await api.clearAmazonStatus()
    }

    /// Runs an import unless one is running, the device isn't connected, or
    /// the last one started under `minimumInterval` ago (15 minutes; 2 for a
    /// Refresh someone pressed). Returns the status after.
    /// `deadline` is passed to the importer (AmazonImporter.deadline).
    @discardableResult
    public func runIfDue(
        deadline: Date? = nil, minimumInterval: TimeInterval = AmazonImportCoordinator.minimumInterval
    ) async -> AmazonLocalStatus {
        var s = store.load()
        guard s.connected, !running, nextAllowedAt(minimumInterval: minimumInterval) == nil else { return s }
        running = true
        defer { running = false }
        s.lastAttemptAt = now()
        store.save(s)

        var run = importer()
        run.deadline = deadline
        let result = await run.run()
        s = store.load()
        guard s.connected else { return s } // Disconnected while it ran.
        switch result {
        case let .imported(items, _):
            s.state = .ok
            s.lastImportAt = now()
            s.lastError = nil
            s.lastCount = items
        case .needsSignIn:
            s.state = .needsSignIn
            s.lastError = "Amazon asked you to sign in again."
        case let .parseFailed(message):
            s.state = .parseFailed
            s.lastError = message
        case let .failed(message):
            s.lastError = message
        }
        store.save(s)
        if case .failed = result { return s }
        if let state = s.state {
            _ = try? await api.reportAmazonStatus(AmazonStatusReport(state: state, lastImportAt: s.lastImportAt, lastError: state == .ok ? nil : s.lastError))
        }
        return s
    }
}
