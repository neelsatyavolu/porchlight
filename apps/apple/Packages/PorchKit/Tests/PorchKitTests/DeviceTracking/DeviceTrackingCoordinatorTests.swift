import Foundation
import Synchronization
import Testing
@testable import PorchKit

/// Serves the due list and records observed posts.
final class DeviceFakeAPI: APIClient, Sendable {
    let jobs: Mutex<[DeviceJob]>
    let dueError: APIError?
    let posts = LockedBox<[(String, DeviceObservation)]>([])

    init(jobs: [DeviceJob], dueError: APIError? = nil) {
        self.jobs = Mutex(jobs)
        self.dueError = dueError
    }

    func deviceTrackingDue() async throws -> [DeviceJob] {
        if let dueError { throw dueError }
        return jobs.withLock { $0 }
    }

    func postObserved(packageId: String, _ observation: DeviceObservation) async throws -> DeviceObservedResponse {
        posts.withLock { $0.append((packageId, observation)) }
        return DeviceObservedResponse(applied: observation.outcome == .ok, deviceNeededAt: nil)
    }

    var posted: [(String, DeviceOutcome)] { posts.withLock { $0.map { ($0.0, $0.1.outcome) } } }

    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse { throw unused() }
    func startEmailSignIn(_ request: EmailStartRequest) async throws { throw unused() }
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse { throw unused() }
    func signOut() async throws { throw unused() }
    func me() async throws -> User { throw unused() }
    func deleteAccount() async throws { throw unused() }
    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device { throw unused() }
    func listSessions() async throws -> [SessionInfo] { throw unused() }
    func deleteSession(id: String) async throws -> SessionDeleteResponse { throw unused() }
    func sync(since cursor: String?) async throws -> SyncResponse { throw unused() }
    func getPackage(id: String) async throws -> PackageResponse { throw unused() }
    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult { throw unused() }
    func deletePackage(id: String) async throws -> PackageDeleteResponse { throw unused() }
    func refreshPackage(id: String) async throws -> RefreshResponse { throw unused() }
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse { throw unused() }
    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse { throw unused() }
    func amazonIntegration() async throws -> AmazonIntegration? { throw unused() }
    func reportAmazonStatus(_ report: AmazonStatusReport) async throws -> AmazonIntegration { throw unused() }
    func clearAmazonStatus() async throws { throw unused() }
    func startPairing() async throws -> PairingStartResponse { throw unused() }
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse { throw unused() }
    func listTokens() async throws -> [APITokenInfo] { throw unused() }
    func deleteToken(id: String) async throws { throw unused() }

    private func unused(_ function: String = #function) -> PorchError { .notImplemented(function) }
}

/// Answers each job from `answer`, records when it was asked and with what timeout.
struct FakeCarrierReader: CarrierPageReading {
    struct Call: Sendable { var packageId: String; var at: Date; var timeout: Duration }
    let clock: TestClock
    let calls = LockedBox<[Call]>([])
    var answer: @Sendable (DeviceJob) throws -> CarrierCapture

    func read(_ job: DeviceJob, timeout: Duration) async throws -> CarrierCapture {
        calls.withLock { $0.append(Call(packageId: job.packageId, at: clock.now, timeout: timeout)) }
        return try answer(job)
    }

    var order: [String] { calls.withLock { $0.map(\.packageId) } }

