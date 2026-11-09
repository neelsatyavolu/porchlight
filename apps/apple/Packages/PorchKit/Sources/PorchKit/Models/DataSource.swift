// CONTRACT: mirrors DataSource in packages/carriers/src/types.ts and the
// package `dataSource` field in docs/API.md.

/// Where a package's current status came from (`packages.last_source`).
public enum DataSource: String, CaseIterable, Sendable, Hashable, Codable {
    /// The carrier's own API with Porchlight's key (today only DHL).
    case api
    /// The carrier's public tracking feed, read by the server.
    case web
    /// Ship24.
    case aggregator
    /// A native app read the carrier page (POST /v1/packages/:id/observed).
    case device
    /// The Amazon import's observed block.
    case amazon
}
