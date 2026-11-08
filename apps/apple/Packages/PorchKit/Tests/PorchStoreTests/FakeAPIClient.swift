import Foundation
import PorchKit
import Synchronization

/// An in-memory `APIClient` for sync tests. Each package endpoint answers from
/// a handler the test sets; calls are recorded in order.
final class FakeAPIClient: APIClient {
    struct State {
        var calls: [String] = []
        var syncPages: [String: [SyncResponse]] = [:]
        var syncError: [String: APIError] = [:]
        var put: (@Sendable (String, PackagePutRequest) throws -> PackagePutResult)?
        var delete: (@Sendable (String) throws -> PackageDeleteResponse)?
        var get: (@Sendable (String) throws -> PackageResponse)?
        var syncGate: (@Sendable () async -> Void)?
    }

    let state = Mutex(State())

    func configure(_ change: (inout State) -> Void) { state.withLock { change(&$0) } }
    var calls: [String] { state.withLock { $0.calls } }

    private func record(_ call: String) { state.withLock { $0.calls.append(call) } }

    func sync(since cursor: String?) async throws -> SyncResponse {
        let key = cursor ?? "nil"
        record("sync \(key)")
        if let gate = state.withLock({ $0.syncGate }) { await gate() }
        return try state.withLock { s in
            if let error = s.syncError[key] { throw error }
            guard var pages = s.syncPages[key], !pages.isEmpty else {
                return SyncResponse(packages: [], events: [], deleted: [], cursor: cursor ?? "", hasMore: false)
            }
            let first = pages.removeFirst()
            s.syncPages[key] = pages
            return first
        }
    }

    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult {
        record("put \(id)")
        guard let handler = state.withLock({ $0.put }) else { throw APIError.network("no handler") }
        return try handler(id, request)
    }

    func deletePackage(id: String) async throws -> PackageDeleteResponse {
        record("delete \(id)")
        guard let handler = state.withLock({ $0.delete }) else { throw APIError.network("no handler") }
        return try handler(id)
    }

    func getPackage(id: String) async throws -> PackageResponse {
        record("get \(id)")
        guard let handler = state.withLock({ $0.get }) else { throw APIError.network("no handler") }
        return try handler(id)
    }

    func refreshPackage(id: String) async throws -> RefreshResponse {
        record("refresh \(id)")
        throw APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "Checked recently"), retryAfter: 60)
    }

    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse { throw unused() }
    func startEmailSignIn(_ request: EmailStartRequest) async throws { throw unused() }
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse { throw unused() }
    func signOut() async throws { throw unused() }
    func me() async throws -> User { throw unused() }
    func deleteAccount() async throws { throw unused() }
    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device { throw unused() }
    func listSessions() async throws -> [SessionInfo] { throw unused() }
    func deleteSession(id: String) async throws -> SessionDeleteResponse { throw unused() }
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse { throw unused() }
    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse { throw unused() }
    func startPairing() async throws -> PairingStartResponse { throw unused() }
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse { throw unused() }
    func listTokens() async throws -> [APITokenInfo] { throw unused() }
    func deleteToken(id: String) async throws { throw unused() }

    private func unused(_ function: String = #function) -> PorchError { .notImplemented(function) }
}

func serverError(_ status: Int, _ code: ErrorCode, details: JSONValue? = nil) -> APIError {
    .server(status: status, body: APIErrorBody(code: code, message: "x", details: details), retryAfter: nil)
}

/// Lets a test hold one fake call open until it says go.
final class Gate: Sendable {
    private let entered = AsyncStream<Void>.makeStream()
    private let opened = AsyncStream<Void>.makeStream()

    /// Called by the fake: parks until `open()`.
    func wait() async {
        entered.continuation.yield()
        for await _ in opened.stream {}
    }

    /// Returns once the fake is parked in `wait()`.
    func waitUntilEntered() async {
        for await _ in entered.stream { return }
    }

    func open() { opened.continuation.finish() }
}