    /// Pages that parse as ok: the USPS timeline fixture, the UPS and FedEx replies.
    static func fixtures(_ job: DeviceJob) throws -> CarrierCapture {
        switch job.carrier {
        case .usps: .page(url: URL(string: "https://tools.usps.com/tracking/")!, html: DeviceFixture.text("usps-timeline.html"))
        case .ups: .response(url: "https://webapis.ups.com/track/api/Track/GetStatus", status: 200, body: DeviceFixture.text("ups-out-for-delivery.json"))
        default: .response(url: "https://api.fedex.com/track/v2/shipments", status: 200, body: DeviceFixture.text("fedex-delivered.json"))
        }
    }
}

final class MemoryDeviceTrackingStore: DeviceTrackingStateStoring, Sendable {
    private let value: Mutex<DeviceTrackingState>
    init(_ state: DeviceTrackingState = DeviceTrackingState()) { value = Mutex(state) }
    func load() -> DeviceTrackingState { value.withLock { $0 } }
    func save(_ state: DeviceTrackingState) { value.withLock { $0 = state } }
}

private func job(_ id: String, _ carrier: Carrier) -> DeviceJob {
    let number = switch carrier {
    case .usps: "9400111899223397910421"
    case .ups: "1Z999AA10123456784"
    default: "999999999999"
    }
    return DeviceJob(packageId: id, carrier: carrier, trackingNumber: number, reason: .scheduled)
}

@Suite struct DeviceTrackingCoordinatorTests {
    let clock = TestClock()
    let store = MemoryDeviceTrackingStore()

    private func coordinator(_ api: DeviceFakeAPI, _ reader: FakeCarrierReader) -> DeviceTrackingCoordinator {
        let clock = clock
        return DeviceTrackingCoordinator(
            api: api, reader: reader, store: store, timeZone: LA, now: { clock.now },
            sleep: { duration in clock.advance(minutes: Double(duration.components.seconds) / 60) }
        )
    }

