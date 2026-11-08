import Foundation
import PorchKit
import PorchStore
import Synchronization
import Testing

@Suite struct SyncEngineTests {
    let api = FakeAPIClient()
    let repo: SwiftDataPackageRepository
    let engine: DefaultSyncEngine

    init() throws {
        repo = try makeRepository()
        engine = DefaultSyncEngine(api: api, repository: repo, now: { T0 })
    }

    private func seed(_ packages: [Package], cursor: String = "c0") async throws {
        try await repo.apply(page(packages))
        try await repo.setCursor(cursor)
    }

    private func echoPuts(updated: Double = 1) {
        api.configure {
            $0.put = { id, request in
                PackagePutResult(package: pkg(id, updated: updated).applying(request, at: T0), created: request.isCreate)
            }
        }
    }

    // MARK: Pulling

    @Test func firstSyncFollowsPagesAndKeepsTheCursor() async throws {
        api.configure {
            $0.syncPages["nil"] = [page([pkg("a")], events: [ev("e1", "a", 0)], cursor: "c1", hasMore: true)]
            $0.syncPages["c1"] = [page([pkg("b")], cursor: "c2")]
        }
        let outcome = try await engine.sync()
        #expect(outcome.changed == 2)
        #expect(!outcome.didFullSync)
        #expect(api.calls == ["sync nil", "sync c1"])
        #expect(try await repo.cursor() == "c2")
        #expect(try await repo.events(packageId: "a").map(\.id) == ["e1"])
    }

    @Test func anUnknownCursorRunsAFullSyncAndPrunesWhatItLeftOut() async throws {
        try await seed([pkg("kept"), pkg("gone"), pkg("edited")], cursor: "old")
        try await repo.enqueue(.put(id: "edited", request: PackagePutRequest(title: .some("x"))), optimistic: nil)
        api.configure {
            $0.syncError["old"] = serverError(400, .badRequest)
            $0.syncPages["nil"] = [page([pkg("kept", updated: 1)], cursor: "fresh")]
            $0.put = { _, _ in throw APIError.network("offline") }
        }
        let outcome = try await engine.sync()
        #expect(outcome.didFullSync)
        #expect(api.calls == ["put edited", "sync old", "sync nil"])
        #expect(try await repo.cursor() == "fresh")
        #expect(Set(try await repo.packages(includeArchived: true).map(\.id)) == ["kept", "edited"])
    }

    @Test func overlappingSyncCallsJoinOneRun() async throws {
        let gate = Gate()
        api.configure {
            $0.syncGate = { await gate.wait() }
            $0.syncPages["nil"] = [page([pkg("a")], cursor: "c1")]
        }
        async let first = engine.sync()
        await gate.waitUntilEntered()
        async let second = engine.sync()
        gate.open()
        let (a, b) = try await (first, second)
        #expect(a == b)
        #expect(api.calls == ["sync nil"])
    }

    @Test func aSlowSyncDoesNotUndoAnEditThatReturnedFirst() async throws {
        try await seed([pkg("a", title: "Old")])
        let gate = Gate()
        api.configure {
            $0.syncGate = { await gate.wait() }
            $0.syncPages["c0"] = [page([pkg("a", title: "Old", updated: 0)], cursor: "c1")]
        }
        echoPuts(updated: 5)
        async let syncing = engine.sync()
        await gate.waitUntilEntered()
        try await engine.update(packageId: "a", PackagePutRequest(title: .some("Mine")))
        gate.open()
        _ = try await syncing
        #expect(try await repo.package(id: "a")?.title == "Mine")
    }

    @Test func aSlowSyncDoesNotBringBackAPackageThisClientDeleted() async throws {
        try await seed([pkg("a"), pkg("b")])
        let gate = Gate()
        api.configure {
            $0.syncGate = { await gate.wait() }
            $0.syncPages["c0"] = [page([pkg("a", updated: 2), pkg("b", title: "B", updated: 2)], cursor: "c1")]
            $0.delete = { id in deleteResponse(id) }
        }
        async let syncing = engine.sync()
        await gate.waitUntilEntered()
        try await engine.delete(packageId: "a")
        gate.open()
        _ = try await syncing
        #expect(try await repo.packages(includeArchived: true).map(\.id) == ["b"])
        #expect(try await repo.package(id: "b")?.title == "B")
    }

    // MARK: Writes

    @Test func anOfflineEditStaysAppliedAndIsSentOnTheNextSync() async throws {
        try await seed([pkg("a", title: "Old")])
        api.configure { $0.put = { _, _ in throw APIError.network("offline") } }
        try await engine.update(packageId: "a", PackagePutRequest(title: .some("New")))
        #expect(try await repo.package(id: "a")?.title == "New")
        #expect(try await repo.pendingWrites().count == 1)

        echoPuts()
        try await engine.sync()
        #expect(try await repo.pendingWrites().isEmpty)
        #expect(try await repo.package(id: "a")?.title == "New")
        #expect(api.calls == ["put a", "put a", "sync c0"])
    }

    @Test func updateSendsOnlyClientOwnedFields() async throws {
        try await seed([pkg("a")])
        let sent = Recorded<PackagePutRequest>()
        api.configure {
            $0.put = { id, request in
                sent.set(request)
                return PackagePutResult(package: pkg(id, updated: 1).applying(request, at: T0), created: false)
            }
        }
        try await engine.update(packageId: "a", PackagePutRequest(trackingNumber: "X", carrier: .fedex, title: .some("T"), archived: true))
        #expect(sent.value == PackagePutRequest(title: .some("T"), archived: true))
        #expect(try await repo.package(id: "a")?.archivedAt == T0)
    }

