import Foundation

// CONTRACT: the local store the apps read and the sync engine writes. The
// SwiftData implementation lives in PorchStore; this protocol stays free of
// SwiftData so PorchKit can be tested and used without it.

/// A local edit waiting to reach the server (SPEC §3: every write is an
/// idempotent PUT or DELETE keyed by a client id).
public enum PendingWrite: Hashable, Sendable {
    case put(id: String, request: PackagePutRequest)
    case delete(id: String)

    public var packageId: String {
        switch self {
        case let .put(id, _), let .delete(id): id
        }
    }
}

public protocol PackageRepository: Sendable {
    /// Live packages, newest `updatedAt` first. Archived ones only when asked.
    func packages(includeArchived: Bool) async throws -> [Package]
    func package(id: String) async throws -> Package?
    /// Newest first.
    func events(packageId: String) async throws -> [TrackEvent]

    /// Applies one sync page: upserts `packages`, replaces each one's events
    /// wholesale, removes `deleted`. Pending local field edits stay applied on
    /// top until their write is acknowledged.
    func apply(_ page: SyncResponse) async throws
    /// Removes everything local, before a full resync or on sign-out.
    func removeAll() async throws

    /// Optimistic write: changes the local copy now and queues `write`.
    func enqueue(_ write: PendingWrite, optimistic: Package?) async throws
    /// Oldest first.
    func pendingWrites() async throws -> [PendingWrite]
    /// The server accepted `write`; `result` is its copy of the package (nil for deletes).
    func acknowledge(_ write: PendingWrite, result: Package?) async throws
    /// A 409 duplicate: the local package becomes `existingId`, and queued writes follow it.
    func adopt(localId: String, existingId: String) async throws

    /// The last sync cursor, nil before the first sync.
    func cursor() async throws -> String?
    func setCursor(_ cursor: String?) async throws
}
