import Foundation
import PorchKit
import PorchStore

let T0 = Date(timeIntervalSince1970: 1_794_160_800) // 2026-11-08T18:00:00Z

func at(_ minutes: Double) -> Date { T0.addingTimeInterval(minutes * 60) }

func pkg(_ id: String, title: String? = nil, status: Status = .inTransit, updated: Double = 0, number: String? = nil) -> Package {
    Package(id: id, carrier: .ups, trackingNumber: number ?? "1Z\(id)", title: title, status: status, updatedAt: at(updated))
}

func ev(_ id: String, _ packageId: String, _ minutes: Double) -> TrackEvent {
    TrackEvent(id: id, packageId: packageId, occurredAt: at(minutes), status: .inTransit, description: id)
}

func page(_ packages: [Package], events: [TrackEvent] = [], deleted: [String] = [], cursor: String = "c", hasMore: Bool = false) -> SyncResponse {
    SyncResponse(packages: packages, events: events, deleted: deleted, cursor: cursor, hasMore: hasMore)
}

func makeRepository() throws -> SwiftDataPackageRepository {
    SwiftDataPackageRepository(modelContainer: try PorchStore.makeContainer(inMemory: true))
}

func packageResponse(_ pkg: Package, events: [TrackEvent] = []) -> PackageResponse {
    PackageResponse(package: pkg, events: events)
}

func deleteResponse(_ id: String) -> PackageDeleteResponse {
    PackageDeleteResponse(id: id, deletedAt: T0)
}
