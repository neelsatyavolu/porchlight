import Foundation

// CONTRACT: `/v1/integrations/amazon` in docs/API.md and AmazonIntegration in
// services/api/src/types/api.ts.

/// How the last Amazon import on a device went.
public enum AmazonImportState: String, Hashable, Sendable, Codable {
    case ok
    /// Amazon asked for a new sign-in (or a captcha) on the device.
    case needsSignIn = "needs_sign_in"
    /// The pages loaded but the parser found nothing it knows.
    case parseFailed = "parse_failed"

    /// An unknown state from a newer server reads as a parse failure, the one that asks for an app update.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AmazonImportState(rawValue: raw) ?? .parseFailed
    }
}

/// `PUT /v1/integrations/amazon`: what the device reports after each import.
public struct AmazonStatusReport: Hashable, Sendable, Encodable {
    public var state: AmazonImportState
    /// The last import that worked, or nil if none has yet.
    public var lastImportAt: Date?
    /// One sentence for Settings when `state` isn't `ok`.
    public var lastError: String?

    public init(state: AmazonImportState, lastImportAt: Date?, lastError: String?) {
        self.state = state
        self.lastImportAt = lastImportAt
        self.lastError = lastError
    }

    enum CodingKeys: String, CodingKey { case state, lastImportAt, lastError }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(state, forKey: .state)
        try c.encode(lastImportAt, forKey: .lastImportAt)
        try c.encode(lastError, forKey: .lastError)
    }
}

/// The account's Amazon status as the server last heard it, from any device.
public struct AmazonIntegration: Hashable, Sendable, Decodable {
    public var state: AmazonImportState
    public var lastImportAt: Date?
    public var lastError: String?
    /// When the device sent the report.
    public var reportedAt: Date
    /// The platform of the device that sent it.
    public var platform: Platform?
}

public struct AmazonIntegrationResponse: Hashable, Sendable, Decodable {
    /// nil until a device connects Amazon, and again after Disconnect.
    public var amazon: AmazonIntegration?
}
