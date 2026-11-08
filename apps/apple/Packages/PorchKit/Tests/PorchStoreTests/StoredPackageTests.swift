import Foundation
import PorchKit
import PorchStore
import SwiftData
import Testing

@Suite struct StoredPackageTests {
    @Test func roundTripsAPackageThroughAnInMemoryStore() throws {
        let container = try PorchStore.makeContainer(inMemory: true)
        let context = ModelContext(container)
        let updated = Date(timeIntervalSince1970: 1_793_000_000)
        let pkg = Package(
            id: "6f1c7a52-6b8e-4c1e-9a43-3b0f2d9a7c11", carrier: .dhlEcommerce, trackingNumber: "GM1234567890",
            title: "Lamp", merchant: nil, orderId: "112-1", source: .amazon, status: .outForDelivery,
            statusDetail: "On vehicle", eta: .day(start: CalendarDate("2026-11-12")!, end: CalendarDate("2026-11-14")!),
            updatedAt: updated, items: [PackageItem(name: "Lamp", quantity: 2)]
        )
        let stored = StoredPackage(pkg)
        context.insert(stored)
        context.insert(StoredEvent(TrackEvent(id: "e1", packageId: pkg.id, occurredAt: updated, status: .outForDelivery, description: "Out"), package: stored))
        try context.save()

        let fetched = try context.fetch(FetchDescriptor<StoredPackage>())
        #expect(fetched.count == 1)
        #expect(fetched.first?.package == pkg)
        #expect(fetched.first?.events.map(\.id) == ["e1"])

        context.delete(stored)
        try context.save()
        #expect(try context.fetchCount(FetchDescriptor<StoredEvent>()) == 0)
    }
}
