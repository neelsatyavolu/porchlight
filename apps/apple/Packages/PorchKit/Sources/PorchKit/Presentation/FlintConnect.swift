import Foundation

// "Connect Flint" (docs/API.md "Pairing and API tokens", DESIGN.md §7): make a
// one-time code, open Flint with a flint: link, then watch GET /v1/tokens for
// Flint's new token. A port of apps/web/src/pages/settings/useFlintConnect.ts.

public enum FlintLink {
    /// Where "Flint not opening? Get Flint" goes.
    public static let downloadURL = URL(string: "https://flint.xanom.co")!

    /// flint://porchlight/pair?code=ABCD-EFGH&host=porchlight.xanom.co
    public static func pair(code: String, host: String = PorchConfig.webHost) -> URL {
        URL(string: "flint://porchlight/pair?code=\(encode(code))&host=\(encode(host))")!
    }

    /// RFC 3986 unreserved characters; everything else is percent-encoded.
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}

/// One press of "Connect Flint": the code, and the tokens that existed before it.
public struct FlintConnectAttempt: Hashable, Sendable {
    /// Look for the new token this often.
    public static let pollInterval: Duration = .seconds(2)
    /// Stop looking after this many seconds; the code itself lasts 10 minutes.
    public static let timeout: TimeInterval = 120

    public let pairing: PairingStartResponse
    public let knownTokenIds: Set<String>
    public let startedAt: Date

    public init(pairing: PairingStartResponse, existing: [APITokenInfo], startedAt: Date) {
        self.pairing = pairing
        knownTokenIds = Set(existing.map(\.id))
        self.startedAt = startedAt
    }

    public func link(host: String = PorchConfig.webHost) -> URL {
        FlintLink.pair(code: pairing.code, host: host)
    }

    /// The first token that wasn't there when the attempt started: Flint's.
    public func newToken(in list: [APITokenInfo]) -> APITokenInfo? {
        list.first { !knownTokenIds.contains($0.id) }
    }
}

public enum FlintConnectState: Hashable, Sendable {
    case idle
    case starting
    /// `stalled`: the timeout passed with no token, so polling stopped.
    case waiting(FlintConnectAttempt, stalled: Bool)
    case connected(APITokenInfo)
    case failed(String)

    public var isPolling: Bool {
        if case .waiting(_, stalled: false) = self { return true }
        return false
    }

    /// The state after a poll of GET /v1/tokens returned `list` at `now`.
    public func polled(_ list: [APITokenInfo], at now: Date) -> FlintConnectState {
        guard case let .waiting(attempt, stalled: false) = self else { return self }
        if let token = attempt.newToken(in: list) { return .connected(token) }
        if now.timeIntervalSince(attempt.startedAt) >= FlintConnectAttempt.timeout { return .waiting(attempt, stalled: true) }
        return self
    }
}

public enum FlintText {
    public static let connectButton = "Connect Flint"
    public static let retryButton = "Try again"
    public static let opening = "Opening Flint…"
    public static let stalled = "Flint hasn't connected yet."
    public static let notInstalled = "Flint isn't on this Mac yet."
    public static let notOpening = "Flint not opening?"
    public static let getFlint = "Get Flint"
    public static let useCode = "Use a code instead"
    public static let codeHelp = "In Flint, open Settings, then Porchlight, and enter this code."
    public static let codeExpired = "This code has expired."
    /// The iPhone row: Flint is a Mac app, so there's nothing to connect from here.
    public static let phoneNote = "Flint runs on your Mac. Open Porchlight on your Mac, or Flint, to connect it."

    /// "Connected to Flint on Studio". Flint labels its token "Flint on <Mac name>".
    public static func connected(_ token: APITokenInfo) -> String {
        "Connected to \(token.label)"
    }
}
