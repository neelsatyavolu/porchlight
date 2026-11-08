import Foundation
import Observation
import PorchKit

/// State behind the package list: what the repository holds, and how the last
/// sync went. Reads come from the repository; writes go through the sync engine.
@Observable
@MainActor
final class PackageListModel {
    private(set) var packages: [Package] = []
    /// False until the first read from the repository finishes.
    private(set) var loaded = false
    private(set) var loadError: String?
    /// Set when the last sync failed; the list keeps showing local data.
    private(set) var syncError: String?
    private(set) var lastSyncedAt: Date?
    private(set) var syncing = false
    /// Set when an archive or delete failed.
    var actionError: String?

    func load(_ services: ScreenServices) async {
        do {
            packages = try await services.repository.packages(includeArchived: false)
            loadError = nil
        } catch {
            loadError = ErrorText.sentence(error)
        }
        loaded = true
    }

    func refresh(_ services: ScreenServices) async {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            let outcome = try await services.sync.sync()
            lastSyncedAt = outcome.finishedAt
            syncError = nil
        } catch {
            if ErrorText.isUnauthorized(error) { await services.account.signOut() }
            syncError = ErrorText.sentence(error)
        }
        await load(services)
        services.didChange()
    }

    func setArchived(_ pkg: Package, _ archived: Bool, _ services: ScreenServices) async {
        await perform(services) { try await services.sync.update(packageId: pkg.id, PackagePutRequest(archived: archived)) }
    }

    func delete(_ pkg: Package, _ services: ScreenServices) async {
        await perform(services) { try await services.sync.delete(packageId: pkg.id) }
    }

    /// Groups to show for a search, archived packages left out (DESIGN.md §6).
    func groups(query: String, now: Date) -> [ArrivalGroup] {
        let visible = packages.filter { !$0.isArchived && PackageText.matches($0, query: query) }
        return Arrival.groups(visible, now: now, timeZone: .current)
    }

    /// The inline line above the list when a sync failed but data is shown.
    func staleLine(now: Date) -> String? {
        guard syncError != nil, !packages.isEmpty else { return nil }
        guard let lastSyncedAt else { return "Couldn't refresh. Showing what's saved on this device." }
        return "Couldn't refresh. Showing what we had at \(TimeWords.clockTime(lastSyncedAt, timeZone: .current))."
    }

    private func perform(_ services: ScreenServices, _ work: () async throws -> Void) async {
        actionError = nil
        do {
            try await work()
        } catch {
            actionError = ErrorText.sentence(error)
        }
        await load(services)
        services.didChange()
    }
}
