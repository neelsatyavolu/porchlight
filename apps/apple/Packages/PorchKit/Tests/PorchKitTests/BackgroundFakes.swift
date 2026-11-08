import Foundation
import Synchronization
@testable import PorchKit

// Fakes for the share, push and background tests. Names are prefixed so they
// don't collide with fakes other test files add to this target.

let SAMPLE_USER = User(id: "u1", email: "a@b.c", hasApple: false, createdAt: Date(timeIntervalSince1970: 0))
let SAMPLE_SESSION = Session(token: "tok", user: SAMPLE_USER, deviceId: "dev-1")

/// Accepts "1Z" + 16 alphanumerics (UPS, high), 20 to 22 digits (USPS, medium)
/// and "7" + 11 digits (FedEx or OnTrac, low), so the
/// extractor tests don't depend on the real detection rules.
struct BGFakeDetector: CarrierDetector {
    func normalize(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .uppercased()
    }

    func detect(_ number: String) -> [Candidate] {
        let n = normalize(number)
        if n.wholeMatch(of: #/1Z[0-9A-Z]{16}/#) != nil { return [Candidate(carrier: .ups, confidence: .high)] }
        if n.wholeMatch(of: #/[0-9]{20,22}/#) != nil { return [Candidate(carrier: .usps, confidence: .medium)] }
        if n.wholeMatch(of: #/7[0-9]{11}/#) != nil {
            return [Candidate(carrier: .fedex, confidence: .low), Candidate(carrier: .ontrac, confidence: .low)]
        }
        return []
    }
}

/// Session store whose load throws, like the Keychain stub.
struct BGThrowingSessionStore: SessionStore {
    struct Failure: Error {}
    func load() throws -> Session? { throw Failure() }
    func save(_ session: Session) throws { throw Failure() }
    func clear() throws { throw Failure() }
}

/// An APIClient that records device and package PUTs. Every other endpoint fails.
final class BGFakeAPI: APIClient {
    struct Unused: Error {}

    let devicePuts = Mutex<[(String, DevicePutRequest)]>([])
    let packagePuts = Mutex<[(String, PackagePutRequest)]>([])
    /// Answers for package PUTs, by tracking number. Missing ones succeed.
    let packageErrors: [String: APIError]
    let deviceError: APIError?

    init(packageErrors: [String: APIError] = [:], deviceError: APIError? = nil) {
        self.packageErrors = packageErrors
        self.deviceError = deviceError
    }

    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device {
        devicePuts.withLock { $0.append((id, request)) }
        if let deviceError { throw deviceError }
        return Device(id: id, platform: request.platform, apnsToken: request.apnsToken, appVersion: request.appVersion,
                      environment: request.environment ?? .production)
    }

    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult {
        packagePuts.withLock { $0.append((id, request)) }
        if let error = packageErrors[request.trackingNumber ?? ""] { throw error }
        let pkg = Package(id: id, carrier: request.carrier ?? .other, trackingNumber: request.trackingNumber ?? "",
                          source: .share, updatedAt: Date(timeIntervalSince1970: 0))
        return PackagePutResult(package: pkg, created: true)
    }

    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse { throw Unused() }
    func startEmailSignIn(_ request: EmailStartRequest) async throws { throw Unused() }
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse { throw Unused() }
    func signOut() async throws { throw Unused() }
    func me() async throws -> User { throw Unused() }
    func deleteAccount() async throws { throw Unused() }
    func listSessions() async throws -> [SessionInfo] { throw Unused() }
    func deleteSession(id: String) async throws -> SessionDeleteResponse { throw Unused() }
    func sync(since cursor: String?) async throws -> SyncResponse { throw Unused() }
    func getPackage(id: String) async throws -> PackageResponse { throw Unused() }
    func deletePackage(id: String) async throws -> PackageDeleteResponse { throw Unused() }
    func refreshPackage(id: String) async throws -> RefreshResponse { throw Unused() }
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse { throw Unused() }
    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse { throw Unused() }
    func startPairing() async throws -> PairingStartResponse { throw Unused() }
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse { throw Unused() }
    func listTokens() async throws -> [APITokenInfo] { throw Unused() }
    func deleteToken(id: String) async throws { throw Unused() }
}

/// A SyncEngine whose `sync()` returns a fixed outcome or throws.
final class BGFakeSyncEngine: SyncEngine {
    struct Unused: Error {}

    let result: Result<SyncOutcome, any Error>
    let calls = Mutex(0)

    init(_ result: Result<SyncOutcome, any Error>) { self.result = result }

    func sync() async throws -> SyncOutcome {
        calls.withLock { $0 += 1 }
        return try result.get()
    }

    func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage { throw Unused() }
    func update(packageId: String, _ request: PackagePutRequest) async throws { throw Unused() }
    func delete(packageId: String) async throws { throw Unused() }
    func refresh(packageId: String) async throws -> RefreshResponse { throw Unused() }
    func reset() async throws { throw Unused() }
}

func outcome(changed: Int = 0, deleted: Int = 0, full: Bool = false) -> SyncOutcome {
    SyncOutcome(changed: changed, deleted: deleted, didFullSync: full, finishedAt: Date(timeIntervalSince1970: 0))
}

func serverError(_ status: Int, _ code: ErrorCode, details: JSONValue? = nil) -> APIError {
    .server(status: status, body: APIErrorBody(code: code, message: "m", details: details), retryAfter: nil)
}

/// A SyncEngine whose `sync()` ignores cancellation and waits for `release()`,
/// like a joined run that a background task's expiry can't stop.
final class BGHangingSyncEngine: SyncEngine {
    struct Unused: Error {}

    private let started = AsyncStream<Void>.makeStream()
    private let gate = AsyncStream<Void>.makeStream()

    func entered() async { for await _ in started.stream { return } }
    func release() { gate.continuation.finish() }

    func sync() async throws -> SyncOutcome {
        started.continuation.yield()
        // Detached so the caller's cancellation doesn't end the wait early.
        let stream = gate.stream
        await Task.detached { for await _ in stream {} }.value
        return outcome(changed: 1)
    }

    func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage { throw Unused() }
    func update(packageId: String, _ request: PackagePutRequest) async throws { throw Unused() }
    func delete(packageId: String) async throws { throw Unused() }
    func refresh(packageId: String) async throws -> RefreshResponse { throw Unused() }
    func reset() async throws { throw Unused() }
}
