import Foundation

// CONTRACT: "Device tracking" in docs/API.md and the DeviceJob /
// DeviceObservation types in services/api/src/types/api.ts. The app reads
// USPS, FedEx and (when the server is blocked) UPS tracking pages in a hidden
// web view and posts what it saw (docs/research/scraping.md).

extension Carrier {
    /// Carriers whose tracking page the device reads (DEVICE_CARRIERS in packages/carriers).
    public static let deviceCarriers: Set<Carrier> = [.usps, .ups, .fedex]

    public var isDeviceCarrier: Bool { Self.deviceCarriers.contains(self) }
}

/// Why the server wants the device to look.
public enum DeviceJobReason: String, CaseIterable, Sendable, Hashable, Codable {
    /// Never read yet.
    case new
    /// The per-package cadence is due.
    case scheduled
    /// The user asked for a refresh.
    case manual
    /// The server's own UPS read was blocked.
    case serverBlocked = "server_blocked"

    /// A reason this build doesn't know reads as `.scheduled`.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DeviceJobReason(rawValue: raw) ?? .scheduled
    }
}

/// One package the device should read now.
public struct DeviceJob: Hashable, Sendable, Codable {
    public var packageId: String
    /// `.usps`, `.ups` or `.fedex`.
    public var carrier: Carrier
    public var trackingNumber: String
    public var reason: DeviceJobReason

    public init(packageId: String, carrier: Carrier, trackingNumber: String, reason: DeviceJobReason) {
        self.packageId = packageId
        self.carrier = carrier
        self.trackingNumber = trackingNumber
        self.reason = reason
    }
}

/// `GET /v1/device-tracking/due`: at most 10, oldest first.
public struct DeviceJobsResponse: Hashable, Sendable, Codable {
    public var jobs: [DeviceJob]
    public init(jobs: [DeviceJob]) { self.jobs = jobs }
}

/// How a device read went.
public enum DeviceOutcome: String, CaseIterable, Sendable, Hashable, Codable {
    /// The page loaded and was parsed.
    case ok
    /// The carrier said it doesn't know the number.
    case notFound = "not_found"
    /// A bot check or CAPTCHA stopped the read. Never solved by the app.
    case challenged
    /// Anything else: a timeout, or a page the parser doesn't know.
    case failed
}

/// `POST /v1/packages/:id/observed`. Every key is encoded; `source` is always "device".
public struct DeviceObservation: Hashable, Sendable, Encodable {
    public var observedAt: Date
    public var outcome: DeviceOutcome
    public var status: Status
    public var statusDetail: String?
    /// Encoded as etaStart / etaEnd / etaDateOnly.
    public var eta: ETA
    public var deliveredAt: Date?
    /// Newest first.
    public var events: [ObservedEvent]

    public init(
        observedAt: Date, outcome: DeviceOutcome, status: Status, statusDetail: String?, eta: ETA,
        deliveredAt: Date?, events: [ObservedEvent]
    ) {
        self.observedAt = observedAt
        self.outcome = outcome
        self.status = status
        self.statusDetail = statusDetail
        self.eta = eta
        self.deliveredAt = deliveredAt
        self.events = events
    }

    /// A read that produced no data (`.notFound`, `.challenged`, `.failed`):
    /// sends "unknown", nulls, false and [], which the server ignores.
    public static func withoutData(_ outcome: DeviceOutcome, observedAt: Date) -> DeviceObservation {
        DeviceObservation(observedAt: observedAt, outcome: outcome, status: .unknown, statusDetail: nil, eta: .none,
                          deliveredAt: nil, events: [])
    }

    enum CodingKeys: String, CodingKey {
        case observedAt, source, outcome, status, statusDetail, etaStart, etaEnd, etaDateOnly, deliveredAt, events
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(observedAt, forKey: .observedAt)
        try c.encode("device", forKey: .source)
        try c.encode(outcome, forKey: .outcome)
        try c.encode(status, forKey: .status)
        try c.encode(statusDetail, forKey: .statusDetail)
        try eta.encode(to: &c, start: .etaStart, end: .etaEnd, dateOnly: .etaDateOnly)
        try c.encode(deliveredAt, forKey: .deliveredAt)
        try c.encode(events, forKey: .events)
    }
}

/// Reply to `POST /v1/packages/:id/observed`.
public struct DeviceObservedResponse: Hashable, Sendable, Codable {
    /// False when the outcome wasn't ok, or the read was not newer than the last check.
    public var applied: Bool
    /// When the server next wants a device read; nil when none is wanted.
    public var deviceNeededAt: Date?

    public init(applied: Bool, deviceNeededAt: Date?) {
        self.applied = applied
        self.deviceNeededAt = deviceNeededAt
    }
}
