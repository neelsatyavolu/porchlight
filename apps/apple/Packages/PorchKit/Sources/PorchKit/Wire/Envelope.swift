import Foundation

// CONTRACT: the response envelope and error codes (docs/API.md "Envelope",
// "Errors"; services/api/src/lib/http.ts).

public enum ErrorCode: String, Sendable, Hashable, Codable {
    case badRequest = "bad_request"
    case unauthorized
    case forbidden
    case notFound = "not_found"
    case methodNotAllowed = "method_not_allowed"
    case conflict
    case rateLimited = "rate_limited"
    case unavailable
    case `internal`

    /// A code this build doesn't know decodes as `.internal`.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ErrorCode(rawValue: raw) ?? .internal
    }
}

/// Arbitrary JSON, for `error.details`.
public enum JSONValue: Hashable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(v): try c.encode(v)
        case let .number(v): try c.encode(v)
        case let .string(v): try c.encode(v)
        case let .array(v): try c.encode(v)
        case let .object(v): try c.encode(v)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }
}

public struct APIErrorBody: Hashable, Sendable, Codable {
    public var code: ErrorCode
    public var message: String
    public var details: JSONValue?

    public init(code: ErrorCode, message: String, details: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}

/// `{ ok, data, error }`. Decode with `WireJSON.decoder()`.
public struct Envelope<T: Decodable & Sendable>: Decodable, Sendable {
    public var ok: Bool
    public var data: T?
    public var error: APIErrorBody?
}

/// `details` of a 409 from `PUT /v1/packages/:id`.
public enum PackageConflict: Hashable, Sendable {
    /// The user already tracks this `(carrier, trackingNumber)`: adopt `existingId`, drop the local id.
    case duplicate(existingId: String)
    /// The id was deleted. Ids are never reused.
    case deleted

    public init?(details: JSONValue?) {
        switch details?["reason"]?.stringValue {
        case "duplicate":
            guard let id = details?["existingId"]?.stringValue else { return nil }
            self = .duplicate(existingId: id)
        case "deleted":
            self = .deleted
        default:
            return nil
        }
    }
}

/// Every error an `APIClient` throws.
public enum APIError: Error, Hashable, Sendable {
    /// The server answered with `ok: false`. `retryAfter` comes from the
    /// `Retry-After` header on 429.
    case server(status: Int, body: APIErrorBody, retryAfter: TimeInterval?)
    /// No response: offline, DNS, TLS, timeout.
    case network(String)
    /// A response that isn't a valid envelope for the expected type.
    case invalidResponse(String)

    public var code: ErrorCode? {
        if case let .server(_, body, _) = self { return body.code }
        return nil
    }

    public var conflict: PackageConflict? {
        if case let .server(_, body, _) = self, body.code == .conflict { return PackageConflict(details: body.details) }
        return nil
    }
}

extension Envelope {
    /// Unwraps a response body. Throws `APIError.server` for `ok: false` and
    /// `.invalidResponse` for anything that isn't an envelope of `T`.
    public static func unwrap(_ data: Data, status: Int, retryAfter: TimeInterval? = nil) throws -> T {
        let envelope: Envelope<T>
        do {
            envelope = try WireJSON.decoder().decode(Envelope<T>.self, from: data)
        } catch {
            throw APIError.invalidResponse("HTTP \(status): \(error)")
        }
        if envelope.ok, let value = envelope.data { return value }
        if let body = envelope.error { throw APIError.server(status: status, body: body, retryAfter: retryAfter) }
        throw APIError.invalidResponse("HTTP \(status): envelope has neither data nor error")
    }
}
