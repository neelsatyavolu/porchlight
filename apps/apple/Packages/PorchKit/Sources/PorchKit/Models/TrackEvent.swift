import Foundation

// CONTRACT: `PackageEvent` in docs/API.md (sync `events`).

/// One carrier scan of a package.
public struct TrackEvent: Identifiable, Hashable, Sendable, Codable {
    public var id: String
    public var packageId: String
    public var occurredAt: Date
    public var status: Status
    public var description: String
    /// "Oakland, CA, US", or nil when the carrier gives none.
    public var location: String?

    public init(id: String, packageId: String, occurredAt: Date, status: Status, description: String, location: String? = nil) {
        self.id = id
        self.packageId = packageId
        self.occurredAt = occurredAt
        self.status = status
        self.description = description
        self.location = location
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(packageId, forKey: .packageId)
        try c.encode(occurredAt, forKey: .occurredAt)
        try c.encode(status, forKey: .status)
        try c.encode(description, forKey: .description)
        try c.encode(location, forKey: .location)
    }
}

/// An event read on the device (Amazon track page), before the server gives it an id.
public struct ObservedEvent: Hashable, Sendable, Codable {
    public var occurredAt: Date
    public var status: Status
    public var description: String
    public var location: String?

    public init(occurredAt: Date, status: Status, description: String, location: String? = nil) {
        self.occurredAt = occurredAt
        self.status = status
        self.description = description
        self.location = location
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(occurredAt, forKey: .occurredAt)
        try c.encode(status, forKey: .status)
        try c.encode(description, forKey: .description)
        try c.encode(location, forKey: .location)
    }
}
