/// Where a package came from (`packages.source`).
public enum Source: String, CaseIterable, Sendable, Hashable, Codable {
    case manual
    case amazon
    case flint
    case share

    /// The detail view's Source fact (DESIGN.md §6).
    public var label: String {
        switch self {
        case .manual: "Added by hand"
        case .amazon: "From Amazon"
        case .flint: "From Flint"
        case .share: "Shared"
        }
    }
}

/// The `source` a client may send on create. `amazon` and `flint` are set by
/// the import endpoints only.
public enum ClientSource: String, Sendable, Hashable, Codable {
    case manual
    case share
}
