// CONTRACT: mirrors Status in packages/carriers/src/types.ts and the labels and
// tones in apps/web/src/lib/status.ts (DESIGN.md §4).

/// Normalized package status (SPEC §4).
public enum Status: String, CaseIterable, Sendable, Hashable, Codable {
    case labelCreated = "label_created"
    case inTransit = "in_transit"
    case outForDelivery = "out_for_delivery"
    case availableForPickup = "available_for_pickup"
    case delivered
    case exception
    case returned
    case unknown

    /// A status this build doesn't know decodes as `.unknown`.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Status(rawValue: raw) ?? .unknown
    }

    public var label: String {
        switch self {
        case .labelCreated: "Label created"
        case .inTransit: "In transit"
        case .outForDelivery: "Out for delivery"
        case .availableForPickup: "Ready for pickup"
        case .delivered: "Delivered"
        case .exception: "Problem"
        case .returned: "Returned to sender"
        case .unknown: "No update yet"
        }
    }

    public var tone: StatusTone {
        switch self {
        case .outForDelivery, .availableForPickup: .out
        case .delivered: .delivered
        case .exception, .returned: .exception
        case .labelCreated, .inTransit, .unknown: .neutral
        }
    }

    /// Hollow dot: nothing has moved yet.
    public var isPending: Bool { self == .labelCreated || self == .unknown }

    /// Out for delivery or waiting at a pickup point: always grouped under Today.
    public var isOut: Bool { self == .outForDelivery || self == .availableForPickup }
}

/// Which color a status gets. Only these four exist (DESIGN.md §4).
public enum StatusTone: String, Sendable, Hashable {
    case out
    case delivered
    case exception
    case neutral
}