    @Test func aRefusedEditRollsBackToTheServerCopyAndThrows() async throws {
        try await seed([pkg("a", title: "Old")])
        api.configure {
            $0.put = { _, _ in throw serverError(400, .badRequest) }
            $0.get = { id in packageResponse(pkg(id, title: "Server", updated: 2), events: [ev("e", id, 0)]) }
        }
        await #expect(throws: APIError.self) {
            try await engine.update(packageId: "a", PackagePutRequest(title: .some(String(repeating: "x", count: 500))))
        }
        #expect(try await repo.package(id: "a")?.title == "Server")
        #expect(try await repo.events(packageId: "a").map(\.id) == ["e"])
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func whenTheServerCannotBeAskedRollbackUsesTheSnapshot() async throws {
        try await seed([pkg("a", title: "Old")])
        api.configure {
            $0.put = { _, _ in throw serverError(403, .forbidden) }
            $0.get = { _ in throw APIError.network("offline") }
        }
        await #expect(throws: APIError.self) {
            try await engine.update(packageId: "a", PackagePutRequest(title: .some("New")))
        }
        #expect(try await repo.package(id: "a")?.title == "Old")
    }

    @Test func addCreatesOptimisticallyAndStoresTheServerCopy() async throws {
        api.configure {
            $0.put = { id, _ in
                PackagePutResult(package: Package(id: id, carrier: .ups, trackingNumber: "1Z999", title: "Shoes", source: .manual, status: .labelCreated, updatedAt: at(-1)), created: true)
            }
        }
        let added = try await engine.addPackage(trackingNumber: " 1z999 ", carrier: nil, title: "Shoes", source: .manual)
        let id = added.id
        #expect(!added.alreadyTracked)
        #expect(id == id.lowercased())
        let stored = try #require(try await repo.package(id: id))
        #expect(stored.status == .labelCreated)
        #expect(stored.carrier == .ups)
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func addingANumberAlreadyTrackedAdoptsTheExistingPackage() async throws {
        api.configure {
            $0.put = { _, _ in
                throw serverError(409, .conflict, details: .object(["reason": .string("duplicate"), "existingId": .string("existing")]))
            }
            $0.get = { id in packageResponse(pkg(id, title: "Theirs", updated: 3)) }
        }
        let added = try await engine.addPackage(trackingNumber: "1Z999", carrier: .ups, title: nil, source: .share)
        #expect(added == AddedPackage(id: "existing", alreadyTracked: true))
        #expect(try await repo.packages(includeArchived: true).map(\.id) == ["existing"])
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func aRefusedCreateIsRemovedAndThrows() async throws {
        api.configure {
            $0.put = { _, _ in throw serverError(400, .badRequest) }
            $0.get = { _ in throw serverError(404, .notFound) }
        }
        await #expect(throws: APIError.self) {
            _ = try await engine.addPackage(trackingNumber: "nope", carrier: nil, title: nil, source: .manual)
        }
        #expect(try await repo.packages(includeArchived: true).isEmpty)
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func anEmptyNumberIsRejectedLocally() async throws {
        await #expect(throws: SyncError.emptyTrackingNumber) {
            _ = try await engine.addPackage(trackingNumber: "  ", carrier: nil, title: nil, source: .manual)
        }
        #expect(api.calls.isEmpty)
    }

    @Test func editingADeletedIdDropsItLocally() async throws {
        try await seed([pkg("a")])
        api.configure { $0.put = { _, _ in throw serverError(409, .conflict, details: .object(["reason": .string("deleted")])) } }
        await #expect(throws: APIError.self) {
            try await engine.update(packageId: "a", PackagePutRequest(title: .some("x")))
        }
        #expect(try await repo.package(id: "a") == nil)
    }

    @Test func deletingAnAlreadyGonePackageCountsAsDone() async throws {
        try await seed([pkg("a")])
        api.configure { $0.delete = { _ in throw serverError(404, .notFound) } }
        try await engine.delete(packageId: "a")
        #expect(try await repo.package(id: "a") == nil)
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func aRefusedDeleteRestoresThePackage() async throws {
        try await seed([pkg("a", title: "Lamp")])
        api.configure {
            $0.delete = { _ in throw serverError(403, .forbidden) }
            $0.get = { _ in throw APIError.network("offline") }
        }
        await #expect(throws: APIError.self) { try await engine.delete(packageId: "a") }
        #expect(try await repo.package(id: "a")?.title == "Lamp")
    }

    @Test func refreshPassesTheRateLimitThrough() async throws {
        do {
            _ = try await engine.refresh(packageId: "a")
            Issue.record("expected a throw")
        } catch let APIError.server(_, body, retryAfter) {
            #expect(body.code == .rateLimited)
            #expect(retryAfter == 60)
        }
    }

    @Test func resetForgetsEverything() async throws {
        try await seed([pkg("a")])
        try await repo.enqueue(.delete(id: "a"), optimistic: nil)
        try await engine.reset()
        #expect(try await repo.cursor() == nil)
        #expect(try await repo.packages(includeArchived: true).isEmpty)
        #expect(try await repo.pendingWrites().isEmpty)
    }
}

final class Recorded<T: Sendable>: Sendable {
    private let box = Mutex<T?>(nil)
    func set(_ value: T) { box.withLock { $0 = value } }
    var value: T? { box.withLock { $0 } }
}
