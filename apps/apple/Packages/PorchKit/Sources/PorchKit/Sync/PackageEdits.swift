import Foundation

// The merge rules the sync engine and the SwiftData repository share. They
// follow apps/web/src/data/store.ts: a copy older than the one held is
// ignored, and a package this client deleted is never brought back.

extension Package {
    /// This package with a PUT's client-owned fields applied, as the server
    /// would apply them. `archived: true` keeps an existing `archivedAt`.
    public func applying(_ request: PackagePutRequest, at now: Date) -> Package {
        var copy = self
        if let title = request.title { copy.title = title }
        if let merchant = request.merchant { copy.merchant = merchant }
        if let orderId = request.orderId { copy.orderId = orderId }
        if let archived = request.archived { copy.archivedAt = archived ? (archivedAt ?? now) : nil }
        return copy
    }

    /// The optimistic local copy of a create, before the server answers.
    public static func optimisticCreate(id: String, _ request: PackagePutRequest, at now: Date) -> Package {
        let source: Source = request.source.flatMap { Source(rawValue: $0.rawValue) } ?? .manual
        let base = Package(
            id: id, carrier: request.carrier ?? .other,
            trackingNumber: (request.trackingNumber ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            source: source, status: .unknown, updatedAt: now
        )
        return base.applying(request, at: now)
    }

    /// True when `incoming` is older than this copy, e.g. a sync that started
    /// before a PUT returned. Equal times are not stale.
    public func isNewer(than incoming: Package) -> Bool {
        updatedAt > incoming.updatedAt
    }
}

extension PackagePutRequest {
    /// True for a create (it carries the tracking number).
    public var isCreate: Bool { trackingNumber != nil }

    /// `current` with the fields this request sets copied back from `original`:
    /// undoes this edit and keeps everything else.
    public func reverting(_ current: Package, to original: Package) -> Package {
        var copy = current
        if title != nil { copy.title = original.title }
        if merchant != nil { copy.merchant = original.merchant }
        if orderId != nil { copy.orderId = original.orderId }
        if archived != nil { copy.archivedAt = original.archivedAt }
        return copy
    }
}

/// Reading back a queued PUT (StoredPendingWrite.body). Absent keys stay nil;
/// a `null` becomes `.some(nil)`, so "clear" survives the round trip.
extension PackagePutRequest: Decodable {
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func clearable(_ key: CodingKeys) throws -> String?? {
            guard c.contains(key) else { return nil }
            return .some(try c.decodeNil(forKey: key) ? nil : try c.decode(String.self, forKey: key))
        }
        self.init(
            trackingNumber: try c.decodeIfPresent(String.self, forKey: .trackingNumber),
            carrier: try c.decodeIfPresent(Carrier.self, forKey: .carrier),
            title: try clearable(.title),
            merchant: try clearable(.merchant),
            orderId: try clearable(.orderId),
            source: try c.decodeIfPresent(ClientSource.self, forKey: .source),
            archived: try c.decodeIfPresent(Bool.self, forKey: .archived)
        )
    }
}
