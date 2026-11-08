import Foundation
import PorchKit
import SwiftData

/// SwiftData-backed `PackageRepository`.
///
/// Create one per container: `SwiftDataPackageRepository(modelContainer: container)`.
/// It runs on its own context, so views reading with @Query on the main
/// context see its saves.
///
/// Merge rules (apps/web/src/data/store.ts): a sync copy older than the held
/// one is ignored; a package with a queued delete is not brought back; queued
/// PUTs stay applied on top of every server copy until acknowledged.
@ModelActor
public actor SwiftDataPackageRepository: PackageRepository {
    // MARK: Reads

    public func packages(includeArchived: Bool) async throws -> [Package] {
        var descriptor = FetchDescriptor<StoredPackage>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)])
        if !includeArchived { descriptor.predicate = #Predicate { $0.archivedAt == nil } }
        return try modelContext.fetch(descriptor).map(\.package)
    }

    public func package(id: String) async throws -> Package? {
        try stored(id)?.package
    }

    public func events(packageId: String) async throws -> [TrackEvent] {
        guard let pkg = try stored(packageId) else { return [] }
        return pkg.events.sorted { $0.occurredAt > $1.occurredAt }.map { $0.event(packageId: packageId) }
    }

    // MARK: Sync

    public func apply(_ page: SyncResponse) async throws {
        let queued = try queuedRows()
        let pendingDeletes = Set(queued.filter { $0.kind == "delete" }.map(\.packageId))
        let eventsByPackage = Dictionary(grouping: page.events, by: \.packageId)

        for incoming in page.packages where !pendingDeletes.contains(incoming.id) {
            let puts = queuedPuts(queued, for: incoming.id)
            let merged = overlay(incoming, puts)
            let row: StoredPackage
            if let held = try stored(incoming.id) {
                if held.package.isNewer(than: incoming) { continue }
                held.update(from: merged)
                row = held
            } else {
                row = StoredPackage(merged)
                modelContext.insert(row)
            }
            row.hasPendingWrite = queued.contains { $0.packageId == incoming.id }
            replaceEvents(of: row, with: eventsByPackage[incoming.id] ?? [])
        }

        for id in page.deleted {
            if let held = try stored(id) { modelContext.delete(held) }
            for row in queued where row.packageId == id { modelContext.delete(row) }
        }
        try modelContext.save()
    }

    public func removeAll() async throws {
        // Row by row: a batch delete fails on the package/event relationship.
        for row in try modelContext.fetch(FetchDescriptor<StoredPackage>()) { modelContext.delete(row) }
        for row in try modelContext.fetch(FetchDescriptor<StoredEvent>()) { modelContext.delete(row) }
        for row in try modelContext.fetch(FetchDescriptor<StoredPendingWrite>()) { modelContext.delete(row) }
        for row in try modelContext.fetch(FetchDescriptor<StoredSyncState>()) { modelContext.delete(row) }
        try modelContext.save()
    }

    // MARK: Queued writes

    public func enqueue(_ write: PendingWrite, optimistic: Package?) async throws {
        modelContext.insert(StoredPendingWrite(createdAt: try nextStamp(), packageId: write.packageId, kind: write.kind, body: try write.body()))
        switch write {
        case .put:
            if let optimistic { upsert(optimistic, pending: true) }
        case let .delete(id):
            if let held = try stored(id) { modelContext.delete(held) }
        }
        try modelContext.save()
    }

    public func pendingWrites() async throws -> [PendingWrite] {
        var writes: [PendingWrite] = []
        for row in try queuedRows() {
            if let write = row.write { writes.append(write) } else { modelContext.delete(row) }
        }
        if modelContext.hasChanges { try modelContext.save() }
        return writes
    }

    public func acknowledge(_ write: PendingWrite, result: Package?) async throws {
        let queued = try queuedRows()
        if let row = queued.first(where: { $0.write == write }) { modelContext.delete(row) }
        let remaining = queued.filter { $0.packageId == write.packageId && $0.write != write }

        if let result {
            let held = try stored(result.id)
            // The answer to a create always wins: the optimistic copy carries the device's clock.
            let isCreate = if case let .put(_, request) = write { request.isCreate } else { false }
            if held == nil || isCreate || !(held!.package.isNewer(than: result)) {
                upsert(overlay(result, queuedPuts(remaining, for: result.id)), pending: !remaining.isEmpty)
            } else {
                held?.hasPendingWrite = !remaining.isEmpty
            }
        } else if let held = try stored(write.packageId) {
            held.hasPendingWrite = !remaining.isEmpty
        }
        try modelContext.save()
    }

    public func adopt(localId: String, existingId: String) async throws {
        if let local = try stored(localId) { modelContext.delete(local) }
        for row in try queuedRows() where row.packageId == localId {
            // The create itself is dropped: the server already tracks the number.
            if case let .put(_, request) = row.write, request.isCreate {
                modelContext.delete(row)
            } else {
                row.packageId = existingId
            }
        }
        if let existing = try stored(existingId) {
            let puts = queuedPuts(try queuedRows(), for: existingId)
            existing.update(from: overlay(existing.package, puts))
            existing.hasPendingWrite = try queuedRows().contains { $0.packageId == existingId }
        }
        try modelContext.save()
    }

    // MARK: Cursor

    public func cursor() async throws -> String? {
        try syncState()?.cursor
    }

    public func setCursor(_ cursor: String?) async throws {
        if let state = try syncState() {
            state.cursor = cursor
            if cursor != nil { state.lastSyncedAt = Date() }
        } else {
            modelContext.insert(StoredSyncState(cursor: cursor, lastSyncedAt: cursor == nil ? nil : Date()))
        }
        try modelContext.save()
    }

    // MARK: Helpers

    private func stored(_ id: String) throws -> StoredPackage? {
        var descriptor = FetchDescriptor<StoredPackage>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        return try modelContext.fetch(descriptor).first
    }

    private func queuedRows() throws -> [StoredPendingWrite] {
        try modelContext.fetch(FetchDescriptor<StoredPendingWrite>(sortBy: [SortDescriptor(\.createdAt)]))
    }

    private func syncState() throws -> StoredSyncState? {
        try modelContext.fetch(FetchDescriptor<StoredSyncState>()).first
    }

    private func queuedPuts(_ rows: [StoredPendingWrite], for id: String) -> [PackagePutRequest] {
        rows.compactMap { row in
            guard row.packageId == id, case let .put(_, request) = row.write else { return nil }
            return request
        }
    }

    private func overlay(_ pkg: Package, _ puts: [PackagePutRequest]) -> Package {
        let now = Date()
        return puts.reduce(pkg) { $0.applying($1, at: now) }
    }

    private func upsert(_ pkg: Package, pending: Bool) {
        if let held = try? stored(pkg.id) {
            held.update(from: pkg)
            held.hasPendingWrite = pending
        } else {
            modelContext.insert(StoredPackage(pkg, hasPendingWrite: pending))
        }
    }

    /// Sync sends every event of a package, so the stored set becomes exactly `events`.
    private func replaceEvents(of pkg: StoredPackage, with events: [TrackEvent]) {
        var held = Dictionary(pkg.events.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for event in events {
            if let row = held.removeValue(forKey: event.id) {
                row.occurredAt = event.occurredAt
                row.statusRaw = event.status.rawValue
                row.detail = event.description
                row.location = event.location
            } else {
                modelContext.insert(StoredEvent(event, package: pkg))
            }
        }
        for row in held.values { modelContext.delete(row) }
    }

    /// Strictly increasing, so two writes queued in the same instant keep their order.
    private func nextStamp() throws -> Date {
        var descriptor = FetchDescriptor<StoredPendingWrite>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        descriptor.fetchLimit = 1
        let now = Date()
        guard let last = try modelContext.fetch(descriptor).first?.createdAt, last >= now else { return now }
        return last.addingTimeInterval(0.001)
    }
}

extension PendingWrite {
    fileprivate var kind: String {
        switch self {
        case .put: "put"
        case .delete: "delete"
        }
    }

    fileprivate func body() throws -> Data? {
        switch self {
        case let .put(_, request): try WireJSON.encoder().encode(request)
        case .delete: nil
        }
    }
}

extension StoredPendingWrite {
    /// nil for a row this build can't read.
    fileprivate var write: PendingWrite? {
        switch kind {
        case "put":
            guard let body, let request = try? WireJSON.decoder().decode(PackagePutRequest.self, from: body) else { return nil }
            return .put(id: packageId, request: request)
        case "delete":
            return .delete(id: packageId)
        default:
            return nil
        }
    }
}