    @Test func readsEachJobAndPostsWhatItSaw() async {
        let api = DeviceFakeAPI(jobs: [job("a", .usps), job("b", .ups), job("c", .fedex)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        let run = await coordinator(api, reader).runIfDue()
        #expect(run.outcomes == ["a": .ok, "b": .ok, "c": .ok])
        #expect(run.skipped == 0)
        #expect(run.error == nil)
        let posts = api.posts.withLock { $0 }
        #expect(posts.map(\.0) == ["a", "b", "c"])
        #expect(posts[0].1.status == .delivered)
        #expect(posts[1].1.status == .outForDelivery)
        #expect(posts.allSatisfy { $0.1.observedAt == NOW })
        #expect(reader.calls.withLock { $0.allSatisfy { $0.timeout == .seconds(25) } })
        #expect(store.load().lastCheckedAt == NOW)
    }

    @Test func spacesLookupsOfOneCarrierFiveSecondsApart() async {
        let api = DeviceFakeAPI(jobs: [job("u1", .usps), job("u2", .usps), job("p1", .ups)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        _ = await coordinator(api, reader).runIfDue()
        // Round robin by carrier, oldest first within one.
        #expect(reader.order == ["u1", "p1", "u2"])
        let times = reader.calls.withLock { $0.map(\.at) }
        #expect(times[0] == NOW && times[1] == NOW)
        #expect(times[2] == NOW.addingTimeInterval(5))
    }

    @Test func keepsToTwentyLookupsPerCarrierPerHourAcrossRuns() async {
        var state = DeviceTrackingState()
        state.lookups["usps"] = (0..<20).map { NOW.addingTimeInterval(TimeInterval(-60 * $0 - 60)) }
        state.lookups["ups"] = [NOW.addingTimeInterval(-3700)] // over an hour ago: forgotten
        store.save(state)
        let api = DeviceFakeAPI(jobs: [job("u", .usps), job("p", .ups)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        let run = await coordinator(api, reader).runIfDue()
        #expect(reader.order == ["p"])
        #expect(run.skipped == 1)
        #expect(store.load().lookups["ups"] == [NOW])
        #expect(store.load().lookups["usps"]?.count == 20)
    }

    @Test func remembersTheLastLookupForSpacingAcrossRuns() async {
        var state = DeviceTrackingState()
        state.lookups["ups"] = [NOW.addingTimeInterval(-2)]
        store.save(state)
        let api = DeviceFakeAPI(jobs: [job("p", .ups)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        _ = await coordinator(api, reader).runIfDue()
        #expect(reader.calls.withLock { $0.first?.at } == NOW.addingTimeInterval(3))
    }

    @Test func startsNoLookupThatCannotFinishBeforeTheDeadline() async {
        let api = DeviceFakeAPI(jobs: [job("u1", .usps), job("u2", .usps), job("u3", .usps)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        let run = await coordinator(api, reader).runIfDue(deadline: NOW.addingTimeInterval(12))
        #expect(reader.order == ["u1"])
        // The lookup gets only the time left.
        #expect(reader.calls.withLock { $0.first?.timeout } == .seconds(12))
        #expect(run.outcomes == ["u1": .ok])
        #expect(run.skipped == 2)
    }

    @Test func stopsACarrierAfterAChallengeAndBacksOffFedExForAnHour() async {
        let api = DeviceFakeAPI(jobs: [job("f1", .fedex), job("f2", .fedex), job("p", .ups)])
        let reader = FakeCarrierReader(clock: clock) { job in
            job.carrier == .fedex
                ? .response(url: "https://api.fedex.com/track/v2/shipments", status: 403, body: DeviceFixture.text("fedex-access-denied.html"))
                : try FakeCarrierReader.fixtures(job)
        }
        let first = await coordinator(api, reader).runIfDue()
        #expect(first.outcomes == ["f1": .challenged, "p": .ok])
        #expect(first.skipped == 1)
        #expect(store.load().pausedUntil["fedex"] == NOW.addingTimeInterval(3600))

        clock.advance(minutes: 30)
        _ = await coordinator(api, reader).runIfDue()
        #expect(reader.order == ["f1", "p", "p"])
    }

    @Test func pausesUSPSFiveMinutesAfterThreeChallengesInARow() async {
        let api = DeviceFakeAPI(jobs: [job("u", .usps)])
        let reader = FakeCarrierReader(clock: clock) { _ in
            .page(url: URL(string: "https://tools.usps.com/tracking/")!, html: DeviceFixture.text("usps-interstitial.html"))
        }
        for _ in 0..<3 {
            _ = await coordinator(api, reader).runIfDue()
            clock.advance(minutes: 1)
        }
        let pausedAt = clock.now.addingTimeInterval(-60)
        #expect(store.load().pausedUntil["usps"] == pausedAt.addingTimeInterval(300))
        _ = await coordinator(api, reader).runIfDue()
        #expect(reader.order.count == 3)
        #expect(api.posted.map(\.1) == [.challenged, .challenged, .challenged])
    }

    @Test func reportsATimeoutAsFailed() async {
        let api = DeviceFakeAPI(jobs: [job("p", .ups)])
        let reader = FakeCarrierReader(clock: clock) { _ in throw CarrierReadError.timedOut }
        let run = await coordinator(api, reader).runIfDue()
        #expect(run.outcomes == ["p": .failed])
    }

    @Test func doesNothingWhenTheDueListFails() async {
        let api = DeviceFakeAPI(jobs: [], dueError: .network("offline"))
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        let run = await coordinator(api, reader).runIfDue()
        #expect(run.error != nil)
        #expect(reader.order.isEmpty)
        #expect(store.load().lastCheckedAt == nil)
    }

    @Test func ignoresCarriersTheDeviceDoesNotRead() async {
        let api = DeviceFakeAPI(jobs: [DeviceJob(packageId: "d", carrier: .dhl, trackingNumber: "1234567890", reason: .scheduled)])
        let reader = FakeCarrierReader(clock: clock, answer: FakeCarrierReader.fixtures)
        let run = await coordinator(api, reader).runIfDue()
        #expect(reader.order.isEmpty)
        #expect(run.outcomes.isEmpty)
    }

    @Test func savesStateThroughUserDefaults() {
        let defaults = UserDefaults(suiteName: "porchlight.tests.\(UUID().uuidString)")!
        let s = DefaultsDeviceTrackingStateStore(defaults: defaults)
        #expect(s.load() == DeviceTrackingState())
        var state = DeviceTrackingState()
        state.lookups["ups"] = [NOW]
        state.lastCheckedAt = NOW
        s.save(state)
        #expect(DefaultsDeviceTrackingStateStore(defaults: defaults).load() == state)
    }
}
