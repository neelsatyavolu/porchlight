import Foundation
import PorchKit
import WidgetKit

/// The app's SyncEngine with the widget and Live Activity work added: after
/// each sync it reloads the widget timelines and (iOS) updates the Live
/// Activities from the local store; on sign-out it does the same so the
/// widget shows signed out and every activity ends. Everything else passes
/// straight through to `base`.
struct WidgetSyncEngine: SyncEngine {
    let base: any SyncEngine
    let repository: any PackageRepository

    @discardableResult
    func sync() async throws -> SyncOutcome {
        let outcome = try await base.sync()
        // A failed read must not look like an empty list: that would end every Live Activity.
        if let packages = try? await repository.packages(includeArchived: false) {
            await Self.didSync(packages)
        } else {
            await MainActor.run { WidgetCenter.shared.reloadAllTimelines() }
        }
        return outcome
    }

    func reset() async throws {
        try await base.reset()
        await Self.didReset()
    }

    func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage {
        try await base.addPackage(trackingNumber: trackingNumber, carrier: carrier, title: title, source: source)
    }

    func update(packageId: String, _ request: PackagePutRequest) async throws {
        try await base.update(packageId: packageId, request)
    }

    func delete(packageId: String) async throws {
        try await base.delete(packageId: packageId)
    }

    func refresh(packageId: String) async throws -> RefreshResponse {
        try await base.refresh(packageId: packageId)
    }

    @MainActor
    private static func didSync(_ packages: [Package]) async {
        WidgetCenter.shared.reloadAllTimelines()
        #if os(iOS)
        await serially { await LiveActivityController.apply(packages) }
        #endif
    }

    @MainActor
    private static func didReset() async {
        WidgetCenter.shared.reloadAllTimelines()
        #if os(iOS)
        await serially { await LiveActivityController.endAll() }
        #endif
    }

    #if os(iOS)
    /// The last Live Activity run. Syncs can finish close together (open, push,
    /// background refresh); two runs at once would both see no activity for a
    /// package and both start one.
    @MainActor private static var liveActivityTail: Task<Void, Never>?

    @MainActor
    private static func serially(_ work: @escaping @Sendable () async -> Void) async {
        let previous = liveActivityTail
        let task = Task {
            await previous?.value
            await work()
        }
        liveActivityTail = task
        await task.value
    }
    #endif
}
