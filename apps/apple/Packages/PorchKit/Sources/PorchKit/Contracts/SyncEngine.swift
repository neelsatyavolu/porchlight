import Foundation

// CONTRACT: the one path for reading from and writing to the server. Screens
// call it for writes and read packages from the store (PackageRepository or
// SwiftData @Query); they never call APIClient for packages directly.

public struct SyncOutcome: Hashable, Sendable {
    public var changed: Int
    public var deleted: Int
    /// True when the cursor was refused (400) and a full sync ran instead.
    public var didFullSync: Bool
    public var finishedAt: Date

    public init(changed: Int, deleted: Int, didFullSync: Bool, finishedAt: Date) {
        self.changed = changed
        self.deleted = deleted
        self.didFullSync = didFullSync
        self.finishedAt = finishedAt
    }
}

/// What `SyncEngine.addPackage` made.
public struct AddedPackage: Hashable, Sendable {
    public var id: String
    /// True after a 409 duplicate: `id` is the package the account already tracks.
    public var alreadyTracked: Bool

    public init(id: String, alreadyTracked: Bool) {
        self.id = id
        self.alreadyTracked = alreadyTracked
    }
}

public protocol SyncEngine: Sendable {
    /// Sends pending writes, then pulls `GET /v1/sync?since=<cursor>` page by
    /// page until `hasMore` is false. A 400 on the cursor clears it and runs a
    /// full sync. Safe to call concurrently: overlapping calls join one run.
    @discardableResult
    func sync() async throws -> SyncOutcome

    /// Creates a package with a new client id. Applies locally first. On a 409
    /// duplicate the local copy is adopted into the existing package (see
    /// PackageRepository.adopt) and the result is that id, `alreadyTracked`.
    /// While offline the result is the new id; a duplicate found later is
    /// adopted on the next sync.
    func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage
    /// Client-owned fields only: title, merchant, orderId, archived.
    func update(packageId: String, _ request: PackagePutRequest) async throws
    func delete(packageId: String) async throws
    /// `POST /v1/packages/:id/refresh`. Throws `APIError.server` with code
    /// `.rateLimited` and `retryAfter` when checked too recently.
    func refresh(packageId: String) async throws -> RefreshResponse

    /// Sign-out: drops the cursor, local packages and queued writes.
    func reset() async throws
}

