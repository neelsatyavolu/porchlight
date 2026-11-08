import Foundation
import PorchKit
import PorchStore
import Testing

@Suite struct RepositoryTests {
    @Test func appliesASyncPageWithEventsNewestFirst() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a")], events: [ev("old", "a", -60), ev("new", "a", -5)]))
        #expect(try await repo.package(id: "a")?.id == "a")
        #expect(try await repo.events(packageId: "a").map(\.id) == ["new", "old"])
    }

    @Test func replacesEventsWholesaleAndDropsDeletedPackages() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a"), pkg("b")], events: [ev("e1", "a", -60)]))
        try await repo.apply(page([pkg("a", status: .delivered, updated: 1)], events: [ev("e2", "a", 0)], deleted: ["b"]))
        #expect(try await repo.package(id: "a")?.status == .delivered)
        #expect(try await repo.events(packageId: "a").map(\.id) == ["e2"])
        #expect(try await repo.package(id: "b") == nil)
    }

    @Test func ignoresAnOlderCopyThanTheOneHeld() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a", title: "Renamed", updated: 5)], events: [ev("e1", "a", -60)]))
        try await repo.apply(page([pkg("a", title: "Old", updated: 0)]))
        #expect(try await repo.package(id: "a")?.title == "Renamed")
        #expect(try await repo.events(packageId: "a").map(\.id) == ["e1"])
    }

    @Test func listsNewestFirstAndHidesArchivedUnlessAsked() async throws {
        let repo = try makeRepository()
        var archived = pkg("c", updated: 9)
        archived.archivedAt = at(9)
        try await repo.apply(page([pkg("a", updated: 1), pkg("b", updated: 2), archived]))
        #expect(try await repo.packages(includeArchived: false).map(\.id) == ["b", "a"])
        #expect(try await repo.packages(includeArchived: true).map(\.id) == ["c", "b", "a"])
    }

    @Test func keepsQueuedEditsOnTopOfNewerServerCopies() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a", title: "Server")]))
        let edit = PendingWrite.put(id: "a", request: PackagePutRequest(title: .some("Mine")))
        try await repo.enqueue(edit, optimistic: pkg("a", title: "Mine"))

        try await repo.apply(page([pkg("a", title: "Server", status: .outForDelivery, updated: 3)]))
        let merged = try #require(try await repo.package(id: "a"))
        #expect(merged.title == "Mine")
        #expect(merged.status == .outForDelivery)

        try await repo.acknowledge(edit, result: pkg("a", title: "Mine", status: .outForDelivery, updated: 4))
        #expect(try await repo.pendingWrites().isEmpty)
        #expect(try await repo.package(id: "a")?.title == "Mine")
    }

    @Test func aQueuedDeleteRemovesNowAndBlocksResurrection() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a"), pkg("b")]))
        try await repo.enqueue(.delete(id: "a"), optimistic: nil)
        #expect(try await repo.package(id: "a") == nil)
        try await repo.apply(page([pkg("a", updated: 2), pkg("b", title: "B", updated: 2)]))
        #expect(try await repo.packages(includeArchived: true).map(\.id) == ["b"])
        #expect(try await repo.pendingWrites() == [.delete(id: "a")])
    }

    @Test func queuedWritesComeBackOldestFirstIncludingClears() async throws {
        let repo = try makeRepository()
        let writes: [PendingWrite] = [
            .put(id: "a", request: PackagePutRequest(trackingNumber: "1Z", carrier: .ups, source: .manual)),
            .put(id: "a", request: PackagePutRequest(merchant: .some(nil))),
            .delete(id: "b"),
            .put(id: "a", request: PackagePutRequest(archived: true)),
        ]
        for write in writes { try await repo.enqueue(write, optimistic: nil) }
        #expect(try await repo.pendingWrites() == writes)
        try await repo.acknowledge(writes[1], result: nil)
        #expect(try await repo.pendingWrites() == [writes[0], writes[2], writes[3]])
    }

    @Test func theAnswerToACreateReplacesTheOptimisticCopy() async throws {
        let repo = try makeRepository()
        let create = PendingWrite.put(id: "n", request: PackagePutRequest(trackingNumber: "1zn", source: .manual))
        // Device clock ahead of the server's.
        try await repo.enqueue(create, optimistic: Package.optimisticCreate(id: "n", PackagePutRequest(trackingNumber: "1zn"), at: at(10)))
        #expect(try await repo.package(id: "n")?.carrier == .other)
        try await repo.acknowledge(create, result: pkg("n", updated: 0, number: "1ZN"))
        let stored = try #require(try await repo.package(id: "n"))
        #expect(stored.carrier == .ups)
        #expect(stored.trackingNumber == "1ZN")
    }

    @Test func adoptMovesLaterEditsToTheExistingPackage() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("existing", title: "Theirs")]))
        let create = PendingWrite.put(id: "local", request: PackagePutRequest(trackingNumber: "1Zexisting", source: .manual))
        let rename = PendingWrite.put(id: "local", request: PackagePutRequest(title: .some("Mine")))
        try await repo.enqueue(create, optimistic: pkg("local", number: "1Zexisting"))
        try await repo.enqueue(rename, optimistic: pkg("local", title: "Mine", number: "1Zexisting"))

        try await repo.adopt(localId: "local", existingId: "existing")
        #expect(try await repo.package(id: "local") == nil)
        #expect(try await repo.pendingWrites() == [.put(id: "existing", request: PackagePutRequest(title: .some("Mine")))])
        #expect(try await repo.package(id: "existing")?.title == "Mine")
    }

    @Test func aServerDeletionAlsoDropsQueuedWritesForIt() async throws {
        let repo = try makeRepository()
        try await repo.apply(page([pkg("a")]))
        try await repo.enqueue(.put(id: "a", request: PackagePutRequest(title: .some("x"))), optimistic: pkg("a", title: "x"))
        try await repo.apply(page([], deleted: ["a"]))
        #expect(try await repo.package(id: "a") == nil)
        #expect(try await repo.pendingWrites().isEmpty)
    }

    @Test func persistsTheCursorAndRemovesEverything() async throws {
        let repo = try makeRepository()
        #expect(try await repo.cursor() == nil)
        try await repo.setCursor("c1")
        try await repo.setCursor("c2")
        #expect(try await repo.cursor() == "c2")
        try await repo.apply(page([pkg("a")], events: [ev("e", "a", 0)]))
        try await repo.enqueue(.delete(id: "z"), optimistic: nil)
        try await repo.removeAll()
        #expect(try await repo.cursor() == nil)
        #expect(try await repo.packages(includeArchived: true).isEmpty)
        #expect(try await repo.pendingWrites().isEmpty)
    }
}
