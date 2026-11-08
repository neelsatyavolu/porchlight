// CONTRACT: mirrors CarrierId in packages/carriers/src/types.ts. Add a case
// there and here in the same change.

/// Every carrier Porchlight knows by name. Anything else is `.other`.
public enum Carrier: String, CaseIterable, Sendable, Hashable, Codable {
    case usps
    case ups
    case fedex
    case dhl
    case dhlEcommerce = "dhl_ecommerce"
    case amazon
    case ontrac
    case lasership
    case uniuni
    case jitsu
    case other

    /// An id this build doesn't know decodes as `.other`, so a carrier added
    /// on the server can't break a whole sync page.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Carrier(rawValue: raw) ?? .other
    }

    /// Display name (apps/web/src/lib/carriers.ts).
    public var displayName: String {
        switch self {
        case .usps: "USPS"
        case .ups: "UPS"
        case .fedex: "FedEx"
        case .dhl: "DHL"
        case .dhlEcommerce: "DHL eCommerce"
        case .amazon: "Amazon"
        case .ontrac: "OnTrac"
        case .lasership: "LaserShip"
        case .uniuni: "UniUni"
        case .jitsu: "Jitsu"
        case .other: "Other carrier"
        }
    }
}
