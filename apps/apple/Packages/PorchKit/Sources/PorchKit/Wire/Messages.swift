import Foundation

// CONTRACT: request and response bodies of every /v1 endpoint (docs/API.md).
// Field names and null-vs-absent behavior match the TypeScript in
// services/api/src/types/api.ts.

// MARK: - Auth

public struct AppleSignInRequest: Hashable, Sendable, Encodable {
    public var identityToken: String
    /// The raw nonce whose SHA-256 went into the Apple request.
    public var nonce: String
    public var client: Client
    public var deviceId: String?

    public init(identityToken: String, nonce: String, client: Client = .current, deviceId: String?) {
        self.identityToken = identityToken
        self.nonce = nonce
        self.client = client
        self.deviceId = deviceId
    }
}

public struct EmailStartRequest: Hashable, Sendable, Encodable {
    public var email: String
    public var client: Client

    public init(email: String, client: Client = .current) {
        self.email = email
        self.client = client
    }
}

/// Either the token from the emailed link, or the email plus its 6-digit code.
public enum EmailVerifyRequest: Hashable, Sendable, Encodable {
    case token(String, client: Client = .current, deviceId: String?)
    case code(email: String, code: String, client: Client = .current, deviceId: String?)

    enum CodingKeys: String, CodingKey { case token, email, code, client, deviceId }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .token(token, client, deviceId):
            try c.encode(token, forKey: .token)
            try c.encode(client, forKey: .client)
            try c.encodeIfPresent(deviceId, forKey: .deviceId)
        case let .code(email, code, client, deviceId):
            try c.encode(email, forKey: .email)
            try c.encode(code, forKey: .code)
            try c.encode(client, forKey: .client)
            try c.encodeIfPresent(deviceId, forKey: .deviceId)
        }
    }
}

public struct SignInResponse: Hashable, Sendable, Decodable {
    /// Always set for native clients.
    public var token: String?
    public var user: User
    public var created: Bool
}

public struct EmailStartResponse: Hashable, Sendable, Decodable { public var sent: Bool }
public struct SignOutResponse: Hashable, Sendable, Decodable { public var signedOut: Bool }
public struct MeResponse: Hashable, Sendable, Decodable { public var user: User }
public struct DeletedResponse: Hashable, Sendable, Decodable { public var deleted: Bool }

// MARK: - Devices

public struct DevicePutRequest: Hashable, Sendable, Encodable {
    public var platform: Platform
    public var apnsToken: String?
    public var appVersion: String?
    /// Left out: production on create, unchanged on update. Native builds always send it.
    public var environment: APNSEnvironment?

    public init(platform: Platform = .current, apnsToken: String?, appVersion: String?, environment: APNSEnvironment?) {
        self.platform = platform
        self.apnsToken = apnsToken
        self.appVersion = appVersion
        self.environment = environment
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(platform, forKey: .platform)
        try c.encode(apnsToken, forKey: .apnsToken)
        try c.encode(appVersion, forKey: .appVersion)
        try c.encodeIfPresent(environment, forKey: .environment)
    }

    enum CodingKeys: String, CodingKey { case platform, apnsToken, appVersion, environment }
}

// MARK: - Sessions

public struct SessionsResponse: Hashable, Sendable, Decodable {
    /// Most recently seen first.
    public var sessions: [SessionInfo]
}

public struct SessionDeleteResponse: Hashable, Sendable, Decodable {
    public var deleted: Bool
    /// True when the deleted session was the caller's own: the caller is now signed out.
    public var signedOut: Bool

    public init(deleted: Bool, signedOut: Bool) {
        self.deleted = deleted
        self.signedOut = signedOut
    }
}

// MARK: - Sync

public struct SyncResponse: Hashable, Sendable, Codable {
    /// Changed (or, on a full sync, all live) packages, oldest change first.
    public var packages: [Package]
    /// Every event of every package in `packages`: replace each package's events wholesale.
    public var events: [TrackEvent]
    /// Ids deleted since the cursor. Empty on a full sync.
    public var deleted: [String]
    /// Opaque; pass as `since` next time.
    public var cursor: String
    /// Call again with `cursor` right away while true.
    public var hasMore: Bool