/// Default `SyncEngine` over an APIClient and a PackageRepository.
///
/// Writes are optimistic: the local copy changes first, the write is queued,
/// and the queue is sent oldest first. A write that can't reach the server
/// (offline, 5xx, 429, 401) stays queued for the next sync. One the server
/// refuses (400, 403, 404, 409) is rolled back to the server's copy and its
/// error is thrown to the caller that made it.
///
/// Like apps/web/src/data/store.ts, a sync that started before a write
/// returned can't undo it: older copies are ignored (repository), and ids
/// this client deleted are never brought back (`removed`).
public actor DefaultSyncEngine: SyncEngine {
    public let api: any APIClient
    public let repository: any PackageRepository
    public let now: @Sendable () -> Date

    private var syncTask: Task<SyncOutcome, any Error>?
    private var flushTask: Task<Void, Never>?
    /// Bumped by `reset()`, so a run that started for the previous user writes nothing.
    private var generation = 0
    /// Package ids this client deleted. Ids are never reused (docs/API.md).
    private var removed: Set<String> = []
    /// Ids written while the current sync ran; a full sync must not prune them.
    private var writtenDuringSync: Set<String> = []
    /// The local copy before each queued write, for rollback when the server can't be asked.
    private var snapshots: [PendingWrite: Package] = [:]
    /// Errors of refused writes, until the caller that queued them picks them up.
    private var refused: [PendingWrite: any Error] = [:]
    /// Local id to the server's id, after a 409 duplicate.
    private var adopted: [String: String] = [:]

    public init(api: any APIClient, repository: any PackageRepository, now: @escaping @Sendable () -> Date = { Date() }) {
        self.api = api
        self.repository = repository
        self.now = now
    }

    // MARK: Sync

    @discardableResult
    public func sync() async throws -> SyncOutcome {
        if let running = syncTask { return try await running.value }
        let task = Task { try await self.runSync() }
        syncTask = task
        defer { if syncTask == task { syncTask = nil } }
        return try await task.value
    }

    private func runSync() async throws -> SyncOutcome {
        let gen = generation
        writtenDuringSync = []
        await flush()

        var cursor = try await repository.cursor()
        var isFull = cursor == nil
        var didFullSync = false
        var seen: Set<String> = []
        var changed = 0
        var deleted = 0

        while true {
            let page: SyncResponse
            do {
                page = try await api.sync(since: cursor)
            } catch let error as APIError where error.code == .badRequest && cursor != nil {
                // Unknown cursor: start over with a full sync (docs/API.md, Sync).
                try check(gen)
                try await repository.setCursor(nil)
                cursor = nil
                isFull = true
                didFullSync = true
                continue
            }
            try check(gen)
            try await repository.apply(SyncResponse(
                packages: page.packages.filter { !removed.contains($0.id) },
                events: page.events.filter { !removed.contains($0.packageId) },
                deleted: page.deleted, cursor: page.cursor, hasMore: page.hasMore
            ))
            seen.formUnion(page.packages.map(\.id))
            changed += page.packages.count
            deleted += page.deleted.count
            if !page.cursor.isEmpty {
                cursor = page.cursor
                // A full sync keeps its cursor until the prune below has run: a
                // later incremental sync would never prune what it missed.
                if !isFull {
                    try check(gen)
                    try await repository.setCursor(page.cursor)
                }
            }
            if !page.hasMore { break }
        }

        if isFull {
            deleted += try await pruneMissing(seen: seen, gen: gen)
            if let cursor {
                try check(gen)
                try await repository.setCursor(cursor)
            }
        }
        return SyncOutcome(changed: changed, deleted: deleted, didFullSync: didFullSync, finishedAt: now())
    }

    /// A full snapshot lists every live package, so local ones it left out were
    /// deleted elsewhere. Packages with queued or just-sent writes are kept.
    private func pruneMissing(seen: Set<String>, gen: Int) async throws -> Int {
        // Local ids first, then queued writes, then sent ones: a package created
        // while this runs is either missing from `local` or covered by `keep`.
        let local = try await repository.packages(includeArchived: true).map(\.id)
        let pending = try await repository.pendingWrites().map(\.packageId)
        let keep = seen.union(pending).union(writtenDuringSync)
        let gone = local.filter { !keep.contains($0) }
        guard !gone.isEmpty else { return 0 }
        try check(gen)
        try await repository.apply(SyncResponse(packages: [], events: [], deleted: gone, cursor: "", hasMore: false))
        return gone.count
    }

    private func check(_ gen: Int) throws {
        if gen != generation { throw CancellationError() }
    }

    // MARK: Writes

    public func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage {
        let number = trackingNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !number.isEmpty else { throw SyncError.emptyTrackingNumber }
        let id = WireID.make()
        let cleanTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let request = PackagePutRequest(
            trackingNumber: number, carrier: carrier,
            title: cleanTitle.flatMap { $0.isEmpty ? nil : .some($0) }, source: source
        )
        let write = PendingWrite.put(id: id, request: request)
        try await repository.enqueue(write, optimistic: .optimisticCreate(id: id, request, at: now()))
        try await send(write)
        if let existing = adopted[id] { return AddedPackage(id: existing, alreadyTracked: true) }
        return AddedPackage(id: id, alreadyTracked: false)
    }

    public func update(packageId: String, _ request: PackagePutRequest) async throws {
        // Client-owned fields only; the rest can't change after create.
        let edit = PackagePutRequest(title: request.title, merchant: request.merchant, orderId: request.orderId, archived: request.archived)
        let id = adopted[packageId] ?? packageId
        let write = PendingWrite.put(id: id, request: edit)
        let current = try await repository.package(id: id)
        if let current { snapshots[write] = current }
        try await repository.enqueue(write, optimistic: current?.applying(edit, at: now()))
        try await send(write)
    }

    public func delete(packageId: String) async throws {
        let id = adopted[packageId] ?? packageId
        let write = PendingWrite.delete(id: id)
        if let current = try await repository.package(id: id) { snapshots[write] = current }
        try await repository.enqueue(write, optimistic: nil)
        try await send(write)
    }

    public func refresh(packageId: String) async throws -> RefreshResponse {
        try await api.refreshPackage(id: adopted[packageId] ?? packageId)
    }

    public func reset() async throws {
        generation += 1
        syncTask?.cancel()
        syncTask = nil
        removed = []
        writtenDuringSync = []
        snapshots = [:]
        refused = [:]
        adopted = [:]
        try await repository.removeAll()
    }

    /// Sends the queue (with `write` in it) and throws if the server refused `write`.
    private func send(_ write: PendingWrite) async throws {
        await flush()
        if let error = refused.removeValue(forKey: write) { throw error }
    }

    // MARK: Queue

    /// One flush at a time. Returns after a flush that started after this call.
    private func flush() async {
        while let running = flushTask { await running.value }
        let task = Task {
            await self.drainQueue()
            // Cleared by the task itself, so waiters never see a finished task.
            self.flushTask = nil
        }
        flushTask = task
        await task.value
    }

    private func drainQueue() async {
        let gen = generation
        var last: PendingWrite?
        while gen == generation, let write = try? await repository.pendingWrites().first, write != last {
            last = write
            guard await deliver(write, gen: gen) else { return }
        }
    }

    /// Sends one write. False when it should wait for the next sync.
    private func deliver(_ write: PendingWrite, gen: Int) async -> Bool {
        do {
            switch write {
            case let .put(id, request):
                let result = try await api.putPackage(id: id, request)
                try check(gen)
                // Before the acknowledge, so a prune running meanwhile always sees it.
                writtenDuringSync.insert(id)
                try await repository.acknowledge(write, result: result.package)
            case let .delete(id):
                _ = try await api.deletePackage(id: id)
                try check(gen)
                try await finishDelete(write)
            }
            snapshots[write] = nil
            return true
        } catch let error as APIError {
            guard gen == generation else { return false }
            return await handle(error, for: write)
        } catch {
            // Cancellation or a local store failure: try again next time.
            return false
        }
    }

    private func handle(_ error: APIError, for write: PendingWrite) async -> Bool {
        if Self.isTransient(error) { return false }
        let id = write.packageId
        do {
            switch (write, error.conflict) {
            case let (.put, .duplicate(existingId)?):
                // Already tracked: the local package becomes the server's (docs/API.md, 409).
                writtenDuringSync.insert(existingId)
                try await repository.acknowledge(write, result: nil)
                try await repository.adopt(localId: id, existingId: existingId)
                adopted[id] = existingId
                await pull(existingId)
            case (.delete, _) where error.status == 404:
                try await finishDelete(write)
            case (_, .deleted?):
                try await repository.acknowledge(write, result: nil)
                try await dropLocal(id)
                refused[write] = error
            default:
                try await rollback(write)
                refused[write] = error
            }
        } catch {
            refused[write] = error
        }
        snapshots[write] = nil
        return true
    }

    private func finishDelete(_ write: PendingWrite) async throws {
        removed.insert(write.packageId)
        try await repository.acknowledge(write, result: nil)
    }

    /// Puts the server's copy back. When the server can't be asked, undoes the
    /// write from the snapshot taken before it.
    private func rollback(_ write: PendingWrite) async throws {
        let id = write.packageId
        do {
            let server = try await api.getPackage(id: id)
            try await repository.acknowledge(write, result: nil)
            try await repository.apply(SyncResponse(packages: [server.package], events: server.events, deleted: [], cursor: "", hasMore: false))
            return
        } catch let error as APIError where error.status == 404 {
            try await repository.acknowledge(write, result: nil)
            try await dropLocal(id)
            return
        } catch {
            // Fall through to the snapshot.
        }
        let snapshot = snapshots[write]
        switch write {
        case let .put(_, request) where request.isCreate:
            try await repository.acknowledge(write, result: nil)
            try await dropLocal(id)
        case let .put(_, request):
            let current = try await repository.package(id: id)
            let reverted = snapshot.map { request.reverting(current ?? $0, to: $0) }
            try await repository.acknowledge(write, result: reverted)
        case .delete:
            try await repository.acknowledge(write, result: snapshot)
        }
    }

    private func dropLocal(_ id: String) async throws {
        try await repository.apply(SyncResponse(packages: [], events: [], deleted: [id], cursor: "", hasMore: false))
    }

    /// Fetches one package the cursor may already be past (an adopted id).
    private func pull(_ id: String) async {
        guard let response = try? await api.getPackage(id: id) else { return }
        try? await repository.apply(SyncResponse(packages: [response.package], events: response.events, deleted: [], cursor: "", hasMore: false))
    }

    static func isTransient(_ error: APIError) -> Bool {
        switch error {
        case .network, .invalidResponse: true
        case let .server(status, _, _): status == 401 || status == 408 || status == 429 || status >= 500
        }
    }
}

public enum SyncError: Error, Hashable, Sendable {
    case emptyTrackingNumber
}

extension APIError {
    /// The HTTP status of a server error, else nil.
    public var status: Int? {
        if case let .server(status, _, _) = self { return status }
        return nil
    }
}
