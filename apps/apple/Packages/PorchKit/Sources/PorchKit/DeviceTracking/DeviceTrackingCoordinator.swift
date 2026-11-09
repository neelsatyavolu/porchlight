import Foundation

/// Opens a carrier's tracking page in the app's hidden carrier web view (its
/// own data store, not Amazon's) and returns the first capture that answers
/// it. The app target implements it with WKWebView; tests replay fixtures.
public protocol CarrierPageReading: Sendable {
    /// Throws `CarrierReadError.timedOut` when nothing usable came within `timeout`.
    func read(_ job: DeviceJob, timeout: Duration) async throws -> CarrierCapture
}

public enum CarrierReadError: Error, Hashable, Sendable {
    case timedOut
    case failed(String)
}

/// Rate limits that must hold across launches, kept on the device.
public struct DeviceTrackingState: Hashable, Sendable, Codable {
    /// Start times of lookups in the last hour, by carrier id.
    public var lookups: [String: [Date]] = [:]
    /// No lookup of that carrier before this time.
    public var pausedUntil: [String: Date] = [:]
    public var challengesInARow: [String: Int] = [:]
    /// When a run last got the due list. For a "Carrier pages last checked" line.
    public var lastCheckedAt: Date?

    public init() {}

    mutating func forget(before cutoff: Date) {
        lookups = lookups.compactMapValues { times in
            let kept = times.filter { $0 > cutoff }
            return kept.isEmpty ? nil : kept
        }
        pausedUntil = pausedUntil.filter { $0.value > cutoff }
    }
}

public protocol DeviceTrackingStateStoring: Sendable {
    func load() -> DeviceTrackingState
    func save(_ state: DeviceTrackingState)
}

/// UserDefaults under one key: times and counts only, no tracking data.
/// UserDefaults is thread-safe, so the unchecked conformance is sound.
public final class DefaultsDeviceTrackingStateStore: DeviceTrackingStateStoring, @unchecked Sendable {
    public static let key = "porchlight.deviceTracking.state"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> DeviceTrackingState {
        defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(DeviceTrackingState.self, from: $0) } ?? DeviceTrackingState()
    }

    public func save(_ state: DeviceTrackingState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.key)
    }
}

/// How one run went.
public struct DeviceTrackingRun: Hashable, Sendable {
    /// What was posted for each package read.
    public var outcomes: [String: DeviceOutcome] = [:]
    /// Jobs left for a later run: rate limits, a pause, a challenge, or the deadline.
    public var skipped = 0
    /// Why the run couldn't start or a post didn't go through, in one sentence.
    public var error: String?

    public init() {}
}