    public init(packages: [Package], events: [TrackEvent], deleted: [String], cursor: String, hasMore: Bool) {
        self.packages = packages
        self.events = events
        self.deleted = deleted
        self.cursor = cursor
        self.hasMore = hasMore
    }
}

// MARK: - Packages

/// `PUT /v1/packages/:id`. Only fields that are set are sent.
///
/// The optional-of-optional fields tell "leave alone" from "clear":
/// `nil` leaves the field out, `.some(nil)` sends `null`.
public struct PackagePutRequest: Hashable, Sendable, Encodable {
    /// Required on create. The server normalizes it.
    public var trackingNumber: String?
    /// Left out on create: the server picks the top detected carrier, else `other`.
    public var carrier: Carrier?
    public var title: String??
    public var merchant: String??
    public var orderId: String??
    /// Create only.
    public var source: ClientSource?
    public var archived: Bool?

    public init(
        trackingNumber: String? = nil, carrier: Carrier? = nil, title: String?? = nil, merchant: String?? = nil,
        orderId: String?? = nil, source: ClientSource? = nil, archived: Bool? = nil
    ) {
        self.trackingNumber = trackingNumber
        self.carrier = carrier
        self.title = title
        self.merchant = merchant
        self.orderId = orderId
        self.source = source
        self.archived = archived
    }

    enum CodingKeys: String, CodingKey { case trackingNumber, carrier, title, merchant, orderId, source, archived }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(trackingNumber, forKey: .trackingNumber)
        try c.encodeIfPresent(carrier, forKey: .carrier)
        if let title { try c.encode(title, forKey: .title) }
        if let merchant { try c.encode(merchant, forKey: .merchant) }
        if let orderId { try c.encode(orderId, forKey: .orderId) }
        try c.encodeIfPresent(source, forKey: .source)
        try c.encodeIfPresent(archived, forKey: .archived)
    }
}

/// `PUT /v1/packages/:id` answers 201 on create and 200 on update.
public struct PackagePutResult: Hashable, Sendable {
    public var package: Package
    public var created: Bool

    public init(package: Package, created: Bool) {
        self.package = package
        self.created = created
    }
}

/// `GET /v1/packages/:id`.
public struct PackageResponse: Hashable, Sendable, Decodable {
    public var package: Package
    /// Newest first.
    public var events: [TrackEvent]

    public init(package: Package, events: [TrackEvent]) {
        self.package = package
        self.events = events
    }
}

public struct PackageDeleteResponse: Hashable, Sendable, Decodable {
    public var id: String
    public var deletedAt: Date

    public init(id: String, deletedAt: Date) {
        self.id = id
        self.deletedAt = deletedAt
    }
}

public struct RefreshResponse: Hashable, Sendable, Decodable {
    public var queued: Bool
    public var nextAllowedAt: Date

    public init(queued: Bool, nextAllowedAt: Date) {
        self.queued = queued
        self.nextAllowedAt = nextAllowedAt
    }
}

// MARK: - Imports

public struct FlintImportItem: Hashable, Sendable, Encodable {
    public var trackingNumber: String
    public var carrier: Carrier?
    public var merchant: String?
    public var subject: String?
    public var messageDate: Date
    /// RFC 5322 Message-ID.
    public var dedupeKey: String

    public init(trackingNumber: String, carrier: Carrier?, merchant: String?, subject: String?, messageDate: Date, dedupeKey: String) {
        self.trackingNumber = trackingNumber
        self.carrier = carrier
        self.merchant = merchant
        self.subject = subject
        self.messageDate = messageDate
        self.dedupeKey = dedupeKey
    }

    enum CodingKeys: String, CodingKey { case trackingNumber, carrier, merchant, subject, messageDate, dedupeKey }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(trackingNumber, forKey: .trackingNumber)
        try c.encodeIfPresent(carrier, forKey: .carrier)
        try c.encode(merchant, forKey: .merchant)
        try c.encode(subject, forKey: .subject)
        try c.encode(messageDate, forKey: .messageDate)
        try c.encode(dedupeKey, forKey: .dedupeKey)
    }
}

