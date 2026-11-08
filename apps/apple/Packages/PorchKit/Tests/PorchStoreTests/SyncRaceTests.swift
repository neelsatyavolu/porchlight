import Foundation
import PorchKit
import PorchStore
import Synchronization
import Testing

/// Forwards to a real repository, and can park the next `apply` (after it
/// finished) or the next `packages(includeArchived:)` (before it runs), so a
/// test can run other engine calls in that window.
final class GatedRepository: PackageRepository {
    let base: SwiftDataPackageRepository
    let afterApply = Mutex<Gate?>(nil)
    let beforePackages = Mutex<Gate?>(nil)

    init(_ base: SwiftDataPackageRepository) { self.base = base }

    func packages(includeArchived: Bool) async throws -> [Package] {
        if let gate = beforePackages.withLock({ $0.take() }) { await gate.wait() }
        return try await base.packages(includeArchived: includeArchived)
    }

    func apply(_ page: SyncResponse) async throws {
        try await base.apply(page)
        if let gate = afterApply.withLock({ $0.take() }) { await gate.wait() }
    }

    func package(id: String) async throws -> Package? { try await base.package(id: id) }
    func events(packageId: String) async throws -> [TrackEvent] { try await base.events(packageId: packageId) }
    func removeAll() async throws { try await base.removeAll() }
    func enqueue(_ write: PendingWrite, optimistic: Package?) async throws { try await base.enqueue(write, optimistic: optimistic) }
    func pendingWrites() async throws -> [PendingWrite] { try await base.pendingWrites() }
    func acknowledge(_ write: PendingWrite, result: Package?) async throws { try await base.acknowledge(write, result: result) }
    func adopt(localId: String, existingId: String) async throws { try await base.adopt(localId: localId, existingId: existingId) }
    func cursor() async throws -> String? { try await base.cursor() }
    func setCursor(_ cursor: String?) async throws { try await base.setCursor(cursor) }
}

@Suite struct SyncRaceTests {
    let api = FakeAPIClient()
    let repo: GatedRepository
    let engine: DefaultSyncEngine

    init() throws {
        repo = GatedRepository(try makeRepository())
        engine = DefaultSyncEngine(api: api, repository: repo, now: { T0 })
    }

    @Test func anInterruptedFullSyncSavesNoCursor() async throws {
        api.configure {
            $0.syncPages["nil"] = [page([pkg("a")], cursor: "c1", hasMore: true)]
            $0.syncError["c1"] = APIError.network("offline")
        }
        await #expect(throws: APIError.self) { try await engine.sync() }
        // The next sync starts over, so it can still prune.
        #expect(try await repo.cursor() == nil)
        #expect(try await repo.package(id: "a") != nil)
    }

    @Test func aSignOutDuringAPageDoesNotSaveTheOldCursor() async throws {
        try await repo.apply(page([pkg("a")]))
        try await repo.setCursor("c0")
        let gate = Gate()
        repo.afterApply.withLock { $0 = gate }
        api.configure { $0.syncPages["c0"] = [page([pkg("b")], cursor: "c1")] }

        let engine = engine
        let syncing = Task { try await engine.sync() }
        await gate.waitUntilEntered()
        try await engine.reset()
        gate.open()
        await #expect(throws: CancellationError.self) { _ = try await syncing.value }
        #expect(try await repo.cursor() == nil)
    }

    @Test func aPackageAddedWhileAFullSyncPrunesIsKept() async throws {
        let gate = Gate()
        repo.beforePackages.withLock { $0 = gate }
        api.configure {
            $0.syncPages["nil"] = [page([], cursor: "c1")]
            $0.put = { _, _ in throw APIError.network("offline") }
        }

        async let syncing: SyncOutcome = engine.sync()
        await gate.waitUntilEntered()
        let added = try await engine.addPackage(trackingNumber: "1Z999", carrier: .ups, title: nil, source: .manual)
        gate.open()
        _ = try await syncing
        #expect(try await repo.package(id: added.id) != nil)
        #expect(try await repo.cursor() == "c1")
    }
}