/// Asks the server which USPS, UPS and FedEx packages the device should read
/// (`GET /v1/device-tracking/due`), reads each carrier page, and posts what it
/// saw (`POST /v1/packages/:id/observed`). docs/research/scraping.md sets the pace.
public actor DeviceTrackingCoordinator {
    /// Least time between two lookups of one carrier.
    public static let spacing: TimeInterval = 5
    public static let perCarrierPerHour = 20
    /// Longest a lookup may take.
    public static let lookupTimeout: TimeInterval = 25
    /// A lookup isn't started with less time than this before the deadline.
    public static let minimumLookupTime: TimeInterval = 10
    /// macOS: how often the app checks while it runs.
    public static let macInterval: Duration = .seconds(5 * 60)
    /// The time from the start of an iOS background refresh until no lookup
    /// may still run. The refresh gets about 30 seconds in all.
    public static let backgroundBudget: TimeInterval = 27
    /// After any FedEx 403.
    static let fedExPause: TimeInterval = 60 * 60
    /// After three USPS challenges in a row.
    static let uspsPause: TimeInterval = 5 * 60

    private let api: any APIClient
    private let reader: any CarrierPageReading
    private let store: any DeviceTrackingStateStoring
    private let timeZone: TimeZone
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private var running = false

    public init(
        api: any APIClient, reader: any CarrierPageReading, store: any DeviceTrackingStateStoring, timeZone: TimeZone = .current,
        now: @escaping @Sendable () -> Date = Date.init,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.api = api
        self.reader = reader
        self.store = store
        self.timeZone = timeZone
        self.now = now
        self.sleep = sleep
    }

    public var lastCheckedAt: Date? { store.load().lastCheckedAt }

    /// Reads whatever the server says is due, one lookup at a time. Returns
    /// at once if a run is already going. With `deadline` (an iOS background
    /// refresh), no lookup starts unless it has `minimumLookupTime` left, and
    /// each gets only the time remaining.
    public func runIfDue(deadline: Date? = nil) async -> DeviceTrackingRun {
        var run = DeviceTrackingRun()
        guard !running else { return run }
        running = true
        defer { running = false }

        let jobs: [DeviceJob]
        do {
            jobs = try await api.deviceTrackingDue()
        } catch {
            run.error = "Couldn't ask Porchlight which carrier pages to check."
            return run
        }
        var state = store.load()
        state.lastCheckedAt = now()
        store.save(state)

        let ordered = Self.roundRobin(jobs.filter { $0.carrier.isDeviceCarrier && CarrierPages.pageURL(for: $0.carrier, trackingNumber: $0.trackingNumber) != nil })
        var stopped: Set<Carrier> = []
        var index = 0
        while index < ordered.count {
            let job = ordered[index]
            if Task.isCancelled { break }
            guard !stopped.contains(job.carrier), let wait = waitBeforeLookup(of: job.carrier) else {
                run.skipped += 1
                index += 1
                continue
            }
            if let deadline, now().addingTimeInterval(wait + Self.minimumLookupTime) > deadline { break }
            if wait > 0 {
                do { try await sleep(.milliseconds(Int(wait * 1000))) } catch { break }
            }
            recordLookup(of: job.carrier)
            let budget = deadline.map { min(Self.lookupTimeout, $0.timeIntervalSince(now())) } ?? Self.lookupTimeout
            guard let read = await read(job, budget: budget) else { break }
            index += 1
            if read == .challenged { stopped.insert(job.carrier) }
            noteChallenge(read == .challenged, carrier: job.carrier)
            do {
                _ = try await api.postObserved(packageId: job.packageId, read.observation(at: now()))
                run.outcomes[job.packageId] = read.outcome
            } catch {
                run.error = "Couldn't send a carrier page reading to Porchlight."
            }
        }
        run.skipped += ordered.count - index
        return run
    }

    // MARK: Private

    /// One job per carrier in turn, keeping the server's oldest-first order
    /// within each, so the 5-second spacing rarely makes a run wait.
    static func roundRobin(_ jobs: [DeviceJob]) -> [DeviceJob] {
        var queues: [Carrier: [DeviceJob]] = [:]
        var carriers: [Carrier] = []
        for job in jobs {
            if queues[job.carrier] == nil { carriers.append(job.carrier) }
            queues[job.carrier, default: []].append(job)
        }
        var out: [DeviceJob] = []
        var round = 0
        while out.count < jobs.count {
            for carrier in carriers where round < queues[carrier]!.count { out.append(queues[carrier]![round]) }
            round += 1
        }
        return out
    }

    /// Seconds to wait before the next lookup of `carrier`, or nil when it is
    /// paused or has used its hourly allowance.
    private func waitBeforeLookup(of carrier: Carrier) -> TimeInterval? {
        let t = now()
        var state = store.load()
        state.forget(before: t.addingTimeInterval(-3600))
        store.save(state)
        if let paused = state.pausedUntil[carrier.rawValue], paused > t { return nil }
        let recent = state.lookups[carrier.rawValue] ?? []
        guard recent.count < Self.perCarrierPerHour else { return nil }
        guard let last = recent.max() else { return 0 }
        return max(0, last.addingTimeInterval(Self.spacing).timeIntervalSince(t))
    }

    private func recordLookup(of carrier: Carrier) {
        var state = store.load()
        state.lookups[carrier.rawValue, default: []].append(now())
        store.save(state)
    }

    private func noteChallenge(_ challenged: Bool, carrier: Carrier) {
        var state = store.load()
        let key = carrier.rawValue
        let run = challenged ? (state.challengesInARow[key] ?? 0) + 1 : 0
        state.challengesInARow[key] = run == 0 ? nil : run
        if challenged, carrier == .fedex { state.pausedUntil[key] = now().addingTimeInterval(Self.fedExPause) }
        if challenged, carrier == .usps, run >= 3 {
            state.pausedUntil[key] = now().addingTimeInterval(Self.uspsPause)
            state.challengesInARow[key] = nil
        }
        store.save(state)
    }

    /// The parsed read, or nil when the run must stop: cancelled, or cut off
    /// by the deadline rather than by the carrier.
    private func read(_ job: DeviceJob, budget: TimeInterval) async -> DeviceRead? {
        do {
            let capture = try await capture(job, timeout: budget)
            return DeviceTrackingParser.read(capture, carrier: job.carrier, trackingNumber: job.trackingNumber, now: now(), timeZone: timeZone)
        } catch CarrierReadError.timedOut {
            return budget < Self.lookupTimeout ? nil : .failed("timed out")
        } catch let CarrierReadError.failed(reason) {
            return .failed(reason)
        } catch {
            return Task.isCancelled ? nil : .failed(String(describing: error))
        }
    }

    /// The reader enforces `timeout` itself; this is a backstop a little after it.
    private func capture(_ job: DeviceJob, timeout: TimeInterval) async throws -> CarrierCapture {
        let reader = reader
        let limit = Duration.milliseconds(Int(max(0, timeout) * 1000))
        return try await withThrowingTaskGroup(of: CarrierCapture.self) { group in
            group.addTask { try await reader.read(job, timeout: limit) }
            group.addTask {
                try await Task.sleep(for: limit + .seconds(2))
                throw CarrierReadError.timedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw CarrierReadError.timedOut }
            return first
        }
    }
}
