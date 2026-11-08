import Foundation

// CONTRACT: one method per endpoint in docs/API.md. Screens and the sync
// engine depend on this protocol, never on HTTPAPIClient, so tests and
// previews can pass a fake.

public protocol APIClient: Sendable {
    // Auth
    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse
    func startEmailSignIn(_ request: EmailStartRequest) async throws
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse
    func signOut() async throws
    func me() async throws -> User
    func deleteAccount() async throws

    // Devices
    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device

    // Sessions
    func listSessions() async throws -> [SessionInfo]
    func deleteSession(id: String) async throws -> SessionDeleteResponse

    // Sync: one page. Callers loop while `hasMore`.
    func sync(since cursor: String?) async throws -> SyncResponse

    // Packages
    func getPackage(id: String) async throws -> PackageResponse
    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult
    func deletePackage(id: String) async throws -> PackageDeleteResponse
    func refreshPackage(id: String) async throws -> RefreshResponse

    // Imports
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse
    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse

    // Pairing and API tokens
    func startPairing() async throws -> PairingStartResponse
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse
    func listTokens() async throws -> [APITokenInfo]
    func deleteToken(id: String) async throws
}

/// A request description: method, path under the `/v1` base, whether it needs
/// the session token, and the JSON body.
public struct Endpoint: Sendable, Hashable {
    public enum Method: String, Sendable { case get = "GET", put = "PUT", post = "POST", delete = "DELETE" }

    public var method: Method
    /// Relative to the base URL, starting with "/", e.g. "/packages/<id>".
    public var path: String
    public var query: [URLQueryItem]
    public var needsSession: Bool
    public var body: Data?

    public init(_ method: Method, _ path: String, query: [URLQueryItem] = [], needsSession: Bool = true, body: Data? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.needsSession = needsSession
        self.body = body
    }

    public static func json(_ method: Method, _ path: String, needsSession: Bool = true, _ value: some Encodable) throws -> Endpoint {
        Endpoint(method, path, needsSession: needsSession, body: try WireJSON.encoder().encode(value))
    }

    /// `baseURL` ends in "/v1", e.g. `https://porchlight.xanom.co/v1`.
    public func urlRequest(baseURL: URL, token: String?) -> URLRequest {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if needsSession, let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

/// Path segment for an id. Ids are UUIDs, so this only guards against a stray "/".
func segment(_ id: String) -> String {
    id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
}

/// Every endpoint of docs/API.md as an `Endpoint`. HTTPAPIClient is built on
/// these; tests assert the method and path of each.
public enum Endpoints {
    public static func signInWithApple(_ r: AppleSignInRequest) throws -> Endpoint { try .json(.post, "/auth/apple", needsSession: false, r) }
    public static func startEmailSignIn(_ r: EmailStartRequest) throws -> Endpoint { try .json(.post, "/auth/email/start", needsSession: false, r) }
    public static func verifyEmail(_ r: EmailVerifyRequest) throws -> Endpoint { try .json(.post, "/auth/email/verify", needsSession: false, r) }
    public static let signOut = Endpoint(.post, "/auth/signout")
    public static let me = Endpoint(.get, "/me")
    public static let deleteAccount = Endpoint(.delete, "/me")
    public static func putDevice(id: String, _ r: DevicePutRequest) throws -> Endpoint { try .json(.put, "/devices/\(segment(id))", r) }
    public static let listSessions = Endpoint(.get, "/sessions")
    public static func deleteSession(id: String) -> Endpoint { Endpoint(.delete, "/sessions/\(segment(id))") }
    public static func sync(since cursor: String?) -> Endpoint {
        Endpoint(.get, "/sync", query: cursor.map { [URLQueryItem(name: "since", value: $0)] } ?? [])
    }
    public static func getPackage(id: String) -> Endpoint { Endpoint(.get, "/packages/\(segment(id))") }
    public static func putPackage(id: String, _ r: PackagePutRequest) throws -> Endpoint { try .json(.put, "/packages/\(segment(id))", r) }
    public static func deletePackage(id: String) -> Endpoint { Endpoint(.delete, "/packages/\(segment(id))") }
    public static func refreshPackage(id: String) -> Endpoint { Endpoint(.post, "/packages/\(segment(id))/refresh") }
    public static func importFlint(_ items: [FlintImportItem]) throws -> Endpoint { try .json(.post, "/imports/flint", ImportRequest(items: items)) }
    public static func importAmazon(_ items: [AmazonImportItem]) throws -> Endpoint { try .json(.post, "/imports/amazon", ImportRequest(items: items)) }
    public static let startPairing = Endpoint(.post, "/pairing/start")
    public static func claimPairing(_ r: PairingClaimRequest) throws -> Endpoint { try .json(.post, "/pairing/claim", needsSession: false, r) }
    public static let listTokens = Endpoint(.get, "/tokens")
    public static func deleteToken(id: String) -> Endpoint { Endpoint(.delete, "/tokens/\(segment(id))") }
}
