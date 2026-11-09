import Foundation

/// The URLSession-backed `APIClient`.
///
/// Each request is built with `Endpoints`, carries the token from `token()`
/// when the endpoint needs a session, goes through `transport`, and is decoded
/// with `Envelope.unwrap`. A 401 on a request that sent a session token calls
/// `onUnauthorized` with that token (the app clears the session and returns
/// to sign-in if it is still the saved one).
/// Transport failures become `APIError.network`.
public struct HTTPAPIClient: APIClient {
    public let baseURL: URL
    public let transport: any HTTPTransport
    public let token: @Sendable () async -> String?
    /// Gets the token the server refused, so a late 401 for a session that
    /// already ended doesn't end the one that replaced it.
    public let onUnauthorized: @Sendable (String) async -> Void

    public init(
        baseURL: URL, transport: any HTTPTransport = URLSession.shared, token: @escaping @Sendable () async -> String?,
        onUnauthorized: @escaping @Sendable (String) async -> Void = { _ in }
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.token = token
        self.onUnauthorized = onUnauthorized
    }

    // MARK: Auth

    public func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse {
        try await send(Endpoints.signInWithApple(request))
    }

    public func startEmailSignIn(_ request: EmailStartRequest) async throws {
        let _: EmailStartResponse = try await send(Endpoints.startEmailSignIn(request))
    }

    public func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse {
        try await send(Endpoints.verifyEmail(request))
    }

    public func signOut() async throws {
        let _: SignOutResponse = try await send(Endpoints.signOut)
    }

    public func me() async throws -> User {
        let response: MeResponse = try await send(Endpoints.me)
        return response.user
    }

    public func deleteAccount() async throws {
        let _: DeletedResponse = try await send(Endpoints.deleteAccount)
    }

    // MARK: Devices and sessions

    public func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device {
        try await send(Endpoints.putDevice(id: id, request))
    }

    public func listSessions() async throws -> [SessionInfo] {
        let response: SessionsResponse = try await send(Endpoints.listSessions)
        return response.sessions
    }

    public func deleteSession(id: String) async throws -> SessionDeleteResponse {
        try await send(Endpoints.deleteSession(id: id))
    }

    // MARK: Sync and packages

    public func sync(since cursor: String?) async throws -> SyncResponse {
        try await send(Endpoints.sync(since: cursor))
    }

    public func getPackage(id: String) async throws -> PackageResponse {
        try await send(Endpoints.getPackage(id: id))
    }

    public func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult {
        let (package, status): (Package, Int) = try await sendWithStatus(Endpoints.putPackage(id: id, request))
        return PackagePutResult(package: package, created: status == 201)
    }

    public func deletePackage(id: String) async throws -> PackageDeleteResponse {
        try await send(Endpoints.deletePackage(id: id))
    }

    public func refreshPackage(id: String) async throws -> RefreshResponse {
        try await send(Endpoints.refreshPackage(id: id))
    }

    // MARK: Imports, pairing, tokens

    public func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse {
        try await send(Endpoints.importFlint(items))
    }

    public func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse {
        try await send(Endpoints.importAmazon(items))
    }

    public func amazonIntegration() async throws -> AmazonIntegration? {
        let response: AmazonIntegrationResponse = try await send(Endpoints.amazonIntegration)
        return response.amazon
    }

    public func reportAmazonStatus(_ report: AmazonStatusReport) async throws -> AmazonIntegration {
        let response: AmazonIntegrationResponse = try await send(Endpoints.reportAmazonStatus(report))
        guard let amazon = response.amazon else { throw APIError.invalidResponse("No Amazon status in the reply") }
        return amazon
    }

    public func clearAmazonStatus() async throws {
        let _: DeletedResponse = try await send(Endpoints.clearAmazonStatus)
    }

    public func startPairing() async throws -> PairingStartResponse {
        try await send(Endpoints.startPairing)
    }

    public func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse {
        try await send(Endpoints.claimPairing(request))
    }

    public func listTokens() async throws -> [APITokenInfo] {
        let response: TokensResponse = try await send(Endpoints.listTokens)
        return response.tokens
    }

    public func deleteToken(id: String) async throws {
        let _: DeletedResponse = try await send(Endpoints.deleteToken(id: id))
    }

    // MARK: Transport

    private func send<T: Decodable & Sendable>(_ endpoint: Endpoint) async throws -> T {
        try await sendWithStatus(endpoint).0
    }

    private func sendWithStatus<T: Decodable & Sendable>(_ endpoint: Endpoint) async throws -> (T, Int) {
        let bearer = endpoint.needsSession ? await token() : nil
        let request = endpoint.urlRequest(baseURL: baseURL, token: bearer)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse("Not an HTTP response")
        }

        do {
            let value = try Envelope<T>.unwrap(data, status: http.statusCode, retryAfter: RetryAfter.parse(http))
            return (value, http.statusCode)
        } catch let error as APIError {
            if case let .server(status, _, _) = error, status == 401, let bearer {
                await onUnauthorized(bearer)
            }
            throw error
        }
    }
}

/// The `Retry-After` header in seconds (docs/API.md, 429). An HTTP date is
/// also accepted, though the server sends seconds.
enum RetryAfter {
    static func parse(_ response: HTTPURLResponse, now: Date = Date()) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespaces) else { return nil }
        if let seconds = TimeInterval(raw), seconds.isFinite, seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }
}

/// The one network seam, so tests can replay responses without URLProtocol.
public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {
    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request, delegate: nil)
    }
}

/// Thrown by contract stubs that a later work item fills in.
public enum PorchError: Error, Hashable, Sendable {
    case notImplemented(String)
}