public struct AmazonObserved: Hashable, Sendable, Encodable {
    public var status: Status
    public var statusDetail: String
    /// When the device read the Amazon track page.
    public var observedAt: Date
    public var deliveredAt: Date?
    /// Newest first, as read from the page.
    public var events: [ObservedEvent]

    public init(status: Status, statusDetail: String, observedAt: Date, deliveredAt: Date?, events: [ObservedEvent]) {
        self.status = status
        self.statusDetail = statusDetail
        self.observedAt = observedAt
        self.deliveredAt = deliveredAt
        self.events = events
    }

    enum CodingKeys: String, CodingKey { case status, statusDetail, observedAt, deliveredAt, events }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(status, forKey: .status)
        try c.encode(statusDetail, forKey: .statusDetail)
        try c.encode(observedAt, forKey: .observedAt)
        try c.encode(deliveredAt, forKey: .deliveredAt)
        try c.encode(events, forKey: .events)
    }
}

public struct AmazonImportItem: Hashable, Sendable, Encodable {
    public var orderId: String
    public var shipmentId: String
    public var carrier: Carrier
    public var trackingNumber: String
    public var title: String?
    public var items: [PackageItem]
    /// The ETA Amazon showed. Encoded as etaStart / etaEnd / etaDateOnly;
    /// `.none` sends both null, which keeps the stored ETA.
    public var eta: ETA
    /// Sent for Amazon Logistics (TBA) packages.
    public var observed: AmazonObserved?

    public init(
        orderId: String, shipmentId: String, carrier: Carrier, trackingNumber: String, title: String?,
        items: [PackageItem], eta: ETA, observed: AmazonObserved?
    ) {
        self.orderId = orderId
        self.shipmentId = shipmentId
        self.carrier = carrier
        self.trackingNumber = trackingNumber
        self.title = title
        self.items = items
        self.eta = eta
        self.observed = observed
    }

    enum CodingKeys: String, CodingKey {
        case orderId, shipmentId, carrier, trackingNumber, title, items, etaStart, etaEnd, etaDateOnly, observed
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(orderId, forKey: .orderId)
        try c.encode(shipmentId, forKey: .shipmentId)
        try c.encode(carrier, forKey: .carrier)
        try c.encode(trackingNumber, forKey: .trackingNumber)
        try c.encode(title, forKey: .title)
        try c.encode(items, forKey: .items)
        try eta.encode(to: &c, start: .etaStart, end: .etaEnd, dateOnly: .etaDateOnly)
        try c.encodeIfPresent(observed, forKey: .observed)
    }
}

/// `{ "items": [...] }`, 1 to 100 items.
public struct ImportRequest<Item: Encodable & Sendable & Hashable>: Hashable, Sendable, Encodable {
    public var items: [Item]
    public init(items: [Item]) { self.items = items }
}

public enum ImportOutcome: String, Hashable, Sendable, Decodable {
    case created, updated, unchanged, rejected
}

public struct ImportResult: Hashable, Sendable, Decodable {
    public var dedupeKey: String
    public var packageId: String?
    public var outcome: ImportOutcome
    /// Set when `outcome` is `.rejected`.
    public var reason: String?
}

public struct ImportResponse: Hashable, Sendable, Decodable {
    public var results: [ImportResult]
}

// MARK: - Pairing and API tokens

public struct PairingStartResponse: Hashable, Sendable, Decodable {
    /// "ABCD-EFGH".
    public var code: String
    public var expiresAt: Date
}

public struct PairingClaimRequest: Hashable, Sendable, Encodable {
    public var code: String
    public var label: String
    public init(code: String, label: String) {
        self.code = code
        self.label = label
    }
}

public struct PairingClaimResponse: Hashable, Sendable, Decodable {
    /// "plt_...", shown once.
    public var token: String
    public var tokenId: String
    public var scopes: [String]
}

public struct APITokenInfo: Identifiable, Hashable, Sendable, Decodable {
    public var id: String
    public var label: String
    public var scopes: [String]
    public var createdAt: Date
    public var lastUsedAt: Date?
}

public struct TokensResponse: Hashable, Sendable, Decodable {
    public var tokens: [APITokenInfo]
}
