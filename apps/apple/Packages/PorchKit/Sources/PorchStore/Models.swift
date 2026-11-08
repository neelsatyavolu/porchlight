import Foundation
import PorchKit
import SwiftData

// CONTRACT: the SwiftData schema. Adding a stored property is a schema change:
// add a VersionedSchema and a migration stage before the first TestFlight build.
// Views may read these with @Query; writes go through SyncEngine.

@Model
public final class StoredPackage {
    @Attribute(.unique) public var id: String
    public var carrierRaw: String
    public var trackingNumber: String
    public var title: String?
    public var merchant: String?
    public var orderId: String?
    public var sourceRaw: String
    public var statusRaw: String
    public var statusDetail: String?
    /// The ETA's wire fields, kept verbatim (see ETA.wireFields).
    public var etaStart: String?
    public var etaEnd: String?
    public var etaDateOnly: Bool
    /// `etaEnd ?? etaStart` as an instant, for sorting in @Query.
    public var etaSortDate: Date?
    public var deliveredAt: Date?
    public var lastCheckedAt: Date?
    public var archivedAt: Date?
    public var updatedAt: Date
    public var items: [PackageItem]
    /// True while a local edit hasn't been acknowledged by the server.
    public var hasPendingWrite: Bool
    @Relationship(deleteRule: .cascade, inverse: \StoredEvent.package)
    public var events: [StoredEvent] = []

    public init(_ pkg: Package, hasPendingWrite: Bool = false) {
        id = pkg.id
        carrierRaw = pkg.carrier.rawValue
        trackingNumber = pkg.trackingNumber
        sourceRaw = pkg.source.rawValue
        statusRaw = pkg.status.rawValue
        etaDateOnly = false
        updatedAt = pkg.updatedAt
        items = pkg.items
        self.hasPendingWrite = hasPendingWrite
        update(from: pkg)
    }

    /// Copies every field of `pkg` except `id`.
    public func update(from pkg: Package) {
        carrierRaw = pkg.carrier.rawValue
        trackingNumber = pkg.trackingNumber
        title = pkg.title
        merchant = pkg.merchant
        orderId = pkg.orderId
        sourceRaw = pkg.source.rawValue
        statusRaw = pkg.status.rawValue
        statusDetail = pkg.statusDetail
        let eta = pkg.eta.wireFields
        etaStart = eta.start
        etaEnd = eta.end
        etaDateOnly = eta.dateOnly
        etaSortDate = pkg.eta.sortDate
        deliveredAt = pkg.deliveredAt
        lastCheckedAt = pkg.lastCheckedAt
        archivedAt = pkg.archivedAt
        updatedAt = pkg.updatedAt
        items = pkg.items
    }

    public var package: Package {
        Package(
            id: id,
            carrier: Carrier(rawValue: carrierRaw) ?? .other,
            trackingNumber: trackingNumber,
            title: title,
            merchant: merchant,
            orderId: orderId,
            source: Source(rawValue: sourceRaw) ?? .manual,
            status: Status(rawValue: statusRaw) ?? .unknown,
            statusDetail: statusDetail,
            eta: ETA(wireStart: etaStart, wireEnd: etaEnd, dateOnly: etaDateOnly),
            deliveredAt: deliveredAt,
            lastCheckedAt: lastCheckedAt,
            archivedAt: archivedAt,
            updatedAt: updatedAt,
            items: items
        )
    }
}

@Model
public final class StoredEvent {
    @Attribute(.unique) public var id: String
    public var package: StoredPackage?
    public var occurredAt: Date
    public var statusRaw: String
    public var detail: String
    public var location: String?

    public init(_ event: TrackEvent, package: StoredPackage?) {
        id = event.id
        self.package = package
        occurredAt = event.occurredAt
        statusRaw = event.status.rawValue
        detail = event.description
        location = event.location
    }

    public func event(packageId: String) -> TrackEvent {
        TrackEvent(id: id, packageId: packageId, occurredAt: occurredAt, status: Status(rawValue: statusRaw) ?? .unknown,
                   description: detail, location: location)
    }
}

/// A queued PendingWrite, oldest first by `createdAt`.
@Model
public final class StoredPendingWrite {
    public var createdAt: Date
    public var packageId: String
    /// "put" or "delete".
    public var kind: String
    /// The PackagePutRequest JSON (WireJSON) for "put"; nil for "delete".
    public var body: Data?

    public init(createdAt: Date, packageId: String, kind: String, body: Data?) {
        self.createdAt = createdAt
        self.packageId = packageId
        self.kind = kind
        self.body = body
    }
}

/// One row: the sync cursor.
@Model
public final class StoredSyncState {
    public var cursor: String?
    public var lastSyncedAt: Date?

    public init(cursor: String? = nil, lastSyncedAt: Date? = nil) {
        self.cursor = cursor
        self.lastSyncedAt = lastSyncedAt
    }
}

public enum PorchStore {
    public static let models: [any PersistentModel.Type] = [
        StoredPackage.self, StoredEvent.self, StoredPendingWrite.self, StoredSyncState.self,
    ]

    /// The app's own container. No app group (owner decision): the share
    /// extension and the widget read the API with the shared keychain token
    /// instead of opening this store. `inMemory` for tests and previews.
    public static func makeContainer(inMemory: Bool = false) throws -> ModelContainer {
        let schema = Schema(models)
        let config = inMemory
            ? ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            : ModelConfiguration(schema: schema, groupContainer: .none)
        return try ModelContainer(for: schema, configurations: config)
    }
}
