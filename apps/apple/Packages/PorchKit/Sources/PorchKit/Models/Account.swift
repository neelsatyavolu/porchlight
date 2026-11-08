import Foundation

// CONTRACT: User, Device and the sign-in response in docs/API.md.

public enum Platform: String, Sendable, Hashable, Codable {
    case ios
    case macos
    case web

    /// The platform this build runs on.
    public static var current: Platform {
        #if os(macOS)
        .macos
        #else
        .ios
        #endif
    }
}

public typealias Client = Platform

public struct User: Identifiable, Hashable, Sendable, Codable {
    public var id: String
    public var email: String?
    public var hasApple: Bool
    public var createdAt: Date

    public init(id: String, email: String?, hasApple: Bool, createdAt: Date) {
        self.id = id
        self.email = email
        self.hasApple = hasApple
        self.createdAt = createdAt
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(email, forKey: .email)
        try c.encode(hasApple, forKey: .hasApple)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

/// A signed-in native session, as kept in the Keychain by `SessionStore`.
/// Not a wire type: built from a `SignInResponse` whose `token` is non-nil.
public struct Session: Hashable, Sendable, Codable {
    /// Opaque bearer token. Never log it.
    public var token: String
    public var user: User
    /// The device id sent with sign-in and `PUT /v1/devices/:id`.
    public var deviceId: String

    public init(token: String, user: User, deviceId: String) {
        self.token = token
        self.user = user
        self.deviceId = deviceId
    }
}

/// Which APNs host serves a device token. Development builds (`aps-environment`
/// = development) use sandbox; TestFlight and the App Store use production.
public enum APNSEnvironment: String, Sendable, Hashable, Codable {
    case sandbox
    case production
}

/// `PUT /v1/devices/:id` response.
public struct Device: Identifiable, Hashable, Sendable, Codable {
    public var id: String
    public var platform: Platform
    /// Hex APNs token.
    public var apnsToken: String?
    /// "1.0 (12)".
    public var appVersion: String?
    public var environment: APNSEnvironment

    public init(id: String, platform: Platform, apnsToken: String?, appVersion: String?, environment: APNSEnvironment) {
        self.id = id
        self.platform = platform
        self.apnsToken = apnsToken
        self.appVersion = appVersion
        self.environment = environment
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(platform, forKey: .platform)
        try c.encode(apnsToken, forKey: .apnsToken)
        try c.encode(appVersion, forKey: .appVersion)
        try c.encode(environment, forKey: .environment)
    }
}

/// One signed-in session, from `GET /v1/sessions` (Settings, "Signed in on").
public struct SessionInfo: Identifiable, Hashable, Sendable, Decodable {
    public var id: String
    /// The linked device's platform, else the client that signed in; nil for old sessions.
    public var platform: Platform?
    public var appVersion: String?
    public var createdAt: Date
    public var lastSeenAt: Date
    /// True for the session making the request.
    public var current: Bool
}
